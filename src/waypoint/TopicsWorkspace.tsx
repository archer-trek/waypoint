import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn } from "@/lib/utils";
import { installViewportScrollLock, resetRootViewportOffset } from "@/lib/viewport-lock";
import { normalizeInset } from "../adapters/inset";
import type { Clock, PlatformAdapter, TransportResult, ViewportMode } from "../adapters/types";
import {
  BACKFILL_PAGE_LIMIT,
  nextBackfillTargetForReadPosition,
  nextBackfillTargetForScrollUp,
  timelineIndexOf,
  type MatrixClient,
} from "./matrix-client";
import { generateAttachmentId, type AttachmentMeta, type DraftRecord } from "./session-store";
import {
  classifyLoginFailure,
  extractLoginSession,
  isAbortedFailure,
  isCredentialRejected,
  isDeviceIdRejected,
  isSyncCursorRejected,
} from "./matrix-errors";
import { DraftPersistenceManager } from "./draft-debounce";
import { RETRY_BACKOFF_MS, RetryQueue } from "./retry-queue";
import {
  appendDirectRoom,
  buildAddAgentContent,
  buildRemoveAgentContent,
  buildRenameAgentContent,
  computeTargetReadPosition,
  createTopicRoom,
  deleteTopicMessage,
  deleteTopicRoom,
  deriveFavoritePreviewForTimelineItem,
  deriveRoomAvailability,
  deriveTopicFavorites,
  type BubbleVisibility,
  type TimelineItem,
  type TimelineMedia,
  type TopicFavoriteItem,
  deriveRoomTimelineItems,
  hasLimitedGapAfterReadPosition,
  deriveTopics,
  parseRegisteredAgents,
  resolvePreselectedBotId,
  saveRegisteredAgents,
  setTopicPinned,
  toggleMessageFavorite,
  updateTopicDetails,
  validateAgentUserId,
} from "./topics";
import { ComposerView } from "./workspace/ComposerView";
import { CreateTopicView } from "./workspace/CreateTopicView";
import { DeleteMessageDialog } from "./workspace/DeleteMessageDialog";
import { DeleteTopicDialog } from "./workspace/DeleteTopicDialog";
import { TopicFavoritesDialog } from "./workspace/TopicFavoritesDialog";
import { EditTopicView } from "./workspace/EditTopicView";
import { EmptyDetailView } from "./workspace/EmptyDetailView";
import { ReauthBanner } from "./workspace/ReauthBanner";
import { DiscardChangesDialog } from "./workspace/ResponsiveFormShell";
import { isSettingsAgentsFormDirty, SettingsView } from "./workspace/SettingsView";
import { SidebarView } from "./workspace/SidebarView";
import { TimelineView } from "./workspace/TimelineView";
import { TopicHeaderView } from "./workspace/TopicHeaderView";
import type { AgentsFormState } from "./workspace/types";

const FOREGROUND_SYNC_INTERVAL_MS = 1000;
const SYNC_WRITE_BACKOFF_MS = [5000, 15000, 30000];
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
  const [respondingTick, setRespondingTick] = useState(0);
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
  const activeTopicIdRef = useRef(activeTopicId);
  activeTopicIdRef.current = activeTopicId;
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
  const [deleteMessageTarget, setDeleteMessageTarget] = useState<{
    roomId: string;
    eventId: string;
  } | null>(null);
  const [deletingMessage, setDeletingMessage] = useState(false);
  const deletingMessageRef = useRef(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoritePendingKeys, setFavoritePendingKeys] = useState<string[]>([]);
  const favoritePendingRef = useRef<Set<string>>(new Set());
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const pendingJumpRequestRef = useRef<{ roomId: string; eventId: string } | null>(null);
  const [toastNotice, setToastNotice] = useState<string | undefined>(undefined);
  const toastNoticeTimerRef = useRef<number | undefined>(undefined);
  const draftManager = useMemo(
    () =>
      new DraftPersistenceManager(clock, (roomId, text, options) =>
        client.setDraftText(roomId, text, options),
      ),
    [client, clock],
  );
  const [draftsByRoom, setDraftsByRoom] = useState<Record<string, DraftRecord>>(() =>
    client.drafts(),
  );
  const draftsByRoomRef = useRef(draftsByRoom);
  draftsByRoomRef.current = draftsByRoom;
  function commitDraftsState(
    updater: (prev: Record<string, DraftRecord>) => Record<string, DraftRecord>,
  ) {
    const next = updater(draftsByRoomRef.current);
    if (next !== draftsByRoomRef.current) {
      draftsByRoomRef.current = next;
      setDraftsByRoom(next);
    }
  }
  const attachmentSeqRef = useRef<Record<string, number>>({});
  const inFlightAttachmentSelectRef = useRef<Record<string, Promise<void>>>({});
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const [persistingSend, setPersistingSend] = useState(false);
  const persistingSendRef = useRef(false);
  const [openFailedMenu, setOpenFailedMenu] = useState<{ roomId: string; id: string } | null>(null);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [messageContextMenuOpen, setMessageContextMenuOpen] = useState(false);
  const dismissContextMenuRef = useRef<(() => void) | null>(null);
  const [headerElevated, setHeaderElevated] = useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] = useState<(() => void) | null>(null);
  const [swipeBackOffset, setSwipeBackOffset] = useState(0);
  const [isSwipingBack, setIsSwipingBack] = useState(false);
  const detailContainerRef = useRef<HTMLDivElement | null>(null);
  const edgeSwipeTrackingRef = useRef<{
    startX: number;
    startY: number;
    tracking: boolean;
    engaged: boolean;
    offset: number;
  } | null>(null);

  const EDGE_SWIPE_SLOP_PX = 10;

  function isInsideScrolledHorizontalContainer(target: EventTarget | null): boolean {
    let el = target as HTMLElement | null;
    while (el && el !== document.body) {
      if (
        (el.tagName.toLowerCase() === "pre" ||
          el.tagName.toLowerCase() === "code" ||
          el.getAttribute("data-streamdown") === "table-wrapper" ||
          el.getAttribute("data-streamdown") === "code-block-body") &&
        el.scrollWidth > el.clientWidth &&
        el.scrollLeft > 0
      ) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function handleEdgeSwipeTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1) {
      edgeSwipeTrackingRef.current = null;
      return;
    }
    const touch = event.touches[0]!;
    if (touch.clientX > 24) {
      edgeSwipeTrackingRef.current = null;
      return;
    }
    if (isInsideScrolledHorizontalContainer(event.target)) {
      edgeSwipeTrackingRef.current = null;
      return;
    }
    edgeSwipeTrackingRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      tracking: true,
      engaged: false,
      offset: 0,
    };
  }

  function handleEdgeSwipeTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    const track = edgeSwipeTrackingRef.current;
    if (!track?.tracking || event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0]!;
    const deltaX = touch.clientX - track.startX;
    const deltaY = touch.clientY - track.startY;

    if (!track.engaged) {
      if (Math.abs(deltaY) > EDGE_SWIPE_SLOP_PX && Math.abs(deltaY) > Math.abs(deltaX)) {
        edgeSwipeTrackingRef.current = null;
        return;
      }
      if (deltaX <= EDGE_SWIPE_SLOP_PX || deltaX <= Math.abs(deltaY)) {
        return;
      }
      track.engaged = true;
      setIsSwipingBack(true);
    }

    const nextOffset = Math.max(0, deltaX);
    track.offset = nextOffset;
    setSwipeBackOffset(nextOffset);
  }

  function handleEdgeSwipeTouchEnd() {
    const track = edgeSwipeTrackingRef.current;
    const shouldGoBack = Boolean(track?.tracking && track.engaged && track.offset > 80);
    edgeSwipeTrackingRef.current = null;
    setIsSwipingBack(false);
    setSwipeBackOffset(0);
    if (shouldGoBack) {
      goBack();
    }
  }
  const [showScrollBottomFab, setShowScrollBottomFab] = useState(false);
  const [composerMultiline, setComposerMultiline] = useState(false);
  const [composerTextareaScrollable, setComposerTextareaScrollable] = useState(false);
  const focusViewportRafRef = useRef<number | undefined>(undefined);
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
  const syncWriteFailCountRef = useRef(0);
  const [syncStorageWarning, setSyncStorageWarning] = useState(false);
  const syncInFlightRef = useRef(false);
  const syncWakePendingRef = useRef(false);
  const syncAbortControllerRef = useRef<AbortController | null>(null);
  const isAtBottomRef = useRef(true);
  const prevTimelineKeyRef = useRef<string>("");
  const prevTimelineClientHeightRef = useRef<number | null>(null);
  const activeVisibleRoomRef = useRef<string | null>(null);
  const backfillInFlightRoomsRef = useRef(new Set<string>());
  const openBackfillStoppedRoomsRef = useRef(new Set<string>());
  const viewportBackfillStoppedRoomsRef = useRef(new Set<string>());
  const viewportBackfillLastTokenRef = useRef<Map<string, string>>(new Map());
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
    Map<string, { url: string; revoke?: () => void }>
  >(new Map());
  const loadingLocalMediaRef = useRef<Set<string>>(new Set());
  const downloadingMediaRef = useRef<Set<string>>(new Set());
  const failedImageMxcUrlsRef = useRef<Set<string>>(new Set());

  const registeredAgents = parseRegisteredAgents(
    client.accountData("im.waypoint.agents"),
    client.ownerId,
  );
  const rooms = client.rooms();
  const roomList = Object.values(rooms);
  const nowMs = clock.currentTimeMs ? clock.currentTimeMs() : Date.now();
  const topics = deriveTopics(rooms, registeredAgents, client.ownerId, client.pendingRoomEvents(), {
    nowMs,
    syncPaused: reauthRequired,
  });
  const nextRespondingExpiryMs = topics.reduce<number | undefined>((earliest, topic) => {
    if (!topic.responding || topic.respondingExpiresAtMs === undefined) {
      return earliest;
    }
    return earliest === undefined
      ? topic.respondingExpiresAtMs
      : Math.min(earliest, topic.respondingExpiresAtMs);
  }, undefined);
  useEffect(() => {
    void respondingTick;
    if (nextRespondingExpiryMs === undefined) {
      return undefined;
    }
    const currentNow = clock.currentTimeMs ? clock.currentTimeMs() : Date.now();
    const delayMs = Math.min(Math.max(0, nextRespondingExpiryMs - currentNow), 2_147_483_647);
    const timerId = clock.setTimeout(() => {
      if (mountedRef.current) {
        setRespondingTick((value) => value + 1);
      }
    }, delayMs);
    return () => {
      clock.clearTimeout(timerId);
    };
  }, [nextRespondingExpiryMs, respondingTick, clock]);
  const activeTopic = activeTopicId
    ? topics.find((topic) => topic.roomId === activeTopicId)
    : undefined;
  const visibleComposerRoomId =
    !settingsOpen && !creating && !editing && activeTopic ? activeTopic.roomId : null;
  activeVisibleRoomRef.current = visibleComposerRoomId;
  const openFailedMenuId =
    visibleComposerRoomId !== null && openFailedMenu?.roomId === visibleComposerRoomId
      ? openFailedMenu.id
      : null;
  function setOpenFailedMenuId(next: SetStateAction<string | null>) {
    setOpenFailedMenu((prev) => {
      const prevId =
        visibleComposerRoomId !== null && prev?.roomId === visibleComposerRoomId ? prev.id : null;
      const nextId = typeof next === "function" ? next(prevId) : next;
      return nextId && visibleComposerRoomId ? { roomId: visibleComposerRoomId, id: nextId } : null;
    });
  }
  const activeTimelineItems = activeTopic
    ? deriveRoomTimelineItems(
        rooms[activeTopic.roomId],
        client.pendingRoomEvents(activeTopic.roomId),
        client.ownerId,
        activeTopic.agentUserId,
        nowMs,
      )
    : [];
  const activeFavorites = activeTopic
    ? deriveTopicFavorites(
        rooms[activeTopic.roomId],
        client.ownerId,
        activeTopic.agentUserId,
      )
    : { items: [], favoritedEventIds: new Set<string>() };
  const activeFavoritePendingEventIds = new Set<string>();
  if (activeTopic) {
    const prefix = `${activeTopic.roomId}\n`;
    for (const key of favoritePendingKeys) {
      if (key.startsWith(prefix)) {
        activeFavoritePendingEventIds.add(key.slice(prefix.length));
      }
    }
  }
  const timelineContentKey = `${activeTopic?.responding ? "1" : "0"}\0${activeTimelineItems
    .map((item) => {
      if (item.kind === "day-separator") {
        return `s:${item.key}`;
      }
      const promptSig = item.prompt
        ? `${item.prompt.kind}:${item.prompt.answered ? 1 : 0}:${item.prompt.superseded ? 1 : 0}:${item.prompt.queuedKey ?? ""}:${item.prompt.options.map((o) => `${o.key}${o.redacted ? "!" : ""}`).join(",")}`
        : "";
      return `m:${item.key}:${item.status}:${item.reactions?.join(",") ?? ""}:${promptSig}:${item.media?.mxcUrl ?? ""}:${item.media?.filename ?? ""}:${item.body}`;
    })
    .join("\0")}`;

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

  const applyNavigationDepth = useEffectEvent((desiredDepth: number) => {
    syncNavigationDepth(desiredDepth);
  });

  useEffect(() => {
    applyNavigationDepth(targetDepth);
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

  const anyFormSubmitting = submitting || quickSubmitting || agentsSubmitting || editSubmitting || exiting || deleting || deletingMessage || reauthSubmitting;

  const createIsDirty = Boolean(
    nameInput.trim() ||
      descriptionInput.trim() ||
      quickUserId.trim() ||
      quickHandwrittenName.trim(),
  );
  const editIsDirty = activeTopic
    ? editNameInput !== activeTopic.name ||
      editDescriptionInput !== (activeTopic.description ?? "")
    : false;
  const settingsIsDirty = isSettingsAgentsFormDirty(agentsForm, registeredAgents);

  function requestGuardedExit(isDirty: boolean, action: () => void) {
    if (isDirty) {
      setPendingDiscardAction(() => action);
    } else {
      action();
    }
  }

  function restoreNarrowNavDepthAfterIntercept() {
    if (viewportMode !== "narrow") {
      return;
    }
    navDepthRef.current = Math.max(0, navDepthRef.current - 1);
    syncNavigationDepth(targetDepth);
  }

  function handleSubViewBack(
    isBusy: boolean,
    isDirty: boolean,
    onCleanClose: () => void,
    onDirtyClose: () => void,
  ): true {
    if (viewportMode === "narrow") {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
    }
    if (isBusy) {
      if (viewportMode === "narrow") {
        syncNavigationDepth(targetDepth);
      }
      return true;
    }
    if (isDirty) {
      if (viewportMode === "narrow") {
        syncNavigationDepth(targetDepth);
      }
      setPendingDiscardAction(() => onDirtyClose);
      return true;
    }
    onCleanClose();
    return true;
  }

  backHandlerRef.current = () => {
    if (pendingDiscardAction !== null) {
      restoreNarrowNavDepthAfterIntercept();
      setPendingDiscardAction(null);
      return true;
    }
    if (deleteMessageTarget !== null) {
      restoreNarrowNavDepthAfterIntercept();
      if (!deletingMessage) {
        setDeleteMessageTarget(null);
      }
      return true;
    }
    if (deleteConfirmOpen) {
      restoreNarrowNavDepthAfterIntercept();
      if (!deleting) {
        cancelDeleteConfirm();
      }
      return true;
    }
    if (exitConfirmOpen) {
      restoreNarrowNavDepthAfterIntercept();
      if (!exiting) {
        cancelExitConfirm();
      }
      return true;
    }
    if (agentsForm?.mode === "remove") {
      restoreNarrowNavDepthAfterIntercept();
      if (!agentsSubmitting) {
        cancelAgentsAction();
      }
      return true;
    }
    if (favoritesOpen) {
      restoreNarrowNavDepthAfterIntercept();
      setFavoritesOpen(false);
      return true;
    }
    if (messageContextMenuOpen) {
      restoreNarrowNavDepthAfterIntercept();
      dismissContextMenuRef.current?.();
      setMessageContextMenuOpen(false);
      return true;
    }
    if (overflowMenuOpen) {
      restoreNarrowNavDepthAfterIntercept();
      setOverflowMenuOpen(false);
      return true;
    }
    if (openFailedMenuId !== null) {
      restoreNarrowNavDepthAfterIntercept();
      setOpenFailedMenu(null);
      return true;
    }
    if (settingsOpen) {
      return handleSubViewBack(
        agentsSubmitting || exiting,
        settingsIsDirty,
        () => {
          setSettingsOpen(false);
          resetAgentsForm();
          setExitConfirmOpen(false);
        },
        closeSettings,
      );
    }
    if (creating) {
      return handleSubViewBack(
        submitting || quickSubmitting,
        createIsDirty,
        resetCreateForm,
        closeCreateForm,
      );
    }
    if (editing && activeTopic) {
      return handleSubViewBack(
        editSubmitting,
        editIsDirty,
        resetEditForm,
        closeEditForm,
      );
    }
    if (viewportMode === "narrow" && activeTopic) {
      navDepthRef.current = Math.max(0, navDepthRef.current - 1);
      if (deleting) {
        syncNavigationDepth(targetDepth);
        return true;
      }
      leaveActiveTopic(activeTopic.roomId);
      return true;
    }
    return false;
  };

  const canHandleSystemBack =
    pendingDiscardAction !== null ||
    deleteMessageTarget !== null ||
    favoritesOpen ||
    deleteConfirmOpen ||
    exitConfirmOpen ||
    agentsForm?.mode === "remove" ||
    messageContextMenuOpen ||
    overflowMenuOpen ||
    openFailedMenuId !== null ||
    settingsOpen ||
    creating ||
    Boolean(editing && activeTopic) ||
    (viewportMode === "narrow" && Boolean(activeTopic));

  useEffect(() => {
    platform?.setSystemBackEnabled?.(canHandleSystemBack);
  }, [platform, canHandleSystemBack]);

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

  const onGlobalKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape") {
      if (event.defaultPrevented || pendingDiscardAction !== null) return;
      if (overflowMenuOpen) {
        setOverflowMenuOpen(false);
      } else if (creating) {
        if (submitting || quickSubmitting) return;
        if (quickRegisterOpen) {
          closeQuickRegister();
        } else {
          requestGuardedExit(createIsDirty, closeCreateForm);
        }
      } else if (settingsOpen) {
        if (agentsSubmitting || exiting) return;
        if (agentsForm && agentsForm.mode !== "remove") {
          cancelAgentsAction();
        } else if (exitConfirmOpen) {
          cancelExitConfirm();
        } else {
          requestGuardedExit(settingsIsDirty, closeSettings);
        }
      } else if (editing) {
        if (editSubmitting) return;
        requestGuardedExit(editIsDirty, closeEditForm);
      } else if (deleteMessageTarget !== null) {
        if (!deletingMessage) {
          setDeleteMessageTarget(null);
        }
      } else if (favoritesOpen) {
        setFavoritesOpen(false);
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
  });

  useEffect(() => {
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, []);

  const activeRoomId = activeTopic?.roomId;
  const currentDraftText = draftsByRoom[activeRoomId ?? ""]?.text ?? "";

  useEffect(() => {
    if (!platform?.subscribeKeyboardInsetBottom) {
      return undefined;
    }
    return platform.subscribeKeyboardInsetBottom((inset) => {
      if (normalizeInset(inset) > 0) {
        setOverflowMenuOpen(false);
      }
    });
  }, [platform]);

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
      if (!style.font) {
        probe.style.fontFamily = style.fontFamily;
        probe.style.fontSize = style.fontSize;
        probe.style.fontWeight = style.fontWeight;
      }
      probe.style.letterSpacing = style.letterSpacing;
      probe.textContent = textValue;
      document.body.appendChild(probe);
      const textWidth = probe.getBoundingClientRect().width;
      probe.remove();
      // Measure against fixed single-line padding rather than computed padding,
      // because multiline mode narrows horizontal padding and would otherwise oscillate.
      const singleLinePadX = 96;
      const available = form.clientWidth - singleLinePadX - 4;
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
    const nextScrollable = exceeds && scrollHeight > nextHeight + 1;
    setComposerTextareaScrollable((prev) => (prev === nextScrollable ? prev : nextScrollable));
  }, [currentDraftText, activeRoomId, composerMultiline, composerWidth, viewportMode]);

  function openSettings() {
    if (anyFormSubmitting) {
      return;
    }
    if (activeTopicIdRef.current) {
      void draftManager.flush(activeTopicIdRef.current);
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
    draftManager.cancel();
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
      initialHandwrittenName: currentName ?? "",
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
      setAgentsError("名册中至少需要保留一个 Bot。");
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
    if (activeTopicIdRef.current) {
      void draftManager.flush(activeTopicIdRef.current);
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
    void draftManager.flush(activeTopic.roomId);
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
    if (activeTopicIdRef.current && activeTopicIdRef.current !== roomId) {
      void draftManager.flush(activeTopicIdRef.current);
    }
    setSettingsOpen(false);
    resetCreateForm();
    resetEditForm();
    setDeleteConfirmOpen(false);
    setDeleteError(undefined);
    setDeleteMessageTarget(null);
    setFavoritesOpen(false);
    setHighlightedEventId(null);
    pendingJumpRequestRef.current = null;
    setHeaderElevated(false);
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

  const onFavoriteJumpLanded = useEffectEvent((eventId: string, showFab: boolean) => {
    setShowScrollBottomFab(showFab);
    if (highlightTimerRef.current !== undefined) {
      clock.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = undefined;
    }
    setHighlightedEventId(eventId);
    highlightTimerRef.current = clock.setTimeout(() => {
      highlightTimerRef.current = undefined;
      if (mountedRef.current) {
        setHighlightedEventId((prev) => (prev === eventId ? null : prev));
      }
    }, 2200);
  });

  async function submitFavoriteToggle(
    roomId: string,
    entry: {
      eventId: string;
      favoritedAt: number;
      senderSide?: "left" | "right";
      preview: string;
      ts?: number;
    },
    currentlyFavorited: boolean,
  ) {
    if (exiting || reauthRequiredRef.current) {
      return;
    }
    const key = `${roomId}\n${entry.eventId}`;
    if (favoritePendingRef.current.has(key)) {
      return;
    }
    favoritePendingRef.current.add(key);
    setFavoritePendingKeys(Array.from(favoritePendingRef.current));
    try {
      const result = await toggleMessageFavorite(client, roomId, entry, currentlyFavorited);
      if (!mountedRef.current || !client.hasToken) {
        return;
      }
      if (!result.ok) {
        showToastNotice(result.message);
        return;
      }
      setRevision((value) => value + 1);
    } finally {
      favoritePendingRef.current.delete(key);
      if (mountedRef.current) {
        setFavoritePendingKeys(Array.from(favoritePendingRef.current));
      }
    }
  }

  async function handleToggleFavorite(
    roomId: string,
    item: Extract<TimelineItem, { kind: "message" }>,
  ) {
    if (!item.eventId || item.status !== "confirmed") {
      return;
    }
    const existingFavorites = client.rooms()[roomId]?.favorites ?? [];
    const currentlyFavorited = existingFavorites.some((f) => f.eventId === item.eventId);
    await submitFavoriteToggle(
      roomId,
      {
        eventId: item.eventId,
        favoritedAt: clock.currentTimeMs ? clock.currentTimeMs() : Date.now(),
        senderSide: item.side,
        preview: deriveFavoritePreviewForTimelineItem(item),
        ...(item.ts !== undefined ? { ts: item.ts } : {}),
      },
      currentlyFavorited,
    );
  }

  async function handleRemoveFavoriteFromDialog(
    roomId: string,
    favItem: TopicFavoriteItem,
  ) {
    await submitFavoriteToggle(
      roomId,
      {
        eventId: favItem.eventId,
        favoritedAt: favItem.favoritedAt,
        ...(favItem.senderSide ? { senderSide: favItem.senderSide } : {}),
        preview: favItem.preview,
        ...(favItem.ts !== undefined ? { ts: favItem.ts } : {}),
      },
      true,
    );
  }

  function handleRequestDeleteMessage(
    roomId: string,
    item: Extract<TimelineItem, { kind: "message" }>,
  ) {
    if (
      !item.eventId ||
      item.status !== "confirmed" ||
      deletingMessageRef.current ||
      anyFormSubmitting ||
      exiting ||
      reauthRequiredRef.current
    ) {
      return;
    }
    if (deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable) {
      return;
    }
    setDeleteMessageTarget({ roomId, eventId: item.eventId });
  }

  async function confirmDeleteMessage() {
    if (deletingMessageRef.current || !deleteMessageTarget) {
      return;
    }
    const target = deleteMessageTarget;
    deletingMessageRef.current = true;
    setDeletingMessage(true);
    try {
      const result = await deleteTopicMessage(client, target.roomId, target.eventId);
      if (!mountedRef.current) {
        return;
      }
      setDeleteMessageTarget(null);
      if (!result.ok) {
        showToastNotice(result.message);
        return;
      }
      setRevision((value) => value + 1);
    } finally {
      deletingMessageRef.current = false;
      if (mountedRef.current) {
        setDeletingMessage(false);
      }
    }
  }

  async function handleSelectFavoriteJump(roomId: string, eventId: string) {
    setFavoritesOpen(false);
    awaitingReadPosLandingRoomRef.current = null;
    userScrolledRoomRef.current = roomId;

    const currentRoom = client.rooms()[roomId];
    if (currentRoom && timelineIndexOf(currentRoom.timelineEvents, eventId) !== -1) {
      pendingJumpRequestRef.current = { roomId, eventId };
      setRevision((value) => value + 1);
      return;
    }

    const myEpoch = syncEpochRef.current;
    const leaveGen = client.currentLeaveGeneration;
    pendingJumpRequestRef.current = { roomId, eventId };

    while (
      mountedRef.current &&
      activeVisibleRoomRef.current === roomId &&
      syncEpochRef.current === myEpoch &&
      pendingJumpRequestRef.current?.roomId === roomId &&
      pendingJumpRequestRef.current?.eventId === eventId
    ) {
      const latestRoom = client.rooms()[roomId];
      if (!latestRoom) {
        pendingJumpRequestRef.current = null;
        return;
      }
      if (timelineIndexOf(latestRoom.timelineEvents, eventId) !== -1) {
        setRevision((value) => value + 1);
        return;
      }
      if (!latestRoom.favorites?.some((f) => f.eventId === eventId)) {
        pendingJumpRequestRef.current = null;
        showToastNotice("该消息已被删除。");
        setRevision((value) => value + 1);
        return;
      }
      if (client.hasOlderLocalChunks(roomId)) {
        const loaded = await client.loadNextOlderLocalChunk(roomId);
        if (loaded === 0) {
          continue;
        }
        continue;
      }
      if (pausedRef.current || reauthRequiredRef.current || !client.hasToken) {
        pendingJumpRequestRef.current = null;
        return;
      }
      const target = nextBackfillTargetForScrollUp(latestRoom);
      if (!target) {
        pendingJumpRequestRef.current = null;
        showToastNotice("未能定位到该消息。");
        return;
      }
      let result: TransportResult;
      try {
        result = await client.roomMessagesBackward(roomId, target.fromToken, BACKFILL_PAGE_LIMIT);
      } catch {
        pendingJumpRequestRef.current = null;
        showToastNotice("暂时无法加载更早的消息，请检查网络后重试。");
        return;
      }
      if (
        !mountedRef.current ||
        activeVisibleRoomRef.current !== roomId ||
        syncEpochRef.current !== myEpoch
      ) {
        return;
      }
      if (isCredentialRejected(result)) {
        pendingJumpRequestRef.current = null;
        pauseForCredentialRejection();
        return;
      }
      if (result.type !== "response" || result.status !== 200) {
        pendingJumpRequestRef.current = null;
        showToastNotice("暂时无法加载更早的消息，请稍后重试。");
        return;
      }
      const applied = await client.applyBackfillPage(roomId, {
        fromToken: target.fromToken,
        body: result.body,
        gapIndex: target.gapIndex,
        leaveGeneration: leaveGen,
      });
      if (applied.prependedCount === 0 && applied.reachedStart) {
        break;
      }
    }

    if (
      mountedRef.current &&
      activeVisibleRoomRef.current === roomId &&
      pendingJumpRequestRef.current?.roomId === roomId &&
      pendingJumpRequestRef.current?.eventId === eventId
    ) {
      const finalRoom = client.rooms()[roomId];
      if (finalRoom && timelineIndexOf(finalRoom.timelineEvents, eventId) !== -1) {
        setRevision((value) => value + 1);
      } else {
        pendingJumpRequestRef.current = null;
        if (finalRoom && !finalRoom.favorites?.some((f) => f.eventId === eventId)) {
          showToastNotice("该消息已被删除。");
          setRevision((value) => value + 1);
        } else {
          showToastNotice("未能定位到该消息。");
        }
      }
    }
  }

  async function confirmDeleteTopic() {
    if (deletingRef.current || !activeTopic) {
      return;
    }
    const targetRoomId = activeTopic.roomId;
    const prevDraftText = draftsByRoomRef.current[targetRoomId]?.text ?? "";
    const hadPendingDraft = draftManager.hasPending(targetRoomId);
    const delSeq = draftManager.cancel(targetRoomId);
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const result = await deleteTopicRoom(client, targetRoomId);
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        if (hadPendingDraft && draftManager.currentSeq(targetRoomId) === delSeq) {
          draftManager.restorePending(targetRoomId, prevDraftText, delSeq);
          void draftManager.flush(targetRoomId);
        }
        setDeleteError(result.message);
        return;
      }
      delete lastRequestedReadRef.current[targetRoomId];
      attachmentSeqRef.current[targetRoomId] = (attachmentSeqRef.current[targetRoomId] ?? 0) + 1;
      draftManager.bumpSeq(targetRoomId);
      commitDraftsState((prev) => {
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

  function leaveActiveTopic(roomId: string) {
    void draftManager.flush(roomId);
    evaluateVisibleReadPosition(roomId);
    setActiveTopicId(null);
    setDescriptionExpanded(false);
    setDeleteConfirmOpen(false);
    setDeleteError(undefined);
    setDeleteMessageTarget(null);
    setFavoritesOpen(false);
    setHighlightedEventId(null);
    pendingJumpRequestRef.current = null;
  }

  function goBack() {
    if (settingsOpen) {
      if (agentsSubmitting || exiting) return;
      requestGuardedExit(settingsIsDirty, closeSettings);
      return;
    }
    if (creating) {
      if (submitting || quickSubmitting) return;
      requestGuardedExit(createIsDirty, closeCreateForm);
      return;
    }
    if (editing && activeTopic) {
      if (editSubmitting) return;
      requestGuardedExit(editIsDirty, closeEditForm);
      return;
    }
    if (activeTopic) {
      if (deleting) {
        return;
      }
      leaveActiveTopic(activeTopic.roomId);
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
    reauthRequiredRef.current = true;
    syncInFlightRef.current = false;
    syncWakePendingRef.current = false;
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    clearSyncTimer();
    retryQueue.pause();
    void draftManager.flush(undefined, { commit: true });
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
        const wasBackedOff = syncBackoffRef.current > 0;
        try {
          await client.retainSync(attempt);
        } catch {
          if (!mountedRef.current || isSyncPaused() || syncEpochRef.current !== mySyncEpoch) {
            return;
          }
          syncWriteFailCountRef.current += 1;
          const failCount = syncWriteFailCountRef.current;
          if (failCount >= 3) {
            setSyncStorageWarning(true);
          }
          syncWakePendingRef.current = false;
          const delay =
            SYNC_WRITE_BACKOFF_MS[Math.min(failCount - 1, SYNC_WRITE_BACKOFF_MS.length - 1)]!;
          scheduleForegroundSync(delay);
          return;
        }
        syncSucceeded = true;
        syncBackoffRef.current = 0;
        if (syncWriteFailCountRef.current > 0) {
          syncWriteFailCountRef.current = 0;
          setSyncStorageWarning(false);
        }
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
        reconcileRoomsAfterSync();
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

  function reconcileRoomsAfterSync() {
    const currentRooms = client.rooms();
    for (const roomId of Object.keys(lastRequestedReadRef.current)) {
      if (!(roomId in currentRooms)) {
        delete lastRequestedReadRef.current[roomId];
      }
    }
    commitDraftsState((prev) => {
      const staleIds = Object.keys(prev).filter((roomId) => !(roomId in currentRooms));
      if (staleIds.length === 0) {
        return prev;
      }
      const next = { ...prev };
      for (const id of staleIds) {
        draftManager.cancel(id);
        delete next[id];
      }
      return next;
    });
    const currentTopics = deriveTopics(
      currentRooms,
      parseRegisteredAgents(client.accountData("im.waypoint.agents"), client.ownerId),
      client.ownerId,
      client.pendingRoomEvents(),
      {
        nowMs: clock.currentTimeMs ? clock.currentTimeMs() : Date.now(),
        syncPaused: reauthRequiredRef.current,
      },
    );
    const selectedId = activeTopicIdRef.current;
    if (selectedId && !currentTopics.some((topic) => topic.roomId === selectedId)) {
      setActiveTopicId(null);
      setDescriptionExpanded(false);
      setEditSubmitting(false);
      resetEditForm();
      if (!deletingRef.current) {
        setDeleteConfirmOpen(false);
        setDeleteError(undefined);
      }
    }
  }

  useEffect(() => {
    if (!openFailedMenuId) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenFailedMenu(null);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".waypoint-failed-controls")) {
        return;
      }
      setOpenFailedMenu(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [openFailedMenuId]);

  const prevActiveTopicIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevRoomId = prevActiveTopicIdRef.current;
    prevActiveTopicIdRef.current = activeTopicId;
    if (prevRoomId && prevRoomId !== activeTopicId) {
      void client.unloadColdChunks(prevRoomId).then((changed) => {
        if (changed && mountedRef.current) {
          setRevision((value) => value + 1);
        }
      });
    }
  }, [activeTopicId, client]);

  useEffect(() => {
    const prevRoomId = visibleComposerRoomRef.current;
    visibleComposerRoomRef.current = visibleComposerRoomId;
    if (prevRoomId && prevRoomId !== visibleComposerRoomId) {
      void draftManager.flush(prevRoomId);
      setComposerError(undefined);
      commitDraftsState((prev) => {
        const draft = prev[prevRoomId];
        if (!draft) {
          return prev;
        }
        const hasText = typeof draft.text === "string" && draft.text.trim() !== "";
        if (hasText) {
          return prev;
        }
        if (draft.attachmentId && draft.attachmentMeta) {
          if (draft.text === undefined) {
            return prev;
          }
          return {
            ...prev,
            [prevRoomId]: {
              attachmentId: draft.attachmentId,
              attachmentMeta: draft.attachmentMeta,
            },
          };
        }
        const next = { ...prev };
        delete next[prevRoomId];
        return next;
      });
    }
  }, [visibleComposerRoomId, draftManager]);

  const onCredentialRejected = useEffectEvent(() => {
    pauseForCredentialRejection();
  });

  const onStartInitialSync = useEffectEvent(() => {
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
  });

  const onVisibilityChange = useEffectEvent((visible: boolean) => {
    if (!mountedRef.current) {
      return;
    }
    if (!visible) {
      void draftManager.flush(undefined, { commit: true });
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
  });

  const onNetworkResume = useEffectEvent(() => {
    handleNetworkResume();
  });

  const onClearSyncTimer = useEffectEvent(() => {
    clearSyncTimer();
  });

  useEffect(() => {
    mountedRef.current = true;
    const isReauth = initialReauthRequired || retryQueue.isPaused;
    pausedRef.current = isReauth;
    if (isReauth) {
      retryQueue.pause();
    }
    client.setCredentialRejectedHandler(() => {
      if (mountedRef.current) {
        onCredentialRejected();
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
          onCredentialRejected();
        }
      },
      isRoomUnavailable: (roomId) =>
        deriveRoomAvailability(client.rooms()[roomId], client.ownerId).unavailable,
    });
    if (!pausedRef.current) {
      onStartInitialSync();
    }
    let unsubVisibility: () => void;
    if (platform?.subscribeAppVisibility) {
      unsubVisibility = platform.subscribeAppVisibility(onVisibilityChange);
    } else {
      const onVis = () =>
        onVisibilityChange(
          typeof document === "undefined" ? true : document.visibilityState !== "hidden",
        );
      const onHide = () => onVisibilityChange(false);
      const onShow = () =>
        onVisibilityChange(
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
    const handleDraftVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        void draftManager.flush(undefined, { commit: true });
      }
    };
    const handleDraftPageHide = () => {
      void draftManager.flush(undefined, { commit: true });
    };
    document?.addEventListener("visibilitychange", handleDraftVisibilityChange);
    window?.addEventListener("pagehide", handleDraftPageHide);
    let unsubResume: () => void;
    if (platform?.subscribeNetworkResume) {
      unsubResume = platform.subscribeNetworkResume(onNetworkResume);
    } else {
      window.addEventListener("online", onNetworkResume);
      unsubResume = () => window.removeEventListener("online", onNetworkResume);
    }
    const downloadedMediaCache = downloadedMediaCacheRef.current;
    const localMediaUrlCache = localMediaUrlCacheRef.current;
    return () => {
      document?.removeEventListener("visibilitychange", handleDraftVisibilityChange);
      window?.removeEventListener("pagehide", handleDraftPageHide);
      void draftManager.flush(undefined, { commit: true });
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
      onClearSyncTimer();
      if (toastNoticeTimerRef.current !== undefined) {
        clock.clearTimeout(toastNoticeTimerRef.current);
        toastNoticeTimerRef.current = undefined;
      }
      if (highlightTimerRef.current !== undefined) {
        clock.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = undefined;
      }
      unsubVisibility();
      unsubResume();
      for (const entry of downloadedMediaCache.values()) {
        entry.revoke?.();
      }
      downloadedMediaCache.clear();
      for (const entry of localMediaUrlCache.values()) {
        entry.revoke?.();
      }
      localMediaUrlCache.clear();
      client.setCredentialRejectedHandler(undefined);
      retryQueue.setCallbacks({});
      if (!providedRetryQueue) {
        retryQueue.dispose();
      }
    };
  }, [client, clock, draftManager, retryQueue, providedRetryQueue, platform, initialReauthRequired]);

  function syncHeaderElevation(container: HTMLElement | null) {
    const isScrolled = Boolean(container && container.scrollTop > 4);
    setHeaderElevated((prev) => (prev !== isScrolled ? isScrolled : prev));
  }

  function setTimelineScrollTop(container: HTMLElement, nextTop: number) {
    if (Math.abs(container.scrollTop - nextTop) < 0.5) {
      syncHeaderElevation(container);
      return;
    }
    programmaticScrollRef.current = { active: true, top: nextTop };
    container.scrollTop = nextTop;
    syncHeaderElevation(container);
  }

  async function triggerScrollBackfill(roomId: string) {
    if (exiting || backfillInFlightRoomsRef.current.has(roomId)) {
      return;
    }
    if (client.hasOlderLocalChunks(roomId)) {
      backfillInFlightRoomsRef.current.add(roomId);
      const myEpoch = syncEpochRef.current;
      try {
        const el = timelineRef.current;
        const shouldPreserve = el !== null && activeVisibleRoomRef.current === roomId;
        const prevScrollHeight = el?.scrollHeight ?? 0;
        const prevScrollTop = el?.scrollTop ?? 0;
        const loaded = await client.loadNextOlderLocalChunk(roomId);
        if (!mountedRef.current || syncEpochRef.current !== myEpoch) {
          return;
        }
        if (loaded > 0 && shouldPreserve && el) {
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
      return;
    }
    if (pausedRef.current || reauthRequiredRef.current || !client.hasToken) {
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

  const activeTopicNeedsReadGapBackfill = Boolean(activeTopic?.needsReadGapBackfill);

  useEffect(() => {
    if (userScrolledRoomRef.current !== visibleComposerRoomId) {
      userScrolledRoomRef.current = null;
    }
    for (const roomId of Array.from(openBackfillStoppedRoomsRef.current)) {
      if (roomId !== visibleComposerRoomId) {
        openBackfillStoppedRoomsRef.current.delete(roomId);
      }
    }
    if (!visibleComposerRoomId || !activeTopicNeedsReadGapBackfill) {
      return;
    }
    const hasLocalReadGap = client.needsLocalChunksForReadPosition(visibleComposerRoomId);
    const hasServerReadGap =
      !pausedRef.current &&
      !reauthRequiredRef.current &&
      client.hasToken &&
      Boolean(nextBackfillTargetForReadPosition(client.rooms()[visibleComposerRoomId]));
    if (
      exiting ||
      backfillInFlightRoomsRef.current.has(visibleComposerRoomId) ||
      openBackfillStoppedRoomsRef.current.has(visibleComposerRoomId) ||
      (!hasLocalReadGap && !hasServerReadGap)
    ) {
      return;
    }
    const roomId = visibleComposerRoomId;
    const myEpoch = syncEpochRef.current;
    awaitingReadPosLandingRoomRef.current = roomId;
    backfillInFlightRoomsRef.current.add(roomId);
    let cancelled = false;
    void (async () => {
      try {
        if (client.needsLocalChunksForReadPosition(roomId)) {
          const el = timelineRef.current;
          const shouldPreserve =
            el !== null &&
            activeVisibleRoomRef.current === roomId &&
            userScrolledRoomRef.current === roomId;
          const prevScrollHeight = el?.scrollHeight ?? 0;
          const prevScrollTop = el?.scrollTop ?? 0;
          await client.loadLocalChunksForReadPosition(roomId);
          if (cancelled || !mountedRef.current || syncEpochRef.current !== myEpoch) {
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
          const afterLocalRoom = client.rooms()[roomId];
          if (
            afterLocalRoom &&
            (afterLocalRoom.readPositionEventId === undefined ||
              timelineIndexOf(afterLocalRoom.timelineEvents, afterLocalRoom.readPositionEventId) !== -1) &&
            !hasLimitedGapAfterReadPosition(afterLocalRoom)
          ) {
            return;
          }
        }
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
            onCredentialRejected();
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
          if (outcome.hasReadPosition && !hasLimitedGapAfterReadPosition(client.rooms()[roomId])) {
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
  }, [visibleComposerRoomId, activeTopicNeedsReadGapBackfill, backfillTick, client, exiting, reauthRequired]);

  useEffect(() => {
    for (const roomId of Array.from(viewportBackfillStoppedRoomsRef.current)) {
      if (roomId !== visibleComposerRoomId) {
        viewportBackfillStoppedRoomsRef.current.delete(roomId);
        viewportBackfillLastTokenRef.current.delete(roomId);
      }
    }
    if (!visibleComposerRoomId) {
      return;
    }
    if (
      exiting ||
      backfillInFlightRoomsRef.current.has(visibleComposerRoomId) ||
      openBackfillStoppedRoomsRef.current.has(visibleComposerRoomId) ||
      viewportBackfillStoppedRoomsRef.current.has(visibleComposerRoomId)
    ) {
      return;
    }
    if (
      activeTopicNeedsReadGapBackfill &&
      (client.needsLocalChunksForReadPosition(visibleComposerRoomId) ||
        nextBackfillTargetForReadPosition(client.rooms()[visibleComposerRoomId]))
    ) {
      return;
    }
    const container = timelineRef.current;
    if (
      !container ||
      container.clientHeight <= 0 ||
      container.scrollHeight > container.clientHeight + TOP_SCROLL_THRESHOLD_PX
    ) {
      return;
    }
    if (client.hasOlderLocalChunks(visibleComposerRoomId)) {
      const roomId = visibleComposerRoomId;
      const myEpoch = syncEpochRef.current;
      backfillInFlightRoomsRef.current.add(roomId);
      let cancelled = false;
      void (async () => {
        try {
          const el = timelineRef.current;
          const shouldPreserve =
            el !== null &&
            activeVisibleRoomRef.current === roomId &&
            userScrolledRoomRef.current === roomId;
          const prevScrollHeight = el?.scrollHeight ?? 0;
          const prevScrollTop = el?.scrollTop ?? 0;
          await client.loadNextOlderLocalChunk(roomId);
          if (cancelled || !mountedRef.current || syncEpochRef.current !== myEpoch) {
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
          if (mountedRef.current && activeVisibleRoomRef.current === roomId) {
            setBackfillTick((value) => value + 1);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (pausedRef.current || reauthRequiredRef.current || !client.hasToken) {
      return;
    }
    const target = nextBackfillTargetForScrollUp(client.rooms()[visibleComposerRoomId]);
    if (!target) {
      return;
    }
    if (viewportBackfillLastTokenRef.current.get(visibleComposerRoomId) === target.fromToken) {
      viewportBackfillStoppedRoomsRef.current.add(visibleComposerRoomId);
      return;
    }
    const roomId = visibleComposerRoomId;
    const myEpoch = syncEpochRef.current;
    const leaveGen = client.currentLeaveGeneration;
    backfillInFlightRoomsRef.current.add(roomId);
    let cancelled = false;
    void (async () => {
      try {
        let result: TransportResult;
        try {
          result = await client.roomMessagesBackward(roomId, target.fromToken, BACKFILL_PAGE_LIMIT);
        } catch {
          viewportBackfillStoppedRoomsRef.current.add(roomId);
          return;
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
          return;
        }
        if (isCredentialRejected(result)) {
          onCredentialRejected();
          return;
        }
        if (result.type !== "response" || result.status !== 200) {
          viewportBackfillStoppedRoomsRef.current.add(roomId);
          return;
        }
        const el = timelineRef.current;
        const shouldPreserve =
          el !== null &&
          activeVisibleRoomRef.current === roomId &&
          userScrolledRoomRef.current === roomId;
        const prevScrollHeight = el?.scrollHeight ?? 0;
        const prevScrollTop = el?.scrollTop ?? 0;
        viewportBackfillLastTokenRef.current.set(roomId, target.fromToken);
        await client.applyBackfillPage(roomId, {
          fromToken: target.fromToken,
          body: result.body,
          gapIndex: target.gapIndex,
          leaveGeneration: leaveGen,
        });
        if (cancelled || !mountedRef.current || pausedRef.current || syncEpochRef.current !== myEpoch) {
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
        if (mountedRef.current && activeVisibleRoomRef.current === roomId) {
          setBackfillTick((value) => value + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    visibleComposerRoomId,
    activeTopicNeedsReadGapBackfill,
    timelineContentKey,
    backfillTick,
    client,
    exiting,
    reauthRequired,
  ]);

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
    const el = timelineRef.current;
    syncHeaderElevation(el);
    if (el && programmaticScrollRef.current.active) {
      const same = Math.abs(el.scrollTop - programmaticScrollRef.current.top) < 1;
      programmaticScrollRef.current.active = false;
      if (same) {
        if (visibleComposerRoomId) {
          evaluateVisibleReadPosition(visibleComposerRoomId);
        }
        return;
      }
    }
    collapseDescription();
    if (visibleComposerRoomId) {
      userScrolledRoomRef.current = visibleComposerRoomId;
    }
    if (el) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX;
      isAtBottomRef.current = atBottom;
      setShowScrollBottomFab(el.scrollHeight - el.scrollTop - el.clientHeight > 60);
      const isScrolled = el.scrollTop > 4;
      setHeaderElevated((prev) => (prev !== isScrolled ? isScrolled : prev));
      if (visibleComposerRoomId && el.scrollTop <= TOP_SCROLL_THRESHOLD_PX) {
        void triggerScrollBackfill(visibleComposerRoomId);
      }
    }
    if (visibleComposerRoomId) {
      evaluateVisibleReadPosition(visibleComposerRoomId);
    }
  }

  function classifyRowVisibility(
    rowTop: number,
    rowBottom: number,
    viewTop: number,
    viewBottom: number,
    atPhysicalBottom: boolean,
  ): BubbleVisibility {
    if (rowBottom <= viewTop) {
      return "above";
    }
    if (!atPhysicalBottom && rowTop >= viewBottom) {
      return "below";
    }
    return "visible";
  }

  function measureRowVisibility(container: HTMLElement): Map<string, BubbleVisibility> {
    const map = new Map<string, BubbleVisibility>();
    const rowEls = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"));
    if (rowEls.length === 0) {
      return map;
    }
    const atPhysicalBottom =
      container.clientHeight > 0 &&
      container.scrollHeight > 0 &&
      container.scrollHeight - container.scrollTop - container.clientHeight <= 1;
    const containerRect = container.getBoundingClientRect();
    const useRects =
      containerRect.height > 0 &&
      rowEls.some((el) => el.getBoundingClientRect().height > 0);
    if (useRects) {
      for (const el of rowEls) {
        const eventId = el.dataset.eventId;
        if (!eventId) continue;
        const rect = el.getBoundingClientRect();
        map.set(
          eventId,
          classifyRowVisibility(
            rect.top,
            rect.bottom,
            containerRect.top,
            containerRect.bottom,
            atPhysicalBottom,
          ),
        );
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
        map.set(
          eventId,
          classifyRowVisibility(
            elTop,
            elTop + el.offsetHeight,
            top,
            bottom,
            atPhysicalBottom,
          ),
        );
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

  function clearPendingReadRequest(roomId: string, eventId: string) {
    if (lastRequestedReadRef.current[roomId] === eventId) {
      delete lastRequestedReadRef.current[roomId];
    }
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
      const prevIdx = timelineIndexOf(room.timelineEvents, prevRequested);
      const targetIdx = timelineIndexOf(room.timelineEvents, targetEventId);
      if (prevIdx !== -1 && targetIdx !== -1 && prevIdx >= targetIdx) {
        return;
      }
    }
    lastRequestedReadRef.current[roomId] = targetEventId;
    void client.advanceReadPosition(roomId, targetEventId).then(
      (changed) => {
        clearPendingReadRequest(roomId, targetEventId);
        if (!changed || !mountedRef.current) {
          return;
        }
        setRevision((value) => value + 1);
        if (!isSyncPaused()) {
          retryQueue.wakeReadMarkers();
        }
      },
      () => {
        clearPendingReadRequest(roomId, targetEventId);
        if (mountedRef.current && activeVisibleRoomRef.current !== roomId) {
          setRevision((value) => value + 1);
        }
      },
    );
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

  function syncTimelineHeightAnchor(container: HTMLElement, roomId: string) {
    if (awaitingReadPosLandingRoomRef.current === roomId) {
      prevTimelineClientHeightRef.current = container.clientHeight;
      return;
    }
    const nextHeight = container.clientHeight;
    const prevHeight = prevTimelineClientHeightRef.current;
    prevTimelineClientHeightRef.current = nextHeight;
    if (prevHeight === null || prevHeight <= 0 || nextHeight <= 0 || nextHeight === prevHeight) {
      return;
    }
    const maxScroll = Math.max(0, container.scrollHeight - nextHeight);
    const wasAtBottom =
      isAtBottomRef.current ||
      container.scrollHeight - container.scrollTop - prevHeight <= AT_BOTTOM_THRESHOLD_PX;
    if (wasAtBottom) {
      setTimelineScrollTop(container, maxScroll);
      isAtBottomRef.current = true;
      setShowScrollBottomFab(false);
    } else {
      if (container.scrollTop > maxScroll) {
        setTimelineScrollTop(container, maxScroll);
      }
      const distanceFromBottom = container.scrollHeight - container.scrollTop - nextHeight;
      isAtBottomRef.current = distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX;
      setShowScrollBottomFab(distanceFromBottom > 60);
    }
    evaluateVisibleReadPosition(roomId);
  }

  const syncTimelineResize = useEffectEvent(() => {
    const container = timelineRef.current;
    const roomId = activeVisibleRoomRef.current;
    if (!container || !roomId) {
      return;
    }
    syncTimelineHeightAnchor(container, roomId);
    if (
      container.clientHeight > 0 &&
      container.scrollHeight <= container.clientHeight + TOP_SCROLL_THRESHOLD_PX &&
      !backfillInFlightRoomsRef.current.has(roomId) &&
      !viewportBackfillStoppedRoomsRef.current.has(roomId) &&
      (client.hasOlderLocalChunks(roomId) || Boolean(nextBackfillTargetForScrollUp(client.rooms()[roomId])))
    ) {
      setBackfillTick((value) => value + 1);
    }
  });

  useLayoutEffect(() => {
    const container = timelineRef.current;
    if (!visibleComposerRoomId || !container || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      syncTimelineResize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [visibleComposerRoomId]);

  useLayoutEffect(() => {
    if (!visibleComposerRoomId || !activeTopic || activeTopic.roomId !== visibleComposerRoomId) {
      lastLandedRoomRef.current = null;
      awaitingReadPosLandingRoomRef.current = null;
      pendingScrollPreserveRef.current = null;
      isAtBottomRef.current = true;
      prevTimelineKeyRef.current = "";
      prevTimelineClientHeightRef.current = null;
      return;
    }
    const container = timelineRef.current;
    if (!container) {
      return;
    }
    const shouldWaitForBackfill =
      activeTopic.needsReadGapBackfill &&
      (client.needsLocalChunksForReadPosition(visibleComposerRoomId) ||
        (!reauthRequired && Boolean(nextBackfillTargetForReadPosition(rooms[visibleComposerRoomId])))) &&
      !openBackfillStoppedRoomsRef.current.has(visibleComposerRoomId);

    const pendingJump = pendingJumpRequestRef.current;
    if (pendingJump && pendingJump.roomId === visibleComposerRoomId) {
      const targetEl = Array.from(
        container.querySelectorAll<HTMLElement>("[data-event-id]"),
      ).find((el) => el.dataset.eventId === pendingJump.eventId);
      if (targetEl) {
        pendingJumpRequestRef.current = null;
        lastLandedRoomRef.current = visibleComposerRoomId;
        awaitingReadPosLandingRoomRef.current = null;
        pendingScrollPreserveRef.current = null;
        const containerRect = container.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        if (containerRect.height > 0 && targetRect.height > 0) {
          const desiredTop =
            container.scrollTop +
            (targetRect.top - containerRect.top) -
            Math.max(0, (container.clientHeight - targetRect.height) / 3);
          setTimelineScrollTop(
            container,
            maxScroll > 0 ? Math.max(0, Math.min(desiredTop, maxScroll)) : Math.max(0, desiredTop),
          );
        } else if (container.clientHeight > 0) {
          setTimelineScrollTop(
            container,
            Math.max(0, Math.min(targetEl.offsetTop, maxScroll)),
          );
        }
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        isAtBottomRef.current = distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX;
        prevTimelineKeyRef.current = timelineContentKey;
        prevTimelineClientHeightRef.current = container.clientHeight;
        onFavoriteJumpLanded(pendingJump.eventId, distanceFromBottom > 60);
        syncHeaderElevation(container);
        evaluateVisibleReadPosition(visibleComposerRoomId);
        return;
      }
    }
    if (lastLandedRoomRef.current !== visibleComposerRoomId) {
      lastLandedRoomRef.current = visibleComposerRoomId;
      if (shouldWaitForBackfill) {
        awaitingReadPosLandingRoomRef.current = visibleComposerRoomId;
      } else {
        awaitingReadPosLandingRoomRef.current = null;
        landTimelineScroll(container, activeTopic.firstUnreadEventId);
      }
      prevTimelineKeyRef.current = timelineContentKey;
      prevTimelineClientHeightRef.current = container.clientHeight;
    } else if (
      awaitingReadPosLandingRoomRef.current === visibleComposerRoomId &&
      !shouldWaitForBackfill
    ) {
      awaitingReadPosLandingRoomRef.current = null;
      const pending = pendingScrollPreserveRef.current;
      pendingScrollPreserveRef.current = null;
      if (userScrolledRoomRef.current !== visibleComposerRoomId) {
        landTimelineScroll(container, activeTopic.firstUnreadEventId);
      } else if (pending?.roomId === visibleComposerRoomId) {
        const delta = container.scrollHeight - pending.prevScrollHeight;
        setTimelineScrollTop(container, Math.max(0, pending.prevScrollTop + delta));
        isAtBottomRef.current =
          container.scrollHeight - container.scrollTop - container.clientHeight <=
          AT_BOTTOM_THRESHOLD_PX;
      }
      prevTimelineKeyRef.current = timelineContentKey;
      prevTimelineClientHeightRef.current = container.clientHeight;
    } else if (pendingScrollPreserveRef.current?.roomId === visibleComposerRoomId) {
      const pending = pendingScrollPreserveRef.current;
      pendingScrollPreserveRef.current = null;
      const delta = container.scrollHeight - pending.prevScrollHeight;
      setTimelineScrollTop(container, Math.max(0, pending.prevScrollTop + delta));
      isAtBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight <=
        AT_BOTTOM_THRESHOLD_PX;
      prevTimelineKeyRef.current = timelineContentKey;
      prevTimelineClientHeightRef.current = container.clientHeight;
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
      prevTimelineClientHeightRef.current = container.clientHeight;
    } else {
      syncTimelineHeightAnchor(container, visibleComposerRoomId);
    }
    syncHeaderElevation(container);
    evaluateVisibleReadPosition(visibleComposerRoomId);
  });
  async function handleSelectAttachment(roomId: string, file: File) {
    if (reauthRequiredRef.current) {
      return;
    }
    const seq = (attachmentSeqRef.current[roomId] ?? 0) + 1;
    attachmentSeqRef.current[roomId] = seq;
    const task = (async () => {
      let data: Uint8Array;
      try {
        data = await readFileBytes(file);
      } catch {
        return;
      }
      if (attachmentSeqRef.current[roomId] !== seq || reauthRequiredRef.current) {
        return;
      }
      const attachmentMeta: AttachmentMeta = {
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: data.byteLength,
      };
      const latestText = draftsByRoomRef.current[roomId]?.text ?? "";
      const hadPending = draftManager.hasPending(roomId);
      const attSeq = draftManager.cancel(roomId);
      let assigned: { attachmentId: string; attachmentMeta: AttachmentMeta } | undefined;
      try {
        assigned = await client.setDraftAttachment(roomId, attachmentMeta, data, {
          text: latestText,
        });
      } catch {
        if (
          (hadPending || latestText.trim() !== "") &&
          draftManager.currentSeq(roomId) === attSeq
        ) {
          draftManager.restorePending(roomId, latestText, attSeq);
        }
        if (mountedRef.current && attachmentSeqRef.current[roomId] === seq) {
          setComposerError("本地存储空间不足，消息未发送");
        }
        return;
      }
      if (!mountedRef.current || !assigned) {
        return;
      }
      if (attachmentSeqRef.current[roomId] !== seq) {
        void client.setDraftAttachment(roomId, undefined).catch(() => undefined);
        return;
      }
      commitDraftsState((prev) => {
        const currentText = prev[roomId]?.text;
        return {
          ...prev,
          [roomId]: {
            ...(currentText !== undefined && currentText !== "" ? { text: currentText } : {}),
            attachmentId: assigned.attachmentId,
            attachmentMeta: assigned.attachmentMeta,
          },
        };
      });
      setComposerError(undefined);
    })();
    inFlightAttachmentSelectRef.current[roomId] = task;
    try {
      await task;
    } finally {
      if (inFlightAttachmentSelectRef.current[roomId] === task) {
        delete inFlightAttachmentSelectRef.current[roomId];
      }
    }
  }

  function handleRemoveAttachment(roomId: string) {
    if (reauthRequiredRef.current) {
      return;
    }
    attachmentSeqRef.current[roomId] = (attachmentSeqRef.current[roomId] ?? 0) + 1;
    const existingText = draftsByRoomRef.current[roomId]?.text ?? "";
    draftManager.cancel(roomId);
    const hasText = existingText !== "";
    const nextDraft: DraftRecord | undefined = hasText ? { text: existingText } : undefined;
    commitDraftsState((prev) => {
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
    void client
      .setDraftAttachment(roomId, undefined, undefined, { text: existingText })
      .catch(() => {
        if (mountedRef.current) {
          const committed = client.draft(roomId);
          commitDraftsState((prev) => {
            const next = { ...prev };
            if (committed) {
              next[roomId] = committed;
            } else {
              delete next[roomId];
            }
            return next;
          });
        }
      });
  }

  function updateDraftText(roomId: string, text: string) {
    if (reauthRequiredRef.current) {
      return;
    }
    commitDraftsState((prev) => {
      const existing = prev[roomId];
      const next = { ...prev };
      if (text !== "" || (existing?.attachmentId && existing?.attachmentMeta)) {
        next[roomId] = {
          ...(text !== "" ? { text } : {}),
          ...(existing?.attachmentId && existing?.attachmentMeta
            ? {
                attachmentId: existing.attachmentId,
                attachmentMeta: existing.attachmentMeta,
              }
            : {}),
        };
      } else {
        delete next[roomId];
      }
      return next;
    });
    if (composerError) {
      setComposerError(undefined);
    }
    draftManager.scheduleText(roomId, text);
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

  function getLocalImageUrl(attachmentId: string): string | undefined {
    return localMediaUrlCacheRef.current.get(attachmentId)?.url;
  }

  const loadMissingLocalImages = useEffectEvent(() => {
    if (exiting) {
      return;
    }
    for (const item of activeTimelineItems) {
      if (
        item.kind !== "message" ||
        !item.media ||
        item.media.kind !== "image" ||
        !item.media.localAttachment
      ) {
        continue;
      }
      const { attachmentId, mimeType } = item.media.localAttachment;
      if (
        localMediaUrlCacheRef.current.has(attachmentId) ||
        loadingLocalMediaRef.current.has(attachmentId)
      ) {
        continue;
      }
      loadingLocalMediaRef.current.add(attachmentId);
      void client
        .loadBlob(attachmentId)
        .then((blob) => {
          if (!mountedRef.current || !blob) {
            return;
          }
          if (!localMediaUrlCacheRef.current.has(attachmentId)) {
            const created = createRenderableMediaUrl(
              blob.data,
              mimeType || blob.mimeType || "image/png",
            );
            localMediaUrlCacheRef.current.set(attachmentId, created);
            setMediaRevision((value) => value + 1);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          loadingLocalMediaRef.current.delete(attachmentId);
        });
    }
  });

  useEffect(() => {
    loadMissingLocalImages();
  }, [timelineContentKey, visibleComposerRoomId, client, exiting]);

  useEffect(() => {
    const localCache = localMediaUrlCacheRef.current;
    const downloadedCache = downloadedMediaCacheRef.current;
    return () => {
      for (const entry of localCache.values()) {
        entry.revoke?.();
      }
      localCache.clear();
      for (const entry of downloadedCache.values()) {
        entry.revoke?.();
      }
      downloadedCache.clear();
    };
  }, []);

  const downloadMissingMedia = useEffectEvent(() => {
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
            onCredentialRejected();
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
  });

  useEffect(() => {
    downloadMissingMedia();
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
        const blob = await client.loadBlob(media.localAttachment.attachmentId);
        if (blob) {
          await invokePlatformOpenMedia({
            data: new Uint8Array(blob.data),
            mimeType: media.mimeType || blob.mimeType || media.localAttachment.mimeType,
            filename: media.filename,
          });
          return;
        }
        if (!media.mxcUrl) {
          showToastNotice("打开附件失败，请重试。");
          return;
        }
      } catch (error) {
        showToastNotice(formatOpenMediaError(error));
        return;
      }
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
      } catch (error) {
        showToastNotice(formatOpenMediaError(error));
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
    } catch (error) {
      showToastNotice(formatOpenMediaError(error));
    }
  }

  function buildAttachmentEventContent(
    attachment: AttachmentMeta,
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

  function restorePendingDraftOnSendFailure(roomId: string, text: string, expectedSeq: number) {
    if (
      text.trim() !== "" &&
      draftManager.currentSeq(roomId) === expectedSeq &&
      client.draft(roomId)?.text !== text
    ) {
      draftManager.restorePending(roomId, text, expectedSeq);
    }
  }

  async function sendComposerAttachmentMessage(
    roomId: string,
    attachmentId: string,
    attachmentMeta: AttachmentMeta,
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
    const sendSeq = draftManager.cancel(roomId);
    try {
      const content = buildAttachmentEventContent(attachmentMeta, captionText);
      await client.enqueueRoomEvent(roomId, "m.room.message", content, {
        clearDraft: true,
        attachmentId,
        attachmentMeta,
      });
      attachmentSeqRef.current[roomId] = (attachmentSeqRef.current[roomId] ?? 0) + 1;
      draftManager.bumpSeq(roomId);
      commitDraftsState((prev) => {
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
      restorePendingDraftOnSendFailure(roomId, captionText, sendSeq);
      setComposerError("本地存储空间不足，消息未发送");
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
      const attachments: Array<{
        attachmentId: string;
        attachmentMeta: AttachmentMeta;
        data: Uint8Array;
      }> = [];
      for (const file of files) {
        const data = await readFileBytes(file);
        attachments.push({
          attachmentId: generateAttachmentId(),
          attachmentMeta: {
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: data.byteLength,
          },
          data,
        });
      }
      const initialCaption = draftsByRoomRef.current[roomId]?.text ?? "";
      const sendSeq = draftManager.cancel(roomId);
      try {
        for (let i = 0; i < attachments.length; i += 1) {
          const attachment = attachments[i]!;
          const captionForItem = i === 0 && initialCaption.trim() !== "" ? initialCaption : "";
          const content = buildAttachmentEventContent(attachment.attachmentMeta, captionForItem);
          await client.enqueueRoomEvent(roomId, "m.room.message", content, {
            clearDraft: i === attachments.length - 1,
            attachmentId: attachment.attachmentId,
            attachmentMeta: attachment.attachmentMeta,
            attachmentData: attachment.data,
          });
        }
        attachmentSeqRef.current[roomId] = (attachmentSeqRef.current[roomId] ?? 0) + 1;
        draftManager.bumpSeq(roomId);
        commitDraftsState((prev) => {
          if (!(roomId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[roomId];
          return next;
        });
        setRevision((value) => value + 1);
        void retryQueue.flush();
      } catch (err) {
        restorePendingDraftOnSendFailure(roomId, initialCaption, sendSeq);
        throw err;
      }
    } catch {
      setRevision((value) => value + 1);
      setComposerError("本地存储空间不足，消息未发送");
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
    const sendSeq = draftManager.cancel(roomId);
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
      attachmentSeqRef.current[roomId] = (attachmentSeqRef.current[roomId] ?? 0) + 1;
      draftManager.bumpSeq(roomId);
      commitDraftsState((prev) => {
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
      restorePendingDraftOnSendFailure(roomId, body, sendSeq);
      setComposerError("本地存储空间不足，消息未发送");
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
    const pendingSelect = inFlightAttachmentSelectRef.current[roomId];
    if (pendingSelect) {
      await pendingSelect;
    }
    const draft = draftsByRoomRef.current[roomId];
    const body = draft?.text ?? "";
    if (draft?.attachmentId && draft?.attachmentMeta) {
      await sendComposerAttachmentMessage(roomId, draft.attachmentId, draft.attachmentMeta, body);
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
    if (draft?.attachmentId || draft?.text !== "/") {
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
        const failure = classifyLoginFailure(loginResult, "重新验证", "密码不正确");
        if (failure.clearPassword) {
          setReauthPassword("");
        }
        setReauthError(
          failure.message.includes("重试") ? failure.message : `${failure.message}请重试。`,
        );
        return;
      }
      if (session.userId !== expectedUserId) {
        setReauthError("登录账号与当前设备不一致，请使用原账号验证。");
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

  useEffect(() => {
    return () => {
      if (focusViewportRafRef.current !== undefined && typeof window !== "undefined") {
        window.cancelAnimationFrame(focusViewportRafRef.current);
        focusViewportRafRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (safeInset === 0 && !isNarrow) {
      return undefined;
    }
    return installViewportScrollLock();
  }, [safeInset, isNarrow]);

  useLayoutEffect(() => {
    if (safeInset > 0) {
      resetRootViewportOffset();
    }
  }, [safeInset]);
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
  useEffect(() => {
    const container = detailContainerRef.current;
    if (!container) return;
    const preventVerticalScrollWhenSwiping = (event: TouchEvent) => {
      if (edgeSwipeTrackingRef.current?.engaged && event.cancelable) {
        event.preventDefault();
      }
    };
    container.addEventListener("touchmove", preventVerticalScrollWhenSwiping, {
      passive: false,
    });
    return () => {
      container.removeEventListener("touchmove", preventVerticalScrollWhenSwiping);
    };
  }, [showDetail, isNarrow, narrowPageKey]);

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
        nestedModalOpen={pendingDiscardAction !== null}
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
        onRequestExit={(action) => requestGuardedExit(settingsIsDirty, action)}
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
        nestedModalOpen={exitConfirmOpen || pendingDiscardAction !== null}
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
        onRequestExit={(action) => requestGuardedExit(createIsDirty, action)}
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
        isDirty={editIsDirty}
        safeInset={safeInset}
        nestedModalOpen={exitConfirmOpen || pendingDiscardAction !== null}
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
        onRequestExit={(action) => requestGuardedExit(editIsDirty, action)}
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
          elevated={headerElevated}
          topic={activeTopic}
          descriptionExpanded={descriptionExpanded}
          overflowMenuOpen={overflowMenuOpen && safeInset === 0}
          overflowMenuRef={overflowMenuRef}
          editing={editing}
          editSubmitting={editSubmitting}
          deleteConfirmOpen={deleteConfirmOpen}
          deleting={deleting}
          reauthRequired={reauthRequired}
          pinPending={Boolean(pinPendingByRoom[roomId])}
          favoriteCount={activeFavorites.items.length}
          onGoBack={goBack}
          onOpenFavorites={() => {
            setOverflowMenuOpen(false);
            setFavoritesOpen(true);
          }}
          onToggleDescription={() =>
            setDescriptionExpanded((expanded) => !expanded)
          }
          onToggleOverflowMenu={() => {
            if (safeInset === 0) {
              setOverflowMenuOpen((prev) => !prev);
            }
          }}
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
            className="waypoint-unavailable-banner touch-none flex shrink-0 items-center gap-2 border-b border-warning-border bg-warning px-5 py-2.5 text-sm font-medium text-warning-foreground"
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
        {deleteMessageTarget !== null ? (
          <DeleteMessageDialog
            deleting={deletingMessage}
            onConfirm={() => void confirmDeleteMessage()}
            onCancel={() => {
              if (!deletingMessage) {
                setDeleteMessageTarget(null);
              }
            }}
          />
        ) : null}
        {favoritesOpen ? (
          <TopicFavoritesDialog
            open
            items={activeFavorites.items}
            botDisplayName={activeTopic.botDisplayName}
            nowMs={nowMs}
            pendingEventIds={activeFavoritePendingEventIds}
            onClose={() => setFavoritesOpen(false)}
            onSelectFavorite={(eventId) =>
              void handleSelectFavoriteJump(roomId, eventId)
            }
            onRemoveFavorite={(favItem) =>
              void handleRemoveFavoriteFromDialog(roomId, favItem)
            }
          />
        ) : null}
        <main
          className="waypoint-timeline-container m-0 box-border flex min-h-0 w-full max-w-none flex-1 flex-col overflow-hidden bg-background p-0 transition-[padding-bottom] duration-280 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
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
              responding={activeTopic.responding}
              isNarrow={isNarrow}
              safeInset={safeInset}
              activeTopicUnavailable={activeTopic.unavailable}
              reauthRequired={reauthRequired}
              openFailedMenuId={openFailedMenuId}
              favoritedEventIds={activeFavorites.favoritedEventIds}
              favoritePendingEventIds={activeFavoritePendingEventIds}
              highlightedEventId={highlightedEventId}
              getLocalImageUrl={getLocalImageUrl}
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
              onToggleFavorite={(item) => void handleToggleFavorite(roomId, item)}
              onRequestDeleteMessage={(item) =>
                handleRequestDeleteMessage(roomId, item)
              }
              onSelectPromptOption={(eventId, optionKey) =>
                void handleSelectPromptOption(roomId, eventId, optionKey)
              }
              onCopyFeedback={showToastNotice}
              onContextMenuOpenChange={setMessageContextMenuOpen}
              onRegisterContextMenuDismiss={(dismiss) => {
                dismissContextMenuRef.current = dismiss;
              }}
            />
            <ComposerView
              safeInset={safeInset}
              showScrollBottomFab={showScrollBottomFab}
              composerMultiline={composerMultiline}
              composerTextareaScrollable={composerTextareaScrollable}
              composerError={composerError}
              activeTopicUnavailable={activeTopic.unavailable}
              reauthRequired={reauthRequired}
              persistingSend={persistingSend}
              draftAttachmentName={currentDraft?.attachmentMeta?.name ?? currentDraft?.attachment?.name}
              hasDraftAttachment={Boolean((currentDraft?.attachmentId && currentDraft?.attachmentMeta) || currentDraft?.attachment)}
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
              onFocusTextarea={() => {
                setOverflowMenuOpen(false);
                resetRootViewportOffset();
                if (
                  typeof window !== "undefined" &&
                  typeof window.requestAnimationFrame === "function"
                ) {
                  if (focusViewportRafRef.current !== undefined) {
                    window.cancelAnimationFrame(focusViewportRafRef.current);
                  }
                  focusViewportRafRef.current = window.requestAnimationFrame(() => {
                    focusViewportRafRef.current = undefined;
                    resetRootViewportOffset();
                  });
                }
              }}
              onBlurTextarea={() => {
                void draftManager.flush(roomId);
              }}
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
      className="waypoint-workspace flex h-full w-full flex-col overflow-hidden bg-background text-foreground"
      data-viewport={viewportMode}
      style={{ "--keyboard-inset": `${safeInset}px` } as CSSProperties}
    >
      {syncStorageWarning ? (
        <div
          role="status"
          aria-live="polite"
          className="waypoint-sync-storage-warning touch-none flex shrink-0 items-center gap-2 border-b border-warning-border bg-warning px-4 py-2 text-sm font-medium text-warning-foreground"
        >
          本地存储空间不足，已暂停接收新消息
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {showSidebar ? (
        <SidebarView
          pageEnterClass={pageEnterClass}
          reauthRequired={reauthRequired}
          showDetail={showDetail}
          reauthBanner={reauthRequired && !showDetail ? renderReauthBanner() : null}
          topics={topics}
          activeTopicId={activeTopic?.roomId}
          nowMs={nowMs}
          isNarrow={isNarrow}
          onOpenSettings={openSettings}
          onOpenCreateForm={openCreateForm}
          onOpenTopic={openTopic}
        />
      ) : null}

      {showDetail ? (
        <div
          ref={detailContainerRef}
          key={isNarrow ? narrowPageKey : "wide"}
          className={cn(
            "waypoint-detail relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
            isNarrow && "w-full",
            isSwipingBack && "[&_.waypoint-timeline]:overflow-y-hidden [&>section]:overflow-y-hidden",
            pageEnterClass,
          )}
          style={{
            transform:
              isNarrow && swipeBackOffset > 0
                ? "translate3d(" + swipeBackOffset + "px, 0, 0)"
                : undefined,
            transition:
              isNarrow && !isSwipingBack
                ? "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)"
                : undefined,
          }}
          data-swiping-back={isSwipingBack ? "true" : undefined}
          data-swipe-offset={swipeBackOffset > 0 ? swipeBackOffset : undefined}
          onTouchStart={isNarrow && isNarrowPushed ? handleEdgeSwipeTouchStart : undefined}
          onTouchMove={isNarrow && isNarrowPushed ? handleEdgeSwipeTouchMove : undefined}
          onTouchEnd={isNarrow && isNarrowPushed ? handleEdgeSwipeTouchEnd : undefined}
          onTouchCancel={isNarrow && isNarrowPushed ? handleEdgeSwipeTouchEnd : undefined}
        >
          <ErrorBoundary
            resetKeys={[activeTopic?.roomId, settingsOpen, creating, editing]}
            title="Topic 视图出现意外错误"
            description={
              isNarrow
                ? "当前 Topic 的内容渲染遇到意外错误，你可以尝试重试或重新加载应用。"
                : "当前 Topic 的内容渲染遇到意外错误，你可以尝试重试或切换到其他 Topic。"
            }
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
          </ErrorBoundary>
        </div>
      ) : null}
      </div>
      <DiscardChangesDialog
        open={pendingDiscardAction !== null}
        onConfirmDiscard={() => {
          const action = pendingDiscardAction;
          setPendingDiscardAction(null);
          action?.();
        }}
        onCancelDiscard={() => {
          setPendingDiscardAction(null);
        }}
      />
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

function formatOpenMediaError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("NO_VIEWER_APP")) {
    return "未找到可打开该附件的应用，请先安装对应的查看器后再试。";
  }
  return "打开附件失败，请重试。";
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
