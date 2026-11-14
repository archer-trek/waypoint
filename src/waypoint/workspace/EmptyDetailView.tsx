import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export type EmptyInvitationProps = {
  topicsCount: number;
  reauthRequired: boolean;
  shortcut?: boolean;
  onOpenCreateForm: () => void;
};

/** Centered monochrome empty-state card encouraging Topic creation. */
export function EmptyInvitation({
  topicsCount,
  reauthRequired,
  shortcut,
  onOpenCreateForm,
}: EmptyInvitationProps) {
  return (
    <section
      aria-label="Topic 引导"
      className="waypoint-empty-detail flex flex-1 flex-col items-center justify-center px-6 py-10 text-center text-muted-foreground"
    >
      <div className="waypoint-empty-card flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-8">
        <p className="m-0 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {topicsCount === 0
            ? "还没有 Topic，新建一条 Topic 开始交流。"
            : "选择一条 Topic，或新建一条 Topic 开始交流。"}
        </p>
        <Button
          type="button"
          size="lg"
          className="min-h-11 gap-1.5"
          disabled={reauthRequired}
          onClick={onOpenCreateForm}
        >
          <Plus aria-hidden="true" className="size-4" />
          新建一条 Topic
        </Button>
        {shortcut === false ? null : (
          <div className="waypoint-empty-shortcut-hint flex items-center gap-1.5 text-xs text-muted-foreground">
            快捷键{" "}
            <kbd className="waypoint-kbd-hint rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
              Alt + N
            </kbd>
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
