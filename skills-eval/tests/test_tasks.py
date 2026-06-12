"""offline tests for the pure multi-stage task adaptation, plus a real read of vendored tasks."""

from pathlib import Path

from task_configs import TASKS
from tasks import (
    FsUpstream,
    McpFixture,
    SkillSource,
    StagedFile,
    StageSpec,
    TaskConfig,
    TextReplacement,
    VerifierSpec,
    adapt_task,
)


class _MemFs:
    """in-memory UpstreamFs for pure adaptation tests."""

    def __init__(self, files: dict[str, bytes]) -> None:
        self._files = files

    def read(self, rel_path: str) -> bytes:
        return self._files[rel_path]

    def list_files(self, rel_dir: str) -> list[str]:
        prefix = rel_dir.rstrip("/") + "/"
        return sorted(p for p in self._files if p.startswith(prefix))


def _config() -> TaskConfig:
    return TaskConfig(
        id="t",
        upstream_dir=Path("/unused"),
        stages=(
            StageSpec(
                instruction_file="instruction.md",
                text="SUFFIX OLD",
                files=(StagedFile(upstream="data.json", dest="/home/sandbox/attachments/data.json"),),
                text_replacements=(TextReplacement(frm="OLD", to="NEW"),),
            ),
            StageSpec(text="actually, do Y"),
        ),
        result_schema={"type": "object", "required": ["x"], "properties": {"x": {"type": "number"}}},
        skills=(SkillSource(name="sk", dir="skills/sk"),),
        verifier=VerifierSpec(deps=(), test_file="tests/t.py", data_file="data.json", report_env="R", data_env="D"),
        mcps=(McpFixture(name="fix", server_url="http://127.0.0.1:9/mcp"),),
    )


def _fs() -> _MemFs:
    return _MemFs(
        {
            "instruction.md": b"do OLD work",
            "data.json": b'{"k": 1}',
            "skills/sk/SKILL.md": b"# skill",
            "skills/sk/helper.py": b"x = 1",
        }
    )


def test_adapt_task_builds_ordered_stages_with_replacements() -> None:
    adapted = adapt_task(_config(), _fs())
    assert len(adapted.stages) == 2
    # stage 1: instruction_file (replaced) + appended text (replaced)
    assert adapted.stages[0].message == "do NEW work\n\nSUFFIX NEW"
    assert adapted.stages[1].message == "actually, do Y"


def test_adapt_task_stages_files_skills_mcps_and_schema() -> None:
    adapted = adapt_task(_config(), _fs())

    assert len(adapted.stages[0].files) == 1
    af = adapted.stages[0].files[0]
    assert af.dest == "/home/sandbox/attachments/data.json"
    assert af.filename == "data.json"
    assert af.content == b'{"k": 1}'
    assert adapted.stages[1].files == ()

    assert adapted.skills[0].name == "sk"
    assert adapted.skills[0].skill_markdown == "# skill"
    assert adapted.skills[0].files == (("helper.py", b"x = 1"),)

    assert adapted.mcps == (McpFixture(name="fix", server_url="http://127.0.0.1:9/mcp"),)
    assert adapted.result_schema["required"] == ["x"]
    assert adapted.max_format_attempts == 3


def test_bike_rebalance_loads_from_vendored_assets() -> None:
    config = TASKS["bike-rebalance"]
    adapted = adapt_task(config, FsUpstream(config.upstream_dir))

    assert len(adapted.stages) == 1
    assert "submit_result" in adapted.stages[0].message
    assert "/home/sandbox/attachments/data.json" in adapted.stages[0].message
    assert {s.name for s in adapted.skills} == {
        "geospatial-routing-data",
        "logistics-rules-to-optimization",
        "routing-subtour-elimination",
        "scip-opt",
    }
    assert len(adapted.stages[0].files) == 1
    assert adapted.stages[0].files[0].content  # data.json is non-empty
    assert adapted.result_schema["required"] == ["summary", "vehicles", "stations"]


def test_list_stats_is_single_stage_with_staged_file() -> None:
    config = TASKS["list-stats"]
    adapted = adapt_task(config, FsUpstream(config.upstream_dir))
    assert len(adapted.stages) == 1
    assert adapted.stages[0].files[0].dest == "/home/sandbox/attachments/data.json"
    assert "submit_result" in adapted.stages[0].message
    assert adapted.result_schema["required"] == ["sum", "count", "min", "max"]
    assert adapted.skills == ()


def test_multistage_demo_is_two_turns() -> None:
    config = TASKS["multistage-demo"]
    adapted = adapt_task(config, FsUpstream(config.upstream_dir))
    assert len(adapted.stages) == 2
    assert "sum" in adapted.stages[0].message
    assert "product" in adapted.stages[1].message
    assert adapted.skills == ()
