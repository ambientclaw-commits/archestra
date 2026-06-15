"use client";

import { Gauge } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type LimitData,
  computeLimitUsage,
  formatResetsIn,
  getLimitCleanupInterval,
  selectMostConstrainedLimit,
} from "@/lib/limit-usage.utils";
import { useLimits } from "@/lib/limits.query";

interface ChatUsageLimitBarProps {
  /** Active agent ID (to include agent-specific limits) */
  agentId?: string | null;
  /**
   * The current user's member record ID (NOT user ID) for user-scoped limits.
   * Pass `member.id` from the org members list where `member.userId === session.user.id`.
   * Optional – only org and agent limits are shown if not provided.
   */
  memberId?: string | null;
}

const TOAST_DEBOUNCE_MS = 60_000; // Don't re-toast the same threshold within 1 minute

type ToastThreshold = "warning" | "danger" | "exceeded";

export function ChatUsageLimitBar({
  agentId,
  memberId,
}: ChatUsageLimitBarProps) {
  const { data: allLimits = [] } = useLimits();

  // Filter limits relevant to this chat session context:
  // organization-wide limits + agent limits + user limits
  const relevantLimits: LimitData[] = useMemo(() => {
    return allLimits.filter((limit) => {
      if (limit.entityType === "organization") return true;
      if (limit.entityType === "agent" && agentId && limit.entityId === agentId)
        return true;
      if (limit.entityType === "user" && memberId && limit.entityId === memberId)
        return true;
      return false;
    });
  }, [allLimits, agentId, memberId]);

  const worstLimit = selectMostConstrainedLimit(relevantLimits);

  // Toast tracking: avoid re-showing the same threshold toast repeatedly
  const lastToastedThreshold = useRef<Record<string, { threshold: ToastThreshold; ts: number }>>({});

  const worstUsage = worstLimit ? computeLimitUsage(worstLimit) : null;
  const worstStatus = worstUsage?.status ?? null;

  useEffect(() => {
    if (!worstLimit || !worstUsage) return;
    const key = worstLimit.id;
    const now = Date.now();
    const prev = lastToastedThreshold.current[key];

    let threshold: ToastThreshold | null = null;
    if (worstUsage.percentage >= 100) threshold = "exceeded";
    else if (worstUsage.percentage >= 90) threshold = "danger";
    else if (worstUsage.percentage >= 75) threshold = "warning";

    if (!threshold) return;

    // Only toast if we haven't shown this threshold recently
    if (prev?.ts && now - prev.ts < TOAST_DEBOUNCE_MS && prev.threshold === threshold)
      return;

    const interval = getLimitCleanupInterval(worstLimit);
    const resetsIn = formatResetsIn(worstLimit.lastCleanup, interval);
    const pct = Math.round(worstUsage.percentage);

    if (threshold === "exceeded") {
      toast.error(`Usage limit reached (${pct}%)`, {
        description: `${worstUsage.limitKindLabel} limit exceeded. Resets ${resetsIn}.`,
        duration: 8000,
      });
    } else if (threshold === "danger") {
      toast.warning(`Approaching usage limit (${pct}%)`, {
        description: `${worstUsage.limitKindLabel} limit is at ${pct}%. Resets ${resetsIn}.`,
        duration: 6000,
      });
    } else {
      toast(`Usage at ${pct}%`, {
        description: `${worstUsage.limitKindLabel} limit is at ${pct}%. Resets ${resetsIn}.`,
        duration: 5000,
        icon: <Gauge className="h-4 w-4 text-yellow-500" />,
      });
    }

    lastToastedThreshold.current[key] = { threshold, ts: now };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worstLimit?.id, worstStatus]);

  if (!worstLimit || !worstUsage) return null;

  const interval = getLimitCleanupInterval(worstLimit);
  const resetsIn = formatResetsIn(worstLimit.lastCleanup, interval);

  const progressColor =
    worstUsage.status === "exceeded" || worstUsage.status === "danger"
      ? "[&>[data-slot=progress-indicator]]:bg-destructive bg-destructive/20"
      : worstUsage.status === "warning"
        ? "[&>[data-slot=progress-indicator]]:bg-orange-500 bg-orange-100"
        : undefined;

  const tooltipContent = [
    `Used: ${formatUsageValue(worstUsage.actualUsage, worstLimit.limitType)} / ${formatUsageValue(worstUsage.actualLimit, worstLimit.limitType)}`,
    `Type: ${worstUsage.limitKindLabel}`,
    `Resets: ${resetsIn}`,
    ...(worstUsage.modelCount > 0
      ? [`Models: ${(worstLimit.model ?? []).join(", ")}`]
      : ["Models: All"]),
  ].join("\n");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 min-w-[120px] max-w-[200px] cursor-help">
          <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex-1">
            <Progress
              value={Math.min(worstUsage.percentage, 100)}
              className={progressColor}
            />
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {Math.round(worstUsage.percentage)}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line max-w-xs" side="top">
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  );
}

function formatUsageValue(
  value: number,
  limitType: LimitData["limitType"],
): string {
  if (limitType === "token_cost") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }
  return value.toLocaleString("en-US");
}
