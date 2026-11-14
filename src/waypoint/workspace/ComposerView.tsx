import type { FormEvent, KeyboardEvent, RefObject } from "react";
import type { ViewportMode } from "../../adapters/types";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "../icons";
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

  return (
    <div className="waypoint-composer-safe-area" data-keyboard-inset={safeInset}>
      {showScrollBottomFab && safeInset === 0 && !composerMultiline ? (
        <button
          type="button"
          aria-label="回到底部"
          className="waypoint-scroll-bottom-fab"
          onClick={onScrollToBottom}
        >
          <ArrowDownIcon aria-hidden="true" size={18} />
        </button>
      ) : null}
      {composerError ? <p role="alert">{composerError}</p> : null}
      {hasDraftAttachment ? (
        <div
          role="region"
          aria-label="已选附件"
          className="waypoint-draft-attachment"
        >
          <span className="waypoint-draft-attachment-name">
            {draftAttachmentName}
          </span>
          <button
            type="button"
            disabled={inputDisabled}
            onClick={onRemoveAttachment}
          >
            移除附件
          </button>
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
          className="waypoint-slash-hints"
        >
          <ul className="waypoint-slash-hint-list">
            {SLASH_COMMAND_HINTS.map((command) => (
              <li key={command}>
                <button
                  type="button"
                  className="waypoint-slash-hint-button"
                  onClick={() => onSelectSlashCommand(command)}
                >
                  {command}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        ref={composerFormRef}
        className={`waypoint-composer${composerMultiline ? " multiline" : ""}`}
        onSubmit={onSendMessage}
      >
        <label className="waypoint-attach-button">
          <PlusIcon aria-hidden="true" size={16} />
          <span className="waypoint-attach-button-text">附件</span>
          <input
            type="file"
            multiple
            aria-label="选择附件"
            className="waypoint-sr-only"
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
        <button
          type="submit"
          aria-label="发送"
          className="waypoint-send-button"
          disabled={inputDisabled}
          data-active={Boolean(draftText.trim() || hasDraftAttachment)}
        >
          <ArrowUpIcon aria-hidden="true" size={16} />
          <span className="waypoint-sr-only">发送</span>
        </button>
      </form>
    </div>
  );
}
