// shared types for the skillsbench eval harness.
//
// the harness forks each upstream skillsbench task (verbatim, under `upstream/`)
// and adapts it at run time so it runs in archestra's non-root uv sandbox: paths
// are remapped under a writable workspace, pip installs become uv installs, and
// the verifier/oracle assets are kept out of the agent's view (anti-cheating).

/** absolute path on the machine running the eval (where upstream assets live). */
export type HostPath = string & { readonly __brand: "HostPath" };

/** absolute path inside the sandbox filesystem (writable roots: /home/sandbox, /skills). */
export type SandboxPath = string & { readonly __brand: "SandboxPath" };

export function hostPath(value: string): HostPath {
  if (!value.startsWith("/")) {
    throw new Error(`host path must be absolute: ${value}`);
  }
  return value as HostPath;
}

export function sandboxPath(value: string): SandboxPath {
  if (!value.startsWith("/")) {
    throw new Error(`sandbox path must be absolute: ${value}`);
  }
  return value as SandboxPath;
}

/** a literal, ordered text substitution applied to script/instruction contents. */
export interface TextReplacement {
  readonly from: string;
  readonly to: string;
}

/** a file copied from the vendored upstream tree into the sandbox. */
export interface StagedFile {
  /** path relative to the task's `upstream/` dir. */
  readonly upstream: string;
  /** absolute destination inside the sandbox. */
  readonly dest: SandboxPath;
  /** apply `textReplacements` to the contents (for scripts); false for raw data. */
  readonly transform: boolean;
  readonly executable?: boolean;
}

/** a skill bundle to import + mount for the with-skill arm. */
export interface SkillSource {
  readonly name: string;
  /** dir relative to the task's `upstream/` dir, containing SKILL.md (+ optional files). */
  readonly dir: string;
}

export interface ResourceHints {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly verifierTimeoutSec: number;
}

/** declarative description of one adapted task. */
export interface TaskConfig {
  readonly id: string;
  /** absolute path to the vendored `upstream/` dir for this task. */
  readonly upstreamDir: HostPath;
  /** writable workspace root inside the sandbox, e.g. /home/sandbox/work. */
  readonly workspace: SandboxPath;
  /** instruction markdown, relative to `upstreamDir`. */
  readonly instruction: string;
  /** files the agent is allowed to see (input data). */
  readonly agentFiles: readonly StagedFile[];
  /** oracle + verifier assets, staged only when running the gate/verifier. */
  readonly verifierFiles: readonly StagedFile[];
  /** literal substitutions applied to transformed files (path remap, pip->uv). */
  readonly textReplacements: readonly TextReplacement[];
  /** pip-style requirements installed via uv before any task command. */
  readonly deps: readonly string[];
  /** extra setup commands (e.g. data generators), run after deps. */
  readonly setup: readonly string[];
  /** command that produces the expected output (oracle), run in the workspace. */
  readonly oracleCommand: string;
  /** command that checks the output; exit code 0 means pass. */
  readonly verifierCommand: string;
  /** env overrides for the verifier (path redirection knobs upstream exposes). */
  readonly verifierEnv: Readonly<Record<string, string>>;
  readonly skills: readonly SkillSource[];
  readonly resourceHints: ResourceHints;
}

/** an upload-ready file: bytes plus its sandbox destination. */
export interface AdaptedFile {
  readonly dest: SandboxPath;
  readonly content: Buffer;
  readonly executable: boolean;
}

/** an import-ready skill: SKILL.md plus any extra bundled files. */
export interface AdaptedSkill {
  readonly name: string;
  readonly skillMarkdown: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: Buffer;
  }[];
}

/** fully-resolved task: every upstream asset read + remapped, ready to stage. */
export interface AdaptedTask {
  readonly id: string;
  readonly instruction: string;
  readonly workspace: SandboxPath;
  readonly agentFiles: readonly AdaptedFile[];
  readonly verifierFiles: readonly AdaptedFile[];
  readonly deps: readonly string[];
  readonly setup: readonly string[];
  readonly oracleCommand: string;
  readonly verifierCommand: string;
  readonly verifierEnv: Readonly<Record<string, string>>;
  readonly skills: readonly AdaptedSkill[];
  readonly resourceHints: ResourceHints;
}
