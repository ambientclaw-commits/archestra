# skills-eval

A benchmark / trajectory generator for Archestra's core agentic features (skills today; sandboxes,
apps, and filesystem later). Each run boots a fresh, isolated Archestra backend, seeds preset
fixtures, drives agentic chat sessions to solve tasks, grades the submitted answers out of band, and
tears the instance down.

## Protocol

```
start the harness-owned benchmark MCP (submit_result) in-process
  -> boot a fresh backend on a new port over a fresh, migrated database
     (reusing the dev stack's shared Postgres + Dagger engine)
  -> seed: provider key + models, task skills, a realistic GitHub skill library,
           task fixture MCPs, the benchmark MCP; lock the eval agent's tool surface
  -> for each task x model:
       drive the task's ordered conversation stages (user asks X -> corrects to Y),
       saving the streamed trajectory
  -> read the submitted result from the benchmark MCP and verify its bytes out of band
  -> aggregate, write artifacts, drop the database + kill the backend
```

The agent hands in its answer by calling the benchmark MCP's `submit_result` tool. That tool checks
only the **format** of the answer (against the task's JSON-schema) and, on a malformed payload,
returns a structured error so the model self-corrects within its own tool loop — bounded by a small
attempt budget. Real correctness is checked **out of band** by the task's vendored verifier, which
never enters the sandbox or the MCP, so the agent can never read or game it.

## Lifecycle: fresh backend over shared infra

The harness does not run its own Tilt stack. It reuses the developer's already-running stack's
shared Postgres and Dagger code-runtime engine, and stands up only what must be isolated: a fresh
database (migrated from scratch) plus a second backend **process** on a new port. The backend reads
`process.env` directly, so benchmark overrides (fresh DB URL, new API/metrics ports, shared Dagger
host) take effect without a git worktree, a second Tilt, or any edit to `platform/.env`. The second
backend runs the already-built `dist/server.mjs` the main stack keeps fresh, so it never starts a
competing `tsdown --watch`. Teardown always runs: the backend process group is killed and the
benchmark database is dropped.

## Tasks

A task is an ordered list of conversation **stages** plus a `result_schema` and a vendored verifier.
Two ship today:

- `bike-rebalance` — a single-stage SkillsBench optimization task; the agent computes in the sandbox
  and submits its `report.json` inline. Four bundled skills; SCIP-backed verifier with a fidelity
  oracle (`--gate-only`).
- `multistage-demo` — a trivial two-turn task (ask the sum, then correct to the product) with a
  no-dependency verifier; exercises the multi-stage + submit_result + verify path.

## Outcomes

Each (task, model) cell resolves to exactly one outcome:

- `passed` / `failed` — a well-formed result was submitted and the verifier accepted / rejected it.
- `format_failed` — the agent submitted but never matched the schema within the attempt budget.
- `no_submission` — the run finished without ever calling `submit_result`.
- `agent_error` — the chat run errored before a result could be graded.

## Run

```bash
export ANTHROPIC_API_KEY=<key>

uv run run.py --task bike-rebalance --model claude-sonnet-4-6
uv run run.py --task multistage-demo --model claude-sonnet-4-6,other-model
uv run run.py --task bike-rebalance --gate-only
```

`--task` and `--model` each accept one name or a comma-separated list. `--provider` defaults to
`anthropic` (the key is read from `ANTHROPIC_API_KEY`). `--run-dir` overrides the artifact directory;
by default artifacts go under `skills-eval/experiments/run_<id>/` (gitignored). `--out` writes the
markdown report to a file instead of stdout.

Each run directory contains `config.json`, `backend.log`, `aggregate.json`, and a subdirectory per
(task, model) with:

- `trajectory.jsonl` — parsed chat stream events plus ignored/parse-error records and errors.
- `run.json` — metadata: model/conversation ids, outcome, finish reason, token/tool counts, format
  attempts, verifier result, artifact paths.
- `submission.json` — the accepted result bytes (when one was submitted).
- `verifier.stdout.txt` / `verifier.stderr.txt` — verifier process output (when verification ran).

## Prerequisites

- A running Archestra dev stack (`tilt up` with `ARCHESTRA_CODE_RUNTIME_ENABLED=true`) providing the
  shared Postgres (host-reachable on `localhost:5432`) and the Dagger engine (`tcp://127.0.0.1:1234`),
  with the backend built (`dist/server.mjs`).
- A real provider key in the environment (`ANTHROPIC_API_KEY`).
- Local `uv` for the harness and the ephemeral verifier environments.

## Tests

```bash
uv run --group dev ruff check .
uv run --group dev ty check
uv run --group dev pytest -q
```

The offline suite uses real components, not mocks: the benchmark MCP runs in-thread and is driven by
a real MCP client over HTTP; seeding/orchestration run against stdlib `HTTPServer` stubs of the
Archestra API; the verifier runs as a real subprocess; the multi-stage end-to-end test drives the
real submit_result gate and the real verifier through every outcome class. The live boot, model run,
and SCIP solve are manual.
