"""Drive Archestra's HTTP API to run SkillsBench tasks through the skill sandbox.

LIVE-ONLY: this talks to a running Archestra instance with real provider keys. The offline
suite covers client streaming, task adaptation, verification, reporting, and run artifacts.

  export ARCHESTRA_BASE_URL=http://localhost:9000
  export ARCHESTRA_API_KEY=<minted key>
  uv run run.py --task bike-rebalance --model claude-sonnet-4-6
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# reuse the migration-kit zero-dependency client by importing it off sys.path (no extraction);
# tests get this via tests/conftest.py, direct execution gets it here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "migration-kit" / "scripts"))

import coloredlogs
import fire

from archestra_client import AgentCreate, ArchestraApiError, SkillCreate, SkillFile
from contracts import JsonValue
from eval_client import ChatRunResult, ChatStreamRecord, EvalClient, FilePart, _apply_chat_event
from results import GateResult, RunResult, build_report, render_markdown
from task_configs import TASKS
from tasks import AdaptedSkill, AdaptedTask, FsUpstream, TaskConfig, adapt_task
from verify import VerifyOutcome, run_gate, run_verifier

logger = logging.getLogger(__name__)

_EVAL_AGENT_NAME = "skills-eval-agent"
_EVAL_AGENT_SYSTEM_PROMPT = "You are an expert software engineer completing a benchmark task."
_DEFAULT_MODEL = "claude-sonnet-4-6"

_REQUIRED_TOOL_SHORT_NAMES = (
    "artifact_write",
    "todo_write",
    "run_command",
    "upload_file",
    "download_file",
    "list_skills",
    "load_skill",
)
_MUTATING_SKILL_TOOL_SHORT_NAMES = ("create_skill", "update_skill")


def main(
    base_url: str = os.environ.get("ARCHESTRA_BASE_URL", "http://localhost:9000"),
    api_key: str | None = os.environ.get("ARCHESTRA_API_KEY"),
    email: str | None = os.environ.get("ARCHESTRA_AUTH_ADMIN_EMAIL"),
    password: str | None = os.environ.get("ARCHESTRA_AUTH_ADMIN_PASSWORD"),
    task: str = "bike-rebalance",
    model: str | list[str] | tuple[str, ...] | None = None,
    gate_only: bool = False,
    out: str | None = None,
    run_dir: str | None = None,
) -> int:
    """Run the benchmark. `model` may be one name or a comma-separated list."""
    if task not in TASKS:
        raise SystemExit(f"unknown task {task!r}; choose one of {sorted(TASKS)}")

    models = _normalize_models(model)
    config = TASKS[task]
    adapted = adapt_task(config, FsUpstream(config.upstream_dir))

    if gate_only:
        gate = _run_fidelity_gate(config)
        report = render_markdown([], [gate])
        _write_report(report, out)
        return 0 if gate.passed else 1

    root_run_dir = Path(run_dir) if run_dir else _default_run_dir()
    root_run_dir.mkdir(parents=True, exist_ok=True)
    _write_run_config(root_run_dir, base_url=base_url, task=task, models=models)

    with _connect(base_url=base_url, api_key=api_key, email=email, password=password) as client:
        agent_id = _ensure_agent(client)
        client.enable_skill_defaults()
        _ensure_required_tools(client, agent_id)
        _ensure_skills(client, adapted.skills)

        results: list[RunResult] = []
        for model_name in models:
            model_id, api_key_id = _resolve_model(client, model_name)
            logger.info("running %s / %s", task, model_name)
            results.append(
                _run_model_task(
                    client=client,
                    root_run_dir=root_run_dir,
                    agent_id=agent_id,
                    model_name=model_name,
                    model_id=model_id,
                    api_key_id=api_key_id,
                    adapted=adapted,
                    config=config,
                )
            )

    report = render_markdown(build_report(results))
    _write_report(report, out)
    return 0 if all(result.verifier_passed for result in results) else 1


# === orchestration ===


def _run_model_task(
    *,
    client: EvalClient,
    root_run_dir: Path,
    agent_id: str,
    model_name: str,
    model_id: str,
    api_key_id: str | None,
    adapted: AdaptedTask,
    config: TaskConfig,
) -> RunResult:
    artifacts = _RunArtifacts(root_run_dir / _run_subdir(adapted.id, model_name))
    artifact_paths: dict[str, JsonValue] = {}
    metadata: dict[str, JsonValue] = {
        "task_id": adapted.id,
        "model": model_name,
        "model_id": model_id,
        "chat_api_key_id": api_key_id,
        "conversation_id": None,
        "started_at": _timestamp(),
        "finished_at": None,
        "output_path": config.output_path,
        "finish_reason": None,
        "tool_call_count": 0,
        "total_tokens": None,
        "agent_error": None,
        "verifier_passed": False,
        "verifier_exit_code": None,
        "verifier_timed_out": None,
        "artifacts": artifact_paths,
    }
    artifacts.write_run(metadata)

    finish_reason: str | None = None
    tool_call_count = 0
    total_tokens: int | None = None
    agent_error: str | None = None

    try:
        conversation = client.create_conversation(
            agent_id,
            title=f"{adapted.id}/{model_name}",
            model_id=model_id,
            chat_api_key_id=api_key_id,
        )
    except ArchestraApiError as exc:
        agent_error = _api_error_text(exc)
        artifacts.append_error("create_conversation_error", agent_error)
        _finish_metadata(metadata, agent_error=agent_error)
        artifacts.write_run(metadata)
        return _run_result(
            adapted, model_name, False, finish_reason, tool_call_count, total_tokens, agent_error, artifacts
        )

    conversation_id = require_str(conversation, "id")
    metadata["conversation_id"] = conversation_id
    artifacts.append("conversation_created", {"conversation_id": conversation_id})
    artifacts.write_run(metadata)

    run = ChatRunResult(text="")
    stream_parse_error: str | None = None
    files = tuple(FilePart(filename=f.filename, mime_type=f.mime_type, data=f.content) for f in adapted.agent_files)
    try:
        for record in client.stream_chat_records(conversation_id, text=adapted.instruction, files=files):
            artifacts.append_stream(record)
            if record.kind == "event" and record.event is not None:
                _apply_chat_event(run, record.event)
            elif record.kind == "parse_error" and stream_parse_error is None:
                stream_parse_error = record.reason or record.raw or "malformed chat stream data"
    except ArchestraApiError as exc:
        agent_error = _api_error_text(exc)
        artifacts.append_error("chat_error", agent_error)
        _finish_metadata(metadata, run=run, agent_error=agent_error)
        artifacts.write_run(metadata)
        return _run_result(
            adapted,
            model_name,
            False,
            run.finish_reason,
            len(run.tool_calls),
            run.total_tokens,
            agent_error,
            artifacts,
        )

    finish_reason = run.finish_reason
    tool_call_count = len(run.tool_calls)
    total_tokens = run.total_tokens
    agent_error = _combine_errors(run.stream_error, _chat_parse_error(stream_parse_error))
    _finish_metadata(metadata, run=run, agent_error=agent_error)
    artifacts.write_run(metadata)

    if agent_error is not None:
        error_kind = "chat_parse_error" if stream_parse_error is not None else "chat_stream_error"
        artifacts.append_error(error_kind, agent_error)
        artifacts.write_run(metadata)
        return _run_result(
            adapted, model_name, False, finish_reason, tool_call_count, total_tokens, agent_error, artifacts
        )

    try:
        report_bytes = client.read_sandbox_file(conversation_id, config.output_path)
    except ArchestraApiError as exc:
        agent_error = _api_error_text(exc)
        artifacts.append_error("sandbox_read_error", agent_error)
        _finish_metadata(metadata, run=run, agent_error=agent_error)
        artifacts.write_run(metadata)
        return _run_result(
            adapted, model_name, False, finish_reason, tool_call_count, total_tokens, agent_error, artifacts
        )

    report_path = artifacts.write_bytes("report.json", report_bytes)
    artifact_paths["report"] = str(report_path)
    artifacts.write_run(metadata)

    try:
        outcome = run_verifier(config.verifier, config.upstream_dir, report_bytes)
    except Exception as exc:
        agent_error = f"verifier infrastructure error: {type(exc).__name__}: {exc}"
        artifacts.append_error("verifier_infrastructure_error", agent_error)
        _finish_metadata(metadata, run=run, agent_error=agent_error)
        artifacts.write_run(metadata)
        logger.exception("verifier infrastructure error")
        raise

    _save_verifier_artifacts(artifacts, artifact_paths, outcome)
    metadata["verifier_passed"] = outcome.passed
    metadata["verifier_exit_code"] = outcome.exit_code
    metadata["verifier_timed_out"] = outcome.timed_out
    _finish_metadata(metadata, run=run, agent_error=None)
    artifacts.write_run(metadata)

    if not outcome.passed:
        logger.info("  verifier failed (exit %s)", outcome.exit_code)

    return _run_result(
        adapted, model_name, outcome.passed, finish_reason, tool_call_count, total_tokens, None, artifacts
    )


def _run_fidelity_gate(config: TaskConfig) -> GateResult:
    outcome = run_gate(config.verifier, config.upstream_dir)
    detail = (
        "oracle reproduces a verifier-passing solution"
        if outcome.passed
        else f"oracle output failed the verifier (exit {outcome.exit_code})"
    )
    return GateResult(task_id=config.id, passed=outcome.passed, detail=detail)


# === seeding ===


def _connect(*, base_url: str, api_key: str | None, email: str | None, password: str | None) -> EvalClient:
    client = EvalClient(base_url, api_key=api_key)
    client.wait_ready()
    if api_key is None:
        if not (email and password):
            raise SystemExit("set ARCHESTRA_API_KEY, or pass --email and --password to sign in")
        client.sign_in(email, password)
        client.mint_api_key("skills-eval")
    return client


def _ensure_agent(client: EvalClient) -> str:
    existing = [agent for agent in client.list_agents(name=_EVAL_AGENT_NAME) if agent.get("name") == _EVAL_AGENT_NAME]
    if len(existing) > 1:
        raise SystemExit(
            f"found multiple agents named {_EVAL_AGENT_NAME!r}; remove stale eval agents before benchmarking"
        )
    if existing:
        agent_id = require_str(existing[0], "id")
        _assert_agent_config(client.get_agent(agent_id))
        return agent_id
    created = client.create_agent(
        AgentCreate(
            name=_EVAL_AGENT_NAME,
            scope="org",
            agentType="agent",
            systemPrompt=_EVAL_AGENT_SYSTEM_PROMPT,
        )
    )
    return require_str(created, "id")


def _assert_agent_config(agent: Mapping[str, JsonValue]) -> None:
    expected: dict[str, JsonValue] = {
        "name": _EVAL_AGENT_NAME,
        "scope": "org",
        "agentType": "agent",
        "systemPrompt": _EVAL_AGENT_SYSTEM_PROMPT,
    }
    mismatches = [
        f"{key}={agent.get(key)!r} (expected {value!r})"
        for key, value in expected.items()
        if agent.get(key) != value
    ]
    if mismatches:
        raise SystemExit(
            f"existing eval agent {_EVAL_AGENT_NAME!r} does not match the benchmark config: "
            f"{'; '.join(mismatches)}"
        )


def _ensure_required_tools(client: EvalClient, agent_id: str) -> None:
    resolved: dict[str, str] = {}
    for short_name in _REQUIRED_TOOL_SHORT_NAMES:
        exact_name = f"archestra__{short_name}"
        matches = [tool for tool in client.list_tools(search=exact_name) if tool.get("name") == exact_name]
        if len(matches) != 1:
            raise SystemExit(
                f"required Archestra tool {exact_name!r} not found exactly once; "
                "is the skill/sandbox tooling enabled on this instance?"
            )
        resolved[short_name] = require_str(matches[0], "id")

    assignments: list[dict[str, JsonValue]] = [
        {"agentId": agent_id, "toolId": tool_id} for tool_id in resolved.values()
    ]
    result = client.bulk_assign_tools(assignments)
    failed = result.get("failed")
    if isinstance(failed, list) and failed:
        raise SystemExit(f"failed to assign required tools to the eval agent: {failed}")
    _assert_agent_tool_surface(client, agent_id)


def _assert_agent_tool_surface(client: EvalClient, agent_id: str) -> None:
    tool_names = {
        name
        for tool in client.list_agent_tools(agent_id)
        if isinstance(name := tool.get("name"), str)
    }
    required_names = {f"archestra__{short_name}" for short_name in _REQUIRED_TOOL_SHORT_NAMES}
    missing = [
        f"archestra__{short_name}"
        for short_name in _REQUIRED_TOOL_SHORT_NAMES
        if f"archestra__{short_name}" not in tool_names
    ]
    if missing:
        raise SystemExit(f"eval agent is missing required tools after assignment: {missing}")

    mutating = [
        f"archestra__{short_name}"
        for short_name in _MUTATING_SKILL_TOOL_SHORT_NAMES
        if f"archestra__{short_name}" in tool_names
    ]
    if mutating:
        raise SystemExit(
            "eval agent can mutate the skill library via tools "
            f"{mutating}; refusing to run a contaminated benchmark surface"
        )

    extra = sorted(tool_names - required_names)
    if extra:
        raise SystemExit(
            "eval agent has extra assigned tools outside the benchmark surface: "
            f"{extra}; remove stale assignments before benchmarking"
        )


def _ensure_skills(client: EvalClient, skills: tuple[AdaptedSkill, ...]) -> None:
    for skill in skills:
        exact = [item for item in client.list_skills(search=skill.name) if item.get("name") == skill.name]
        if not exact:
            client.create_skill(
                SkillCreate(
                    content=skill.skill_markdown,
                    scope="org",
                    files=[SkillFile(path=path, content=_as_text(data)) for path, data in skill.files],
                )
            )
            continue
        if len(exact) != 1:
            raise SystemExit(
                f"found multiple accessible skills named {skill.name!r}; run against a clean instance "
                "or remove the ambiguous skills before benchmarking"
            )
        detail = client.get_skill(require_str(exact[0], "id"))
        if not _skill_matches(detail, skill):
            raise SystemExit(
                f"skill {skill.name!r} already exists but does not match the vendored benchmark source; "
                "reset the instance or update the skill before benchmarking"
            )


def _resolve_model(client: EvalClient, model_name: str) -> tuple[str, str | None]:
    """Resolve a provider model name to its UUID and linked provider API-key id."""
    for model in client.list_models():
        if model.get("modelId") == model_name:
            api_keys = model.get("apiKeys")
            api_key_id = None
            if isinstance(api_keys, list) and api_keys and isinstance(api_keys[0], dict):
                raw = api_keys[0].get("id")
                api_key_id = raw if isinstance(raw, str) else None
            if api_key_id is None:
                raise SystemExit(
                    f"model {model_name!r} has no linked provider api key; add one in the instance"
                )
            return require_str(model, "id"), api_key_id
    raise SystemExit(f"model {model_name!r} not found; sync the provider's models first")


# === artifacts ===


@dataclass
class _RunArtifacts:
    path: Path
    sequence: int = 0

    def __post_init__(self) -> None:
        try:
            self.path.mkdir(parents=True, exist_ok=False)
        except FileExistsError as exc:
            raise FileExistsError(f"run artifact directory already exists: {self.path}") from exc

    def append(self, kind: str, data: dict[str, JsonValue]) -> None:
        self.sequence += 1
        record: dict[str, JsonValue] = {
            "sequence": self.sequence,
            "timestamp": _timestamp(),
            "kind": kind,
            **data,
        }
        with (self.path / "trajectory.jsonl").open("a", encoding="utf-8") as handle:
            json.dump(record, handle, allow_nan=False, sort_keys=True)
            handle.write("\n")

    def append_stream(self, record: ChatStreamRecord) -> None:
        data: dict[str, JsonValue] = {"record_kind": record.kind}
        if record.event is not None:
            data["event"] = record.event
        if record.raw is not None:
            data["raw"] = record.raw
        if record.reason is not None:
            data["reason"] = record.reason
        self.append("chat_stream", data)

    def append_error(self, kind: str, message: str) -> None:
        self.append(kind, {"error": message})

    def write_run(self, metadata: dict[str, JsonValue]) -> None:
        tmp = self.path / "run.json.tmp"
        tmp.write_text(json.dumps(metadata, allow_nan=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(self.path / "run.json")

    def write_bytes(self, filename: str, data: bytes) -> Path:
        path = self.path / filename
        path.write_bytes(data)
        return path

    def write_text(self, filename: str, text: str) -> Path:
        path = self.path / filename
        path.write_text(text, encoding="utf-8")
        return path


# === helpers ===


def _run_result(
    adapted: AdaptedTask,
    model_name: str,
    verifier_passed: bool,
    finish_reason: str | None,
    tool_call_count: int,
    total_tokens: int | None,
    agent_error: str | None,
    artifacts: _RunArtifacts,
) -> RunResult:
    return RunResult(
        task_id=adapted.id,
        model=model_name,
        verifier_passed=verifier_passed,
        finish_reason=finish_reason,
        tool_call_count=tool_call_count,
        agent_error=agent_error,
        total_tokens=total_tokens,
        artifact_dir=str(artifacts.path),
    )


def _finish_metadata(
    metadata: dict[str, JsonValue], *, run: ChatRunResult | None = None, agent_error: str | None
) -> None:
    metadata["finished_at"] = _timestamp()
    metadata["agent_error"] = agent_error
    if run is not None:
        metadata["finish_reason"] = run.finish_reason
        metadata["tool_call_count"] = len(run.tool_calls)
        metadata["total_tokens"] = run.total_tokens


def _save_verifier_artifacts(
    artifacts: _RunArtifacts, artifact_paths: dict[str, JsonValue], outcome: VerifyOutcome
) -> None:
    stdout_path = artifacts.write_text("verifier.stdout.txt", outcome.stdout)
    stderr_path = artifacts.write_text("verifier.stderr.txt", outcome.stderr)
    artifact_paths["verifier_stdout"] = str(stdout_path)
    artifact_paths["verifier_stderr"] = str(stderr_path)


def _skill_matches(detail: Mapping[str, JsonValue], skill: AdaptedSkill) -> bool:
    if detail.get("content") != _persisted_skill_content(skill.skill_markdown):
        return False
    expected_files = {path: _as_text(data) for path, data in skill.files}
    raw_files = detail.get("files")
    if not isinstance(raw_files, list):
        return False
    actual_files: dict[str, str] = {}
    for item in raw_files:
        if not isinstance(item, dict):
            return False
        path = item.get("path")
        content = item.get("content")
        encoding = item.get("encoding")
        if not isinstance(path, str) or not isinstance(content, str):
            return False
        if encoding not in (None, "utf8"):
            return False
        actual_files[path] = content
    return actual_files == expected_files


def _persisted_skill_content(skill_markdown: str) -> str:
    lines = skill_markdown.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return skill_markdown.rstrip("\r\n")
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "".join(lines[index + 1 :]).lstrip("\r\n").rstrip("\r\n")
    return skill_markdown.rstrip("\r\n")


def _as_text(data: bytes) -> str:
    return data.decode("utf-8")


def require_str(obj: Mapping[str, object], key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str):
        raise ArchestraApiError("GET", key, 0, f"expected string field {key!r}, got {value!r}")
    return value


def _normalize_models(model: str | list[str] | tuple[str, ...] | None) -> list[str]:
    if model is None:
        return [_DEFAULT_MODEL]
    if isinstance(model, str):
        values = [part.strip() for part in model.split(",")]
    else:
        values = [part.strip() for part in model]
    models = [value for value in values if value]
    if len(models) != len(set(models)):
        raise SystemExit(f"duplicate models are not allowed: {models}")
    return models or [_DEFAULT_MODEL]


def _default_run_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return Path(__file__).resolve().parent / "experiments" / f"run_{stamp}"


def _write_run_config(run_dir: Path, *, base_url: str, task: str, models: list[str]) -> None:
    config: dict[str, JsonValue] = {
        "started_at": _timestamp(),
        "base_url": base_url,
        "task": task,
        "models": models,
        "git_commit": _git_commit(),
    }
    (run_dir / "config.json").write_text(
        json.dumps(config, allow_nan=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _git_commit() -> str | None:
    repo = Path(__file__).resolve().parents[1]
    proc = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, timeout=10)
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def _write_report(report: str, out: str | None) -> None:
    if out:
        path = Path(out)
        path.write_text(report, encoding="utf-8")
        logger.info("wrote report to %s", path)
    else:
        print(report)


def _run_subdir(task_id: str, model_name: str) -> str:
    return f"{_slug(task_id)}__{_slug(model_name)}"


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return slug or "run"


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _api_error_text(exc: ArchestraApiError) -> str:
    return f"{exc.method} {exc.url} -> {exc.status}: {exc.body}"


def _chat_parse_error(reason: str | None) -> str | None:
    if reason is None:
        return None
    return f"malformed chat stream data: {reason}"


def _combine_errors(first: str | None, second: str | None) -> str | None:
    match first, second:
        case None, None:
            return None
        case str(value), None:
            return value
        case None, str(value):
            return value
        case str(left), str(right):
            return f"{left}; {right}"


def cli(
    base_url: str = os.environ.get("ARCHESTRA_BASE_URL", "http://localhost:9000"),
    api_key: str | None = os.environ.get("ARCHESTRA_API_KEY"),
    email: str | None = os.environ.get("ARCHESTRA_AUTH_ADMIN_EMAIL"),
    password: str | None = os.environ.get("ARCHESTRA_AUTH_ADMIN_PASSWORD"),
    task: str = "bike-rebalance",
    model: str | list[str] | tuple[str, ...] | None = None,
    gate_only: bool = False,
    out: str | None = None,
    run_dir: str | None = None,
) -> None:
    """Fire entrypoint that preserves `main`'s integer exit code."""
    coloredlogs.install(level=logging.INFO, fmt="%(message)s")
    raise SystemExit(
        main(
            base_url=base_url,
            api_key=api_key,
            email=email,
            password=password,
            task=task,
            model=model,
            gate_only=gate_only,
            out=out,
            run_dir=run_dir,
        )
    )


if __name__ == "__main__":
    fire.Fire(cli)
