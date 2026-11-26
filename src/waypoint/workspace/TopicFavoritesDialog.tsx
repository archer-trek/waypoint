import { Bookmark, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatTopicListTime, type TopicFavoriteItem } from "../topics";

export type TopicFavoritesDialogProps = {
  open: boolean;
  items: TopicFavoriteItem[];
  botDisplayName?: string;
  nowMs: number;
  pendingEventIds: ReadonlySet<string>;
  onClose: () => void;
  onSelectFavorite: (eventId: string) => void;
  onRemoveFavorite: (item: TopicFavoriteItem) => void;
};

/** Per-Topic list of Owner-private favorited messages with jump-to-message and direct unfavorite. */
export function TopicFavoritesDialog({
  open,
  items,
  botDisplayName,
  nowMs,
  pendingEventIds,
  onClose,
  onSelectFavorite,
  onRemoveFavorite,
}: TopicFavoritesDialogProps) {
  const agentLabel = botDisplayName?.trim() || "Bot";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent
        aria-label="本 Topic 收藏"
        className="waypoint-favorites-dialog flex max-h-[80vh] flex-col gap-3 p-5 sm:max-w-md"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-[17px]">
            <Bookmark aria-hidden="true" className="size-4 text-muted-foreground" />
            <span>收藏（{items.length}）</span>
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            仅对你可见，点击任意条目跳回原消息位置。
          </DialogDescription>
        </DialogHeader>
        <div className="waypoint-favorites-list -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
          {items.length === 0 ? (
            <p className="m-0 py-8 text-center text-sm text-muted-foreground">
              当前 Topic 暂无收藏消息
            </p>
          ) : (
            items.map((item) => {
              const senderLabel =
                item.senderSide === "right"
                  ? "你"
                  : item.senderSide === "left"
                    ? agentLabel
                    : undefined;
              const timeLabel =
                item.ts !== undefined
                  ? formatTopicListTime(item.ts, nowMs)
                  : undefined;
              const isPending = pendingEventIds.has(item.eventId);

              return (
                <div
                  key={item.eventId}
                  className="waypoint-favorite-row group flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 p-2.5 transition-colors hover:bg-accent/50"
                >
                  <button
                    type="button"
                    className="waypoint-favorite-jump flex min-w-0 flex-1 cursor-pointer flex-col gap-1 border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    onClick={() => onSelectFavorite(item.eventId)}
                  >
                    {senderLabel || timeLabel ? (
                      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        {senderLabel ? (
                          <span className="font-medium text-foreground/80 truncate">
                            {senderLabel}
                          </span>
                        ) : null}
                        {senderLabel && timeLabel ? (
                          <span aria-hidden="true">·</span>
                        ) : null}
                        {timeLabel ? (
                          <span className="shrink-0 tabular-nums">{timeLabel}</span>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="line-clamp-2 wrap-anywhere text-sm leading-snug text-foreground">
                      {item.preview}
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="取消收藏"
                    title="取消收藏"
                    disabled={isPending}
                    className="waypoint-favorite-remove size-9 min-h-9 min-w-9 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => onRemoveFavorite(item)}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
