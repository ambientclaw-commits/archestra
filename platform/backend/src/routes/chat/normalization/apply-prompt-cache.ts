import type { ModelMessage } from "ai";

// Per-provider cache-breakpoint marker, written into a message's
// `providerOptions`. Anthropic and Amazon Bedrock both require explicit
// breakpoints and both cap at 4 per request; only the providerOptions key and
// value shape differ:
//   - Anthropic: `{ anthropic: { cacheControl: { type: "ephemeral" } } }`
//   - Bedrock:   `{ bedrock:   { cachePoint:   { type: "default"   } } }`
const CACHE_BREAKPOINTS = {
  anthropic: { key: "anthropic", field: "cacheControl", type: "ephemeral" },
  bedrock: { key: "bedrock", field: "cachePoint", type: "default" },
} as const;

type CacheBreakpointConfig =
  (typeof CACHE_BREAKPOINTS)[keyof typeof CACHE_BREAKPOINTS];

// Per AWS's prompt-caching docs the 1-hour cache TTL is supported only by
// Claude Opus 4.5, Sonnet 4.5, and Haiku 4.5. Every other model uses the
// 5-minute default — including Opus 4.6 (documented 5-minute-only), Opus 4
// ("claude-sonnet-4-20250514"), Claude 3.x, any newer model not yet listed,
// and non-Anthropic providers. Matches bare ids ("claude-sonnet-4-5") and
// Bedrock inference-profile ids ("us.anthropic.claude-sonnet-4-5-..."). `(?!\d)`
// requires "4-5" to be the whole minor version (followed by "-" or end of
// string), so a hypothetical "claude-opus-4-50" is not read as 4.5.
const ONE_HOUR_CACHE_MODEL = /claude-(?:sonnet|haiku|opus)-4-5(?!\d)/;

function supportsOneHourCache(model: string): boolean {
  return ONE_HOUR_CACHE_MODEL.test(model);
}

// Anthropic and Bedrock both reject a request with more than 4 cache
// breakpoints, and the AI SDK provider throws before the call. Breakpoints
// already present (e.g. `materializeAttachments` marks each Anthropic
// file/document part) count against this budget, so the markers added here
// must fit in what's left.
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Adds provider cache breakpoints so the chat request's stable prefix is
 * prompt-cached across turns. Without a breakpoint Anthropic and Bedrock cache
 * nothing, re-billing the full system prompt + tool definitions + history on
 * every turn.
 *
 * A breakpoint caches everything rendered before it — the prefix is
 * `tools → system → messages` — so placing the markers on messages also caches
 * the system prompt and tools. Up to two breakpoints are added:
 *   - last message: a rolling breakpoint that extends the cached prefix to the
 *     most recent turn (each turn writes the new tail; the next turn reads it);
 *   - first message: the stable prefix (tools + system + first turn) that never
 *     changes, so it stays a cache hit on every later turn.
 *
 * Last is prioritized over first when only one slot is left in the breakpoint
 * budget. Messages that already carry a breakpoint for this provider are left
 * alone — their prefix is already cacheable and re-marking would waste budget.
 *
 * On models that support it the breakpoints use a 1-hour TTL; both breakpoints
 * share the same TTL so there is no ordering constraint between them.
 *
 * No-op for providers other than Anthropic and Bedrock: OpenAI, Gemini,
 * DeepSeek, etc. cache prefixes automatically and reject or ignore explicit
 * markers.
 */
export function applyPromptCacheBreakpoints(params: {
  provider: string;
  /** Resolved model id; used to decide cache TTL. Absent → 5-minute default. */
  model?: string;
  messages: ModelMessage[];
}): ModelMessage[] {
  const { provider, model, messages } = params;
  const config = (CACHE_BREAKPOINTS as Record<string, CacheBreakpointConfig>)[
    provider
  ];
  if (!config || messages.length === 0) {
    return messages;
  }

  const existingBreakpoints = messages.reduce(
    (total, message) => total + breakpointCount(message, config),
    0,
  );
  let budget = MAX_CACHE_BREAKPOINTS - existingBreakpoints;
  if (budget <= 0) {
    return messages;
  }

  // Only opt into the 1h TTL when this request has no other breakpoints. Other
  // breakpoints (e.g. `materializeAttachments`' per-part markers) use the 5m
  // default, and Anthropic/Bedrock reject a longer TTL placed after a shorter
  // one — so mixing 1h here with those 5m markers can fail the request. Staying
  // uniformly 5m when any marker pre-exists keeps ordering valid.
  const useOneHour =
    !!model && supportsOneHourCache(model) && existingBreakpoints === 0;
  const markerValue = useOneHour
    ? { type: config.type, ttl: "1h" }
    : { type: config.type };

  const lastIndex = messages.length - 1;
  // Prefer the rolling (last) breakpoint, then the stable (first) one. A single
  // message collapses both candidates to index 0.
  const candidates = lastIndex === 0 ? [0] : [lastIndex, 0];

  const indicesToMark = new Set<number>();
  for (const index of candidates) {
    if (budget <= 0) break;
    // Already cacheable via its own marker — don't spend budget re-marking it.
    if (breakpointCount(messages[index], config) > 0) continue;
    indicesToMark.add(index);
    budget--;
  }

  if (indicesToMark.size === 0) {
    return messages;
  }

  return messages.map((message, index) =>
    indicesToMark.has(index)
      ? withCacheBreakpoint(message, config, markerValue)
      : message,
  );
}

// Counts cache breakpoints a message already contributes for this provider: one
// per content part that carries the marker, plus the message-level marker. May
// slightly over-count (a message-level marker only takes effect on the last
// part when that part has none), which is the safe direction — over-counting
// makes us add fewer breakpoints, never more than the cap allows.
function breakpointCount(
  message: ModelMessage,
  config: CacheBreakpointConfig,
): number {
  let count = hasCacheBreakpoint(message.providerOptions, config) ? 1 : 0;
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      // Not every content part type declares `providerOptions`; read it
      // structurally rather than narrowing the wide part union.
      const partProviderOptions = (part as { providerOptions?: unknown })
        .providerOptions;
      if (hasCacheBreakpoint(partProviderOptions, config)) {
        count++;
      }
    }
  }
  return count;
}

function hasCacheBreakpoint(
  providerOptions: unknown,
  config: CacheBreakpointConfig,
): boolean {
  const providerEntry = (
    providerOptions as Record<string, Record<string, unknown>> | undefined
  )?.[config.key];
  return Boolean(providerEntry?.[config.field]);
}

function withCacheBreakpoint(
  message: ModelMessage,
  config: CacheBreakpointConfig,
  markerValue: { type: string; ttl?: string },
): ModelMessage {
  const providerOptions = (message.providerOptions ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const providerEntry = providerOptions[config.key] ?? {};
  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      [config.key]: { ...providerEntry, [config.field]: markerValue },
    },
  } as ModelMessage;
}
