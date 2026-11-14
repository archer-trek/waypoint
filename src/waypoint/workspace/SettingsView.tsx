import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { APPEARANCE_OPTIONS, useAppearancePreference } from "../appearance";
import { BackIcon, CloseIcon } from "../icons";
import type { StoredRoomEvents } from "../session-store";
import { resolveBotName, type RegisteredAgent } from "../topics";
import { ExitConfirmDialog } from "./ReauthBanner";
import type { AgentsFormState } from "./types";

export type SettingsViewProps = {
  isModal: boolean;
  isNarrow: boolean;
  safeInset: number;
  reauthBanner: ReactNode;
  registeredAgents: RegisteredAgent[];
  roomList: StoredRoomEvents[];
  agentsForm: AgentsFormState | null;
  agentsSubmitting: boolean;
  agentsError?: string;
  exitConfirmOpen: boolean;
  exiting: boolean;
  onGoBack: () => void;
  onCloseSettings: () => void;
  onOpenAddAgentForm: () => void;
  onOpenEditAgentForm: (userId: string, currentName?: string) => void;
  onOpenRemoveAgentConfirm: (userId: string) => void;
  onAgentsFormChange: (next: AgentsFormState) => void;
  onAddAgentSubmit: (event: FormEvent) => void;
  onEditAgentSubmit: (event: FormEvent) => void;
  onConfirmRemoveBot: () => void;
  onCancelAgentsAction: () => void;
  onOpenExitConfirm: () => void;
  onConfirmExit: () => void;
  onCancelExit: () => void;
};

/** Settings dialog/page for Bot roster management and device sign-out. */
export function SettingsView({
  isModal,
  isNarrow,
  safeInset,
  reauthBanner,
  registeredAgents,
  roomList,
  agentsForm,
  agentsSubmitting,
  agentsError,
  exitConfirmOpen,
  exiting,
  onGoBack,
  onCloseSettings,
  onOpenAddAgentForm,
  onOpenEditAgentForm,
  onOpenRemoveAgentConfirm,
  onAgentsFormChange,
  onAddAgentSubmit,
  onEditAgentSubmit,
  onConfirmRemoveBot,
  onCancelAgentsAction,
  onOpenExitConfirm,
  onConfirmExit,
  onCancelExit,
}: SettingsViewProps) {
  const [appearanceMode, setAppearanceMode] = useAppearancePreference();

  return (
    <section
      aria-label="设置"
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
              disabled={agentsSubmitting || exiting}
              onClick={onGoBack}
            >
              <BackIcon aria-hidden="true" size={16} />
              <span className="sr-only">返回</span>
            </button>
            <div className="waypoint-topic-header-main">
              <h2>设置</h2>
            </div>
          </div>
        </div>
      ) : null}
      {reauthBanner}
      <div
        className="waypoint-dialog-body"
        style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
      >
        {!isNarrow ? (
          <div className="waypoint-settings-header">
            <h2>设置</h2>
            <button
              type="button"
              disabled={agentsSubmitting || exiting}
              onClick={onCloseSettings}
            >
              <CloseIcon aria-hidden="true" size={14} />
              关闭
            </button>
          </div>
        ) : null}
        <section aria-label="Bot 名册" className="waypoint-agents-section">
          <div className="waypoint-agents-header">
            <h3>Bot 名册</h3>
            <button
              type="button"
              disabled={agentsSubmitting || exiting}
              onClick={onOpenAddAgentForm}
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
                    disabled={agentsSubmitting || exiting}
                    onClick={() =>
                      onOpenEditAgentForm(bot.userId, bot.handwrittenName)
                    }
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={
                      registeredAgents.length <= 1 || agentsSubmitting || exiting
                    }
                    onClick={() => onOpenRemoveAgentConfirm(bot.userId)}
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {agentsForm?.mode === "add" ? (
            <form onSubmit={onAddAgentSubmit} className="waypoint-agents-form">
              <h4>登记新 Bot</h4>
              <label>
                Matrix 用户 ID
                <input
                  name="agents-bot-user-id"
                  value={agentsForm.userId}
                  disabled={agentsSubmitting}
                  onChange={(event) =>
                    onAgentsFormChange({
                      ...agentsForm,
                      userId: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                手写名字（可选）
                <input
                  name="agents-bot-name"
                  value={agentsForm.handwrittenName}
                  disabled={agentsSubmitting}
                  onChange={(event) =>
                    onAgentsFormChange({
                      ...agentsForm,
                      handwrittenName: event.target.value,
                    })
                  }
                />
              </label>
              {agentsError ? <p role="alert">{agentsError}</p> : null}
              <div className="waypoint-form-actions">
                <button type="submit" disabled={agentsSubmitting}>
                  {agentsSubmitting ? "正在保存…" : "登记 Bot"}
                </button>
                <button
                  type="button"
                  disabled={agentsSubmitting}
                  onClick={onCancelAgentsAction}
                >
                  取消
                </button>
              </div>
            </form>
          ) : agentsForm?.mode === "edit" ? (
            <form onSubmit={onEditAgentSubmit} className="waypoint-agents-form">
              <h4>编辑 Bot</h4>
              <label>
                Matrix 用户 ID
                <input
                  name="agents-edit-user-id"
                  value={agentsForm.userId}
                  disabled
                />
              </label>
              <label>
                手写名字（可选）
                <input
                  name="agents-edit-name"
                  value={agentsForm.handwrittenName}
                  disabled={agentsSubmitting}
                  onChange={(event) =>
                    onAgentsFormChange({
                      ...agentsForm,
                      handwrittenName: event.target.value,
                    })
                  }
                />
              </label>
              {agentsError ? <p role="alert">{agentsError}</p> : null}
              <div className="waypoint-form-actions">
                <button type="submit" disabled={agentsSubmitting}>
                  {agentsSubmitting ? "正在保存…" : "保存"}
                </button>
                <button
                  type="button"
                  disabled={agentsSubmitting}
                  onClick={onCancelAgentsAction}
                >
                  取消
                </button>
              </div>
            </form>
          ) : agentsForm?.mode === "remove" ? (
            <div
              role="alertdialog"
              aria-label="确认移除 Bot"
              className="waypoint-agents-form"
            >
              <h4>确认移除 Bot</h4>
              <p>
                确定要从 Bot 名册移除{" "}
                {resolveBotName(agentsForm.userId, registeredAgents, roomList)}（
                {agentsForm.userId}）吗？
              </p>
              <p>
                移除不会删除已有 Topic，已有交流不受影响，也不会离开这些房间。
              </p>
              {agentsError ? <p role="alert">{agentsError}</p> : null}
              <div className="waypoint-form-actions">
                <button
                  type="button"
                  disabled={agentsSubmitting}
                  onClick={onConfirmRemoveBot}
                >
                  {agentsSubmitting ? "正在移除…" : "确认移除"}
                </button>
                <button
                  type="button"
                  disabled={agentsSubmitting}
                  onClick={onCancelAgentsAction}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </section>
        <section aria-label="这台设备" className="mt-8 space-y-3">
          <h3 className="ml-1 text-xs font-semibold tracking-wide text-muted-foreground">
            这台设备
          </h3>
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">外观</span>
              <span className="text-xs text-muted-foreground">仅作用于本机</span>
            </div>
            <div
              role="radiogroup"
              aria-label="外观"
              className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                  return;
                }
                event.preventDefault();
                const currentIndex = APPEARANCE_OPTIONS.findIndex(
                  (option) => option.value === appearanceMode,
                );
                const delta = event.key === "ArrowRight" ? 1 : -1;
                const nextIndex =
                  (currentIndex + delta + APPEARANCE_OPTIONS.length) %
                  APPEARANCE_OPTIONS.length;
                setAppearanceMode(APPEARANCE_OPTIONS[nextIndex].value);
                const radios = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
                radios[nextIndex]?.focus();
              }}
            >
              {APPEARANCE_OPTIONS.map((option) => {
                const selected = appearanceMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={agentsSubmitting || exiting}
                    onClick={() => setAppearanceMode(option.value)}
                    className={cn(
                      "inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
                      selected
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-12 w-full rounded-xl border-border bg-card text-sm font-semibold text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            disabled={agentsSubmitting || exiting}
            onClick={onOpenExitConfirm}
          >
            退出这台设备
          </Button>
          {exitConfirmOpen ? (
            <ExitConfirmDialog
              exiting={exiting}
              onConfirmExit={onConfirmExit}
              onCancelExit={onCancelExit}
            />
          ) : null}
        </section>
      </div>
    </section>
  );
}
