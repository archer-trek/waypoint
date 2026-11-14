import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { BackIcon, PlusIcon } from "../icons";
import type { StoredRoomEvents } from "../session-store";
import { resolveBotName, type RegisteredAgent } from "../topics";

export type CreateTopicViewProps = {
  isModal: boolean;
  isNarrow: boolean;
  safeInset: number;
  reauthRequired: boolean;
  reauthBanner: ReactNode;
  registeredAgents: RegisteredAgent[];
  roomList: StoredRoomEvents[];
  nameInput: string;
  descriptionInput: string;
  selectedBotId: string;
  submitting: boolean;
  formError?: string;
  quickRegisterOpen: boolean;
  quickUserId: string;
  quickHandwrittenName: string;
  quickSubmitting: boolean;
  quickError?: string;
  onGoBack: () => void;
  onCloseCreateForm: () => void;
  onSubmit: (event: FormEvent) => void;
  onNameInputChange: (value: string) => void;
  onDescriptionInputChange: (value: string) => void;
  onSelectedBotIdChange: (value: string) => void;
  onOpenQuickRegister: () => void;
  onCloseQuickRegister: () => void;
  onQuickUserIdChange: (value: string) => void;
  onQuickHandwrittenNameChange: (value: string) => void;
  onQuickRegisterKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onQuickRegister: () => void;
};

/** New Topic creation dialog/page with inline Bot quick-registration. */
export function CreateTopicView({
  isModal,
  isNarrow,
  safeInset,
  reauthRequired,
  reauthBanner,
  registeredAgents,
  roomList,
  nameInput,
  descriptionInput,
  selectedBotId,
  submitting,
  formError,
  quickRegisterOpen,
  quickUserId,
  quickHandwrittenName,
  quickSubmitting,
  quickError,
  onGoBack,
  onCloseCreateForm,
  onSubmit,
  onNameInputChange,
  onDescriptionInputChange,
  onSelectedBotIdChange,
  onOpenQuickRegister,
  onCloseQuickRegister,
  onQuickUserIdChange,
  onQuickHandwrittenNameChange,
  onQuickRegisterKeyDown,
  onQuickRegister,
}: CreateTopicViewProps) {
  return (
    <section
      aria-label="新建 Topic"
      className={isModal ? "waypoint-dialog waypoint-modal" : "waypoint-dialog"}
      role="region"
      aria-modal={isModal ? "true" : undefined}
      onClick={isModal ? (event) => event.stopPropagation() : undefined}
    >
      {isNarrow ? (
        <div className="waypoint-topic-header">
          <div className="waypoint-topic-header-bar">
            <button
              type="button"
              className="waypoint-back-button"
              aria-label="返回"
              disabled={submitting || quickSubmitting}
              onClick={onGoBack}
            >
              <BackIcon aria-hidden="true" size={16} />
              <span className="sr-only">返回</span>
            </button>
            <div className="waypoint-topic-header-main">
              <h2>新建 Topic</h2>
            </div>
          </div>
        </div>
      ) : null}
      {reauthBanner}
      <div
        className="waypoint-dialog-body"
        style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
      >
        {!isNarrow ? <h2>新建 Topic</h2> : null}
        <form onSubmit={onSubmit}>
          <label>
            Topic 名字
            <input
              name="topic-name"
              value={nameInput}
              onChange={(event) => onNameInputChange(event.target.value)}
            />
          </label>
          <label>
            Description（可选）
            <textarea
              name="topic-description"
              value={descriptionInput}
              onChange={(event) => onDescriptionInputChange(event.target.value)}
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
                onChange={(event) => onSelectedBotIdChange(event.target.value)}
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
              className="waypoint-quick-register-trigger"
              disabled={submitting || quickSubmitting}
              onClick={onOpenQuickRegister}
            >
              <PlusIcon aria-hidden="true" size={13} />
              登记新 Bot
            </button>
          ) : (
            <section
              aria-label="登记新 Bot"
              className="waypoint-inline-register"
            >
              <h3>登记新 Bot</h3>
              <label>
                Matrix 用户 ID
                <input
                  name="quick-bot-user-id"
                  value={quickUserId}
                  disabled={quickSubmitting}
                  onChange={(event) => onQuickUserIdChange(event.target.value)}
                  onKeyDown={onQuickRegisterKeyDown}
                />
              </label>
              <label>
                手写名字（可选）
                <input
                  name="quick-bot-name"
                  value={quickHandwrittenName}
                  disabled={quickSubmitting}
                  onChange={(event) =>
                    onQuickHandwrittenNameChange(event.target.value)
                  }
                  onKeyDown={onQuickRegisterKeyDown}
                />
              </label>
              {quickError ? <p role="alert">{quickError}</p> : null}
              <div className="waypoint-form-actions">
                <button
                  type="button"
                  disabled={quickSubmitting || submitting}
                  onClick={onQuickRegister}
                >
                  {quickSubmitting ? "正在保存…" : "登记 Bot"}
                </button>
                <button
                  type="button"
                  disabled={quickSubmitting || submitting}
                  onClick={onCloseQuickRegister}
                >
                  取消登记
                </button>
              </div>
            </section>
          )}
          {formError ? <p role="alert">{formError}</p> : null}
          <div className="waypoint-form-actions">
            <button
              type="submit"
              disabled={submitting || quickSubmitting || reauthRequired}
            >
              {submitting ? "正在创建…" : "创建 Topic"}
            </button>
            <button
              type="button"
              disabled={submitting || quickSubmitting}
              onClick={onCloseCreateForm}
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
