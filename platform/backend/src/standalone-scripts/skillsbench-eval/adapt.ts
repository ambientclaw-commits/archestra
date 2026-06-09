// generic adaptation transform: read a task's vendored upstream assets and remap
// them into an upload-ready AdaptedTask. pure given an UpstreamFs reader, so it is
// fully unit-testable offline (no sandbox, no DB).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  AdaptedFile,
  AdaptedSkill,
  AdaptedTask,
  HostPath,
  StagedFile,
  TaskConfig,
  TextReplacement,
} from "./types";

/** read access to a task's vendored `upstream/` tree. */
export interface UpstreamFs {
  /** read a file by path relative to the task's upstream dir. */
  read(relPath: string): Buffer;
  /** recursively list file paths (relative to the upstream dir) under a subdir. */
  list(relDir: string): string[];
}

/** apply ordered literal substitutions; later replacements see earlier output. */
export function applyReplacements(
  content: string,
  replacements: readonly TextReplacement[],
): string {
  let result = content;
  for (const { from, to } of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}

function adaptFile(
  file: StagedFile,
  fs: UpstreamFs,
  replacements: readonly TextReplacement[],
): AdaptedFile {
  const raw = fs.read(file.upstream);
  const content = file.transform
    ? Buffer.from(
        applyReplacements(raw.toString("utf-8"), replacements),
        "utf-8",
      )
    : raw;
  return { dest: file.dest, content, executable: file.executable ?? false };
}

function adaptSkill(name: string, dir: string, fs: UpstreamFs): AdaptedSkill {
  const skillMarkdownPath = path.posix.join(dir, "SKILL.md");
  const skillMarkdown = fs.read(skillMarkdownPath).toString("utf-8");
  const files = fs
    .list(dir)
    .filter((rel) => rel !== skillMarkdownPath)
    .map((rel) => ({
      // path relative to the skill dir, as the skill model expects.
      path: path.posix.relative(dir, rel),
      content: fs.read(rel),
    }));
  return { name, skillMarkdown, files };
}

export function adaptTask(config: TaskConfig, fs: UpstreamFs): AdaptedTask {
  const instruction = applyReplacements(
    fs.read(config.instruction).toString("utf-8"),
    config.textReplacements,
  );
  return {
    id: config.id,
    instruction,
    workspace: config.workspace,
    agentFiles: config.agentFiles.map((f) =>
      adaptFile(f, fs, config.textReplacements),
    ),
    verifierFiles: config.verifierFiles.map((f) =>
      adaptFile(f, fs, config.textReplacements),
    ),
    deps: config.deps,
    setup: config.setup,
    oracleCommand: config.oracleCommand,
    verifierCommand: config.verifierCommand,
    verifierEnv: config.verifierEnv,
    skills: config.skills.map((s) => adaptSkill(s.name, s.dir, fs)),
    resourceHints: config.resourceHints,
  };
}

/** filesystem-backed UpstreamFs rooted at a task's vendored upstream dir. */
export function createUpstreamFs(upstreamDir: HostPath): UpstreamFs {
  const listRecursive = (absDir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listRecursive(abs));
      } else {
        out.push(path.relative(upstreamDir, abs));
      }
    }
    return out;
  };
  return {
    read: (relPath) => readFileSync(path.join(upstreamDir, relPath)),
    list: (relDir) => listRecursive(path.join(upstreamDir, relDir)),
  };
}
