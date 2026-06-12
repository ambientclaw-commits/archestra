import pytest

from results import GateResult, Outcome, RunResult, aggregate, build_report, render_markdown


def _result(task: str = "t", model: str = "m", outcome: Outcome = Outcome.PASSED) -> RunResult:
    return RunResult(
        task_id=task,
        model=model,
        outcome=outcome,
        finish_reason="stop",
        tool_call_count=2,
        total_tokens=123,
        agent_error=None,
        stage_count=1,
        format_attempts=1,
        artifact_dir="runs/t__m",
    )


def test_build_report_sorts_results() -> None:
    rows = build_report([_result("b", "m2"), _result("a", "m1", Outcome.FAILED)])

    assert [(row.task_id, row.model, row.verifier_passed) for row in rows] == [
        ("a", "m1", False),
        ("b", "m2", True),
    ]


def test_build_report_rejects_duplicate_task_model() -> None:
    with pytest.raises(ValueError, match="duplicate result"):
        build_report([_result(), _result()])


def test_aggregate_counts_outcomes_per_task_and_overall() -> None:
    rows = [
        _result("a", "m1", Outcome.PASSED),
        _result("a", "m2", Outcome.FORMAT_FAILED),
        _result("b", "m1", Outcome.NO_SUBMISSION),
    ]
    agg = aggregate(rows)
    assert agg.total == 3
    assert agg.passed == 1
    assert agg.outcomes == {"passed": 1, "format_failed": 1, "no_submission": 1}
    by_task = {t.task_id: t for t in agg.per_task}
    assert by_task["a"].passed == 1 and by_task["a"].total == 2
    assert by_task["a"].pass_rate == 0.5
    assert by_task["b"].outcomes == {"no_submission": 1}


def test_render_markdown_shows_outcomes_and_aggregate() -> None:
    markdown = render_markdown(
        [_result(outcome=Outcome.PASSED), _result("t2", "m", Outcome.FORMAT_FAILED)],
        [GateResult("t", True, "gate ok")],
    )
    assert "| task | model | outcome |" in markdown
    assert "PASS `t` - gate ok" in markdown
    assert "format_failed" in markdown
    assert "## Aggregate" in markdown
    assert "1/2 passed" in markdown
    assert "runs/t__m" in markdown
