import type { RefObject } from "react";
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
      className="waypoint-timeline"
      onScroll={onScroll}
    >
      {items.map((item) =>
        item.kind === "day-separator" ? (
          <div
            key={item.key}
            role="separator"
            aria-label={item.label}
            className="waypoint-day-separator"
          >
            {item.label}
          </div>
        ) : (
          <div
            key={item.key}
            className={`waypoint-message-row ${item.side}`}
            data-side={item.side}
            data-event-id={item.eventId}
          >
            {item.status === "unconfirmed" ? (
              <span
                role="status"
                aria-label="未确认"
                className="waypoint-unconfirmed-spinner"
              />
            ) : item.status === "failed" && item.localId ? (
              <div className="waypoint-failed-controls">
                <button
                  type="button"
                  aria-label="更多操作"
                  aria-haspopup="menu"
                  aria-expanded={openFailedMenuId === item.localId}
                  className="waypoint-bubble-menu-trigger"
                  onClick={() => onToggleFailedMenu(item.localId!)}
                >
                  ⋯
                </button>
                <button
                  type="button"
                  aria-label="失败"
                  className="waypoint-failed-button"
                  disabled={reauthRequired}
                  onClick={() => onResendFailed(item.localId!)}
                >
                  !
                </button>
                {openFailedMenuId === item.localId ? (
                  <div
                    role="menu"
                    aria-label="消息操作"
                    className="waypoint-failed-menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => onDiscardFailed(item.localId!)}
                    >
                      丢掉
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="waypoint-message-content">
              <div
                className="waypoint-bubble"
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
                  <div className="waypoint-media-bubble">
                    {item.media.kind === "image" ? (
                      <button
                        type="button"
                        aria-label={`查看图片 ${item.media.filename}`}
                        className="waypoint-media-image-button"
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
                              className="waypoint-bubble-image"
                            />
                          ) : (
                            <span className="waypoint-media-filename">
                              {item.media.filename}
                            </span>
                          );
                        })()}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="waypoint-media-file-button"
                        onClick={() => onOpenMedia(item.media!)}
                      >
                        <span className="waypoint-media-filename">
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
                <div className="waypoint-message-reactions">
                  {item.reactions.map((key) => (
                    <span key={key} className="waypoint-message-reaction">
                      {key}
                    </span>
                  ))}
                </div>
              ) : null}
              {item.prompt && item.eventId ? (
                <div
                  className="waypoint-message-prompt"
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
                      <button
                        key={option.key}
                        type="button"
                        className={`waypoint-prompt-button${isSelected ? " selected" : ""}`}
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
                          <>
                            {" "}
                            <span className="waypoint-prompt-button-scope">
                              {option.scope}
                            </span>
                          </>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {item.responding ? (
                <div className="waypoint-message-responding">正在回应</div>
              ) : null}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
