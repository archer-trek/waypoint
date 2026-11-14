import type { ReactNode } from "react";
import { PlusIcon } from "../icons";

export type EmptyInvitationProps = {
  topicsCount: number;
  reauthRequired: boolean;
  shortcut?: boolean;
  onOpenCreateForm: () => void;
};

/** Muse-style empty invitation card encouraging Topic creation. */
export function EmptyInvitation({
  topicsCount,
  reauthRequired,
  shortcut,
  onOpenCreateForm,
}: EmptyInvitationProps) {
  return (
    <section aria-label="Topic 引导" className="waypoint-empty-detail">
      <div className="waypoint-empty-card">
        <p>
          {topicsCount === 0
            ? "还没有 Topic，新建一条 Topic 开始交流。"
            : "选择一条 Topic，或新建一条 Topic 开始交流。"}
        </p>
        <button type="button" disabled={reauthRequired} onClick={onOpenCreateForm}>
          <PlusIcon aria-hidden="true" size={14} />
          新建一条 Topic
        </button>
        {shortcut === false ? null : (
          <div className="waypoint-empty-shortcut-hint">
            快捷键 <kbd className="waypoint-kbd-hint">Alt + N</kbd>
          </div>
        )}
      </div>
    </section>
  );
}

export type EmptyDetailViewProps = {
  reauthBanner: ReactNode;
  topicsCount: number;
  reauthRequired: boolean;
  onOpenCreateForm: () => void;
};

/** Detail pane empty state shown on wide viewports when no Topic is selected. */
export function EmptyDetailView({
  reauthBanner,
  topicsCount,
  reauthRequired,
  onOpenCreateForm,
}: EmptyDetailViewProps) {
  return (
    <>
      {reauthBanner}
      <EmptyInvitation
        topicsCount={topicsCount}
        reauthRequired={reauthRequired}
        onOpenCreateForm={onOpenCreateForm}
      />
    </>
  );
}
