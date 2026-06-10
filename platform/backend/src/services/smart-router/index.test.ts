import { describe, expect, it } from "vitest";
import type { LlmRouter } from "@/types";
import { resolveSmartRoute } from "./index";

/**
 * Router with no cheapModelId so the ambiguous-band classifier call is skipped
 * and resolveSmartRoute stays a pure unit (heuristic-only).
 */
function makeRouter(overrides: Partial<LlmRouter> = {}): LlmRouter {
  return {
    id: "router-1",
    organizationId: "org-1",
    name: "Test",
    enabled: true,
    cheapModelId: null,
    cheapApiKeyId: null,
    premiumModelId: "premium-uuid",
    premiumApiKeyId: "key-uuid",
    mode: "balanced",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const base = {
  cheapModel: "claude-haiku-4-5",
  premiumModel: "claude-opus-4-8",
  cheapSupportsTools: true,
  premiumSupportsTools: true,
  agentId: "agent-1",
};

describe("resolveSmartRoute", () => {
  it("routes an easy prompt to the cheap model", async () => {
    const decision = await resolveSmartRoute({
      ...base,
      router: makeRouter(),
      promptText: "what is the capital of France?",
      hasTools: false,
    });
    expect(decision.tier).toBe("cheap");
    expect(decision.chosenModel).toBe(base.cheapModel);
    expect(decision.source).toBe("heuristic");
  });

  it("escalates a tool-bearing turn when the cheap model lacks tool support", async () => {
    const decision = await resolveSmartRoute({
      ...base,
      cheapSupportsTools: false,
      router: makeRouter({ mode: "cost" }),
      promptText: "get the weather in NYC",
      hasTools: true,
    });
    expect(decision.tier).toBe("premium");
    expect(decision.source).toBe("capability");
  });

  it("keeps a tool-bearing turn on the cheap model when it supports tools", async () => {
    // cost mode (0.7): ambiguous score 0.5 < 0.7 -> cheap, and cheap supports tools
    const decision = await resolveSmartRoute({
      ...base,
      router: makeRouter({ mode: "cost" }),
      promptText: "get the weather in NYC",
      hasTools: true,
    });
    expect(decision.tier).toBe("cheap");
  });

  it("always reports the premium model as the baseline", async () => {
    const decision = await resolveSmartRoute({
      ...base,
      router: makeRouter(),
      promptText: "what is 2 + 2?",
      hasTools: false,
    });
    expect(decision.baselineModel).toBe(base.premiumModel);
  });

  it("maps modes to thresholds at the ambiguous boundary (score 0.5)", async () => {
    const ambiguous = "summarize the following note. ".repeat(40);

    // quality mode (threshold 0.3): 0.5 >= 0.3 -> premium
    const quality = await resolveSmartRoute({
      ...base,
      router: makeRouter({ mode: "quality" }),
      promptText: ambiguous,
      hasTools: false,
    });
    expect(quality.tier).toBe("premium");

    // cost mode (threshold 0.7): 0.5 < 0.7 -> cheap
    const cost = await resolveSmartRoute({
      ...base,
      router: makeRouter({ mode: "cost" }),
      promptText: ambiguous,
      hasTools: false,
    });
    expect(cost.tier).toBe("cheap");
  });
});
