"""Result contract, outcome taxonomy, aggregation, and markdown rendering for the eval matrix."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from enum import Enum


class Outcome(str, Enum):
    """The terminal classification of one agent attempt at a task.

    `passed`/`failed` mean the agent submitted a well-formed result and the out-of-band verifier
    accepted/rejected it. The remaining classes are distinct failure modes that must not be
    conflated with a verifier verdict: the agent never produced a gradeable answer."""

    PASSED = "passed"
    FAILED = "failed"
    FORMAT_FAILED = "format_failed"  # submitted, but never matched the result schema within budget
    NO_SUBMISSION = "no_submission"  # the run finished without ever calling submit_result
    AGENT_ERROR = "agent_error"  # the chat run errored before a result could be graded


@dataclass(frozen=True)
class GateResult:
    """Fidelity gate: the task's oracle must reproduce a verifier-passing solution."""

    task_id: str
    passed: bool
    detail: str


@dataclass(frozen=True)
class RunResult:
    """One agent attempt at a task with a specific model."""

    task_id: str
    model: str
    outcome: Outcome
    finish_reason: str | None
    tool_call_count: int
    total_tokens: int | None
    agent_error: str | None
    stage_count: int
    format_attempts: int
    artifact_dir: str | None = None

    @property
    def verifier_passed(self) -> bool:
        return self.outcome is Outcome.PASSED


def build_report(results: list[RunResult]) -> list[RunResult]:
    """Sort results and reject duplicate (task, model) cells."""
    seen: set[tuple[str, str]] = set()
    for result in results:
        key = (result.task_id, result.model)
        if key in seen:
            raise ValueError(f"duplicate result for {key}")
        seen.add(key)
    return sorted(results, key=lambda result: (result.task_id, result.model))


@dataclass(frozen=True)
class TaskAggregate:
    task_id: str
    total: int
    passed: int
    outcomes: dict[str, int]

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total if self.total else 0.0


@dataclass(frozen=True)
class Aggregate:
    total: int
    passed: int
    outcomes: dict[str, int]
    per_task: list[TaskAggregate]

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total if self.total else 0.0

    def to_json(self) -> dict[str, object]:
        return {
            "total": self.total,
            "passed": self.passed,
            "pass_rate": self.pass_rate,
            "outcomes": self.outcomes,
            "per_task": [
                {
                    "task_id": t.task_id,
                    "total": t.total,
                    "passed": t.passed,
                    "pass_rate": t.pass_rate,
                    "outcomes": t.outcomes,
                }
                for t in self.per_task
            ],
        }


def aggregate(results: list[RunResult]) -> Aggregate:
    """Roll results up into per-task and overall outcome breakdowns."""
    by_task: dict[str, list[RunResult]] = {}
    for result in results:
        by_task.setdefault(result.task_id, []).append(result)
    per_task = [
        TaskAggregate(
            task_id=task_id,
            total=len(rows),
            passed=sum(r.verifier_passed for r in rows),
            outcomes=_outcome_counts(rows),
        )
        for task_id, rows in sorted(by_task.items())
    ]
    return Aggregate(
        total=len(results),
        passed=sum(r.verifier_passed for r in results),
        outcomes=_outcome_counts(results),
        per_task=per_task,
    )


def render_markdown(rows: list[RunResult], gate: list[GateResult] | None = None) -> str:
    """Render the fidelity gate, the task x model outcome table, and the aggregation."""
    lines: list[str] = ["# Archestra benchmark results", ""]

    if gate:
        lines += ["## Fidelity gate", ""]
        for item in gate:
            lines.append(f"- {_verdict(item.passed)} `{item.task_id}` - {item.detail}")
        lines.append("")

    lines += [
        "## Pass matrix",
        "",
        "| task | model | outcome | finish | tools | tokens | stages | fmt | agent error | artifacts |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row.task_id} | {row.model} | {row.outcome.value} | {_cell(row.finish_reason)} | "
            f"{row.tool_call_count} | {_cell(row.total_tokens)} | {row.stage_count} | "
            f"{row.format_attempts} | {_cell(row.agent_error)} | {_cell(row.artifact_dir)} |"
        )

    if rows:
        agg = aggregate(rows)
        lines += ["", "## Aggregate", ""]
        lines.append(f"- overall: {agg.passed}/{agg.total} passed ({agg.pass_rate:.0%})")
        lines.append(f"- outcomes: {_outcome_summary(agg.outcomes)}")
        for task in agg.per_task:
            lines.append(
                f"  - `{task.task_id}`: {task.passed}/{task.total} passed "
                f"({task.pass_rate:.0%}) - {_outcome_summary(task.outcomes)}"
            )

    return "\n".join(lines) + "\n"


def _outcome_counts(rows: list[RunResult]) -> dict[str, int]:
    counts = Counter(r.outcome.value for r in rows)
    return {outcome.value: counts[outcome.value] for outcome in Outcome if counts[outcome.value]}


def _outcome_summary(outcomes: dict[str, int]) -> str:
    return ", ".join(f"{name}={count}" for name, count in outcomes.items()) or "-"


def _verdict(passed: bool) -> str:
    return "PASS" if passed else "FAIL"


def _cell(value: object | None) -> str:
    if value is None:
        return "-"
    text = str(value).replace("\n", " ").replace("|", "\\|")
    return text or "-"
