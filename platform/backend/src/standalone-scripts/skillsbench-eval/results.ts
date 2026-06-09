// result contract produced by the live stages (fidelity gate + agent runs) and
// consumed by the report. kept separate from the adaptation types so the pure
// report aggregation can be built and tested without touching the sandbox.

/** paired-protocol arm: agent runs the task without vs. with the task's skills mounted. */
export type Arm = "without_skill" | "with_skill";

export const ARMS: readonly Arm[] = ["without_skill", "with_skill"];

export interface CommandOutcome {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/** either a completed command or a stage that failed before/around it. */
export type StageOutcome = CommandOutcome | { readonly error: string };

export function isError(
  outcome: StageOutcome | null,
): outcome is { readonly error: string } {
  return outcome !== null && "error" in outcome;
}

export function commandPassed(outcome: StageOutcome | null): boolean {
  return (
    outcome !== null &&
    !isError(outcome) &&
    outcome.exitCode === 0 &&
    !outcome.timedOut
  );
}

/** fidelity gate: the task's own oracle must reproduce a verifier-passing solution. */
export interface GateResult {
  readonly taskId: string;
  readonly passed: boolean;
  readonly oracle: StageOutcome;
  readonly verifier: StageOutcome | null;
}

/** one agent attempt at a task under a given model + arm. */
export interface ArmRunResult {
  readonly taskId: string;
  readonly model: string;
  readonly arm: Arm;
  readonly verifierPassed: boolean;
  readonly agentFinishReason: string;
  readonly agentError: string | null;
  readonly verifier: StageOutcome | null;
  readonly usage: { readonly totalTokens: number } | null;
}
