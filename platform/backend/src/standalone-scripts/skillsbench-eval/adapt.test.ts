import { describe, expect, it } from "vitest";
import {
  adaptTask,
  applyReplacements,
  createUpstreamFs,
  type UpstreamFs,
} from "./adapt";
import { bikeRebalanceConfig } from "./tasks/bike-rebalance/config";
import { hostPath, sandboxPath, type TaskConfig } from "./types";

function inMemoryFs(files: Record<string, string>): UpstreamFs {
  return {
    read: (rel) => {
      const content = files[rel];
      if (content === undefined) {
        throw new Error(`missing upstream file: ${rel}`);
      }
      return Buffer.from(content, "utf-8");
    },
    list: (relDir) =>
      Object.keys(files).filter((p) => p.startsWith(`${relDir}/`)),
  };
}

describe("applyReplacements", () => {
  it("applies replacements in order and replaces every occurrence", () => {
    const out = applyReplacements("/root/a and /root/b", [
      { from: "/root", to: "/work" },
    ]);
    expect(out).toBe("/work/a and /work/b");
  });

  it("feeds earlier output into later replacements", () => {
    const out = applyReplacements("a", [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(out).toBe("c");
  });
});

describe("adaptTask (synthetic)", () => {
  const config: TaskConfig = {
    id: "synthetic",
    upstreamDir: hostPath("/nonexistent"),
    workspace: sandboxPath("/home/sandbox/work"),
    instruction: "instruction.md",
    agentFiles: [
      {
        upstream: "data.json",
        dest: sandboxPath("/home/sandbox/work/data.json"),
        transform: false,
      },
    ],
    verifierFiles: [
      {
        upstream: "solve.sh",
        dest: sandboxPath("/home/sandbox/work/solve.sh"),
        transform: true,
        executable: true,
      },
    ],
    textReplacements: [{ from: "/root", to: "/home/sandbox/work" }],
    deps: ["pytest==8.4.1"],
    setup: [],
    oracleCommand: "bash solve.sh",
    verifierCommand: "python3 -m pytest",
    verifierEnv: { FOO: "bar" },
    skills: [{ name: "skill-a", dir: "skills/skill-a" }],
    resourceHints: { cpus: 1, memoryMb: 1024, verifierTimeoutSec: 60 },
  };

  const fs = inMemoryFs({
    "instruction.md": "read /root/data.json",
    "data.json": '{"raw": "/root/keep-me"}',
    "solve.sh": "cat /root/data.json",
    "skills/skill-a/SKILL.md": "# skill a",
    "skills/skill-a/scripts/helper.py": "print('hi')",
  });

  it("remaps the instruction", () => {
    const adapted = adaptTask(config, fs);
    expect(adapted.instruction).toBe("read /home/sandbox/work/data.json");
  });

  it("leaves non-transformed data files byte-identical", () => {
    const adapted = adaptTask(config, fs);
    expect(adapted.agentFiles[0].content.toString("utf-8")).toBe(
      '{"raw": "/root/keep-me"}',
    );
  });

  it("transforms scripts and marks executables", () => {
    const adapted = adaptTask(config, fs);
    expect(adapted.verifierFiles[0].content.toString("utf-8")).toBe(
      "cat /home/sandbox/work/data.json",
    );
    expect(adapted.verifierFiles[0].executable).toBe(true);
  });

  it("reads SKILL.md plus bundled files with skill-relative paths", () => {
    const adapted = adaptTask(config, fs);
    expect(adapted.skills).toHaveLength(1);
    expect(adapted.skills[0].skillMarkdown).toBe("# skill a");
    expect(adapted.skills[0].files).toEqual([
      {
        path: "scripts/helper.py",
        content: Buffer.from("print('hi')", "utf-8"),
      },
    ]);
  });
});

describe("adaptTask (real bike-rebalance assets)", () => {
  const adapted = adaptTask(
    bikeRebalanceConfig,
    createUpstreamFs(bikeRebalanceConfig.upstreamDir),
  );

  it("transforms the oracle's hardcoded /root paths to the workspace", () => {
    const solve = adapted.verifierFiles.find((f) =>
      f.dest.endsWith("solve.sh"),
    );
    const content = solve?.content.toString("utf-8") ?? "";
    expect(content).toContain("/home/sandbox/work/data.json");
    expect(content).toContain("/home/sandbox/work/report.json");
    expect(content).not.toContain("/root/");
    expect(content).toContain("uv pip install --system");
  });

  it("keeps data.json and the env-driven verifier verbatim", () => {
    const data = adapted.agentFiles.find((f) => f.dest.endsWith("data.json"));
    expect(JSON.parse(data?.content.toString("utf-8") ?? "{}")).toHaveProperty(
      "stations",
    );

    const verifier = adapted.verifierFiles.find((f) =>
      f.dest.endsWith("test_outputs.py"),
    );
    expect(verifier?.content.toString("utf-8")).toContain(
      'os.environ.get("BIKE_REBALANCE_REPORT"',
    );
  });

  it("imports all four skills", () => {
    expect(adapted.skills.map((s) => s.name).sort()).toEqual([
      "geospatial-routing-data",
      "logistics-rules-to-optimization",
      "routing-subtour-elimination",
      "scip-opt",
    ]);
    for (const skill of adapted.skills) {
      expect(skill.skillMarkdown).toContain("name:");
    }
  });
});
