"use client";

import { Gauge } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  computeLimitUsage,
  formatResetsIn,
  getLimitCleanupInterval,
  selectMostConstrainedLimit,
  type LimitData,
} from "@/lib/limit-usage.utils";
import { useLimits } from "@/lib/limits.query";

interface LimitUsageCellProps {
  entityType: LimitData["entityType"];
  entityId: string;
}

/**
 * Table cell that shows remaining usage for the most-constrained limit
 * applicable to a given entity.
 *
 * - Shows a compact progress badge with remaining % 
 * - Tooltip shows used/limit, limit kind, resets-in
 * - If there are multiple limits, shows "View all" button opening a modal
 */
export function LimitUsageCell({ entityType, entityId }: LimitUsageCellProps) {
  const { data: limits = [] } = useLimits({ entityType, entityId });
  const [showAll, setShowAll] = useState(false);

  if (limits.length === 0) {
    return <span className="text-xs text-muted-foreground">–</span>;
  }

  const worst = selectMostConstrainedLimit(limits);
  if (!worst) return null;

  const usage = computeLimitUsage(worst);
  const interval = getLimitCleanupInterval(worst);
  const resetsIn = formatResetsIn(worst.lastCleanup, interval);

  const progressColor =
    usage.status === "exceeded" || usage.status === "danger"
      ? "[&>[data-slot=progress-indicator]]:bg-destructive bg-destructive/20"
      : usage.status === "warning"
        ? "[&>[data-slot=progress-indicator]]:bg-orange-500 bg-orange-100"
        : undefined;

  const badgeVariant =
    usage.status === "exceeded" || usage.status === "danger"
      ? ("destructive" as const)
      : usage.status === "warning"
        ? ("outline" as const)
        : ("secondary" as const);

  const remainingPct = Math.max(0, 100 - usage.percentage);

  const tooltipLines = [
    `Used: ${formatUsageValue(usage.actualUsage, worst.limitType)} / ${formatUsageValue(usage.actualLimit, worst.limitType)}`,
    `Type: ${usage.limitKindLabel}`,
    `Resets: ${resetsIn}`,
    ...(Array.isArray(worst.model) && worst.model.length > 0
      ? [`Models: ${worst.model.join(", ")}`]
      : ["Models: All"]),
  ].join("\n");

  return (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 cursor-help">
            <Progress
              value={Math.min(usage.percentage, 100)}
              className={`w-16 h-1.5 ${progressColor ?? ""}`}
            />
            <Badge
              variant={badgeVariant}
              className={
                badgeVariant === "outline" && usage.status === "warning"
                  ? "border-orange-500/50 text-orange-600 text-xs px-1.5"
                  : "text-xs px-1.5"
              }
            >
              {remainingPct.toFixed(0)}% left
            </Badge>
          </div>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line max-w-xs" side="top">
          {tooltipLines}
        </TooltipContent>
      </Tooltip>

      {limits.length > 1 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-5 text-xs px-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll(true)}
        >
          View all
        </Button>
      )}

      {showAll && (
        <LimitUsageAllDialog
          limits={limits}
          open={showAll}
          onOpenChange={setShowAll}
        />
      )}
    </div>
  );
}

// ─── "View all" modal ────────────────────────────────────────────────────────

interface LimitUsageAllDialogProps {
  limits: LimitData[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function LimitUsageAllDialog({
  limits,
  open,
  onOpenChange,
}: LimitUsageAllDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            All Usage Limits
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          {limits.map((limit) => {
            const usage = computeLimitUsage(limit);
            const interval = getLimitCleanupInterval(limit);
            const resetsIn = formatResetsIn(limit.lastCleanup, interval);
            const progressColor =
              usage.status === "exceeded" || usage.status === "danger"
                ? "[&>[data-slot=progress-indicator]]:bg-destructive bg-destructive/20"
                : usage.status === "warning"
                  ? "[&>[data-slot=progress-indicator]]:bg-orange-500 bg-orange-100"
                  : undefined;

            const models =
              Array.isArray(limit.model) && limit.model.length > 0
                ? limit.model.join(", ")
                : "All models";

            return (
              <div
                key={limit.id}
                className="rounded-md border p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{usage.limitKindLabel}</span>
                  <span className="text-muted-foreground text-xs">{resetsIn}</span>
                </div>
                <Progress
                  value={Math.min(usage.percentage, 100)}
                  className={progressColor}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {formatUsageValue(usage.actualUsage, limit.limitType)} /{" "}
                    {formatUsageValue(usage.actualLimit, limit.limitType)} (
                    {usage.percentage.toFixed(1)}%)
                  </span>
                  <span className="truncate max-w-[140px]" title={models}>
                    {models}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
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
