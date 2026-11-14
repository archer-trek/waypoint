import type { FormEvent, ReactNode } from "react";
import { AlertCircle, Plus, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { APPEARANCE_OPTIONS, useAppearancePreference } from "../appearance";
import type { StoredRoomEvents } from "../session-store";
import { resolveBotName, type RegisteredAgent } from "../topics";
import { ExitConfirmDialog } from "./ReauthBanner";
import { ResponsiveFormShell } from "./ResponsiveFormShell";
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

/** Settings dialog/page for Registered Bots management, local appearance, and device sign-out. */
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
  const busy = agentsSubmitting || exiting;
  const hasNestedAlertDialog =
    agentsForm?.mode === "remove" || exitConfirmOpen;

  return (
    <ResponsiveFormShell
      title="设置"
      isModal={isModal}
      isNarrow={isNarrow}
      safeInset={safeInset}
      closeDisabled={busy}
      backDisabled={busy}
      nestedModalOpen={hasNestedAlertDialog}
      reauthBanner={reauthBanner}
      headerAction={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onCloseSettings}
          className="h-8 gap-1 px-2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
          关闭
        </Button>
      }
      onClose={onCloseSettings}
      onGoBack={onGoBack}
      onEscapeKeyDown={(event) => {
        if (agentsForm && agentsForm.mode !== "remove") {
          event.preventDefault();
          onCancelAgentsAction();
        }
      }}
    >
      <section aria-label="Bot 名册" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="ml-1 text-xs font-semibold tracking-wide text-muted-foreground">
            Bot 名册
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-foreground"
            disabled={busy}
            onClick={onOpenAddAgentForm}
          >
            <Plus className="size-4" aria-hidden="true" />
            登记新 Bot
          </Button>
        </div>

        <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0">
          {registeredAgents.map((bot) => (
            <li
              key={bot.userId}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {resolveBotName(bot.userId, registeredAgents, roomList)}
                </span>
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {bot.userId}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onOpenEditAgentForm(bot.userId, bot.handwrittenName)
                  }
                >
                  编辑
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                  disabled={registeredAgents.length <= 1 || busy}
                  onClick={() => onOpenRemoveAgentConfirm(bot.userId)}
                >
                  移除
                </Button>
              </div>
            </li>
          ))}
        </ul>

        {agentsForm?.mode === "add" ? (
          <form
            onSubmit={onAddAgentSubmit}
            className="space-y-3 rounded-xl border border-border bg-muted/40 p-4"
          >
            <h4 className="m-0 text-sm font-semibold text-foreground">
              登记新 Bot
            </h4>
            <div className="flex flex-col gap-2">
              <Label htmlFor="agents-bot-user-id">Matrix 用户 ID</Label>
              <Input
                id="agents-bot-user-id"
                name="agents-bot-user-id"
                placeholder="@agent:example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={agentsForm.userId}
                disabled={agentsSubmitting}
                onChange={(event) =>
                  onAgentsFormChange({
                    ...agentsForm,
                    userId: event.target.value,
                  })
                }
                className="h-11 bg-background select-text"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="agents-bot-name">手写名字（可选）</Label>
              <Input
                id="agents-bot-name"
                name="agents-bot-name"
                value={agentsForm.handwrittenName}
                disabled={agentsSubmitting}
                onChange={(event) =>
                  onAgentsFormChange({
                    ...agentsForm,
                    handwrittenName: event.target.value,
                  })
                }
                className="h-11 bg-background select-text"
              />
            </div>
            {agentsError ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertDescription>{agentsError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={agentsSubmitting}
                onClick={onCancelAgentsAction}
              >
                取消
              </Button>
              <Button
                type="submit"
                className="min-h-11 sm:min-h-9"
                disabled={agentsSubmitting}
              >
                {agentsSubmitting ? "正在保存…" : "登记 Bot"}
              </Button>
            </div>
          </form>
        ) : agentsForm?.mode === "edit" ? (
          <form
            onSubmit={onEditAgentSubmit}
            className="space-y-3 rounded-xl border border-border bg-muted/40 p-4"
          >
            <h4 className="m-0 text-sm font-semibold text-foreground">
              编辑 Bot
            </h4>
            <div className="flex flex-col gap-2">
              <Label htmlFor="agents-edit-user-id">Matrix 用户 ID</Label>
              <Input
                id="agents-edit-user-id"
                name="agents-edit-user-id"
                value={agentsForm.userId}
                disabled
                className="h-11 bg-background font-mono select-text"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="agents-edit-name">手写名字（可选）</Label>
              <Input
                id="agents-edit-name"
                name="agents-edit-name"
                value={agentsForm.handwrittenName}
                disabled={agentsSubmitting}
                onChange={(event) =>
                  onAgentsFormChange({
                    ...agentsForm,
                    handwrittenName: event.target.value,
                  })
                }
                className="h-11 bg-background select-text"
              />
            </div>
            {agentsError ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertDescription>{agentsError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={agentsSubmitting}
                onClick={onCancelAgentsAction}
              >
                取消
              </Button>
              <Button
                type="submit"
                className="min-h-11 sm:min-h-9"
                disabled={agentsSubmitting}
              >
                {agentsSubmitting ? "正在保存…" : "保存"}
              </Button>
            </div>
          </form>
        ) : agentsForm?.mode === "remove" ? (
          <AlertDialog
            open
            onOpenChange={(open) => {
              if (!open && !agentsSubmitting) {
                onCancelAgentsAction();
              }
            }}
          >
            <AlertDialogContent
              aria-label="确认移除 Bot"
              onEscapeKeyDown={(event) => {
                if (agentsSubmitting) {
                  event.preventDefault();
                }
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>确认移除 Bot</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <p className="m-0">
                      确定要从 Bot 名册移除{" "}
                      {resolveBotName(
                        agentsForm.userId,
                        registeredAgents,
                        roomList,
                      )}
                      （{agentsForm.userId}）吗？
                    </p>
                    <p className="m-0">
                      移除不会删除已有 Topic，已有交流不受影响，也不会离开这些房间。
                    </p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              {agentsError ? (
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>{agentsError}</AlertDescription>
                </Alert>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel
                  className="min-h-11 sm:min-h-9"
                  disabled={agentsSubmitting}
                >
                  取消
                </AlertDialogCancel>
                <AlertDialogAction
                  className={cn(
                    buttonVariants({ variant: "destructive" }),
                    "min-h-11 sm:min-h-9",
                  )}
                  disabled={agentsSubmitting}
                  onClick={(event) => {
                    event.preventDefault();
                    onConfirmRemoveBot();
                  }}
                >
                  {agentsSubmitting ? "正在移除…" : "确认移除"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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
              const radios =
                event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="radio"]',
                );
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
                  disabled={busy}
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
          disabled={busy}
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
    </ResponsiveFormShell>
  );
}
