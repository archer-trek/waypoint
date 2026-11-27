import { useEffect, useEffectEvent, useState, useRef, type RefObject } from "react";
import {
  canScrollVerticallyInDirection,
  installTouchScrollBoundaryLock,
  isViewportKeyboardConstrained,
} from "@/lib/viewport-lock";
import { copyToClipboard } from "@/lib/utils";
import { Bookmark, Code2, Copy, FileText, MoreHorizontal, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ActionSheet,
  ActionSheetCard,
  ActionSheetContent,
  ActionSheetItem,
  ActionSheetCancel,
} from "@/components/ui/action-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MessageBody } from "../MessageBody";
import type { TimelineItem, TimelineMedia } from "../topics";
import { RespondingIndicator } from "./RespondingIndicator";

export type TimelineViewProps = {
  timelineRef: RefObject<HTMLDivElement | null>;
  items: TimelineItem[];
  responding?: boolean;
  activeTopicUnavailable: boolean;
  reauthRequired: boolean;
  openFailedMenuId: string | null;
  isNarrow?: boolean;
  safeInset?: number;
  getLocalImageUrl: (attachmentId: string) => string | undefined;
  getDownloadedImageUrl: (mxcUrl: string) => string | undefined;
  onScroll: () => void;
  onToggleFailedMenu: (localId: string) => void;
  onOpenFailedMenu: (localId: string) => void;
  onResendFailed: (localId: string) => void;
  onDiscardFailed: (localId: string) => void;
  onOpenMedia: (media: TimelineMedia) => void;
  onOpenExternalUrl: (url: string) => void;
  favoritedEventIds?: ReadonlySet<string>;
  favoritePendingEventIds?: ReadonlySet<string>;
  highlightedEventId?: string | null;
  onSelectPromptOption: (eventId: string, optionKey: string) => void;
  onToggleFavorite?: (item: Extract<TimelineItem, { kind: "message" }>) => void;
  onRequestDeleteMessage?: (item: Extract<TimelineItem, { kind: "message" }>) => void;
  onCopyFeedback?: (message: string) => void;
  onContextMenuOpenChange?: (open: boolean) => void;
  onRegisterContextMenuDismiss?: (dismiss: (() => void) | null) => void;
};

const BLOCK_TAG_NAMES = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "tr",
]);

function extractPlainTextFromBubble(bubbleEl: HTMLElement | null): string {
  if (!bubbleEl) return "";

  const parts: string[] = [];

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (
      tag === "button" ||
      tag === "script" ||
      tag === "style" ||
      el.getAttribute("aria-hidden") === "true" ||
      el.getAttribute("data-streamdown") === "code-block-header" ||
      el.getAttribute("data-streamdown") === "code-block-actions"
    ) {
      return;
    }
    if (tag === "br") {
      parts.push("\n");
      return;
    }
    const isBlock = BLOCK_TAG_NAMES.has(tag);
    if (isBlock && parts.length > 0 && !parts[parts.length - 1]!.endsWith("\n")) {
      parts.push("\n");
    }
    const isCell = tag === "td" || tag === "th";
    const beforeLen = parts.length;
    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
    if (isCell && parts.length > beforeLen) {
      const nextSibling = el.nextElementSibling;
      if (nextSibling && (nextSibling.tagName.toLowerCase() === "td" || nextSibling.tagName.toLowerCase() === "th")) {
        parts.push("\t");
      }
    }
    if (isBlock && parts.length > beforeLen && !parts[parts.length - 1]!.endsWith("\n")) {
      parts.push("\n");
    }
  }

  walk(bubbleEl);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractCodeSnippet(target: HTMLElement | null): string | undefined {
  if (!target) return undefined;
  if (
    target.closest('[data-streamdown="code-block-header"]') ||
    target.closest('[data-streamdown="code-block-actions"]')
  ) {
    return undefined;
  }
  const codeBody = target.closest(
    '[data-streamdown="code-block"] [data-streamdown="code-block-body"]',
  );
  if (codeBody) {
    const codeEl = codeBody.querySelector("pre > code") ?? codeBody.querySelector("code");
    return codeEl?.textContent ?? undefined;
  }
  const preEl = target.closest("pre");
  if (preEl && !preEl.closest('[data-streamdown="code-block-header"]')) {
    const codeEl = preEl.querySelector(":scope > code") ?? preEl;
    return codeEl.textContent ?? undefined;
  }
  return undefined;
}

function extractCopyableMarkdown(
  item: Extract<TimelineItem, { kind: "message" }>,
): string {
  if (item.media) {
    return item.media.caption?.trim() ? item.media.caption : "";
  }
  return item.body.trim() ? item.body : "";
}

type MessageMenuPayload = {
  item: Extract<TimelineItem, { kind: "message" }>;
  plainText: string;
  markdownText: string;
  codeSnippet?: string;
};

/** Scrollable timeline log rendering day separators, message bubbles, media, reactions, and prompts. */
export function TimelineView({
  timelineRef,
  items,
  responding = false,
  activeTopicUnavailable,
  reauthRequired,
  openFailedMenuId,
  isNarrow,
  safeInset = 0,
  getLocalImageUrl,
  getDownloadedImageUrl,
  onScroll,
  onToggleFailedMenu,
  onOpenFailedMenu,
  onResendFailed,
  onDiscardFailed,
  onOpenMedia,
  favoritedEventIds,
  favoritePendingEventIds,
  highlightedEventId,
  onOpenExternalUrl,
  onSelectPromptOption,
  onToggleFavorite,
  onRequestDeleteMessage,
  onCopyFeedback,
  onContextMenuOpenChange,
  onRegisterContextMenuDismiss,
}: TimelineViewProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const safeInsetRef = useRef(safeInset);
  useEffect(() => {
    safeInsetRef.current = safeInset;
  }, [safeInset]);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    return installTouchScrollBoundaryLock(el, {
      isLocked: () => isViewportKeyboardConstrained(safeInsetRef.current),
      onlyVertical: true,
      shouldIgnoreHorizontalEdge: (startX, dx, dy) =>
        startX <= 24 && Math.abs(dx) > Math.abs(dy),
      allowVerticalScroll: (target, dy) =>
        canScrollVerticallyInDirection(target, el, dy),
    });
  }, [timelineRef]);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const [contextMenuItem, setContextMenuItem] = useState<MessageMenuPayload | null>(null);
  const [desktopMenuState, setDesktopMenuState] = useState<MessageMenuPayload | null>(null);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const notifyContextMenuOpen = useEffectEvent((open: boolean) => {
    onContextMenuOpenChange?.(open);
  });
  const registerContextMenuDismiss = useEffectEvent((dismiss: (() => void) | null) => {
    onRegisterContextMenuDismiss?.(dismiss);
  });

  useEffect(() => {
    registerContextMenuDismiss(() => {
      setContextMenuItem(null);
      setDesktopMenuState(null);
    });
    return () => {
      registerContextMenuDismiss(null);
      notifyContextMenuOpen(false);
    };
  }, []);

  useEffect(() => {
    notifyContextMenuOpen(contextMenuItem !== null || desktopMenuState !== null);
  }, [contextMenuItem, desktopMenuState]);

  function buildMenuPayload(
    item: Extract<TimelineItem, { kind: "message" }>,
    bubbleEl: HTMLElement | null,
    targetEl: HTMLElement | null,
  ): MessageMenuPayload {
    const markdownText = extractCopyableMarkdown(item);
    const plainText = markdownText
      ? extractPlainTextFromBubble(bubbleEl) || markdownText
      : "";
    const codeSnippet = markdownText ? extractCodeSnippet(targetEl) : undefined;
    return { item, plainText, markdownText, codeSnippet };
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>, item: TimelineItem) {
    if (isNarrow === false || e.touches.length !== 1 || item.kind !== "message") return;
    const markdownText = extractCopyableMarkdown(item);
    const isConfirmed = item.status === "confirmed" && Boolean(item.eventId);
    if (!markdownText && !isConfirmed) return;

    const touch = e.touches[0]!;
    const bubbleEl = e.currentTarget;
    const targetEl = e.target as HTMLElement | null;
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    const codeSnippet = markdownText ? extractCodeSnippet(targetEl) : undefined;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      touchStartPosRef.current = null;
      window.getSelection()?.removeAllRanges();
      const plainText = markdownText
        ? extractPlainTextFromBubble(bubbleEl) || markdownText
        : "";
      setContextMenuItem({ item, plainText, markdownText, codeSnippet });
    }, 500);
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!touchStartPosRef.current || !longPressTimerRef.current) return;
    const touch = e.touches[0]!;
    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
    if (dx > 10 || dy > 10) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      touchStartPosRef.current = null;
    }
  }

  function handleTouchEnd() {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchStartPosRef.current = null;
  }

  function handleDesktopMenuOpenChange(
    item: Extract<TimelineItem, { kind: "message" }>,
    nextOpen: boolean,
  ) {
    if (!nextOpen) {
      setDesktopMenuState(null);
      return;
    }
    if (!item.eventId) {
      return;
    }
    const rowEl = document.querySelector<HTMLElement>(
      `[data-event-id="${CSS.escape(item.eventId)}"]`,
    );
    const bubbleEl = rowEl?.querySelector<HTMLElement>(".waypoint-bubble") ?? null;
    setDesktopMenuState(buildMenuPayload(item, bubbleEl, null));
  }

  function performCopy(text: string) {
    setContextMenuItem(null);
    setDesktopMenuState(null);
    void copyToClipboard(text).then((ok) => {
      if (ok) {
        onCopyFeedback?.("已复制");
      }
    });
  }

  return (
    <div
      ref={timelineRef}
      role="log"
      aria-label="对话时间线"
      className="waypoint-timeline relative flex-1 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 flex flex-col"
      onScroll={onScroll}
    >
      <div className="waypoint-timeline-track mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
        {items.map((item) =>
        item.kind === "day-separator" ? (
          <div
            key={item.key}
            role="separator"
            aria-label={item.label}
            className="waypoint-day-separator self-center text-center text-xs font-medium text-muted-foreground my-4 px-3 py-1 bg-transparent border-0 rounded-full"
          >
            {item.label}
          </div>
        ) : (() => {
          const isConfirmed = item.status === "confirmed" && Boolean(item.eventId);
          const isFavorited = Boolean(
            isConfirmed && item.eventId && favoritedEventIds?.has(item.eventId),
          );
          const isFavoritePending = Boolean(
            isConfirmed && item.eventId && favoritePendingEventIds?.has(item.eventId),
          );
          const isHighlighted = Boolean(
            isConfirmed && item.eventId && highlightedEventId === item.eventId,
          );
          const desktopMenuOpen = Boolean(
            isNarrow === false &&
              isConfirmed &&
              desktopMenuState?.item.eventId === item.eventId,
          );
          const showDesktopMenu =
            isNarrow === false &&
            isConfirmed &&
            Boolean(item.eventId) &&
            (hoveredEventId === item.eventId || desktopMenuOpen);
          const activeDesktopPayload = desktopMenuOpen ? desktopMenuState : null;
          const desktopMenu =
            showDesktopMenu ? (
              <DropdownMenu
                modal={false}
                open={desktopMenuOpen}
                onOpenChange={(nextOpen) => handleDesktopMenuOpenChange(item, nextOpen)}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="消息操作"
                    className={cn(
                      "waypoint-message-menu-trigger size-7 min-w-7 rounded-full p-0 text-muted-foreground hover:text-foreground hover:bg-accent/70 shrink-0",
                      item.side === "left"
                        ? "absolute top-0.5 right-0 bg-background/85 backdrop-blur-xs"
                        : "self-center",
                    )}
                  >
                    <MoreHorizontal aria-hidden="true" className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  aria-labelledby={undefined}
                  aria-label="消息操作"
                  side="bottom"
                  align={item.side === "right" ? "end" : "start"}
                  sideOffset={4}
                  className="waypoint-message-dropdown min-w-40 p-1 rounded-xl border-border/80 bg-popover/95 backdrop-blur-md shadow-lg"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.nativeEvent.stopPropagation();
                  }}
                >
                  {activeDesktopPayload?.markdownText ? (
                    <>
                      <DropdownMenuItem
                        className="min-h-8 gap-2 px-2.5 text-sm"
                        onSelect={() => performCopy(activeDesktopPayload.plainText)}
                      >
                        <Copy aria-hidden="true" className="size-3.5 text-muted-foreground" />
                        <span>复制纯文本</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="min-h-8 gap-2 px-2.5 text-sm"
                        onSelect={() => performCopy(activeDesktopPayload.markdownText)}
                      >
                        <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
                        <span>复制 Markdown</span>
                      </DropdownMenuItem>
                      {activeDesktopPayload.codeSnippet ? (
                        <DropdownMenuItem
                          className="min-h-8 gap-2 px-2.5 text-sm"
                          onSelect={() => performCopy(activeDesktopPayload.codeSnippet!)}
                        >
                          <Code2 aria-hidden="true" className="size-3.5 text-muted-foreground" />
                          <span>复制代码</span>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuItem
                    className="min-h-8 gap-2 px-2.5 text-sm"
                    disabled={isFavoritePending || reauthRequired}
                    onSelect={() => {
                      setDesktopMenuState(null);
                      onToggleFavorite?.(item);
                    }}
                  >
                    <Bookmark
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 text-muted-foreground",
                        isFavorited && "fill-current text-foreground",
                      )}
                    />
                    <span>{isFavorited ? "取消收藏" : "收藏"}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    className="min-h-8 gap-2 px-2.5 text-sm"
                    disabled={activeTopicUnavailable || reauthRequired}
                    onSelect={() => {
                      setDesktopMenuState(null);
                      onRequestDeleteMessage?.(item);
                    }}
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                    <span>删除消息</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null;

          return (
          <div
            key={item.key}
            className={cn(
              "waypoint-message-row group/row relative flex items-start gap-2 w-full min-w-0 max-w-full box-border transition-colors duration-200",
              item.side,
              item.side === "right" ? "justify-end" : "justify-start",
              isHighlighted && "rounded-xl bg-accent/50 ring-1 ring-ring/40",
            )}
            data-side={item.side}
            data-event-id={item.eventId}
            data-favorited={isFavorited ? "true" : undefined}
            data-highlighted={isHighlighted ? "true" : undefined}
            onMouseEnter={
              isNarrow === false && isConfirmed && item.eventId
                ? () => setHoveredEventId(item.eventId!)
                : undefined
            }
            onMouseLeave={
              isNarrow === false && isConfirmed && item.eventId
                ? () =>
                    setHoveredEventId((prev) => (prev === item.eventId ? null : prev))
                : undefined
            }
          >
            {item.side === "right" ? desktopMenu : null}
            <div
              className={cn(
                "waypoint-message-content flex flex-col min-w-0 gap-1",
                item.side === "right"
                  ? "max-w-[min(38rem,85%)] items-end"
                  : "w-full max-w-full items-start",
              )}
            >
              <div
                className={cn(
                  "waypoint-bubble min-w-0 wrap-anywhere",
                  item.side === "right"
                    ? "max-w-full bg-primary text-primary-foreground dark:bg-secondary dark:text-foreground rounded-2xl px-4 py-2.5 whitespace-normal shadow-xs [&_a]:underline [&_p]:text-inherit [&_p]:leading-normal text-[16px]"
                    : "bg-transparent border-0 rounded-none shadow-none py-1 px-0 w-full max-w-full text-[16px] leading-[1.5] text-foreground",
                )}
                onTouchStart={(e) => handleTouchStart(e, item)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
                onContextMenu={
                  item.status === "failed" && item.localId
                    ? (event) => {
                        event.preventDefault();
                        onOpenFailedMenu(item.localId!);
                      }
                    : isNarrow === false && isConfirmed
                      ? (event) => {
                          event.preventDefault();
                          setDesktopMenuState(
                            buildMenuPayload(
                              item,
                              event.currentTarget,
                              event.target as HTMLElement | null,
                            ),
                          );
                        }
                      : undefined
                }
              >
                {item.media ? (
                  <div className="waypoint-media-bubble flex flex-col gap-1.5 min-w-0 max-w-full">
                    {item.media.kind === "image" ? (
                      <div className="waypoint-media-image-frame w-fit max-w-[min(15rem,100%)] sm:max-w-[min(20rem,100%)] min-w-0">
                        <button
                          type="button"
                          aria-label={`查看图片 ${item.media.filename}`}
                          className="waypoint-media-image-button block w-fit m-0 p-0 border-0 bg-transparent text-inherit text-left cursor-pointer min-w-0 max-w-full rounded-lg overflow-hidden"
                          onClick={() => onOpenMedia(item.media!)}
                        >
                          {(() => {
                            const imageSrc =
                              (item.media.localAttachment
                                ? getLocalImageUrl(item.media.localAttachment.attachmentId)
                                : undefined) ??
                              (item.media.mxcUrl
                                ? getDownloadedImageUrl(item.media.mxcUrl)
                                : undefined);
                            return imageSrc ? (
                              <img
                                src={imageSrc}
                                alt={item.media.filename}
                                className="waypoint-bubble-image block w-auto max-w-full h-auto max-h-60 sm:max-h-72 rounded-lg"
                              />
                            ) : (
                              <span className="waypoint-media-filename block min-w-0 max-w-full wrap-anywhere">
                                {item.media.filename}
                              </span>
                            );
                          })()}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="waypoint-media-file-button inline-flex items-center gap-1.5 m-0 px-2.5 py-1.5 rounded-md border border-border bg-secondary text-secondary-foreground text-left cursor-pointer min-w-0 max-w-full hover:bg-accent"
                        onClick={() => onOpenMedia(item.media!)}
                      >
                        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
                        <span className="waypoint-media-filename min-w-0 max-w-full wrap-anywhere">
                          {item.media.filename}
                        </span>
                      </button>
                    )}
                    {item.media.caption ? (
                      <MessageBody
                        body={item.media.caption}
                        onOpenExternalUrl={onOpenExternalUrl}
                        richColor={item.side === "left"}
                      />
                    ) : null}
                  </div>
                ) : (
                  <MessageBody
                    body={item.body}
                    onOpenExternalUrl={onOpenExternalUrl}
                    richColor={item.side === "left"}
                  />
                )}
              </div>
              {item.status === "failed" && item.localId ? (
                <div className="waypoint-failed-controls relative inline-flex items-center justify-end gap-1.5 pr-0.5">
                  <DropdownMenu
                    modal={false}
                    open={openFailedMenuId === item.localId}
                    onOpenChange={(nextOpen) => {
                      const isOpen = openFailedMenuId === item.localId;
                      if (nextOpen !== isOpen) {
                        onToggleFailedMenu(item.localId!);
                      }
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="更多操作"
                        className="waypoint-bubble-menu-trigger size-6 min-w-6 rounded-full p-0 text-muted-foreground hover:text-foreground hover:bg-accent/60"
                      >
                        <MoreHorizontal aria-hidden="true" className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      aria-labelledby={undefined}
                      aria-label="消息操作"
                      side="bottom"
                      align="end"
                      sideOffset={4}
                      className="waypoint-failed-menu waypoint-failed-controls min-w-20 p-1 rounded-lg border-border/80 bg-popover/95 backdrop-blur-md shadow-md"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        event.nativeEvent.stopPropagation();
                      }}
                    >
                      <DropdownMenuItem
                        variant="destructive"
                        className="min-h-8 px-2 py-1.5 text-sm"
                        onSelect={() => onDiscardFailed(item.localId!)}
                      >
                        丢掉
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    aria-label="失败"
                    className="waypoint-failed-button size-5 min-w-5 rounded-full p-0 text-[12px] font-bold leading-none shrink-0"
                    disabled={reauthRequired}
                    onClick={() => onResendFailed(item.localId!)}
                  >
                    !
                  </Button>
                </div>
              ) : null}
              {item.reactions && item.reactions.length > 0 ? (
                <div className="waypoint-message-reactions flex flex-wrap gap-1">
                  {item.reactions.map((key) => (
                    <Badge
                      key={key}
                      variant="secondary"
                      className="waypoint-message-reaction font-normal text-xs px-2 py-0.5 border border-border/60 text-muted-foreground"
                    >
                      {key}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {item.prompt && item.eventId ? (
                <div
                  className="waypoint-message-prompt inline-flex flex-wrap gap-2 items-center mt-2"
                  role="group"
                  aria-label={
                    item.prompt.kind === "approval" ? "审批操作" : "选择操作"
                  }
                >
                  {item.prompt.options.map((option) => {
                    const isSelected = item.prompt!.selectedKey === option.key;
                    const isDisabled =
                      Boolean(option.redacted) ||
                      item.prompt!.answered ||
                      item.prompt!.superseded ||
                      item.prompt!.queuedKey === option.key ||
                      activeTopicUnavailable ||
                      reauthRequired;
                    return (
                      <Button
                        key={option.key}
                        type="button"
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className={cn(
                          "waypoint-prompt-button h-auto rounded-full px-3.5 py-1.5 text-[13px] font-medium gap-1.5 transition-transform",
                          isSelected && "selected font-semibold scale-[1.03] shadow-xs",
                        )}
                        aria-pressed={isSelected}
                        disabled={isDisabled}
                        onClick={() =>
                          onSelectPromptOption(item.eventId!, option.key)
                        }
                      >
                        <span className="waypoint-prompt-button-label">
                          {option.label}
                        </span>
                        {option.scope ? (
                          <span
                            className={cn(
                              "waypoint-prompt-button-scope text-xs",
                              isSelected
                                ? "text-primary-foreground/85"
                                : "text-muted-foreground",
                            )}
                          >
                            {option.scope}
                          </span>
                        ) : null}
                      </Button>
                    );
                  })}
                </div>
              ) : null}
              {isFavorited ? (
                <div
                  className={cn(
                    "waypoint-favorite-indicator inline-flex items-center gap-1 text-[12px] text-muted-foreground",
                    item.side === "right" ? "self-end pr-0.5" : "self-start",
                  )}
                >
                  <Bookmark
                    aria-label="已收藏"
                    className="size-3 fill-current"
                  />
                </div>
              ) : null}
            </div>
            {item.side === "left" ? desktopMenu : null}
          </div>
          );
        })(),
      )}
        {responding ? (
          <RespondingIndicator
            size="timeline"
            role="status"
            aria-label="正在回应"
            className="waypoint-timeline-responding self-start py-1.5"
          />
        ) : null}
      </div>
      {contextMenuItem !== null ? (
        <ActionSheet
          open
          onOpenChange={(open) => {
            if (!open) setContextMenuItem(null);
          }}
        >
          <ActionSheetContent
            aria-label="消息操作"
            title="消息操作"
            onDismiss={() => setContextMenuItem(null)}
          >
            <ActionSheetCard>
              <div role="menu" aria-label="消息操作" className="flex flex-col">
                {contextMenuItem.markdownText ? (
                  <>
                    <ActionSheetItem
                      icon={<Copy className="size-4" aria-hidden="true" />}
                      onClick={() => {
                        performCopy(contextMenuItem.plainText);
                      }}
                    >
                      复制纯文本
                    </ActionSheetItem>
                    <ActionSheetItem
                      icon={<FileText className="size-4" aria-hidden="true" />}
                      onClick={() => {
                        performCopy(contextMenuItem.markdownText);
                      }}
                    >
                      复制 Markdown
                    </ActionSheetItem>
                    {contextMenuItem.codeSnippet ? (
                      <ActionSheetItem
                        icon={<Code2 className="size-4" aria-hidden="true" />}
                        onClick={() => {
                          if (contextMenuItem.codeSnippet) {
                            performCopy(contextMenuItem.codeSnippet);
                          }
                        }}
                      >
                        复制代码
                      </ActionSheetItem>
                    ) : null}
                  </>
                ) : null}
                {contextMenuItem.item.status === "confirmed" && contextMenuItem.item.eventId ? (
                  <>
                    <ActionSheetItem
                      icon={
                        <Bookmark
                          className={cn(
                            "size-4",
                            favoritedEventIds?.has(contextMenuItem.item.eventId) &&
                              "fill-current text-foreground",
                          )}
                          aria-hidden="true"
                        />
                      }
                      disabled={
                        Boolean(
                          favoritePendingEventIds?.has(contextMenuItem.item.eventId),
                        ) || reauthRequired
                      }
                      onClick={() => {
                        const target = contextMenuItem.item;
                        setContextMenuItem(null);
                        onToggleFavorite?.(target);
                      }}
                    >
                      {favoritedEventIds?.has(contextMenuItem.item.eventId)
                        ? "取消收藏"
                        : "收藏"}
                    </ActionSheetItem>
                    <ActionSheetItem
                      variant="destructive"
                      icon={<Trash2 className="size-4 text-destructive" aria-hidden="true" />}
                      disabled={activeTopicUnavailable || reauthRequired}
                      onClick={() => {
                        const target = contextMenuItem.item;
                        setContextMenuItem(null);
                        onRequestDeleteMessage?.(target);
                      }}
                    >
                      删除消息
                    </ActionSheetItem>
                  </>
                ) : null}
              </div>
            </ActionSheetCard>
            <ActionSheetCard>
              <ActionSheetCancel onClick={() => setContextMenuItem(null)}>
                取消
              </ActionSheetCancel>
            </ActionSheetCard>
          </ActionSheetContent>
        </ActionSheet>
      ) : null}
    </div>
  );
}
