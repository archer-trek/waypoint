import type { RefObject } from "react";
import {
  BackIcon,
  EditIcon,
  MoreHorizontalIcon,
  PinIcon,
  TrashIcon,
} from "../icons";
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

  return (
    <header className="waypoint-topic-header">
      <div className="waypoint-topic-header-bar">
        {isNarrow ? (
          <button
            type="button"
            className="waypoint-back-button"
            disabled={(editing && editSubmitting) || deleting}
            aria-label="返回"
            onClick={onGoBack}
          >
            <BackIcon aria-hidden="true" size={20} />
          </button>
        ) : null}
        <div className="waypoint-topic-header-main">
          <h2>{topic.name}</h2>
          {topic.description ? (
            <button
              type="button"
              className={
                descriptionExpanded
                  ? "waypoint-topic-description expanded"
                  : "waypoint-topic-description"
              }
              aria-expanded={descriptionExpanded}
              onClick={onToggleDescription}
            >
              {topic.description}
            </button>
          ) : null}
        </div>
        <div className="waypoint-header-actions-group">
          <div className="waypoint-overflow-wrapper" ref={overflowMenuRef}>
            <button
              type="button"
              aria-label="话题操作"
              aria-haspopup="menu"
              aria-expanded={overflowMenuOpen}
              className="waypoint-overflow-trigger"
              onClick={onToggleOverflowMenu}
            >
              <MoreHorizontalIcon aria-hidden="true" size={20} />
            </button>
            {overflowMenuOpen ? (
              <div
                role="menu"
                aria-label="话题操作"
                className="waypoint-overflow-menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="waypoint-topic-pin-button"
                  disabled={pinDisabled}
                  aria-pressed={topic.pinned}
                  aria-label={topic.pinned ? "取消置顶" : "置顶"}
                  onClick={() => {
                    onCloseOverflowMenu();
                    onTogglePin();
                  }}
                >
                  <PinIcon aria-hidden="true" size={15} />
                  <span>{topic.pinned ? "取消置顶" : "置顶"}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="waypoint-topic-edit-button"
                  disabled={editOrDeleteDisabled}
                  aria-label="编辑"
                  onClick={() => {
                    onCloseOverflowMenu();
                    onOpenEditForm();
                  }}
                >
                  <EditIcon aria-hidden="true" size={15} />
                  <span>编辑</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="waypoint-topic-delete-button"
                  disabled={editOrDeleteDisabled}
                  aria-label="删除"
                  onClick={() => {
                    onCloseOverflowMenu();
                    onOpenDeleteConfirm();
                  }}
                >
                  <TrashIcon aria-hidden="true" size={15} />
                  <span>删除</span>
                </button>
              </div>
            ) : null}
          </div>
          {/* Expose pure icon buttons in wide desktop and for test accessibility */}
          <div
            className={!isNarrow ? "waypoint-desktop-actions" : "waypoint-sr-only"}
          >
            <button
              type="button"
              className="waypoint-topic-pin-button"
              disabled={pinDisabled}
              aria-pressed={topic.pinned}
              aria-label={topic.pinned ? "取消置顶" : "置顶"}
              onClick={onTogglePin}
            >
              <PinIcon aria-hidden="true" size={16} />
            </button>
            <button
              type="button"
              className="waypoint-topic-edit-button"
              disabled={editOrDeleteDisabled}
              aria-label="编辑"
              onClick={onOpenEditForm}
            >
              <EditIcon aria-hidden="true" size={16} />
            </button>
            <button
              type="button"
              className="waypoint-topic-delete-button"
              disabled={editOrDeleteDisabled}
              aria-label="删除"
              onClick={onOpenDeleteConfirm}
            >
              <TrashIcon aria-hidden="true" size={16} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
