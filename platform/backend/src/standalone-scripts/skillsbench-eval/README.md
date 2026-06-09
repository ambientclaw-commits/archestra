# SkillsBench skill/sandbox eval

A lightweight, in-process eval that runs a curated, adapted subset of
[SkillsBench](https://github.com/benchflow-ai/skillsbench) tasks on Archestra's real
skill-sandbox. Two purposes:

1. **Smoke test** the skill + sandbox pipeline end-to-end (import skill → build the
   task env in the sandbox → run the agent → run the verifier).
2. **Quick LLM read** — pass rate per model, with vs. without the task's skills, on
   non-trivial knowledge-worker tasks. The delta is the skill-efficacy signal.

It is an internal, maintained fork — **not** leaderboard-comparable. Out of scope:
MCP governance/policy, statistical rigor, the full task set.

## Architecture

Everything runs in **one in-process script** (no HTTP), against one DB + one Dagger
host. `executeA2AMessage` runs the agent loop in-process and threads `conversationId`
straight to the same default sandbox the harness stages and verifies, so there is no
cross-process sandbox-visibility gap.

```
seed (org/user/agent/llm-key) → create conversation → stage data + uv deps
  → [with-skill arm: mountSkill] → executeA2AMessage → run hidden verifier
```

Each upstream task is **vendored verbatim** under `tasks/<id>/upstream/` and adapted at
run time by `adapt.ts` (path remap into the writable `/home/sandbox/work`, pip→uv, and a
ground-truth split that keeps the oracle/verifier out of the agent's view).

## Layout

| file | role |
|---|---|
| `types.ts` | adaptation types (branded paths, `TaskConfig`, `AdaptedTask`) |
| `adapt.ts` | generic transform: vendored assets → upload-ready `AdaptedTask` |
| `results.ts` | result contract produced by the live stages |
| `report.ts` | `{task × model × arm}` matrix + skill-efficacy delta |
| `tasks/<id>/config.ts` | per-task adaptation config |
| `tasks/<id>/upstream/` | vendored SkillsBench assets (Apache-2.0, see `NOTICE`) |
| `smoke.ts` | in-process plumbing + pyscipopt probe (first live check) |

## Prerequisites (live runs)

The sandbox runtime must be up. In `platform/.env` set
`ARCHESTRA_CODE_RUNTIME_ENABLED=true`, then `tilt up` (deploys the Dagger engine and
wires the backend to it). Raise the eval caps via env as needed
(`ARCHESTRA_SKILLS_SANDBOX_CPU_LIMIT_SECONDS`, `…_MEMORY_LIMIT_BYTES`).

## Run

```bash
# offline unit tests (no sandbox needed)
ARCHESTRA_DATABASE_URL=postgres://dummy npx vitest run src/standalone-scripts/skillsbench-eval/

# in-process plumbing + pyscipopt probe (needs the runtime up)
pnpm eval:skillsbench:smoke
```
