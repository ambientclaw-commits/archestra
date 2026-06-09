import { describe, expect, it } from "vitest";
import { buildReport, renderReportMarkdown } from "./report";
import type { ArmRunResult, GateResult } from "./results";

const ok: GateResult = {
  taskId: "bike-rebalance",
  passed: true,
  oracle: { exitCode: 0, durationMs: 10, timedOut: false },
  verifier: { exitCode: 0, durationMs: 10, timedOut: false },
};

function run(
  taskId: string,
  arm: ArmRunResult["arm"],
  passed: boolean,
): ArmRunResult {
  return {
    taskId,
    model: "claude-sonnet-4-6",
    arm,
    verifierPassed: passed,
    agentFinishReason: "stop",
    agentError: null,
    verifier: { exitCode: passed ? 0 : 1, durationMs: 5, timedOut: false },
    usage: { totalTokens: 100 },
  };
}

describe("buildReport", () => {
  it("computes the skill delta per row and the mean", () => {
    const summary = buildReport(
      [ok],
      [
        run("bike-rebalance", "without_skill", false),
        run("bike-rebalance", "with_skill", true),
      ],
    );
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].skillDelta).toBe(1);
    expect(summary.meanSkillDelta).toBe(1);
    expect(summary.withSkillPassRate).toEqual({ passed: 1, total: 1 });
    expect(summary.withoutSkillPassRate).toEqual({ passed: 0, total: 1 });
  });

  it("leaves skillDelta null when only one arm ran", () => {
    const summary = buildReport(
      [ok],
      [run("bike-rebalance", "without_skill", true)],
    );
    expect(summary.rows[0].skillDelta).toBeNull();
    expect(summary.rows[0].withSkillPassed).toBeNull();
    expect(summary.meanSkillDelta).toBeNull();
  });

  it("flags tasks whose fidelity gate failed", () => {
    const failedGate: GateResult = {
      taskId: "bike-rebalance",
      passed: false,
      oracle: { error: "pyscipopt import failed" },
      verifier: null,
    };
    const summary = buildReport([failedGate], []);
    expect(summary.flaggedTasks).toEqual(["bike-rebalance"]);
    expect(summary.rows[0].gatePassed).toBe(false);
    expect(summary.rows[0].model).toBe("");
  });

  it("throws on a duplicate (task, model, arm) result instead of silently dropping", () => {
    expect(() =>
      buildReport(
        [],
        [
          run("bike-rebalance", "without_skill", true),
          run("bike-rebalance", "without_skill", false),
        ],
      ),
    ).toThrow(/duplicate arm run/);
  });

  it("renders a markdown matrix", () => {
    const md = renderReportMarkdown(
      buildReport(
        [ok],
        [
          run("bike-rebalance", "without_skill", false),
          run("bike-rebalance", "with_skill", true),
        ],
      ),
    );
    expect(md).toContain(
      "| bike-rebalance | claude-sonnet-4-6 | pass | FAIL | pass | +1 |",
    );
    expect(md).toContain("mean skill delta: 1.00");
  });
});
