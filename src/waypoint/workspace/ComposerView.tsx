import { useEffect, useRef, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import {
  canScrollVerticallyInDirection,
  installTouchScrollBoundaryLock,
  isViewportKeyboardConstrained,
} from "@/lib/viewport-lock";
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
  composerTextareaScrollable?: boolean;
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
  onBlurTextarea?: () => void;
  onDraftTextChange: (text: string) => void;
  extractDataTransferFiles: (transfer: DataTransfer | null | undefined) => File[];
};

/** Bottom composer area with scroll-to-bottom FAB, attachment strip, slash hints, and capsule input. */
export function ComposerView({
  safeInset,
  showScrollBottomFab,
  composerMultiline,
  composerTextareaScrollable = false,
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
  onBlurTextarea,
  onDraftTextChange,
  extractDataTransferFiles,
}: ComposerViewProps) {
  const inputDisabled = persistingSend || activeTopicUnavailable || reauthRequired;
  const isSendActive = Boolean(draftText.trim() || hasDraftAttachment);
  const isNarrowMode = viewportMode === "narrow";
  const safeAreaRef = useRef<HTMLDivElement | null>(null);
  const safeInsetRef = useRef(safeInset);
  useEffect(() => {
    safeInsetRef.current = safeInset;
  }, [safeInset]);

  useEffect(() => {
    const safeAreaEl = safeAreaRef.current;
    if (!safeAreaEl) return;
    return installTouchScrollBoundaryLock(safeAreaEl, {
      isLocked: () => isViewportKeyboardConstrained(safeInsetRef.current),
      onlyVertical: false,
      shouldIgnoreHorizontalEdge: (startX, dx, dy) =>
        startX <= 24 && Math.abs(dx) > Math.abs(dy),
      allowVerticalScroll: (target, dy) => {
        const textarea = composerTextareaRef.current;
        if (!textarea || !(target instanceof Node) || !textarea.contains(target)) {
          return false;
        }
        return canScrollVerticallyInDirection(textarea, textarea, dy);
      },
    });
  }, [composerTextareaRef]);

  return (
    <div
      ref={safeAreaRef}
      className={cn(
        "waypoint-composer-safe-area relative shrink-0 px-3 sm:px-6 pt-1.5 bg-transparent border-t-0 pointer-events-none box-border transition-[padding-bottom] duration-280 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        composerTextareaScrollable ? "touch-pan-y" : "touch-none",
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
          className="waypoint-scroll-bottom-fab pointer-events-auto touch-none absolute bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 z-25 size-8 rounded-full border-border/80 bg-background/90 backdrop-blur-md text-foreground shadow-sm hover:bg-accent hover:-translate-y-0.5 transition-transform"
          onClick={onScrollToBottom}
        >
          <ChevronDown aria-hidden="true" className="size-4" />
        </Button>
      ) : null}
      <div className="waypoint-composer-track mx-auto w-full min-w-0 max-w-3xl pointer-events-none [&>*]:pointer-events-auto">
      {composerError ? (
        <Alert variant="destructive" className="mb-2 py-2 px-3">
          <AlertDescription>{composerError}</AlertDescription>
        </Alert>
      ) : null}
      {hasDraftAttachment ? (
        <div
          role="region"
          aria-label="已选附件"
          className="waypoint-draft-attachment touch-none flex items-center justify-between gap-3 px-3 py-1.5 mb-2 rounded-xl border border-border/80 bg-card/90 backdrop-blur-sm text-[13px]"
        >
          <span className="waypoint-draft-attachment-name min-w-0 truncate text-foreground">
            {draftAttachmentName}
          </span>
          <Button
            type="button"
            variant="ghost"
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
          className="waypoint-slash-hints touch-none relative px-3 py-2 mb-2 rounded-xl border border-border/80 bg-card/95 backdrop-blur-sm shadow-xs"
        >
          <ul className="waypoint-slash-hint-list flex flex-wrap gap-1.5 list-none m-0 p-0">
            {SLASH_COMMAND_HINTS.map((command) => (
              <li key={command}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="waypoint-slash-hint-button h-7 px-2.5 font-mono text-[13px] border border-border/80 hover:bg-accent hover:text-accent-foreground"
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
          "waypoint-composer relative border border-border/90 bg-background dark:bg-card/75 shadow-xs dark:shadow-none box-border transition-[border-color,border-radius] focus-within:border-muted-foreground/45",
          composerTextareaScrollable ? "touch-pan-y" : "touch-none",
          composerMultiline
            ? cn(
                "multiline block rounded-[18px]",
                isNarrowMode
                  ? "min-h-[50px] pt-3 px-4 pb-[48px]"
                  : "min-h-[46px] pt-2.5 px-4 pb-[44px]",
              )
            : cn(
                "flex items-center rounded-[23px] px-[48px]",
                isNarrowMode
                  ? "min-h-[50px] py-2"
                  : "min-h-[46px] py-1.5",
              ),
        )}
        onSubmit={onSendMessage}
      >
        <label
          className={cn(
            "waypoint-attach-button touch-none absolute z-1 m-0 inline-flex items-center justify-center p-0 border-0 rounded-full bg-muted/80 text-muted-foreground cursor-pointer shrink-0 transition-colors hover:bg-muted hover:text-foreground",
            isNarrowMode
              ? "bottom-[9px] left-2 size-8 min-w-8 min-h-8 after:absolute after:-inset-1.5 after:content-[''] active:scale-92"
              : "bottom-[7px] left-2 size-8 min-w-8",
            inputDisabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <Plus aria-hidden="true" strokeWidth={1.9} className="size-[18px]" />
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
          className={cn(
            "block w-full m-0 py-0.5 px-0 border-0 outline-none shadow-none ring-0 focus-visible:ring-0 bg-transparent font-sans text-[16px] leading-[1.45] text-foreground caret-foreground min-h-[1.45em] max-h-[calc(1.45em*4)] resize-none overflow-y-auto overscroll-contain box-border [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden disabled:opacity-60 disabled:cursor-not-allowed",
            composerTextareaScrollable ? "touch-pan-y" : "touch-none",
          )}
          onFocus={onFocusTextarea}
          onBlur={() => onBlurTextarea?.()}
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
            "waypoint-send-button touch-none absolute z-1 m-0 p-0 border-0 rounded-full shrink-0 transition-colors",
            isNarrowMode
              ? "bottom-[9px] right-2 size-8 min-w-8 min-h-8 after:absolute after:-inset-1.5 after:content-[''] active:scale-92"
              : "bottom-[7px] right-2 size-8 min-w-8",
            isSendActive
              ? "bg-primary text-primary-foreground shadow-xs hover:opacity-90"
              : "bg-muted/80 text-muted-foreground/65 hover:bg-muted hover:text-muted-foreground",
          )}
          disabled={inputDisabled}
          data-active={isSendActive}
        >
          <ArrowUp aria-hidden="true" strokeWidth={2} className="size-4" />
          <span className="waypoint-sr-only sr-only">发送</span>
        </Button>
      </form>
      </div>
    </div>
  );
}
