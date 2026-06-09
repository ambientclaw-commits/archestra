import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostPath, sandboxPath, type TaskConfig } from "../../types";

const upstreamDir = hostPath(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "upstream"),
);

const WORKSPACE = "/home/sandbox/work";
const ws = (rel: string) => sandboxPath(`${WORKSPACE}/${rel}`);

const SKILL_NAMES = [
  "geospatial-routing-data",
  "logistics-rules-to-optimization",
  "routing-subtour-elimination",
  "scip-opt",
] as const;

// bike-rebalance: a multi-vehicle pickup/dropoff routing MIP. the oracle and the
// verifier both solve a SCIP model, so pyscipopt must import + solve in the sandbox
// (the fidelity gate is the probe for that — upstream apt-installs libgfortran5,
// which we cannot replicate non-root).
export const bikeRebalanceConfig: TaskConfig = {
  id: "bike-rebalance",
  upstreamDir,
  workspace: sandboxPath(WORKSPACE),
  instruction: "instruction.md",

  // only the input data is visible to the agent.
  agentFiles: [
    {
      upstream: "environment/data.json",
      dest: ws("data.json"),
      transform: false,
    },
  ],

  // oracle + checks, staged only for the gate / post-agent verification.
  // solve.sh hardcodes /root/... in a python heredoc (no env knob) -> transform it.
  // test_outputs.py exposes BIKE_REBALANCE_* env knobs -> keep verbatim, set env.
  verifierFiles: [
    {
      upstream: "solution/solve.sh",
      dest: ws("solution/solve.sh"),
      transform: true,
      executable: true,
    },
    {
      upstream: "tests/test_outputs.py",
      dest: ws("tests/test_outputs.py"),
      transform: false,
    },
  ],

  textReplacements: [
    { from: "/root", to: WORKSPACE },
    // defensive: solve.sh's fallback installs pyscipopt; pip is disabled in the sandbox.
    {
      from: "pip3 install --break-system-packages",
      to: "uv pip install --system",
    },
  ],

  // pytest-json-ctrf is intentionally dropped: it only served upstream test.sh's
  // --ctrf flag, and we run pytest directly (see verifierCommand).
  deps: ["pyscipopt==6.1.0", "pytest==8.4.1"],
  setup: [],

  oracleCommand: "bash solution/solve.sh",
  // run pytest directly: upstream test.sh swallows the exit code into reward.txt.
  // the `test -n` guards fail loudly if the path-redirect env regresses, rather than
  // letting test_outputs.py silently fall back to its non-writable /root defaults.
  verifierCommand:
    'test -n "$BIKE_REBALANCE_REPORT" && test -n "$BIKE_REBALANCE_DATA" && python3 -m pytest tests/test_outputs.py -rA',
  verifierEnv: {
    BIKE_REBALANCE_REPORT: `${WORKSPACE}/report.json`,
    BIKE_REBALANCE_DATA: `${WORKSPACE}/data.json`,
    // upstream's 10%-gap SCIP benchmark; cap so a broken solver can't stall the gate.
    BIKE_REBALANCE_BENCHMARK_TIME_LIMIT: "600",
  },

  skills: SKILL_NAMES.map((name) => ({
    name,
    dir: `environment/skills/${name}`,
  })),

  resourceHints: { cpus: 2, memoryMb: 8192, verifierTimeoutSec: 900 },
};
