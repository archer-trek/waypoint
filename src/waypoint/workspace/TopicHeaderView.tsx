import type { RefObject } from "react";
import { ArrowLeft, MoreHorizontal, PenLine, Pin, Trash2 } from "lucide-react";
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
  onGoBack: () => void;
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
  onGoBack,
  onToggleDescription,
  onToggleOverflowMenu,
  onCloseOverflowMenu,
  onTogglePin,
  onOpenEditForm,
  onOpenDeleteConfirm,
}: TopicHeaderViewProps) {
  const pinDisabled =
    editing || deleteConfirmOpen || deleting || reauthRequired || pinPending;
  const editOrDeleteDisabled = editing || deleteConfirmOpen || deleting;
  const pinLabel = topic.pinned ? "取消置顶" : "置顶";

  return (
    <header
      className={cn(
        "waypoint-topic-header sticky top-0 z-10 shrink-0 bg-background/90 backdrop-blur-md border-b border-border/60 px-4 py-2.5 box-border",
        isNarrow
          ? "pt-[max(0.65rem,env(safe-area-inset-top,0px))] pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))]"
          : "pt-[calc(0.65rem+env(safe-area-inset-top,0px))]",
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
          <h2 className="m-0 text-[1.2rem] font-bold leading-snug tracking-tight text-foreground truncate">
            {topic.name}
          </h2>
          {topic.description ? (
            <button
              type="button"
              className={cn(
                "waypoint-topic-description block w-full text-left bg-transparent border-0 p-0 m-0 mt-0.5 text-sm leading-[1.35] text-muted-foreground hover:text-foreground cursor-pointer",
                descriptionExpanded
                  ? "expanded whitespace-pre-wrap overflow-visible"
                  : "truncate",
              )}
              aria-expanded={descriptionExpanded}
              onClick={onToggleDescription}
            >
              {topic.description}
            </button>
          ) : null}
        </div>
        <div className="waypoint-header-actions-group flex items-center gap-1.5 shrink-0">
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
                    "waypoint-overflow-trigger rounded-full text-foreground hover:bg-accent",
                    isNarrow
                      ? "size-11 min-w-11 min-h-11 active:scale-92"
                      : "size-9",
                  )}
                >
                  <MoreHorizontal aria-hidden="true" className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                aria-labelledby={undefined}
                aria-label="话题操作"
                align="end"
                sideOffset={8}
                className="waypoint-overflow-menu min-w-36 p-1.5"
                onPointerDown={(event) => {
                  // Prevent TopicsWorkspace's document pointerdown outside listener
                  // from unmounting the portaled menu before click/onSelect fires.
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
          {/* Expose pure icon buttons in wide desktop and for test accessibility */}
          <div
            className={
              !isNarrow
                ? "waypoint-desktop-actions flex items-center gap-1"
                : "waypoint-sr-only sr-only"
            }
          >
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
