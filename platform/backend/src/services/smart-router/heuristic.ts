type DifficultyBand = "easy" | "ambiguous" | "hard";

interface HeuristicResult {
  band: DifficultyBand;
  /** Rough difficulty in 0..1; only used directly when band is not ambiguous. */
  score: number;
  reason: string;
}

const APPROX_CHARS_PER_TOKEN = 4;
const EASY_MAX_TOKENS = 200;
const HARD_MIN_TOKENS = 1500;

const HARD_KEYWORDS = [
  "code",
  "debug",
  "refactor",
  "algorithm",
  "prove",
  "analyze",
  "analyse",
  "architecture",
  "optimize",
  "optimise",
  "step by step",
  "derive",
  "stack trace",
  "regex",
  "sql",
  "calculate",
];

/**
 * Zero-cost first pass: decides the obvious easy/hard cases from prompt size,
 * tool presence, and task keywords. Returns "ambiguous" when the cheap LLM
 * classifier should make the call.
 */
export function classifyHeuristic(params: {
  promptText: string;
  hasTools: boolean;
}): HeuristicResult {
  const { promptText, hasTools } = params;
  const approxTokens = Math.ceil(promptText.length / APPROX_CHARS_PER_TOKEN);
  const lower = promptText.toLowerCase();
  const hardKeyword = HARD_KEYWORDS.find((keyword) => lower.includes(keyword));

  if (approxTokens >= HARD_MIN_TOKENS) {
    return {
      band: "hard",
      score: 0.85,
      reason: `long prompt (~${approxTokens} tokens)`,
    };
  }
  // A short, simple prompt is only "easy" when no tools are in play; an agentic
  // turn always gets a closer look (and a capability guard downstream).
  if (!hasTools && approxTokens <= EASY_MAX_TOKENS && !hardKeyword) {
    return {
      band: "easy",
      score: 0.15,
      reason: `short, simple prompt (~${approxTokens} tokens)`,
    };
  }
  return {
    band: "ambiguous",
    score: 0.5,
    reason: hasTools
      ? "uses tools — needs a closer look"
      : hardKeyword
        ? `mentions "${hardKeyword}" — needs a closer look`
        : `mid-size prompt (~${approxTokens} tokens) — needs a closer look`,
  };
}
