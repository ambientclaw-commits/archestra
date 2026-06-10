import { generateObject } from "ai";
import { z } from "zod";
import { createLLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import { resolveConfiguredAgentLlm } from "@/utils/llm-resolution";

// No min/max/maxLength constraints: Anthropic's structured-output schema
// rejects JSON-schema `minimum`/`maximum` on numbers. The score is clamped and
// the reason truncated in code instead.
const DifficultySchema = z.object({
  score: z.number(),
  reason: z.string(),
});

const CLASSIFIER_SYSTEM =
  "You are a routing classifier for an LLM gateway. Rate how much the user's " +
  "latest request needs a top-tier, expensive model versus a small fast one. " +
  "Return a difficulty score from 0 (a small model handles it perfectly: " +
  "greetings, simple facts, formatting, short rewrites) to 1 (needs the " +
  "strongest model: multi-step reasoning, hard coding, careful analysis). " +
  "Give a terse reason of a few words.";

const MAX_CLASSIFIER_PROMPT_CHARS = 4000;

/**
 * Mid-band tiebreaker: asks the router's cheap model itself to score the
 * request's difficulty. The call runs through the LLM proxy with its own
 * source, so its cost is captured and nets against the routing savings.
 * Returns null on any failure so the caller falls back to the heuristic score.
 */
export async function classifyWithCheapModel(params: {
  cheapModelId: string;
  cheapApiKeyId: string | null;
  promptText: string;
  agentId: string;
  userId?: string;
  sessionId?: string;
}): Promise<{ score: number; reason: string } | null> {
  const resolved = await resolveConfiguredAgentLlm({
    llmApiKeyId: params.cheapApiKeyId,
    modelId: params.cheapModelId,
  });
  if (!resolved) {
    return null;
  }

  const model = createLLMModel({
    provider: resolved.provider,
    apiKey: resolved.apiKey,
    modelName: resolved.modelName,
    baseUrl: resolved.baseUrl,
    agentId: params.agentId,
    userId: params.userId,
    sessionId: params.sessionId,
    source: "chat:smart_router_classifier",
  });

  try {
    const { object } = await generateObject({
      model,
      schema: DifficultySchema,
      system: CLASSIFIER_SYSTEM,
      prompt: params.promptText.slice(0, MAX_CLASSIFIER_PROMPT_CHARS),
      temperature: 0,
      // Tiny cap: the classifier emits only {score, reason}. Without it the SDK
      // defaults to a huge max_tokens, which Anthropic rejects on non-streaming
      // requests ("Streaming is required for operations that may take >10 min").
      maxOutputTokens: 256,
    });
    return {
      score: Math.max(0, Math.min(1, object.score)),
      reason: object.reason.slice(0, 200),
    };
  } catch (error) {
    logger.warn(
      { error: String(error) },
      "smart-router classifier call failed; falling back to heuristic score",
    );
    return null;
  }
}
