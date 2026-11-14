import type { ReactNode } from "react";
import { PinIcon, PlusIcon, SettingsIcon } from "../icons";
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

/** Topic list sidebar with settings/create actions and empty state. */
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
  return (
    <aside
      className={`waypoint-sidebar${pageEnterClass ? ` ${pageEnterClass}` : ""}`}
      aria-label="Topic 列表"
    >
      <p className="sr-only">已连接</p>
      <div className="waypoint-sidebar-header" data-tauri-drag-region>
        <h1 className="sr-only">Topic</h1>
        <div className="waypoint-sidebar-header-left">
          <button
            type="button"
            className="waypoint-sidebar-icon-btn"
            aria-label="设置"
            onClick={onOpenSettings}
          >
            <SettingsIcon aria-hidden="true" size={18} />
            <span className="sr-only">设置</span>
          </button>
        </div>
        <div className="waypoint-sidebar-header-right">
          <button
            type="button"
            className="waypoint-sidebar-icon-btn waypoint-create-topic-btn"
            disabled={reauthRequired}
            aria-label="新建 Topic"
            onClick={onOpenCreateForm}
          >
            <PlusIcon aria-hidden="true" size={18} />
            <span className="sr-only">新建 Topic</span>
          </button>
        </div>
      </div>
      {reauthRequired && !showDetail ? reauthBanner : null}
      {topics.length === 0 ? (
        isNarrow ? (
          <div className="waypoint-list-empty">
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
        <ul className="waypoint-topic-list">
          {topics.map((topic) => (
            <li key={topic.roomId}>
              <button
                type="button"
                aria-label={topic.name}
                className={[
                  "waypoint-topic-row",
                  topic.roomId === activeTopicId ? "active" : "",
                  topic.unavailable ? "unavailable" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-unread={topic.unread ? "true" : undefined}
                data-pinned={topic.pinned ? "true" : undefined}
                data-unavailable={topic.unavailable ? "true" : undefined}
                onClick={() => onOpenTopic(topic.roomId)}
              >
                <span className="waypoint-topic-row-header">
                  <span className="waypoint-topic-bot-avatar" aria-hidden="true">
                    {(topic.botDisplayName || topic.name || "T")
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                  <span className="waypoint-topic-row-title">
                    {topic.unread ? (
                      <span className="waypoint-unread-dot" aria-hidden="true" />
                    ) : null}
                    <span
                      className={
                        topic.unread
                          ? "waypoint-topic-name unread"
                          : "waypoint-topic-name"
                      }
                      style={{ fontWeight: topic.unread ? 700 : 400 }}
                    >
                      {topic.name}
                    </span>
                    {topic.unavailable ? (
                      <span className="waypoint-topic-row-unavailable">不可用</span>
                    ) : null}
                  </span>
                  <span className="waypoint-topic-row-trailing">
                    {topic.pinned ? (
                      <span className="waypoint-topic-row-pin" aria-label="已置顶">
                        <PinIcon aria-hidden="true" size={11} />
                        置顶
                      </span>
                    ) : null}
                    {topic.sendStatus === "failed" ? (
                      <span
                        role="img"
                        aria-label="失败"
                        className="waypoint-topic-row-failed"
                      >
                        !
                      </span>
                    ) : topic.sendStatus === "unconfirmed" ? (
                      <span
                        role="img"
                        aria-label="未确认"
                        className="waypoint-unconfirmed-spinner"
                      />
                    ) : null}
                    {topic.lastActivityTs !== undefined ? (
                      <span className="waypoint-topic-row-time">
                        {formatTopicListTime(topic.lastActivityTs, nowMs)}
                      </span>
                    ) : null}
                  </span>
                </span>
                {(registeredAgentsCount > 1 && topic.botDisplayName) ||
                topic.responding ? (
                  <span className="waypoint-topic-row-secondary">
                    {registeredAgentsCount > 1 && topic.botDisplayName ? (
                      <span className="waypoint-topic-row-bot">
                        {topic.botDisplayName}
                      </span>
                    ) : null}
                    {topic.responding ? (
                      <span className="waypoint-topic-row-responding">正在回应</span>
                    ) : null}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
