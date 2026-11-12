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

function actionFailedPrefix(action: string): string {
  return /[A-Za-z0-9]$/.test(action) ? `${action} 失败` : `${action}失败`;
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
