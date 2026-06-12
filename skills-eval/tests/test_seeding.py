"""Offline seeding tests against a real stdlib HTTP server (no mocks): exercises the model
sync-then-poll, the GitHub-import cap, and remote MCP registration over the real client."""

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from eval_client import EvalClient
from seeding import (
    ensure_provider_and_models,
    register_remote_mcp,
    seed_realistic_skills,
)

_MODEL = {"id": "m-uuid", "modelId": "claude-sonnet-4-6", "apiKeys": [{"id": "key-1"}]}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def _json(self, payload: object, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        state = self.server.state  # type: ignore[attr-defined]
        match self.path:
            case "/api/llm-provider-api-keys":
                self._json({"id": "key-1"})
            case "/api/llm-models/sync":
                state["synced"] = True
                self._json({"success": True})
            case "/api/skills/github/discover":
                self._json({"skills": [{"skillPath": f"skills/s{i}"} for i in range(12)]})
            case "/api/skills/github/import":
                state["imported"] = body["skillPaths"]
                self._json({"created": [], "skipped": [], "skippedFiles": []})
            case "/api/internal_mcp_catalog":
                self._json({"id": "cat-1"})
            case "/api/mcp_server":
                state["installed"] = body
                self._json({"id": "srv-1"})
            case _:
                self._json({"error": "not found"}, status=404)

    def do_GET(self) -> None:
        state = self.server.state  # type: ignore[attr-defined]
        if self.path == "/api/llm-models":
            self._json({"items": [_MODEL] if state["synced"] else []})
        elif self.path == "/api/mcp_server/srv-1/tools":
            self._json({"items": [{"id": "tool-1", "name": "fix__submit_result"}]})
        else:
            self._json({"error": "not found"}, status=404)


@pytest.fixture()
def client() -> Iterator[EvalClient]:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    server.state = {"synced": False, "imported": None, "installed": None}  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with EvalClient(f"http://127.0.0.1:{server.server_address[1]}", api_key="sk-test") as c:
            yield c
    finally:
        server.shutdown()
        thread.join()


def test_ensure_provider_and_models_forces_sync_then_resolves(client: EvalClient) -> None:
    resolved = ensure_provider_and_models(
        client,
        provider="anthropic",
        api_key="sk-ant-test",
        models=["claude-sonnet-4-6"],
        timeout_s=5.0,
        interval_s=0.01,
    )
    assert resolved["claude-sonnet-4-6"].model_id == "m-uuid"
    assert resolved["claude-sonnet-4-6"].api_key_id == "key-1"


def test_seed_realistic_skills_caps_imports(client: EvalClient) -> None:
    selected = seed_realistic_skills(client, repo_url="github.com/arsenyinfo/skills", cap=10)
    assert len(selected) == 10
    assert selected[0] == "skills/s0"


def test_register_remote_mcp_returns_discovered_tools(client: EvalClient) -> None:
    registered = register_remote_mcp(client, name="fix", server_url="http://127.0.0.1:1/mcp")
    assert registered.server_id == "srv-1"
    assert registered.tools[0]["name"] == "fix__submit_result"
