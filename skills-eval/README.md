# skills-eval

Internal SkillsBench smoke eval for Archestra's real HTTP surface. It seeds the task skills, equips
one eval agent with the required Archestra tools, runs each task/model once, reads the agent's
`/home/sandbox/report.json`, and verifies it outside the sandbox.

## Protocol

```
seed eval agent + task skills
  -> assign required Archestra tools
  -> create one conversation per task/model
  -> send instruction + input files as chat file parts
  -> drain /api/chat to EOF, saving the stream trajectory
  -> read /home/sandbox/report.json through the conversation-file route
  -> run the vendored verifier locally in an isolated uv environment
```

The verifier and oracle never enter the sandbox, so the model cannot inspect them. The backend route
`GET /api/skill-sandbox/conversations/:conversationId/file?path=...` is a no-command export path:
it does not run a sandbox command or alter the sandbox filesystem, but materializing the sandbox can
replay pending uploads and persist an artifact row just like `download_file`.

## Required Tools

The harness assigns exact Archestra tool names and fails if any are unavailable:

- `archestra__artifact_write`
- `archestra__todo_write`
- `archestra__run_command`
- `archestra__upload_file`
- `archestra__download_file`
- `archestra__list_skills`
- `archestra__load_skill`

It refuses to run if the eval agent can see `archestra__create_skill` or `archestra__update_skill`,
because benchmark runs must not mutate the skill library.

## Skill Seeding

For each vendored task skill, the harness looks up the exact skill name with the API. If the skill is
missing, it creates the org-scoped skill. If an exact name already exists, the harness fetches the
skill detail and requires the stored `SKILL.md` and bundled files to match the vendored source. Stale
or ambiguous same-name skills fail the run instead of being silently reused.

## Run

```bash
export ARCHESTRA_BASE_URL=http://localhost:9000
export ARCHESTRA_API_KEY=<minted key>

uv run run.py --task bike-rebalance --model claude-sonnet-4-6
uv run run.py --task bike-rebalance --model claude-sonnet-4-6,other-model
uv run run.py --task bike-rebalance --gate-only
```

`--run-dir` overrides the artifact directory. By default artifacts are written under
`skills-eval/experiments/run_<timestamp>/`, which is gitignored.

Each task/model attempt gets a subdirectory containing:

- `trajectory.jsonl`: raw parsed chat stream events plus ignored/parse-error stream records and errors.
- `run.json`: metadata, model/conversation ids, finish reason, token/tool counts, errors, verifier result, and artifact paths.
- `report.json`: fetched sandbox output when available.
- `verifier.stdout.txt` / `verifier.stderr.txt`: verifier process output when verification runs.

## Prerequisites

- Running Archestra backend with skill sandbox enabled (`ARCHESTRA_CODE_RUNTIME_ENABLED=true`).
- A synced model row with a linked provider key.
- Local `uv` for verifier environments.

## Tests

Offline checks:

```bash
uv run --group dev ruff check .
uv run --group dev ty check
uv run --group dev pytest -q
```

The suite uses real components where practical: stdlib `HTTPServer` for HTTP/streaming boundaries,
real filesystem artifacts, and real verifier subprocesses. The heavy live sandbox/model run is manual.
