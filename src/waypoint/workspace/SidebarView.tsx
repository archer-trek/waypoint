import type { ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Pin, Plus, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatTopicListTime, type TopicSummary } from "../topics";
import { EmptyInvitation } from "./EmptyDetailView";

export type SidebarViewProps = {
  pageEnterClass: string;
  reauthRequired: boolean;
  showDetail: boolean;
  reauthBanner: ReactNode;
  topics: TopicSummary[];
  activeTopicId?: string;
  nowMs: number;
  isNarrow: boolean;
  showTrafficLightClearance?: boolean;
  onOpenSettings: () => void;
  onOpenCreateForm: () => void;
  onOpenTopic: (roomId: string) => void;
};

type TopicRowProps = {
  topic: TopicSummary;
  isActive: boolean;
  isNarrow: boolean;
  nowMs: number;
  onOpenTopic: (roomId: string) => void;
};

function needsMacTrafficLightClearance(): boolean {
  if (!isTauri() || typeof navigator === "undefined") {
    return false;
  }
  return /mac/i.test(navigator.platform || navigator.userAgent);
}

/** Single Topic item row aligned to the brand axis, with margin-inset unread dot and latest message preview. */
function TopicRow({
  topic,
  isActive,
  isNarrow,
  nowMs,
  onOpenTopic,
}: TopicRowProps) {
  const showSecondary = Boolean(topic.lastMessagePreview) || topic.responding;
  return (
    <li>
      <button
        type="button"
        aria-label={topic.name}
        className={cn(
          "waypoint-topic-row relative flex w-full min-h-13.5 cursor-pointer select-none flex-col justify-center gap-0.5 rounded-lg text-left transition-colors active:scale-[0.99] touch-manipulation",
          isNarrow ? "py-3 pl-4 pr-4" : "py-2.5 pl-4 pr-3.5",
          isActive
            ? "active bg-accent text-accent-foreground"
            : "bg-transparent hover:bg-accent/45 active:bg-accent/70",
          topic.unavailable && "unavailable opacity-60",
        )}
        data-active={isActive ? "true" : undefined}
        data-unread={topic.unread ? "true" : undefined}
        data-pinned={topic.pinned ? "true" : undefined}
        data-unavailable={topic.unavailable ? "true" : undefined}
        onClick={() => onOpenTopic(topic.roomId)}
      >
        <span className="waypoint-topic-row-header relative flex min-w-0 items-baseline justify-between gap-3">
          {topic.unread ? (
            <span
              aria-hidden="true"
              className={cn(
                "waypoint-unread-dot pointer-events-none absolute top-1/2 size-[6px] -translate-y-1/2 rounded-full bg-foreground",
                isNarrow ? "-left-[11px]" : "-left-[10px]",
              )}
            />
          ) : null}
          <span className="waypoint-topic-row-title flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                "waypoint-topic-name min-w-0 truncate leading-[1.35] text-foreground [-webkit-font-smoothing:auto]",
                isNarrow ? "text-[17px]" : "text-[15px]",
                topic.unread && "unread",
              )}
              style={{ fontWeight: topic.unread ? 700 : 500 }}
            >
              {topic.name}
            </span>
            {topic.unavailable ? (
              <Badge
                variant="outline"
                className="waypoint-topic-row-unavailable shrink-0 rounded border-warning-border bg-warning px-1.5 py-0 text-[11px] font-medium text-warning-foreground"
              >
                不可用
              </Badge>
            ) : null}
          </span>
          <span className="waypoint-topic-row-trailing inline-flex shrink-0 items-center gap-1.5">
            {topic.pinned ? (
              <Badge
                variant="secondary"
                aria-label="已置顶"
                className="waypoint-topic-row-pin shrink-0 gap-0.5 rounded border border-border bg-secondary px-1.5 py-0 text-[11px] font-medium text-muted-foreground"
              >
                <Pin aria-hidden="true" className="size-2.5" />
                置顶
              </Badge>
            ) : null}
            {topic.sendStatus === "failed" ? (
              <span
                role="img"
                aria-label="失败"
                className="waypoint-topic-row-failed inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive text-xs font-bold leading-none text-destructive-foreground"
              >
                !
              </span>
            ) : topic.sendStatus === "unconfirmed" ? (
              <span
                role="img"
                aria-label="未确认"
                className="waypoint-unconfirmed-spinner inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
              />
            ) : null}
            {topic.lastActivityTs !== undefined ? (
              <span
                className={cn(
                  "waypoint-topic-row-time whitespace-nowrap font-sans tabular-nums text-muted-foreground",
                  isNarrow ? "text-[12.5px]" : "text-[12px]",
                )}
              >
                {formatTopicListTime(topic.lastActivityTs, nowMs)}
              </span>
            ) : null}
          </span>
        </span>

        {showSecondary ? (
          <span className="waypoint-topic-row-secondary flex min-w-0 items-center justify-between gap-2">
            {topic.lastMessagePreview ? (
              <span
                className={cn(
                  "waypoint-topic-row-preview min-w-0 flex-1 truncate font-normal text-muted-foreground",
                  isNarrow ? "text-[14px] leading-snug" : "text-[13px] leading-snug",
                )}
              >
                {topic.lastMessagePreview}
              </span>
            ) : null}
            {topic.responding ? (
              <span
                className={cn(
                  "waypoint-topic-row-responding ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium text-foreground",
                  isNarrow ? "text-[12.5px]" : "text-[12px]",
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-foreground animate-pulse motion-reduce:animate-none"
                />
                <span>正在回应</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** Topic list sidebar with aligned header, settings/create triggers, and pinned scroll region. */
export function SidebarView({
  pageEnterClass,
  reauthRequired,
  showDetail,
  reauthBanner,
  topics,
  activeTopicId,
  nowMs,
  isNarrow,
  showTrafficLightClearance,
  onOpenSettings,
  onOpenCreateForm,
  onOpenTopic,
}: SidebarViewProps) {
  const trafficLightHeader =
    !isNarrow && (showTrafficLightClearance ?? needsMacTrafficLightClearance());

  const iconButtonClass = cn(
    "rounded-full text-muted-foreground hover:text-foreground transition-all active:scale-95 touch-manipulation",
    isNarrow ? "size-11 min-h-11 min-w-11" : "size-9 min-h-9 min-w-9",
  );

  const settingsButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={iconButtonClass}
      aria-label="设置"
      onClick={onOpenSettings}
    >
      <Settings
        aria-hidden="true"
        strokeWidth={1.85}
        className={isNarrow ? "size-5" : "size-[18px]"}
      />
      <span className="sr-only">设置</span>
    </Button>
  );

  const createButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(iconButtonClass, "waypoint-create-topic-btn")}
      disabled={reauthRequired}
      aria-label="新建 Topic"
      onClick={onOpenCreateForm}
    >
      <Plus
        aria-hidden="true"
        strokeWidth={1.85}
        className={isNarrow ? "size-[22px]" : "size-5"}
      />
      <span className="sr-only">新建 Topic</span>
    </Button>
  );

  return (
    <aside
      className={cn(
        "waypoint-sidebar flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground box-border select-none",
        isNarrow
          ? "w-full flex-1 border-r-0"
          : "w-[clamp(16rem,28%,22rem)] flex-[0_0_clamp(16rem,28%,22rem)] border-r border-border",
        pageEnterClass,
      )}
      aria-label="Topic 列表"
    >
      <p className="sr-only">已连接</p>
      <div
        className={cn(
          "waypoint-sidebar-header flex shrink-0 items-center gap-2 border-b border-border/60 touch-none",
          isNarrow
            ? "min-h-13 justify-between pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-2 pl-[max(20px,env(safe-area-inset-left,0px))] pr-[max(8px,env(safe-area-inset-right,0px))]"
            : trafficLightHeader
              ? "justify-end pt-[calc(0.65rem+env(safe-area-inset-top,0px))] pb-2.5 pl-[76px] pr-3"
              : "justify-between pt-[calc(0.65rem+env(safe-area-inset-top,0px))] pb-2.5 pl-6 pr-3",
        )}
        data-tauri-drag-region
      >
        <h1 className="sr-only">Topic</h1>
        {!trafficLightHeader ? (
          <div className="waypoint-sidebar-brand flex min-w-0 items-center text-foreground">
            <span
              className={cn(
                "font-semibold leading-normal tracking-tight",
                isNarrow ? "text-[20px]" : "text-[18px]",
              )}
            >
              Waypoint
            </span>
          </div>
        ) : null}
        <div className="waypoint-sidebar-actions flex shrink-0 items-center gap-0.5">
          {settingsButton}
          {createButton}
        </div>
      </div>

      <div
        className={cn(
          "waypoint-sidebar-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain",
          isNarrow
            ? "pb-[max(0.875rem,env(safe-area-inset-bottom,0px))]"
            : "pb-3",
        )}
      >
        {reauthRequired && !showDetail ? (
          <div
            className={cn(
              isNarrow
                ? "pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))]"
                : "px-3",
            )}
          >
            {reauthBanner}
          </div>
        ) : null}

        {topics.length === 0 ? (
          isNarrow ? (
            <div className="waypoint-list-empty flex min-h-0 flex-1 flex-col pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))]">
              <p className="sr-only">暂无 Topic</p>
              <EmptyInvitation
                topicsCount={topics.length}
                reauthRequired={reauthRequired}
                shortcut={false}
                onOpenCreateForm={onOpenCreateForm}
              />
            </div>
          ) : (
            <p className="sr-only">暂无 Topic</p>
          )
        ) : (
          <ul
            className={cn(
              "waypoint-topic-list m-0 flex list-none flex-col gap-0.5 p-0",
              isNarrow
                ? "mt-1.5 pl-[max(4px,env(safe-area-inset-left,0px))] pr-[max(4px,env(safe-area-inset-right,0px))]"
                : "mt-2 px-2",
            )}
          >
            {topics.map((topic) => (
              <TopicRow
                key={topic.roomId}
                topic={topic}
                isActive={topic.roomId === activeTopicId}
                isNarrow={isNarrow}
                nowMs={nowMs}
                onOpenTopic={onOpenTopic}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
