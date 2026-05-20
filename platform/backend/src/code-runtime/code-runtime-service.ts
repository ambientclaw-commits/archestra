import { connect, ReturnType as DaggerReturnType } from "@dagger.io/dagger";
import config from "@/config";
import logger from "@/logging";
import * as metrics from "@/observability/metrics";
import {
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
type CapturedRun = { stdout: string; stderr: string; exitCode: number };

/**
 * Runs agent-provided Python scripts in throwaway Dagger containers.
 *
 * One container per call (stateless — nothing persists between calls). The
 * Dagger Engine caches the base image across calls; concurrency across
 * conversations is capped by a semaphore.
 */
class CodeRuntimeService {
  private status: RuntimeStatus = "disabled";
  private initPromise: Promise<void> | null = null;
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
   * Connects to the Dagger Engine and pre-pulls the base image so the first
   * real run is fast. Idempotent and safe to call from any process — the first
   * call does the work, later calls await it. Never throws.
   */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  /**
   * Executes a Python script and returns its output. Throws
   * {@link CodeRuntimeError} when the run cannot be performed; a non-zero
   * script exit is a normal result.
   */
  async run(params: RunCodeParams): Promise<RunCodeResult> {
    if (!config.codeRuntime.enabled) {
      throw new CodeRuntimeError("the code runtime is not enabled");
    }
    // lazily initialize so scheduled-agent runs in worker processes work too.
    await this.init();
    if (this.status !== "ready") {
      throw new CodeRuntimeError(
        "the code runtime is not available (engine unreachable)",
      );
    }

    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);
    await this.acquire();
    const startedAt = Date.now();
    try {
      const result = await this.execute(params, timeoutSeconds, startedAt);
      metrics.codeRuntime.reportRun(
        result.timedOut ? "timeout" : result.exitCode === 0 ? "ok" : "error",
        result.durationMs / 1000,
      );
      return result;
    } catch (error) {
      metrics.codeRuntime.reportRun("error", (Date.now() - startedAt) / 1000);
      throw error;
    } finally {
      this.release();
    }
  }

  /** Stops accepting new runs. Connect-per-run leaves nothing long-lived to close. */
  async shutdown(): Promise<void> {
    if (this.status === "ready") {
      this.status = "stopped";
    }
  }

  // === private ===

  private async doInit(): Promise<void> {
    if (!config.codeRuntime.enabled) {
      this.status = "disabled";
      return;
    }

    this.applyDaggerEnv();
    this.status = "initializing";
    try {
      await connect(async (client) => {
        await client.container().from(config.codeRuntime.image).sync();
      });
      this.status = "ready";
      logger.info(
        { image: config.codeRuntime.image },
        "[CodeRuntime] ready — base image pre-warmed",
      );
    } catch (error) {
      this.status = "error";
      logger.error(
        { err: error },
        "[CodeRuntime] failed to initialize — code execution unavailable",
      );
    }
  }

  private async execute(
    params: RunCodeParams,
    timeoutSeconds: number,
    startedAt: number,
  ): Promise<RunCodeResult> {
    // the connect() callback can only return void, so the captured output is
    // flowed out through a promise rather than a closure-mutated variable.
    let resolveRun!: (value: CapturedRun) => void;
    const runResult = new Promise<CapturedRun>((resolve) => {
      resolveRun = resolve;
    });

    const pipeline = connect(async (client) => {
      const container = client
        .container()
        .from(config.codeRuntime.image)
        .withWorkdir(WORKDIR)
        .withNewFile(`${WORKDIR}/${SCRIPT_FILE}`, params.code)
        .withExec(
          [
            "timeout",
            "-s",
            "KILL",
            String(timeoutSeconds),
            "python3",
            SCRIPT_FILE,
          ],
          // accept any exit code: a failing script is a result, not a throw.
          { expect: DaggerReturnType.Any },
        );
      const [stdout, stderr, exitCode] = await Promise.all([
        container.stdout(),
        container.stderr(),
        container.exitCode(),
      ]);
      resolveRun({ stdout, stderr, exitCode });
    });

    // the in-container `timeout` should always fire first; this backstop only
    // catches a hung engine/session so the agent is never blocked indefinitely.
    const backstopMs = (timeoutSeconds + BACKSTOP_BUFFER_SECONDS) * 1000;
    if ((await raceWithTimeout(pipeline, backstopMs)) === "timeout") {
      throw new CodeRuntimeError("the code run exceeded its time budget");
    }

    // pipeline settled without timing out → the callback resolved runResult.
    const run = await runResult;
    const stdout = truncate(run.stdout);
    const stderr = truncate(run.stderr);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: run.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: TIMEOUT_EXIT_CODES.has(run.exitCode),
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  /**
   * Points the Dagger SDK at a pre-deployed engine and a baked-in CLI so it
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
    if (!requested || requested <= 0) return max;
    return Math.min(requested, max);
  }

  private async acquire(): Promise<void> {
    if (this.activeRuns < config.codeRuntime.maxConcurrent) {
      this.activeRuns++;
      return;
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
/** extra time beyond the script's own timeout before the hung-run backstop fires. */
const BACKSTOP_BUFFER_SECONDS = 60;
/** exit codes coreutils/busybox `timeout` reports when it kills the script. */
const TIMEOUT_EXIT_CODES = new Set([124, 137]);

function truncate(text: string): { text: string; truncated: boolean } {
  const max = config.codeRuntime.maxOutputBytes;
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= max) {
    return { text, truncated: false };
  }
  return {
    text: `${buf.subarray(0, max).toString("utf8")}\n…[output truncated]`,
    truncated: true,
  };
}

async function raceWithTimeout(
  work: Promise<void>,
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
