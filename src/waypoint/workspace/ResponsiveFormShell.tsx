import type { ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ResponsiveFormShellProps = {
  title: string;
  isModal: boolean;
  isNarrow: boolean;
  safeInset: number;
  closeDisabled?: boolean;
  backDisabled?: boolean;
  nestedModalOpen?: boolean;
  reauthBanner?: ReactNode;
  headerAction?: ReactNode;
  onClose: () => void;
  onGoBack: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode;
};

/**
 * Shared responsive form container: centered modal Dialog on wide viewports,
 * full-screen pushed page with sticky back-bar on narrow mobile viewports.
 */
export function ResponsiveFormShell({
  title,
  isModal,
  isNarrow,
  safeInset,
  closeDisabled = false,
  backDisabled = false,
  nestedModalOpen = false,
  reauthBanner,
  headerAction,
  onClose,
  onGoBack,
  onEscapeKeyDown,
  children,
}: ResponsiveFormShellProps) {
  if (isModal && !isNarrow) {
    const blockDismiss = closeDisabled || nestedModalOpen;
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !blockDismiss) {
            onClose();
          }
        }}
      >
        <DialogContent
          role="region"
          aria-label={title}
          aria-modal="true"
          aria-describedby={undefined}
          showCloseButton={false}
          overlayClassName="waypoint-modal-backdrop"
          onOverlayClick={() => {
            if (!blockDismiss) {
              onClose();
            }
          }}
          onEscapeKeyDown={(event) => {
            if (blockDismiss) {
              event.preventDefault();
              return;
            }
            onEscapeKeyDown?.(event);
          }}
          onPointerDownOutside={(event) => {
            if (blockDismiss) {
              event.preventDefault();
            }
          }}
          onFocusOutside={(event) => {
            if (blockDismiss) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (blockDismiss) {
              event.preventDefault();
            }
          }}
          className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-lg"
        >
          {reauthBanner}
          <div
            className="space-y-5 p-6"
            style={{
              paddingBottom:
                safeInset > 0 ? `calc(1.5rem + ${safeInset}px)` : undefined,
            }}
          >
            <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
                {title}
              </DialogTitle>
              {headerAction ?? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="关闭"
                  disabled={closeDisabled}
                  onClick={onClose}
                  className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              )}
            </DialogHeader>
            {children}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <section
      aria-label={title}
      role="region"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
    >
      <div
        className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-2 py-2 backdrop-blur-xs"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))" }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="返回"
          disabled={backDisabled}
          onClick={onGoBack}
          className="size-11 shrink-0 rounded-full text-foreground"
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
          <span className="sr-only">返回</span>
        </Button>
        <h2 className="m-0 truncate text-base font-semibold tracking-tight text-foreground">
          {title}
        </h2>
      </div>
      {reauthBanner}
      <div
        className="mx-auto w-full max-w-lg space-y-5 px-5 py-6"
        style={{
          paddingBottom:
            safeInset > 0
              ? `calc(1.5rem + ${safeInset}px)`
              : "max(1.5rem, env(safe-area-inset-bottom, 0px))",
        }}
      >
        {children}
      </div>
    </section>
  );
}
