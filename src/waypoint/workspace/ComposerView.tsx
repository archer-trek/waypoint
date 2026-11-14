import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { ArrowUp, ChevronDown, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ViewportMode } from "../../adapters/types";
import { SLASH_COMMAND_HINTS } from "./types";

export type ComposerViewProps = {
  safeInset: number;
  showScrollBottomFab: boolean;
  composerMultiline: boolean;
  composerError?: string;
  activeTopicUnavailable: boolean;
  reauthRequired: boolean;
  persistingSend: boolean;
  draftAttachmentName?: string;
  hasDraftAttachment: boolean;
  draftText: string;
  composerFormRef: RefObject<HTMLFormElement | null>;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  viewportMode: ViewportMode;
  supportsFileDropAndPaste: boolean;
  onScrollToBottom: () => void;
  onRemoveAttachment: () => void;
  onSelectSlashCommand: (command: string) => void;
  onSendMessage: (
    event: FormEvent | KeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  onPickedFiles: (files: File[]) => void;
  onFocusTextarea: () => void;
  onDraftTextChange: (text: string) => void;
  extractDataTransferFiles: (transfer: DataTransfer | null | undefined) => File[];
};

/** Bottom composer area with scroll-to-bottom FAB, attachment strip, slash hints, and capsule input. */
export function ComposerView({
  safeInset,
  showScrollBottomFab,
  composerMultiline,
  composerError,
  activeTopicUnavailable,
  reauthRequired,
  persistingSend,
  draftAttachmentName,
  hasDraftAttachment,
  draftText,
  composerFormRef,
  composerTextareaRef,
  viewportMode,
  supportsFileDropAndPaste,
  onScrollToBottom,
  onRemoveAttachment,
  onSelectSlashCommand,
  onSendMessage,
  onPickedFiles,
  onFocusTextarea,
  onDraftTextChange,
  extractDataTransferFiles,
}: ComposerViewProps) {
  const inputDisabled = persistingSend || activeTopicUnavailable || reauthRequired;
  const isSendActive = Boolean(draftText.trim() || hasDraftAttachment);

  return (
    <div
      className={cn(
        "waypoint-composer-safe-area relative shrink-0 px-3 pt-1.5 bg-transparent border-t-0 pointer-events-none box-border [&>*]:pointer-events-auto",
        safeInset === 0
          ? "pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]"
          : "pb-1.5",
      )}
      data-keyboard-inset={safeInset}
    >
      {showScrollBottomFab && safeInset === 0 && !composerMultiline ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="回到底部"
          className="waypoint-scroll-bottom-fab absolute bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 z-25 size-9 rounded-full border-border bg-card text-foreground shadow-md hover:bg-accent hover:-translate-y-0.5 transition-transform"
          onClick={onScrollToBottom}
        >
          <ChevronDown aria-hidden="true" className="size-4.5" />
        </Button>
      ) : null}
      {composerError ? (
        <Alert variant="destructive" className="mb-2 py-2 px-3">
          <AlertDescription>{composerError}</AlertDescription>
        </Alert>
      ) : null}
      {hasDraftAttachment ? (
        <div
          role="region"
          aria-label="已选附件"
          className="waypoint-draft-attachment flex items-center justify-between gap-3 px-3 py-1.5 mb-2 rounded-lg border border-border bg-secondary text-[0.8125rem]"
        >
          <span className="waypoint-draft-attachment-name min-w-0 truncate text-foreground">
            {draftAttachmentName}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
            disabled={inputDisabled}
            onClick={onRemoveAttachment}
          >
            移除附件
          </Button>
        </div>
      ) : null}
      {!activeTopicUnavailable &&
      !reauthRequired &&
      !persistingSend &&
      !hasDraftAttachment &&
      draftText === "/" ? (
        <div
          role="region"
          aria-label="斜杠命令提示"
          className="waypoint-slash-hints relative px-3 py-2 mb-2 rounded-lg border border-border bg-card shadow-sm"
        >
          <ul className="waypoint-slash-hint-list flex flex-wrap gap-1.5 list-none m-0 p-0">
            {SLASH_COMMAND_HINTS.map((command) => (
              <li key={command}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="waypoint-slash-hint-button h-7 px-2 font-mono text-[0.8125rem] border border-border hover:bg-accent hover:text-accent-foreground"
                  onClick={() => onSelectSlashCommand(command)}
                >
                  {command}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        ref={composerFormRef}
        className={cn(
          "waypoint-composer relative block border border-border bg-card shadow-lg box-border transition-shadow focus-within:shadow-xl",
          viewportMode === "narrow"
            ? "min-h-[52px] rounded-[26px]"
            : "min-h-12 rounded-[24px]",
          composerMultiline
            ? viewportMode === "narrow"
              ? "multiline pt-3 px-4 pb-[52px]"
              : "multiline pt-3 px-4 pb-12"
            : viewportMode === "narrow"
              ? "py-2.5 px-14"
              : "py-2 px-[52px]",
        )}
        onSubmit={onSendMessage}
      >
        <label
          className={cn(
            "waypoint-attach-button absolute z-1 m-0 inline-flex items-center justify-center p-0 border border-border rounded-full bg-secondary text-muted-foreground cursor-pointer shrink-0 transition-colors hover:bg-card hover:text-foreground",
            viewportMode === "narrow"
              ? "bottom-2 left-2 size-9 min-w-9 min-h-9 after:absolute after:-inset-1 after:content-[''] active:scale-92"
              : "bottom-2 left-2 size-8 min-w-8",
            inputDisabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <Plus aria-hidden="true" className="size-4" />
          <span className="waypoint-attach-button-text hidden">附件</span>
          <input
            type="file"
            multiple
            aria-label="选择附件"
            className="waypoint-sr-only sr-only"
            disabled={inputDisabled}
            onChange={(event) => {
              const files = event.target.files
                ? Array.from(event.target.files)
                : [];
              event.target.value = "";
              onPickedFiles(files);
            }}
          />
        </label>
        <textarea
          ref={composerTextareaRef}
          aria-label="输入消息"
          name="message"
          rows={1}
          disabled={inputDisabled}
          value={draftText}
          className="block w-full m-0 py-0.5 px-0 border-0 outline-none shadow-none ring-0 focus-visible:ring-0 bg-transparent font-sans text-[17px] leading-[1.45] text-foreground caret-foreground min-h-[1.45em] max-h-[calc(1.45em*4)] resize-none overflow-y-auto box-border [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden disabled:opacity-60 disabled:cursor-not-allowed"
          onFocus={onFocusTextarea}
          onChange={(event) => onDraftTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              viewportMode !== "narrow"
            ) {
              event.preventDefault();
              onSendMessage(event);
            }
          }}
          onPaste={(event) => {
            if (!supportsFileDropAndPaste) {
              return;
            }
            const files = extractDataTransferFiles(event.clipboardData);
            if (files.length === 0) {
              return;
            }
            event.preventDefault();
            if (inputDisabled) {
              return;
            }
            onPickedFiles(files);
          }}
        />
        <Button
          type="submit"
          variant={isSendActive ? "default" : "secondary"}
          size="icon"
          aria-label="发送"
          className={cn(
            "waypoint-send-button absolute z-1 m-0 p-0 border-0 rounded-full shrink-0 transition-all",
            viewportMode === "narrow"
              ? "bottom-2 right-2 size-9 min-w-9 min-h-9 after:absolute after:-inset-1 after:content-[''] active:scale-92"
              : "bottom-2 right-2 size-8 min-w-8",
            isSendActive
              ? "bg-primary text-primary-foreground shadow-xs hover:opacity-90"
              : "bg-secondary text-muted-foreground hover:bg-secondary/80",
          )}
          disabled={inputDisabled}
          data-active={isSendActive}
        >
          <ArrowUp aria-hidden="true" className="size-4" />
          <span className="waypoint-sr-only sr-only">发送</span>
        </Button>
      </form>
    </div>
  );
}
