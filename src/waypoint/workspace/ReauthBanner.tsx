import type { FormEvent } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type ExitConfirmDialogProps = {
  exiting: boolean;
  onConfirmExit: () => void;
  onCancelExit: () => void;
};

/** Centered AlertDialog rendered before clearing local session state on device exit. */
export function ExitConfirmDialog({
  exiting,
  onConfirmExit,
  onCancelExit,
}: ExitConfirmDialogProps) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !exiting) {
          onCancelExit();
        }
      }}
    >
      <AlertDialogContent
        aria-label="确认退出这台设备"
        onEscapeKeyDown={(event) => {
          if (exiting) {
            event.preventDefault();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>确认退出这台设备</AlertDialogTitle>
          <AlertDialogDescription>
            退出将清空这台设备上的本地时间线、未发送草稿和重试队列。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            className="min-h-11 sm:min-h-9"
            disabled={exiting}
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              buttonVariants({ variant: "destructive" }),
              "min-h-11 sm:min-h-9",
            )}
            disabled={exiting}
            onClick={(event) => {
              event.preventDefault();
              onConfirmExit();
            }}
          >
            {exiting ? "正在退出…" : "确认退出"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ReauthBannerProps = {
  address: string;
  ownerId: string;
  reauthOpen: boolean;
  reauthPassword: string;
  reauthSubmitting: boolean;
  reauthError?: string;
  exiting: boolean;
  showInlineExitConfirm: boolean;
  onOpenReauthForm: () => void;
  onCloseReauthForm: () => void;
  onReauthPasswordChange: (password: string) => void;
  onReauthSubmit: (event: FormEvent) => void;
  onOpenExitConfirm: () => void;
  onConfirmExit: () => void;
  onCancelExit: () => void;
};

/** Silent top-bar banner shown when the homeserver rejects the active token. */
export function ReauthBanner({
  address,
  ownerId,
  reauthOpen,
  reauthPassword,
  reauthSubmitting,
  reauthError,
  exiting,
  showInlineExitConfirm,
  onOpenReauthForm,
  onCloseReauthForm,
  onReauthPasswordChange,
  onReauthSubmit,
  onOpenExitConfirm,
  onConfirmExit,
  onCancelExit,
}: ReauthBannerProps) {
  const busy = exiting || reauthSubmitting;

  return (
    <section
      role="status"
      aria-label="重新验证提示"
      className="shrink-0 border-b border-warning-border bg-warning px-4 py-3 text-warning-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-warning-foreground"
            aria-hidden="true"
          />
          <p className="m-0 text-sm leading-snug">
            服务器不认这台设备的登录，已暂停同步与发送，本地时间线、草稿和重试队列仍保留。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-warning-border bg-background/80 text-foreground hover:bg-background"
            disabled={busy}
            onClick={onOpenReauthForm}
          >
            重新验证
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-warning-foreground hover:bg-background/40 hover:text-warning-foreground"
            disabled={busy}
            onClick={onOpenExitConfirm}
          >
            退出这台设备
          </Button>
        </div>
      </div>

      {reauthOpen ? (
        <form
          aria-label="重新验证"
          className="mt-3 space-y-3 rounded-xl border border-warning-border bg-card p-4 text-card-foreground shadow-xs"
          onSubmit={onReauthSubmit}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="reauth-address">Homeserver 地址</Label>
            <Input
              id="reauth-address"
              name="reauth-address"
              value={address}
              readOnly
              disabled
              className="h-10 bg-muted font-mono text-xs select-text"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reauth-user-id">用户 ID</Label>
            <Input
              id="reauth-user-id"
              name="reauth-user-id"
              value={ownerId}
              readOnly
              disabled
              className="h-10 bg-muted font-mono text-xs select-text"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reauth-password">密码</Label>
            <Input
              id="reauth-password"
              name="reauth-password"
              type="password"
              value={reauthPassword}
              disabled={busy}
              onChange={(event) => onReauthPasswordChange(event.target.value)}
              className="h-10 bg-background select-text"
            />
          </div>
          {reauthError ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{reauthError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              disabled={busy}
              onClick={onCloseReauthForm}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="min-h-11 sm:min-h-9"
              disabled={busy}
            >
              {reauthSubmitting ? "正在验证…" : "确认验证"}
            </Button>
          </div>
        </form>
      ) : null}

      {showInlineExitConfirm ? (
        <ExitConfirmDialog
          exiting={exiting}
          onConfirmExit={onConfirmExit}
          onCancelExit={onCancelExit}
        />
      ) : null}
    </section>
  );
}
