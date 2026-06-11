# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""task model + adaptation: turn a vendored SkillsBench task into upload-ready pieces.

each task is vendored verbatim under tasks/<id>/upstream/ (see its NOTICE). this module reads
those assets and remaps them for archestra's HTTP path:
  - the input data is delivered as a chat file-part (auto-staged into the sandbox under
    /home/sandbox/attachments/), so the instruction is rewritten to name that concrete path and
    a fixed output path (run_command's cwd is /home/sandbox, not the task workspace);
  - the task's skills become SkillCreate-ready bundles seeded before agent runs;
  - the oracle + verifier assets are NOT staged into the sandbox -- they run in the harness
    against the downloaded output (anti-cheating: the agent never sees them).

`adapt_task` is pure given an UpstreamFs reader, so it is fully unit-testable with no sandbox.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Protocol

# placeholder the oracle's path remap uses for the gate's working dir; verify.py fills it in
# at run time (the oracle hardcodes an absolute root we cannot know until the gate dir exists).
WORKDIR_TOKEN = "{WORKDIR}"


@dataclass(frozen=True)
class TextReplacement:
    """an ordered literal substitution applied to instruction text (path remap, etc.)."""

    frm: str
    to: str


@dataclass(frozen=True)
class StagedFile:
    """an input file the agent is allowed to see, delivered as a chat file-part.

    `dest` is the sandbox path the file auto-stages to; the instruction references it."""

    upstream: str  # path relative to the task's upstream/ dir
    dest: str  # absolute sandbox path it lands at (under /home/sandbox/attachments)
    mime_type: str = "application/octet-stream"


@dataclass(frozen=True)
class SkillSource:
    """a skill bundle to import for benchmark runs."""

    name: str
    dir: str  # dir relative to upstream/, containing SKILL.md (+ optional files)


@dataclass(frozen=True)
class VerifierSpec:
    """how the harness verifies the agent's output, OUT of band (never staged into the sandbox).

    the verifier and oracle run locally in an ephemeral uv env. the verifier reads the agent's
    downloaded report and the task's input data via env knobs the upstream test exposes."""

    deps: tuple[str, ...]  # pip-style requirements for the ephemeral uv env
    test_file: str  # pytest file, relative to upstream/
    data_file: str  # input data, relative to upstream/ (the verifier's ground truth input)
    report_env: str  # env var the test reads the agent's report path from
    data_env: str  # env var the test reads the data path from
    env: dict[str, str] = field(default_factory=dict)  # extra env (time limits, etc.)
    # the oracle reproduces a known-good report for the fidelity gate. it hardcodes upstream
    # paths, so `oracle_replacements` remaps them onto the gate's working dir at run time.
    oracle_file: str | None = None  # oracle script, relative to upstream/
    oracle_replacements: tuple[TextReplacement, ...] = ()


@dataclass(frozen=True)
class TaskConfig:
    """declarative description of one adapted task."""

    id: str
    upstream_dir: Path  # absolute path to the vendored upstream/ dir
    instruction: str  # instruction markdown, relative to upstream_dir
    instruction_suffix: str  # appended to the instruction (concrete input/output paths)
    output_path: str  # absolute sandbox path the agent must write its result to
    agent_files: tuple[StagedFile, ...]
    skills: tuple[SkillSource, ...]
    verifier: VerifierSpec
    text_replacements: tuple[TextReplacement, ...] = ()


@dataclass(frozen=True)
class AdaptedFile:
    dest: str
    content: bytes
    mime_type: str

    @property
    def filename(self) -> str:
        return PurePosixPath(self.dest).name


@dataclass(frozen=True)
class AdaptedSkill:
    name: str
    skill_markdown: str
    files: tuple[tuple[str, bytes], ...]  # (path-relative-to-skill-dir, bytes)


@dataclass(frozen=True)
class AdaptedTask:
    id: str
    instruction: str
    agent_files: tuple[AdaptedFile, ...]
    skills: tuple[AdaptedSkill, ...]
    verifier: VerifierSpec


class UpstreamFs(Protocol):
    """read access to a task's vendored upstream/ tree."""

    def read(self, rel_path: str) -> bytes: ...

    def list_files(self, rel_dir: str) -> list[str]: ...


def apply_replacements(text: str, replacements: tuple[TextReplacement, ...]) -> str:
    """apply ordered literal substitutions; later replacements see earlier output."""
    for r in replacements:
        text = text.replace(r.frm, r.to)
    return text


def adapt_task(config: TaskConfig, fs: UpstreamFs) -> AdaptedTask:
    instruction = apply_replacements(
        fs.read(config.instruction).decode("utf-8"), config.text_replacements
    )
    instruction = f"{instruction}\n\n{config.instruction_suffix}"
    agent_files = tuple(
        AdaptedFile(dest=f.dest, content=fs.read(f.upstream), mime_type=f.mime_type)
        for f in config.agent_files
    )
    skills = tuple(_adapt_skill(s, fs) for s in config.skills)
    return AdaptedTask(
        id=config.id,
        instruction=instruction,
        agent_files=agent_files,
        skills=skills,
        verifier=config.verifier,
    )


class FsUpstream:
    """filesystem-backed UpstreamFs rooted at a task's vendored upstream/ dir."""

    def __init__(self, upstream_dir: Path) -> None:
        self._root = upstream_dir

    def read(self, rel_path: str) -> bytes:
        return (self._root / rel_path).read_bytes()

    def list_files(self, rel_dir: str) -> list[str]:
        base = self._root / rel_dir
        return sorted(
            str(p.relative_to(self._root)) for p in base.rglob("*") if p.is_file()
        )


def _adapt_skill(source: SkillSource, fs: UpstreamFs) -> AdaptedSkill:
    skill_md_path = str(PurePosixPath(source.dir) / "SKILL.md")
    skill_markdown = fs.read(skill_md_path).decode("utf-8")
    files = tuple(
        (str(PurePosixPath(rel).relative_to(source.dir)), fs.read(rel))
        for rel in fs.list_files(source.dir)
        if rel != skill_md_path
    )
    return AdaptedSkill(name=source.name, skill_markdown=skill_markdown, files=files)
