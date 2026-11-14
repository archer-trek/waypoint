import type { FormEvent } from "react";

export type ExitConfirmDialogProps = {
  exiting: boolean;
  onConfirmExit: () => void;
  onCancelExit: () => void;
};

/** Confirmation dialog rendered before clearing local session state on device exit. */
export function ExitConfirmDialog({
  exiting,
  onConfirmExit,
  onCancelExit,
}: ExitConfirmDialogProps) {
  return (
    <div
      role="alertdialog"
      aria-label="确认退出这台设备"
      className="waypoint-agents-form"
    >
      <h4>确认退出这台设备</h4>
      <p>退出将清空这台设备上的本地时间线、未发送草稿和重试队列。</p>
      <div className="waypoint-form-actions">
        <button type="button" disabled={exiting} onClick={onConfirmExit}>
          {exiting ? "正在退出…" : "确认退出"}
        </button>
        <button type="button" disabled={exiting} onClick={onCancelExit}>
          取消
        </button>
      </div>
    </div>
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
  return (
    <section
      role="status"
      aria-label="重新验证提示"
      className="waypoint-reauth-banner"
    >
      <div className="waypoint-reauth-banner-row">
        <p className="waypoint-reauth-banner-text">
          服务器不认这台设备的登录，已暂停同步与发送，本地时间线、草稿和重试队列仍保留。
        </p>
        <div className="waypoint-reauth-banner-actions">
          <button
            type="button"
            disabled={exiting || reauthSubmitting}
            onClick={onOpenReauthForm}
          >
            重新验证
          </button>
          <button
            type="button"
            disabled={exiting || reauthSubmitting}
            onClick={onOpenExitConfirm}
          >
            退出这台设备
          </button>
        </div>
      </div>
      {reauthOpen ? (
        <form
          aria-label="重新验证"
          className="waypoint-reauth-form"
          onSubmit={onReauthSubmit}
        >
          <label>
            Homeserver 地址
            <input name="reauth-address" value={address} readOnly disabled />
          </label>
          <label>
            用户 ID
            <input name="reauth-user-id" value={ownerId} readOnly disabled />
          </label>
          <label>
            密码
            <input
              name="reauth-password"
              type="password"
              value={reauthPassword}
              disabled={reauthSubmitting || exiting}
              onChange={(event) => onReauthPasswordChange(event.target.value)}
            />
          </label>
          {reauthError ? <p role="alert">{reauthError}</p> : null}
          <div className="waypoint-form-actions">
            <button type="submit" disabled={reauthSubmitting || exiting}>
              {reauthSubmitting ? "正在验证…" : "确认验证"}
            </button>
            <button
              type="button"
              disabled={reauthSubmitting || exiting}
              onClick={onCloseReauthForm}
            >
              取消
            </button>
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
