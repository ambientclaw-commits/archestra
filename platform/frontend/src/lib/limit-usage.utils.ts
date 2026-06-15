import type { archestraApiTypes } from "@archestra/shared";
import {
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  type LimitCleanupInterval,
} from "@/components/limit-cleanup-interval-select";

export type LimitData = archestraApiTypes.GetLimitsResponses["200"][number];
export type UsageStatus = "safe" | "warning" | "danger" | "exceeded";

export interface LimitUsage {
  percentage: number;
  status: UsageStatus;
  actualUsage: number;
  actualLimit: number;
  /** Human-readable label for the limit type */
  limitKindLabel: string;
  /** Number of models this limit applies to (0 = all models) */
  modelCount: number;
}

/**
 * Compute usage stats for a single limit record.
 * Currently the API returns modelUsage (cost) for token_cost limits.
 * For other limit types, usage will show as 0 until the API exposes it.
 */
export function computeLimitUsage(limit: LimitData): LimitUsage {
  const actualUsage = (limit.modelUsage ?? []).reduce(
    (sum, u) => sum + u.cost,
    0,
  );
  const actualLimit = limit.limitValue;
  const percentage = actualLimit > 0 ? (actualUsage / actualLimit) * 100 : 0;

  let status: UsageStatus;
  if (percentage >= 100) {
    status = "exceeded";
  } else if (percentage >= 90) {
    status = "danger";
  } else if (percentage >= 75) {
    status = "warning";
  } else {
    status = "safe";
  }

  const limitKindLabel =
    limit.limitType === "token_cost"
      ? "Token cost"
      : limit.limitType === "mcp_server_calls"
        ? "MCP server calls"
        : "Tool calls";

  const modelCount = Array.isArray(limit.model) ? limit.model.length : 0;

  return { percentage, status, actualUsage, actualLimit, limitKindLabel, modelCount };
}

/**
 * From a list of limits applicable to the current chat session, select the one
 * with the most consumed percentage (i.e. least remaining capacity).
 *
 * Hierarchy: user > agent > organization (higher priority shown first, but we
 * pick the most-consumed one across all that apply).
 */
export function selectMostConstrainedLimit(
  limits: LimitData[],
): LimitData | null {
  if (limits.length === 0) return null;
  return limits.reduce<LimitData>((worst, current) => {
    const worstPct = computeLimitUsage(worst).percentage;
    const currentPct = computeLimitUsage(current).percentage;
    return currentPct > worstPct ? current : worst;
  });
}

// ─── Reset-time helpers (shared with limits page) ───────────────────────────

function isCalendarCleanupInterval(
  interval: LimitCleanupInterval,
): interval is Extract<
  LimitCleanupInterval,
  | "calendar_day"
  | "calendar_week_sunday"
  | "calendar_week_monday"
  | "calendar_month"
> {
  return interval.startsWith("calendar_");
}

function getNextCalendarResetDate(
  date: Date,
  interval: Extract<
    LimitCleanupInterval,
    | "calendar_day"
    | "calendar_week_sunday"
    | "calendar_week_monday"
    | "calendar_month"
  >,
): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  switch (interval) {
    case "calendar_day":
      next.setDate(next.getDate() + 1);
      return next;
    case "calendar_week_sunday": {
      const days = (7 - next.getDay()) % 7 || 7;
      next.setDate(next.getDate() + days);
      return next;
    }
    case "calendar_week_monday": {
      const days = (8 - next.getDay()) % 7 || 7;
      next.setDate(next.getDate() + days);
      return next;
    }
    case "calendar_month":
      next.setMonth(next.getMonth() + 1, 1);
      return next;
  }
}

export function addCleanupInterval(date: Date, interval: LimitCleanupInterval): Date {
  const next = new Date(date);
  switch (interval) {
    case "1h":
      next.setHours(next.getHours() + 1);
      return next;
    case "12h":
      next.setHours(next.getHours() + 12);
      return next;
    case "24h":
      next.setDate(next.getDate() + 1);
      return next;
    case "1w":
      next.setDate(next.getDate() + 7);
      return next;
    case "1m":
      next.setMonth(next.getMonth() + 1);
      return next;
    case "calendar_day":
    case "calendar_week_sunday":
    case "calendar_week_monday":
    case "calendar_month":
      return getNextCalendarResetDate(next, interval);
  }
}

export function getNextResetDate(
  lastCleanup: LimitData["lastCleanup"],
  cleanupInterval: LimitCleanupInterval,
): Date | null {
  if (isCalendarCleanupInterval(cleanupInterval)) {
    return getNextCalendarResetDate(new Date(), cleanupInterval);
  }
  if (!lastCleanup) return null;
  const next = addCleanupInterval(new Date(lastCleanup), cleanupInterval);
  if (Number.isNaN(next.getTime())) return null;
  return next;
}

/**
 * Returns a human-readable "resets in X" string for a limit.
 */
export function formatResetsIn(
  lastCleanup: LimitData["lastCleanup"],
  cleanupInterval: LimitCleanupInterval,
): string {
  const next = getNextResetDate(lastCleanup, cleanupInterval);
  if (!next) return "Resets on next check";

  const now = Date.now();
  const msLeft = next.getTime() - now;
  if (msLeft <= 0) return "Resetting soon";

  const totalSeconds = Math.floor(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return "in <1m";
}

/**
 * Format the exact reset date/time.
 */
export function formatResetDate(date: Date): string {
  return `Resets ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  })}`;
}

export function formatNextLimitReset(
  lastCleanup: LimitData["lastCleanup"],
  cleanupInterval: LimitCleanupInterval,
): string {
  const next = getNextResetDate(lastCleanup, cleanupInterval);
  if (!next) return "Resets on next check";
  return formatResetDate(next);
}

export function getLimitCleanupInterval(
  limit: LimitData,
): LimitCleanupInterval {
  return (limit.cleanupInterval as LimitCleanupInterval | null | undefined) ?? DEFAULT_LIMIT_CLEANUP_INTERVAL;
}
