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
import { cn } from "@/lib/utils";
import { normalizeInset } from "../adapters/inset";
import type { Clock, PlatformAdapter, TransportResult, ViewportMode } from "../adapters/types";
import {
  BACKFILL_PAGE_LIMIT,
  nextBackfillTargetForReadPosition,
  nextBackfillTargetForScrollUp,
  type MatrixClient,
} from "./matrix-client";
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
  parseRegisteredAgents,
  resolvePreselectedBotId,
  saveRegisteredAgents,
  setTopicPinned,
  updateTopicDetails,
  validateAgentUserId,
} from "./topics";
import { ComposerView } from "./workspace/ComposerView";
import { CreateTopicView } from "./workspace/CreateTopicView";
import { DeleteTopicDialog } from "./workspace/DeleteTopicDialog";
import { EditTopicView } from "./workspace/EditTopicView";
import { EmptyDetailView } from "./workspace/EmptyDetailView";
import { ReauthBanner } from "./workspace/ReauthBanner";
import { SettingsView } from "./workspace/SettingsView";
import { SidebarView } from "./workspace/SidebarView";
import { TimelineView } from "./workspace/TimelineView";
import { TopicHeaderView } from "./workspace/TopicHeaderView";
import type { AgentsFormState } from "./workspace/types";

const FOREGROUND_SYNC_INTERVAL_MS = 1000;
const AT_BOTTOM_THRESHOLD_PX = 24;
const TOP_SCROLL_THRESHOLD_PX = 24;

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
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [showScrollBottomFab, setShowScrollBottomFab] = useState(false);
  const [composerMultiline, setComposerMultiline] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
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
        if (event.defaultPrevented) return;
        if (overflowMenuOpen) {
          setOverflowMenuOpen(false);
        } else if (creating) {
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
        } else if (exitConfirmOpen) {
          cancelExitConfirm();
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
    overflowMenuOpen,
    creating,
    submitting,
    quickRegisterOpen,
    quickSubmitting,
    settingsOpen,
    agentsForm,
    agentsSubmitting,
    exitConfirmOpen,
    exiting,
    editing,
    editSubmitting,
    deleteConfirmOpen,
    deleting,
  ]);

  const activeRoomId = activeTopic?.roomId;
  const currentDraftText = draftsByRoom[activeRoomId ?? ""]?.text ?? "";

  useEffect(() => {
    if (normalizeInset(keyboardInsetBottom) > 0) {
      setOverflowMenuOpen(false);
    }
  }, [keyboardInsetBottom]);

  useEffect(() => {
    if (!overflowMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = overflowMenuRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      setOverflowMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [overflowMenuOpen]);

  const [composerWidth, setComposerWidth] = useState(0);
  useLayoutEffect(() => {
    const form = composerFormRef.current;
    if (!form || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = form.clientWidth;
      setComposerWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(form);
    setComposerWidth((prev) => (prev === form.clientWidth ? prev : form.clientWidth));
    return () => observer.disconnect();
  }, [activeRoomId]);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    const form = composerFormRef.current;
    if (!textarea) return;
    const style = getComputedStyle(textarea);
    const line = Number.parseFloat(style.lineHeight) || 24;
    const maxHeight = line * 4;
    const textValue = currentDraftText;
    let exceeds = textValue.includes("\n");
    if (!exceeds && textValue.length > 0 && form) {
      const probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "pre";
      probe.style.font = style.font;
      probe.textContent = textValue;
      document.body.appendChild(probe);
      const textWidth = probe.getBoundingClientRect().width;
      probe.remove();
      const formStyle = getComputedStyle(form);
      const padX =
        (Number.parseFloat(formStyle.paddingLeft) || 0) +
        (Number.parseFloat(formStyle.paddingRight) || 0);
      const available = form.clientWidth - padX - 32 - 32 - 8 - 8 - 12;
      exceeds = textWidth > Math.max(available, 48);
    }
    if (exceeds !== composerMultiline) {
      setComposerMultiline(exceeds);
    }
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    const nextHeight = exceeds
      ? Math.min(Math.max(scrollHeight, line), maxHeight)
      : Math.max(scrollHeight, line);
    textarea.style.height = `${nextHeight}px`;
  }, [currentDraftText, activeRoomId, composerMultiline, composerWidth]);

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
    setOverflowMenuOpen(false);
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
    setOverflowMenuOpen(false);
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
      // StrictMode remounts this effect while the first sync is still in flight.
      // Drop that generation so the restarted effect can sync again; otherwise
      // the aborted call keeps the in-flight flag and the list never refreshes.
      syncEpochRef.current += 1;
      syncRunIdRef.current += 1;
      syncInFlightRef.current = false;
      syncWakePendingRef.current = false;
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

  function scrollToBottom() {
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowScrollBottomFab(false);
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
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX;
      isAtBottomRef.current = atBottom;
      setShowScrollBottomFab(el.scrollHeight - el.scrollTop - el.clientHeight > 60);
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

  function renderReauthBanner() {
    return (
      <ReauthBanner
        address={client.address}
        ownerId={client.ownerId}
        reauthOpen={reauthOpen}
        reauthPassword={reauthPassword}
        reauthSubmitting={reauthSubmitting}
        reauthError={reauthError}
        exiting={exiting}
        showInlineExitConfirm={!settingsOpen && exitConfirmOpen}
        onOpenReauthForm={openReauthForm}
        onCloseReauthForm={closeReauthForm}
        onReauthPasswordChange={setReauthPassword}
        onReauthSubmit={(event) => void handleReauthSubmit(event)}
        onOpenExitConfirm={openExitConfirm}
        onConfirmExit={() => void confirmExitDevice()}
        onCancelExit={cancelExitConfirm}
      />
    );
  }

  const supportsFileDropAndPaste =
    platform?.supportsFileDropAndPaste ?? platform?.deviceDisplayName !== "Waypoint Android";
  const isNarrow = viewportMode === "narrow";
  const isNarrowPushed = isNarrow && (settingsOpen || creating || Boolean(activeTopic));
  const showSidebar = !isNarrow || !isNarrowPushed;
  const showDetail = !isNarrow || isNarrowPushed;
  const safeInset = normalizeInset(keyboardInsetBottom);
  const narrowPageKey = !isNarrow
    ? "wide"
    : settingsOpen
      ? "settings"
      : creating
        ? "create"
        : editing
          ? "edit-topic"
          : activeTopic
            ? "topic"
            : "list";
  const pageMotionRef = useRef({
    key: narrowPageKey,
    depth: targetDepth,
    direction: "none" as "none" | "forward" | "back",
  });
  if (isNarrow && pageMotionRef.current.key !== narrowPageKey) {
    const previous = pageMotionRef.current;
    const direction =
      previous.key === "wide" ? "none" : targetDepth < previous.depth ? "back" : "forward";
    pageMotionRef.current = { key: narrowPageKey, depth: targetDepth, direction };
  } else if (!isNarrow && pageMotionRef.current.key !== "wide") {
    pageMotionRef.current = { key: "wide", depth: 0, direction: "none" };
  }
  const pageEnterClass =
    isNarrow && pageMotionRef.current.direction === "forward"
      ? "waypoint-page-enter-forward"
      : isNarrow && pageMotionRef.current.direction === "back"
        ? "waypoint-page-enter-back"
        : "";

  function renderSettingsDialog(isModal: boolean) {
    return (
      <SettingsView
        isModal={isModal}
        isNarrow={isNarrow}
        safeInset={safeInset}
        reauthBanner={reauthRequired ? renderReauthBanner() : null}
        registeredAgents={registeredAgents}
        roomList={roomList}
        agentsForm={agentsForm}
        agentsSubmitting={agentsSubmitting}
        agentsError={agentsError}
        exitConfirmOpen={exitConfirmOpen}
        exiting={exiting}
        onGoBack={goBack}
        onCloseSettings={closeSettings}
        onOpenAddAgentForm={openAddAgentForm}
        onOpenEditAgentForm={openEditAgentForm}
        onOpenRemoveAgentConfirm={openRemoveAgentConfirm}
        onAgentsFormChange={setAgentsForm}
        onAddAgentSubmit={(event) => void handleAddAgentSubmit(event)}
        onEditAgentSubmit={(event) => void handleEditAgentSubmit(event)}
        onConfirmRemoveBot={() => void confirmRemoveBot()}
        onCancelAgentsAction={cancelAgentsAction}
        onOpenExitConfirm={openExitConfirm}
        onConfirmExit={() => void confirmExitDevice()}
        onCancelExit={cancelExitConfirm}
      />
    );
  }

  function renderCreateDialog(isModal: boolean) {
    return (
      <CreateTopicView
        isModal={isModal}
        isNarrow={isNarrow}
        safeInset={safeInset}
        nestedModalOpen={exitConfirmOpen}
        reauthRequired={reauthRequired}
        reauthBanner={reauthRequired ? renderReauthBanner() : null}
        registeredAgents={registeredAgents}
        roomList={roomList}
        nameInput={nameInput}
        descriptionInput={descriptionInput}
        selectedBotId={selectedBotId}
        submitting={submitting}
        formError={formError}
        quickRegisterOpen={quickRegisterOpen}
        quickUserId={quickUserId}
        quickHandwrittenName={quickHandwrittenName}
        quickSubmitting={quickSubmitting}
        quickError={quickError}
        onGoBack={goBack}
        onCloseCreateForm={closeCreateForm}
        onSubmit={(event) => void handleSubmit(event)}
        onNameInputChange={setNameInput}
        onDescriptionInputChange={setDescriptionInput}
        onSelectedBotIdChange={setSelectedBotId}
        onOpenQuickRegister={openQuickRegister}
        onCloseQuickRegister={closeQuickRegister}
        onQuickUserIdChange={setQuickUserId}
        onQuickHandwrittenNameChange={setQuickHandwrittenName}
        onQuickRegisterKeyDown={handleQuickRegisterKeyDown}
        onQuickRegister={() => void handleQuickRegister()}
      />
    );
  }

  function renderEditDialog(isModal: boolean) {
    return (
      <EditTopicView
        isModal={isModal}
        isNarrow={isNarrow}
        safeInset={safeInset}
        nestedModalOpen={exitConfirmOpen}
        reauthBanner={reauthRequired ? renderReauthBanner() : null}
        editPendingFields={editPendingFields}
        editNameInput={editNameInput}
        editDescriptionInput={editDescriptionInput}
        editSubmitting={editSubmitting}
        editError={editError}
        onSubmit={(event) => void handleEditSubmit(event)}
        onEditNameInputChange={setEditNameInput}
        onEditDescriptionInputChange={setEditDescriptionInput}
        onCloseEditForm={closeEditForm}
        onGoBack={goBack}
      />
    );
  }

  function renderTopicView() {
    if (!activeTopic) return null;
    const roomId = activeTopic.roomId;
    const currentDraft = draftsByRoom[roomId];
    return (
      <div className="waypoint-topic-view flex min-h-0 flex-1 flex-col bg-background">
        <TopicHeaderView
          isNarrow={isNarrow}
          topic={activeTopic}
          descriptionExpanded={descriptionExpanded}
          overflowMenuOpen={overflowMenuOpen}
          overflowMenuRef={overflowMenuRef}
          editing={editing}
          editSubmitting={editSubmitting}
          deleteConfirmOpen={deleteConfirmOpen}
          deleting={deleting}
          reauthRequired={reauthRequired}
          pinPending={Boolean(pinPendingByRoom[roomId])}
          onGoBack={goBack}
          onToggleDescription={() =>
            setDescriptionExpanded((expanded) => !expanded)
          }
          onToggleOverflowMenu={() => setOverflowMenuOpen((prev) => !prev)}
          onCloseOverflowMenu={() => setOverflowMenuOpen(false)}
          onTogglePin={() => void handleTogglePin(roomId, activeTopic.pinned)}
          onOpenEditForm={openEditForm}
          onOpenDeleteConfirm={openDeleteConfirm}
        />
        {reauthRequired && !settingsOpen && !creating ? renderReauthBanner() : null}
        {activeTopic.unavailable && activeTopic.unavailableReason ? (
          <div
            role="status"
            aria-label="Topic 不可用"
            className="waypoint-unavailable-banner flex shrink-0 items-center gap-2 border-b border-warning-border bg-warning px-5 py-2.5 text-sm font-medium text-warning-foreground"
          >
            {activeTopic.unavailableReason}
          </div>
        ) : null}
        {deleteConfirmOpen ? (
          <DeleteTopicDialog
            topicName={activeTopic.name}
            deleting={deleting}
            deleteError={deleteError}
            onConfirm={() => void confirmDeleteTopic()}
            onCancel={cancelDeleteConfirm}
          />
        ) : null}
        <main
          className="waypoint-timeline-container m-0 box-border flex min-h-0 w-full max-w-none flex-1 flex-col overflow-hidden bg-background p-0"
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
              handlePickedFiles(roomId, files);
            }}
          >
            <TimelineView
              timelineRef={timelineRef}
              items={activeTimelineItems}
              activeTopicUnavailable={activeTopic.unavailable}
              reauthRequired={reauthRequired}
              openFailedMenuId={openFailedMenuId}
              getLocalImageUrl={getOrCreateLocalImageUrl}
              getDownloadedImageUrl={(mxcUrl) =>
                downloadedMediaCacheRef.current.get(mxcUrl)?.imageUrl
              }
              onScroll={handleTimelineScroll}
              onToggleFailedMenu={(localId) =>
                setOpenFailedMenuId((prev) =>
                  prev === localId ? null : localId,
                )
              }
              onOpenFailedMenu={(localId) => setOpenFailedMenuId(localId)}
              onResendFailed={(localId) =>
                void handleResendFailed(roomId, localId)
              }
              onDiscardFailed={(localId) =>
                void handleDiscardFailed(roomId, localId)
              }
              onOpenMedia={(media) => void handleOpenMedia(media)}
              onOpenExternalUrl={handleOpenExternalUrl}
              onSelectPromptOption={(eventId, optionKey) =>
                void handleSelectPromptOption(roomId, eventId, optionKey)
              }
            />
            <ComposerView
              safeInset={safeInset}
              showScrollBottomFab={showScrollBottomFab}
              composerMultiline={composerMultiline}
              composerError={composerError}
              activeTopicUnavailable={activeTopic.unavailable}
              reauthRequired={reauthRequired}
              persistingSend={persistingSend}
              draftAttachmentName={currentDraft?.attachment?.name}
              hasDraftAttachment={Boolean(currentDraft?.attachment)}
              draftText={currentDraft?.text ?? ""}
              composerFormRef={composerFormRef}
              composerTextareaRef={composerTextareaRef}
              viewportMode={viewportMode}
              supportsFileDropAndPaste={supportsFileDropAndPaste}
              onScrollToBottom={scrollToBottom}
              onRemoveAttachment={() => handleRemoveAttachment(roomId)}
              onSelectSlashCommand={(command) =>
                void handleSelectSlashCommand(roomId, command)
              }
              onSendMessage={(event) => void handleSendMessage(event)}
              onPickedFiles={(files) => handlePickedFiles(roomId, files)}
              onFocusTextarea={() => setOverflowMenuOpen(false)}
              onDraftTextChange={(text) => updateDraftText(roomId, text)}
              extractDataTransferFiles={extractDataTransferFiles}
            />
        </main>
      </div>
    );
  }

  function renderEmptyDetail() {
    return (
      <EmptyDetailView
        reauthBanner={
          reauthRequired && !settingsOpen && !creating ? renderReauthBanner() : null
        }
        topicsCount={topics.length}
        reauthRequired={reauthRequired}
        onOpenCreateForm={openCreateForm}
      />
    );
  }
  return (
    <div
      className="waypoint-workspace flex h-full w-full overflow-hidden bg-background text-foreground"
      data-viewport={viewportMode}
      style={{ "--keyboard-inset": `${safeInset}px` } as CSSProperties}
    >
      {showSidebar ? (
        <SidebarView
          pageEnterClass={pageEnterClass}
          reauthRequired={reauthRequired}
          showDetail={showDetail}
          reauthBanner={reauthRequired && !showDetail ? renderReauthBanner() : null}
          topics={topics}
          activeTopicId={activeTopic?.roomId}
          registeredAgentsCount={registeredAgents.length}
          nowMs={nowMs}
          isNarrow={isNarrow}
          onOpenSettings={openSettings}
          onOpenCreateForm={openCreateForm}
          onOpenTopic={openTopic}
        />
      ) : null}

      {showDetail ? (
        <div
          key={isNarrow ? narrowPageKey : "wide"}
          className={cn(
            "waypoint-detail relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
            isNarrow && "w-full",
            pageEnterClass,
          )}
        >
          {isNarrow ? (
            settingsOpen ? (
              renderSettingsDialog(false)
            ) : creating ? (
              renderCreateDialog(false)
            ) : activeTopic && editing ? (
              renderEditDialog(false)
            ) : activeTopic ? (
              renderTopicView()
            ) : (
              renderEmptyDetail()
            )
          ) : (
            <>
              <div
                style={{ display: "contents" }}
                aria-hidden={settingsOpen || creating || editing ? "true" : undefined}
              >
                {activeTopic ? renderTopicView() : renderEmptyDetail()}
              </div>
              {settingsOpen
                ? renderSettingsDialog(true)
                : creating
                  ? renderCreateDialog(true)
                  : activeTopic && editing
                    ? renderEditDialog(true)
                    : null}
            </>
          )}
        </div>
      ) : null}
      {toastNotice ? (
        <div
          role="status"
          aria-live="polite"
          className="waypoint-toast fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-lg"
        >
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
