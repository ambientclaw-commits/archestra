# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""concrete TaskConfigs for the benchmark tasks, keyed by id in TASKS."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tasks import (
    WORKDIR_TOKEN,
    SkillSource,
    StagedFile,
    StageSpec,
    TaskConfig,
    TextReplacement,
    VerifierSpec,
)

_TASKS_DIR = Path(__file__).resolve().parent / "tasks"

# where a data file-part auto-stages in the conversation's sandbox (run_command's cwd is
# /home/sandbox, so the path the agent reads is absolute and explicit).
_ATTACHMENTS = "/home/sandbox/attachments"

_SUBMIT_INSTRUCTIONS = (
    "When you have your final answer, submit it by calling the `submit_result` tool with the "
    "report object as the `result` argument -- a single JSON object in exactly the format described "
    "above. Do not write a file; call `submit_result`. If the tool reports a format problem, fix it "
    "and call `submit_result` again."
)

# === bike-rebalance ===

_BIKE_SKILLS = (
    "geospatial-routing-data",
    "logistics-rules-to-optimization",
    "routing-subtour-elimination",
    "scip-opt",
)

_BIKE_NUMBER = {"type": "number"}

_BIKE_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["summary", "vehicles", "stations"],
    "properties": {
        "summary": {
            "type": "object",
            "required": [
                "objective",
                "travel_distance_miles",
                "unmet_rebalancing_penalty",
                "total_unmet_rebalancing_amount",
            ],
            "properties": {
                "objective": _BIKE_NUMBER,
                "travel_distance_miles": _BIKE_NUMBER,
                "unmet_rebalancing_penalty": _BIKE_NUMBER,
                "total_unmet_rebalancing_amount": _BIKE_NUMBER,
            },
        },
        "vehicles": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["vehicle_id", "start_load", "route", "stops", "end_load"],
                "properties": {
                    "vehicle_id": _BIKE_NUMBER,
                    "start_load": _BIKE_NUMBER,
                    "route": {"type": "array"},
                    "end_load": _BIKE_NUMBER,
                    "stops": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": [
                                "station_id",
                                "bikes_picked_up",
                                "bikes_dropped_off",
                                "load_after_stop",
                            ],
                            "properties": {
                                "station_id": _BIKE_NUMBER,
                                "bikes_picked_up": _BIKE_NUMBER,
                                "bikes_dropped_off": _BIKE_NUMBER,
                                "load_after_stop": _BIKE_NUMBER,
                            },
                        },
                    },
                },
            },
        },
        "stations": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "station_id",
                    "net_rebalancing_target",
                    "total_bikes_picked_up",
                    "total_bikes_dropped_off",
                    "net_bike_change",
                    "unmet_rebalancing_amount",
                ],
                "properties": {
                    "station_id": _BIKE_NUMBER,
                    "net_rebalancing_target": _BIKE_NUMBER,
                    "total_bikes_picked_up": _BIKE_NUMBER,
                    "total_bikes_dropped_off": _BIKE_NUMBER,
                    "net_bike_change": _BIKE_NUMBER,
                    "unmet_rebalancing_amount": _BIKE_NUMBER,
                },
            },
        },
    },
}

_bike_rebalance = TaskConfig(
    id="bike-rebalance",
    upstream_dir=_TASKS_DIR / "bike-rebalance" / "upstream",
    stages=(
        StageSpec(
            instruction_file="instruction.md",
            text=(
                "## Runtime environment\n"
                f"The input file `data.json` is available at `{_ATTACHMENTS}/data.json`. "
                "Use the sandbox tools to read it and do your work. Install any packages you need "
                "following the run_command tool's guidance.\n\n" + _SUBMIT_INSTRUCTIONS
            ),
            files=(
                StagedFile(
                    upstream="environment/data.json",
                    dest=f"{_ATTACHMENTS}/data.json",
                    mime_type="application/json",
                ),
            ),
        ),
    ),
    result_schema=_BIKE_RESULT_SCHEMA,
    skills=tuple(SkillSource(name=name, dir=f"environment/skills/{name}") for name in _BIKE_SKILLS),
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
            TextReplacement(frm="pip3 install --break-system-packages pyscipopt==6.1.0 -q", to="true"),
        ),
    ),
)

# === multistage-demo ===
# A trivial multi-turn task: the user asks for one thing, then corrects to another. No sandbox or
# verifier deps -- it exercises the multi-stage conversation + submit_result + out-of-band verify
# path end to end (the agent computes from values given in the prompt; data.json holds ground truth).

_multistage_demo = TaskConfig(
    id="multistage-demo",
    upstream_dir=_TASKS_DIR / "multistage-demo" / "upstream",
    stages=(
        StageSpec(
            text=(
                "Two integers: a = 6 and b = 7. Add them together and submit your answer by calling "
                'the `submit_result` tool with `result = {"sum": <number>}`. ' + _SUBMIT_INSTRUCTIONS
            ),
        ),
        StageSpec(
            text=(
                "Correction: I actually need the PRODUCT of a and b (6 and 7), not the sum. Submit "
                'the corrected answer with `result = {"product": <number>}`.'
            ),
        ),
    ),
    result_schema={
        "type": "object",
        "required": ["product"],
        "properties": {"product": {"type": "number"}},
        "additionalProperties": False,
    },
    skills=(),
    verifier=VerifierSpec(
        deps=(),
        test_file="tests/test_outputs.py",
        data_file="environment/data.json",
        report_env="DEMO_REPORT",
        data_env="DEMO_DATA",
    ),
    max_format_attempts=3,
)

TASKS: dict[str, TaskConfig] = {
    _bike_rebalance.id: _bike_rebalance,
    _multistage_demo.id: _multistage_demo,
}
