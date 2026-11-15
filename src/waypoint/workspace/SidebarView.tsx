import type { ReactNode } from "react";
import { Bot, Pin, Plus, Settings } from "lucide-react";
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
  registeredAgentsCount: number;
  nowMs: number;
  isNarrow: boolean;
  onOpenSettings: () => void;
  onOpenCreateForm: () => void;
  onOpenTopic: (roomId: string) => void;
};

type TopicRowProps = {
  topic: TopicSummary;
  isActive: boolean;
  showBotBadge: boolean;
  isNarrow: boolean;
  nowMs: number;
  onOpenTopic: (roomId: string) => void;
};

/** Single Topic item row aligned to the brand axis, with margin-inset unread dot and Bot icon subtitle. */
function TopicRow({
  topic,
  isActive,
  showBotBadge,
  isNarrow,
  nowMs,
  onOpenTopic,
}: TopicRowProps) {
  const showSecondary = showBotBadge || topic.responding;
  return (
    <li>
      <button
        type="button"
        aria-label={topic.name}
        className={cn(
          "waypoint-topic-row relative flex w-full min-h-14 cursor-pointer select-none flex-col justify-center gap-0.5 rounded-lg text-left transition-colors active:scale-[0.99] touch-manipulation",
          isNarrow ? "py-3 pl-4 pr-4" : "py-2.5 pl-5 pr-2.5",
          isActive
            ? "active bg-accent text-accent-foreground"
            : "bg-transparent hover:bg-accent/60 active:bg-accent/80",
          topic.unavailable && "unavailable opacity-60",
        )}
        data-active={isActive ? "true" : undefined}
        data-unread={topic.unread ? "true" : undefined}
        data-pinned={topic.pinned ? "true" : undefined}
        data-unavailable={topic.unavailable ? "true" : undefined}
        onClick={() => onOpenTopic(topic.roomId)}
      >
        {topic.unread ? (
          <span
            aria-hidden="true"
            className={cn(
              "waypoint-unread-dot pointer-events-none absolute size-[6px] rounded-full bg-foreground",
              isNarrow ? "left-[5px] top-[20px]" : "left-[7px] top-[17px]",
            )}
          />
        ) : null}

        <span className="waypoint-topic-row-header flex min-w-0 items-baseline justify-between gap-3">
          <span className="waypoint-topic-row-title flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                "waypoint-topic-name min-w-0 truncate leading-[1.35] text-foreground [-webkit-font-smoothing:auto]",
                isNarrow ? "text-[17px]" : "text-[0.9375rem]",
                topic.unread && "unread",
              )}
              style={{ fontWeight: topic.unread ? 700 : 500 }}
            >
              {topic.name}
            </span>
            {topic.unavailable ? (
              <Badge
                variant="outline"
                className="waypoint-topic-row-unavailable shrink-0 rounded border-warning-border bg-warning px-1.5 py-0 text-[0.6875rem] font-medium text-warning-foreground"
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
                className="waypoint-topic-row-pin shrink-0 gap-0.5 rounded border border-border bg-secondary px-1.5 py-0 text-[0.6875rem] font-medium text-muted-foreground"
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
                  isNarrow ? "text-[12.5px]" : "text-xs",
                )}
              >
                {formatTopicListTime(topic.lastActivityTs, nowMs)}
              </span>
            ) : null}
          </span>
        </span>

        {showSecondary ? (
          <span className="waypoint-topic-row-secondary flex min-w-0 items-center justify-between gap-2">
            {showBotBadge ? (
              <span
                className={cn(
                  "waypoint-topic-row-bot inline-flex min-w-0 max-w-full items-center gap-1 font-normal leading-snug text-muted-foreground",
                  isNarrow ? "text-[13.5px]" : "text-[0.8125rem]",
                )}
              >
                <Bot aria-hidden="true" strokeWidth={1.85} className="size-3 shrink-0" />
                <span className="truncate">{topic.botDisplayName}</span>
              </span>
            ) : null}
            {topic.responding ? (
              <span
                className={cn(
                  "waypoint-topic-row-responding ml-auto shrink-0 whitespace-nowrap font-medium text-foreground",
                  isNarrow ? "text-[12.5px]" : "text-xs",
                )}
              >
                正在回应
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** Topic list sidebar with native drag header, settings/create triggers, and empty state. */
export function SidebarView({
  pageEnterClass,
  reauthRequired,
  showDetail,
  reauthBanner,
  topics,
  activeTopicId,
  registeredAgentsCount,
  nowMs,
  isNarrow,
  onOpenSettings,
  onOpenCreateForm,
  onOpenTopic,
}: SidebarViewProps) {
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
        "waypoint-sidebar flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground box-border select-none",
        isNarrow
          ? "w-full flex-1 border-r-0 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-[max(0.875rem,env(safe-area-inset-bottom,0px))]"
          : "w-[clamp(16rem,28%,22rem)] flex-[0_0_clamp(16rem,28%,22rem)] border-r border-border pb-3 pt-[max(0.5rem,env(safe-area-inset-top,0px))]",
        pageEnterClass,
      )}
      aria-label="Topic 列表"
    >
      <p className="sr-only">已连接</p>
      <div
        className={cn(
          "waypoint-sidebar-header flex min-h-11 items-center justify-between gap-2 border-b border-border/60",
          isNarrow
            ? "pb-2 pt-0.5 pl-[max(20px,env(safe-area-inset-left,0px))] pr-[max(8px,env(safe-area-inset-right,0px))]"
            : "pb-2.5 pl-[76px] pr-3 pt-1",
        )}
        data-tauri-drag-region
      >
        <h1 className="sr-only">Topic</h1>
        {isNarrow ? (
          <>
            <div className="waypoint-sidebar-brand flex min-w-0 items-center text-foreground">
              <span className="text-[20px] font-semibold leading-normal tracking-tight">
                Waypoint
              </span>
            </div>
            <div className="waypoint-sidebar-actions flex shrink-0 items-center">
              {settingsButton}
              {createButton}
            </div>
          </>
        ) : (
          <>
            <div className="waypoint-sidebar-header-left flex items-center">
              {settingsButton}
            </div>
            <div className="waypoint-sidebar-header-right flex items-center">
              {createButton}
            </div>
          </>
        )}
      </div>

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
              showBotBadge={registeredAgentsCount > 1 && Boolean(topic.botDisplayName)}
              isNarrow={isNarrow}
              nowMs={nowMs}
              onOpenTopic={onOpenTopic}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
