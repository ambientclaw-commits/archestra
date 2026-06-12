"""End-to-end orchestration test for `_run_one`: a stub Archestra whose chat handler calls the REAL
benchmark MCP (standing in for the agent submitting its answer), the REAL submit_result format gate,
and the REAL no-dep verifier of the multistage-demo task. Exercises every outcome class. No mocks."""

import asyncio
import dataclasses
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

import run
from benchmark_mcp import BenchmarkMcp
from eval_client import EvalClient
from results import Outcome, RunResult
from seeding import ResolvedModel
from task_configs import TASKS
from tasks import FsUpstream, adapt_task

_FINISH = [
    {"type": "text-delta", "id": "t", "delta": "done"},
    {"type": "data-token-usage", "data": {"totalTokens": 10}},
    {"type": "finish", "finishReason": "stop"},
]


def _submit(mcp_url: str, payload: dict[str, object]) -> None:
    async def go() -> None:
        async with streamable_http_client(mcp_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await session.call_tool("submit_result", {"result": payload})

    asyncio.run(go())


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        state = self.server.state  # type: ignore[attr-defined]
        match self.path:
            case "/api/chat/conversations":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"id": "conv-1"}).encode())
            case "/api/chat":
                # one chat POST == one stage; submit this stage's configured payload (if any),
                # simulating the agent calling the benchmark MCP, then stream to EOF.
                stage = state["call"]
                state["call"] += 1
                subs = state["submissions"]
                payload = subs[stage] if stage < len(subs) else None
                if payload is not None:
                    _submit(state["mcp_url"], payload)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                events = [{"type": "error", "errorText": "boom"}] if stage in state["error_stages"] else _FINISH
                for event in events:
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
            case _:
                self.send_response(404)
                self.end_headers()


@pytest.fixture()
def harness() -> Iterator[tuple[EvalClient, BenchmarkMcp, HTTPServer]]:
    with BenchmarkMcp() as mcp:
        server = HTTPServer(("127.0.0.1", 0), _Handler)
        server.state = {  # type: ignore[attr-defined]
            "submissions": [],
            "mcp_url": mcp.base_url(),
            "call": 0,
            "error_stages": set(),
        }
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with EvalClient(f"http://127.0.0.1:{server.server_address[1]}", api_key="sk-test") as client:
                yield client, mcp, server
        finally:
            server.shutdown()
            thread.join()


def _run(client: EvalClient, mcp: BenchmarkMcp, tmp_path: Path, *, max_attempts: int = 3) -> RunResult:
    config = dataclasses.replace(TASKS["multistage-demo"], max_format_attempts=max_attempts)
    adapted = adapt_task(config, FsUpstream(config.upstream_dir))
    return run._run_one(
        client=client,
        bench_mcp=mcp,
        submit_tool="benchmark__submit_result",
        root_run_dir=tmp_path,
        agent_id="agent-1",
        adapted=adapted,
        config=config,
        model_name="m",
        resolved=ResolvedModel(model_id="model-uuid", api_key_id="key-1"),
    )


def test_correct_submission_passes(harness: tuple[EvalClient, BenchmarkMcp, HTTPServer], tmp_path: Path) -> None:
    client, mcp, server = harness
    server.state["submissions"] = [None, {"product": 42}]  # type: ignore[attr-defined]
    result = _run(client, mcp, tmp_path)
    assert result.outcome is Outcome.PASSED
    assert result.stage_count == 2
    assert result.format_attempts == 1
    assert json.loads((Path(result.artifact_dir or "") / "submission.json").read_text()) == {"product": 42}


def test_wrong_value_fails_verifier(harness: tuple[EvalClient, BenchmarkMcp, HTTPServer], tmp_path: Path) -> None:
    client, mcp, server = harness
    server.state["submissions"] = [None, {"product": 99}]  # type: ignore[attr-defined]
    assert _run(client, mcp, tmp_path).outcome is Outcome.FAILED


def test_no_submission_is_distinct_outcome(
    harness: tuple[EvalClient, BenchmarkMcp, HTTPServer], tmp_path: Path
) -> None:
    client, mcp, server = harness
    server.state["submissions"] = [None, None]  # type: ignore[attr-defined]
    assert _run(client, mcp, tmp_path).outcome is Outcome.NO_SUBMISSION


def test_submission_survives_a_later_stage_error(
    harness: tuple[EvalClient, BenchmarkMcp, HTTPServer], tmp_path: Path
) -> None:
    # the agent submits a valid result in stage 0, then stage 1's stream errors: the captured
    # answer is still gradeable, so this is PASSED, not agent_error.
    client, mcp, server = harness
    server.state["submissions"] = [{"product": 42}, None]  # type: ignore[attr-defined]
    server.state["error_stages"] = {1}  # type: ignore[attr-defined]
    assert _run(client, mcp, tmp_path).outcome is Outcome.PASSED


def test_stream_error_without_submission_is_agent_error(
    harness: tuple[EvalClient, BenchmarkMcp, HTTPServer], tmp_path: Path
) -> None:
    client, mcp, server = harness
    server.state["error_stages"] = {0}  # type: ignore[attr-defined]  # errors before any submission
    result = _run(client, mcp, tmp_path)
    assert result.outcome is Outcome.AGENT_ERROR
    assert result.agent_error and "boom" in result.agent_error


def test_persistently_malformed_is_format_failed(
    harness: tuple[EvalClient, BenchmarkMcp, HTTPServer], tmp_path: Path
) -> None:
    client, mcp, server = harness
    server.state["submissions"] = [{"sum": 1}, {"sum": 2}]  # type: ignore[attr-defined]  # never provides `product`
    result = _run(client, mcp, tmp_path, max_attempts=2)
    assert result.outcome is Outcome.FORMAT_FAILED
    assert result.format_attempts == 2
