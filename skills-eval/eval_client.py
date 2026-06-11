# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""chat-driving + sandbox file-read extensions to the migration-kit ArchestraClient.

the benchmark reuses the zero-dependency migration-kit client verbatim (auth, request
plumbing, typed create_* payloads) and subclasses it here -- so the shipped migration skill
gains no benchmark-only code, and we still talk to one real archestra instance over HTTP.

three capabilities the migration client doesn't need but the eval does:
  - create_conversation: open a chat conversation bound to an agent (gives a conversationId,
    which is what makes the per-conversation skill sandbox + skill activation + attachment
    staging engage -- the A2A path can't thread one).
  - run_chat: POST /api/chat and consume the server-driven model+tool loop's streamed
    UI-message events to completion, returning the final assistant text + run metadata.
  - read_sandbox_file: GET a file the agent wrote, from the conversation's materialized
    sandbox, via the no-command backend route the eval adds.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Literal

from archestra_client import ArchestraApiError, ArchestraClient, _items
from contracts import JsonValue, require_dict

# an agent run drives a full model+tool loop; it takes minutes, not the client's default 30s.
DEFAULT_CHAT_TIMEOUT_S = 1800.0


@dataclass(frozen=True)
class FilePart:
    """an input file delivered inline in the chat message. the backend turns it into a
    conversation attachment that auto-stages into the sandbox under /home/sandbox/attachments/
    on the agent's first run_command."""

    filename: str
    mime_type: str
    data: bytes

    def to_data_url_part(self) -> dict[str, JsonValue]:
        b64 = base64.b64encode(self.data).decode("ascii")
        return {
            "type": "file",
            "url": f"data:{self.mime_type};base64,{b64}",
            "filename": self.filename,
            "mediaType": self.mime_type,
        }


@dataclass
class ChatRunResult:
    """outcome of one agent turn driven to completion."""

    text: str  # accumulated final assistant text
    tool_calls: list[str] = field(default_factory=list)  # tool names the model invoked, in order
    finish_reason: str | None = None
    total_tokens: int | None = None
    stream_error: str | None = None  # an error event surfaced mid-stream (run did not finish clean)


@dataclass(frozen=True)
class ChatStreamRecord:
    """One observable chat stream line after SSE parsing."""

    kind: Literal["event", "ignored", "parse_error"]
    event: dict[str, JsonValue] | None = None
    raw: str | None = None
    reason: str | None = None


class EvalClient(ArchestraClient):
    """ArchestraClient plus the chat + sandbox-file calls the benchmark needs."""

    def __enter__(self) -> "EvalClient":
        return self

    # --- models ----------------------------------------------------------------------------

    def list_models(self) -> list[dict[str, JsonValue]]:
        """all synced LLM models with their linked provider api keys. each row's `id` is the
        UUID used as a conversation's `modelId`; `modelId` is the provider model name."""
        return _items(self._request("GET", "/api/llm-models"))

    # --- skills & tools ---------------------------------------------------------------------

    def get_skill(self, skill_id: str) -> dict[str, JsonValue]:
        return require_dict(self._request("GET", f"/api/skills/{skill_id}"), ctx="GET /api/skills/:id")

    def list_agent_tools(self, agent_id: str) -> list[dict[str, JsonValue]]:
        return _items(self._request("GET", f"/api/agents/{agent_id}/tools"))

    def get_agent(self, agent_id: str) -> dict[str, JsonValue]:
        return require_dict(self._request("GET", f"/api/agents/{agent_id}"), ctx="GET /api/agents/:id")

    # --- conversations & chat --------------------------------------------------------------

    def create_conversation(self, agent_id: str, *, title: str | None = None,
                            model_id: str | None = None,
                            chat_api_key_id: str | None = None) -> dict[str, JsonValue]:
        body: dict[str, JsonValue] = {"agentId": agent_id}
        if title is not None:
            body["title"] = title
        if model_id is not None:
            body["modelId"] = model_id
        if chat_api_key_id is not None:
            body["chatApiKeyId"] = chat_api_key_id
        return require_dict(self._request("POST", "/api/chat/conversations", json_body=body),
                            ctx="POST /api/chat/conversations")

    def run_chat(self, conversation_id: str, *, text: str, files: tuple[FilePart, ...] = (),
                 timeout_s: float = DEFAULT_CHAT_TIMEOUT_S) -> ChatRunResult:
        """send one user message and drive the server-side model+tool loop to completion.

        completion is the stream's EOF: the backend holds the response open for the whole run
        and closes it when finished, so we drain every event rather than stopping on the first
        text/step finish (intermediate tool steps also finish). an `error` event is recorded but
        does not raise -- the caller decides what a non-clean finish means for the task."""
        result = ChatRunResult(text="")
        for record in self.stream_chat_records(conversation_id, text=text, files=files, timeout_s=timeout_s):
            if record.kind == "event" and record.event is not None:
                _apply_chat_event(result, record.event)
        return result

    def stream_chat_records(self, conversation_id: str, *, text: str, files: tuple[FilePart, ...] = (),
                            timeout_s: float = DEFAULT_CHAT_TIMEOUT_S) -> Iterator[ChatStreamRecord]:
        """Send one user message and yield every parsed/ignored chat stream record."""
        parts: list[dict[str, JsonValue]] = [{"type": "text", "text": text}]
        parts.extend(part.to_data_url_part() for part in files)
        body: dict[str, JsonValue] = {
            "id": conversation_id,
            "messages": [{"id": str(uuid.uuid4()), "role": "user", "parts": parts}],
            "trigger": "submit-message",
        }
        yield from self._stream_chat_records(body, timeout_s)

    # --- sandbox file access ---------------------------------------------------------------

    def read_sandbox_file(self, conversation_id: str, path: str) -> bytes:
        """read a file the agent produced, from the conversation's materialized sandbox.

        backed by GET /api/skill-sandbox/conversations/:id/file: it runs no command, so it cannot
        alter the sandbox filesystem. Like download_file, materializing may stage pending attachments
        and records the read bytes as an artifact. raises ArchestraApiError on any non-2xx (e.g. 404
        when the path was never written)."""
        url = self._url(f"/api/skill-sandbox/conversations/{conversation_id}/file", {"path": path})
        headers = {"Accept-Encoding": "identity"}
        if self._auth:
            headers["Authorization"] = self._auth
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise ArchestraApiError("GET", url, exc.code, _read_error_body(exc)) from exc
        except OSError as exc:
            raise ArchestraApiError("GET", url, 0, f"{type(exc).__name__}: {exc}") from exc

    # --- internal --------------------------------------------------------------------------

    def _stream_chat(self, body: dict[str, JsonValue], timeout_s: float) -> Iterator[dict[str, JsonValue]]:
        """POST /api/chat and yield parsed UI-message-stream events."""
        for record in self._stream_chat_records(body, timeout_s):
            if record.kind == "event" and record.event is not None:
                yield record.event

    def _stream_chat_records(self, body: dict[str, JsonValue], timeout_s: float) -> Iterator[ChatStreamRecord]:
        """POST /api/chat and yield every observed SSE data record."""
        url = self._url("/api/chat")
        headers = {"Accept-Encoding": "identity", "Content-Type": "application/json",
                   "Accept": "text/event-stream"}
        if self._auth:
            headers["Authorization"] = self._auth
        data = json.dumps(body, allow_nan=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            resp = self._opener.open(req, timeout=timeout_s)
        except urllib.error.HTTPError as exc:
            raise ArchestraApiError("POST", url, exc.code, _read_error_body(exc)) from exc
        except OSError as exc:
            raise ArchestraApiError("POST", url, 0, f"{type(exc).__name__}: {exc}") from exc
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                payload = _sse_data_payload(line)
                if payload is None:
                    if line:
                        yield ChatStreamRecord(kind="ignored", raw=line, reason="non-data line")
                    continue
                if payload == "[DONE]":
                    yield ChatStreamRecord(kind="ignored", raw=line, reason="done")
                    continue
                if payload == "":
                    yield ChatStreamRecord(kind="ignored", raw=line, reason="empty data payload")
                    continue
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError as exc:
                    yield ChatStreamRecord(kind="parse_error", raw=line, reason=str(exc))
                    continue
                if isinstance(event, dict):
                    yield ChatStreamRecord(kind="event", event=event)
                else:
                    yield ChatStreamRecord(kind="ignored", raw=line, reason="non-object JSON payload")


def _sse_data_payload(line: str) -> str | None:
    """extract the JSON payload from one SSE line, or None for non-data lines."""
    if not line.startswith("data:"):
        return None
    return line[len("data:"):].strip()


def _apply_chat_event(result: ChatRunResult, event: dict[str, JsonValue]) -> None:
    """fold one stream event into the accumulating result. tolerant of the AI-SDK text-delta
    field name (`delta` in v5; some paths emit `text`)."""
    match event.get("type"):
        case "text-delta":
            delta = event.get("delta")
            if not isinstance(delta, str):
                delta = event.get("text")
            if isinstance(delta, str):
                result.text += delta
        case "tool-input-available" | "tool-call":
            name = event.get("toolName")
            if isinstance(name, str):
                result.tool_calls.append(name)
        case "finish" | "finish-step":
            reason = event.get("finishReason")
            if isinstance(reason, str):
                result.finish_reason = reason
        case "data-token-usage":
            usage = event.get("data")
            if isinstance(usage, dict) and isinstance(usage.get("totalTokens"), int):
                result.total_tokens = usage["totalTokens"]
        case "error":
            text = event.get("errorText") or event.get("error")
            result.stream_error = text if isinstance(text, str) else json.dumps(event)


def _read_error_body(exc: urllib.error.HTTPError) -> str:
    raw = exc.read()
    charset = exc.headers.get_content_charset() if exc.headers else None
    return raw.decode(charset or "utf-8", errors="replace")
