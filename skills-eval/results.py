"""Result contract and markdown report rendering for the task x model eval matrix."""

from __future__ import annotations

from dataclasses import dataclass


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
    verifier_passed: bool
    finish_reason: str | None
    tool_call_count: int
    agent_error: str | None
    total_tokens: int | None
    artifact_dir: str | None = None


def build_report(results: list[RunResult]) -> list[RunResult]:
    """Sort results and reject duplicate (task, model) cells."""
    seen: set[tuple[str, str]] = set()
    for result in results:
        key = (result.task_id, result.model)
        if key in seen:
            raise ValueError(f"duplicate result for {key}")
        seen.add(key)
    return sorted(results, key=lambda result: (result.task_id, result.model))


def render_markdown(rows: list[RunResult], gate: list[GateResult] | None = None) -> str:
    """Render the fidelity gate and the single-arm task x model pass table."""
    lines: list[str] = ["# SkillsBench eval results", ""]

    if gate:
        lines += ["## Fidelity gate", ""]
        for item in gate:
            lines.append(f"- {_verdict(item.passed)} `{item.task_id}` - {item.detail}")
        lines.append("")

    lines += [
        "## Pass matrix",
        "",
        "| task | model | verifier | finish | tools | tokens | agent error | artifacts |",
        "| --- | --- | --- | --- | ---: | ---: | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row.task_id} | {row.model} | {_verdict(row.verifier_passed)} | "
            f"{_cell(row.finish_reason)} | {row.tool_call_count} | {_cell(row.total_tokens)} | "
            f"{_cell(row.agent_error)} | {_cell(row.artifact_dir)} |"
        )
    return "\n".join(lines) + "\n"


def _verdict(passed: bool) -> str:
    return "PASS" if passed else "FAIL"


def _cell(value: object | None) -> str:
    if value is None:
        return "-"
    text = str(value).replace("\n", " ").replace("|", "\\|")
    return text or "-"
