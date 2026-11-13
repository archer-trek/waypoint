import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { normalizeInset } from "../adapters/inset";
import type { Clock, PlatformAdapter, TransportResult, ViewportMode } from "../adapters/types";
import {
  BACKFILL_PAGE_LIMIT,
  nextBackfillTargetForReadPosition,
  nextBackfillTargetForScrollUp,
  type MatrixClient,
} from "./matrix-client";
import { MessageBody } from "./MessageBody";
import {
  BackIcon,
  CloseIcon,
  EditIcon,
  PaperclipIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
} from "./icons";
import type { DraftAttachment, DraftRecord } from "./session-store";
import {
  classifyLoginFailure,
  extractLoginSession,
  isAbortedFailure,
  isCredentialRejected,
  isDeviceIdRejected,
  isSyncCursorRejected,
} from "./matrix-errors";
import { RETRY_BACKOFF_MS, RetryQueue } from "./retry-queue";
import {
  appendDirectRoom,
  buildAddAgentContent,
  buildRemoveAgentContent,
  buildRenameAgentContent,
  computeTargetReadPosition,
  createTopicRoom,
  deleteTopicRoom,
  deriveRoomAvailability,
  type BubbleVisibility,
  type TimelineMedia,
  deriveRoomTimelineItems,
  hasLimitedGapAfterReadPosition,
  deriveTopics,
  formatTopicListTime,
  parseRegisteredAgents,
  resolveBotName,
  resolvePreselectedBotId,
  saveRegisteredAgents,
  setTopicPinned,
  updateTopicDetails,
  validateAgentUserId,
} from "./topics";

const FOREGROUND_SYNC_INTERVAL_MS = 1000;
const AT_BOTTOM_THRESHOLD_PX = 24;
const TOP_SCROLL_THRESHOLD_PX = 24;
const SLASH_COMMAND_HINTS = ["/model", "/stop", "/status", "/commands"] as const;

type AgentsFormState =
  | {
      mode: "add";
      userId: string;
      handwrittenName: string;
    }
  | {
      mode: "edit";
      userId: string;
      handwrittenName: string;
    }
  | {
      mode: "remove";
      userId: string;
    };

function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (target as HTMLElement).isContentEditable
  );
}

export function TopicsWorkspace({
  client,
  clock,
  retryQueue: providedRetryQueue,
  platform,
  viewportMode = "wide",
  keyboardInsetBottom = 0,
  initialReauthRequired = false,
  initialSyncImmediate = false,
  onAgentsInvalidated,
  onExitDevice,
}: {
  client: MatrixClient;
  clock: Clock;
  retryQueue?: RetryQueue;
  platform?: PlatformAdapter;
  viewportMode?: ViewportMode;
  keyboardInsetBottom?: number;
  initialReauthRequired?: boolean;
  initialSyncImmediate?: boolean;
  onAgentsInvalidated?: () => void;
  onExitDevice?: () => Promise<void>;
}) {
  const retryQueue = useMemo(
    () => providedRetryQueue ?? new RetryQueue(client, clock),
    [providedRetryQueue, client, clock],
  );
  const [, setRevision] = useState(0);
  const [, setMediaRevision] = useState(0);
  const [backfillTick, setBackfillTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsForm, setAgentsForm] = useState<AgentsFormState | null>(null);
  const [agentsSubmitting, setAgentsSubmitting] = useState(false);
  const [agentsError, setAgentsError] = useState<string | undefined>(undefined);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [quickRegisterOpen, setQuickRegisterOpen] = useState(false);
  const [quickUserId, setQuickUserId] = useState("");
  const [quickHandwrittenName, setQuickHandwrittenName] = useState("");
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [quickError, setQuickError] = useState<string | undefined>(undefined);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editNameInput, setEditNameInput] = useState("");
  const [editDescriptionInput, setEditDescriptionInput] = useState("");
  const [editPendingFields, setEditPendingFields] = useState({ name: true, description: true });
  const [editError, setEditError] = useState<string | undefined>(undefined);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [pinPendingByRoom, setPinPendingByRoom] = useState<Record<string, boolean>>({});
  const pinPendingRef = useRef<Set<string>>(new Set());
  const [toastNotice, setToastNotice] = useState<string | undefined>(undefined);
  const toastNoticeTimerRef = useRef<number | undefined>(undefined);
  const [draftsByRoom, setDraftsByRoom] = useState<Record<string, DraftRecord>>(() =>
    client.drafts(),
  );
  const draftsByRoomRef = useRef(draftsByRoom);
  draftsByRoomRef.current = draftsByRoom;
  const draftMutationSeqRef = useRef<Record<string, number>>({});
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const [persistingSend, setPersistingSend] = useState(false);
  const persistingSendRef = useRef(false);
  const [openFailedMenuId, setOpenFailedMenuId] = useState<string | null>(null);
  const resendingLocalIdsRef = useRef(new Set<string>());
  const discardingLocalIdsRef = useRef(new Set<string>());
  const visibleComposerRoomRef = useRef<string | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const lastLandedRoomRef = useRef<string | null>(null);
  const lastRequestedReadRef = useRef<Record<string, string>>({});
  const mountedRef = useRef(true);
  const [reauthRequired, setReauthRequired] = useState(
    () => initialReauthRequired || retryQueue.isPaused,
  );
  const reauthRequiredRef = useRef(reauthRequired);
  reauthRequiredRef.current = reauthRequired;
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthSubmitting, setReauthSubmitting] = useState(false);
  const reauthSubmittingRef = useRef(false);
  const [reauthError, setReauthError] = useState<string | undefined>(undefined);
  const pausedRef = useRef(initialReauthRequired || retryQueue.isPaused);
  const readAppVisible = () => {
    if (platform?.isAppVisible) {
      return platform.isAppVisible();
    }
    if (typeof document !== "undefined") {
      return document.visibilityState !== "hidden";
    }
    return true;
  };
  const suspendInBackground =
    platform?.suspendSyncInBackground ?? platform?.deviceDisplayName === "Waypoint Android";
  const backgroundSuspendedRef = useRef(suspendInBackground && !readAppVisible());
  const isSyncPaused = () => pausedRef.current || backgroundSuspendedRef.current;
  const syncEpochRef = useRef(0);
  const syncRunIdRef = useRef(0);
  const syncTimerRef = useRef<number | undefined>(undefined);
  const syncBackoffRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const syncWakePendingRef = useRef(false);
  const syncAbortControllerRef = useRef<AbortController | null>(null);
  const isAtBottomRef = useRef(true);
  const prevTimelineKeyRef = useRef<string>("");
  const activeVisibleRoomRef = useRef<string | null>(null);
  const backfillInFlightRoomsRef = useRef(new Set<string>());
  const openBackfillStoppedRoomsRef = useRef(new Set<string>());
  const pendingScrollPreserveRef = useRef<{
    roomId: string;
    prevScrollHeight: number;
    prevScrollTop: number;
  } | null>(null);
  const awaitingReadPosLandingRoomRef = useRef<string | null>(null);
  const programmaticScrollRef = useRef<{ active: boolean; top: number }>({
    active: false,
    top: 0,
  });
  const userScrolledRoomRef = useRef<string | null>(null);
  const downloadedMediaCacheRef = useRef<
    Map<string, { data: Uint8Array; mimeType: string; imageUrl?: string; revoke?: () => void }>
  >(new Map());
  const localMediaUrlCacheRef = useRef<
    Map<string, { dataRef: Uint8Array; url: string; revoke?: () => void }>
  >(new Map());
  const downloadingMediaRef = useRef<Set<string>>(new Set());
  const failedImageMxcUrlsRef = useRef<Set<string>>(new Set());

  const registeredAgents = parseRegisteredAgents(
    client.accountData("im.waypoint.agents"),
    client.ownerId,
  );
  const rooms = client.rooms();
  const roomList = Object.values(rooms);
  const topics = deriveTopics(rooms, registeredAgents, client.ownerId, client.pendingRoomEvents());
  const activeTopic = activeTopicId
    ? topics.find((topic) => topic.roomId === activeTopicId)
    : undefined;
  const nowMs = clock.currentTimeMs ? clock.currentTimeMs() : Date.now();
  const activeTimelineItems = activeTopic
    ? deriveRoomTimelineItems(
        rooms[activeTopic.roomId],
        client.pendingRoomEvents(activeTopic.roomId),
        client.ownerId,
        activeTopic.agentUserId,
        nowMs,
      )
    : [];
  const timelineContentKey = activeTimelineItems
    .map((item) => {
      if (item.kind === "day-separator") {
        return `s:${item.key}`;
      }
      const promptSig = item.prompt
        ? `${item.prompt.kind}:${item.prompt.answered ? 1 : 0}:${item.prompt.superseded ? 1 : 0}:${item.prompt.queuedKey ?? ""}:${item.prompt.options.map((o) => `${o.key}${o.redacted ? "!" : ""}`).join(",")}`
        : "";
      return `m:${item.key}:${item.status}:${item.responding ? 1 : 0}:${item.reactions?.join(",") ?? ""}:${promptSig}:${item.media?.mxcUrl ?? ""}:${item.media?.filename ?? ""}:${item.body}`;
    })
    .join("\0");

  useLayoutEffect(() => {
    setOpenFailedMenuId(null);
  }, [activeTopic?.roomId]);


  useEffect(() => {
    if (activeTopicId && !topics.some((topic) => topic.roomId === activeTopicId)) {
      setActiveTopicId(null);
      setDescriptionExpanded(false);
      setEditSubmitting(false);
      resetEditForm();
      if (!deletingRef.current) {
        setDeleteConfirmOpen(false);
        setDeleteError(undefined);
      }
    }
  }, [activeTopicId, topics]);

  const navDepthRef = useRef(0);
  const targetDepth =
    viewportMode === "narrow" && !exiting
      ? (settingsOpen ? 1 : 0) +
        (creating ? 1 : 0) +
        (activeTopic ? 1 : 0) +
        (!settingsOpen && !creating && activeTopic && editing ? 1 : 0)
      : 0;

  function syncNavigationDepth(desiredDepth: number) {
    while (navDepthRef.current < desiredDepth) {
      navDepthRef.current += 1;
      platform?.pushNavigationEntry?.();
    }
    while (navDepthRef.current > desiredDepth) {
      navDepthRef.current -= 1;
      platform?.popNavigationEntry?.();
    }
  }

  useEffect(() => {
    syncNavigationDepth(targetDepth);
  }, [targetDepth, platform]);

  const backHandlerRef = useRef<() => boolean>(() => false);
  function resetAgentsForm() {
    setAgentsForm(null);
    setAgentsError(undefined);
  }

  function resetQuickRegister() {
    setQuickRegisterOpen(false);
    setQuickUserId("");
    setQuickHandwrittenName("");
    setQuickError(undefined);
  }

  function resetCreateForm() {
    setCreating(false);
    setFormError(undefined);
    resetQuickRegister();
  }

  function resetEditForm() {
    setEditing(false);
    setEditError(undefined);
    setEditPendingFields({ name: true, description: true });
  }

  const anyFormSubmitting = submitting || quickSubmitting || agentsSubmitting || editSubmitting || exiting || deleting || reauthSubmitting;

  backHandlerRef.current = () => {
    if (viewportMode !== "narrow") {
      return false;
    }
    if (settingsOpen) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (agentsSubmitting || exiting) {
        syncNavigationDepth(targetDepth);
        return true;
      }
      setSettingsOpen(false);
      resetAgentsForm();
      setExitConfirmOpen(false);
      return true;
    }
    if (creating) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (submitting || quickSubmitting) {
        syncNavigationDepth(targetDepth);
        return true;
      }
      resetCreateForm();
      return true;
    }
    if (editing && activeTopic) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (editSubmitting) {
        syncNavigationDepth(targetDepth);
        return true;
      }
      resetEditForm();
      return true;
    }
    if (activeTopic) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (deleting) {
        syncNavigationDepth(targetDepth);
        return true;
      }
      setActiveTopicId(null);
      setDescriptionExpanded(false);
      setDeleteConfirmOpen(false);
      setDeleteError(undefined);
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (platform?.onSystemBack) {
      return platform.onSystemBack(() => backHandlerRef.current());
    }
    const onPopState = () => {
      backHandlerRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [platform]);

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (creating) {
          if (quickRegisterOpen) {
            closeQuickRegister();
          } else {
            closeCreateForm();
          }
        } else if (settingsOpen) {
          if (agentsForm) {
            cancelAgentsAction();
          } else if (exitConfirmOpen) {
            cancelExitConfirm();
          } else {
            closeSettings();
          }
        } else if (editing) {
          closeEditForm();
        } else if (deleteConfirmOpen) {
          cancelDeleteConfirm();
        }
      } else if (
        (event.key === "n" || event.key === "N") &&
        (event.altKey || (!isInputTarget(event.target) && (event.metaKey || event.ctrlKey)))
      ) {
        if (!creating && !settingsOpen && !reauthRequiredRef.current) {
          event.preventDefault();
          openCreateForm();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [
    creating,
    quickRegisterOpen,
    settingsOpen,
    agentsForm,
    exitConfirmOpen,
    editing,
    deleteConfirmOpen,
  ]);

  const activeRoomId = activeTopic?.roomId;
  const currentDraftText = draftsByRoom[activeRoomId ?? ""]?.text ?? "";

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    const clampedHeight = Math.max(38, Math.min(scrollHeight, 180));
    textarea.style.height = `${clampedHeight}px`;
  }, [currentDraftText, activeRoomId]);

  function openSettings() {
    if (anyFormSubmitting) {
      return;
    }
    resetCreateForm();
    resetEditForm();
    setDeleteConfirmOpen(false);
    setDeleteError(undefined);
    resetAgentsForm();
    setExitConfirmOpen(false);
    setSettingsOpen(true);
  }

  function closeSettings() {
    if (agentsSubmitting || exiting) {
      return;
    }
    setSettingsOpen(false);
    resetAgentsForm();
    setExitConfirmOpen(false);
  }

  function openExitConfirm() {
    if (agentsSubmitting || exiting) {
      return;
    }
    resetAgentsForm();
    setExitConfirmOpen(true);
  }

  function cancelExitConfirm() {
    if (exiting) {
      return;
    }
    setExitConfirmOpen(false);
  }

  async function confirmExitDevice() {
    if (exiting || agentsSubmitting || !onExitDevice) {
      return;
    }
    setExiting(true);
    pausedRef.current = true;
    syncEpochRef.current += 1;
    syncRunIdRef.current += 1;
    syncInFlightRef.current = false;
    syncWakePendingRef.current = false;
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    clearSyncTimer();
    retryQueue.pause();
    syncNavigationDepth(0);
    try {
      await onExitDevice();
    } finally {
      if (mountedRef.current) {
        setExiting(false);
      }
    }
  }

  function openAddAgentForm() {
    if (agentsSubmitting || exiting) {
      return;
    }
    setExitConfirmOpen(false);
    setAgentsForm({ mode: "add", userId: "", handwrittenName: "" });
    setAgentsError(undefined);
  }

  function openEditAgentForm(userId: string, currentName?: string) {
    if (agentsSubmitting || exiting) {
      return;
    }
    setExitConfirmOpen(false);
    setAgentsForm({
      mode: "edit",
      userId,
      handwrittenName: currentName ?? "",
    });
    setAgentsError(undefined);
  }

  async function handleEditAgentSubmit(event: FormEvent) {
    event.preventDefault();
    if (agentsSubmitting || agentsForm?.mode !== "edit") {
      return;
    }
    const nextContent = buildRenameAgentContent(
      client.accountData("im.waypoint.agents"),
      agentsForm.userId,
      agentsForm.handwrittenName,
    );
    setAgentsSubmitting(true);
    setAgentsError(undefined);
    const result = await saveRegisteredAgents(client, "修改 Bot 名字", nextContent);
    setAgentsSubmitting(false);
    if (!result.ok) {
      setAgentsError(result.message);
      return;
    }
    resetAgentsForm();
    setRevision((value) => value + 1);
  }

  function openRemoveAgentConfirm(userId: string) {
    if (agentsSubmitting || exiting || registeredAgents.length <= 1) {
      return;
    }
    setExitConfirmOpen(false);
    setAgentsForm({ mode: "remove", userId });
    setAgentsError(undefined);
  }

  async function confirmRemoveBot() {
    if (agentsSubmitting || agentsForm?.mode !== "remove") {
      return;
    }
    if (registeredAgents.length <= 1) {
      setAgentsError("移除 Bot 失败，因为名册里至少要保留一个 Bot。");
      return;
    }
    const nextContent = buildRemoveAgentContent(
      client.accountData("im.waypoint.agents"),
      agentsForm.userId,
    );
    setAgentsSubmitting(true);
    setAgentsError(undefined);
    const result = await saveRegisteredAgents(client, "移除 Bot", nextContent);
    setAgentsSubmitting(false);
    if (!result.ok) {
      setAgentsError(result.message);
      return;
    }
    resetAgentsForm();
    setRevision((value) => value + 1);
  }

  function cancelAgentsAction() {
    if (agentsSubmitting) {
      return;
    }
    resetAgentsForm();
  }

  async function submitAddAgent({
    userId,
    handwrittenName,
    onTrimmedUserId,
    setBusy,
    setError,
    onSuccess,
  }: {
    userId: string;
    handwrittenName: string;
    onTrimmedUserId: (trimmed: string) => void;
    setBusy: (busy: boolean) => void;
    setError: (message: string | undefined) => void;
    onSuccess: (addedUserId: string) => void;
  }) {
    const validation = validateAgentUserId(userId, client.ownerId, registeredAgents);
    if (!validation.ok) {
      onTrimmedUserId(validation.trimmed);
      setError(validation.message);
      return;
    }
    const nextContent = buildAddAgentContent(
      client.accountData("im.waypoint.agents"),
      validation.userId,
      handwrittenName,
    );
    onTrimmedUserId(validation.userId);
    setBusy(true);
    setError(undefined);
    const result = await saveRegisteredAgents(client, "登记 Bot", nextContent);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSuccess(validation.userId);
    setRevision((value) => value + 1);
  }

  async function handleAddAgentSubmit(event: FormEvent) {
    event.preventDefault();
    if (agentsSubmitting || agentsForm?.mode !== "add") {
      return;
    }
    const draft = agentsForm;
    await submitAddAgent({
      userId: draft.userId,
      handwrittenName: draft.handwrittenName,
      onTrimmedUserId: (trimmed) => setAgentsForm({ ...draft, userId: trimmed }),
      setBusy: setAgentsSubmitting,
      setError: setAgentsError,
      onSuccess: () => resetAgentsForm(),
    });
  }

  function openCreateForm() {
    if (anyFormSubmitting || reauthRequiredRef.current) {
      return;
    }
    setSettingsOpen(false);
    resetEditForm();
    setDeleteConfirmOpen(false);
    setDeleteError(undefined);
    setCreating(true);
    setSubmitting(false);
    setNameInput("");
    setDescriptionInput("");
    setSelectedBotId(
      registeredAgents.length === 1
        ? registeredAgents[0].userId
        : resolvePreselectedBotId(topics, registeredAgents),
    );
    setFormError(undefined);
    resetQuickRegister();
  }

  function closeCreateForm() {
    if (submitting || quickSubmitting) {
      return;
    }
    resetCreateForm();
  }

  function openQuickRegister() {
    if (submitting || quickSubmitting) {
      return;
    }
    resetQuickRegister();
    setQuickRegisterOpen(true);
  }

  function closeQuickRegister() {
    if (quickSubmitting) {
      return;
    }
    resetQuickRegister();
  }

  async function handleQuickRegister() {
    if (quickSubmitting || submitting) {
      return;
    }
    await submitAddAgent({
      userId: quickUserId,
      handwrittenName: quickHandwrittenName,
      onTrimmedUserId: setQuickUserId,
      setBusy: setQuickSubmitting,
      setError: setQuickError,
      onSuccess: (addedUserId) => {
        setSelectedBotId(addedUserId);
        resetQuickRegister();
      },
    });
  }

  function handleQuickRegisterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void handleQuickRegister();
    }
  }

  function openEditForm() {
    if (anyFormSubmitting || !activeTopic) {
      return;
    }
    setDeleteConfirmOpen(false);
    setDeleteError(undefined);
    setEditing(true);
    setEditSubmitting(false);
    setEditNameInput(activeTopic.name);
    setEditDescriptionInput(activeTopic.description ?? "");
    setEditPendingFields({ name: true, description: true });
    setEditError(undefined);
  }

  function closeEditForm() {
    if (editSubmitting) {
      return;
    }
    resetEditForm();
  }

  function openTopic(roomId: string) {
    if (anyFormSubmitting) {
      return;
    }
    setSettingsOpen(false);
    resetCreateForm();
    resetEditForm();
    setDeleteConfirmOpen(false);
    setDeleteError(undefined);
    setActiveTopicId(roomId);
    setDescriptionExpanded(false);
  }

  function openDeleteConfirm() {
    if (anyFormSubmitting || !activeTopic || editing) {
      return;
    }
    setDeleteError(undefined);
    setDeleteConfirmOpen(true);
  }

  function cancelDeleteConfirm() {
    if (deleting) {
      return;
    }
    setDeleteConfirmOpen(false);
    setDeleteError(undefined);
  }

  function clearPinNotice() {
    if (toastNoticeTimerRef.current !== undefined) {
      clock.clearTimeout(toastNoticeTimerRef.current);
      toastNoticeTimerRef.current = undefined;
    }
    setToastNotice(undefined);
  }

  function showToastNotice(message: string) {
    if (toastNoticeTimerRef.current !== undefined) {
      clock.clearTimeout(toastNoticeTimerRef.current);
      toastNoticeTimerRef.current = undefined;
    }
    setToastNotice(message);
    toastNoticeTimerRef.current = clock.setTimeout(() => {
      toastNoticeTimerRef.current = undefined;
      if (mountedRef.current) {
        setToastNotice(undefined);
      }
    }, 4000);
  }

  async function handleTogglePin(roomId: string, currentPinned: boolean) {
    if (pinPendingRef.current.has(roomId) || anyFormSubmitting || exiting || reauthRequiredRef.current) {
      return;
    }
    pinPendingRef.current.add(roomId);
    setPinPendingByRoom((prev) => ({ ...prev, [roomId]: true }));
    clearPinNotice();
    try {
      const result = await setTopicPinned(client, roomId, !currentPinned);
      if (!mountedRef.current || !client.hasToken) {
        return;
      }
      if (!result.ok) {
        showToastNotice(result.message);
        return;
      }
      setRevision((value) => value + 1);
    } finally {
      pinPendingRef.current.delete(roomId);
      if (mountedRef.current) {
        setPinPendingByRoom((prev) => {
          if (!(roomId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[roomId];
          return next;
        });
      }
    }
  }

  async function confirmDeleteTopic() {
    if (deletingRef.current || !activeTopic) {
      return;
    }
    const targetRoomId = activeTopic.roomId;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const result = await deleteTopicRoom(client, targetRoomId);
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        setDeleteError(result.message);
        return;
      }
      delete lastRequestedReadRef.current[targetRoomId];
      bumpDraftSeq(targetRoomId);
      setDraftsByRoom((prev) => {
        if (!(targetRoomId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[targetRoomId];
        return next;
      });
      setDeleteConfirmOpen(false);
      setDeleteError(undefined);
      setActiveTopicId(null);
      setDescriptionExpanded(false);
      resetEditForm();
      setRevision((value) => value + 1);
    } finally {
      deletingRef.current = false;
      if (mountedRef.current) {
        setDeleting(false);
      }
    }
  }

  function goBack() {
    if (settingsOpen) {
      closeSettings();
      return;
    }
    if (creating) {
      closeCreateForm();
      return;
    }
    if (editing && activeTopic) {
      closeEditForm();
      return;
    }
    if (activeTopic) {
      if (deleting) {
        return;
      }
      setActiveTopicId(null);
      setDescriptionExpanded(false);
      setDeleteConfirmOpen(false);
      setDeleteError(undefined);
    }
  }

  function clearSyncTimer() {
    if (syncTimerRef.current !== undefined) {
      clock.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = undefined;
    }
  }

  function pauseForCredentialRejection() {
    syncEpochRef.current += 1;
    syncRunIdRef.current += 1;
    pausedRef.current = true;
    syncInFlightRef.current = false;
    syncWakePendingRef.current = false;
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    clearSyncTimer();
    retryQueue.pause();
    if (mountedRef.current) {
      setReauthRequired(true);
    }
  }

  function scheduleForegroundSync(delayMs: number) {
    clearSyncTimer();
    if (!mountedRef.current || isSyncPaused()) {
      return;
    }
    syncTimerRef.current = clock.setTimeout(() => {
      syncTimerRef.current = undefined;
      void runForegroundSync();
    }, delayMs);
  }

  function suspendForBackground() {
    if (!suspendInBackground || backgroundSuspendedRef.current) {
      return;
    }
    backgroundSuspendedRef.current = true;
    syncEpochRef.current += 1;
    syncRunIdRef.current += 1;
    syncInFlightRef.current = false;
    syncWakePendingRef.current = false;
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    clearSyncTimer();
    retryQueue.pause();
  }

  function resumeFromBackground() {
    const wasSuspended = backgroundSuspendedRef.current;
    backgroundSuspendedRef.current = false;
    if (!mountedRef.current || pausedRef.current || !client.hasToken) {
      return;
    }
    if (!wasSuspended) {
      if (!syncInFlightRef.current && syncBackoffRef.current > 0) {
        syncBackoffRef.current = 0;
        clearSyncTimer();
        void runForegroundSync();
        retryQueue.resume();
        retryQueue.wake();
      }
      if (activeVisibleRoomRef.current) {
        setRevision((value) => value + 1);
      }
      return;
    }
    syncBackoffRef.current = 0;
    clearSyncTimer();
    void runForegroundSync();
    retryQueue.resume();
    retryQueue.wake();
    if (activeVisibleRoomRef.current) {
      setBackfillTick((value) => value + 1);
      setRevision((value) => value + 1);
    }
  }

  function handleNetworkResume() {
    if (!mountedRef.current || isSyncPaused() || !client.hasToken) {
      return;
    }
    if (syncInFlightRef.current) {
      syncEpochRef.current += 1;
      syncRunIdRef.current += 1;
      syncInFlightRef.current = false;
      syncAbortControllerRef.current?.abort();
      syncAbortControllerRef.current = null;
    }
    syncWakePendingRef.current = false;
    syncBackoffRef.current = 0;
    clearSyncTimer();
    void runForegroundSync();
    retryQueue.resume();
    retryQueue.wake();
  }

  async function runForegroundSync() {
    if (syncInFlightRef.current || !mountedRef.current || isSyncPaused() || !client.hasToken) {
      return;
    }
    const myRunId = ++syncRunIdRef.current;
    const mySyncEpoch = syncEpochRef.current;
    syncInFlightRef.current = true;
    clearSyncTimer();
    const controller = new AbortController();
    syncAbortControllerRef.current = controller;
    let syncSucceeded = false;
    try {
      let attempt;
      try {
        attempt = await client.sync({ signal: controller.signal });
      } catch {
        if (
          !mountedRef.current ||
          isSyncPaused() ||
          syncEpochRef.current !== mySyncEpoch ||
          controller.signal.aborted
        ) {
          return;
        }
        const delay = RETRY_BACKOFF_MS[Math.min(syncBackoffRef.current, RETRY_BACKOFF_MS.length - 1)];
        syncBackoffRef.current += 1;
        scheduleForegroundSync(delay);
        return;
      }
      if (
        !mountedRef.current ||
        isSyncPaused() ||
        syncEpochRef.current !== mySyncEpoch ||
        controller.signal.aborted ||
        isAbortedFailure(attempt.result)
      ) {
        return;
      }
      if (isSyncCursorRejected(attempt.incremental, attempt.result)) {
        await client.dropSyncCursor();
        if (
          !mountedRef.current ||
          isSyncPaused() ||
          syncEpochRef.current !== mySyncEpoch ||
          controller.signal.aborted
        ) {
          return;
        }
        try {
          attempt = await client.sync({ signal: controller.signal });
        } catch {
          if (
            !mountedRef.current ||
            isSyncPaused() ||
            syncEpochRef.current !== mySyncEpoch ||
            controller.signal.aborted
          ) {
            return;
          }
          const delay = RETRY_BACKOFF_MS[Math.min(syncBackoffRef.current, RETRY_BACKOFF_MS.length - 1)];
          syncBackoffRef.current += 1;
          scheduleForegroundSync(delay);
          return;
        }
        if (
          !mountedRef.current ||
          isSyncPaused() ||
          syncEpochRef.current !== mySyncEpoch ||
          controller.signal.aborted ||
          isAbortedFailure(attempt.result)
        ) {
          return;
        }
      }
      if (isCredentialRejected(attempt.result)) {
        pauseForCredentialRejection();
        return;
      }
      if (attempt.result.type === "response" && attempt.result.status === 200) {
        syncSucceeded = true;
        const wasBackedOff = syncBackoffRef.current > 0;
        syncBackoffRef.current = 0;
        await client.retainSync(attempt);
        if (!mountedRef.current || isSyncPaused() || syncEpochRef.current !== mySyncEpoch) {
          return;
        }
        if (parseRegisteredAgents(client.accountData("im.waypoint.agents"), client.ownerId).length === 0) {
          onAgentsInvalidated?.();
          return;
        }
        await retryQueue.failUnavailablePendingEvents();
        if (!mountedRef.current || isSyncPaused() || syncEpochRef.current !== mySyncEpoch) {
          return;
        }
        setRevision((value) => value + 1);
        if (wasBackedOff && (retryQueue.isActive() || client.pendingRoomEvents().length > 0 || client.pendingReadMarkers().length > 0)) {
          retryQueue.wake();
        }
        scheduleForegroundSync(FOREGROUND_SYNC_INTERVAL_MS);
        return;
      }
      const delay = RETRY_BACKOFF_MS[Math.min(syncBackoffRef.current, RETRY_BACKOFF_MS.length - 1)];
      syncBackoffRef.current += 1;
      scheduleForegroundSync(delay);
    } finally {
      if (syncRunIdRef.current === myRunId) {
        syncInFlightRef.current = false;
        if (syncAbortControllerRef.current === controller) {
          syncAbortControllerRef.current = null;
        }
        if (
          syncWakePendingRef.current &&
          !syncSucceeded &&
          mountedRef.current &&
          !isSyncPaused() &&
          client.hasToken
        ) {
          syncWakePendingRef.current = false;
          clearSyncTimer();
          void runForegroundSync();
        } else {
          syncWakePendingRef.current = false;
        }
      }
    }
  }

  const visibleComposerRoomId =
    !settingsOpen && !creating && !editing && activeTopic ? activeTopic.roomId : null;
  activeVisibleRoomRef.current = visibleComposerRoomId;

  useEffect(() => {
    if (visibleComposerRoomId === null) {
      setOpenFailedMenuId(null);
    }
  }, [visibleComposerRoomId]);

  useEffect(() => {
    if (!openFailedMenuId) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenFailedMenuId(null);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".waypoint-failed-controls")) {
        return;
      }
      setOpenFailedMenuId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [openFailedMenuId]);

  useEffect(() => {
    const prevRoomId = visibleComposerRoomRef.current;
    visibleComposerRoomRef.current = visibleComposerRoomId;
    if (prevRoomId && prevRoomId !== visibleComposerRoomId) {
      setComposerError(undefined);
      setDraftsByRoom((prev) => {
        const draft = prev[prevRoomId];
        if (!draft) {
          return prev;
        }
        const hasText = typeof draft.text === "string" && draft.text.trim() !== "";
        if (hasText) {
          return prev;
        }
        if (draft.attachment) {
          if (draft.text === undefined) {
            return prev;
          }
          return { ...prev, [prevRoomId]: { attachment: draft.attachment } };
        }
        const next = { ...prev };
        delete next[prevRoomId];
        return next;
      });
    }
  }, [visibleComposerRoomId]);

  useEffect(() => {
    setDraftsByRoom(client.drafts());
  }, [client]);

  useEffect(() => {
    for (const roomId of Object.keys(lastRequestedReadRef.current)) {
      if (!(roomId in rooms)) {
        delete lastRequestedReadRef.current[roomId];
      }
    }
    setDraftsByRoom((prev) => {
      const staleIds = Object.keys(prev).filter((roomId) => !(roomId in rooms));
      if (staleIds.length === 0) {
        return prev;
      }
      const next = { ...prev };
      for (const id of staleIds) {
        delete next[id];
      }
      return next;
    });
  }, [rooms]);

  useEffect(() => {
    mountedRef.current = true;
    const isReauth = initialReauthRequired || retryQueue.isPaused;
    pausedRef.current = isReauth;
    if (isReauth) {
      retryQueue.pause();
      setReauthRequired(true);
    }
    client.setCredentialRejectedHandler(() => {
      if (mountedRef.current) {
        pauseForCredentialRejection();
      }
    });
    retryQueue.setCallbacks({
      onConfirmed: () => {
        if (mountedRef.current) {
          setRevision((value) => value + 1);
        }
      },
      onFailed: () => {
        if (mountedRef.current) {
          setRevision((value) => value + 1);
        }
      },
      onCredentialRejected: () => {
        if (mountedRef.current) {
          pauseForCredentialRejection();
        }
      },
      isRoomUnavailable: (roomId) =>
        deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable,
    });
    if (!pausedRef.current) {
      if (suspendInBackground && !readAppVisible()) {
        backgroundSuspendedRef.current = true;
        retryQueue.pause();
      } else {
        backgroundSuspendedRef.current = false;
        if (initialSyncImmediate && !initialReauthRequired) {
          void runForegroundSync();
        } else {
          scheduleForegroundSync(FOREGROUND_SYNC_INTERVAL_MS);
        }
        if (
          (client.pendingRoomEvents().length > 0 || client.pendingReadMarkers().length > 0) &&
          !retryQueue.isActive()
        ) {
          void retryQueue.flush();
        }
      }
    }
    const handleVisibility = (visible: boolean) => {
      if (!mountedRef.current) {
        return;
      }
      if (suspendInBackground) {
        if (!visible) {
          suspendForBackground();
        } else {
          resumeFromBackground();
        }
      } else if (visible) {
        resumeFromBackground();
      }
    };
    let unsubVisibility: () => void;
    if (platform?.subscribeAppVisibility) {
      unsubVisibility = platform.subscribeAppVisibility(handleVisibility);
    } else {
      const onVis = () =>
        handleVisibility(typeof document === "undefined" ? true : document.visibilityState !== "hidden");
      const onHide = () => handleVisibility(false);
      const onShow = () =>
        handleVisibility(typeof document === "undefined" ? true : document.visibilityState !== "hidden");
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
    if (platform?.subscribeNetworkResume) {
      unsubResume = platform.subscribeNetworkResume(handleNetworkResume);
    } else {
      window.addEventListener("online", handleNetworkResume);
      unsubResume = () => window.removeEventListener("online", handleNetworkResume);
    }
    return () => {
      mountedRef.current = false;
      syncAbortControllerRef.current?.abort();
      syncAbortControllerRef.current = null;
      clearSyncTimer();
      if (toastNoticeTimerRef.current !== undefined) {
        clock.clearTimeout(toastNoticeTimerRef.current);
        toastNoticeTimerRef.current = undefined;
      }
      unsubVisibility();
      unsubResume();
      for (const entry of downloadedMediaCacheRef.current.values()) {
        entry.revoke?.();
      }
      downloadedMediaCacheRef.current.clear();
      for (const entry of localMediaUrlCacheRef.current.values()) {
        entry.revoke?.();
      }
      localMediaUrlCacheRef.current.clear();
      client.setCredentialRejectedHandler(undefined);
      retryQueue.setCallbacks({});
      if (!providedRetryQueue) {
        retryQueue.dispose();
      }
    };
  }, [client, clock, retryQueue, providedRetryQueue, platform]);

  function setTimelineScrollTop(container: HTMLElement, nextTop: number) {
    programmaticScrollRef.current = { active: true, top: nextTop };
    container.scrollTop = nextTop;
  }

  async function triggerScrollBackfill(roomId: string) {
    if (
      pausedRef.current ||
      reauthRequiredRef.current ||
      exiting ||
      !client.hasToken ||
      backfillInFlightRoomsRef.current.has(roomId)
    ) {
      return;
    }
    const target = nextBackfillTargetForScrollUp(client.rooms()[roomId]);
    if (!target) {
      return;
    }
    backfillInFlightRoomsRef.current.add(roomId);
    const leaveGen = client.currentLeaveGeneration;
    const myEpoch = syncEpochRef.current;
    try {
      let result: TransportResult;
      try {
        result = await client.roomMessagesBackward(roomId, target.fromToken, BACKFILL_PAGE_LIMIT);
      } catch {
        return;
      }
      if (
        !mountedRef.current ||
        pausedRef.current ||
        reauthRequiredRef.current ||
        exiting ||
        !client.hasToken ||
        syncEpochRef.current !== myEpoch
      ) {
        return;
      }
      if (isCredentialRejected(result)) {
        pauseForCredentialRejection();
        return;
      }
      if (result.type !== "response" || result.status !== 200) {
        return;
      }
      const el = timelineRef.current;
      const shouldPreserve = el !== null && activeVisibleRoomRef.current === roomId;
      const prevScrollHeight = el?.scrollHeight ?? 0;
      const prevScrollTop = el?.scrollTop ?? 0;
      await client.applyBackfillPage(roomId, {
        fromToken: target.fromToken,
        body: result.body,
        gapIndex: target.gapIndex,
        leaveGeneration: leaveGen,
      });
      if (!mountedRef.current || pausedRef.current || syncEpochRef.current !== myEpoch) {
        return;
      }
      if (shouldPreserve && el) {
        pendingScrollPreserveRef.current = {
          roomId,
          prevScrollHeight,
          prevScrollTop,
        };
      }
      setRevision((value) => value + 1);
    } finally {
      backfillInFlightRoomsRef.current.delete(roomId);
    }
  }

  useEffect(() => {
    if (userScrolledRoomRef.current !== visibleComposerRoomId) {
      userScrolledRoomRef.current = null;
    }
    for (const roomId of Array.from(openBackfillStoppedRoomsRef.current)) {
      if (roomId !== visibleComposerRoomId) {
        openBackfillStoppedRoomsRef.current.delete(roomId);
      }
    }
    if (!visibleComposerRoomId || !activeTopic || !activeTopic.readPositionUnknown) {
      return;
    }
    if (
      pausedRef.current ||
      reauthRequiredRef.current ||
      exiting ||
      !client.hasToken ||
      backfillInFlightRoomsRef.current.has(visibleComposerRoomId) ||
      openBackfillStoppedRoomsRef.current.has(visibleComposerRoomId)
    ) {
      return;
    }
    if (!nextBackfillTargetForReadPosition(client.rooms()[visibleComposerRoomId])) {
      return;
    }
    const roomId = visibleComposerRoomId;
    const myEpoch = syncEpochRef.current;
    awaitingReadPosLandingRoomRef.current = roomId;
    backfillInFlightRoomsRef.current.add(roomId);
    let cancelled = false;
    void (async () => {
      try {
        while (
          !cancelled &&
          mountedRef.current &&
          !pausedRef.current &&
          !reauthRequiredRef.current &&
          !exiting &&
          client.hasToken &&
          syncEpochRef.current === myEpoch &&
          activeVisibleRoomRef.current === roomId
        ) {
          const currentRoom = client.rooms()[roomId];
          const target = nextBackfillTargetForReadPosition(currentRoom);
          if (!target) {
            break;
          }
          const leaveGen = client.currentLeaveGeneration;
          let result: TransportResult;
          try {
            result = await client.roomMessagesBackward(
              roomId,
              target.fromToken,
              BACKFILL_PAGE_LIMIT,
            );
          } catch {
            openBackfillStoppedRoomsRef.current.add(roomId);
            break;
          }
          if (
            cancelled ||
            !mountedRef.current ||
            pausedRef.current ||
            reauthRequiredRef.current ||
            exiting ||
            !client.hasToken ||
            syncEpochRef.current !== myEpoch
          ) {
            break;
          }
          if (isCredentialRejected(result)) {
            pauseForCredentialRejection();
            break;
          }
          if (result.type !== "response" || result.status !== 200) {
            openBackfillStoppedRoomsRef.current.add(roomId);
            break;
          }
          const el = timelineRef.current;
          const shouldPreserve =
            el !== null &&
            activeVisibleRoomRef.current === roomId &&
            userScrolledRoomRef.current === roomId;
          const prevScrollHeight = el?.scrollHeight ?? 0;
          const prevScrollTop = el?.scrollTop ?? 0;
          const outcome = await client.applyBackfillPage(roomId, {
            fromToken: target.fromToken,
            body: result.body,
            gapIndex: target.gapIndex,
            leaveGeneration: leaveGen,
          });
          if (cancelled || !mountedRef.current || pausedRef.current || syncEpochRef.current !== myEpoch) {
            break;
          }
          if (shouldPreserve && el) {
            pendingScrollPreserveRef.current = {
              roomId,
              prevScrollHeight,
              prevScrollTop,
            };
          }
          setRevision((value) => value + 1);
          if (outcome.hasReadPosition) {
            break;
          }
          if (!nextBackfillTargetForReadPosition(client.rooms()[roomId])) {
            openBackfillStoppedRoomsRef.current.add(roomId);
            break;
          }
        }
      } finally {
        backfillInFlightRoomsRef.current.delete(roomId);
        if (mountedRef.current && activeVisibleRoomRef.current === roomId) {
          setRevision((value) => value + 1);
          if (cancelled) {
            setBackfillTick((value) => value + 1);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visibleComposerRoomId, activeTopic?.readPositionUnknown, backfillTick, client, exiting, reauthRequired]);

  function collapseDescription() {
    setDescriptionExpanded(false);
  }

  function handleTimelineScroll() {
    collapseDescription();
    const el = timelineRef.current;
    if (el && programmaticScrollRef.current.active) {
      const same = Math.abs(el.scrollTop - programmaticScrollRef.current.top) < 1;
      programmaticScrollRef.current.active = false;
      if (same) {
        return;
      }
    }
    if (visibleComposerRoomId) {
      userScrolledRoomRef.current = visibleComposerRoomId;
    }
    if (el) {
      isAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX;
      if (visibleComposerRoomId && el.scrollTop <= TOP_SCROLL_THRESHOLD_PX) {
        void triggerScrollBackfill(visibleComposerRoomId);
      }
    }
    if (visibleComposerRoomId) {
      evaluateVisibleReadPosition(visibleComposerRoomId);
    }
  }

  function measureRowVisibility(container: HTMLElement): Map<string, BubbleVisibility> {
    const map = new Map<string, BubbleVisibility>();
    const rowEls = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"));
    if (rowEls.length === 0) {
      return map;
    }
    const containerRect = container.getBoundingClientRect();
    const useRects =
      containerRect.height > 0 &&
      rowEls.some((el) => el.getBoundingClientRect().height > 0);
    if (useRects) {
      for (const el of rowEls) {
        const eventId = el.dataset.eventId;
        if (!eventId) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom <= containerRect.top) {
          map.set(eventId, "above");
        } else if (rect.top >= containerRect.bottom) {
          map.set(eventId, "below");
        } else {
          map.set(eventId, "visible");
        }
      }
      return map;
    }
    const useOffsets =
      container.clientHeight > 0 &&
      rowEls.some((el) => el.offsetHeight > 0 || el.offsetTop > 0);
    if (useOffsets) {
      const top = container.scrollTop;
      const bottom = top + container.clientHeight;
      for (const el of rowEls) {
        const eventId = el.dataset.eventId;
        if (!eventId) continue;
        const elTop = el.offsetTop;
        const elBottom = elTop + el.offsetHeight;
        if (elBottom <= top) {
          map.set(eventId, "above");
        } else if (elTop >= bottom) {
          map.set(eventId, "below");
        } else {
          map.set(eventId, "visible");
        }
      }
      return map;
    }
    for (const el of rowEls) {
      const eventId = el.dataset.eventId;
      if (eventId) {
        map.set(eventId, "visible");
      }
    }
    return map;
  }

  function evaluateVisibleReadPosition(roomId: string) {
    if (
      !client.hasToken ||
      exiting ||
      reauthRequiredRef.current ||
      backgroundSuspendedRef.current ||
      !readAppVisible()
    ) {
      return;
    }
    const container = timelineRef.current;
    const room = client.rooms()[roomId];
    const topic = topics.find((item) => item.roomId === roomId);
    if (!container || !room || !topic) {
      return;
    }
    const visibilityByEventId = measureRowVisibility(container);
    const targetEventId = computeTargetReadPosition(
      room,
      client.ownerId,
      topic.agentUserId,
      visibilityByEventId,
    );
    if (!targetEventId) {
      return;
    }
    const prevRequested = lastRequestedReadRef.current[roomId];
    if (prevRequested) {
      const prevIdx = room.timelineEvents.findIndex((ev) => ev.event_id === prevRequested);
      const targetIdx = room.timelineEvents.findIndex((ev) => ev.event_id === targetEventId);
      if (prevIdx !== -1 && targetIdx !== -1 && prevIdx >= targetIdx) {
        return;
      }
    }
    lastRequestedReadRef.current[roomId] = targetEventId;
    void client
      .advanceReadPosition(roomId, targetEventId)
      .then((changed) => {
        if (!changed || !mountedRef.current) {
          return;
        }
        setRevision((value) => value + 1);
        if (!isSyncPaused()) {
          retryQueue.wakeReadMarkers();
        }
      })
      .catch(() => {
        if (lastRequestedReadRef.current[roomId] === targetEventId) {
          delete lastRequestedReadRef.current[roomId];
        }
      });
  }

  function landTimelineScroll(container: HTMLElement, firstUnreadEventId: string | undefined) {
    if (firstUnreadEventId) {
      const rowEls = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"));
      const targetEl = rowEls.find((el) => el.dataset.eventId === firstUnreadEventId);
      if (targetEl) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        if (containerRect.height > 0 && targetRect.height > 0) {
          const desiredTop = container.scrollTop + (targetRect.top - containerRect.top);
          setTimelineScrollTop(
            container,
            maxScroll > 0 ? Math.max(0, Math.min(desiredTop, maxScroll)) : Math.max(0, desiredTop),
          );
        } else if (container.clientHeight > 0) {
          setTimelineScrollTop(container, Math.max(0, Math.min(targetEl.offsetTop, maxScroll)));
        }
      }
      isAtBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight <=
        AT_BOTTOM_THRESHOLD_PX;
    } else {
      setTimelineScrollTop(
        container,
        Math.max(0, container.scrollHeight - container.clientHeight),
      );
      isAtBottomRef.current = true;
    }
  }

  useLayoutEffect(() => {
    if (!visibleComposerRoomId || !activeTopic || activeTopic.roomId !== visibleComposerRoomId) {
      lastLandedRoomRef.current = null;
      awaitingReadPosLandingRoomRef.current = null;
      pendingScrollPreserveRef.current = null;
      isAtBottomRef.current = true;
      prevTimelineKeyRef.current = "";
      return;
    }
    const container = timelineRef.current;
    if (!container) {
      return;
    }
    const shouldWaitForBackfill =
      !reauthRequired &&
      activeTopic.readPositionUnknown &&
      Boolean(nextBackfillTargetForReadPosition(rooms[visibleComposerRoomId])) &&
      !openBackfillStoppedRoomsRef.current.has(visibleComposerRoomId);

    if (lastLandedRoomRef.current !== visibleComposerRoomId) {
      lastLandedRoomRef.current = visibleComposerRoomId;
      if (shouldWaitForBackfill) {
        awaitingReadPosLandingRoomRef.current = visibleComposerRoomId;
      } else {
        awaitingReadPosLandingRoomRef.current = null;
        landTimelineScroll(container, activeTopic.firstUnreadEventId);
      }
      prevTimelineKeyRef.current = timelineContentKey;
    } else if (
      awaitingReadPosLandingRoomRef.current === visibleComposerRoomId &&
      !shouldWaitForBackfill
    ) {
      awaitingReadPosLandingRoomRef.current = null;
      pendingScrollPreserveRef.current = null;
      if (userScrolledRoomRef.current !== visibleComposerRoomId) {
        landTimelineScroll(container, activeTopic.firstUnreadEventId);
      }
      prevTimelineKeyRef.current = timelineContentKey;
    } else if (pendingScrollPreserveRef.current?.roomId === visibleComposerRoomId) {
      const pending = pendingScrollPreserveRef.current;
      pendingScrollPreserveRef.current = null;
      const delta = container.scrollHeight - pending.prevScrollHeight;
      setTimelineScrollTop(container, Math.max(0, pending.prevScrollTop + delta));
      isAtBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight <=
        AT_BOTTOM_THRESHOLD_PX;
      prevTimelineKeyRef.current = timelineContentKey;
    } else if (prevTimelineKeyRef.current !== timelineContentKey) {
      prevTimelineKeyRef.current = timelineContentKey;
      if (isAtBottomRef.current) {
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        let nextTop = maxScroll;
        const currentRoom = rooms[visibleComposerRoomId];
        if (
          activeTopic.firstUnreadEventId &&
          !hasLimitedGapAfterReadPosition(currentRoom)
        ) {
          const rowEls = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"));
          const targetEl = rowEls.find(
            (el) => el.dataset.eventId === activeTopic.firstUnreadEventId,
          );
          if (targetEl) {
            const containerRect = container.getBoundingClientRect();
            const targetRect = targetEl.getBoundingClientRect();
            let desiredTop: number | undefined;
            if (containerRect.height > 0 && targetRect.height > 0) {
              desiredTop = Math.max(
                0,
                container.scrollTop + (targetRect.top - containerRect.top),
              );
            } else if (container.clientHeight > 0) {
              desiredTop = Math.max(0, targetEl.offsetTop);
            }
            if (desiredTop !== undefined && desiredTop >= container.scrollTop) {
              nextTop = Math.min(maxScroll, desiredTop);
            }
          }
        }
        setTimelineScrollTop(container, nextTop);
        isAtBottomRef.current =
          container.scrollHeight - container.scrollTop - container.clientHeight <=
          AT_BOTTOM_THRESHOLD_PX;
      }
    }
    evaluateVisibleReadPosition(visibleComposerRoomId);
  });
  function bumpDraftSeq(roomId: string): number {
    const next = (draftMutationSeqRef.current[roomId] ?? 0) + 1;
    draftMutationSeqRef.current[roomId] = next;
    return next;
  }

  async function handleSelectAttachment(roomId: string, file: File) {
    if (reauthRequiredRef.current) {
      return;
    }
    const seq = bumpDraftSeq(roomId);
    let data: Uint8Array;
    try {
      data = await readFileBytes(file);
    } catch {
      return;
    }
    if (draftMutationSeqRef.current[roomId] !== seq) {
      return;
    }
    const existingText = draftsByRoomRef.current[roomId]?.text;
    const attachment: DraftAttachment = {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: data.byteLength,
      data,
    };
    const nextDraft: DraftRecord = {
      ...(existingText !== undefined && existingText !== "" ? { text: existingText } : {}),
      attachment,
    };
    setDraftsByRoom((prev) => ({ ...prev, [roomId]: nextDraft }));
    if (composerError) {
      setComposerError(undefined);
    }
    void client.setDraft(roomId, nextDraft).catch(() => undefined);
  }

  function handleRemoveAttachment(roomId: string) {
    if (reauthRequiredRef.current) {
      return;
    }
    bumpDraftSeq(roomId);
    const existingText = draftsByRoomRef.current[roomId]?.text;
    const hasText = typeof existingText === "string" && existingText !== "";
    const nextDraft: DraftRecord | undefined = hasText ? { text: existingText } : undefined;
    setDraftsByRoom((prev) => {
      const next = { ...prev };
      if (nextDraft) {
        next[roomId] = nextDraft;
      } else {
        delete next[roomId];
      }
      return next;
    });
    if (composerError) {
      setComposerError(undefined);
    }
    void client.setDraft(roomId, nextDraft).catch(() => undefined);
  }

  function updateDraftText(roomId: string, text: string) {
    if (reauthRequiredRef.current) {
      return;
    }
    bumpDraftSeq(roomId);
    const existingAttachment = draftsByRoomRef.current[roomId]?.attachment;
    const nextDraft: DraftRecord = {
      ...(text !== "" ? { text } : {}),
      ...(existingAttachment ? { attachment: existingAttachment } : {}),
    };
    setDraftsByRoom((prev) => {
      const next = { ...prev };
      if (nextDraft.text !== undefined || nextDraft.attachment !== undefined) {
        next[roomId] = nextDraft;
      } else {
        delete next[roomId];
      }
      return next;
    });
    if (composerError) {
      setComposerError(undefined);
    }
    void client.setDraft(roomId, nextDraft).catch(() => undefined);
  }

  async function handleResendFailed(roomId: string, localId: string) {
    if (
      reauthRequiredRef.current ||
      resendingLocalIdsRef.current.has(localId) ||
      discardingLocalIdsRef.current.has(localId)
    ) {
      return;
    }
    setOpenFailedMenuId((prev) => (prev === localId ? null : prev));
    if (deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable) {
      return;
    }
    resendingLocalIdsRef.current.add(localId);
    try {
      const pending = await client.resendFailedRoomEvent(roomId, localId);
      if (pending && mountedRef.current) {
        setRevision((value) => value + 1);
        retryQueue.wake();
      }
    } finally {
      resendingLocalIdsRef.current.delete(localId);
    }
  }

  async function handleSelectPromptOption(roomId: string, targetEventId: string, key: string) {
    if (reauthRequiredRef.current || exiting) {
      return;
    }
    if (deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable) {
      return;
    }
    await client.enqueueOrReplacePromptReaction(roomId, targetEventId, key);
    if (!mountedRef.current) {
      return;
    }
    setRevision((value) => value + 1);
    retryQueue.wakeEvents();
  }

  async function handleDiscardFailed(roomId: string, localId: string) {
    if (resendingLocalIdsRef.current.has(localId) || discardingLocalIdsRef.current.has(localId)) {
      return;
    }
    setOpenFailedMenuId((prev) => (prev === localId ? null : prev));
    discardingLocalIdsRef.current.add(localId);
    try {
      const removed = await client.discardFailedRoomEvent(roomId, localId);
      if (removed && mountedRef.current) {
        setRevision((value) => value + 1);
      }
    } finally {
      discardingLocalIdsRef.current.delete(localId);
    }
  }

  function getOrCreateLocalImageUrl(localId: string, attachment: DraftAttachment): string {
    const existing = localMediaUrlCacheRef.current.get(localId);
    if (existing && existing.dataRef === attachment.data) {
      return existing.url;
    }
    existing?.revoke?.();
    const created = createRenderableMediaUrl(attachment.data, attachment.mimeType);
    localMediaUrlCacheRef.current.set(localId, {
      dataRef: attachment.data,
      url: created.url,
      revoke: created.revoke,
    });
    return created.url;
  }

  useEffect(() => {
    if (reauthRequired || !client.hasToken || exiting) {
      return;
    }
    for (const item of activeTimelineItems) {
      if (item.kind !== "message" || !item.media || item.media.kind !== "image") {
        continue;
      }
      const mxcUrl = item.media.mxcUrl;
      if (
        !mxcUrl ||
        item.media.localAttachment ||
        downloadedMediaCacheRef.current.has(mxcUrl) ||
        downloadingMediaRef.current.has(mxcUrl) ||
        failedImageMxcUrlsRef.current.has(mxcUrl)
      ) {
        continue;
      }
      downloadingMediaRef.current.add(mxcUrl);
      const fallbackMime = item.media.mimeType || "image/png";
      void client
        .downloadMedia(mxcUrl)
        .then((result) => {
          if (!mountedRef.current || !client.hasToken) {
            return;
          }
          if (isCredentialRejected(result)) {
            pauseForCredentialRejection();
            return;
          }
          const bytes =
            result.type === "response" && result.status >= 200 && result.status < 300
              ? extractBytesFromTransportBody(result.body)
              : undefined;
          if (!bytes) {
            failedImageMxcUrlsRef.current.add(mxcUrl);
            return;
          }
          const created = createRenderableMediaUrl(bytes, fallbackMime);
          downloadedMediaCacheRef.current.set(mxcUrl, {
            data: bytes,
            mimeType: fallbackMime,
            imageUrl: created.url,
            revoke: created.revoke,
          });
          setMediaRevision((value) => value + 1);
        })
        .catch(() => {
          failedImageMxcUrlsRef.current.add(mxcUrl);
        })
        .finally(() => {
          downloadingMediaRef.current.delete(mxcUrl);
        });
    }
  }, [timelineContentKey, visibleComposerRoomId, client, exiting, reauthRequired]);

  function handleOpenExternalUrl(url: string) {
    if (platform?.openExternalUrl) {
      void Promise.resolve(platform.openExternalUrl(url)).catch(() => undefined);
      return;
    }
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  async function invokePlatformOpenMedia(input: {
    data: Uint8Array;
    mimeType: string;
    filename: string;
  }) {
    if (platform?.openMediaFile) {
      await Promise.resolve(platform.openMediaFile(input));
      return;
    }
    if (typeof document !== "undefined") {
      const created = createRenderableMediaUrl(input.data, input.mimeType);
      const anchor = document.createElement("a");
      anchor.href = created.url;
      anchor.download = input.filename;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
      if (created.revoke) {
        clock.setTimeout(() => created.revoke?.(), 60_000);
      }
    }
  }

  async function handleOpenMedia(media: TimelineMedia) {
    if (media.externalUrl) {
      handleOpenExternalUrl(media.externalUrl);
      return;
    }
    if (media.localAttachment) {
      try {
        await invokePlatformOpenMedia({
          data: new Uint8Array(media.localAttachment.data),
          mimeType: media.localAttachment.mimeType,
          filename: media.localAttachment.name,
        });
      } catch {
        showToastNotice("打开附件失败，请重试。");
      }
      return;
    }
    const mxcUrl = media.mxcUrl;
    if (!mxcUrl) {
      return;
    }
    let cached = downloadedMediaCacheRef.current.get(mxcUrl);
    if (!cached) {
      if (reauthRequiredRef.current || !client.hasToken) {
        return;
      }
      failedImageMxcUrlsRef.current.delete(mxcUrl);
      let result: TransportResult;
      try {
        result = await client.downloadMedia(mxcUrl);
      } catch {
        showToastNotice("打开附件失败，请重试。");
        return;
      }
      if (!mountedRef.current || !client.hasToken) {
        return;
      }
      if (isCredentialRejected(result)) {
        pauseForCredentialRejection();
        return;
      }
      const bytes =
        result.type === "response" && result.status >= 200 && result.status < 300
          ? extractBytesFromTransportBody(result.body)
          : undefined;
      if (!bytes) {
        if (media.kind === "image") {
          failedImageMxcUrlsRef.current.add(mxcUrl);
        }
        showToastNotice("打开附件失败，请重试。");
        return;
      }
      const mimeType = media.mimeType || "application/octet-stream";
      const created = media.kind === "image" ? createRenderableMediaUrl(bytes, mimeType) : undefined;
      cached = {
        data: bytes,
        mimeType,
        ...(created ? { imageUrl: created.url, revoke: created.revoke } : {}),
      };
      downloadedMediaCacheRef.current.set(mxcUrl, cached);
      if (media.kind === "image") {
        setMediaRevision((value) => value + 1);
      }
    }
    try {
      await invokePlatformOpenMedia({
        data: new Uint8Array(cached.data),
        mimeType: media.mimeType || cached.mimeType,
        filename: media.filename,
      });
    } catch {
      showToastNotice("打开附件失败，请重试。");
    }
  }

  function buildAttachmentEventContent(
    attachment: DraftAttachment,
    captionText: string,
  ): Record<string, unknown> {
    const msgtype = attachment.mimeType.startsWith("image/") ? "m.image" : "m.file";
    const body = captionText.trim() !== "" ? captionText : attachment.name;
    return {
      msgtype,
      body,
      filename: attachment.name,
      info: {
        mimetype: attachment.mimeType,
        size: attachment.size,
      },
    };
  }

  async function sendComposerAttachmentMessage(
    roomId: string,
    attachment: DraftAttachment,
    captionText: string,
  ) {
    if (persistingSendRef.current || reauthRequiredRef.current) {
      return;
    }
    if (deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable) {
      return;
    }
    persistingSendRef.current = true;
    setPersistingSend(true);
    setComposerError(undefined);
    try {
      const content = buildAttachmentEventContent(attachment, captionText);
      await client.enqueueRoomEvent(roomId, "m.room.message", content, {
        clearDraft: true,
        attachment,
      });
      bumpDraftSeq(roomId);
      setDraftsByRoom((prev) => {
        if (!(roomId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
      setRevision((value) => value + 1);
      void retryQueue.flush();
    } catch {
      setComposerError("消息保存失败，请重试。");
    } finally {
      persistingSendRef.current = false;
      setPersistingSend(false);
    }
  }

  async function sendMultipleAttachmentsInOrder(roomId: string, files: File[]) {
    if (files.length === 0 || persistingSendRef.current || reauthRequiredRef.current) {
      return;
    }
    if (deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable) {
      return;
    }
    persistingSendRef.current = true;
    setPersistingSend(true);
    setComposerError(undefined);
    try {
      const attachments: DraftAttachment[] = [];
      for (const file of files) {
        const data = await readFileBytes(file);
        attachments.push({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: data.byteLength,
          data,
        });
      }
      const initialCaption = draftsByRoomRef.current[roomId]?.text ?? "";
      for (let i = 0; i < attachments.length; i += 1) {
        const attachment = attachments[i]!;
        const captionForItem = i === 0 && initialCaption.trim() !== "" ? initialCaption : "";
        const content = buildAttachmentEventContent(attachment, captionForItem);
        await client.enqueueRoomEvent(roomId, "m.room.message", content, {
          clearDraft: i === attachments.length - 1,
          attachment,
        });
      }
      bumpDraftSeq(roomId);
      setDraftsByRoom((prev) => {
        if (!(roomId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
      setRevision((value) => value + 1);
      void retryQueue.flush();
    } catch {
      setRevision((value) => value + 1);
      setComposerError("附件保存失败，请重试。");
    } finally {
      persistingSendRef.current = false;
      setPersistingSend(false);
    }
  }

  function handlePickedFiles(roomId: string, files: File[]) {
    if (files.length === 0) {
      return;
    }
    if (files.length === 1) {
      void handleSelectAttachment(roomId, files[0]!);
      return;
    }
    void sendMultipleAttachmentsInOrder(roomId, files);
  }

  async function sendComposerTextMessage(roomId: string, body: string) {
    if (persistingSendRef.current || reauthRequiredRef.current) {
      return;
    }
    if (deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable) {
      return;
    }
    persistingSendRef.current = true;
    setPersistingSend(true);
    setComposerError(undefined);
    try {
      await client.enqueueRoomEvent(
        roomId,
        "m.room.message",
        {
          msgtype: "m.text",
          body,
        },
        { clearDraft: true },
      );
      bumpDraftSeq(roomId);
      setDraftsByRoom((prev) => {
        if (!(roomId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
      setRevision((value) => value + 1);
      void retryQueue.flush();
    } catch {
      setComposerError("消息保存失败，请重试。");
    } finally {
      persistingSendRef.current = false;
      setPersistingSend(false);
    }
  }

  async function handleSendMessage(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!activeTopic || activeTopic.unavailable || persistingSendRef.current || reauthRequiredRef.current) {
      return;
    }
    const roomId = activeTopic.roomId;
    const draft = draftsByRoomRef.current[roomId];
    const body = draft?.text ?? "";
    if (draft?.attachment) {
      await sendComposerAttachmentMessage(roomId, draft.attachment, body);
      return;
    }
    if (body.trim() === "") {
      return;
    }
    await sendComposerTextMessage(roomId, body);
  }

  async function handleSelectSlashCommand(roomId: string, command: string) {
    if (persistingSendRef.current || reauthRequiredRef.current) {
      return;
    }
    const draft = draftsByRoomRef.current[roomId];
    if (draft?.attachment || draft?.text !== "/") {
      return;
    }
    await sendComposerTextMessage(roomId, command);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || quickSubmitting || reauthRequiredRef.current) {
      return;
    }
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      setFormError("请输入 Topic 名字。");
      return;
    }
    const agentUserId = registeredAgents.length === 1 ? registeredAgents[0].userId : selectedBotId;
    if (!agentUserId || !registeredAgents.some((bot) => bot.userId === agentUserId)) {
      setFormError("请选择要绑定的 Bot。");
      return;
    }

    const trimmedDescription = descriptionInput.trim();
    setSubmitting(true);
    setFormError(undefined);

    const now = clock.currentTimeMs ? clock.currentTimeMs() : Date.now();
    const result = await createTopicRoom(client, {
      name: trimmedName,
      description: trimmedDescription || undefined,
      agentUserId,
      now,
    });

    setSubmitting(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    setCreating(false);
    resetEditForm();
    setActiveTopicId(result.roomId);
    setDescriptionExpanded(false);
    setRevision((value) => value + 1);
    void appendDirectRoom(client, agentUserId, result.roomId);
  }

  async function handleEditSubmit(event: FormEvent) {
    event.preventDefault();
    if (editSubmitting || !activeTopic) {
      return;
    }
    const nextName = editPendingFields.name ? editNameInput.trim() : activeTopic.name;
    if (editPendingFields.name && !nextName) {
      setEditError("请输入 Topic 名字。");
      return;
    }
    const currentDescription = activeTopic.description ?? "";
    const nextDescription = editPendingFields.description
      ? editDescriptionInput.trim()
      : currentDescription;

    if (nextName === activeTopic.name && nextDescription === currentDescription) {
      resetEditForm();
      return;
    }

    setEditSubmitting(true);
    setEditError(undefined);

    const now = clock.currentTimeMs ? clock.currentTimeMs() : Date.now();
    const result = await updateTopicDetails(client, {
      roomId: activeTopic.roomId,
      currentName: activeTopic.name,
      currentDescription,
      nextName,
      nextDescription,
      now,
    });

    setEditSubmitting(false);
    if (result.nameUpdated) {
      setEditNameInput(nextName);
    }
    if (result.descriptionUpdated) {
      setEditDescriptionInput(nextDescription);
    }
    if (result.nameUpdated || result.descriptionUpdated) {
      setRevision((value) => value + 1);
    }
    if (!result.ok) {
      setEditPendingFields((prev) => ({
        name: prev.name && !result.nameUpdated,
        description: prev.description && !result.descriptionUpdated,
      }));
      setEditError(result.message);
      return;
    }

    resetEditForm();
  }

  function openReauthForm() {
    if (exiting || reauthSubmittingRef.current) {
      return;
    }
    setExitConfirmOpen(false);
    setReauthError(undefined);
    setReauthOpen(true);
  }

  function closeReauthForm() {
    if (reauthSubmittingRef.current) {
      return;
    }
    setReauthOpen(false);
    setReauthError(undefined);
  }

  async function handleReauthSubmit(event: FormEvent) {
    event.preventDefault();
    if (reauthSubmittingRef.current || exiting || !reauthRequiredRef.current) {
      return;
    }
    reauthSubmittingRef.current = true;
    setReauthSubmitting(true);
    setReauthError(undefined);
    try {
      const storedDeviceId = client.currentDeviceId;
      const displayName = platform?.deviceDisplayName ?? "Waypoint";
      const expectedUserId = client.ownerId;
      const password = reauthPassword;

      let loginResult;
      try {
        loginResult = await client.passwordLogin(
          expectedUserId,
          password,
          displayName,
          storedDeviceId,
        );
      } catch {
        loginResult = { type: "failure" as const, failure: { type: "network" as const } };
      }
      if (!mountedRef.current || exiting) {
        return;
      }

      let deviceIdWasRejected = false;
      if (storedDeviceId && isDeviceIdRejected(loginResult)) {
        deviceIdWasRejected = true;
        try {
          loginResult = await client.passwordLogin(expectedUserId, password, displayName);
        } catch {
          loginResult = { type: "failure" as const, failure: { type: "network" as const } };
        }
        if (!mountedRef.current || exiting) {
          return;
        }
      }

      const session = extractLoginSession(loginResult);
      const validDevice = deviceIdWasRejected
        ? Boolean(session?.deviceId)
        : Boolean(storedDeviceId || session?.deviceId);
      if (!session || !validDevice) {
        const failure = classifyLoginFailure(loginResult, "重新验证", "密码被拒绝");
        if (failure.clearPassword) {
          setReauthPassword("");
        }
        setReauthError(`${failure.message}请重试。`);
        return;
      }
      if (session.userId !== expectedUserId) {
        setReauthError("重新验证失败，因为返回的用户 ID 与当前设备不一致。");
        return;
      }

      const nextDeviceId = deviceIdWasRejected
        ? session.deviceId
        : storedDeviceId
          ? undefined
          : session.deviceId;
      await client.completeReauth(session.accessToken, nextDeviceId);
      if (!mountedRef.current || exiting) {
        return;
      }

      syncEpochRef.current += 1;
      pausedRef.current = false;
      syncBackoffRef.current = 0;
      setReauthRequired(false);
      setReauthOpen(false);
      setReauthPassword("");
      setReauthError(undefined);
      retryQueue.resume();
      retryQueue.wake();
      void runForegroundSync();
      setRevision((value) => value + 1);
    } finally {
      reauthSubmittingRef.current = false;
      if (mountedRef.current) {
        setReauthSubmitting(false);
      }
    }
  }

  function renderExitConfirmDialog() {
    return (
      <div
        role="alertdialog"
        aria-label="确认退出这台设备"
        className="waypoint-agents-form"
      >
        <h4>确认退出这台设备</h4>
        <p>
          退出将清空这台设备上的本地时间线、未发送草稿和重试队列。
        </p>
        <div className="waypoint-form-actions">
          <button
            type="button"
            disabled={exiting}
            onClick={() => void confirmExitDevice()}
          >
            {exiting ? "正在退出…" : "确认退出"}
          </button>
          <button
            type="button"
            disabled={exiting}
            onClick={cancelExitConfirm}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  function renderReauthBanner() {
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
              onClick={openReauthForm}
            >
              重新验证
            </button>
            <button
              type="button"
              disabled={exiting || reauthSubmitting}
              onClick={openExitConfirm}
            >
              退出这台设备
            </button>
          </div>
        </div>
        {reauthOpen ? (
          <form
            aria-label="重新验证"
            className="waypoint-reauth-form"
            onSubmit={handleReauthSubmit}
          >
            <label>
              Homeserver 地址
              <input name="reauth-address" value={client.address} readOnly disabled />
            </label>
            <label>
              用户 ID
              <input name="reauth-user-id" value={client.ownerId} readOnly disabled />
            </label>
            <label>
              密码
              <input
                name="reauth-password"
                type="password"
                value={reauthPassword}
                disabled={reauthSubmitting || exiting}
                onChange={(event) => setReauthPassword(event.target.value)}
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
                onClick={closeReauthForm}
              >
                取消
              </button>
            </div>
          </form>
        ) : null}
        {!settingsOpen && exitConfirmOpen ? renderExitConfirmDialog() : null}
      </section>
    );
  }

  const supportsFileDropAndPaste =
    platform?.supportsFileDropAndPaste ?? platform?.deviceDisplayName !== "Waypoint Android";
  const isNarrow = viewportMode === "narrow";
  const isNarrowPushed = isNarrow && (settingsOpen || creating || Boolean(activeTopic));
  const showSidebar = !isNarrow || !isNarrowPushed;
  const showDetail = !isNarrow || isNarrowPushed;
  const safeInset = normalizeInset(keyboardInsetBottom);

  function renderSettingsDialog(isModal: boolean) {
    return (
<section aria-label="设置" className={isModal ? "waypoint-dialog waypoint-modal" : "waypoint-dialog"} role="region" aria-modal={isModal ? "true" : undefined} onClick={isModal ? (event) => event.stopPropagation() : undefined}>
              {isNarrow ? (
                <div className="waypoint-topic-header">
                  <div className="waypoint-topic-header-bar">
                    <button
                      type="button"
                      className="waypoint-back-button"
                      disabled={agentsSubmitting || exiting}
                      onClick={goBack}
                    >
                      <BackIcon aria-hidden="true" size={14} />
                      返回
                    </button>
                    <div className="waypoint-topic-header-main">
                      <h2>设置</h2>
                    </div>
                  </div>
                </div>
              ) : null}
              {reauthRequired ? renderReauthBanner() : null}
              <div
                className="waypoint-dialog-body"
                style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
              >
                {!isNarrow ? (
                  <div className="waypoint-settings-header">
                    <h2>设置</h2>
                    <button type="button" disabled={agentsSubmitting || exiting} onClick={closeSettings}>
                      <CloseIcon aria-hidden="true" size={14} />
                      关闭
                    </button>
                  </div>
                ) : null}
                <section aria-label="Bot 名册" className="waypoint-agents-section">
                  <div className="waypoint-agents-header">
                    <h3>Bot 名册</h3>
                    <button
                      type="button"
                      disabled={agentsSubmitting || exiting}
                      onClick={openAddAgentForm}
                    >
                      登记新 Bot
                    </button>
                  </div>
                  <ul className="waypoint-bot-list">
                    {registeredAgents.map((bot) => (
                      <li key={bot.userId} className="waypoint-bot-row">
                        <div className="waypoint-bot-info">
                          <span className="waypoint-bot-name">
                            {resolveBotName(bot.userId, registeredAgents, roomList)}
                          </span>
                          <span className="waypoint-bot-id">{bot.userId}</span>
                        </div>
                        <div className="waypoint-bot-actions">
                          <button
                            type="button"
                            disabled={agentsSubmitting || exiting}
                            onClick={() => openEditAgentForm(bot.userId, bot.handwrittenName)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={registeredAgents.length <= 1 || agentsSubmitting || exiting}
                            onClick={() => openRemoveAgentConfirm(bot.userId)}
                          >
                            移除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {agentsForm?.mode === "add" ? (
                    <form onSubmit={handleAddAgentSubmit} className="waypoint-agents-form">
                      <h4>登记新 Bot</h4>
                      <label>
                        Matrix 用户 ID
                        <input
                          name="agents-bot-user-id"
                          value={agentsForm.userId}
                          disabled={agentsSubmitting}
                          onChange={(event) =>
                            setAgentsForm({ ...agentsForm, userId: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        手写名字（可选）
                        <input
                          name="agents-bot-name"
                          value={agentsForm.handwrittenName}
                          disabled={agentsSubmitting}
                          onChange={(event) =>
                            setAgentsForm({ ...agentsForm, handwrittenName: event.target.value })
                          }
                        />
                      </label>
                      {agentsError ? <p role="alert">{agentsError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button type="submit" disabled={agentsSubmitting}>
                          {agentsSubmitting ? "正在保存…" : "登记 Bot"}
                        </button>
                        <button
                          type="button"
                          disabled={agentsSubmitting}
                          onClick={cancelAgentsAction}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  ) : agentsForm?.mode === "edit" ? (
                    <form onSubmit={handleEditAgentSubmit} className="waypoint-agents-form">
                      <h4>编辑 Bot</h4>
                      <label>
                        Matrix 用户 ID
                        <input
                          name="agents-edit-user-id"
                          value={agentsForm.userId}
                          disabled
                        />
                      </label>
                      <label>
                        手写名字（可选）
                        <input
                          name="agents-edit-name"
                          value={agentsForm.handwrittenName}
                          disabled={agentsSubmitting}
                          onChange={(event) =>
                            setAgentsForm({ ...agentsForm, handwrittenName: event.target.value })
                          }
                        />
                      </label>
                      {agentsError ? <p role="alert">{agentsError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button type="submit" disabled={agentsSubmitting}>
                          {agentsSubmitting ? "正在保存…" : "保存"}
                        </button>
                        <button
                          type="button"
                          disabled={agentsSubmitting}
                          onClick={cancelAgentsAction}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  ) : agentsForm?.mode === "remove" ? (
                    <div
                      role="alertdialog"
                      aria-label="确认移除 Bot"
                      className="waypoint-agents-form"
                    >
                      <h4>确认移除 Bot</h4>
                      <p>
                        确定要从 Bot 名册移除{" "}
                        {resolveBotName(agentsForm.userId, registeredAgents, roomList)}（
                        {agentsForm.userId}）吗？
                      </p>
                      <p>
                        移除不会删除已有 Topic，已有交流不受影响，也不会离开这些房间。
                      </p>
                      {agentsError ? <p role="alert">{agentsError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button
                          type="button"
                          disabled={agentsSubmitting}
                          onClick={() => void confirmRemoveBot()}
                        >
                          {agentsSubmitting ? "正在移除…" : "确认移除"}
                        </button>
                        <button
                          type="button"
                          disabled={agentsSubmitting}
                          onClick={cancelAgentsAction}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
                <section aria-label="这台设备" className="waypoint-device-section">
                  <h3>这台设备</h3>
                  <button
                    type="button"
                    disabled={agentsSubmitting || exiting}
                    onClick={openExitConfirm}
                  >
                    退出这台设备
                  </button>
                  {exitConfirmOpen ? renderExitConfirmDialog() : null}
                </section>
              </div>
            </section>
    );
  }

  function renderCreateDialog(isModal: boolean) {
    return (
<section aria-label="新建 Topic" className={isModal ? "waypoint-dialog waypoint-modal" : "waypoint-dialog"} role="region" aria-modal={isModal ? "true" : undefined} onClick={isModal ? (event) => event.stopPropagation() : undefined}>
              {isNarrow ? (
                <div className="waypoint-topic-header">
                  <div className="waypoint-topic-header-bar">
                    <button
                      type="button"
                      className="waypoint-back-button"
                      disabled={submitting || quickSubmitting}
                      onClick={goBack}
                    >
                      <BackIcon aria-hidden="true" size={14} />
                      返回
                    </button>
                    <div className="waypoint-topic-header-main">
                      <h2>新建 Topic</h2>
                    </div>
                  </div>
                </div>
              ) : null}
              {reauthRequired ? renderReauthBanner() : null}
              <div
                className="waypoint-dialog-body"
                style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
              >
                {!isNarrow ? <h2>新建 Topic</h2> : null}
                <form onSubmit={handleSubmit}>
                  <label>
                    Topic 名字
                    <input
                      name="topic-name"
                      value={nameInput}
                      onChange={(event) => setNameInput(event.target.value)}
                    />
                  </label>
                  <label>
                    Description（可选）
                    <textarea
                      name="topic-description"
                      value={descriptionInput}
                      onChange={(event) => setDescriptionInput(event.target.value)}
                    />
                  </label>
                  <p className="waypoint-field-hint">
                    留空表示没有额外上下文；填写后会发给这条 Topic 绑定的 Bot，不是私密备忘。
                  </p>
                  {registeredAgents.length > 1 ? (
                    <label>
                      绑定 Bot
                      <select
                        name="bot-user-id"
                        value={selectedBotId}
                        disabled={submitting || quickSubmitting}
                        onChange={(event) => setSelectedBotId(event.target.value)}
                      >
                        <option value="">请选择 Bot</option>
                        {registeredAgents.map((bot) => (
                          <option key={bot.userId} value={bot.userId}>
                            {resolveBotName(bot.userId, registeredAgents, roomList)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {!quickRegisterOpen ? (
                    <button
                      type="button"
                      disabled={submitting || quickSubmitting}
                      onClick={openQuickRegister}
                    >
                      登记新 Bot
                    </button>
                  ) : (
                    <section aria-label="登记新 Bot" className="waypoint-inline-register">
                      <h3>登记新 Bot</h3>
                      <label>
                        Matrix 用户 ID
                        <input
                          name="quick-bot-user-id"
                          value={quickUserId}
                          disabled={quickSubmitting}
                          onChange={(event) => setQuickUserId(event.target.value)}
                          onKeyDown={handleQuickRegisterKeyDown}
                        />
                      </label>
                      <label>
                        手写名字（可选）
                        <input
                          name="quick-bot-name"
                          value={quickHandwrittenName}
                          disabled={quickSubmitting}
                          onChange={(event) => setQuickHandwrittenName(event.target.value)}
                          onKeyDown={handleQuickRegisterKeyDown}
                        />
                      </label>
                      {quickError ? <p role="alert">{quickError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button
                          type="button"
                          disabled={quickSubmitting || submitting}
                          onClick={() => void handleQuickRegister()}
                        >
                          {quickSubmitting ? "正在保存…" : "登记 Bot"}
                        </button>
                        <button
                          type="button"
                          disabled={quickSubmitting || submitting}
                          onClick={closeQuickRegister}
                        >
                          取消登记
                        </button>
                      </div>
                    </section>
                  )}
                  {formError ? <p role="alert">{formError}</p> : null}
                  <div className="waypoint-form-actions">
                    <button type="submit" disabled={submitting || quickSubmitting || reauthRequired}>
                      {submitting ? "正在创建…" : "创建 Topic"}
                    </button>
                    <button
                      type="button"
                      disabled={submitting || quickSubmitting}
                      onClick={closeCreateForm}
                    >
                      取消
                    </button>
                  </div>
                </form>
              </div>
            </section>
    );
  }

  function renderTopicView() {
    if (!activeTopic) return null;
    return (
<div className="waypoint-topic-view">
              <header className="waypoint-topic-header">
                <div className="waypoint-topic-header-bar">
                  {isNarrow ? (
                    <button
                      type="button"
                      className="waypoint-back-button"
                      disabled={(editing && editSubmitting) || deleting}
                      onClick={goBack}
                    >
                      <BackIcon aria-hidden="true" size={14} />
                      返回
                    </button>
                  ) : null}
                  <div className="waypoint-topic-header-main">
                    <h2>{activeTopic.name}</h2>
                    {activeTopic.botDisplayName ? (
                      <p className="waypoint-topic-header-bot">{activeTopic.botDisplayName}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="waypoint-topic-pin-button"
                    disabled={
                      editing ||
                      deleteConfirmOpen ||
                      deleting ||
                      reauthRequired ||
                      Boolean(pinPendingByRoom[activeTopic.roomId])
                    }
                    aria-pressed={activeTopic.pinned}
                    onClick={() => void handleTogglePin(activeTopic.roomId, activeTopic.pinned)}
                  >
                    <PinIcon aria-hidden="true" size={13} /> {activeTopic.pinned ? "取消置顶" : "置顶"}
                  </button>
                  <button
                    type="button"
                    className="waypoint-topic-edit-button"
                    disabled={editing || deleteConfirmOpen || deleting}
                    onClick={openEditForm}
                  >
                    <EditIcon aria-hidden="true" size={13} />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="waypoint-topic-delete-button"
                    disabled={editing || deleteConfirmOpen || deleting}
                    onClick={openDeleteConfirm}
                  >
                    <TrashIcon aria-hidden="true" size={13} />
                    删除
                  </button>
                </div>
                {activeTopic.description ? (
                  <button
                    type="button"
                    className={
                      descriptionExpanded
                        ? "waypoint-topic-description expanded"
                        : "waypoint-topic-description"
                    }
                    aria-expanded={descriptionExpanded}
                    onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                  >
                    {activeTopic.description}
                  </button>
                ) : null}
              </header>
              {reauthRequired && !settingsOpen && !creating ? renderReauthBanner() : null}
              {activeTopic.unavailable && activeTopic.unavailableReason ? (
                <div
                  role="status"
                  aria-label="Topic 不可用"
                  className="waypoint-unavailable-banner"
                >
                  {activeTopic.unavailableReason}
                </div>
              ) : null}
              {deleteConfirmOpen ? (
                <div
                  role="alertdialog"
                  aria-label="确认删除 Topic"
                  className="waypoint-agents-form waypoint-delete-dialog"
                >
                  <h4>确认删除 Topic</h4>
                  <p>
                    确定要删除「{activeTopic.name}」吗？删除后无法恢复。
                  </p>
                  <p>
                    Waypoint 看不出这条是不是该 Bot 的 home；如果是，之后走 home 的投递会进已离开的房间，追不回，也不会再提示；要改投就在还留着的或新建的 Topic 里自己发一条以 /sethome 开头的消息（Waypoint 不代发 /sethome）。
                  </p>
                  <p>
                    在这条 Topic 里跟该 Bot 约定的、回到本房间的提醒仍会发进已离开的房间，追不回，/sethome 不会把它们改投走（若要取消或重设，需在删除前或在该 Bot 的其他 Topic 里发消息让它处理）。
                  </p>
                  {deleteError ? <p role="alert">{deleteError}</p> : null}
                  <div className="waypoint-form-actions">
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => void confirmDeleteTopic()}
                    >
                      {deleting ? "正在删除…" : "确认删除"}
                    </button>
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={cancelDeleteConfirm}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
              {editing ? (
                <section aria-label="编辑 Topic" className="waypoint-dialog">
                  <div
                    className="waypoint-dialog-body"
                    style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
                  >
                    <h2>编辑 Topic</h2>
                    <form onSubmit={handleEditSubmit}>
                      {editPendingFields.name ? (
                        <label>
                          Topic 名字
                          <input
                            name="edit-topic-name"
                            value={editNameInput}
                            disabled={editSubmitting}
                            onChange={(event) => setEditNameInput(event.target.value)}
                          />
                        </label>
                      ) : null}
                      {editPendingFields.description ? (
                        <>
                          <label>
                            Description（可选）
                            <textarea
                              name="edit-topic-description"
                              value={editDescriptionInput}
                              disabled={editSubmitting}
                              onChange={(event) => setEditDescriptionInput(event.target.value)}
                            />
                          </label>
                          <p className="waypoint-field-hint">
                            留空表示没有额外上下文；填写后会发给这条 Topic 绑定的 Bot，不是私密备忘。
                          </p>
                        </>
                      ) : null}
                      {editError ? <p role="alert">{editError}</p> : null}
                      <div className="waypoint-form-actions">
                        <button type="submit" disabled={editSubmitting}>
                          {editSubmitting ? "正在保存…" : "保存"}
                        </button>
                        <button type="button" disabled={editSubmitting} onClick={closeEditForm}>
                          取消
                        </button>
                      </div>
                    </form>
                  </div>
                </section>
              ) : (
                <main
                  className="waypoint-timeline-container"
                  style={{ paddingBottom: `${safeInset}px` }}
                  onDragOver={(event) => {
                    if (!supportsFileDropAndPaste) {
                      return;
                    }
                    const hasFiles =
                      (event.dataTransfer?.files?.length ?? 0) > 0 ||
                      Array.from(event.dataTransfer?.types ?? []).includes("Files");
                    if (hasFiles) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => {
                    if (!supportsFileDropAndPaste) {
                      return;
                    }
                    const files = extractDataTransferFiles(event.dataTransfer);
                    if (files.length === 0) {
                      return;
                    }
                    event.preventDefault();
                    if (persistingSend || activeTopic.unavailable || reauthRequired) {
                      return;
                    }
                    handlePickedFiles(activeTopic.roomId, files);
                  }}
                >
                  <div
                    ref={timelineRef}
                    role="log"
                    aria-label="对话时间线"
                    className="waypoint-timeline"
                    onScroll={handleTimelineScroll}
                  >
                    {activeTimelineItems.map((item) =>
                      item.kind === "day-separator" ? (
                        <div
                          key={item.key}
                          role="separator"
                          aria-label={item.label}
                          className="waypoint-day-separator"
                        >
                          {item.label}
                        </div>
                      ) : (
                        <div
                          key={item.key}
                          className={`waypoint-message-row ${item.side}`}
                          data-side={item.side}
                          data-event-id={item.eventId}
                        >
                          {item.status === "unconfirmed" ? (
                            <span
                              role="status"
                              aria-label="未确认"
                              className="waypoint-unconfirmed-spinner"
                            />
                          ) : item.status === "failed" && item.localId ? (
                            <div className="waypoint-failed-controls">
                              <button
                                type="button"
                                aria-label="更多操作"
                                aria-haspopup="menu"
                                aria-expanded={openFailedMenuId === item.localId}
                                className="waypoint-bubble-menu-trigger"
                                onClick={() =>
                                  setOpenFailedMenuId((prev) =>
                                    prev === item.localId ? null : item.localId!,
                                  )
                                }
                              >
                                ⋯
                              </button>
                              <button
                                type="button"
                                aria-label="失败"
                                className="waypoint-failed-button"
                                disabled={reauthRequired}
                                onClick={() => {
                                  void handleResendFailed(activeTopic.roomId, item.localId!);
                                }}
                              >
                                !
                              </button>
                              {openFailedMenuId === item.localId ? (
                                <div
                                  role="menu"
                                  aria-label="消息操作"
                                  className="waypoint-failed-menu"
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      void handleDiscardFailed(activeTopic.roomId, item.localId!);
                                    }}
                                  >
                                    丢掉
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="waypoint-message-content">
                            <div
                              className="waypoint-bubble"
                              onContextMenu={
                                item.status === "failed" && item.localId
                                  ? (event) => {
                                      event.preventDefault();
                                      setOpenFailedMenuId(item.localId!);
                                    }
                                  : undefined
                              }
                            >
                              {item.media ? (
                                <div className="waypoint-media-bubble">
                                  {item.media.kind === "image" ? (
                                    <button
                                      type="button"
                                      aria-label={`查看图片 ${item.media.filename}`}
                                      className="waypoint-media-image-button"
                                      onClick={() => void handleOpenMedia(item.media!)}
                                    >
                                      {(() => {
                                        const imageSrc = item.media.localAttachment
                                          ? getOrCreateLocalImageUrl(
                                              item.localId ?? item.key,
                                              item.media.localAttachment,
                                            )
                                          : item.media.mxcUrl
                                            ? downloadedMediaCacheRef.current.get(item.media.mxcUrl)?.imageUrl
                                            : undefined;
                                        return imageSrc ? (
                                          <img
                                            src={imageSrc}
                                            alt={item.media.filename}
                                            className="waypoint-bubble-image"
                                          />
                                        ) : (
                                          <span className="waypoint-media-filename">
                                            {item.media.filename}
                                          </span>
                                        );
                                      })()}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="waypoint-media-file-button"
                                      onClick={() => void handleOpenMedia(item.media!)}
                                    >
                                      <span className="waypoint-media-filename">
                                        {item.media.filename}
                                      </span>
                                    </button>
                                  )}
                                  {item.media.caption ? (
                                    <MessageBody
                                      body={item.media.caption}
                                      onOpenExternalUrl={handleOpenExternalUrl}
                                    />
                                  ) : null}
                                </div>
                              ) : (
                                <MessageBody
                                  body={item.body}
                                  onOpenExternalUrl={handleOpenExternalUrl}
                                />
                              )}
                            </div>
                            {item.reactions && item.reactions.length > 0 ? (
                              <div className="waypoint-message-reactions">
                                {item.reactions.map((key) => (
                                  <span key={key} className="waypoint-message-reaction">
                                    {key}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {item.prompt && item.eventId ? (
                              <div
                                className="waypoint-message-prompt"
                                role="group"
                                aria-label={item.prompt.kind === "approval" ? "审批操作" : "选择操作"}
                              >
                                {item.prompt.options.map((option) => {
                                  const isSelected = item.prompt!.selectedKey === option.key;
                                  const isDisabled =
                                    Boolean(option.redacted) ||
                                    item.prompt!.answered ||
                                    item.prompt!.superseded ||
                                    item.prompt!.queuedKey === option.key ||
                                    activeTopic.unavailable ||
                                    reauthRequired;
                                  return (
                                    <button
                                      key={option.key}
                                      type="button"
                                      className={`waypoint-prompt-button${isSelected ? " selected" : ""}`}
                                      aria-pressed={isSelected}
                                      disabled={isDisabled}
                                      onClick={() => {
                                        void handleSelectPromptOption(
                                          activeTopic.roomId,
                                          item.eventId!,
                                          option.key,
                                        );
                                      }}
                                    >
                                      <span className="waypoint-prompt-button-label">
                                        {option.label}
                                      </span>
                                      {option.scope ? (
                                        <>
                                          {" "}
                                          <span className="waypoint-prompt-button-scope">
                                            {option.scope}
                                          </span>
                                        </>
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                            {item.responding ? (
                              <div className="waypoint-message-responding">正在回应</div>
                            ) : null}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                  <div
                    className="waypoint-composer-safe-area"
                    data-keyboard-inset={safeInset}
                  >
                    {composerError ? <p role="alert">{composerError}</p> : null}
                    {draftsByRoom[activeTopic.roomId]?.attachment ? (
                      <div
                        role="region"
                        aria-label="已选附件"
                        className="waypoint-draft-attachment"
                      >
                        <span className="waypoint-draft-attachment-name">
                          {draftsByRoom[activeTopic.roomId]?.attachment?.name}
                        </span>
                        <button
                          type="button"
                          disabled={persistingSend || activeTopic.unavailable || reauthRequired}
                          onClick={() => handleRemoveAttachment(activeTopic.roomId)}
                        >
                          移除附件
                        </button>
                      </div>
                    ) : null}
                    {!activeTopic.unavailable &&
                    !reauthRequired &&
                    !persistingSend &&
                    !draftsByRoom[activeTopic.roomId]?.attachment &&
                    draftsByRoom[activeTopic.roomId]?.text === "/" ? (
                      <div
                        role="region"
                        aria-label="斜杠命令提示"
                        className="waypoint-slash-hints"
                      >
                        <ul className="waypoint-slash-hint-list">
                          {SLASH_COMMAND_HINTS.map((command) => (
                            <li key={command}>
                              <button
                                type="button"
                                className="waypoint-slash-hint-button"
                                onClick={() =>
                                  void handleSelectSlashCommand(activeTopic.roomId, command)
                                }
                              >
                                {command}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <form className="waypoint-composer" onSubmit={handleSendMessage}>
                      <label className="waypoint-attach-button">
                        <PaperclipIcon aria-hidden="true" size={14} />
                        附件
                        <input
                          type="file"
                          multiple
                          aria-label="选择附件"
                          className="waypoint-sr-only"
                          disabled={persistingSend || activeTopic.unavailable || reauthRequired}
                          onChange={(event) => {
                            const files = event.target.files ? Array.from(event.target.files) : [];
                            event.target.value = "";
                            handlePickedFiles(activeTopic.roomId, files);
                          }}
                        />
                      </label>
                      <textarea
                        ref={composerTextareaRef}
                        rows={1}
                        aria-label="输入消息"
                        name="message"
                        disabled={persistingSend || activeTopic.unavailable || reauthRequired}
                        placeholder={
                          activeTopic.unavailable ? "Topic 不可用，无法发送消息" : undefined
                        }
                        value={draftsByRoom[activeTopic.roomId]?.text ?? ""}
                        onChange={(event) => updateDraftText(activeTopic.roomId, event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing &&
                            viewportMode !== "narrow"
                          ) {
                            event.preventDefault();
                            void handleSendMessage(event);
                          }
                        }}
                        onPaste={(event) => {
                          if (!supportsFileDropAndPaste) {
                            return;
                          }
                          const files = extractDataTransferFiles(event.clipboardData);
                          if (files.length === 0) {
                            return;
                          }
                          event.preventDefault();
                          if (persistingSend || activeTopic.unavailable || reauthRequired) {
                            return;
                          }
                          handlePickedFiles(activeTopic.roomId, files);
                        }}
                      />
                      <button
                        type="submit"
                        disabled={persistingSend || activeTopic.unavailable || reauthRequired}
                      >
                        发送
                      </button>
                    </form>
                  </div>
                </main>
              )}
            </div>
    );
  }

  function renderEmptyDetail() {
    return (
      <>
        {reauthRequired && !settingsOpen && !creating ? renderReauthBanner() : null}
        <section aria-label="Topic 引导" className="waypoint-empty-detail">
          <div className="waypoint-empty-card">
            <p>
              {topics.length === 0
                ? "还没有 Topic，新建一条 Topic 开始交流。"
                : "选择一条 Topic，或新建一条 Topic 开始交流。"}
            </p>
            <button type="button" disabled={reauthRequired} onClick={openCreateForm}>
              <PlusIcon aria-hidden="true" size={14} />
              新建一条 Topic
            </button>
            <div className="waypoint-empty-shortcut-hint">
              快捷键 <kbd className="waypoint-kbd-hint">Alt + N</kbd>
            </div>
          </div>
        </section>
      </>
    );
  }
  return (
    <div
      className="waypoint-workspace"
      data-viewport={viewportMode}
      style={{ "--keyboard-inset": `${safeInset}px` } as CSSProperties}
    >
      {showSidebar ? (
        <aside className="waypoint-sidebar" aria-label="Topic 列表">
          <p>已连接</p>
          <div className="waypoint-sidebar-header">
            <h1>Topic</h1>
            <div className="waypoint-sidebar-actions">
              <button type="button" disabled={reauthRequired} onClick={openCreateForm}>
                <PlusIcon aria-hidden="true" size={13} />
                新建 Topic
              </button>
              <button type="button" onClick={openSettings}>
                <SettingsIcon aria-hidden="true" size={13} />
                设置
              </button>
            </div>
          </div>
          {reauthRequired && !showDetail ? renderReauthBanner() : null}
          {topics.length === 0 ? (
            <p>暂无 Topic</p>
          ) : (
            <ul className="waypoint-topic-list">
              {topics.map((topic) => (
                <li key={topic.roomId}>
                  <button
                    type="button"
                    aria-label={topic.name}
                    className={[
                      "waypoint-topic-row",
                      topic.roomId === activeTopic?.roomId ? "active" : "",
                      topic.unavailable ? "unavailable" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-unread={topic.unread ? "true" : undefined}
                    data-pinned={topic.pinned ? "true" : undefined}
                    data-unavailable={topic.unavailable ? "true" : undefined}
                    onClick={() => openTopic(topic.roomId)}
                  >
                    <span className="waypoint-topic-row-header">
                      <span className="waypoint-topic-row-title">
                        {topic.unread ? (
                          <span className="waypoint-unread-dot" aria-hidden="true" />
                        ) : null}
                        <span
                          className={
                            topic.unread
                              ? "waypoint-topic-name unread"
                              : "waypoint-topic-name"
                          }
                          style={{ fontWeight: topic.unread ? 700 : 400 }}
                        >
                          {topic.name}
                        </span>
                        {topic.unavailable ? (
                          <span className="waypoint-topic-row-unavailable">不可用</span>
                        ) : null}
                      </span>
                      <span className="waypoint-topic-row-trailing">
                        {topic.pinned ? (
                          <span className="waypoint-topic-row-pin" aria-label="已置顶">
                            <PinIcon aria-hidden="true" size={11} />
                            置顶
                          </span>
                        ) : null}
                        {topic.sendStatus === "failed" ? (
                          <span
                            role="img"
                            aria-label="失败"
                            className="waypoint-topic-row-failed"
                          >
                            !
                          </span>
                        ) : topic.sendStatus === "unconfirmed" ? (
                          <span
                            role="img"
                            aria-label="未确认"
                            className="waypoint-unconfirmed-spinner"
                          />
                        ) : null}
                        {topic.lastActivityTs !== undefined ? (
                          <span className="waypoint-topic-row-time">
                            {formatTopicListTime(topic.lastActivityTs, nowMs)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {(registeredAgents.length > 1 && topic.botDisplayName) || topic.responding ? (
                      <span className="waypoint-topic-row-secondary">
                        {registeredAgents.length > 1 && topic.botDisplayName ? (
                          <span className="waypoint-topic-row-bot">{topic.botDisplayName}</span>
                        ) : null}
                        {topic.responding ? (
                          <span className="waypoint-topic-row-responding">正在回应</span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      ) : null}

      {showDetail ? (
        <div className="waypoint-detail">
          {isNarrow ? (
            settingsOpen ? (
              renderSettingsDialog(false)
            ) : creating ? (
              renderCreateDialog(false)
            ) : activeTopic ? (
              renderTopicView()
            ) : (
              renderEmptyDetail()
            )
          ) : (
            <>
              <div
                style={{ display: "contents" }}
                aria-hidden={settingsOpen || creating ? "true" : undefined}
              >
                {activeTopic ? renderTopicView() : renderEmptyDetail()}
              </div>
              {settingsOpen ? (
                <div className="waypoint-modal-backdrop" onClick={closeSettings}>
                  {renderSettingsDialog(true)}
                </div>
              ) : creating ? (
                <div className="waypoint-modal-backdrop" onClick={closeCreateForm}>
                  {renderCreateDialog(true)}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {toastNotice ? (
        <div role="status" aria-live="polite" className="waypoint-toast">
          {toastNotice}
        </div>
      ) : null}
    </div>
  );
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("无法读取附件内容"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取附件内容"));
    reader.readAsArrayBuffer(file);
  });
  return new Uint8Array(buffer);
}

function extractBytesFromTransportBody(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) {
    return new Uint8Array(body);
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  return undefined;
}

function createRenderableMediaUrl(
  data: Uint8Array,
  mimeType: string,
): { url: string; revoke?: () => void } {
  const safeMime = mimeType || "application/octet-stream";
  if (typeof URL.createObjectURL === "function") {
    const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: safeMime }));
    return {
      url: objectUrl,
      revoke: () => URL.revokeObjectURL(objectUrl),
    };
  }
  let binary = "";
  for (let i = 0; i < data.length; i += 1) {
    binary += String.fromCharCode(data[i]!);
  }
  return {
    url: `data:${safeMime};base64,${btoa(binary)}`,
  };
}

function extractDataTransferFiles(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) {
    return [];
  }
  if (transfer.files && transfer.files.length > 0) {
    return Array.from(transfer.files);
  }
  if (transfer.items && transfer.items.length > 0) {
    const out: File[] = [];
    for (const item of Array.from(transfer.items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          out.push(file);
        }
      }
    }
    return out;
  }
  return [];
}
