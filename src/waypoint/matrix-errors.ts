import type { TransportFailure, TransportResult } from "../adapters/types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errcode(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const value = body.errcode;
  return typeof value === "string" ? value : undefined;
}

export function errorText(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const value = body.error;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function sentence(reason: string, serverError?: string): string {
  if (serverError) {
    return `${reason}：${serverError}。`;
  }
  return `${reason}。`;
}

export function actionFailedPrefix(action: string): string {
  return /[A-Za-z0-9]$/.test(action) ? `${action} 失败` : `${action}失败`;
}

export function disconnectedMessage(action: string): string {
  return `${actionFailedPrefix(action)}，因为尚未连接。`;
}

function becauseReason(reason: string): string {
  return /^[A-Za-z0-9]/.test(reason) ? `因为 ${reason}` : `因为${reason}`;
}

export function isRateLimited(status: number, body: unknown): boolean {
  return status === 429 || errcode(body) === "M_LIMIT_EXCEEDED";
}

export function isCredentialRejected(result: TransportResult): boolean {
  if (result.type !== "response") {
    return false;
  }
  const code = errcode(result.body);
  return code === "M_UNKNOWN_TOKEN" || code === "M_USER_DEACTIVATED";
}

export function isSyncCursorRejected(incremental: boolean, result: TransportResult): boolean {
  if (!incremental || result.type !== "response") {
    return false;
  }
  if (isCredentialRejected(result) || isRateLimited(result.status, result.body)) {
    return false;
  }
  return result.status === 400;
}

export function credentialRejectedMessage(action: string, result: TransportResult): string {
  const body = result.type === "response" ? result.body : undefined;
  const prefix = actionFailedPrefix(action);
  return errcode(body) === "M_USER_DEACTIVATED"
    ? sentence(`${prefix}，因为账号已停用`, errorText(body))
    : sentence(`${prefix}，因为服务器不认这台设备的登录`, errorText(body));
}

export function transportFailureMessage(action: string, failure: TransportFailure): string {
  const prefix = actionFailedPrefix(action);
  switch (failure.type) {
    case "timeout":
      return `${prefix}，因为超时。`;
    case "untrusted-certificate":
      return `${prefix}，因为到达不了，证书不受信任。`;
    case "hostname-mismatch":
      return `${prefix}，因为到达不了，主机名对不上。`;
    case "https-unavailable":
      return `${prefix}，因为到达不了，HTTPS 建不起来。`;
    case "network":
      return `${prefix}，因为到达不了。`;
  }
}

export function formatMatrixActionFailure(
  action: string,
  result: TransportResult,
  options?: {
    serverErrorReason?: string;
    rejectedReason?: string;
    fallbackMessage?: string;
  },
): string {
  if (result.type === "failure") {
    return transportFailureMessage(action, result.failure);
  }
  const prefix = actionFailedPrefix(action);
  if (isRateLimited(result.status, result.body)) {
    return sentence(`${prefix}，因为被限流`, errorText(result.body));
  }
  if (result.status >= 500) {
    return sentence(
      `${prefix}，${becauseReason(options?.serverErrorReason ?? "Homeserver 暂时不能完成请求")}`,
      errorText(result.body),
    );
  }
  if (options?.fallbackMessage) {
    return options.fallbackMessage;
  }
  return sentence(
    `${prefix}，${becauseReason(options?.rejectedReason ?? "Homeserver 拒绝了请求")}`,
    errorText(result.body),
  );
}

export function isInteractiveLogin(body: Record<string, unknown>): boolean {
  return typeof body.session === "string" && Array.isArray(body.flows);
}

function nonEmptyText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function extractLoginSession(result: TransportResult):
  | { userId: string; accessToken: string; deviceId?: string }
  | undefined {
  if (result.type !== "response" || result.status !== 200 || !isRecord(result.body)) {
    return undefined;
  }
  if (isInteractiveLogin(result.body)) {
    return undefined;
  }
  const userId = nonEmptyText(result.body, "user_id");
  const accessToken = nonEmptyText(result.body, "access_token");
  const deviceId = nonEmptyText(result.body, "device_id");
  if (!userId || !accessToken) {
    return undefined;
  }
  return { userId, accessToken, ...(deviceId ? { deviceId } : {}) };
}

export function isDeviceIdRejected(result: TransportResult): boolean {
  if (result.type !== "response" || result.status < 400 || result.status >= 500) {
    return false;
  }
  if (isRateLimited(result.status, result.body)) {
    return false;
  }
  const code = errcode(result.body);
  if (code === "M_USER_DEACTIVATED" || code === "M_UNAUTHORIZED") {
    return false;
  }
  if (code === "M_INVALID_PARAM" || code === "M_UNKNOWN_DEVICE" || code === "M_BAD_DEVICE_ID") {
    return true;
  }
  const msg = errorText(result.body) ?? "";
  return /device[_\s-]?id|\bdevice\b/i.test(msg);
}

export function classifyLoginFailure(
  result: TransportResult,
  action = "登录",
  rejectedCredentialLabel = "用户标识或密码被拒绝",
): { message: string; clearPassword: boolean } {
  const prefix = actionFailedPrefix(action);
  if (result.type === "response" && isRecord(result.body) && isInteractiveLogin(result.body)) {
    return {
      message: `${prefix}，因为还要验证码或其他交互式验证，Waypoint 做不了。`,
      clearPassword: false,
    };
  }
  if (result.type === "response" && errcode(result.body) === "M_USER_DEACTIVATED") {
    return {
      message: sentence(`${prefix}，因为账号已停用`, errorText(result.body)),
      clearPassword: true,
    };
  }
  if (result.type === "response" && isRateLimited(result.status, result.body)) {
    return {
      message: sentence(`${prefix}，因为被限流`, errorText(result.body)),
      clearPassword: false,
    };
  }
  if (
    result.type === "response" &&
    (errcode(result.body) === "M_FORBIDDEN" || errcode(result.body) === "M_UNAUTHORIZED")
  ) {
    return {
      message: sentence(`${prefix}，因为${rejectedCredentialLabel}`, errorText(result.body)),
      clearPassword: true,
    };
  }
  if (result.type === "failure") {
    return { message: transportFailureMessage(action, result.failure), clearPassword: false };
  }
  if (result.type === "response" && result.status === 200) {
    return { message: `${prefix}，因为 Homeserver 没有返回完整的登录结果。`, clearPassword: false };
  }
  if (result.type === "response" && result.status >= 500) {
    return {
      message: sentence(`${prefix}，因为 Homeserver 暂时不能完成${action}`, errorText(result.body)),
      clearPassword: false,
    };
  }
  return { message: `${prefix}，因为 Homeserver 没有返回完整的登录结果。`, clearPassword: false };
}
