import type { ReactNode } from "react";
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
  nowMs: number;
  onOpenTopic: (roomId: string) => void;
};

/** Single Topic item row with Grokbot monochrome status indicators. */
function TopicRow({
  topic,
  isActive,
  showBotBadge,
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
          "waypoint-topic-row w-full min-h-14 cursor-pointer select-none rounded-lg px-2.5 py-2.5 text-left transition-colors active:scale-[0.99] touch-manipulation",
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
        <span className="waypoint-topic-row-header flex items-center justify-between gap-2.5">
          <span
            className="waypoint-topic-bot-avatar inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-sm font-semibold text-secondary-foreground"
            aria-hidden="true"
          >
            {(topic.botDisplayName || topic.name || "T")
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <span className="waypoint-topic-row-title flex min-w-0 flex-1 items-center gap-1.5">
            {topic.unread ? (
              <span
                className="waypoint-unread-dot size-2 shrink-0 rounded-full bg-foreground"
                aria-hidden="true"
              />
            ) : null}
            <span
              className={cn(
                "waypoint-topic-name min-w-0 truncate text-[0.9375rem] leading-snug text-foreground",
                topic.unread && "unread",
              )}
              style={{ fontWeight: topic.unread ? 700 : 400 }}
            >
              {topic.name}
            </span>
            {topic.unavailable ? (
              <Badge
                variant="outline"
                className="waypoint-topic-row-unavailable shrink-0 rounded-sm border-warning-border bg-warning px-1.5 py-0 text-[0.6875rem] font-medium text-warning-foreground"
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
                className="waypoint-topic-row-pin shrink-0 gap-0.5 rounded-sm border border-border bg-secondary px-1.5 py-0 text-[0.6875rem] font-medium text-muted-foreground"
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
              <span className="waypoint-topic-row-time whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                {formatTopicListTime(topic.lastActivityTs, nowMs)}
              </span>
            ) : null}
          </span>
        </span>
        {showSecondary ? (
          <span className="waypoint-topic-row-secondary mt-1 flex min-w-0 items-center justify-between gap-2 pl-[2.875rem]">
            {showBotBadge ? (
              <Badge
                variant="secondary"
                className="waypoint-topic-row-bot min-w-0 max-w-full truncate rounded-full px-2 py-0 text-xs font-medium text-muted-foreground"
              >
                {topic.botDisplayName}
              </Badge>
            ) : null}
            {topic.responding ? (
              <span className="waypoint-topic-row-responding ml-auto shrink-0 whitespace-nowrap text-xs font-medium text-foreground">
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
    "rounded-full transition-all active:scale-95 touch-manipulation",
    isNarrow ? "size-11 min-h-11 min-w-11" : "size-9 min-h-9 min-w-9",
  );

  return (
    <aside
      className={cn(
        "waypoint-sidebar flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground box-border select-none",
        isNarrow
          ? "w-full flex-1 border-r-0 pt-[max(0.875rem,env(safe-area-inset-top,0px))] pb-[max(0.875rem,env(safe-area-inset-bottom,0px))] pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))]"
          : "w-[clamp(16rem,28%,22rem)] flex-[0_0_clamp(16rem,28%,22rem)] border-r border-border px-3 pb-3 pt-[max(0.5rem,env(safe-area-inset-top,0px))]",
        pageEnterClass,
      )}
      aria-label="Topic 列表"
    >
      <p className="sr-only">已连接</p>
      <div
        className={cn(
          "waypoint-sidebar-header flex min-h-11 items-center justify-between gap-2 border-b border-border/60 pb-2.5",
          isNarrow ? "px-1 pt-1" : "pl-[76px] pr-1 pt-1",
        )}
        data-tauri-drag-region
      >
        <h1 className="sr-only">Topic</h1>
        <div className="waypoint-sidebar-header-left flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(iconButtonClass, "text-muted-foreground hover:text-foreground")}
            aria-label="设置"
            onClick={onOpenSettings}
          >
            <Settings aria-hidden="true" className="size-[18px]" />
            <span className="sr-only">设置</span>
          </Button>
        </div>
        <div className="waypoint-sidebar-header-right flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              iconButtonClass,
              "waypoint-create-topic-btn text-foreground hover:bg-accent hover:text-accent-foreground",
            )}
            disabled={reauthRequired}
            aria-label="新建 Topic"
            onClick={onOpenCreateForm}
          >
            <Plus aria-hidden="true" className="size-[18px]" />
            <span className="sr-only">新建 Topic</span>
          </Button>
        </div>
      </div>
      {reauthRequired && !showDetail ? reauthBanner : null}
      {topics.length === 0 ? (
        isNarrow ? (
          <div className="waypoint-list-empty flex min-h-0 flex-1 flex-col">
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
        <ul className="waypoint-topic-list m-0 mt-2 flex list-none flex-col gap-0.5 p-0">
          {topics.map((topic) => (
            <TopicRow
              key={topic.roomId}
              topic={topic}
              isActive={topic.roomId === activeTopicId}
              showBotBadge={registeredAgentsCount > 1 && Boolean(topic.botDisplayName)}
              nowMs={nowMs}
              onOpenTopic={onOpenTopic}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
