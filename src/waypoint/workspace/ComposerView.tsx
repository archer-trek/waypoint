import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  canScrollVerticallyInDirection,
  installTouchScrollBoundaryLock,
  isViewportKeyboardConstrained,
} from "@/lib/viewport-lock";
import {
  ArrowUp,
  Camera,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Plus,
  X,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ViewportMode } from "../../adapters/types";
import { MediaKindIcon } from "./MediaKindIcon";
import { extractFileExtensionLabel, formatFileSize } from "./media-presentation";
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
  draftAttachmentMimeType?: string;
  draftAttachmentSize?: number;
  draftAttachmentImageUrl?: string;
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

/** Bottom composer area with scroll-to-bottom FAB, unified attachment tray, slash hints, and capsule input. */
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
  draftAttachmentMimeType,
  draftAttachmentSize,
  draftAttachmentImageUrl,
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
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const safeAreaRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
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

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    onPickedFiles(files);
  }

  const displayName = draftAttachmentName ?? "附件";
  const isImageDraft = Boolean(
    draftAttachmentMimeType?.startsWith("image/") && draftAttachmentImageUrl,
  );
  const extLabel = extractFileExtensionLabel(displayName, draftAttachmentMimeType);
  const sizeLabel = formatFileSize(draftAttachmentSize);

  const attachButtonClassName = cn(
    "waypoint-attach-button touch-none absolute z-1 m-0 inline-flex items-center justify-center p-0 border-0 rounded-full bg-muted/80 text-muted-foreground cursor-pointer shrink-0 transition-colors hover:bg-muted hover:text-foreground",
    isNarrowMode
      ? "bottom-[9px] left-2 size-8 min-w-8 min-h-8 after:absolute after:-inset-1.5 after:content-[''] active:scale-92"
      : "bottom-[7px] left-2 size-8 min-w-8",
    inputDisabled && "opacity-50 cursor-not-allowed",
  );

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

        <div
          className={cn(
            "waypoint-composer-shell min-w-0",
            hasDraftAttachment &&
              "rounded-[18px] border border-border/90 bg-background dark:bg-card/75 shadow-xs dark:shadow-none transition-colors focus-within:border-muted-foreground/45",
          )}
        >
          {hasDraftAttachment ? (
            <div
              role="region"
              aria-label="已选附件"
              className="waypoint-draft-attachment touch-none flex items-center px-3 pt-2.5 pb-1"
            >
              {isImageDraft ? (
                <div className="waypoint-draft-image-card relative inline-flex size-14 shrink-0 rounded-xl border border-border/75 overflow-hidden bg-secondary">
                  <img
                    src={draftAttachmentImageUrl}
                    alt={displayName}
                    className="block size-full object-cover"
                  />
                  <span className="waypoint-draft-attachment-name sr-only">
                    {displayName}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="移除附件"
                    className="waypoint-draft-attachment-remove absolute top-1 right-1 size-5 min-w-5 min-h-5 rounded-full p-0 bg-background/90 text-foreground border border-border/80 shadow-xs hover:bg-background after:absolute after:-inset-2 after:content-['']"
                    disabled={inputDisabled}
                    onClick={onRemoveAttachment}
                  >
                    <X aria-hidden="true" strokeWidth={2.4} className="size-3" />
                  </Button>
                </div>
              ) : (
                <div className="waypoint-draft-file-card inline-flex items-center gap-2.5 min-w-0 max-w-full sm:max-w-[280px] pl-2 pr-1.5 py-1.5 rounded-xl border border-border/80 bg-secondary/75">
                  <span className="size-8 rounded-lg border border-border/70 bg-background flex items-center justify-center shrink-0 text-foreground">
                    <MediaKindIcon
                      filename={displayName}
                      mimeType={draftAttachmentMimeType}
                      className="size-4"
                    />
                  </span>
                  <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                    <span className="waypoint-draft-attachment-name block min-w-0 truncate text-[13px] font-medium leading-snug text-foreground">
                      {displayName}
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] font-mono leading-snug text-muted-foreground">
                      <span>{extLabel}</span>
                      {sizeLabel ? <span>· {sizeLabel}</span> : null}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="移除附件"
                    className="waypoint-draft-attachment-remove relative size-7 min-w-7 min-h-7 rounded-full p-0 text-muted-foreground hover:text-foreground hover:bg-background/70 shrink-0 after:absolute after:-inset-1.5 after:content-['']"
                    disabled={inputDisabled}
                    onClick={onRemoveAttachment}
                  >
                    <X aria-hidden="true" strokeWidth={2.1} className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          <form
            ref={composerFormRef}
            className={cn(
              "waypoint-composer relative box-border",
              hasDraftAttachment
                ? "border-0 bg-transparent shadow-none"
                : "border border-border/90 bg-background dark:bg-card/75 shadow-xs dark:shadow-none transition-[border-color,border-radius] focus-within:border-muted-foreground/45",
              composerTextareaScrollable ? "touch-pan-y" : "touch-none",
              composerMultiline
                ? cn(
                    "multiline block",
                    hasDraftAttachment ? "rounded-b-[18px]" : "rounded-[18px]",
                    isNarrowMode
                      ? hasDraftAttachment
                        ? "min-h-[48px] pt-1.5 px-4 pb-[48px]"
                        : "min-h-[50px] pt-3 px-4 pb-[48px]"
                      : hasDraftAttachment
                        ? "min-h-[44px] pt-1.5 px-4 pb-[44px]"
                        : "min-h-[46px] pt-2.5 px-4 pb-[44px]",
                  )
                : cn(
                    "flex items-center px-[48px]",
                    hasDraftAttachment ? "rounded-b-[18px]" : "rounded-[23px]",
                    isNarrowMode
                      ? hasDraftAttachment
                        ? "min-h-[48px] py-1.5"
                        : "min-h-[50px] py-2"
                      : hasDraftAttachment
                        ? "min-h-[44px] py-1.5"
                        : "min-h-[46px] py-1.5",
                  ),
            )}
            onSubmit={onSendMessage}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              aria-label="选择附件"
              className="waypoint-sr-only sr-only"
              disabled={inputDisabled}
              onChange={handleFileInputChange}
            />
            {isNarrowMode ? (
              <>
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  aria-label="拍照"
                  className="waypoint-sr-only sr-only"
                  disabled={inputDisabled}
                  onChange={handleFileInputChange}
                />
                <input
                  ref={galleryInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  aria-label="从图库选择"
                  className="waypoint-sr-only sr-only"
                  disabled={inputDisabled}
                  onChange={handleFileInputChange}
                />
                <DropdownMenu
                  modal={false}
                  open={attachMenuOpen && !inputDisabled}
                  onOpenChange={(nextOpen) => {
                    if (inputDisabled) return;
                    setAttachMenuOpen(nextOpen);
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="添加附件"
                      disabled={inputDisabled}
                      className={attachButtonClassName}
                    >
                      <Plus aria-hidden="true" strokeWidth={1.9} className="size-[18px]" />
                      <span className="waypoint-attach-button-text hidden">附件</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="top"
                    align="start"
                    sideOffset={10}
                    aria-labelledby={undefined}
                    aria-label="选择附件方式"
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    className="w-44 rounded-xl border-border/90 bg-popover/95 p-1.5 shadow-lg backdrop-blur-md"
                  >
                    <DropdownMenuItem
                      className="min-h-11 gap-2.5 rounded-lg px-3 text-[15px] font-medium"
                      onSelect={() => cameraInputRef.current?.click()}
                    >
                      <Camera
                        aria-hidden="true"
                        strokeWidth={1.85}
                        className="size-4 text-muted-foreground"
                      />
                      <span>拍照</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="min-h-11 gap-2.5 rounded-lg px-3 text-[15px] font-medium"
                      onSelect={() => galleryInputRef.current?.click()}
                    >
                      <ImageIcon
                        aria-hidden="true"
                        strokeWidth={1.85}
                        className="size-4 text-muted-foreground"
                      />
                      <span>从图库选择</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="min-h-11 gap-2.5 rounded-lg px-3 text-[15px] font-medium"
                      onSelect={() => fileInputRef.current?.click()}
                    >
                      <FileText
                        aria-hidden="true"
                        strokeWidth={1.85}
                        className="size-4 text-muted-foreground"
                      />
                      <span>选择文件</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <button
                type="button"
                aria-label="添加附件"
                disabled={inputDisabled}
                className={attachButtonClassName}
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus aria-hidden="true" strokeWidth={1.9} className="size-[18px]" />
                <span className="waypoint-attach-button-text hidden">附件</span>
              </button>
            )}

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
    </div>
  );
}
