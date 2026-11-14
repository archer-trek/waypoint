import type { RefObject } from "react";
import { FileText, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MessageBody } from "../MessageBody";
import type { DraftAttachment } from "../session-store";
import type { TimelineItem, TimelineMedia } from "../topics";

export type TimelineViewProps = {
  timelineRef: RefObject<HTMLDivElement | null>;
  items: TimelineItem[];
  activeTopicUnavailable: boolean;
  reauthRequired: boolean;
  openFailedMenuId: string | null;
  getLocalImageUrl: (key: string, attachment: DraftAttachment) => string;
  getDownloadedImageUrl: (mxcUrl: string) => string | undefined;
  onScroll: () => void;
  onToggleFailedMenu: (localId: string) => void;
  onOpenFailedMenu: (localId: string) => void;
  onResendFailed: (localId: string) => void;
  onDiscardFailed: (localId: string) => void;
  onOpenMedia: (media: TimelineMedia) => void;
  onOpenExternalUrl: (url: string) => void;
  onSelectPromptOption: (eventId: string, optionKey: string) => void;
};

/** Scrollable timeline log rendering day separators, message bubbles, media, reactions, and prompts. */
export function TimelineView({
  timelineRef,
  items,
  activeTopicUnavailable,
  reauthRequired,
  openFailedMenuId,
  getLocalImageUrl,
  getDownloadedImageUrl,
  onScroll,
  onToggleFailedMenu,
  onOpenFailedMenu,
  onResendFailed,
  onDiscardFailed,
  onOpenMedia,
  onOpenExternalUrl,
  onSelectPromptOption,
}: TimelineViewProps) {
  return (
    <div
      ref={timelineRef}
      role="log"
      aria-label="对话时间线"
      className="waypoint-timeline relative flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 flex flex-col gap-4.5"
      onScroll={onScroll}
    >
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
        ) : (
          <div
            key={item.key}
            className={cn(
              "waypoint-message-row flex items-start gap-2 w-full box-border",
              item.side,
              item.side === "right" ? "justify-end" : "justify-start",
            )}
            data-side={item.side}
            data-event-id={item.eventId}
          >
            {item.status === "unconfirmed" ? (
              <span
                role="status"
                aria-label="未确认"
                className="waypoint-unconfirmed-spinner inline-block size-3.5 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin shrink-0 mt-1"
              />
            ) : item.status === "failed" && item.localId ? (
              <div className="waypoint-failed-controls relative inline-flex items-center gap-1 shrink-0 mt-1">
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
                      className="waypoint-bubble-menu-trigger size-5 min-w-5 rounded-full p-0 text-muted-foreground hover:text-foreground"
                    >
                      <MoreHorizontal aria-hidden="true" className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    aria-labelledby={undefined}
                    aria-label="消息操作"
                    side="top"
                    align="end"
                    sideOffset={4}
                    className="waypoint-failed-menu waypoint-failed-controls min-w-20 p-1"
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
                  className="waypoint-failed-button size-4.5 min-w-4.5 rounded-full p-0 text-xs font-bold leading-none shrink-0"
                  disabled={reauthRequired}
                  onClick={() => onResendFailed(item.localId!)}
                >
                  !
                </Button>
              </div>
            ) : null}
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
                  "waypoint-bubble",
                  item.side === "right"
                    ? "bg-primary text-primary-foreground dark:bg-secondary dark:text-foreground rounded-2xl px-4 py-2.5 whitespace-normal break-words shadow-xs [&_a]:underline [&_p]:text-inherit [&_p]:leading-normal"
                    : "bg-transparent border-0 rounded-none shadow-none py-1 px-0 w-full max-w-[min(42rem,100%)] leading-[1.65] text-foreground",
                )}
                onContextMenu={
                  item.status === "failed" && item.localId
                    ? (event) => {
                        event.preventDefault();
                        onOpenFailedMenu(item.localId!);
                      }
                    : undefined
                }
              >
                {item.media ? (
                  <div className="waypoint-media-bubble flex flex-col gap-1.5 max-w-full">
                    {item.media.kind === "image" ? (
                      <button
                        type="button"
                        aria-label={`查看图片 ${item.media.filename}`}
                        className="waypoint-media-image-button m-0 p-0 border-0 bg-transparent text-inherit text-left cursor-pointer max-w-full rounded-lg overflow-hidden"
                        onClick={() => onOpenMedia(item.media!)}
                      >
                        {(() => {
                          const imageSrc = item.media.localAttachment
                            ? getLocalImageUrl(
                                item.localId ?? item.key,
                                item.media.localAttachment,
                              )
                            : item.media.mxcUrl
                              ? getDownloadedImageUrl(item.media.mxcUrl)
                              : undefined;
                          return imageSrc ? (
                            <img
                              src={imageSrc}
                              alt={item.media.filename}
                              className="waypoint-bubble-image block max-w-full h-auto rounded-lg"
                            />
                          ) : (
                            <span className="waypoint-media-filename break-words">
                              {item.media.filename}
                            </span>
                          );
                        })()}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="waypoint-media-file-button inline-flex items-center gap-1.5 m-0 px-2.5 py-1.5 rounded-md border border-border bg-secondary text-secondary-foreground text-left cursor-pointer max-w-full hover:bg-accent"
                        onClick={() => onOpenMedia(item.media!)}
                      >
                        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
                        <span className="waypoint-media-filename break-words">
                          {item.media.filename}
                        </span>
                      </button>
                    )}
                    {item.media.caption ? (
                      <MessageBody
                        body={item.media.caption}
                        onOpenExternalUrl={onOpenExternalUrl}
                      />
                    ) : null}
                  </div>
                ) : (
                  <MessageBody
                    body={item.body}
                    onOpenExternalUrl={onOpenExternalUrl}
                  />
                )}
              </div>
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
                          "waypoint-prompt-button h-auto rounded-full px-3.5 py-1.5 text-[0.8125rem] font-medium gap-1.5 transition-transform",
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
              {item.responding ? (
                <div className="waypoint-message-responding text-xs font-medium text-muted-foreground px-1">
                  正在回应
                </div>
              ) : null}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
