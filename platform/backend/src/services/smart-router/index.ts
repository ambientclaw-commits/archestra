import type { LlmRouter, RouterMode } from "@/types";
import { classifyWithCheapModel } from "./classifier";
import { classifyHeuristic } from "./heuristic";

/**
 * Calibrated difficulty thresholds per admin-facing mode. The router picks the
 * premium model when the difficulty score is >= the mode's threshold, so a
 * higher threshold (cost) sends fewer requests to premium.
 */
const MODE_THRESHOLDS: Record<RouterMode, number> = {
  cost: 0.7,
  balanced: 0.5,
  quality: 0.3,
};

export interface SmartRouteDecision {
  tier: "cheap" | "premium";
  source: "heuristic" | "classifier" | "capability";
  mode: RouterMode;
  /** Difficulty in 0..1 that drove the decision. */
  score: number;
  threshold: number;
  reason: string;
  /** Premium model string — what the request would cost without routing. */
  baselineModel: string;
  /** The model the request is actually routed to. */
  chosenModel: string;
}

/**
 * Hybrid per-request routing decision: a zero-cost heuristic handles the
 * obvious easy/hard cases, and only ambiguous prompts pay for a cheap-model
 * classifier call. The caller resolves the candidate model strings (so this
 * stays provider-agnostic) and applies `chosenModel` to the request.
 */
export async function resolveSmartRoute(params: {
  router: LlmRouter;
  cheapModel: string;
  premiumModel: string;
  promptText: string;
  hasTools: boolean;
  /** Whether each candidate supports tool calling (null = unknown). */
  cheapSupportsTools: boolean | null;
  premiumSupportsTools: boolean | null;
  agentId: string;
  userId?: string;
  sessionId?: string;
}): Promise<SmartRouteDecision> {
  const { router, cheapModel, premiumModel, promptText, hasTools } = params;
  const threshold = MODE_THRESHOLDS[router.mode];

  const heuristic = classifyHeuristic({ promptText, hasTools });
  let score = heuristic.score;
  let reason = heuristic.reason;
  let source: SmartRouteDecision["source"] = "heuristic";

  if (heuristic.band === "ambiguous" && router.cheapModelId) {
    const classified = await classifyWithCheapModel({
      cheapModelId: router.cheapModelId,
      cheapApiKeyId: router.cheapApiKeyId,
      promptText,
      agentId: params.agentId,
      userId: params.userId,
      sessionId: params.sessionId,
    });
    if (classified) {
      score = classified.score;
      reason = classified.reason;
      source = "classifier";
    }
  }

  let tier: SmartRouteDecision["tier"] =
    score >= threshold ? "premium" : "cheap";

  // Capability guard: a tool-bearing request must never land on a model that is
  // known not to support tool calling. Escalate to premium when the cheap model
  // can't do tools (and premium can).
  if (
    hasTools &&
    tier === "cheap" &&
    params.cheapSupportsTools === false &&
    params.premiumSupportsTools !== false
  ) {
    tier = "premium";
    reason = "cheap model lacks tool support";
    source = "capability";
  }

  return {
    tier,
    source,
    mode: router.mode,
    score,
    threshold,
    reason,
    baselineModel: premiumModel,
    chosenModel: tier === "premium" ? premiumModel : cheapModel,
  };
}
