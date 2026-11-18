import { useState, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type DiscardChangesDialogProps = {
  open: boolean;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
};

/** Shared confirmation AlertDialog guarding unsaved form input before discarding. */
export function DiscardChangesDialog({
  open,
  onConfirmDiscard,
  onCancelDiscard,
}: DiscardChangesDialogProps) {
  if (!open) {
    return null;
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancelDiscard();
        }
      }}
    >
      <AlertDialogContent
        role="alertdialog"
        aria-label="放弃未保存的更改吗？"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>放弃未保存的更改吗？</AlertDialogTitle>
          <AlertDialogDescription>
            当前输入的内容将不会被保存。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancelDiscard}>
            继续编辑
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }), "min-h-11 sm:min-h-9")}
            onClick={onConfirmDiscard}
          >
            放弃更改
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ResponsiveFormShellContext = {
  requestExit: (action: () => void) => void;
};

export type ResponsiveFormShellProps = {
  title: string;
  isModal: boolean;
  isNarrow: boolean;
  safeInset: number;
  isDirty?: boolean;
  closeDisabled?: boolean;
  backDisabled?: boolean;
  nestedModalOpen?: boolean;
  reauthBanner?: ReactNode;
  headerAction?: ReactNode | ((ctx: ResponsiveFormShellContext) => ReactNode);
  onClose: () => void;
  onGoBack: () => void;
  onRequestExit?: (action: () => void) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode | ((ctx: ResponsiveFormShellContext) => ReactNode);
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
  isDirty = false,
  closeDisabled = false,
  backDisabled = false,
  nestedModalOpen = false,
  reauthBanner,
  headerAction,
  onClose,
  onGoBack,
  onRequestExit,
  onEscapeKeyDown,
  children,
}: ResponsiveFormShellProps) {
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);

  function requestExit(action: () => void) {
    if (onRequestExit) {
      onRequestExit(action);
      return;
    }
    if (isDirty) {
      setPendingExit(() => action);
      setConfirmDiscardOpen(true);
    } else {
      action();
    }
  }

  function handleConfirmDiscard() {
    setConfirmDiscardOpen(false);
    const action = pendingExit;
    setPendingExit(null);
    action?.();
  }

  function handleCancelDiscard() {
    setConfirmDiscardOpen(false);
    setPendingExit(null);
  }

  const discardDialog = !onRequestExit ? (
    <DiscardChangesDialog
      open={confirmDiscardOpen}
      onConfirmDiscard={handleConfirmDiscard}
      onCancelDiscard={handleCancelDiscard}
    />
  ) : null;

  const ctx: ResponsiveFormShellContext = { requestExit };
  const renderedHeaderAction =
    typeof headerAction === "function" ? headerAction(ctx) : headerAction;
  const renderedChildren =
    typeof children === "function" ? children(ctx) : children;

  if (isModal && !isNarrow) {
    const blockDismiss = closeDisabled || nestedModalOpen;
    return (
      <>
        {discardDialog}
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !blockDismiss) {
              requestExit(onClose);
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
                requestExit(onClose);
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
              className="space-y-5 p-6 transition-[padding-bottom] duration-280 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
              style={{
                paddingBottom:
                  safeInset > 0 ? `calc(1.5rem + ${safeInset}px)` : undefined,
              }}
            >
              <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0">
                <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
                  {title}
                </DialogTitle>
                {renderedHeaderAction ?? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="关闭"
                    disabled={closeDisabled}
                    onClick={() => requestExit(onClose)}
                    className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </DialogHeader>
              {renderedChildren}
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      {discardDialog}
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
            onClick={() => requestExit(onGoBack)}
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
          {renderedChildren}
        </div>
      </section>
    </>
  );
}
