# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""drive one real chat turn against a running local archestra instance and print the result.

this makes a REAL llm call through the running stack: pick an agent, send a prompt, drain the
chat stream, then read the persisted assistant reply and the turn's token usage / cost back.
the instance is assumed to already have a usable llm provider key + a model resolvable for the
agent -- this script never creates or edits keys.

connection comes from env:
    ARCHESTRA_BASE_URL   (default http://localhost:3000 -- the frontend origin serves /api/*)
    ARCHESTRA_API_KEY    raw api key (Authorization header), OR sign in with:
    ARCHESTRA_EMAIL      (default admin@example.com)
    ARCHESTRA_PASSWORD   (default password)

usage:
    python3 chat_turn.py --agent "My Agent" --prompt "say hi in 3 words"
    python3 chat_turn.py --agent <agent-uuid> --prompt "..." --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from smoke_client import ArchestraApiError, ChatTurnError, ChatTurnResult, SmokeClient

DEFAULT_BASE_URL = "http://localhost:3000"
DEFAULT_EMAIL = "admin@example.com"
DEFAULT_PASSWORD = "password"


def main() -> int:
    args = _parse_args()
    base_url = os.environ.get("ARCHESTRA_BASE_URL", DEFAULT_BASE_URL)
    api_key = os.environ.get("ARCHESTRA_API_KEY")

    with SmokeClient(base_url, api_key=api_key) as client:
        try:
            if api_key is None:
                client.sign_in(
                    os.environ.get("ARCHESTRA_EMAIL", DEFAULT_EMAIL),
                    os.environ.get("ARCHESTRA_PASSWORD", DEFAULT_PASSWORD),
                )
            client.connect_check()
        except (ArchestraApiError, ValueError) as exc:
            return _fail(f"cannot reach a ready archestra at {base_url}: {exc}\n"
                         "is the local stack up (`tilt up` / `pnpm dev`)?")

        agent_id = _resolve_agent(client, args.agent)
        if agent_id is None:
            return _fail(f"no agent matched {args.agent!r}; create one in the UI or pass its id")

        try:
            result = client.run_turn(agent_id, args.prompt, title=args.title, model_id=args.model)
        except ChatTurnError as exc:
            hint = "" if client.list_llm_keys() else (
                "\nthe instance has no llm provider key configured -- add one in Settings -> LLM "
                "before running a live turn"
            )
            return _fail(f"chat turn failed: {exc}{hint}")
        except ArchestraApiError as exc:
            return _fail(f"chat turn failed (api error): {exc}")

    _report(result, as_json=args.json)
    return 0


def _resolve_agent(client: SmokeClient, agent: str) -> str | None:
    """match by exact id first, then by exact name. ambiguous names resolve to the first match."""
    agents = client.list_agents()
    for row in agents:
        if row.get("id") == agent:
            return agent
    for row in agents:
        if row.get("name") == agent and isinstance(row.get("id"), str):
            return row["id"]
    return None


def _report(result: ChatTurnResult, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps({
            "conversationId": result.conversation_id,
            "text": result.text,
            "toolCalls": result.tool_calls,
            "model": result.model,
            "inputTokens": result.input_tokens,
            "outputTokens": result.output_tokens,
            "cost": result.cost,
        }, indent=2))
        return
    print(f"conversation: {result.conversation_id}")
    if result.model:
        print(f"model:        {result.model}")
    if result.tool_calls:
        print(f"tool calls:   {', '.join(result.tool_calls)}")
    tokens = _fmt_tokens(result)
    if tokens:
        print(f"usage:        {tokens}")
    print("\n--- assistant reply ---")
    print(result.text or "(no text in reply)")


def _fmt_tokens(result: ChatTurnResult) -> str:
    parts: list[str] = []
    if result.input_tokens is not None or result.output_tokens is not None:
        parts.append(f"in={result.input_tokens} out={result.output_tokens}")
    if result.cost is not None:
        parts.append(f"cost=${result.cost:.6f}")
    return " ".join(parts)


def _fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="drive one real chat turn against local archestra")
    parser.add_argument("--agent", required=True, help="agent name or id to chat with")
    parser.add_argument("--prompt", required=True, help="the user message to send")
    parser.add_argument("--model", default=None, help="optional model id override (else auto-resolved)")
    parser.add_argument("--title", default=None, help="optional conversation title")
    parser.add_argument("--json", action="store_true", help="print the result as json")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(main())
