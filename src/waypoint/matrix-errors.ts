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

export function disconnectedMessage(_action: string): string {
  return "尚未连接到服务器，请先登录。";
}

export function isRateLimited(status: number, body: unknown): boolean {
  return status === 429 || errcode(body) === "M_LIMIT_EXCEEDED";
}

export function isAbortedFailure(result: TransportResult): boolean {
  return result.type === "failure" && result.failure.type === "aborted";
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

export function credentialRejectedMessage(_action: string, result: TransportResult): string {
  const body = result.type === "response" ? result.body : undefined;
  return errcode(body) === "M_USER_DEACTIVATED"
    ? "该账号已停用。"
    : "当前设备登录已失效，请重新登录。";
}

export function transportFailureMessage(action: string, failure: TransportFailure): string {
  switch (failure.type) {
    case "timeout":
      return action === "确认 Homeserver" || action === "同步" || action === "登录"
        ? "连接超时，请稍后重试。"
        : `${/[A-Za-z0-9]$/.test(action) ? `${action} 超时` : `${action}超时`}，请稍后重试。`;
    case "untrusted-certificate":
      return "服务器证书不受信任，无法建立连接。";
    case "hostname-mismatch":
      return "服务器证书与当前域名不匹配。";
    case "https-unavailable":
      return "无法与该服务器建立安全的 HTTPS 连接。";
    case "network":
      return "无法连接到服务器，请检查网络或地址。";
    case "aborted":
      return "操作已取消。";
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
  if (isRateLimited(result.status, result.body)) {
    return "请求过于频繁，请稍后再试。";
  }
  if (result.status >= 500) {
    return options?.serverErrorReason ?? "服务器暂时无法响应，请稍后重试。";
  }
  if (options?.fallbackMessage) {
    return options.fallbackMessage;
  }
  return options?.rejectedReason ?? `${action}被服务器拒绝，请稍后重试。`;
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
  rejectedCredentialLabel = "用户名或密码不正确",
): { message: string; clearPassword: boolean } {
  if (result.type === "response" && isRecord(result.body) && isInteractiveLogin(result.body)) {
    return {
      message: "该服务器需要验证码或其他交互式验证，暂不支持登录。",
      clearPassword: false,
    };
  }
  if (result.type === "response" && errcode(result.body) === "M_USER_DEACTIVATED") {
    return {
      message: "该账号已停用。",
      clearPassword: true,
    };
  }
  if (result.type === "response" && isRateLimited(result.status, result.body)) {
    return {
      message: "请求过于频繁，请稍后再试。",
      clearPassword: false,
    };
  }
  if (
    result.type === "response" &&
    (errcode(result.body) === "M_FORBIDDEN" || errcode(result.body) === "M_UNAUTHORIZED")
  ) {
    return {
      message: `${rejectedCredentialLabel}。`,
      clearPassword: true,
    };
  }
  if (result.type === "failure") {
    return { message: transportFailureMessage(action, result.failure), clearPassword: false };
  }
  if (result.type === "response" && result.status === 200) {
    return { message: "服务器返回的登录信息不完整，请稍后重试。", clearPassword: false };
  }
  if (result.type === "response" && result.status >= 500) {
    return {
      message: "服务器暂时无法响应，请稍后重试。",
      clearPassword: false,
    };
  }
  return { message: "服务器返回的登录信息不完整，请稍后重试。", clearPassword: false };
}
