"""offline tests for the pure task adaptation, plus a real read of the vendored bike-rebalance."""
from pathlib import Path

from task_configs import TASKS
from tasks import (
    FsUpstream,
    SkillSource,
    StagedFile,
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


def _config(tmp: Path) -> TaskConfig:
    return TaskConfig(
        id="t",
        upstream_dir=tmp,
        instruction="instruction.md",
        instruction_suffix="SUFFIX",
        output_path="/home/sandbox/report.json",
        agent_files=(StagedFile(upstream="data.json", dest="/home/sandbox/attachments/data.json"),),
        skills=(SkillSource(name="sk", dir="skills/sk"),),
        verifier=VerifierSpec(
            deps=(), test_file="tests/t.py", data_file="data.json",
            report_env="R", data_env="D",
        ),
        text_replacements=(TextReplacement(frm="OLD", to="NEW"),),
    )


def test_adapt_task_remaps_instruction_and_appends_suffix() -> None:
    fs = _MemFs({
        "instruction.md": b"do OLD work",
        "data.json": b'{"k": 1}',
        "skills/sk/SKILL.md": b"# skill",
        "skills/sk/helper.py": b"x = 1",
    })
    adapted = adapt_task(_config(Path("/unused")), fs)
    assert adapted.instruction == "do NEW work\n\nSUFFIX"


def test_adapt_task_stages_agent_files_and_skills() -> None:
    fs = _MemFs({
        "instruction.md": b"x",
        "data.json": b'{"k": 1}',
        "skills/sk/SKILL.md": b"# skill",
        "skills/sk/helper.py": b"x = 1",
    })
    adapted = adapt_task(_config(Path("/unused")), fs)

    assert len(adapted.agent_files) == 1
    af = adapted.agent_files[0]
    assert af.dest == "/home/sandbox/attachments/data.json"
    assert af.filename == "data.json"
    assert af.content == b'{"k": 1}'

    assert len(adapted.skills) == 1
    skill = adapted.skills[0]
    assert skill.name == "sk"
    assert skill.skill_markdown == "# skill"
    assert skill.files == (("helper.py", b"x = 1"),)


def test_bike_rebalance_loads_from_vendored_assets() -> None:
    config = TASKS["bike-rebalance"]
    adapted = adapt_task(config, FsUpstream(config.upstream_dir))

    assert "report.json" in adapted.instruction
    assert "/home/sandbox/attachments/data.json" in adapted.instruction
    assert {s.name for s in adapted.skills} == {
        "geospatial-routing-data",
        "logistics-rules-to-optimization",
        "routing-subtour-elimination",
        "scip-opt",
    }
    assert len(adapted.agent_files) == 1
    assert adapted.agent_files[0].content  # data.json is non-empty
