import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { Clock, PlatformAdapter, ViewportMode } from "../adapters/types";
import type { MatrixClient } from "./matrix-client";
import {
  deriveTopics,
  localpartOf,
  parseBotRoster,
  resolvePreselectedBotId,
  type BotRosterEntry,
  type StoredRoomRecord,
} from "./topics";

export function TopicsWorkspace({
  client,
  clock,
  platform,
  viewportMode = "wide",
  keyboardInsetBottom = 0,
}: {
  client: MatrixClient;
  clock: Clock;
  platform?: PlatformAdapter;
  viewportMode?: ViewportMode;
  keyboardInsetBottom?: number;
}) {
  const [, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const roster = parseBotRoster(client.accountData("im.waypoint.agents"), client.ownerId);
  const rooms = client.rooms();
  const topics = deriveTopics(rooms, roster, client.ownerId);
  const activeTopic = activeTopicId ? topics.find((topic) => topic.roomId === activeTopicId) : undefined;

  useEffect(() => {
    if (activeTopicId && !topics.some((topic) => topic.roomId === activeTopicId)) {
      setActiveTopicId(null);
      setDescriptionExpanded(false);
    }
  }, [activeTopicId, topics]);

  const navDepthRef = useRef(0);
  const targetDepth = viewportMode === "narrow" ? (creating ? 1 : 0) + (activeTopic ? 1 : 0) : 0;

  useEffect(() => {
    while (navDepthRef.current < targetDepth) {
      navDepthRef.current += 1;
      platform?.pushNavigationEntry?.();
    }
    while (navDepthRef.current > targetDepth) {
      navDepthRef.current -= 1;
      platform?.popNavigationEntry?.();
    }
  }, [targetDepth, platform]);

  const backHandlerRef = useRef<() => boolean>(() => false);
  backHandlerRef.current = () => {
    if (viewportMode !== "narrow") {
      return false;
    }
    if (creating) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (submitting) {
        return true;
      }
      setCreating(false);
      setFormError(undefined);
      return true;
    }
    if (activeTopic) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      setActiveTopicId(null);
      setDescriptionExpanded(false);
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (platform?.onSystemBack) {
      return platform.onSystemBack(() => backHandlerRef.current());
    }
    const onPopState = () => {
      backHandlerRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [platform]);

  function openCreateForm() {
    if (submitting) {
      return;
    }
    setCreating(true);
    setSubmitting(false);
    setNameInput("");
    setDescriptionInput("");
    setSelectedBotId(roster.length === 1 ? roster[0].userId : resolvePreselectedBotId(topics, roster));
    setFormError(undefined);
  }

  function closeCreateForm() {
    if (submitting) {
      return;
    }
    setCreating(false);
    setFormError(undefined);
  }

  function openTopic(roomId: string) {
    if (submitting) {
      return;
    }
    setCreating(false);
    setFormError(undefined);
    setActiveTopicId(roomId);
    setDescriptionExpanded(false);
  }

  function goBack() {
    if (creating) {
      closeCreateForm();
      return;
    }
    if (activeTopic) {
      setActiveTopicId(null);
      setDescriptionExpanded(false);
    }
  }

  function collapseDescription() {
    setDescriptionExpanded(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      setFormError("请输入 Topic 名字。");
      return;
    }
    const agentUserId = roster.length === 1 ? roster[0].userId : selectedBotId;
    if (!agentUserId || !roster.some((bot) => bot.userId === agentUserId)) {
      setFormError("请选择要绑定的 Bot。");
      return;
    }

    const trimmedDescription = descriptionInput.trim();
    setSubmitting(true);
    setFormError(undefined);

    const now = clock.currentTimeMs ? clock.currentTimeMs() : Date.now();
    const result = await client.createTopicRoom({
      name: trimmedName,
      description: trimmedDescription || undefined,
      agentUserId,
      now,
    });

    setSubmitting(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    setCreating(false);
    setActiveTopicId(result.roomId);
    setDescriptionExpanded(false);
    setRevision((value) => value + 1);
    void client.appendDirectRoom(agentUserId, result.roomId);
  }

  const isNarrow = viewportMode === "narrow";
  const isNarrowPushed = isNarrow && (creating || Boolean(activeTopic));
  const showSidebar = !isNarrow || !isNarrowPushed;
  const showDetail = !isNarrow || isNarrowPushed;
  const safeInset = Number.isFinite(keyboardInsetBottom) && keyboardInsetBottom > 0 ? Math.round(keyboardInsetBottom) : 0;

  return (
    <div
      className="waypoint-workspace"
      data-viewport={viewportMode}
      style={{ "--keyboard-inset": `${safeInset}px` } as CSSProperties}
    >
      {showSidebar ? (
        <aside className="waypoint-sidebar" aria-label="Topic 列表">
          <p>已连接</p>
          <div className="waypoint-sidebar-header">
            <h1>Topic</h1>
            <button type="button" onClick={openCreateForm}>
              新建 Topic
            </button>
          </div>
          {topics.length === 0 ? (
            <p>暂无 Topic</p>
          ) : (
            <ul className="waypoint-topic-list">
              {topics.map((topic) => (
                <li key={topic.roomId}>
                  <button
                    type="button"
                    className={
                      topic.roomId === activeTopic?.roomId
                        ? "waypoint-topic-row active"
                        : "waypoint-topic-row"
                    }
                    onClick={() => openTopic(topic.roomId)}
                  >
                    <span className="waypoint-topic-row-title">
                      <span>{topic.name}</span>
                      {topic.unavailableReason ? (
                        <span className="waypoint-unavailable-tag">不可用</span>
                      ) : null}
                    </span>
                    {roster.length > 1 && topic.botDisplayName ? (
                      <span className="waypoint-topic-row-bot">{topic.botDisplayName}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      ) : null}

      {showDetail ? (
        <div className="waypoint-detail">
          {creating ? (
            <section aria-label="新建 Topic" className="waypoint-dialog">
              {isNarrow ? (
                <div className="waypoint-topic-header">
                  <div className="waypoint-topic-header-bar">
                    <button
                      type="button"
                      className="waypoint-back-button"
                      disabled={submitting}
                      onClick={goBack}
                    >
                      返回
                    </button>
                    <div className="waypoint-topic-header-main">
                      <h2>新建 Topic</h2>
                    </div>
                  </div>
                </div>
              ) : null}
              <div
                className="waypoint-dialog-body"
                style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
              >
                {!isNarrow ? <h2>新建 Topic</h2> : null}
                <form onSubmit={handleSubmit}>
                  <label>
                    Topic 名字
                    <input
                      name="topic-name"
                      value={nameInput}
                      onChange={(event) => setNameInput(event.target.value)}
                    />
                  </label>
                  <label>
                    Description（可选）
                    <textarea
                      name="topic-description"
                      value={descriptionInput}
                      onChange={(event) => setDescriptionInput(event.target.value)}
                    />
                  </label>
                  <p className="waypoint-field-hint">
                    留空表示没有额外上下文；填写后会发给这条 Topic 绑定的 Bot，不是私密备忘。
                  </p>
                  {roster.length > 1 ? (
                    <label>
                      绑定 Bot
                      <select
                        name="bot-user-id"
                        value={selectedBotId}
                        onChange={(event) => setSelectedBotId(event.target.value)}
                      >
                        <option value="">请选择 Bot</option>
                        {roster.map((bot) => (
                          <option key={bot.userId} value={bot.userId}>
                            {resolveRosterOptionLabel(bot, rooms)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {formError ? <p role="alert">{formError}</p> : null}
                  <div className="waypoint-form-actions">
                    <button type="submit" disabled={submitting}>
                      {submitting ? "正在创建…" : "创建 Topic"}
                    </button>
                    <button type="button" disabled={submitting} onClick={closeCreateForm}>
                      取消
                    </button>
                  </div>
                </form>
              </div>
            </section>
          ) : activeTopic ? (
            <div className="waypoint-topic-view">
              <header className="waypoint-topic-header">
                <div className="waypoint-topic-header-bar">
                  {isNarrow ? (
                    <button
                      type="button"
                      className="waypoint-back-button"
                      onClick={goBack}
                    >
                      返回
                    </button>
                  ) : null}
                  <div className="waypoint-topic-header-main">
                    <h2>{activeTopic.name}</h2>
                    {activeTopic.botDisplayName ? (
                      <p className="waypoint-topic-header-bot">{activeTopic.botDisplayName}</p>
                    ) : null}
                  </div>
                </div>
                {activeTopic.description ? (
                  <button
                    type="button"
                    className={
                      descriptionExpanded
                        ? "waypoint-topic-description expanded"
                        : "waypoint-topic-description"
                    }
                    aria-expanded={descriptionExpanded}
                    onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                  >
                    {activeTopic.description}
                  </button>
                ) : null}
                {activeTopic.unavailableReason ? (
                  <p role="status" className="waypoint-unavailable-banner">
                    {activeTopic.unavailableReason}
                  </p>
                ) : null}
              </header>
              <main
                className="waypoint-timeline-container"
                style={{ paddingBottom: `${safeInset}px` }}
              >
                <div
                  role="log"
                  aria-label="对话时间线"
                  className="waypoint-timeline"
                  onScroll={collapseDescription}
                />
                <div
                  className="waypoint-composer-safe-area"
                  data-keyboard-inset={safeInset}
                />
              </main>
            </div>
          ) : (
            <section aria-label="Topic 引导" className="waypoint-empty-detail">
              <p>
                {topics.length === 0
                  ? "还没有 Topic，新建一条 Topic 开始交流。"
                  : "选择一条 Topic，或新建一条 Topic 开始交流。"}
              </p>
              <button type="button" onClick={openCreateForm}>
                新建一条 Topic
              </button>
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}

function resolveRosterOptionLabel(
  bot: BotRosterEntry,
  rooms: Record<string, StoredRoomRecord>,
): string {
  if (bot.handwrittenName) {
    return bot.handwrittenName;
  }
  for (const room of Object.values(rooms)) {
    const memberDisplayName = room.members[bot.userId]?.displayname;
    if (memberDisplayName) {
      return memberDisplayName;
    }
  }
  return localpartOf(bot.userId);
}
