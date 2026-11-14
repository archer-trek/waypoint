import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { AlertCircle, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { StoredRoomEvents } from "../session-store";
import { resolveBotName, type RegisteredAgent } from "../topics";
import { ResponsiveFormShell } from "./ResponsiveFormShell";

export type CreateTopicViewProps = {
  isModal: boolean;
  isNarrow: boolean;
  safeInset: number;
  nestedModalOpen?: boolean;
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
  nestedModalOpen = false,
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
  const busy = submitting || quickSubmitting;

  return (
    <ResponsiveFormShell
      title="新建 Topic"
      isModal={isModal}
      isNarrow={isNarrow}
      safeInset={safeInset}
      closeDisabled={busy}
      backDisabled={busy}
      nestedModalOpen={nestedModalOpen}
      reauthBanner={reauthBanner}
      onClose={onCloseCreateForm}
      onGoBack={onGoBack}
      onEscapeKeyDown={(event) => {
        if (quickRegisterOpen) {
          event.preventDefault();
          onCloseQuickRegister();
        }
      }}
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="create-topic-name">Topic 名字</Label>
          <Input
            id="create-topic-name"
            name="topic-name"
            value={nameInput}
            disabled={submitting}
            onChange={(event) => onNameInputChange(event.target.value)}
            className="h-11 bg-background select-text"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="create-topic-description">Description（可选）</Label>
          <Textarea
            id="create-topic-description"
            name="topic-description"
            rows={3}
            value={descriptionInput}
            disabled={submitting}
            onChange={(event) => onDescriptionInputChange(event.target.value)}
            className="min-h-22 resize-none bg-background select-text"
          />
          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
            留空表示没有额外上下文；填写后会发给这条 Topic 绑定的 Bot，不是私密备忘。
          </p>
        </div>

        {registeredAgents.length > 1 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-topic-bot-select">绑定 Bot</Label>
            <Select
              value={selectedBotId}
              disabled={busy}
              onValueChange={onSelectedBotIdChange}
            >
              <SelectTrigger
                id="create-topic-bot-select"
                aria-label="绑定 Bot"
                className="h-11 bg-background"
              >
                <SelectValue placeholder="请选择 Bot" />
              </SelectTrigger>
              <SelectContent className="z-[60]">
                {registeredAgents.map((bot) => (
                  <SelectItem key={bot.userId} value={bot.userId}>
                    {resolveBotName(bot.userId, registeredAgents, roomList)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {!quickRegisterOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit justify-start px-2 text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={onOpenQuickRegister}
          >
            <Plus className="size-4" aria-hidden="true" />
            登记新 Bot
          </Button>
        ) : (
          <section
            aria-label="登记新 Bot"
            className="space-y-3 rounded-xl border border-border bg-muted/40 p-4"
          >
            <h3 className="m-0 text-sm font-semibold text-foreground">
              登记新 Bot
            </h3>
            <div className="flex flex-col gap-2">
              <Label htmlFor="quick-bot-user-id">Matrix 用户 ID</Label>
              <Input
                id="quick-bot-user-id"
                name="quick-bot-user-id"
                placeholder="@agent:example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={quickUserId}
                disabled={quickSubmitting}
                onChange={(event) => onQuickUserIdChange(event.target.value)}
                onKeyDown={onQuickRegisterKeyDown}
                className="h-11 bg-background select-text"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="quick-bot-name">手写名字（可选）</Label>
              <Input
                id="quick-bot-name"
                name="quick-bot-name"
                value={quickHandwrittenName}
                disabled={quickSubmitting}
                onChange={(event) =>
                  onQuickHandwrittenNameChange(event.target.value)
                }
                onKeyDown={onQuickRegisterKeyDown}
                className="h-11 bg-background select-text"
              />
            </div>
            {quickError ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertDescription>{quickError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={busy}
                onClick={onCloseQuickRegister}
              >
                取消登记
              </Button>
              <Button
                type="button"
                className="min-h-11 sm:min-h-9"
                disabled={busy}
                onClick={onQuickRegister}
              >
                {quickSubmitting ? "正在保存…" : "登记 Bot"}
              </Button>
            </div>
          </section>
        )}

        {formError ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={busy}
            onClick={onCloseCreateForm}
          >
            取消
          </Button>
          <Button
            type="submit"
            className="min-h-11 sm:min-h-9"
            disabled={busy || reauthRequired}
          >
            {submitting ? "正在创建…" : "创建 Topic"}
          </Button>
        </div>
      </form>
    </ResponsiveFormShell>
  );
}
