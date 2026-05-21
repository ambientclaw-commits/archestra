import {
  CacheSharingMode,
  type Client,
  type ConnectOpts,
  type Container,
  connect,
  ReturnType as DaggerReturnType,
} from "@dagger.io/dagger";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import * as metrics from "@/observability/metrics";
import {
  CODE_RUNTIME_LIMITS,
  CodeRuntimeError,
  type RunCodeParams,
  type RunCodeResult,
} from "./types";

type RuntimeStatus =
  | "disabled"
  | "initializing"
  | "ready"
  | "error"
  | "stopped";
type CapturedRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};
type ValidatedRunParams = { code: string; requirements: string[] };

class CodeRuntimeBackstopError extends CodeRuntimeError {
  constructor(readonly pipeline: Promise<unknown>) {
    super("the code run exceeded its time budget");
  }
}

/**
 * runs agent-provided Python scripts in throwaway Dagger containers.
 *
 * each call gets a fresh container filesystem; only Dagger-managed base image
 * and uv package caches persist across calls. concurrency across conversations
 * is capped by a semaphore.
 */
class CodeRuntimeService {
  private status: RuntimeStatus = "disabled";
  private baseContainer: Container | null = null;
  private client: Client | null = null;
  private initPromise: Promise<void> | null = null;
  private sessionPromise: Promise<void> | null = null;
  private stopSession: (() => void) | null = null;
  private lastInitAttemptAt = 0;
  private activeRuns = 0;
  private readonly waiters: Array<() => void> = [];

  /** whether the runtime is configured on (independent of engine health). */
  get isEnabled(): boolean {
    return config.codeRuntime.enabled;
  }

  /** whether the engine is reachable and the base image is pre-warmed. */
  get isReady(): boolean {
    return this.status === "ready";
  }

  /**
   * connects to the Dagger Engine and pre-pulls the base image so the first
   * real run is fast. Idempotent and safe to call from any process — the first
   * call does the work, later calls await it. Never throws.
   */
  init(): Promise<void> {
    if (!config.codeRuntime.enabled) {
      this.status = "disabled";
      return Promise.resolve();
    }

    if (this.status === "ready" || this.status === "stopped") {
      return Promise.resolve();
    }

    if (this.initPromise) return this.initPromise;

    const now = Date.now();
    if (
      this.status === "error" &&
      now - this.lastInitAttemptAt < INIT_RETRY_COOLDOWN_MS
    ) {
      return Promise.resolve();
    }

    this.initPromise = this.doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  /**
   * executes a Python script and returns its output. Throws
   * {@link CodeRuntimeError} when the run cannot be performed; a non-zero
   * script exit is a normal result.
   */
  async run(params: RunCodeParams): Promise<RunCodeResult> {
    if (!config.codeRuntime.enabled) {
      throw new CodeRuntimeError("the code runtime is not enabled");
    }
    const runParams = validateRunParams(params);
    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);
    // lazily initialize so scheduled-agent runs in worker processes work too.
    await this.init();
    if (this.status === "stopped") {
      throw new CodeRuntimeError("the code runtime is stopped");
    }
    if (this.status !== "ready") {
      throw new CodeRuntimeError(
        "the code runtime is not available (engine unreachable)",
      );
    }

    const startedAt = Date.now();
    let acquired = false;
    let releaseWhenSettled: Promise<unknown> | null = null;
    try {
      await this.acquire();
      acquired = true;
      const result = await this.execute({
        params: runParams,
        startedAt,
        timeoutSeconds,
      });
      metrics.codeRuntime.reportRun(
        result.timedOut
          ? "timeout"
          : result.exitCode === 0
            ? "ok"
            : "script_error",
        result.durationMs / 1000,
      );
      return result;
    } catch (error) {
      if (error instanceof CodeRuntimeBackstopError) {
        releaseWhenSettled = error.pipeline;
      }
      metrics.codeRuntime.reportRun(
        "runtime_error",
        (Date.now() - startedAt) / 1000,
      );
      throw error;
    } finally {
      if (acquired) {
        if (releaseWhenSettled) {
          void releaseWhenSettled
            .catch((error) => {
              logger.error(
                { err: error },
                "[CodeRuntime] Dagger pipeline failed after backstop timeout",
              );
            })
            .finally(() => {
              this.release();
            });
        } else {
          this.release();
        }
      }
    }
  }

  /** stops accepting new runs and closes the long-lived Dagger session. */
  async shutdown(): Promise<void> {
    if (this.status !== "disabled") {
      this.status = "stopped";
    }
    await this.closeDaggerSession();
  }

  // === private ===

  private async doInit(): Promise<void> {
    if (!config.codeRuntime.enabled) {
      this.status = "disabled";
      return;
    }

    this.applyDaggerEnv();
    await this.closeDaggerSession();
    this.lastInitAttemptAt = Date.now();
    this.status = "initializing";

    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => {
        if (readySettled) return;
        readySettled = true;
        resolve();
      };
      rejectReady = (error) => {
        if (readySettled) return;
        readySettled = true;
        reject(error);
      };
    });

    let closeSession!: () => void;
    const sessionClosed = new Promise<void>((resolve) => {
      closeSession = resolve;
    });
    this.stopSession = closeSession;

    const sessionPromise = connect(async (client) => {
      this.client = client;
      try {
        const warmedContainer = await warmBaseContainer(
          buildBaseContainer(client),
        ).sync();
        if (this.client === client) {
          this.baseContainer = warmedContainer;
        }
        resolveReady();
        await sessionClosed;
      } catch (error) {
        rejectReady(error);
        throw error;
      } finally {
        if (this.client === client) {
          this.baseContainer = null;
          this.client = null;
        }
        if (this.stopSession === closeSession) {
          this.stopSession = null;
        }
      }
    }, DAGGER_CONNECT_OPTS)
      .catch((error) => {
        rejectReady(error);
        if (this.status !== "stopped") {
          this.status = "error";
        }
      })
      .finally(() => {
        if (this.sessionPromise === sessionPromise) {
          this.sessionPromise = null;
        }
        if (this.status === "ready") {
          this.status = "error";
        }
      });
    this.sessionPromise = sessionPromise;

    try {
      await ready;
      this.status = "ready";
      logger.info(
        { image: config.codeRuntime.image },
        "[CodeRuntime] ready — base image and default packages pre-warmed",
      );
    } catch (error) {
      this.status = "error";
      logger.error(
        { err: error },
        "[CodeRuntime] failed to initialize — code execution unavailable",
      );
    }
  }

  private async execute({
    params,
    startedAt,
    timeoutSeconds,
  }: {
    params: ValidatedRunParams;
    startedAt: number;
    timeoutSeconds: number;
  }): Promise<RunCodeResult> {
    const client = this.client;
    const baseContainer = this.baseContainer;
    if (!client || !baseContainer) {
      this.status = "error";
      throw new CodeRuntimeError(
        "the code runtime is not available (engine unreachable)",
      );
    }

    const pipeline = this.executeWithClient({
      baseContainer,
      params,
      timeoutSeconds,
    });

    // the in-container `timeout` should always fire first; this backstop only
    // catches a hung engine/session so the agent is never blocked indefinitely.
    const backstopMs = (timeoutSeconds + BACKSTOP_BUFFER_SECONDS) * 1000;
    if ((await raceWithTimeout(pipeline, backstopMs)) === "timeout") {
      this.status = "error";
      void this.closeDaggerSession();
      throw new CodeRuntimeBackstopError(pipeline);
    }

    const run = await pipeline;
    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: run.timedOut,
      truncated: run.truncated,
    };
  }

  private async executeWithClient({
    baseContainer,
    params,
    timeoutSeconds,
  }: {
    baseContainer: Container;
    params: ValidatedRunParams;
    timeoutSeconds: number;
  }): Promise<CapturedRun> {
    const container = baseContainer
      .withNewFile(`${WORKDIR}/${SCRIPT_FILE}`, params.code)
      .withNewFile(`${WORKDIR}/${RUNNER_FILE}`, RUNNER_SCRIPT)
      .withExec(buildRunnerArgs(params.requirements, timeoutSeconds), {
        expect: DaggerReturnType.Any,
      });
    return parseCapturedRun(await container.file(RESULT_FILE).contents());
  }

  private async closeDaggerSession(): Promise<void> {
    this.baseContainer = null;
    this.client = null;
    this.stopSession?.();
    await this.sessionPromise?.catch((error) => {
      logger.error({ err: error }, "[CodeRuntime] Dagger session failed");
    });
  }

  /**
   * points the Dagger SDK at a pre-deployed engine and a baked-in CLI so it
   * never tries to provision its own or download the CLI at runtime.
   */
  private applyDaggerEnv(): void {
    const { daggerEngineHost, daggerCliBin } = config.codeRuntime;
    if (daggerEngineHost && !process.env._EXPERIMENTAL_DAGGER_RUNNER_HOST) {
      process.env._EXPERIMENTAL_DAGGER_RUNNER_HOST = daggerEngineHost;
    }
    if (daggerCliBin && !process.env._EXPERIMENTAL_DAGGER_CLI_BIN) {
      process.env._EXPERIMENTAL_DAGGER_CLI_BIN = daggerCliBin;
    }
  }

  private resolveTimeout(requested: number | undefined): number {
    const max = config.codeRuntime.timeoutSeconds;
    if (requested === undefined) return max;
    if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
      throw new CodeRuntimeError("timeoutSeconds must be a finite integer");
    }
    if (requested <= 0) {
      throw new CodeRuntimeError("timeoutSeconds must be positive");
    }
    return Math.min(requested, max);
  }

  private async acquire(): Promise<void> {
    if (this.activeRuns < config.codeRuntime.maxConcurrent) {
      this.activeRuns++;
      return;
    }
    // cap the queue so a wedged engine cannot pile up unbounded waiters.
    if (this.waiters.length >= CODE_RUNTIME_LIMITS.maxQueueLength) {
      throw new CodeRuntimeError(
        "the code runtime is at capacity — too many runs are already queued",
      );
    }
    // wait for a slot; release() hands one over without decrementing.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.activeRuns--;
    }
  }
}

export const codeRuntimeService = new CodeRuntimeService();

// === internal helpers ===

/** scripts run from /tmp — world-writable, so the non-root image user can write there. */
const WORKDIR = "/tmp";
const SCRIPT_FILE = "main.py";
const RUNNER_FILE = "runner.py";
const RESULT_FILE = `${WORKDIR}/result.json`;
const UV_CACHE_DIR = `${WORKDIR}/uv-cache`;
const UV_CACHE_KEY = "archestra-code-runtime-uv-cache-v1";
const VENV_DIR = `${WORKDIR}/.venv`;
const VENV_PYTHON = `${VENV_DIR}/bin/python`;
const NON_ROOT_USER = "1000:1000";
const DAGGER_CONNECT_OPTS = {
  LoadWorkspaceModules: false,
  Workdir: "/",
} satisfies ConnectOpts;
/** extra time beyond the script's own timeout before the hung-run backstop fires. */
const BACKSTOP_BUFFER_SECONDS = 60;
const INIT_RETRY_COOLDOWN_MS = 10_000;

const DEFAULT_REQUIREMENTS = ["numpy", "pandas", "httpx"] as const;

function buildBaseContainer(client: Client): Container {
  return (
    client
      .container()
      .from(config.codeRuntime.image)
      .withWorkdir(WORKDIR)
      .withUser(NON_ROOT_USER)
      .withEnvVariable("HOME", WORKDIR)
      .withEnvVariable("UV_CACHE_DIR", UV_CACHE_DIR)
      // shared, not locked: uv's cache is concurrency-safe, so serializing
      // runs on it would defeat the maxConcurrent semaphore.
      .withMountedCache(UV_CACHE_DIR, client.cacheVolume(UV_CACHE_KEY), {
        owner: NON_ROOT_USER,
        sharing: CacheSharingMode.Shared,
      })
  );
}

function warmBaseContainer(container: Container): Container {
  return container
    .withExec(["uv", "venv", VENV_DIR])
    .withExec([
      "uv",
      "pip",
      "install",
      "--python",
      VENV_PYTHON,
      ...DEFAULT_REQUIREMENTS,
    ]);
}

const RUNNER_SCRIPT = `import asyncio
import json
import os
import resource
import signal
import sys
import traceback

timeout_seconds = int(sys.argv[1])
max_output_bytes = int(sys.argv[2])
cpu_seconds = int(sys.argv[3])
memory_bytes = int(sys.argv[4])
max_processes = int(sys.argv[5])
uv_args = sys.argv[6:]


def write_text(path, value):
    with open(path, "w", encoding="utf-8") as file:
        file.write(value)


def finalize(stdout_data, stderr_data, exit_code, truncated, timed_out):
    stdout_text = stdout_data.decode("utf-8", errors="replace")
    stderr_text = stderr_data.decode("utf-8", errors="replace")
    if truncated["stdout"]:
        stdout_text += "\\n...[output truncated]"
    if truncated["stderr"]:
        stderr_text += "\\n...[output truncated]"

    write_text("${RESULT_FILE}", json.dumps({
        "stdout": stdout_text,
        "stderr": stderr_text,
        "exitCode": exit_code,
        "truncated": truncated["stdout"] or truncated["stderr"],
        "timedOut": timed_out,
    }, ensure_ascii=False))


def append_output(buffer, truncated, stream_name, chunk):
    remaining = max_output_bytes - len(buffer)
    if remaining > 0:
        buffer.extend(chunk[:remaining])
    if len(chunk) > remaining:
        truncated[stream_name] = True


async def read_stream(stream, buffer, truncated, stream_name):
    while True:
        chunk = await stream.read(8192)
        if not chunk:
            return
        append_output(buffer, truncated, stream_name, chunk)


def normalize_exit_code(return_code):
    if return_code < 0:
        return 128 + abs(return_code)
    return return_code


def apply_limits():
    os.setsid()
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (max_processes, max_processes))
    except (AttributeError, ValueError, OSError):
        pass


async def run():
    command = ["uv", "run", "--python", "${VENV_PYTHON}", *uv_args, "python3", "${SCRIPT_FILE}"]
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd="${WORKDIR}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        preexec_fn=apply_limits,
    )
    if process.stdout is None or process.stderr is None:
        raise RuntimeError("failed to capture subprocess output")

    stdout_buffer = bytearray()
    stderr_buffer = bytearray()
    truncated = {"stdout": False, "stderr": False}
    stdout_task = asyncio.create_task(
        read_stream(process.stdout, stdout_buffer, truncated, "stdout")
    )
    stderr_task = asyncio.create_task(
        read_stream(process.stderr, stderr_buffer, truncated, "stderr")
    )

    try:
        return_code = await asyncio.wait_for(process.wait(), timeout_seconds)
        timed_out = False
    except asyncio.TimeoutError:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()
        return_code = 124

    await asyncio.gather(stdout_task, stderr_task)

    if not timed_out:
        return_code = normalize_exit_code(return_code)
    finalize(stdout_buffer, stderr_buffer, return_code, truncated, timed_out)


try:
    asyncio.run(run())
except BaseException:
    no_truncation = {"stdout": False, "stderr": False}
    finalize(b"", traceback.format_exc().encode("utf-8", errors="replace"), 127, no_truncation, False)
`;

const CapturedRunSchema = z.object({
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});

function parseCapturedRun(raw: string): CapturedRun {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new CodeRuntimeError("the code runtime returned invalid JSON");
  }

  const result = CapturedRunSchema.safeParse(decoded);
  if (!result.success) {
    throw new CodeRuntimeError("the code runtime returned an invalid result");
  }
  return result.data;
}

function validateRunParams(params: RunCodeParams): ValidatedRunParams {
  const codeBytes = Buffer.byteLength(params.code, "utf8");
  if (codeBytes > CODE_RUNTIME_LIMITS.maxCodeBytes) {
    throw new CodeRuntimeError(
      `code is too large (${formatBytes(codeBytes)} > ${formatBytes(CODE_RUNTIME_LIMITS.maxCodeBytes)})`,
    );
  }

  return {
    code: params.code,
    requirements: normalizeRequirements(params.requirements),
  };
}

function normalizeRequirements(requirements: string[] | undefined): string[] {
  if (!requirements) return [];
  if (requirements.length > CODE_RUNTIME_LIMITS.maxRequirements) {
    throw new CodeRuntimeError(
      `too many requirements (${requirements.length} > ${CODE_RUNTIME_LIMITS.maxRequirements})`,
    );
  }

  return requirements.map((requirement, index) => {
    const normalized = requirement.trim();
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (!normalized) {
      throw new CodeRuntimeError(`requirement ${index + 1} is empty`);
    }
    if (bytes > CODE_RUNTIME_LIMITS.maxRequirementBytes) {
      throw new CodeRuntimeError(
        `requirement ${index + 1} is too large (${formatBytes(bytes)} > ${formatBytes(CODE_RUNTIME_LIMITS.maxRequirementBytes)})`,
      );
    }
    if (/[\r\n\0]/.test(normalized)) {
      throw new CodeRuntimeError(
        `requirement ${index + 1} must be a single line`,
      );
    }
    return normalized;
  });
}

function buildRunnerArgs(
  requirements: string[],
  timeoutSeconds: number,
): string[] {
  return [
    "python3",
    `${WORKDIR}/${RUNNER_FILE}`,
    String(timeoutSeconds),
    String(config.codeRuntime.maxOutputBytes),
    String(CODE_RUNTIME_LIMITS.maxCpuSeconds),
    String(CODE_RUNTIME_LIMITS.maxMemoryBytes),
    String(CODE_RUNTIME_LIMITS.maxProcesses),
    ...requirements.flatMap((requirement) => ["--with", requirement]),
  ];
}

function formatBytes(bytes: number): string {
  return `${bytes} bytes`;
}

async function raceWithTimeout(
  work: Promise<unknown>,
  ms: number,
): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work.then(() => "done" as const), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
