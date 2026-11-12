import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Clock,
  HomeserverTransport,
  PlatformAdapter,
  TransportResult,
} from "../adapters/types";
import { MatrixClient } from "./matrix-client";

type Phase =
  | { name: "booting" }
  | { name: "address"; address: string; message?: string }
  | { name: "password"; address: string; userId: string; password: string; message?: string }
  | { name: "syncing"; address: string; userId: string; message?: string }
  | { name: "holding" }
  | { name: "topics" };

export function WaypointApp({
  homeserver,
  platform,
  clock,
}: {
  homeserver: HomeserverTransport;
  platform: PlatformAdapter;
  clock: Clock;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "booting" });
  const clientRef = useRef<MatrixClient | undefined>(undefined);

  function client(): MatrixClient {
    if (!clientRef.current) {
      clientRef.current = new MatrixClient(homeserver);
    }
    return clientRef.current;
  }
  const retryTimer = useRef<number | undefined>(undefined);
  const backoffStep = useRef(0);
  const syncGeneration = useRef(0);
  const epoch = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await client().restore();
      if (cancelled) {
        return;
      }
      const matrix = client();
      if (restored === "sync") {
        setPhase({ name: "syncing", address: matrix.address, userId: matrix.ownerId });
        void syncNow();
        return;
      }
      if (restored === "password") {
        setPhase({
          name: "password",
          address: matrix.address,
          userId: matrix.ownerId,
          password: "",
        });
        return;
      }
      setPhase({ name: "address", address: "" });
    })();
    return () => {
      cancelled = true;
      epoch.current += 1;
      if (retryTimer.current !== undefined) {
        clock.clearTimeout(retryTimer.current);
        retryTimer.current = undefined;
      }
    };
  }, [clock]);

  function clearRetry() {
    if (retryTimer.current !== undefined) {
      clock.clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    }
  }

  function scheduleRetry() {
    clearRetry();
    const delay = BACKOFF_MS[Math.min(backoffStep.current, BACKOFF_MS.length - 1)];
    backoffStep.current += 1;
    retryTimer.current = clock.setTimeout(() => {
      retryTimer.current = undefined;
      void syncNow();
    }, delay);
  }

  function syncIsCurrent(myEpoch: number, generation: number): boolean {
    return epoch.current === myEpoch && syncGeneration.current === generation;
  }

  async function syncNow() {
    const matrix = client();
    if (!matrix.hasToken) {
      return;
    }
    const myEpoch = epoch.current;
    const generation = ++syncGeneration.current;
    clearRetry();
    const attempt = await matrix.sync();
    if (!syncIsCurrent(myEpoch, generation)) {
      return;
    }
    const sync = attempt.result;
    if (isCredentialRejected(sync)) {
      backoffStep.current = 0;
      const address = matrix.address;
      const userId = matrix.ownerId;
      await matrix.forgetCredential();
      if (!syncIsCurrent(myEpoch, generation)) {
        return;
      }
      setPhase({
        name: "password",
        address,
        userId,
        password: "",
        message:
          errcode(sync.type === "response" ? sync.body : undefined) === "M_USER_DEACTIVATED"
            ? sentence("同步失败，因为账号已停用", errorText(sync.type === "response" ? sync.body : undefined))
            : sentence("同步失败，因为服务器不认这台设备的登录", errorText(sync.type === "response" ? sync.body : undefined)),
      });
      return;
    }
    if (sync.type === "response" && sync.status === 200) {
      backoffStep.current = 0;
      await matrix.retainSync(attempt);
      if (!syncIsCurrent(myEpoch, generation)) {
        return;
      }
      setPhase(
        hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)
          ? { name: "topics" }
          : { name: "holding" },
      );
      return;
    }
    setPhase({
      name: "syncing",
      address: matrix.address,
      userId: matrix.ownerId,
      message: syncFailureMessage(sync),
    });
    scheduleRetry();
  }

  function submitAddress(event: FormEvent) {
    event.preventDefault();
    if (phase.name !== "address") {
      return;
    }
    const baseUrl = normalizeBaseUrl(phase.address);
    if (!baseUrl) {
      setPhase({
        ...phase,
        message: "确认 Homeserver 失败，因为只接受完整的 https 地址。",
      });
      return;
    }
    setPhase({ name: "address", address: baseUrl });
    void confirmHomeserver(baseUrl);
  }

  async function confirmHomeserver(baseUrl: string) {
    const result = await client().versions(baseUrl);
    const message = versionsOutcome(result);
    if (!message) {
      setPhase({ name: "password", address: baseUrl, userId: "", password: "" });
      return;
    }
    setPhase({ name: "address", address: baseUrl, message });
  }

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (phase.name !== "password") {
      return;
    }
    const identifier = classifyIdentifier(phase.userId);
    if (identifier.kind === "empty") {
      setPhase({ ...phase, message: "登录失败，因为用户标识是空的。" });
      return;
    }
    if (identifier.kind === "rejected") {
      setPhase({
        ...phase,
        userId: phase.userId.trim(),
        message: "登录失败，因为用户标识只能是 localpart 或完整用户 ID，不接受邮箱或电话。",
      });
      return;
    }
    const next = { ...phase, userId: identifier.user, message: undefined };
    setPhase(next);
    void beginLogin(next.address, identifier.user, phase.password);
  }

  async function beginLogin(address: string, user: string, password: string) {
    const matrix = client();
    const flows = await matrix.loginFlows();
    if (!(flows.type === "response" && flows.status === 200)) {
      const failure = loginFailure(flows);
      setPhase((prev) =>
        prev.name === "password"
          ? {
              ...prev,
              password: failure.clearPassword ? "" : prev.password,
              message: failure.message,
            }
          : prev,
      );
      return;
    }
    if (!hasPasswordLogin(flows.body)) {
      setPhase((prev) =>
        prev.name === "password"
          ? { ...prev, message: "登录失败，因为这台 Homeserver 没有密码登录，这不是密码错误。" }
          : prev,
      );
      return;
    }
    const login = await matrix.passwordLogin(user, password, platform.deviceDisplayName);
    const session = loginSuccess(login);
    if (!session) {
      const failure = loginFailure(login);
      setPhase((prev) =>
        prev.name === "password"
          ? {
              ...prev,
              password: failure.clearPassword ? "" : prev.password,
              message: failure.message,
            }
          : prev,
      );
      return;
    }
    await matrix.rememberLogin(session.userId, session.accessToken, session.deviceId);
    setPhase({ name: "syncing", address, userId: session.userId });
    await syncNow();
  }

  if (phase.name === "topics") {
    return (
      <main>
        <p>已连接</p>
        <h1>Topic</h1>
        <p>暂无 Topic</p>
      </main>
    );
  }

  return (
    <main>
      <p>尚未进入 Topic 列表</p>
      {phase.name === "address" ? (
        <form onSubmit={submitAddress}>
          <label>
            Homeserver 地址
            <input
              name="address"
              value={phase.address}
              onChange={(event) =>
                setPhase({ name: "address", address: event.target.value })
              }
            />
          </label>
          <button type="submit">继续</button>
        </form>
      ) : phase.name === "password" ? (
        <form onSubmit={submitPassword}>
          <p>{phase.address}</p>
          <label>
            用户标识
            <input
              name="user-id"
              value={phase.userId}
              onChange={(event) =>
                setPhase({ ...phase, userId: event.target.value })
              }
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              value={phase.password}
              onChange={(event) =>
                setPhase({ ...phase, password: event.target.value })
              }
            />
          </label>
          <button type="submit">用密码登录</button>
        </form>
      ) : phase.name === "syncing" ? (
        <button type="button" onClick={() => { void syncNow(); }}>立刻再试</button>
      ) : null}
      {"message" in phase && phase.message ? <p role="alert">{phase.message}</p> : null}
    </main>
  );
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function isCredentialRejected(result: TransportResult): boolean {
  if (result.type !== "response") {
    return false;
  }
  const code = errcode(result.body);
  return code === "M_UNKNOWN_TOKEN" || code === "M_USER_DEACTIVATED";
}

function syncFailureMessage(result: TransportResult): string {
  if (result.type === "failure") {
    if (result.failure.type === "timeout") {
      return "同步失败，因为超时。";
    }
    if (result.failure.type === "untrusted-certificate") {
      return "同步失败，因为到达不了，证书不受信任。";
    }
    if (result.failure.type === "hostname-mismatch") {
      return "同步失败，因为到达不了，主机名对不上。";
    }
    if (result.failure.type === "https-unavailable") {
      return "同步失败，因为到达不了，HTTPS 建不起来。";
    }
    return "同步失败，因为到达不了。";
  }
  if (isRateLimited(result.status, result.body)) {
    return sentence("同步失败，因为被限流", errorText(result.body));
  }
  if (result.status >= 500) {
    return sentence("同步失败，因为 Homeserver 暂时不能完成同步", errorText(result.body));
  }
  return "同步失败，因为到达不了。";
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const stripped = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (!stripped) {
    return null;
  }
  try {
    const url = new URL(stripped);
    if (url.protocol !== "https:" || url.hostname === "") {
      return null;
    }
  } catch {
    return null;
  }
  return stripped;
}

function hasUsableVersions(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const versions = (body as { versions?: unknown }).versions;
  return Array.isArray(versions) && versions.length > 0;
}

function versionsOutcome(result: TransportResult): string | undefined {
  if (result.type === "failure") {
    switch (result.failure.type) {
      case "untrusted-certificate":
        return "确认 Homeserver 失败，因为到达不了，证书不受信任。";
      case "hostname-mismatch":
        return "确认 Homeserver 失败，因为到达不了，主机名对不上。";
      case "https-unavailable":
        return "确认 Homeserver 失败，因为到达不了，HTTPS 建不起来。";
      case "timeout":
        return "确认 Homeserver 失败，因为超时。";
      case "network":
        return "确认 Homeserver 失败，因为到达不了。";
    }
  }
  if (isRateLimited(result.status, result.body)) {
    return sentence("确认 Homeserver 失败，因为被限流", errorText(result.body));
  }
  if (result.status === 200 && hasUsableVersions(result.body)) {
    return undefined;
  }
  return "确认 Homeserver 失败，因为这不是 Matrix Homeserver。";
}

function isRateLimited(status: number, body: unknown): boolean {
  return status === 429 || errcode(body) === "M_LIMIT_EXCEEDED";
}

function errcode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("errcode" in body)) {
    return undefined;
  }
  const value = (body as { errcode?: unknown }).errcode;
  return typeof value === "string" ? value : undefined;
}

function errorText(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const value = (body as { error?: unknown }).error;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sentence(reason: string, serverError?: string): string {
  if (serverError) {
    return `${reason}：${serverError}。`;
  }
  return `${reason}。`;
}

function classifyIdentifier(raw: string):
  | { kind: "empty" }
  | { kind: "rejected" }
  | { kind: "ok"; user: string } {
  const user = raw.trim();
  if (!user) {
    return { kind: "empty" };
  }
  if (isFullUserId(user) || isLocalpart(user)) {
    return { kind: "ok", user };
  }
  return { kind: "rejected" };
}

function isFullUserId(user: string): boolean {
  if (!user.startsWith("@")) {
    return false;
  }
  const colon = user.indexOf(":");
  return colon > 1 && user.slice(colon + 1).trim() !== "" && !/\s/.test(user);
}

function isLocalpart(user: string): boolean {
  if (user.includes("@") || user.includes(":") || /\s/.test(user)) {
    return false;
  }
  if (user.startsWith("+")) {
    return false;
  }
  const digits = user.replace(/\D/g, "");
  if (/^[\d\s().-]+$/.test(user) && digits.length >= 7) {
    return false;
  }
  return user.length > 0;
}

function hasPasswordLogin(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("flows" in body)) {
    return false;
  }
  const flows = (body as { flows?: unknown }).flows;
  if (!Array.isArray(flows)) {
    return false;
  }
  return flows.some((flow) => {
    if (!flow || typeof flow !== "object" || !("type" in flow)) {
      return false;
    }
    return (flow as { type?: unknown }).type === "m.login.password";
  });
}

function loginSuccess(result: TransportResult):
  | { userId: string; accessToken: string; deviceId: string }
  | undefined {
  if (result.type !== "response" || result.status !== 200 || !isRecord(result.body)) {
    return undefined;
  }
  if (isInteractive(result.body)) {
    return undefined;
  }
  const userId = textField(result.body, "user_id");
  const accessToken = textField(result.body, "access_token");
  const deviceId = textField(result.body, "device_id");
  if (!userId || !accessToken || !deviceId) {
    return undefined;
  }
  return { userId, accessToken, deviceId };
}

function isInteractive(body: Record<string, unknown>): boolean {
  return typeof body.session === "string" && Array.isArray(body.flows);
}

function textField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasValidAgent(content: unknown, ownerUserId: string): boolean {
  if (!isRecord(content) || !Array.isArray(content.agents)) {
    return false;
  }
  const ownerServer = serverName(ownerUserId);
  if (!ownerServer) {
    return false;
  }
  return content.agents.some((agent) => {
    if (!isRecord(agent)) {
      return false;
    }
    const userId = agent.user_id;
    if (typeof userId !== "string" || !isFullUserId(userId) || userId === ownerUserId) {
      return false;
    }
    return serverName(userId) === ownerServer;
  });
}

function serverName(userId: string): string | undefined {
  const colon = userId.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const server = userId.slice(colon + 1);
  return server ? server : undefined;
}

function loginFailure(result: TransportResult): { message: string; clearPassword: boolean } {
  if (result.type === "response" && isRecord(result.body) && isInteractive(result.body)) {
    return {
      message: "登录失败，因为还要验证码或其他交互式验证，Waypoint 做不了。",
      clearPassword: false,
    };
  }
  if (result.type === "response" && errcode(result.body) === "M_USER_DEACTIVATED") {
    return {
      message: sentence("登录失败，因为账号已停用", errorText(result.body)),
      clearPassword: true,
    };
  }
  if (result.type === "response" && isRateLimited(result.status, result.body)) {
    return {
      message: sentence("登录失败，因为被限流", errorText(result.body)),
      clearPassword: false,
    };
  }
  if (
    result.type === "response" &&
    (errcode(result.body) === "M_FORBIDDEN" || errcode(result.body) === "M_UNAUTHORIZED")
  ) {
    return {
      message: sentence("登录失败，因为用户标识或密码被拒绝", errorText(result.body)),
      clearPassword: true,
    };
  }
  if (result.type === "failure") {
    if (result.failure.type === "timeout") {
      return { message: "登录失败，因为超时。", clearPassword: false };
    }
    if (result.failure.type === "untrusted-certificate") {
      return { message: "登录失败，因为到达不了，证书不受信任。", clearPassword: false };
    }
    if (result.failure.type === "hostname-mismatch") {
      return { message: "登录失败，因为到达不了，主机名对不上。", clearPassword: false };
    }
    if (result.failure.type === "https-unavailable") {
      return { message: "登录失败，因为到达不了，HTTPS 建不起来。", clearPassword: false };
    }
    return { message: "登录失败，因为到达不了。", clearPassword: false };
  }
  if (result.type === "response" && result.status === 200) {
    return { message: "登录失败，因为 Homeserver 没有返回完整的登录结果。", clearPassword: false };
  }
  if (result.type === "response" && result.status >= 500) {
    return {
      message: sentence("登录失败，因为 Homeserver 暂时不能完成登录", errorText(result.body)),
      clearPassword: false,
    };
  }
  return { message: "登录失败，因为 Homeserver 没有返回完整的登录结果。", clearPassword: false };
}
