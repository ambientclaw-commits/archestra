import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from eval_client import EvalClient
from run import _run_model_task
from tasks import AdaptedTask, TaskConfig, VerifierSpec

_CHAT_EVENTS = [
    {"type": "tool-input-available", "toolCallId": "c1", "toolName": "run_command"},
    {"type": "data-token-usage", "data": {"totalTokens": 42}},
    {"type": "finish", "finishReason": "stop"},
]


@contextmanager
def _client(
    *,
    conversation_status: int = 200,
    chat_status: int = 200,
    sandbox_status: int = 200,
    report_bytes: bytes = b'{"objective": 5}',
    malformed_sse: bool = False,
) -> Iterator[EvalClient]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def do_POST(self) -> None:
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            match self.path:
                case "/api/chat/conversations":
                    self.send_response(conversation_status)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    body = {"id": "conv-1", "agentId": "agent-1"} if conversation_status == 200 else {"error": "nope"}
                    self.wfile.write(json.dumps(body).encode())
                case "/api/chat":
                    self.send_response(chat_status)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    if chat_status == 200:
                        if malformed_sse:
                            self.wfile.write(b"data: not-json\n\n")
                        for event in _CHAT_EVENTS:
                            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                        self.wfile.write(b"data: [DONE]\n\n")
                    else:
                        self.wfile.write(b'{"error": "chat failed"}')
                case _:
                    self.send_response(404)
                    self.end_headers()

        def do_GET(self) -> None:
            if self.path.startswith("/api/skill-sandbox/conversations/conv-1/file?path="):
                self.send_response(sandbox_status)
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                if sandbox_status == 200:
                    self.wfile.write(report_bytes)
                else:
                    self.wfile.write(b'{"error": "missing"}')
            else:
                self.send_response(404)
                self.end_headers()

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with EvalClient(f"http://127.0.0.1:{server.server_address[1]}", api_key="sk-test") as client:
            yield client
    finally:
        server.shutdown()
        thread.join()


def test_run_model_task_saves_success_trajectory_and_artifacts(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with _client() as client:
        result = _run_model_task(
            client=client,
            root_run_dir=tmp_path / "runs",
            agent_id="agent-1",
            model_name="model-a",
            model_id="model-id",
            api_key_id="key-id",
            adapted=_adapted(config),
            config=config,
        )

    run_dir = tmp_path / "runs" / "mini__model-a"
    metadata = _read_json(run_dir / "run.json")
    trajectory = _read_jsonl(run_dir / "trajectory.jsonl")

    assert result.verifier_passed
    assert result.tool_call_count == 1
    assert metadata["conversation_id"] == "conv-1"
    assert metadata["verifier_passed"] is True
    assert (run_dir / "report.json").read_bytes() == b'{"objective": 5}'
    assert (run_dir / "verifier.stdout.txt").exists()
    assert any(record["kind"] == "conversation_created" for record in trajectory)
    assert any(
        record["kind"] == "chat_stream" and record.get("event", {}).get("type") == "finish"
        for record in trajectory
    )


def test_run_model_task_records_create_conversation_failure(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with _client(conversation_status=500) as client:
        result = _run_model_task(
            client=client,
            root_run_dir=tmp_path / "runs",
            agent_id="agent-1",
            model_name="model-a",
            model_id="model-id",
            api_key_id=None,
            adapted=_adapted(config),
            config=config,
        )

    run_dir = tmp_path / "runs" / "mini__model-a"
    metadata = _read_json(run_dir / "run.json")
    trajectory = _read_jsonl(run_dir / "trajectory.jsonl")

    assert not result.verifier_passed
    assert result.agent_error is not None
    assert metadata["conversation_id"] is None
    assert any(record["kind"] == "create_conversation_error" for record in trajectory)


def test_run_model_task_records_chat_transport_failure(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with _client(chat_status=500) as client:
        result = _run_model_task(
            client=client,
            root_run_dir=tmp_path / "runs",
            agent_id="agent-1",
            model_name="model-a",
            model_id="model-id",
            api_key_id=None,
            adapted=_adapted(config),
            config=config,
        )

    trajectory = _read_jsonl(tmp_path / "runs" / "mini__model-a" / "trajectory.jsonl")

    assert not result.verifier_passed
    assert result.agent_error is not None
    assert any(record["kind"] == "chat_error" for record in trajectory)


def test_run_model_task_records_sandbox_read_failure(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with _client(sandbox_status=404) as client:
        result = _run_model_task(
            client=client,
            root_run_dir=tmp_path / "runs",
            agent_id="agent-1",
            model_name="model-a",
            model_id="model-id",
            api_key_id=None,
            adapted=_adapted(config),
            config=config,
        )

    trajectory = _read_jsonl(tmp_path / "runs" / "mini__model-a" / "trajectory.jsonl")

    assert not result.verifier_passed
    assert result.agent_error is not None
    assert any(record["kind"] == "sandbox_read_error" for record in trajectory)


def test_run_model_task_fails_on_malformed_chat_stream_record(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with _client(malformed_sse=True) as client:
        result = _run_model_task(
            client=client,
            root_run_dir=tmp_path / "runs",
            agent_id="agent-1",
            model_name="model-a",
            model_id="model-id",
            api_key_id=None,
            adapted=_adapted(config),
            config=config,
        )

    run_dir = tmp_path / "runs" / "mini__model-a"
    metadata = _read_json(run_dir / "run.json")
    trajectory = _read_jsonl(run_dir / "trajectory.jsonl")

    assert not result.verifier_passed
    assert result.agent_error is not None
    assert "malformed chat stream data" in result.agent_error
    assert "malformed chat stream data" in str(metadata["agent_error"])
    assert any(record["kind"] == "chat_parse_error" for record in trajectory)
    assert not (run_dir / "report.json").exists()


def test_run_model_task_refuses_existing_artifact_directory(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with _client() as client:
        result = _run_model_task(
            client=client,
            root_run_dir=tmp_path / "runs",
            agent_id="agent-1",
            model_name="model-a",
            model_id="model-id",
            api_key_id=None,
            adapted=_adapted(config),
            config=config,
        )
        assert result.verifier_passed
        with pytest.raises(FileExistsError, match="run artifact directory already exists"):
            _run_model_task(
                client=client,
                root_run_dir=tmp_path / "runs",
                agent_id="agent-1",
                model_name="model-a",
                model_id="model-id",
                api_key_id=None,
                adapted=_adapted(config),
                config=config,
            )


def test_run_model_task_keeps_verifier_verdict_failure_nonfatal(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with _client(report_bytes=b'{"objective": 999}') as client:
        result = _run_model_task(
            client=client,
            root_run_dir=tmp_path / "runs",
            agent_id="agent-1",
            model_name="model-a",
            model_id="model-id",
            api_key_id=None,
            adapted=_adapted(config),
            config=config,
        )

    metadata = _read_json(tmp_path / "runs" / "mini__model-a" / "run.json")

    assert not result.verifier_passed
    assert result.agent_error is None
    assert metadata["verifier_passed"] is False
    assert isinstance(metadata["verifier_exit_code"], int)


def test_run_model_task_finalizes_artifacts_before_verifier_infrastructure_error(tmp_path: Path) -> None:
    config = _config(tmp_path, data_file="missing.json")
    with _client() as client:
        with pytest.raises(FileNotFoundError):
            _run_model_task(
                client=client,
                root_run_dir=tmp_path / "runs",
                agent_id="agent-1",
                model_name="model-a",
                model_id="model-id",
                api_key_id=None,
                adapted=_adapted(config),
                config=config,
            )

    run_dir = tmp_path / "runs" / "mini__model-a"
    metadata = _read_json(run_dir / "run.json")
    trajectory = _read_jsonl(run_dir / "trajectory.jsonl")

    assert (run_dir / "report.json").exists()
    assert "verifier infrastructure error" in str(metadata["agent_error"])
    assert any(record["kind"] == "verifier_infrastructure_error" for record in trajectory)


def _config(tmp_path: Path, *, data_file: str = "data.json") -> TaskConfig:
    upstream = tmp_path / "upstream"
    (upstream / "tests").mkdir(parents=True)
    (upstream / "tests" / "check.py").write_text(
        """
import json
import os


def test_objective_matches():
    report = json.load(open(os.environ["TEST_REPORT"]))
    data = json.load(open(os.environ["TEST_DATA"]))
    assert report["objective"] == data["expected"]
""".lstrip(),
        encoding="utf-8",
    )
    (upstream / "data.json").write_text(json.dumps({"expected": 5}), encoding="utf-8")
    return TaskConfig(
        id="mini",
        upstream_dir=upstream,
        instruction="instruction.md",
        instruction_suffix="",
        output_path="/home/sandbox/report.json",
        agent_files=(),
        skills=(),
        verifier=VerifierSpec(
            deps=(),
            test_file="tests/check.py",
            data_file=data_file,
            report_env="TEST_REPORT",
            data_env="TEST_DATA",
        ),
    )


def _adapted(config: TaskConfig) -> AdaptedTask:
    return AdaptedTask(
        id=config.id,
        instruction="write report.json",
        agent_files=(),
        skills=(),
        verifier=config.verifier,
    )


def _read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
