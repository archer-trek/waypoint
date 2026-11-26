import { cn } from "@/lib/utils";

export type RespondingIndicatorProps = {
  size: "timeline" | "row";
  role?: "status";
  "aria-label"?: string;
  className?: string;
};

/** Textless monochrome three-dot breathing indicator for Topic-level responding state (ADR-0034). */
export function RespondingIndicator({
  size,
  role,
  "aria-label": ariaLabel = "正在回应",
  className,
}: RespondingIndicatorProps) {
  const dotClass = cn(
    "waypoint-responding-dot rounded-full bg-muted-foreground",
    size === "timeline" ? "size-[6px]" : "size-[4px]",
  );

  return (
    <span
      role={role}
      aria-label={ariaLabel}
      className={cn(
        "waypoint-responding-indicator inline-flex items-center",
        size === "timeline" ? "gap-[5px]" : "min-h-[18px] gap-[3px]",
        className,
      )}
    >
      <span aria-hidden="true" className={dotClass} />
      <span aria-hidden="true" className={dotClass} />
      <span aria-hidden="true" className={dotClass} />
    </span>
  );
}
