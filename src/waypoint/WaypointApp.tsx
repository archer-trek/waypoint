import "../App.css";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { normalizeInset } from "../adapters/inset";
import type {
  Clock,
  HomeserverTransport,
  PlatformAdapter,
  TransportResult,
  ViewportMode,
} from "../adapters/types";
import { MatrixClient } from "./matrix-client";
import { RetryQueue } from "./retry-queue";
import {
  credentialRejectedMessage,
  isAbortedFailure,
  errcode,
  errorText,
  formatMatrixActionFailure,
  isCredentialRejected,
  isRateLimited,
  isRecord,
  isSyncCursorRejected,
  sentence,
  transportFailureMessage,
} from "./matrix-errors";
import { TopicsWorkspace } from "./TopicsWorkspace";
import { deriveRoomAvailability, isFullUserId, parseRegisteredAgents, validateAgentUserId } from "./topics";

let liveAppInstanceToken: symbol | null = null;

type Phase =
  | { name: "booting" }
  | { name: "address"; address: string; message?: string }
  | { name: "password"; address: string; userId: string; password: string; message?: string }
  | { name: "syncing"; address: string; userId: string; message?: string }
  | {
      name: "register";
      address: string;
      userId: string;
      agentUserId: string;
      submitting: boolean;
      message?: string;
    }
  | { name: "topics"; initialReauthRequired?: boolean };

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
  const [viewportMode, setViewportMode] = useState<ViewportMode>(() =>
    platform.viewportMode ? platform.viewportMode() : "wide",
  );
  const [keyboardInsetBottom, setKeyboardInsetBottom] = useState<number>(() =>
    normalizeInset(platform.keyboardInsetBottom ? platform.keyboardInsetBottom() : 0),
  );
  const [duplicateInstance, setDuplicateInstance] = useState(false);
  const clientRef = useRef<MatrixClient | undefined>(undefined);
  const retryQueueRef = useRef<RetryQueue | undefined>(undefined);

  function client(): MatrixClient {
    if (!clientRef.current) {
      clientRef.current = new MatrixClient(homeserver);
    }
    return clientRef.current;
  }

  const isRoomUnavailable = (roomId: string) =>
    deriveRoomAvailability(client().rooms()[roomId], client().ownerId).unavailable;

  function retryQueue(): RetryQueue {
    if (!retryQueueRef.current) {
      retryQueueRef.current = new RetryQueue(client(), clock);
      retryQueueRef.current.setCallbacks({ isRoomUnavailable });
    }
    return retryQueueRef.current;
  }

  const retryTimer = useRef<number | undefined>(undefined);
  const backoffStep = useRef(0);
  const syncGeneration = useRef(0);
  const epoch = useRef(0);
  const syncAbortControllerRef = useRef<AbortController | null>(null);
  const abandoning = useRef(false);
  const exiting = useRef(false);
  const phaseNameRef = useRef(phase.name);
  phaseNameRef.current = phase.name;
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const suspendInBackground = shouldSuspendSyncInBackground(platform);
  const readAppVisible = () => {
    const p = platformRef.current;
    if (p.isAppVisible) {
      return p.isAppVisible();
    }
    if (typeof document !== "undefined") {
      return document.visibilityState !== "hidden";
    }
    return true;
  };
  const backgroundSuspendedRef = useRef(suspendInBackground && !readAppVisible());

  useEffect(() => {
    setViewportMode(platform.viewportMode ? platform.viewportMode() : "wide");
    if (!platform.subscribeViewportMode) {
      return undefined;
    }
    return platform.subscribeViewportMode((mode) => {
      setViewportMode(mode);
    });
  }, [platform]);

  useEffect(() => {
    setKeyboardInsetBottom(
      normalizeInset(platform.keyboardInsetBottom ? platform.keyboardInsetBottom() : 0),
    );
    if (!platform.subscribeKeyboardInsetBottom) {
      return undefined;
    }
    return platform.subscribeKeyboardInsetBottom((inset) => {
      setKeyboardInsetBottom(normalizeInset(inset));
    });
  }, [platform]);

  useEffect(() => {
    if (liveAppInstanceToken !== null) {
      setDuplicateInstance(true);
      platformRef.current.focusMainWindow?.();
      return;
    }
    const myToken = Symbol("waypoint-app-instance");
    liveAppInstanceToken = myToken;
    setDuplicateInstance(false);

    let cancelled = false;
    void (async () => {
      const restored = await client().restore();
      if (cancelled) {
        return;
      }
      const matrix = client();
      if (restored === "sync") {
        setPhase({ name: "syncing", address: matrix.address, userId: matrix.ownerId });
        const suspended = shouldSuspendSyncInBackground(platformRef.current) && !readAppVisible();
        backgroundSuspendedRef.current = suspended;
        if (hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)) {
          retryQueue().setCallbacks({
            isRoomUnavailable,
            onCredentialRejected: () => {
              if (!cancelled) {
                syncGeneration.current += 1;
                syncAbortControllerRef.current?.abort();
                syncAbortControllerRef.current = null;
                clearRetry();
                backoffStep.current = 0;
                setPhase({ name: "topics", initialReauthRequired: true });
              }
            },
          });
          if (suspended) {
            retryQueue().pause();
          } else if (matrix.pendingRoomEvents().length > 0 || matrix.pendingReadMarkers().length > 0) {
            void retryQueue().flush();
          }
        }
        if (!suspended) {
          void syncNow();
        }
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
      syncAbortControllerRef.current?.abort();
      syncAbortControllerRef.current = null;
      retryQueueRef.current?.dispose();
      if (liveAppInstanceToken === myToken) {
        liveAppInstanceToken = null;
      }
    };
  }, [clock]);

  useEffect(() => {
    const handleVisibility = (visible: boolean) => {
      if (!shouldSuspendSyncInBackground(platform)) {
        return;
      }
      if (!visible) {
        backgroundSuspendedRef.current = true;
        if (phaseNameRef.current === "syncing") {
          syncGeneration.current += 1;
          syncAbortControllerRef.current?.abort();
          syncAbortControllerRef.current = null;
          clearRetry();
          retryQueue().pause();
        }
        return;
      }
      backgroundSuspendedRef.current = false;
      if (phaseNameRef.current !== "syncing") {
        return;
      }
      const matrix = client();
      if (!matrix.hasToken) {
        return;
      }
      backoffStep.current = 0;
      clearRetry();
      void syncNow();
      if (hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)) {
        retryQueue().resume();
        retryQueue().wake();
      }
    };
    const handleResume = () => {
      if (phaseNameRef.current !== "syncing" || backgroundSuspendedRef.current) {
        return;
      }
      const matrix = client();
      if (!matrix.hasToken) {
        return;
      }
      syncGeneration.current += 1;
      syncAbortControllerRef.current?.abort();
      syncAbortControllerRef.current = null;
      backoffStep.current = 0;
      clearRetry();
      void syncNow();
      if (hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)) {
        retryQueue().resume();
        retryQueue().wake();
      }
    };
    let unsubVisibility: () => void;
    if (platform.subscribeAppVisibility) {
      unsubVisibility = platform.subscribeAppVisibility(handleVisibility);
    } else {
      const onVis = () => handleVisibility(typeof document === "undefined" ? true : document.visibilityState !== "hidden");
      const onHide = () => handleVisibility(false);
      const onShow = () => handleVisibility(typeof document === "undefined" ? true : document.visibilityState !== "hidden");
      document?.addEventListener("visibilitychange", onVis);
      window?.addEventListener("pagehide", onHide);
      window?.addEventListener("pageshow", onShow);
      unsubVisibility = () => {
        document?.removeEventListener("visibilitychange", onVis);
        window?.removeEventListener("pagehide", onHide);
        window?.removeEventListener("pageshow", onShow);
      };
    }
    let unsubResume: () => void;
    if (platform.subscribeNetworkResume) {
      unsubResume = platform.subscribeNetworkResume(handleResume);
    } else {
      window.addEventListener("online", handleResume);
      unsubResume = () => window.removeEventListener("online", handleResume);
    }
    return () => {
      unsubVisibility();
      unsubResume();
    };
  }, [clock, platform]);

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

  async function abandon() {
    if (abandoning.current || (phase.name !== "syncing" && phase.name !== "register")) {
      return;
    }
    abandoning.current = true;
    const myEpoch = ++epoch.current;
    syncGeneration.current += 1;
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    clearRetry();
    backoffStep.current = 0;
    retryQueue().resume();
    const matrix = client();
    const address = matrix.address;
    const userId = matrix.ownerId;
    try {
      await matrix.abandonBeforeList();
      if (epoch.current !== myEpoch) {
        return;
      }
      setPhase({ name: "password", address, userId, password: "" });
    } finally {
      abandoning.current = false;
    }
  }

  async function exitDevice() {
    if (exiting.current || phase.name !== "topics") {
      return;
    }
    exiting.current = true;
    const myEpoch = ++epoch.current;
    syncGeneration.current += 1;
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    clearRetry();
    backoffStep.current = 0;
    retryQueue().pause();
    const matrix = client();
    const address = matrix.address;
    const userId = matrix.ownerId;
    try {
      await matrix.exitDevice();
      if (epoch.current !== myEpoch) {
        return;
      }
      setPhase({ name: "password", address, userId, password: "" });
    } finally {
      exiting.current = false;
    }
  }

  function syncIsCurrent(myEpoch: number, generation: number): boolean {
    return epoch.current === myEpoch && syncGeneration.current === generation;
  }

  async function syncNow() {
    const matrix = client();
    if (!matrix.hasToken || backgroundSuspendedRef.current) {
      return;
    }
    const myEpoch = epoch.current;
    const generation = ++syncGeneration.current;
    clearRetry();
    syncAbortControllerRef.current?.abort();
    const controller = new AbortController();
    syncAbortControllerRef.current = controller;
    let attempt;
    try {
      attempt = await matrix.sync({ signal: controller.signal });
      if (!syncIsCurrent(myEpoch, generation) || controller.signal.aborted || isAbortedFailure(attempt.result)) {
        return;
      }
      if (isSyncCursorRejected(attempt.incremental, attempt.result)) {
        await matrix.dropSyncCursor();
        if (!syncIsCurrent(myEpoch, generation) || controller.signal.aborted) {
          return;
        }
        attempt = await matrix.sync({ signal: controller.signal });
        if (!syncIsCurrent(myEpoch, generation) || controller.signal.aborted || isAbortedFailure(attempt.result)) {
          return;
        }
      }
    } finally {
      if (syncAbortControllerRef.current === controller) {
        syncAbortControllerRef.current = null;
      }
    }
    const sync = attempt.result;
    if (isCredentialRejected(sync)) {
      backoffStep.current = 0;
      if (hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)) {
        retryQueue().pause();
        setPhase({ name: "topics", initialReauthRequired: true });
        return;
      }
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
        message: credentialRejectedMessage("同步", sync),
      });
      return;
    }
    if (sync.type === "response" && sync.status === 200) {
      const wasBackedOff = backoffStep.current > 0;
      backoffStep.current = 0;
      await matrix.retainSync(attempt);
      if (!syncIsCurrent(myEpoch, generation)) {
        return;
      }
      await retryQueue().failUnavailablePendingEvents();
      if (!syncIsCurrent(myEpoch, generation)) {
        return;
      }
      if (wasBackedOff && retryQueue().isActive()) {
        retryQueue().wake();
      }
      setPhase(
        hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)
          ? { name: "topics" }
          : {
              name: "register",
              address: matrix.address,
              userId: matrix.ownerId,
              agentUserId: "",
              submitting: false,
            },
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

  function submitRegistration(event: FormEvent) {
    event.preventDefault();
    if (phase.name !== "register" || phase.submitting) {
      return;
    }
    const validation = validateAgentUserId(phase.agentUserId, phase.userId);
    if (!validation.ok) {
      setPhase({ ...phase, agentUserId: validation.trimmed, message: validation.message });
      return;
    }
    setPhase({
      ...phase,
      agentUserId: validation.userId,
      submitting: true,
      message: undefined,
    });
    void beginRegistration(validation.userId);
  }

  async function handlePreListCredentialRejection(
    myEpoch: number,
    action: string,
    result: TransportResult,
  ) {
    const matrix = client();
    const address = matrix.address;
    const userId = matrix.ownerId;
    await matrix.forgetCredential();
    if (epoch.current !== myEpoch) {
      return;
    }
    setPhase({
      name: "password",
      address,
      userId,
      password: "",
      message: credentialRejectedMessage(action, result),
    });
  }

  async function beginRegistration(agentUserId: string) {
    const matrix = client();
    const myEpoch = epoch.current;
    const ownerId = matrix.ownerId;
    const existing = await matrix.getAccountData("im.waypoint.agents");
    if (epoch.current !== myEpoch) {
      return;
    }
    if (isCredentialRejected(existing)) {
      await handlePreListCredentialRejection(myEpoch, "登记 Bot", existing);
      return;
    }
    if (existing.type === "response" && existing.status === 200 && hasValidAgent(existing.body, ownerId)) {
      await matrix.retainAccountData("im.waypoint.agents", existing.body);
      if (epoch.current !== myEpoch) {
        return;
      }
      setPhase({ name: "topics" });
      return;
    }
    if (!(existing.type === "response" && (existing.status === 200 || existing.status === 404))) {
      setPhase((prev) =>
        prev.name === "register"
          ? {
              ...prev,
              submitting: false,
              message: formatMatrixActionFailure("读取名册", existing),
            }
          : prev,
      );
      return;
    }
    const nextContent = nextAgentsContent(existing, agentUserId);
    const written = await matrix.putAccountData("im.waypoint.agents", nextContent);
    if (epoch.current !== myEpoch) {
      return;
    }
    if (isCredentialRejected(written)) {
      await handlePreListCredentialRejection(myEpoch, "登记 Bot", written);
      return;
    }
    if (written.type === "response" && written.status >= 200 && written.status < 300) {
      await matrix.retainAccountData("im.waypoint.agents", nextContent);
      if (epoch.current !== myEpoch) {
        return;
      }
      setPhase({ name: "topics" });
      return;
    }
    setPhase((prev) =>
      prev.name === "register"
        ? {
            ...prev,
            submitting: false,
            message: formatMatrixActionFailure("登记 Bot", written),
          }
        : prev,
    );
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
    retryQueue().resume();
    await matrix.rememberLogin(session.userId, session.accessToken, session.deviceId);
    setPhase({ name: "syncing", address, userId: session.userId });
    await syncNow();
  }

  if (duplicateInstance) {
    return (
      <main className="waypoint-auth-main">
        <p role="status">Waypoint 已在主窗口中运行，请切回主窗口继续。</p>
      </main>
    );
  }

  if (phase.name === "topics") {
    return (
      <TopicsWorkspace
        client={client()}
        clock={clock}
        retryQueue={retryQueue()}
        platform={platform}
        viewportMode={viewportMode}
        keyboardInsetBottom={keyboardInsetBottom}
        initialReauthRequired={phase.initialReauthRequired}
        onExitDevice={exitDevice}
      />
    );
  }

  return (
    <main
      className="waypoint-auth-main"
      style={
        {
          "--keyboard-inset": `${keyboardInsetBottom}px`,
          paddingBottom: keyboardInsetBottom > 0 ? `${keyboardInsetBottom}px` : undefined,
        } as CSSProperties
      }
    >
      <p>尚未进入 Topic 列表</p>
      {phase.name === "address" ? (
        <form onSubmit={submitAddress}>
          <label>
            Homeserver 地址
            <input
              name="address"
              value={phase.address}
              onChange={(event) => setPhase({ name: "address", address: event.target.value })}
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
              onChange={(event) => setPhase({ ...phase, userId: event.target.value })}
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              value={phase.password}
              onChange={(event) => setPhase({ ...phase, password: event.target.value })}
            />
          </label>
          <button type="submit">用密码登录</button>
          <button
            type="button"
            onClick={() => setPhase({ name: "address", address: phase.address })}
          >
            更改地址
          </button>
        </form>
      ) : phase.name === "syncing" ? (
        <>
          <button type="button" onClick={() => void syncNow()}>
            立刻再试
          </button>
          <button type="button" onClick={() => void abandon()}>
            放弃
          </button>
        </>
      ) : phase.name === "register" ? (
        <form onSubmit={submitRegistration}>
          <h1>登记 Bot</h1>
          <label>
            Matrix 用户 ID
            <input
              name="agent-user-id"
              value={phase.agentUserId}
              disabled={phase.submitting}
              onChange={(event) => setPhase({ ...phase, agentUserId: event.target.value })}
            />
          </label>
          <button type="submit" disabled={phase.submitting}>
            登记 Bot
          </button>
          <button type="button" onClick={() => void abandon()}>
            放弃
          </button>
        </form>
      ) : null}
      {"message" in phase && phase.message ? <p role="alert">{phase.message}</p> : null}
    </main>
  );
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function syncFailureMessage(result: TransportResult): string {
  return formatMatrixActionFailure("同步", result, {
    serverErrorReason: "Homeserver 暂时不能完成同步",
    fallbackMessage: "同步失败，因为到达不了。",
  });
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
    return transportFailureMessage("确认 Homeserver", result.failure);
  }
  if (isRateLimited(result.status, result.body)) {
    return sentence("确认 Homeserver 失败，因为被限流", errorText(result.body));
  }
  if (result.status === 200 && hasUsableVersions(result.body)) {
    return undefined;
  }
  return "确认 Homeserver 失败，因为这不是 Matrix Homeserver。";
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

function hasValidAgent(content: unknown, ownerUserId: string): boolean {
  return parseRegisteredAgents(content, ownerUserId).length > 0;
}

function nextAgentsContent(existing: TransportResult, agentUserId: string): Record<string, unknown> {
  if (
    existing.type === "response" &&
    existing.status === 200 &&
    isRecord(existing.body) &&
    !Array.isArray(existing.body)
  ) {
    const prevAgents = Array.isArray(existing.body.agents) ? existing.body.agents : [];
    return {
      ...existing.body,
      agents: [...prevAgents, { user_id: agentUserId }],
    };
  }
  return { agents: [{ user_id: agentUserId }] };
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
    return { message: transportFailureMessage("登录", result.failure), clearPassword: false };
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

function shouldSuspendSyncInBackground(platform: PlatformAdapter): boolean {
  return platform.suspendSyncInBackground ?? platform.deviceDisplayName === "Waypoint Android";
}
