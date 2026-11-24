import { AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
import { WaypointBrandIcon } from "./icons";
import "../App.css";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
} from "react";
import { normalizeInset } from "../adapters/inset";
import type {
  Clock,
  HomeserverTransport,
  PlatformAdapter,
  TransportResult,
  ViewportMode,
} from "../adapters/types";
import { resetAppearancePreference, syncAppearanceLifecycle } from "./appearance";
import { MatrixClient } from "./matrix-client";
import { deleteLocalDatabase } from "./session-store";
import { RetryQueue } from "./retry-queue";
import {
  classifyLoginFailure,
  credentialRejectedMessage,
  isAbortedFailure,
  formatMatrixActionFailure,
  isCredentialRejected,
  isRateLimited,
  isRecord,
  isSyncCursorRejected,
  transportFailureMessage,
} from "./matrix-errors";
import { TopicsWorkspace } from "./TopicsWorkspace";
import { deriveRoomAvailability, isFullUserId, isLocalpart, parseRegisteredAgents, validateAgentUserId } from "./topics";

let liveAppInstanceToken: symbol | null = null;

type AuthStepDir = "forward" | "back" | "fade";

type Phase =
  | { name: "booting" }
  | {
      name: "restore-error";
      resetting: boolean;
      resetConfirmOpen: boolean;
      resetError?: string;
    }
  | { name: "address"; address: string; submitting: boolean; message?: string }
  | {
      name: "password";
      address: string;
      userId: string;
      password: string;
      submitting: boolean;
      message?: string;
    }
  | { name: "syncing"; address: string; userId: string; message?: string }
  | {
      name: "register";
      address: string;
      userId: string;
      agentUserId: string;
      submitting: boolean;
      message?: string;
    }
  | { name: "topics"; initialReauthRequired?: boolean; initialSyncImmediate?: boolean };

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
  const [authStepDir, setAuthStepDir] = useState<AuthStepDir>("fade");
  const subscribeViewport = useCallback(
    (listener: () => void) =>
      platform.subscribeViewportMode
        ? platform.subscribeViewportMode(() => listener())
        : () => undefined,
    [platform],
  );
  const getViewportSnapshot = useCallback(
    (): ViewportMode => (platform.viewportMode ? platform.viewportMode() : "wide"),
    [platform],
  );
  const viewportMode = useSyncExternalStore(
    subscribeViewport,
    getViewportSnapshot,
    getViewportSnapshot,
  );
  const subscribeKeyboardInset = useCallback(
    (listener: () => void) =>
      platform.subscribeKeyboardInsetBottom
        ? platform.subscribeKeyboardInsetBottom(() => listener())
        : () => undefined,
    [platform],
  );
  const getKeyboardInsetSnapshot = useCallback(
    () => normalizeInset(platform.keyboardInsetBottom ? platform.keyboardInsetBottom() : 0),
    [platform],
  );
  const keyboardInsetBottom = useSyncExternalStore(
    subscribeKeyboardInset,
    getKeyboardInsetSnapshot,
    getKeyboardInsetSnapshot,
  );
  const [duplicateInstance, setDuplicateInstance] = useState(
    () => liveAppInstanceToken !== null,
  );
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
    return syncAppearanceLifecycle();
  }, []);

  const appBackHandlerRef = useRef<() => boolean>(() => false);
  const canHandleAppSystemBack =
    phase.name === "restore-error" && phase.resetConfirmOpen;

  appBackHandlerRef.current = () => {
    if (phase.name === "restore-error" && phase.resetConfirmOpen) {
      if (!phase.resetting) {
        setPhase((prev) =>
          prev.name === "restore-error"
            ? { ...prev, resetConfirmOpen: false }
            : prev,
        );
      }
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (phase.name === "topics") {
      return undefined;
    }
    platform.setSystemBackEnabled?.(canHandleAppSystemBack);
    return platform.onSystemBack?.(() => appBackHandlerRef.current());
  }, [phase.name, platform, canHandleAppSystemBack]);

  const unmountedRef = useRef(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  const restoreSessionOnMount = useEffectEvent(async (isCancelled: () => boolean) => {
    const outcome = await client()
      .restore()
      .then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      );
    if (isCancelled()) {
      return;
    }
    if (!outcome.ok) {
      setAuthStepDir("fade");
      setPhase({
        name: "restore-error",
        resetting: false,
        resetConfirmOpen: false,
      });
      return;
    }
    const restored = outcome.value;
    if (isCancelled()) {
      return;
    }
    const matrix = client();
    if (restored === "sync") {
      if (
        matrix.hasSyncCursor &&
        hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)
      ) {
        setPhase({ name: "topics", initialSyncImmediate: true });
        return;
      }
      setAuthStepDir("fade");
      setPhase({ name: "syncing", address: matrix.address, userId: matrix.ownerId });
      const suspended = shouldSuspendSyncInBackground(platformRef.current) && !readAppVisible();
      backgroundSuspendedRef.current = suspended;
      if (!suspended) {
        void syncNow();
      }
      return;
    }
    if (restored === "password") {
      setAuthStepDir("fade");
      setPhase({
        name: "password",
        address: matrix.address,
        userId: matrix.ownerId,
        password: "",
        submitting: false,
      });
      return;
    }
    setAuthStepDir("fade");
    setPhase({ name: "address", address: "", submitting: false });
  });

  useEffect(() => {
    if (restoreAttempt === 0) {
      return;
    }
    let cancelled = false;
    void restoreSessionOnMount(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  useEffect(() => {
    let cancelled = false;
    if (duplicateInstance || liveAppInstanceToken !== null) {
      platformRef.current.focusMainWindow?.();
      if (!duplicateInstance) {
        void Promise.resolve().then(() => {
          if (!cancelled) {
            setDuplicateInstance(true);
          }
        });
      }
      return () => {
        cancelled = true;
      };
    }
    const myToken = Symbol("waypoint-app-instance");
    liveAppInstanceToken = myToken;

    unmountedRef.current = false;
    void restoreSessionOnMount(() => cancelled);
    return () => {
      cancelled = true;
      unmountedRef.current = true;
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
  }, [clock, duplicateInstance]);

  const handleAppVisibilityChange = useEffectEvent((visible: boolean) => {
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
  });

  const handleAppNetworkResume = useEffectEvent(() => {
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
  });

  useEffect(() => {
    let unsubVisibility: () => void;
    if (platform.subscribeAppVisibility) {
      unsubVisibility = platform.subscribeAppVisibility(handleAppVisibilityChange);
    } else {
      const onVis = () =>
        handleAppVisibilityChange(
          typeof document === "undefined" ? true : document.visibilityState !== "hidden",
        );
      const onHide = () => handleAppVisibilityChange(false);
      const onShow = () =>
        handleAppVisibilityChange(
          typeof document === "undefined" ? true : document.visibilityState !== "hidden",
        );
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
      unsubResume = platform.subscribeNetworkResume(handleAppNetworkResume);
    } else {
      window.addEventListener("online", handleAppNetworkResume);
      unsubResume = () => window.removeEventListener("online", handleAppNetworkResume);
    }
    return () => {
      unsubVisibility();
      unsubResume();
    };
  }, [platform]);

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
      setAuthStepDir("back");
      setPhase({ name: "password", address, userId, password: "", submitting: false });
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
      resetAppearancePreference();
      setAuthStepDir("back");
      setPhase({ name: "password", address, userId, password: "", submitting: false });
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
    setPhase((prev) =>
      prev.name === "syncing" && prev.message
        ? { name: "syncing", address: prev.address, userId: prev.userId }
        : prev,
    );
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
      setAuthStepDir("back");
      setPhase({
        name: "password",
        address,
        userId,
        password: "",
        submitting: false,
        message: credentialRejectedMessage("同步", sync),
      });
      return;
    }
    if (sync.type === "response" && sync.status === 200) {
      const wasBackedOff = backoffStep.current > 0;
      try {
        await matrix.retainSync(attempt);
      } catch {
        if (!syncIsCurrent(myEpoch, generation)) {
          return;
        }
        setPhase({
          name: "syncing",
          address: matrix.address,
          userId: matrix.ownerId,
          message: "本地存储空间不足，已暂停接收新消息",
        });
        scheduleRetry();
        return;
      }
      backoffStep.current = 0;
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
      if (hasValidAgent(matrix.accountData("im.waypoint.agents"), matrix.ownerId)) {
        setPhase({ name: "topics" });
      } else {
        setAuthStepDir("forward");
        setPhase({
          name: "register",
          address: matrix.address,
          userId: matrix.ownerId,
          agentUserId: "",
          submitting: false,
        });
      }
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
    if (phase.name !== "address" || phase.submitting) {
      return;
    }
    const parsed = classifyBaseUrl(phase.address);
    if (!parsed.ok) {
      setPhase({
        ...phase,
        submitting: false,
        message: parsed.message,
      });
      return;
    }
    setPhase({ name: "address", address: parsed.baseUrl, submitting: true });
    void confirmHomeserver(parsed.baseUrl, epoch.current);
  }

  async function confirmHomeserver(baseUrl: string, myEpoch: number) {
    const result = await client().versions(baseUrl);
    if (epoch.current !== myEpoch) {
      return;
    }
    const message = versionsOutcome(result);
    if (!message) {
      setAuthStepDir("forward");
      setPhase({
        name: "password",
        address: baseUrl,
        userId: "",
        password: "",
        submitting: false,
      });
      return;
    }
    setPhase((prev) =>
      prev.name === "address"
        ? { name: "address", address: baseUrl, submitting: false, message }
        : prev,
    );
  }

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (phase.name !== "password" || phase.submitting) {
      return;
    }
    const identifier = classifyIdentifier(phase.userId);
    if (identifier.kind === "empty") {
      setPhase({ ...phase, submitting: false, message: "请输入用户名。" });
      return;
    }
    if (identifier.kind === "rejected") {
      setPhase({
        ...phase,
        submitting: false,
        userId: phase.userId.trim(),
        message: "请输入有效的用户名或完整 Matrix 用户 ID，不支持邮箱和手机号。",
      });
      return;
    }
    const next = { ...phase, userId: identifier.user, submitting: true, message: undefined };
    setPhase(next);
    void beginLogin(next.address, identifier.user, phase.password, epoch.current);
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
    setAuthStepDir("back");
    setPhase({
      name: "password",
      address,
      userId,
      password: "",
      submitting: false,
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
      try {
        await matrix.retainAccountData("im.waypoint.agents", existing.body);
      } catch {
        if (epoch.current !== myEpoch) {
          return;
        }
        setPhase((prev) =>
          prev.name === "register"
            ? {
                ...prev,
                submitting: false,
                message: "本地存储空间不足，未能保存 Bot 名册，请清理空间后重试。",
              }
            : prev,
        );
        return;
      }
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
      try {
        await matrix.retainAccountData("im.waypoint.agents", nextContent);
      } catch {
        if (epoch.current !== myEpoch) {
          return;
        }
        setPhase((prev) =>
          prev.name === "register"
            ? {
                ...prev,
                submitting: false,
                message: "本地存储空间不足，未能保存 Bot 名册，请清理空间后重试。",
              }
            : prev,
        );
        return;
      }
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

  async function beginLogin(address: string, user: string, password: string, myEpoch: number) {
    const matrix = client();
    const flows = await matrix.loginFlows();
    if (epoch.current !== myEpoch) {
      return;
    }
    if (!(flows.type === "response" && flows.status === 200)) {
      const failure = loginFailure(flows);
      setPhase((prev) =>
        prev.name === "password"
          ? {
              ...prev,
              submitting: false,
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
          ? {
              ...prev,
              submitting: false,
              message: "该 Homeserver 未开启密码登录。",
            }
          : prev,
      );
      return;
    }
    const login = await matrix.passwordLogin(user, password, platform.deviceDisplayName);
    if (epoch.current !== myEpoch) {
      return;
    }
    const session = loginSuccess(login);
    if (!session) {
      const failure = loginFailure(login);
      setPhase((prev) =>
        prev.name === "password"
          ? {
              ...prev,
              submitting: false,
              password: failure.clearPassword ? "" : prev.password,
              message: failure.message,
            }
          : prev,
      );
      return;
    }
    retryQueue().resume();
    try {
      await matrix.rememberLogin(session.userId, session.accessToken, session.deviceId);
    } catch {
      if (epoch.current !== myEpoch) {
        return;
      }
      setPhase((prev) =>
        prev.name === "password"
          ? {
              ...prev,
              submitting: false,
              message: "本地存储空间不足，无法保存登录状态，请清理空间后重试。",
            }
          : prev,
      );
      return;
    }
    if (epoch.current !== myEpoch) {
      return;
    }
    setAuthStepDir("forward");
    setPhase({ name: "syncing", address, userId: session.userId });
    await syncNow();
  }

  const isNarrow = viewportMode === "narrow";

  const authMainClassName = cn(
    "flex h-full w-full max-w-full overflow-y-auto overscroll-contain bg-background px-6 text-foreground",
    isNarrow
      ? "flex-col pt-[max(3.25rem,env(safe-area-inset-top,0px))] pb-[calc(max(1.5rem,env(safe-area-inset-bottom,0px))+var(--keyboard-inset,0px))] transition-[padding-bottom] duration-280 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
      : "items-center justify-center py-8 pt-[max(2rem,env(safe-area-inset-top,0px))] pb-[calc(max(2rem,env(safe-area-inset-bottom,0px))+var(--keyboard-inset,0px))]",
  );

  const authMainStyle = {
    "--keyboard-inset": `${keyboardInsetBottom}px`,
    paddingBottom: keyboardInsetBottom > 0 ? `${keyboardInsetBottom}px` : undefined,
  } as CSSProperties;

  const stepAnimationClassName =
    authStepDir === "forward"
      ? "waypoint-auth-step-forward"
      : authStepDir === "back"
        ? "waypoint-auth-step-back"
        : "waypoint-auth-fade";

  const authInputClassName = cn(
    "mt-0 rounded-xl border-border/80 bg-secondary/45 px-3.5 text-[16px] shadow-none transition-colors focus-visible:bg-background select-text",
    isNarrow ? "h-12" : "h-11",
  );

  const authPrimaryButtonClassName = cn(
    "w-full rounded-full font-medium",
    isNarrow ? "h-12 text-[15px]" : "h-11",
  );

  const authGhostButtonClassName = cn(
    "w-full rounded-full text-muted-foreground hover:text-foreground",
    isNarrow ? "h-11" : "h-10",
  );

  const inlineAlert =
    "message" in phase && phase.message ? (
      <Alert variant="destructive" className="rounded-xl waypoint-auth-fade">
        <AlertCircle aria-hidden="true" />
        <AlertDescription>{phase.message}</AlertDescription>
      </Alert>
    ) : null;

  if (duplicateInstance) {
    return (
      <main
        data-viewport={viewportMode}
        data-tauri-drag-region="deep"
        className={authMainClassName}
      >
        <div
          className={cn(
            "mx-auto w-full max-w-[23rem] text-center select-none waypoint-auth-fade",
            isNarrow && "my-auto",
          )}
        >
          <div className="mb-4 flex justify-center text-foreground">
            <WaypointBrandIcon size={40} />
          </div>
          <p role="status" className="m-0 text-sm leading-relaxed text-muted-foreground">
            Waypoint 已在主窗口中运行，请切回主窗口继续。
          </p>
        </div>
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
        initialSyncImmediate={phase.initialSyncImmediate}
        onAgentsInvalidated={() => {
          syncGeneration.current += 1;
          syncAbortControllerRef.current?.abort();
          syncAbortControllerRef.current = null;
          clearRetry();
          retryQueue().pause();
          const m = client();
          setAuthStepDir("fade");
          setPhase({
            name: "register",
            address: m.address,
            userId: m.ownerId,
            agentUserId: "",
            submitting: false,
          });
        }}
        onExitDevice={exitDevice}
      />
    );
  }

  if (phase.name === "booting") {
    return (
      <main
        data-viewport={viewportMode}
        data-tauri-drag-region="deep"
        className={authMainClassName}
        aria-busy="true"
        style={authMainStyle}
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-[23rem] flex-col items-center justify-center gap-6 py-12 select-none waypoint-auth-fade",
            isNarrow && "my-auto",
          )}
        >
          <div className="text-foreground">
            <WaypointBrandIcon size={44} />
          </div>
          <div className="flex items-center justify-center" aria-hidden="true">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        </div>
      </main>
    );
  }

  if (phase.name === "restore-error") {
    const handleRetryRestore = () => {
      if (phase.resetting) {
        return;
      }
      setPhase({ name: "booting" });
      setRestoreAttempt((n) => n + 1);
    };

    const handleConfirmReset = async () => {
      if (phase.resetting) {
        return;
      }
      setPhase((prev) =>
        prev.name === "restore-error"
          ? { ...prev, resetting: true, resetError: undefined }
          : prev,
      );
      try {
        await deleteLocalDatabase(5000);
        if (unmountedRef.current) {
          return;
        }
        const matrix = client();
        const cachedAddress = matrix.address;
        matrix.resetInMemoryForDatabaseReset(true);
        setAuthStepDir("fade");
        setPhase({ name: "address", address: cachedAddress, submitting: false });
      } catch {
        if (unmountedRef.current) {
          return;
        }
        setPhase((prev) =>
          prev.name === "restore-error"
            ? {
                ...prev,
                resetting: false,
                resetError: "重置本地数据失败，请关闭其他占用窗口后重试。",
              }
            : prev,
        );
      }
    };

    return (
      <main
        data-viewport={viewportMode}
        data-tauri-drag-region="deep"
        className={authMainClassName}
        style={authMainStyle}
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-[23rem] flex-col gap-6 select-none waypoint-auth-fade",
            isNarrow ? "flex-1 justify-between py-2" : "py-4",
          )}
        >
          <div className={cn("flex flex-col gap-4", isNarrow ? "items-start text-left" : "items-center text-center")}>
            <div className="text-foreground">
              <WaypointBrandIcon size={36} />
            </div>
            <div className="space-y-1.5">
              <h1 className="m-0 text-2xl font-bold tracking-tight text-foreground">
                本地数据读取异常
              </h1>
              <p className="m-0 text-sm leading-relaxed text-muted-foreground">
                当前设备上的本地数据暂时无法读取，你可以重试或重置本地数据后重新连接。
              </p>
            </div>
          </div>

          <div className={cn("flex w-full flex-col gap-2.5", isNarrow && "mt-auto pt-2")}>
            <Button
              className={authPrimaryButtonClassName}
              type="button"
              disabled={phase.resetting}
              onClick={handleRetryRestore}
            >
              重试
            </Button>
            <Button
              variant="outline"
              className={authPrimaryButtonClassName}
              type="button"
              disabled={phase.resetting}
              onClick={() =>
                setPhase((prev) =>
                  prev.name === "restore-error"
                    ? { ...prev, resetConfirmOpen: true, resetError: undefined }
                    : prev,
                )
              }
            >
              重置本地数据并重新连接
            </Button>
          </div>
        </div>

        <AlertDialog
          open={phase.resetConfirmOpen}
          onOpenChange={(open) => {
            if (!phase.resetting) {
              setPhase((prev) =>
                prev.name === "restore-error"
                  ? { ...prev, resetConfirmOpen: open }
                  : prev,
              );
            }
          }}
        >
          <AlertDialogContent
            aria-label="重置本地数据并重新连接"
            onEscapeKeyDown={(event) => {
              if (phase.resetting) {
                event.preventDefault();
              }
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>重置本地数据并重新连接</AlertDialogTitle>
              <AlertDialogDescription>
                重置将彻底清空这台设备上的本地时间线、草稿与重试队列
              </AlertDialogDescription>
            </AlertDialogHeader>
            {phase.resetError ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertDescription>{phase.resetError}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={phase.resetting}>
                取消
              </AlertDialogCancel>
              <AlertDialogAction
                className={cn(
                  buttonVariants({ variant: "destructive" }),
                  "min-h-11 sm:min-h-9",
                )}
                disabled={phase.resetting}
                onClick={(event) => {
                  event.preventDefault();
                  void handleConfirmReset();
                }}
              >
                {phase.resetting ? "正在重置…" : "确认重置"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    );
  }

  const headerAlignedLeft = isNarrow && phase.name !== "syncing";

  return (
    <main
      data-viewport={viewportMode}
      data-tauri-drag-region="deep"
      className={authMainClassName}
      style={authMainStyle}
    >
      <p className="sr-only">尚未进入 Topic 列表</p>
      <div
        className={cn(
          "mx-auto w-full max-w-[23rem] select-none",
          isNarrow && "flex flex-1 flex-col",
          isNarrow && phase.name === "syncing" && "pt-8",
        )}
      >
        <header
          className={cn(
            "flex flex-col transition-all duration-200",
            headerAlignedLeft ? "items-start text-left" : "items-center text-center",
            phase.name === "address" ? (isNarrow ? "mb-8" : "mb-9") : "mb-6",
          )}
        >
          <div className="text-foreground transition-transform duration-200">
            <WaypointBrandIcon size={phase.name === "address" ? 42 : 34} />
          </div>
          {phase.name === "register" ? (
            <span className="mt-3 text-xs font-medium tracking-wide text-muted-foreground">
              Waypoint
            </span>
          ) : (
            <h1
              className={cn(
                "m-0 font-bold tracking-tight text-foreground",
                phase.name === "address"
                  ? isNarrow
                    ? "mt-5 text-[1.75rem] leading-tight"
                    : "mt-4 text-2xl"
                  : "mt-3.5 text-2xl",
              )}
            >
              {phase.name === "password" ? "登录 Waypoint" : "Waypoint"}
            </h1>
          )}
          {phase.name === "address" ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              连接到你的 Matrix Homeserver
            </p>
          ) : null}
        </header>

        <div
          key={phase.name}
          className={cn(
            isNarrow && "flex flex-1 flex-col",
            stepAnimationClassName,
          )}
        >
          {phase.name === "address" ? (
            <form
              className={cn(
                "flex w-full flex-col",
                isNarrow ? "flex-1 justify-between gap-6" : "gap-5",
              )}
              aria-busy={phase.submitting}
              onSubmit={submitAddress}
            >
              <div className="flex w-full flex-col gap-4">
                <div className="flex w-full flex-col gap-2">
                  <Label htmlFor="waypoint-address">Homeserver 地址</Label>
                  <Input
                    id="waypoint-address"
                    className={authInputClassName}
                    name="address"
                    autoComplete="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={phase.submitting}
                    value={phase.address}
                    onChange={(event) =>
                      setPhase({
                        name: "address",
                        address: event.target.value,
                        submitting: false,
                      })
                    }
                  />
                </div>
                {inlineAlert}
              </div>
              <div className={cn("flex w-full flex-col gap-2.5", isNarrow && "mt-auto pt-2")}>
                <Button
                  className={authPrimaryButtonClassName}
                  type="submit"
                  disabled={phase.submitting || !phase.address.trim()}
                >
                  {phase.submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      <span>正在连接…</span>
                    </>
                  ) : (
                    "继续"
                  )}
                </Button>
              </div>
            </form>
          ) : phase.name === "password" ? (
            <form
              className={cn(
                "flex w-full flex-col",
                isNarrow ? "flex-1 justify-between gap-6" : "gap-5",
              )}
              aria-busy={phase.submitting}
              onSubmit={submitPassword}
            >
              <div className="flex w-full flex-col gap-4">
                <div className="flex items-center gap-2 overflow-hidden rounded-xl bg-secondary/75 py-1.5 pr-1.5 pl-3.5 text-xs">
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-foreground/60"
                    aria-hidden="true"
                  />
                  <p className="m-0 min-w-0 flex-1 truncate font-mono text-foreground/85">
                    {phase.address}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                    type="button"
                    disabled={phase.submitting}
                    onClick={() => {
                      setAuthStepDir("back");
                      setPhase({
                        name: "address",
                        address: phase.address,
                        submitting: false,
                      });
                    }}
                  >
                    更改地址
                  </Button>
                </div>
                <div className="flex w-full flex-col gap-2">
                  <Label htmlFor="waypoint-user-id">用户名</Label>
                  <Input
                    id="waypoint-user-id"
                    className={authInputClassName}
                    name="user-id"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={phase.submitting}
                    value={phase.userId}
                    onChange={(event) => setPhase({ ...phase, userId: event.target.value })}
                  />
                </div>
                <div className="flex w-full flex-col gap-2">
                  <Label htmlFor="waypoint-password">密码</Label>
                  <Input
                    id="waypoint-password"
                    className={authInputClassName}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    disabled={phase.submitting}
                    value={phase.password}
                    onChange={(event) => setPhase({ ...phase, password: event.target.value })}
                  />
                </div>
                {inlineAlert}
              </div>
              <div className={cn("flex w-full flex-col gap-2.5", isNarrow && "mt-auto pt-2")}>
                <Button
                  className={authPrimaryButtonClassName}
                  type="submit"
                  disabled={phase.submitting || !phase.userId.trim() || !phase.password}
                >
                  {phase.submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      <span>正在登录…</span>
                    </>
                  ) : (
                    "用密码登录"
                  )}
                </Button>
              </div>
            </form>
          ) : phase.name === "syncing" ? (
            <div
              className={cn(
                "flex w-full flex-col items-center text-center",
                isNarrow ? "flex-1 justify-between gap-6" : "gap-5 py-2",
              )}
            >
              <div
                className={cn(
                  "flex w-full flex-col items-center gap-4",
                  isNarrow && "my-auto",
                )}
              >
                <div className="flex items-center justify-center" aria-hidden="true">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <p className="m-0 text-sm font-medium text-foreground">
                    正在增量同步…
                  </p>
                  <p className="m-0 text-xs text-muted-foreground">
                    {phase.message ? "连接受阻，将自动退避重试" : "正在拉取你的对话与名册"}
                  </p>
                </div>
                <div className="w-full text-left">{inlineAlert}</div>
              </div>
              <div
                className={cn(
                  "flex w-full flex-row justify-center gap-2.5",
                  isNarrow && "mt-auto pt-2",
                )}
              >
                <Button
                  variant={phase.message ? "default" : "outline"}
                  className={cn(
                    "flex-1 rounded-full",
                    isNarrow ? "h-12 text-[15px]" : "h-11",
                  )}
                  type="button"
                  onClick={() => void syncNow()}
                >
                  立刻再试
                </Button>
                <Button
                  variant="ghost"
                  className={cn(
                    "flex-1 rounded-full text-muted-foreground hover:text-foreground",
                    isNarrow ? "h-12 text-[15px]" : "h-11",
                  )}
                  type="button"
                  onClick={() => void abandon()}
                >
                  放弃
                </Button>
              </div>
            </div>
          ) : phase.name === "register" ? (
            <form
              className={cn(
                "flex w-full flex-col",
                isNarrow ? "flex-1 justify-between gap-6" : "gap-5",
              )}
              aria-busy={phase.submitting}
              onSubmit={submitRegistration}
            >
              <div className="flex w-full flex-col gap-4">
                <div
                  className={cn(
                    "mb-1 space-y-1.5",
                    headerAlignedLeft ? "text-left" : "text-center",
                  )}
                >
                  <h1 className="m-0 text-2xl font-bold tracking-tight text-foreground">
                    登记 Bot
                  </h1>
                  <p className="m-0 text-sm leading-relaxed text-muted-foreground">
                    名册为空，请为你的专属空间登记第一个 Bot
                  </p>
                </div>
                <div className="flex w-full flex-col gap-2">
                  <Label htmlFor="waypoint-agent-user-id">Bot 用户名</Label>
                  <Input
                    id="waypoint-agent-user-id"
                    className={authInputClassName}
                    name="agent-user-id"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={phase.agentUserId}
                    disabled={phase.submitting}
                    onChange={(event) => setPhase({ ...phase, agentUserId: event.target.value })}
                  />
                </div>
                {inlineAlert}
              </div>
              <div className={cn("flex w-full flex-col gap-2", isNarrow && "mt-auto pt-2")}>
                <Button
                  className={authPrimaryButtonClassName}
                  type="submit"
                  disabled={phase.submitting || !phase.agentUserId.trim()}
                >
                  {phase.submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      <span>正在登记…</span>
                    </>
                  ) : (
                    "登记 Bot"
                  )}
                </Button>
                <Button
                  variant="ghost"
                  className={authGhostButtonClassName}
                  type="button"
                  onClick={() => void abandon()}
                >
                  放弃
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </main>
  );
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function syncFailureMessage(result: TransportResult): string {
  return formatMatrixActionFailure("同步", result, {
    serverErrorReason: "服务器暂时无法响应，请稍后重试。",
    fallbackMessage: "无法连接到服务器，请检查网络后重试。",
  });
}

function classifyBaseUrl(
  raw: string,
): { ok: true; baseUrl: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "请输入 Homeserver 地址。" };
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const hasNonPortScheme =
    !hasScheme && trimmed.includes(":") && /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(trimmed);
  if (hasScheme || hasNonPortScheme) {
    if (!/^https:\/\//i.test(trimmed)) {
      return { ok: false, message: "仅支持通过 HTTPS 连接 Homeserver。" };
    }
  }
  const withScheme = hasScheme || hasNonPortScheme ? trimmed : `https://${trimmed}`;
  const stripped = withScheme.endsWith("/") ? withScheme.slice(0, -1) : withScheme;
  if (!stripped || /\s/.test(stripped)) {
    return {
      ok: false,
      message: "Homeserver 地址格式不正确，请填写域名或 https:// 地址。",
    };
  }
  try {
    const url = new URL(stripped);
    if (url.protocol !== "https:") {
      return { ok: false, message: "仅支持通过 HTTPS 连接 Homeserver。" };
    }
    if (url.hostname === "" || url.username !== "" || url.password !== "") {
      return {
        ok: false,
        message: "Homeserver 地址格式不正确，请填写域名或 https:// 地址。",
      };
    }
  } catch {
    return {
      ok: false,
      message: "Homeserver 地址格式不正确，请填写域名或 https:// 地址。",
    };
  }
  return { ok: true, baseUrl: stripped };
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
    return "请求过于频繁，请稍后再试。";
  }
  if (result.status === 200 && hasUsableVersions(result.body)) {
    return undefined;
  }
  return "该地址不是有效的 Matrix Homeserver。";
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
  return classifyLoginFailure(result, "登录", "用户名或密码不正确");
}

function shouldSuspendSyncInBackground(platform: PlatformAdapter): boolean {
  return platform.suspendSyncInBackground ?? platform.deviceDisplayName === "Waypoint Android";
}
