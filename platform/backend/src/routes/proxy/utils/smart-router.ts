import { LLM_ROUTER_ID_HEADER } from "@archestra/shared";
import { trace } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";
import config from "@/config";
import logger from "@/logging";
import { LlmRouterModel, ModelModel } from "@/models";
import {
  ATTR_ARCHESTRA_ROUTER_BASELINE_MODEL,
  ATTR_ARCHESTRA_ROUTER_ID,
  ATTR_ARCHESTRA_ROUTER_REASON,
  ATTR_ARCHESTRA_ROUTER_SCORE,
  ATTR_ARCHESTRA_ROUTER_SOURCE,
  ATTR_ARCHESTRA_ROUTER_TIER,
} from "@/observability/tracing";
import {
  resolveSmartRoute,
  type SmartRouteDecision,
} from "@/services/smart-router";
import { isLoopbackAddress } from "@/utils/network";

/**
 * Applies the smart router when the loopback request carries an
 * LLM_ROUTER_ID_HEADER (set by in-app chat). Returns the chosen model + the
 * decision, or null when no eligible router applies. The caller swaps the
 * request model to `chosenModel`; the existing baseline-vs-actual cost path
 * then records the savings against the premium baseline.
 */
export async function applySmartRouting(params: {
  request: FastifyRequest;
  organizationId: string;
  agentId: string;
  userId?: string;
  sessionId?: string | null;
  providerMessages: unknown;
  hasTools: boolean;
}): Promise<{ chosenModel: string; decision: SmartRouteDecision } | null> {
  // Server-side kill switch: when the flag is off, no request routes, even if a
  // conversation still carries an llmRouterId.
  if (!config.llmProxy.smartRouterEnabled) {
    return null;
  }

  const headerValue =
    params.request.headers[LLM_ROUTER_ID_HEADER.toLowerCase()];
  const routerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (
    !isLoopbackAddress(params.request.ip) ||
    typeof routerId !== "string" ||
    routerId.length === 0
  ) {
    return null;
  }

  const router = await LlmRouterModel.findById(routerId);
  if (
    !router ||
    !router.enabled ||
    router.organizationId !== params.organizationId ||
    !router.cheapModelId ||
    !router.premiumModelId
  ) {
    return null;
  }

  const [cheap, premium] = await Promise.all([
    ModelModel.findById(router.cheapModelId),
    ModelModel.findById(router.premiumModelId),
  ]);
  if (!cheap || !premium) {
    return null;
  }

  const promptText = extractLatestUserText(params.providerMessages);
  const decision = await resolveSmartRoute({
    router,
    cheapModel: cheap.modelId,
    premiumModel: premium.modelId,
    promptText,
    hasTools: params.hasTools,
    cheapSupportsTools: cheap.supportsToolCalling,
    premiumSupportsTools: premium.supportsToolCalling,
    agentId: params.agentId,
    userId: params.userId,
    sessionId: params.sessionId ?? undefined,
  });

  const span = trace.getActiveSpan();
  span?.setAttributes({
    [ATTR_ARCHESTRA_ROUTER_ID]: router.id,
    [ATTR_ARCHESTRA_ROUTER_TIER]: decision.tier,
    [ATTR_ARCHESTRA_ROUTER_SOURCE]: decision.source,
    [ATTR_ARCHESTRA_ROUTER_SCORE]: decision.score,
    [ATTR_ARCHESTRA_ROUTER_REASON]: decision.reason,
    [ATTR_ARCHESTRA_ROUTER_BASELINE_MODEL]: decision.baselineModel,
  });

  logger.info(
    {
      routerId: router.id,
      tier: decision.tier,
      source: decision.source,
      score: decision.score,
      chosenModel: decision.chosenModel,
    },
    "Smart router decision",
  );

  return { chosenModel: decision.chosenModel, decision };
}

/** Best-effort extraction of the latest user turn's text across provider shapes. */
function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!message || typeof message !== "object" || message.role !== "user") {
      continue;
    }
    const { content } = message;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          const text = (part as { text?: unknown })?.text;
          return typeof text === "string" ? text : "";
        })
        .join(" ")
        .trim();
    }
  }
  return "";
}
