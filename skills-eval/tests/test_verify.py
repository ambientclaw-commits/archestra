"""offline tests for harness-side verification.

run_verifier is exercised for real (no mocks) with a deps-free spec: the verifier runs under the
current interpreter, so the staging + env-wiring + exit-code -> verdict logic is covered without
uv or network. the heavy pyscipopt verifier + oracle gate run live only.
"""
import json
from pathlib import Path

import pytest

from tasks import TextReplacement, VerifierSpec
from verify import render_oracle, run_gate, run_verifier

# a deps-free verifier that asserts the report's objective matches the data's expectation.
_CHECK_PY = """
import json, os
def test_objective_matches():
    report = json.load(open(os.environ["TEST_REPORT"]))
    data = json.load(open(os.environ["TEST_DATA"]))
    assert report["objective"] == data["expected"]
"""


def _fake_upstream(tmp_path: Path) -> Path:
    upstream = tmp_path / "upstream"
    (upstream / "tests").mkdir(parents=True)
    (upstream / "tests" / "check.py").write_text(_CHECK_PY)
    (upstream / "data.json").write_text(json.dumps({"expected": 5}))
    return upstream


def _spec() -> VerifierSpec:
    return VerifierSpec(
        deps=(), test_file="tests/check.py", data_file="data.json",
        report_env="TEST_REPORT", data_env="TEST_DATA",
    )


def test_run_verifier_passes_on_correct_report(tmp_path: Path) -> None:
    outcome = run_verifier(_spec(), _fake_upstream(tmp_path), b'{"objective": 5}', timeout_s=60)
    assert outcome.passed
    assert outcome.exit_code == 0


def test_run_verifier_fails_on_wrong_report(tmp_path: Path) -> None:
    # negative fixture: a deliberately-wrong report must FAIL (guards an always-pass verifier).
    outcome = run_verifier(_spec(), _fake_upstream(tmp_path), b'{"objective": 999}', timeout_s=60)
    assert not outcome.passed
    assert outcome.exit_code != 0


def test_render_oracle_substitutes_workdir(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    (upstream / "solution").mkdir(parents=True)
    (upstream / "solution" / "solve.sh").write_text("echo /root/report.json")
    spec = VerifierSpec(
        deps=(), test_file="t", data_file="d", report_env="R", data_env="D",
        oracle_file="solution/solve.sh",
        oracle_replacements=(TextReplacement(frm="/root", to="{WORKDIR}"),),
    )
    rendered = render_oracle(spec, upstream, Path("/tmp/gate"))
    assert rendered == "echo /tmp/gate/report.json"


def test_run_gate_without_oracle_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="no oracle"):
        run_gate(_spec(), _fake_upstream(tmp_path))
