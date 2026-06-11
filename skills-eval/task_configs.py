# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""concrete TaskConfigs for the vendored SkillsBench tasks, keyed by id in TASKS."""

from __future__ import annotations

from pathlib import Path

from tasks import (
    WORKDIR_TOKEN,
    SkillSource,
    StagedFile,
    TaskConfig,
    TextReplacement,
    VerifierSpec,
)

_TASKS_DIR = Path(__file__).resolve().parent / "tasks"

# where the data file-part auto-stages, and where we require the agent to write its result.
# run_command's cwd is /home/sandbox, so the output path is absolute and explicit.
_ATTACHMENTS = "/home/sandbox/attachments"
_OUTPUT_PATH = "/home/sandbox/report.json"

_BIKE_SKILLS = (
    "geospatial-routing-data",
    "logistics-rules-to-optimization",
    "routing-subtour-elimination",
    "scip-opt",
)

_bike_rebalance = TaskConfig(
    id="bike-rebalance",
    upstream_dir=_TASKS_DIR / "bike-rebalance" / "upstream",
    instruction="instruction.md",
    instruction_suffix=(
        "## Runtime environment\n"
        f"The input file `data.json` is available at `{_ATTACHMENTS}/data.json`. "
        "Use the sandbox tools to read it, do your work, and write your final "
        f"`report.json` to the absolute path `{_OUTPUT_PATH}`. "
        "Install any packages you need following the run_command tool's guidance."
    ),
    output_path=_OUTPUT_PATH,
    agent_files=(
        StagedFile(
            upstream="environment/data.json",
            dest=f"{_ATTACHMENTS}/data.json",
            mime_type="application/json",
        ),
    ),
    skills=tuple(
        SkillSource(name=name, dir=f"environment/skills/{name}") for name in _BIKE_SKILLS
    ),
    verifier=VerifierSpec(
        deps=("pyscipopt==6.1.0", "pytest==8.4.1"),
        test_file="tests/test_outputs.py",
        data_file="environment/data.json",
        report_env="BIKE_REBALANCE_REPORT",
        data_env="BIKE_REBALANCE_DATA",
        # cap the verifier's SCIP benchmark solve so a broken solution can't stall the gate.
        env={"BIKE_REBALANCE_BENCHMARK_TIME_LIMIT": "600"},
        oracle_file="solution/solve.sh",
        oracle_replacements=(
            # solve.sh hardcodes /root for data.json + report.json -> remap onto the gate dir.
            TextReplacement(frm="/root", to=WORKDIR_TOKEN),
            # it pip-installs pyscipopt; the gate's uv env already provides it (pip is disabled).
            TextReplacement(
                frm="pip3 install --break-system-packages pyscipopt==6.1.0 -q",
                to="true",
            ),
        ),
    ),
)

TASKS: dict[str, TaskConfig] = {_bike_rebalance.id: _bike_rebalance}
