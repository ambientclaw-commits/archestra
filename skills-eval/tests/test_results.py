import pytest

from results import GateResult, RunResult, build_report, render_markdown


def _result(task: str = "t", model: str = "m", passed: bool = True) -> RunResult:
    return RunResult(
        task_id=task,
        model=model,
        verifier_passed=passed,
        finish_reason="stop",
        tool_call_count=2,
        agent_error=None,
        total_tokens=123,
        artifact_dir="runs/t__m",
    )


def test_build_report_sorts_single_run_results() -> None:
    rows = build_report([_result("b", "m2"), _result("a", "m1", False)])

    assert [(row.task_id, row.model, row.verifier_passed) for row in rows] == [
        ("a", "m1", False),
        ("b", "m2", True),
    ]


def test_build_report_rejects_duplicate_task_model() -> None:
    with pytest.raises(ValueError, match="duplicate result"):
        build_report([_result(), _result()])


def test_render_markdown_has_no_arm_or_delta_language() -> None:
    markdown = render_markdown([_result()], [GateResult("t", True, "gate ok")])

    assert "with skill" not in markdown.lower()
    assert "without skill" not in markdown.lower()
    assert "skill delta" not in markdown.lower()
    assert "| task | model | verifier |" in markdown
    assert "PASS `t` - gate ok" in markdown
    assert "runs/t__m" in markdown
