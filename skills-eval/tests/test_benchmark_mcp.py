"""Real-HTTP tests for the benchmark MCP: the server runs in-thread and is driven over the wire
by an actual MCP streamable-http client, exercising the same transport Archestra uses."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from benchmark_mcp import BenchmarkMcp, SubmissionAccepted, SubmissionFormatFailed

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["answer"],
    "properties": {"answer": {"type": "number"}},
    "additionalProperties": False,
}


def _call(base_url: str, result: dict[str, Any]) -> str:
    async def go() -> str:
        async with streamable_http_client(base_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                response = await session.call_tool("submit_result", {"result": result})
                return "".join(block.text for block in response.content if block.type == "text")

    return asyncio.run(go())


def test_valid_submission_is_accepted_as_canonical_bytes() -> None:
    with BenchmarkMcp() as mcp:
        mcp.begin_task(schema=_SCHEMA, max_attempts=3)
        reply = _call(mcp.base_url(), {"answer": 42})
        assert "accepted" in reply.lower()
        submission = mcp.take_submission()
        assert isinstance(submission, SubmissionAccepted)
        assert submission.attempts == 1
        assert json.loads(submission.payload_bytes) == {"answer": 42}


def test_malformed_then_corrected() -> None:
    with BenchmarkMcp() as mcp:
        mcp.begin_task(schema=_SCHEMA, max_attempts=3)
        bad = _call(mcp.base_url(), {"answer": "not a number"})
        assert "submit_result again" in bad
        assert mcp.take_submission() is None
        good = _call(mcp.base_url(), {"answer": 7})
        assert "accepted" in good.lower()
        submission = mcp.take_submission()
        assert isinstance(submission, SubmissionAccepted)
        assert submission.attempts == 2


def test_budget_exhaustion_is_format_failed() -> None:
    with BenchmarkMcp() as mcp:
        mcp.begin_task(schema=_SCHEMA, max_attempts=2)
        _call(mcp.base_url(), {"answer": "x"})
        last = _call(mcp.base_url(), {"answer": "y"})
        assert "budget is exhausted" in last
        submission = mcp.take_submission()
        assert isinstance(submission, SubmissionFormatFailed)
        assert submission.attempts == 2
        assert submission.errors


def test_budget_exhaustion_is_terminal_even_if_later_valid() -> None:
    with BenchmarkMcp() as mcp:
        mcp.begin_task(schema=_SCHEMA, max_attempts=2)
        _call(mcp.base_url(), {"answer": "x"})
        _call(mcp.base_url(), {"answer": "y"})  # exhausts the budget -> format_failed (terminal)
        late = _call(mcp.base_url(), {"answer": 7})  # a valid submit must NOT revive the task
        assert "exhausted" in late
        submission = mcp.take_submission()
        assert isinstance(submission, SubmissionFormatFailed)
        assert submission.attempts == 2


def test_first_valid_submission_wins() -> None:
    with BenchmarkMcp() as mcp:
        mcp.begin_task(schema=_SCHEMA, max_attempts=5)
        _call(mcp.base_url(), {"answer": 1})
        second = _call(mcp.base_url(), {"answer": 2})
        assert "already accepted" in second.lower()
        submission = mcp.take_submission()
        assert isinstance(submission, SubmissionAccepted)
        assert json.loads(submission.payload_bytes) == {"answer": 1}


def test_no_active_task_is_ignored() -> None:
    with BenchmarkMcp() as mcp:
        reply = _call(mcp.base_url(), {"answer": 1})
        assert "no benchmark task" in reply.lower()
        assert mcp.take_submission() is None
