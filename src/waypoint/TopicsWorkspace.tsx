import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { normalizeInset } from "../adapters/inset";
import type { Clock, PlatformAdapter, ViewportMode } from "../adapters/types";
import type { MatrixClient } from "./matrix-client";
import {
  appendDirectRoom,
  buildAddAgentContent,
  buildRemoveAgentContent,
  buildRenameAgentContent,
  createTopicRoom,
  deriveTopics,
  parseRegisteredAgents,
  resolveBotName,
  resolvePreselectedBotId,
  saveAgentsRoster,
  validateAgentUserId,
} from "./topics";

type RosterFormState =
  | {
      mode: "add";
      userId: string;
      handwrittenName: string;
    }
  | {
      mode: "edit";
      userId: string;
      handwrittenName: string;
    }
  | {
      mode: "remove";
      userId: string;
    };

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rosterForm, setRosterForm] = useState<RosterFormState | null>(null);
  const [rosterSubmitting, setRosterSubmitting] = useState(false);
  const [rosterError, setRosterError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [quickRegisterOpen, setQuickRegisterOpen] = useState(false);
  const [quickUserId, setQuickUserId] = useState("");
  const [quickHandwrittenName, setQuickHandwrittenName] = useState("");
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [quickError, setQuickError] = useState<string | undefined>(undefined);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const registeredAgents = parseRegisteredAgents(
    client.accountData("im.waypoint.agents"),
    client.ownerId,
  );
  const rooms = client.rooms();
  const roomList = Object.values(rooms);
  const topics = deriveTopics(rooms, registeredAgents, client.ownerId);
  const activeTopic = activeTopicId
    ? topics.find((topic) => topic.roomId === activeTopicId)
    : undefined;

  useEffect(() => {
    if (activeTopicId && !topics.some((topic) => topic.roomId === activeTopicId)) {
      setActiveTopicId(null);
      setDescriptionExpanded(false);
    }
  }, [activeTopicId, topics]);

  const navDepthRef = useRef(0);
  const targetDepth =
    viewportMode === "narrow"
      ? (settingsOpen ? 1 : 0) + (creating ? 1 : 0) + (activeTopic ? 1 : 0)
      : 0;

  function syncNavigationDepth(desiredDepth: number) {
    while (navDepthRef.current < desiredDepth) {
      navDepthRef.current += 1;
      platform?.pushNavigationEntry?.();
    }
    while (navDepthRef.current > desiredDepth) {
      navDepthRef.current -= 1;
      platform?.popNavigationEntry?.();
    }
  }

  useEffect(() => {
    syncNavigationDepth(targetDepth);
  }, [targetDepth, platform]);

  const backHandlerRef = useRef<() => boolean>(() => false);
  backHandlerRef.current = () => {
    if (viewportMode !== "narrow") {
      return false;
    }
    if (settingsOpen) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (rosterSubmitting) {
        syncNavigationDepth(targetDepth);
        return true;
      }
      setSettingsOpen(false);
      setRosterForm(null);
      setRosterError(undefined);
      return true;
    }
    if (creating) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (submitting || quickSubmitting) {
        syncNavigationDepth(targetDepth);
        return true;
      }
      setCreating(false);
      setFormError(undefined);
      setQuickRegisterOpen(false);
      setQuickUserId("");
      setQuickHandwrittenName("");
      setQuickError(undefined);
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

  function openSettings() {
    if (submitting || quickSubmitting || rosterSubmitting) {
      return;
    }
    setCreating(false);
    setFormError(undefined);
    setQuickRegisterOpen(false);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
    setRosterForm(null);
    setRosterError(undefined);
    setSettingsOpen(true);
  }

  function closeSettings() {
    if (rosterSubmitting) {
      return;
    }
    setSettingsOpen(false);
    setRosterForm(null);
    setRosterError(undefined);
  }

  function openAddRosterForm() {
    if (rosterSubmitting) {
      return;
    }
    setRosterForm({ mode: "add", userId: "", handwrittenName: "" });
    setRosterError(undefined);
  }

  function openEditRosterForm(userId: string, currentName?: string) {
    if (rosterSubmitting) {
      return;
    }
    setRosterForm({
      mode: "edit",
      userId,
      handwrittenName: currentName ?? "",
    });
    setRosterError(undefined);
  }

  async function handleEditRosterSubmit(event: FormEvent) {
    event.preventDefault();
    if (rosterSubmitting || rosterForm?.mode !== "edit") {
      return;
    }
    const nextContent = buildRenameAgentContent(
      client.accountData("im.waypoint.agents"),
      rosterForm.userId,
      rosterForm.handwrittenName,
    );
    setRosterSubmitting(true);
    setRosterError(undefined);
    const result = await saveAgentsRoster(client, "修改 Bot 名字", nextContent);
    setRosterSubmitting(false);
    if (!result.ok) {
      setRosterError(result.message);
      return;
    }
    setRosterForm(null);
    setRosterError(undefined);
    setRevision((value) => value + 1);
  }

  function openRemoveRosterConfirm(userId: string) {
    if (rosterSubmitting || registeredAgents.length <= 1) {
      return;
    }
    setRosterForm({ mode: "remove", userId });
    setRosterError(undefined);
  }

  async function confirmRemoveBot() {
    if (rosterSubmitting || rosterForm?.mode !== "remove") {
      return;
    }
    if (registeredAgents.length <= 1) {
      setRosterError("移除 Bot 失败，因为名册里至少要保留一个 Bot。");
      return;
    }
    const nextContent = buildRemoveAgentContent(
      client.accountData("im.waypoint.agents"),
      rosterForm.userId,
    );
    setRosterSubmitting(true);
    setRosterError(undefined);
    const result = await saveAgentsRoster(client, "移除 Bot", nextContent);
    setRosterSubmitting(false);
    if (!result.ok) {
      setRosterError(result.message);
      return;
    }
    setRosterForm(null);
    setRosterError(undefined);
    setRevision((value) => value + 1);
  }

  function cancelRosterAction() {
    if (rosterSubmitting) {
      return;
    }
    setRosterForm(null);
    setRosterError(undefined);
  }

  async function handleAddRosterSubmit(event: FormEvent) {
    event.preventDefault();
    if (rosterSubmitting || rosterForm?.mode !== "add") {
      return;
    }
    const validation = validateAgentUserId(
      rosterForm.userId,
      client.ownerId,
      registeredAgents,
    );
    if (!validation.ok) {
      setRosterForm({ ...rosterForm, userId: validation.trimmed });
      setRosterError(validation.message);
      return;
    }
    const nextContent = buildAddAgentContent(
      client.accountData("im.waypoint.agents"),
      validation.userId,
      rosterForm.handwrittenName,
    );
    setRosterForm({ ...rosterForm, userId: validation.userId });
    setRosterSubmitting(true);
    setRosterError(undefined);
    const result = await saveAgentsRoster(client, "登记 Bot", nextContent);
    setRosterSubmitting(false);
    if (!result.ok) {
      setRosterError(result.message);
      return;
    }
    setRosterForm(null);
    setRosterError(undefined);
    setRevision((value) => value + 1);
  }

  function openCreateForm() {
    if (submitting || quickSubmitting || rosterSubmitting) {
      return;
    }
    setSettingsOpen(false);
    setCreating(true);
    setSubmitting(false);
    setNameInput("");
    setDescriptionInput("");
    setSelectedBotId(
      registeredAgents.length === 1
        ? registeredAgents[0].userId
        : resolvePreselectedBotId(topics, registeredAgents),
    );
    setFormError(undefined);
    setQuickRegisterOpen(false);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
  }

  function closeCreateForm() {
    if (submitting || quickSubmitting) {
      return;
    }
    setCreating(false);
    setFormError(undefined);
    setQuickRegisterOpen(false);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
  }

  function openQuickRegister() {
    if (submitting || quickSubmitting) {
      return;
    }
    setQuickRegisterOpen(true);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
  }

  function closeQuickRegister() {
    if (quickSubmitting) {
      return;
    }
    setQuickRegisterOpen(false);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
  }

  async function handleQuickRegister() {
    if (quickSubmitting || submitting) {
      return;
    }
    const validation = validateAgentUserId(quickUserId, client.ownerId, registeredAgents);
    if (!validation.ok) {
      setQuickUserId(validation.trimmed);
      setQuickError(validation.message);
      return;
    }
    const nextContent = buildAddAgentContent(
      client.accountData("im.waypoint.agents"),
      validation.userId,
      quickHandwrittenName,
    );
    setQuickUserId(validation.userId);
    setQuickSubmitting(true);
    setQuickError(undefined);
    const result = await saveAgentsRoster(client, "登记 Bot", nextContent);
    setQuickSubmitting(false);
    if (!result.ok) {
      setQuickError(result.message);
      return;
    }
    setSelectedBotId(validation.userId);
    setQuickRegisterOpen(false);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
    setRevision((value) => value + 1);
  }

  function openTopic(roomId: string) {
    if (submitting || quickSubmitting || rosterSubmitting) {
      return;
    }
    setSettingsOpen(false);
    setCreating(false);
    setFormError(undefined);
    setQuickRegisterOpen(false);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
    setActiveTopicId(roomId);
    setDescriptionExpanded(false);
  }

  function goBack() {
    if (settingsOpen) {
      closeSettings();
      return;
    }
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
    if (submitting || quickSubmitting) {
      return;
    }
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      setFormError("请输入 Topic 名字。");
      return;
    }
    const agentUserId = registeredAgents.length === 1 ? registeredAgents[0].userId : selectedBotId;
    if (!agentUserId || !registeredAgents.some((bot) => bot.userId === agentUserId)) {
      setFormError("请选择要绑定的 Bot。");
      return;
    }

    const trimmedDescription = descriptionInput.trim();
    setSubmitting(true);
    setFormError(undefined);

    const now = clock.currentTimeMs ? clock.currentTimeMs() : Date.now();
    const result = await createTopicRoom(client, {
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
    void appendDirectRoom(client, agentUserId, result.roomId);
  }

  const isNarrow = viewportMode === "narrow";
  const isNarrowPushed = isNarrow && (settingsOpen || creating || Boolean(activeTopic));
  const showSidebar = !isNarrow || !isNarrowPushed;
  const showDetail = !isNarrow || isNarrowPushed;
  const safeInset = normalizeInset(keyboardInsetBottom);

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
            <div className="waypoint-sidebar-actions">
              <button type="button" onClick={openCreateForm}>
                新建 Topic
              </button>
              <button type="button" onClick={openSettings}>
                设置
              </button>
            </div>
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
                    </span>
                    {registeredAgents.length > 1 && topic.botDisplayName ? (
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
          {settingsOpen ? (
            <section aria-label="设置" className="waypoint-dialog">
              {isNarrow ? (
                <div className="waypoint-topic-header">
                  <div className="waypoint-topic-header-bar">
                    <button
                      type="button"
                      className="waypoint-back-button"
                      disabled={rosterSubmitting}
                      onClick={goBack}
                    >
                      返回
                    </button>
                    <div className="waypoint-topic-header-main">
                      <h2>设置</h2>
                    </div>
                  </div>
                </div>
              ) : null}
              <div
                className="waypoint-dialog-body"
                style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
              >
                {!isNarrow ? (
                  <div className="waypoint-settings-header">
                    <h2>设置</h2>
                    <button type="button" disabled={rosterSubmitting} onClick={closeSettings}>
                      关闭
                    </button>
                  </div>
                ) : null}
                <section aria-label="Bot 名册" className="waypoint-roster-section">
                  <div className="waypoint-roster-header">
                    <h3>Bot 名册</h3>
                    <button
                      type="button"
                      disabled={rosterSubmitting}
                      onClick={openAddRosterForm}
                    >
                      登记新 Bot
                    </button>
                  </div>
                  <ul className="waypoint-bot-list">
                    {registeredAgents.map((bot) => (
                      <li key={bot.userId} className="waypoint-bot-row">
                        <div className="waypoint-bot-info">
                          <span className="waypoint-bot-name">
                            {resolveBotName(bot.userId, registeredAgents, roomList)}
                          </span>
                          <span className="waypoint-bot-id">{bot.userId}</span>
                        </div>
                        <div className="waypoint-bot-actions">
                          <button
                            type="button"
                            disabled={rosterSubmitting}
                            onClick={() => openEditRosterForm(bot.userId, bot.handwrittenName)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={registeredAgents.length <= 1 || rosterSubmitting}
                            onClick={() => openRemoveRosterConfirm(bot.userId)}
                          >
                            移除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {rosterForm?.mode === "add" ? (
                    <form onSubmit={handleAddRosterSubmit} className="waypoint-roster-form">
                      <h4>登记新 Bot</h4>
                      <label>
                        Matrix 用户 ID
                        <input
                          name="roster-bot-user-id"
                          value={rosterForm.userId}
                          disabled={rosterSubmitting}
                          onChange={(event) =>
                            setRosterForm({ ...rosterForm, userId: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        手写名字（可选）
                        <input
                          name="roster-bot-name"
                          value={rosterForm.handwrittenName}
                          disabled={rosterSubmitting}
                          onChange={(event) =>
                            setRosterForm({ ...rosterForm, handwrittenName: event.target.value })
                          }
                        />
                      </label>
                      {rosterError ? <p role="alert">{rosterError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button type="submit" disabled={rosterSubmitting}>
                          {rosterSubmitting ? "正在保存…" : "登记 Bot"}
                        </button>
                        <button
                          type="button"
                          disabled={rosterSubmitting}
                          onClick={cancelRosterAction}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  ) : rosterForm?.mode === "edit" ? (
                    <form onSubmit={handleEditRosterSubmit} className="waypoint-roster-form">
                      <h4>编辑 Bot</h4>
                      <label>
                        Matrix 用户 ID
                        <input
                          name="roster-edit-user-id"
                          value={rosterForm.userId}
                          disabled
                        />
                      </label>
                      <label>
                        手写名字（可选）
                        <input
                          name="roster-edit-name"
                          value={rosterForm.handwrittenName}
                          disabled={rosterSubmitting}
                          onChange={(event) =>
                            setRosterForm({ ...rosterForm, handwrittenName: event.target.value })
                          }
                        />
                      </label>
                      {rosterError ? <p role="alert">{rosterError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button type="submit" disabled={rosterSubmitting}>
                          {rosterSubmitting ? "正在保存…" : "保存"}
                        </button>
                        <button
                          type="button"
                          disabled={rosterSubmitting}
                          onClick={cancelRosterAction}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  ) : rosterForm?.mode === "remove" ? (
                    <div
                      role="alertdialog"
                      aria-label="确认移除 Bot"
                      className="waypoint-roster-form"
                    >
                      <h4>确认移除 Bot</h4>
                      <p>
                        确定要从 Bot 名册移除{" "}
                        {resolveBotName(rosterForm.userId, registeredAgents, roomList)}（
                        {rosterForm.userId}）吗？
                      </p>
                      <p>
                        移除不会删除已有 Topic，已有交流不受影响，也不会离开这些房间。
                      </p>
                      {rosterError ? <p role="alert">{rosterError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button
                          type="button"
                          disabled={rosterSubmitting}
                          onClick={() => void confirmRemoveBot()}
                        >
                          {rosterSubmitting ? "正在移除…" : "确认移除"}
                        </button>
                        <button
                          type="button"
                          disabled={rosterSubmitting}
                          onClick={cancelRosterAction}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
              </div>
            </section>
          ) : creating ? (
            <section aria-label="新建 Topic" className="waypoint-dialog">
              {isNarrow ? (
                <div className="waypoint-topic-header">
                  <div className="waypoint-topic-header-bar">
                    <button
                      type="button"
                      className="waypoint-back-button"
                      disabled={submitting || quickSubmitting}
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
                  {registeredAgents.length > 1 ? (
                    <label>
                      绑定 Bot
                      <select
                        name="bot-user-id"
                        value={selectedBotId}
                        disabled={submitting || quickSubmitting}
                        onChange={(event) => setSelectedBotId(event.target.value)}
                      >
                        <option value="">请选择 Bot</option>
                        {registeredAgents.map((bot) => (
                          <option key={bot.userId} value={bot.userId}>
                            {resolveBotName(bot.userId, registeredAgents, roomList)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {!quickRegisterOpen ? (
                    <button
                      type="button"
                      disabled={submitting || quickSubmitting}
                      onClick={openQuickRegister}
                    >
                      登记新 Bot
                    </button>
                  ) : (
                    <section aria-label="登记新 Bot" className="waypoint-inline-register">
                      <h3>登记新 Bot</h3>
                      <label>
                        Matrix 用户 ID
                        <input
                          name="quick-bot-user-id"
                          value={quickUserId}
                          disabled={quickSubmitting}
                          onChange={(event) => setQuickUserId(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleQuickRegister();
                            }
                          }}
                        />
                      </label>
                      <label>
                        手写名字（可选）
                        <input
                          name="quick-bot-name"
                          value={quickHandwrittenName}
                          disabled={quickSubmitting}
                          onChange={(event) => setQuickHandwrittenName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleQuickRegister();
                            }
                          }}
                        />
                      </label>
                      {quickError ? <p role="alert">{quickError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button
                          type="button"
                          disabled={quickSubmitting || submitting}
                          onClick={() => void handleQuickRegister()}
                        >
                          {quickSubmitting ? "正在保存…" : "登记 Bot"}
                        </button>
                        <button
                          type="button"
                          disabled={quickSubmitting || submitting}
                          onClick={closeQuickRegister}
                        >
                          取消登记
                        </button>
                      </div>
                    </section>
                  )}
                  {formError ? <p role="alert">{formError}</p> : null}
                  <div className="waypoint-form-actions">
                    <button type="submit" disabled={submitting || quickSubmitting}>
                      {submitting ? "正在创建…" : "创建 Topic"}
                    </button>
                    <button
                      type="button"
                      disabled={submitting || quickSubmitting}
                      onClick={closeCreateForm}
                    >
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
