"""tests for the chat-streaming + sandbox-file client against a REAL local http.server.

no mocks: a stdlib HTTPServer emits a UI-message-stream with an interleaved tool step, so the
tests prove the parser accumulates text across the whole run (not stopping at the first finish)
and that completion is the stream's EOF.
"""
import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from archestra_client import ArchestraApiError
from eval_client import ChatRunResult, EvalClient, FilePart, _apply_chat_event

# a run with text split *around* a tool step: a naive "stop on first finish" parser would
# capture only "Hel". draining to EOF must yield "Hello".
_CHAT_EVENTS = [
    {"type": "start"},
    {"type": "text-delta", "id": "t1", "delta": "Hel"},
    {"type": "tool-input-available", "toolCallId": "c1", "toolName": "run_command"},
    {"type": "finish-step"},
    {"type": "text-delta", "id": "t1", "delta": "lo"},
    {"type": "data-token-usage", "data": {"totalTokens": 1234}},
    {"type": "finish", "finishReason": "stop"},
]


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        match self.path:
            case "/api/chat/conversations":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"id": "conv-1", "agentId": "a-1"}).encode())
            case "/api/chat":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b": keepalive\n\n")
                self.wfile.write(b"data: not-json\n\n")
                for event in _CHAT_EVENTS:
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                # HTTP/1.0 closes the connection on return -> EOF is the completion signal.
            case _:
                self.send_response(404)
                self.end_headers()

    def do_GET(self) -> None:
        if self.path.startswith("/api/skill-sandbox/conversations/conv-1/file?path="):
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(b'{"objective": 5.55}')
        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error": "no such file"}')


@pytest.fixture()
def client() -> Iterator[EvalClient]:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with EvalClient(f"http://127.0.0.1:{server.server_address[1]}", api_key="sk-test") as c:
            yield c
    finally:
        server.shutdown()
        thread.join()


def test_create_conversation_returns_id(client: EvalClient) -> None:
    assert client.create_conversation("a-1", title="t")["id"] == "conv-1"


def test_run_chat_accumulates_text_across_tool_step(client: EvalClient) -> None:
    result = client.run_chat("conv-1", text="solve it", timeout_s=10)
    assert result.text == "Hello"  # both deltas, despite the tool step + intermediate finish
    assert result.tool_calls == ["run_command"]
    assert result.finish_reason == "stop"
    assert result.total_tokens == 1234
    assert result.stream_error is None


def test_run_chat_sends_file_parts_without_error(client: EvalClient) -> None:
    files = (FilePart("data.json", "application/json", b'{"k": 1}'),)
    assert client.run_chat("conv-1", text="use the data", files=files, timeout_s=10).text == "Hello"


def test_stream_chat_records_malformed_sse_lines(client: EvalClient) -> None:
    records = list(client.stream_chat_records("conv-1", text="solve it", timeout_s=10))

    assert any(record.kind == "ignored" and record.reason == "non-data line" for record in records)
    assert any(record.kind == "parse_error" and record.raw == "data: not-json" for record in records)
    assert [record.event for record in records if record.kind == "event"] == _CHAT_EVENTS


def test_read_sandbox_file_returns_bytes(client: EvalClient) -> None:
    assert client.read_sandbox_file("conv-1", "/home/sandbox/report.json") == b'{"objective": 5.55}'


def test_read_sandbox_file_missing_raises(client: EvalClient) -> None:
    with pytest.raises(ArchestraApiError) as excinfo:
        client.read_sandbox_file("conv-other", "/home/sandbox/nope.json")
    assert excinfo.value.status == 404


def test_run_chat_connection_failure_raises_status_zero() -> None:
    port = _unused_port()
    with EvalClient(f"http://127.0.0.1:{port}", api_key="sk-test") as client:
        with pytest.raises(ArchestraApiError) as excinfo:
            client.run_chat("conv-1", text="solve it", timeout_s=1)
    assert excinfo.value.status == 0


def test_file_part_data_url_round_trips() -> None:
    part = FilePart("d.json", "application/json", b'{"k": 1}').to_data_url_part()
    assert part["type"] == "file"
    assert part["url"] == "data:application/json;base64,eyJrIjogMX0="
    assert part["filename"] == "d.json"


def test_apply_chat_event_tolerates_text_field_name() -> None:
    # some AI-SDK paths emit `text` rather than `delta` for a text-delta.
    result = ChatRunResult(text="")
    _apply_chat_event(result, {"type": "text-delta", "text": "hi"})
    assert result.text == "hi"


def test_apply_chat_event_records_stream_error() -> None:
    result = ChatRunResult(text="")
    _apply_chat_event(result, {"type": "error", "errorText": "model exploded"})
    assert result.stream_error == "model exploded"


def _unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
