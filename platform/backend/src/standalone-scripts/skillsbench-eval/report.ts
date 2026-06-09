// pure aggregation of gate + agent-run results into the {task × model × arm}
// matrix and the skill-efficacy delta (with-skill pass rate minus without-skill).

import type { ArmRunResult, GateResult } from "./results";

export interface Fraction {
  readonly passed: number;
  readonly total: number;
}

export interface TaskModelRow {
  readonly taskId: string;
  readonly model: string;
  /** null when the task had no fidelity gate run. */
  readonly gatePassed: boolean | null;
  readonly withoutSkillPassed: boolean | null;
  readonly withSkillPassed: boolean | null;
  /** (withSkill ? 1 : 0) - (withoutSkill ? 1 : 0); null unless both arms ran. */
  readonly skillDelta: number | null;
}

export interface ReportSummary {
  readonly rows: readonly TaskModelRow[];
  readonly gatePassRate: Fraction;
  readonly withoutSkillPassRate: Fraction;
  readonly withSkillPassRate: Fraction;
  /** mean per-row skillDelta over rows where both arms ran; null if none. */
  readonly meanSkillDelta: number | null;
  /** tasks whose fidelity gate failed (results are advisory, not trusted). */
  readonly flaggedTasks: readonly string[];
}

function rate(values: readonly boolean[]): Fraction {
  return { passed: values.filter(Boolean).length, total: values.length };
}

// a duplicate key means the harness produced two results for the same cell, which
// would silently skew the aggregates — surface it instead.
function indexBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (map.has(k)) {
      throw new Error(`duplicate ${label} result: ${k}`);
    }
    map.set(k, item);
  }
  return map;
}

export function buildReport(
  gates: readonly GateResult[],
  runs: readonly ArmRunResult[],
): ReportSummary {
  const gateByTask = indexBy(gates, (g) => g.taskId, "gate");
  const runByKey = indexBy(
    runs,
    (r) => [r.taskId, r.model, r.arm].join(" "),
    "arm run",
  );

  // one row per (task, model) pair observed across gates or runs.
  const pairs = new Map<string, { taskId: string; model: string }>();
  for (const r of runs) {
    pairs.set(`${r.taskId} ${r.model}`, { taskId: r.taskId, model: r.model });
  }
  for (const g of gates) {
    // a gate-only task (no agent runs yet) still surfaces, with an empty model.
    if (![...pairs.values()].some((p) => p.taskId === g.taskId)) {
      pairs.set(`${g.taskId} `, { taskId: g.taskId, model: "" });
    }
  }

  const rows: TaskModelRow[] = [...pairs.values()]
    .map(({ taskId, model }) => {
      const without = runByKey.get([taskId, model, "without_skill"].join(" "));
      const withSkill = runByKey.get([taskId, model, "with_skill"].join(" "));
      const withoutSkillPassed = without ? without.verifierPassed : null;
      const withSkillPassed = withSkill ? withSkill.verifierPassed : null;
      return {
        taskId,
        model,
        gatePassed: gateByTask.get(taskId)?.passed ?? null,
        withoutSkillPassed,
        withSkillPassed,
        skillDelta:
          withoutSkillPassed !== null && withSkillPassed !== null
            ? (withSkillPassed ? 1 : 0) - (withoutSkillPassed ? 1 : 0)
            : null,
      };
    })
    .sort(
      (a, b) =>
        a.taskId.localeCompare(b.taskId) || a.model.localeCompare(b.model),
    );

  const deltas = rows
    .map((r) => r.skillDelta)
    .filter((d): d is number => d !== null);

  return {
    rows,
    gatePassRate: rate(gates.map((g) => g.passed)),
    withoutSkillPassRate: rate(
      runs
        .filter((r) => r.arm === "without_skill")
        .map((r) => r.verifierPassed),
    ),
    withSkillPassRate: rate(
      runs.filter((r) => r.arm === "with_skill").map((r) => r.verifierPassed),
    ),
    meanSkillDelta:
      deltas.length > 0
        ? deltas.reduce((a, b) => a + b, 0) / deltas.length
        : null,
    flaggedTasks: gates.filter((g) => !g.passed).map((g) => g.taskId),
  };
}

function pct(f: Fraction): string {
  if (f.total === 0) return "n/a";
  return `${((f.passed / f.total) * 100).toFixed(0)}% (${f.passed}/${f.total})`;
}

function cell(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "pass" : "FAIL";
}

export function renderReportMarkdown(summary: ReportSummary): string {
  const header = "| task | model | gate | without skill | with skill | Δ |";
  const sep = "|---|---|---|---|---|---|";
  const lines = summary.rows.map((r) => {
    const delta =
      r.skillDelta === null
        ? "—"
        : r.skillDelta > 0
          ? "+1"
          : String(r.skillDelta);
    return `| ${r.taskId} | ${r.model || "—"} | ${cell(r.gatePassed)} | ${cell(r.withoutSkillPassed)} | ${cell(r.withSkillPassed)} | ${delta} |`;
  });
  const meanDelta =
    summary.meanSkillDelta === null ? "n/a" : summary.meanSkillDelta.toFixed(2);
  return [
    "# SkillsBench eval report",
    "",
    header,
    sep,
    ...lines,
    "",
    `- fidelity gate: ${pct(summary.gatePassRate)}`,
    `- without-skill pass rate: ${pct(summary.withoutSkillPassRate)}`,
    `- with-skill pass rate: ${pct(summary.withSkillPassRate)}`,
    `- mean skill delta: ${meanDelta}`,
    summary.flaggedTasks.length > 0
      ? `- flagged (gate failed, advisory only): ${summary.flaggedTasks.join(", ")}`
      : "- flagged (gate failed): none",
  ].join("\n");
}
