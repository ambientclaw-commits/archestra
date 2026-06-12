"""Boot a fresh isolated Archestra, seed fixtures, run benchmark tasks, and verify out of band.

Per invocation the harness:
  - starts the harness-owned benchmark MCP (`submit_result`) in-process;
  - boots a fresh backend on a new port over a fresh, migrated database, reusing the dev stack's
    shared Postgres + Dagger engine (see lifecycle.py);
  - seeds an LLM provider key + models, the task skills, a realistic GitHub skill library, the task
    fixture MCPs, and the benchmark MCP, then locks the eval agent's tool surface;
  - drives each task's multi-stage conversation per model, capturing the trajectory;
  - reads the submitted result from the benchmark MCP and verifies its bytes out of band;
  - writes per-cell artifacts + an aggregated report, and tears the instance down.

  export ANTHROPIC_API_KEY=<key>
  uv run run.py --task bike-rebalance --model claude-sonnet-4-6
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

# reuse the migration-kit zero-dependency client by importing it off sys.path (no extraction);
# tests get this via tests/conftest.py, direct execution gets it here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "migration-kit" / "scripts"))

import coloredlogs
import fire

from archestra_client import AgentCreate, ArchestraApiError
from benchmark_mcp import BenchmarkMcp, SubmissionAccepted, SubmissionFormatFailed
from contracts import JsonValue, Provider
from eval_client import ChatRunResult, ChatStreamRecord, EvalClient, FilePart, _apply_chat_event
from lifecycle import Instance
from results import GateResult, Outcome, RunResult, aggregate, build_report, render_markdown
from seeding import (
    RegisteredMcp,
    ResolvedModel,
    ensure_provider_and_models,
    register_remote_mcp,
    seed_mcp_fixtures,
    seed_realistic_skills,
    seed_task_skills,
)
from task_configs import TASKS
from tasks import AdaptedStage, AdaptedTask, FsUpstream, TaskConfig, adapt_task
from verify import VerifyOutcome, run_gate, run_verifier

logger = logging.getLogger(__name__)

_EVAL_AGENT_NAME = "skills-eval-agent"
_EVAL_AGENT_SYSTEM_PROMPT = "You are an expert software engineer completing a benchmark task."
_DEFAULT_MODEL = "claude-sonnet-4-6"
_DEFAULT_PROVIDER = "anthropic"
_REALISTIC_SKILLS_REPO = "github.com/arsenyinfo/skills"
_BENCH_MCP_NAME = "benchmark"
_SUBMIT_TOOL_SUFFIX = "__submit_result"

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
    task: str = "bike-rebalance",
    model: str | list[str] | tuple[str, ...] | None = None,
    provider: str = _DEFAULT_PROVIDER,
    gate_only: bool = False,
    out: str | None = None,
    run_dir: str | None = None,
) -> int:
    """Run the benchmark. `task` and `model` may each be one name or a comma-separated list."""
    configs = _resolve_tasks(task)
    models = _normalize_models(model)

    if gate_only:
        gate = [_run_fidelity_gate(config) for config in configs]
        _write_report(render_markdown([], gate), out)
        return 0 if all(g.passed for g in gate) else 1

    api_key = _provider_key_from_env(provider)
    run_id = _run_id()
    root_run_dir = Path(run_dir) if run_dir else _default_run_dir(run_id)
    root_run_dir.mkdir(parents=True, exist_ok=True)
    _write_run_config(root_run_dir, run_id=run_id, tasks=[c.id for c in configs], provider=provider, models=models)

    results: list[RunResult] = []
    with BenchmarkMcp(server_name=_BENCH_MCP_NAME) as bench_mcp:
        with Instance(_repo_root(), run_id=run_id, log_path=root_run_dir / "backend.log") as instance:
            client = instance.client
            resolved = ensure_provider_and_models(
                client, provider=_as_provider(provider), api_key=api_key, models=models
            )
            agent_id = _ensure_agent(client)
            client.enable_skill_defaults()
            submit_tool = _setup_agent_tools(client, agent_id, bench_mcp.base_url())
            seed_realistic_skills(client, repo_url=_REALISTIC_SKILLS_REPO)

            for config in configs:
                adapted = adapt_task(config, FsUpstream(config.upstream_dir))
                seed_task_skills(client, adapted.skills)
                _seed_task_mcps(client, agent_id, adapted)
                for model_name in models:
                    logger.info("running %s / %s", adapted.id, model_name)
                    results.append(
                        _run_one(
                            client=client,
                            bench_mcp=bench_mcp,
                            submit_tool=submit_tool,
                            root_run_dir=root_run_dir,
                            agent_id=agent_id,
                            adapted=adapted,
                            config=config,
                            model_name=model_name,
                            resolved=resolved[model_name],
                        )
                    )

    report = render_markdown(build_report(results))
    _write_report(report, out)
    (root_run_dir / "aggregate.json").write_text(
        json.dumps(aggregate(results).to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0 if all(r.verifier_passed for r in results) else 1


# === per-cell run ===


def _run_one(
    *,
    client: EvalClient,
    bench_mcp: BenchmarkMcp,
    submit_tool: str,
    root_run_dir: Path,
    agent_id: str,
    adapted: AdaptedTask,
    config: TaskConfig,
    model_name: str,
    resolved: ResolvedModel,
) -> RunResult:
    artifacts = _RunArtifacts(root_run_dir / _run_subdir(adapted.id, model_name))
    artifact_paths: dict[str, JsonValue] = {}
    metadata: dict[str, JsonValue] = {
        "task_id": adapted.id,
        "model": model_name,
        "model_id": resolved.model_id,
        "chat_api_key_id": resolved.api_key_id,
        "submit_tool": submit_tool,
        "conversation_id": None,
        "started_at": _timestamp(),
        "finished_at": None,
        "stage_count": len(adapted.stages),
        "outcome": None,
        "finish_reason": None,
        "tool_call_count": 0,
        "total_tokens": None,
        "format_attempts": 0,
        "agent_error": None,
        "verifier_exit_code": None,
        "verifier_timed_out": None,
        "artifacts": artifact_paths,
    }
    artifacts.write_run(metadata)

    bench_mcp.begin_task(schema=adapted.result_schema, max_attempts=adapted.max_format_attempts)

    try:
        conversation = client.create_conversation(
            agent_id,
            title=f"{adapted.id}/{model_name}",
            model_id=resolved.model_id,
            chat_api_key_id=resolved.api_key_id,
        )
    except ArchestraApiError as exc:
        return _agent_error(adapted, model_name, _api_error_text(exc), artifacts, metadata, run=None)

    conversation_id = _require_str(conversation, "id")
    metadata["conversation_id"] = conversation_id
    artifacts.append("conversation_created", {"conversation_id": conversation_id})
    artifacts.write_run(metadata)

    run = ChatRunResult(text="")
    stage_error: str | None = None
    for index, stage in enumerate(adapted.stages):
        stage_error = _drive_stage(client, conversation_id, stage, run, artifacts)
        if stage_error is not None:
            break
        artifacts.append("stage_complete", {"stage": index, "finish_reason": run.finish_reason})

    metadata["finish_reason"] = run.finish_reason
    metadata["tool_call_count"] = len(run.tool_calls)
    metadata["total_tokens"] = run.total_tokens

    # classify by submission first: a well-formed answer captured before a later stage's stream
    # error is still gradeable. agent_error is only for a run that errored without ever submitting.
    submission = bench_mcp.take_submission()
    if isinstance(submission, SubmissionFormatFailed):
        return _finish(
            adapted, model_name, Outcome.FORMAT_FAILED, run, artifacts, metadata, format_attempts=submission.attempts
        )
    if submission is None:
        if stage_error is not None:
            return _agent_error(adapted, model_name, stage_error, artifacts, metadata, run=run)
        return _finish(adapted, model_name, Outcome.NO_SUBMISSION, run, artifacts, metadata, format_attempts=0)

    assert isinstance(submission, SubmissionAccepted)
    metadata["format_attempts"] = submission.attempts
    report_path = artifacts.write_bytes("submission.json", submission.payload_bytes)
    artifact_paths["submission"] = str(report_path)

    outcome = run_verifier(config.verifier, config.upstream_dir, submission.payload_bytes)
    _save_verifier_artifacts(artifacts, artifact_paths, outcome)
    metadata["verifier_exit_code"] = outcome.exit_code
    metadata["verifier_timed_out"] = outcome.timed_out
    if not outcome.passed:
        logger.info("  verifier failed (exit %s)", outcome.exit_code)
    return _finish(
        adapted,
        model_name,
        Outcome.PASSED if outcome.passed else Outcome.FAILED,
        run,
        artifacts,
        metadata,
        format_attempts=submission.attempts,
    )


def _drive_stage(
    client: EvalClient,
    conversation_id: str,
    stage: AdaptedStage,
    run: ChatRunResult,
    artifacts: _RunArtifacts,
) -> str | None:
    """Send one stage's user message and drain the chat stream to EOF, folding events into `run`.

    Returns an error string if the chat stream itself errored, else None."""
    files = tuple(FilePart(filename=f.filename, mime_type=f.mime_type, data=f.content) for f in stage.files)
    stream_parse_error: str | None = None
    try:
        for record in client.stream_chat_records(conversation_id, text=stage.message, files=files):
            artifacts.append_stream(record)
            if record.kind == "event" and record.event is not None:
                _apply_chat_event(run, record.event)
            elif record.kind == "parse_error" and stream_parse_error is None:
                stream_parse_error = record.reason or record.raw or "malformed chat stream data"
    except ArchestraApiError as exc:
        return _api_error_text(exc)
    return _combine_errors(run.stream_error, _chat_parse_error(stream_parse_error))


# === setup ===


def _ensure_agent(client: EvalClient) -> str:
    existing = [a for a in client.list_agents(name=_EVAL_AGENT_NAME) if a.get("name") == _EVAL_AGENT_NAME]
    if existing:
        return _require_str(existing[0], "id")
    created = client.create_agent(
        AgentCreate(name=_EVAL_AGENT_NAME, scope="org", agentType="agent", systemPrompt=_EVAL_AGENT_SYSTEM_PROMPT)
    )
    return _require_str(created, "id")


def _setup_agent_tools(client: EvalClient, agent_id: str, bench_url: str) -> str:
    """Assign the built-in sandbox tools (bulk-assign) and the benchmark `submit_result` tool
    (assigned at MCP install time, since remote MCP tools cannot be bulk-assigned) to the eval
    agent, then assert the surface. Returns the namespaced submit_result tool name."""
    required_ids = _resolve_required_tool_ids(client)
    _assign_tools(client, agent_id, list(required_ids.values()))
    registered = register_remote_mcp(client, name=_BENCH_MCP_NAME, server_url=bench_url, agent_ids=[agent_id])
    submit_tool, _ = _submit_tool(registered)
    _strip_mutating_skill_tools(client, agent_id)
    _assert_agent_tool_surface(client, agent_id, submit_tool)
    return submit_tool


def _strip_mutating_skill_tools(client: EvalClient, agent_id: str) -> None:
    """`enable_skill_defaults` backfills every skill tool, including `create_skill`/`update_skill`.
    The benchmark agent may use skills but must not mutate the library, so unassign those."""
    mutating = {f"archestra__{n}" for n in _MUTATING_SKILL_TOOL_SHORT_NAMES}
    for tool in client.list_agent_tools(agent_id):
        if tool.get("name") in mutating:
            client.unassign_tool(agent_id, _require_str(tool, "id"))


def _seed_task_mcps(client: EvalClient, agent_id: str, adapted: AdaptedTask) -> None:
    """Register a task's fixture MCPs, assigning their tools to the eval agent at install time."""
    if adapted.mcps:
        seed_mcp_fixtures(client, adapted.mcps, agent_ids=[agent_id])


def _resolve_required_tool_ids(client: EvalClient) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for short_name in _REQUIRED_TOOL_SHORT_NAMES:
        exact = f"archestra__{short_name}"
        matches = [tool for tool in client.list_tools(search=exact) if tool.get("name") == exact]
        if len(matches) != 1:
            raise SystemExit(f"required tool {exact!r} not found exactly once; is sandbox tooling enabled?")
        resolved[short_name] = _require_str(matches[0], "id")
    return resolved


def _assign_tools(client: EvalClient, agent_id: str, tool_ids: list[str]) -> None:
    if not tool_ids:
        return
    result = client.bulk_assign_tools([{"agentId": agent_id, "toolId": tool_id} for tool_id in tool_ids])
    failed = result.get("failed")
    if isinstance(failed, list) and failed:
        raise SystemExit(f"failed to assign tools to the eval agent: {failed}")


def _assert_agent_tool_surface(client: EvalClient, agent_id: str, submit_tool: str) -> None:
    names = {name for tool in client.list_agent_tools(agent_id) if isinstance(name := tool.get("name"), str)}
    missing = [f"archestra__{n}" for n in _REQUIRED_TOOL_SHORT_NAMES if f"archestra__{n}" not in names]
    if missing:
        raise SystemExit(f"eval agent is missing required tools after assignment: {missing}")
    if submit_tool not in names:
        raise SystemExit(f"benchmark tool {submit_tool!r} was not assigned/discovered; refusing to run")
    mutating = [f"archestra__{n}" for n in _MUTATING_SKILL_TOOL_SHORT_NAMES if f"archestra__{n}" in names]
    if mutating:
        raise SystemExit(f"eval agent can mutate the skill library via {mutating}; refusing a contaminated surface")


def _submit_tool(registered: RegisteredMcp) -> tuple[str, str]:
    for tool in registered.tools:
        name = tool.get("name")
        if isinstance(name, str) and name.endswith(_SUBMIT_TOOL_SUFFIX):
            return name, _require_str(tool, "id")
    got = [t.get("name") for t in registered.tools]
    raise SystemExit(f"benchmark MCP exposed no {_SUBMIT_TOOL_SUFFIX} tool; got {got}")


# === fidelity gate ===


def _run_fidelity_gate(config: TaskConfig) -> GateResult:
    if config.verifier.oracle_file is None:
        return GateResult(task_id=config.id, passed=False, detail="task has no oracle to gate against")
    outcome = run_gate(config.verifier, config.upstream_dir)
    detail = (
        "oracle reproduces a verifier-passing solution"
        if outcome.passed
        else f"oracle output failed the verifier (exit {outcome.exit_code})"
    )
    return GateResult(task_id=config.id, passed=outcome.passed, detail=detail)


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
        record: dict[str, JsonValue] = {"sequence": self.sequence, "timestamp": _timestamp(), "kind": kind, **data}
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


# === result assembly ===


def _agent_error(
    adapted: AdaptedTask,
    model_name: str,
    error: str,
    artifacts: _RunArtifacts,
    metadata: dict[str, JsonValue],
    *,
    run: ChatRunResult | None,
) -> RunResult:
    artifacts.append_error("agent_error", error)
    return _finish(
        adapted, model_name, Outcome.AGENT_ERROR, run, artifacts, metadata, format_attempts=0, agent_error=error
    )


def _finish(
    adapted: AdaptedTask,
    model_name: str,
    outcome: Outcome,
    run: ChatRunResult | None,
    artifacts: _RunArtifacts,
    metadata: dict[str, JsonValue],
    *,
    format_attempts: int,
    agent_error: str | None = None,
) -> RunResult:
    metadata["finished_at"] = _timestamp()
    metadata["outcome"] = outcome.value
    metadata["agent_error"] = agent_error
    metadata["format_attempts"] = format_attempts
    artifacts.write_run(metadata)
    return RunResult(
        task_id=adapted.id,
        model=model_name,
        outcome=outcome,
        finish_reason=run.finish_reason if run else None,
        tool_call_count=len(run.tool_calls) if run else 0,
        total_tokens=run.total_tokens if run else None,
        agent_error=agent_error,
        stage_count=len(adapted.stages),
        format_attempts=format_attempts,
        artifact_dir=str(artifacts.path),
    )


def _save_verifier_artifacts(
    artifacts: _RunArtifacts, artifact_paths: dict[str, JsonValue], outcome: VerifyOutcome
) -> None:
    artifact_paths["verifier_stdout"] = str(artifacts.write_text("verifier.stdout.txt", outcome.stdout))
    artifact_paths["verifier_stderr"] = str(artifacts.write_text("verifier.stderr.txt", outcome.stderr))


# === helpers ===


def _resolve_tasks(task: str | list[str] | tuple[str, ...]) -> list[TaskConfig]:
    values = [t.strip() for t in task.split(",")] if isinstance(task, str) else [t.strip() for t in task]
    names = [n for n in values if n]
    unknown = [n for n in names if n not in TASKS]
    if unknown:
        raise SystemExit(f"unknown task(s) {unknown}; choose from {sorted(TASKS)}")
    return [TASKS[n] for n in names]


def _normalize_models(model: str | list[str] | tuple[str, ...] | None) -> list[str]:
    if model is None:
        return [_DEFAULT_MODEL]
    values = [p.strip() for p in model.split(",")] if isinstance(model, str) else [p.strip() for p in model]
    models = [v for v in values if v]
    if len(models) != len(set(models)):
        raise SystemExit(f"duplicate models are not allowed: {models}")
    return models or [_DEFAULT_MODEL]


def _provider_key_from_env(provider: str) -> str:
    var = f"{provider.upper()}_API_KEY"
    key = os.environ.get(var)
    if not key:
        raise SystemExit(f"set {var} to seed the {provider} provider key")
    return key


def _as_provider(provider: str) -> Provider:
    allowed = ("anthropic", "openai", "gemini")
    if provider not in allowed:
        raise SystemExit(f"unsupported provider {provider!r}; expected one of {allowed}")
    return cast(Provider, provider)


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _default_run_dir(run_id: str) -> Path:
    return Path(__file__).resolve().parent / "experiments" / f"run_{run_id}"


def _write_run_config(
    run_dir: Path, *, run_id: str, tasks: list[str], provider: str, models: list[str]
) -> None:
    config: dict[str, JsonValue] = {
        "run_id": run_id,
        "started_at": _timestamp(),
        "tasks": tasks,
        "provider": provider,
        "models": models,
        "git_commit": _git_commit(),
    }
    (run_dir / "config.json").write_text(
        json.dumps(config, allow_nan=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _git_commit() -> str | None:
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=_repo_root(), capture_output=True, text=True, timeout=10
    )
    return proc.stdout.strip() or None if proc.returncode == 0 else None


def _write_report(report: str, out: str | None) -> None:
    if out:
        Path(out).write_text(report, encoding="utf-8")
        logger.info("wrote report to %s", out)
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
    return None if reason is None else f"malformed chat stream data: {reason}"


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


def _require_str(obj: dict[str, JsonValue], key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str):
        raise ArchestraApiError("GET", key, 0, f"expected string field {key!r}, got {value!r}")
    return value


def cli(
    task: str = "bike-rebalance",
    model: str | list[str] | tuple[str, ...] | None = None,
    provider: str = _DEFAULT_PROVIDER,
    gate_only: bool = False,
    out: str | None = None,
    run_dir: str | None = None,
) -> None:
    """Fire entrypoint that preserves `main`'s integer exit code."""
    coloredlogs.install(level=logging.INFO, fmt="%(message)s")
    # SIGINT (Ctrl+C) already unwinds the with-blocks via KeyboardInterrupt; make SIGTERM (`timeout`,
    # `kill`) do the same so the instance is always torn down instead of leaking a backend + database.
    signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)
    raise SystemExit(main(task=task, model=model, provider=provider, gate_only=gate_only, out=out, run_dir=run_dir))


def _raise_keyboard_interrupt(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


if __name__ == "__main__":
    fire.Fire(cli)
