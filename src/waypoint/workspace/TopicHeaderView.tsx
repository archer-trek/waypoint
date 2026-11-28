import type { RefObject } from "react";
import { ArrowLeft, Bookmark, MoreHorizontal, PenLine, Pin, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { TopicSummary } from "../topics";

export type TopicHeaderViewProps = {
  isNarrow: boolean;
  topic: TopicSummary;
  descriptionExpanded: boolean;
  overflowMenuOpen: boolean;
  overflowMenuRef: RefObject<HTMLDivElement | null>;
  editing: boolean;
  editSubmitting: boolean;
  deleteConfirmOpen: boolean;
  deleting: boolean;
  reauthRequired: boolean;
  pinPending: boolean;
  favoriteCount?: number;
  elevated?: boolean;
  onGoBack: () => void;
  onOpenFavorites?: () => void;
  onToggleDescription: () => void;
  onToggleOverflowMenu: () => void;
  onCloseOverflowMenu: () => void;
  onTogglePin: () => void;
  onOpenEditForm: () => void;
  onOpenDeleteConfirm: () => void;
};

/** Sticky Topic header displaying title, expandable description, and topic actions. */
export function TopicHeaderView({
  isNarrow,
  topic,
  descriptionExpanded,
  overflowMenuOpen,
  overflowMenuRef,
  editing,
  editSubmitting,
  deleteConfirmOpen,
  deleting,
  reauthRequired,
  pinPending,
  favoriteCount = 0,
  onGoBack,
  onOpenFavorites,
  onToggleDescription,
  onToggleOverflowMenu,
  onCloseOverflowMenu,
  onTogglePin,
  onOpenEditForm,
  onOpenDeleteConfirm,
  elevated,
}: TopicHeaderViewProps) {
  const pinDisabled =
    editing || deleteConfirmOpen || deleting || reauthRequired || pinPending;
  const editOrDeleteDisabled = editing || deleteConfirmOpen || deleting;
  const pinLabel = topic.pinned ? "取消置顶" : "置顶";
  const isElevated = elevated ?? !isNarrow;
  const botName = topic.botDisplayName?.trim() || undefined;
  const hasDescription = Boolean(topic.description);

  return (
    <header
      data-elevated={isElevated ? "true" : undefined}
      data-tauri-drag-region="deep"
      className={cn(
        "waypoint-topic-header sticky top-0 z-10 shrink-0 py-2.5 box-border touch-none transition-colors duration-200",
        isElevated
          ? "bg-background/90 backdrop-blur-md border-b border-border/60 shadow-xs"
          : isNarrow
            ? "bg-background border-b border-transparent"
            : "bg-background/90 backdrop-blur-md border-b border-border/60",
        isNarrow
          ? "pt-[max(0.65rem,env(safe-area-inset-top,0px))] pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))]"
          : "px-4 sm:px-6 pt-[calc(0.65rem+env(safe-area-inset-top,0px))]",
      )}
    >
      <div className="waypoint-topic-header-bar flex items-center justify-between gap-3">
        {isNarrow ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="waypoint-back-button size-11 min-w-11 min-h-11 rounded-full shrink-0 text-foreground hover:bg-accent active:scale-92"
            disabled={(editing && editSubmitting) || deleting}
            aria-label="返回"
            onClick={onGoBack}
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </Button>
        ) : null}
        <div className="waypoint-topic-header-main flex flex-col justify-center min-w-0 flex-1">
          <h2 className="m-0 text-[19px] sm:text-[20px] font-bold leading-snug tracking-tight text-foreground truncate">
            {topic.name}
          </h2>
          {botName || hasDescription ? (
            <div
              className={cn(
                "waypoint-topic-header-meta mt-0.5 flex min-w-0 text-[13px] leading-[1.35] text-muted-foreground",
                hasDescription && descriptionExpanded
                  ? "flex-col items-stretch gap-0.5"
                  : "flex-row items-baseline gap-1.5",
              )}
            >
              {botName ? (
                <span
                  className={cn(
                    "waypoint-topic-bot-name min-w-0 truncate",
                    hasDescription && !descriptionExpanded && "shrink-0 max-w-[50%]",
                  )}
                >
                  {botName}
                </span>
              ) : null}
              {botName && hasDescription && !descriptionExpanded ? (
                <span
                  aria-hidden="true"
                  className="waypoint-topic-meta-separator shrink-0 text-muted-foreground/70"
                >
                  ·
                </span>
              ) : null}
              {hasDescription ? (
                <button
                  type="button"
                  className={cn(
                    "waypoint-topic-description text-left bg-transparent border-0 p-0 m-0 text-[13px] leading-[1.35] text-muted-foreground hover:text-foreground cursor-pointer",
                    descriptionExpanded
                      ? "expanded block w-full whitespace-pre-wrap overflow-visible"
                      : "min-w-0 flex-1 truncate",
                  )}
                  aria-expanded={descriptionExpanded}
                  onClick={onToggleDescription}
                >
                  {topic.description}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="waypoint-header-actions-group flex items-center gap-1.5 shrink-0">
          {favoriteCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`收藏 (${favoriteCount})`}
              className={cn(
                "waypoint-topic-favorites-button rounded-full text-muted-foreground hover:text-foreground hover:bg-accent gap-1.5 font-medium tabular-nums",
                isNarrow
                  ? "h-11 min-w-11 px-3 active:scale-92"
                  : "h-9 px-2.5",
              )}
              onClick={onOpenFavorites}
            >
              <Bookmark aria-hidden="true" className="size-4" />
              <span className="text-[13px]">{favoriteCount}</span>
            </Button>
          ) : null}
          <div
            className="waypoint-overflow-wrapper relative inline-flex"
            ref={overflowMenuRef}
          >
            <DropdownMenu
              modal={false}
              open={overflowMenuOpen}
              onOpenChange={(nextOpen) => {
                if (nextOpen === overflowMenuOpen) {
                  return;
                }
                if (nextOpen) {
                  onToggleOverflowMenu();
                } else {
                  onCloseOverflowMenu();
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="话题操作"
                  className={cn(
                    "waypoint-overflow-trigger group rounded-full text-foreground hover:bg-transparent",
                    isNarrow
                      ? "size-11 min-w-11 min-h-11"
                      : "size-9",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex size-full items-center justify-center rounded-full transition-[transform,background-color] group-hover:bg-accent",
                      isNarrow && "group-active:scale-92",
                    )}
                  >
                    <MoreHorizontal aria-hidden="true" className="size-5" />
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                aria-labelledby={undefined}
                aria-label="话题操作"
                align="end"
                sideOffset={8}
                className="waypoint-overflow-menu min-w-40 p-1.5 rounded-xl shadow-lg border-border/80 bg-popover/95 backdrop-blur-md"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.nativeEvent.stopPropagation();
                }}
              >
                <DropdownMenuItem
                  className="waypoint-topic-pin-button min-h-11 px-3 text-[15px] gap-2.5"
                  disabled={pinDisabled}
                  aria-pressed={topic.pinned}
                  aria-label={pinLabel}
                  onSelect={() => {
                    onCloseOverflowMenu();
                    onTogglePin();
                  }}
                >
                  <Pin aria-hidden="true" className="size-4" />
                  <span>{pinLabel}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="waypoint-topic-edit-button min-h-11 px-3 text-[15px] gap-2.5"
                  disabled={editOrDeleteDisabled}
                  aria-label="编辑"
                  onSelect={() => {
                    onCloseOverflowMenu();
                    onOpenEditForm();
                  }}
                >
                  <PenLine aria-hidden="true" className="size-4" />
                  <span>编辑</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  className="waypoint-topic-delete-button min-h-11 px-3 text-[15px] gap-2.5"
                  disabled={editOrDeleteDisabled}
                  aria-label="删除"
                  onSelect={() => {
                    onCloseOverflowMenu();
                    onOpenDeleteConfirm();
                  }}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  <span>删除</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* Visually converged to the ··· overflow menu per ADR-0024; keep direct buttons sr-only for test/a11y hooks */}
          <div className="waypoint-sr-only sr-only">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "waypoint-topic-pin-button size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent",
                topic.pinned && "bg-accent text-foreground",
              )}
              disabled={pinDisabled}
              aria-pressed={topic.pinned}
              aria-label={pinLabel}
              onClick={onTogglePin}
            >
              <Pin aria-hidden="true" className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="waypoint-topic-edit-button size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
              disabled={editOrDeleteDisabled}
              aria-label="编辑"
              onClick={onOpenEditForm}
            >
              <PenLine aria-hidden="true" className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="waypoint-topic-delete-button size-8 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              disabled={editOrDeleteDisabled}
              aria-label="删除"
              onClick={onOpenDeleteConfirm}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
