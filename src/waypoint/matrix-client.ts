import type { HomeserverTransport, TransportResult } from "../adapters/types";
import { isCredentialRejected } from "./matrix-errors";
import {
  dropCredential,
  dropPreListSession,
  generateAttachmentId,
  loadBlob,
  loadV2Snapshot,
  pruneOrphanBlobs,
  replacePendingEvent,
  resetSessionStores,
  saveConfirmedEvent,
  saveDiscardFailedEvent,
  saveDraftInStore,
  saveEnqueuedEvent,
  saveFailedEvent,
  saveLeftRoomRemoval,
  saveMeta,
  saveReadMarkerConfirmation,
  saveResendEvent,
  saveRoomAndTimeline,
  saveRoomMeta,
  saveRoomMetaAndReadMarker,
  saveSyncBatch,
  saveUploadedMediaUrl,
  type AttachmentMeta,
  type BlobRecord,
  type DraftAttachment,
  type DraftRecord,
  type PendingReadMarker,
  type PendingRoomEvent,
  type RawMatrixEvent,
  type SessionMeta,
  type StoredRoomEvents,
  type StoredRoomMeta,
  type StoredTimelineGap,
} from "./session-store";

const MAX_SYNC_TIMELINE_EVENTS_PER_ROOM = 20;
export const BACKFILL_PAGE_LIMIT = 50;

export type SyncAttempt = {
  result: TransportResult;
  incremental: boolean;
  leaveGeneration?: number;
  tagGeneration?: number;
};

export type LocalMessageStatus = "unconfirmed" | "failed";

export type WaypointLocalMeta = {
  id: string;
  status: LocalMessageStatus;
  txnId: string;
  attachmentId?: string;
  attachmentMeta?: AttachmentMeta;
};

export class MatrixClient {
  private baseUrl = "";
  private userId = "";
  private accessToken?: string;
  private deviceId?: string;
  private syncCursor?: string;
  private storedAccountData: Record<string, unknown> = {};
  private storedRooms: Record<string, StoredRoomEvents> = {};
  private storedPendingEvents: PendingRoomEvent[] = [];
  private storedPendingReadMarkers: PendingReadMarker[] = [];
  private storedDrafts: Record<string, DraftRecord> = {};
  private txnCounter = 0;
  private pendingOrderSeq = 0;
  private leaveGeneration = 0;
  private tokenGeneration = 0;
  private credentialRejectedHandler?: (result: TransportResult) => void;
  private leftAtGeneration = new Map<string, number>();
  private tagGeneration = 0;
  private tagUpdatedAtGeneration = new Map<string, number>();
  private optimisticReadPositions = new Map<string, string>();
  private persistTail: Promise<void> = Promise.resolve();
  private persistActiveCount = 0;

  constructor(private readonly transport: HomeserverTransport) {}

  get address(): string {
    return this.baseUrl;
  }

  get ownerId(): string {
    return this.userId;
  }

  get hasToken(): boolean {
    return Boolean(this.accessToken);
  }

  get hasSyncCursor(): boolean {
    return Boolean(this.syncCursor);
  }

  get currentDeviceId(): string | undefined {
    return this.deviceId;
  }

  setCredentialRejectedHandler(handler?: (result: TransportResult) => void): void {
    this.credentialRejectedHandler = handler;
  }

  resetInMemoryForDatabaseReset(preserveAddress = true): void {
    this.tokenGeneration += 1;
    this.optimisticReadPositions.clear();
    if (!preserveAddress) {
      this.baseUrl = "";
      this.userId = "";
    }
    this.accessToken = undefined;
    this.deviceId = undefined;
    this.syncCursor = undefined;
    this.storedAccountData = {};
    this.storedRooms = {};
    this.storedPendingEvents = [];
    this.storedPendingReadMarkers = [];
    this.storedDrafts = {};
    this.pendingOrderSeq = 0;
    this.leaveGeneration = 0;
    this.leftAtGeneration.clear();
    this.tagGeneration = 0;
    this.tagUpdatedAtGeneration.clear();
  }

  loadBlob(attachmentId: string): Promise<BlobRecord | undefined> {
    return loadBlob(attachmentId);
  }

  accountData(type: string): unknown {
    return this.storedAccountData[type];
  }

  rooms(): Record<string, StoredRoomEvents> {
    if (this.optimisticReadPositions.size === 0) {
      return this.storedRooms;
    }
    let next: Record<string, StoredRoomEvents> | undefined;
    for (const [roomId, eventId] of this.optimisticReadPositions.entries()) {
      const room = this.storedRooms[roomId];
      if (!room || !canAdvanceReadPosition(room, eventId, room.readPositionEventId)) {
        continue;
      }
      if (!next) {
        next = { ...this.storedRooms };
      }
      next[roomId] = {
        ...room,
        readPositionEventId: eventId,
      };
    }
    return next ?? this.storedRooms;
  }

  draft(roomId: string): DraftRecord | undefined {
    const existing = this.storedDrafts[roomId];
    return existing ? cloneDraftRecord(existing) : undefined;
  }

  drafts(): Record<string, DraftRecord> {
    return cloneDrafts(this.storedDrafts);
  }

  async setDraft(
    roomId: string,
    draft: DraftRecord | undefined,
    blobData?: Uint8Array,
  ): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const existing = this.storedDrafts[roomId];
      const text =
        typeof draft?.text === "string" && draft.text.trim() !== "" ? draft.text : undefined;

      let attachmentId: string | undefined;
      let attachmentMeta: AttachmentMeta | undefined;
      let putBlob: BlobRecord | undefined;

      if (draft?.attachmentId && draft?.attachmentMeta) {
        attachmentId = draft.attachmentId;
        attachmentMeta = { ...draft.attachmentMeta };
        if (blobData) {
          putBlob = {
            id: attachmentId,
            name: attachmentMeta.name,
            mimeType: attachmentMeta.mimeType,
            size: attachmentMeta.size,
            data: new Uint8Array(blobData),
          };
        }
      } else if (draft?.attachment) {
        attachmentId = draft.attachmentId ?? generateAttachmentId();
        attachmentMeta = {
          name: draft.attachment.name,
          mimeType: draft.attachment.mimeType,
          size: draft.attachment.size,
        };
        putBlob = {
          id: attachmentId,
          name: attachmentMeta.name,
          mimeType: attachmentMeta.mimeType,
          size: attachmentMeta.size,
          data: new Uint8Array(draft.attachment.data),
        };
      }

      const normalized: DraftRecord | undefined =
        text !== undefined || (attachmentId && attachmentMeta)
          ? {
              ...(text !== undefined ? { text } : {}),
              ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
            }
          : undefined;

      if (!normalized && !existing) {
        return;
      }

      const nextDrafts = { ...this.storedDrafts };
      if (normalized) {
        nextDrafts[roomId] = normalized;
      } else {
        delete nextDrafts[roomId];
      }

      const deleteBlobIds: string[] = [];
      if (
        existing?.attachmentId &&
        existing.attachmentId !== attachmentId &&
        !isAttachmentReferenced(
          existing.attachmentId,
          nextDrafts,
          this.storedPendingEvents,
          this.storedRooms,
        )
      ) {
        deleteBlobIds.push(existing.attachmentId);
      }

      await saveDraftInStore({
        roomId,
        draft: normalized,
        putBlob,
        deleteBlobIds,
      });
      this.storedDrafts = nextDrafts;
    });
  }

  async setDraftText(
    roomId: string,
    text: string,
    options?: { commit?: boolean; isCurrent?: () => boolean },
  ): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken || (options?.isCurrent && !options.isCurrent())) {
        return;
      }
      const existing = this.storedDrafts[roomId];
      const nextText = text.trim() !== "" ? text : undefined;
      const nextDraft: DraftRecord | undefined =
        nextText !== undefined || (existing?.attachmentId && existing?.attachmentMeta)
          ? {
              ...(nextText !== undefined ? { text: nextText } : {}),
              ...(existing?.attachmentId && existing?.attachmentMeta
                ? {
                    attachmentId: existing.attachmentId,
                    attachmentMeta: { ...existing.attachmentMeta },
                  }
                : {}),
            }
          : undefined;

      if (!nextDraft && !existing) {
        return;
      }
      if (
        nextDraft &&
        existing &&
        nextDraft.text === existing.text &&
        nextDraft.attachmentId === existing.attachmentId
      ) {
        return;
      }

      const nextDrafts = { ...this.storedDrafts };
      if (nextDraft) {
        nextDrafts[roomId] = nextDraft;
      } else {
        delete nextDrafts[roomId];
      }

      await saveDraftInStore({
        roomId,
        draft: nextDraft,
        commit: options?.commit,
      });
      this.storedDrafts = nextDrafts;
    });
  }

  async setDraftAttachment(
    roomId: string,
    attachmentMeta: AttachmentMeta | undefined,
    blobData?: Uint8Array,
    options?: { text?: string; commit?: boolean },
  ): Promise<{ attachmentId: string; attachmentMeta: AttachmentMeta } | undefined> {
    let assigned: { attachmentId: string; attachmentMeta: AttachmentMeta } | undefined;
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const existing = this.storedDrafts[roomId];
      let attachmentId: string | undefined;
      let nextMeta: AttachmentMeta | undefined;
      let putBlob: BlobRecord | undefined;

      if (attachmentMeta && blobData) {
        attachmentId = generateAttachmentId();
        nextMeta = { ...attachmentMeta };
        putBlob = {
          id: attachmentId,
          name: nextMeta.name,
          mimeType: nextMeta.mimeType,
          size: nextMeta.size,
          data: new Uint8Array(blobData),
        };
      }

      const mergedText =
        options && "text" in options
          ? typeof options.text === "string" && options.text.trim() !== ""
            ? options.text
            : undefined
          : existing?.text;

      const nextDraft: DraftRecord | undefined =
        mergedText !== undefined || (attachmentId && nextMeta)
          ? {
              ...(mergedText !== undefined ? { text: mergedText } : {}),
              ...(attachmentId && nextMeta
                ? { attachmentId, attachmentMeta: nextMeta }
                : {}),
            }
          : undefined;

      if (!nextDraft && !existing) {
        return;
      }

      const nextDrafts = { ...this.storedDrafts };
      if (nextDraft) {
        nextDrafts[roomId] = nextDraft;
      } else {
        delete nextDrafts[roomId];
      }

      const deleteBlobIds: string[] = [];
      if (
        existing?.attachmentId &&
        existing.attachmentId !== attachmentId &&
        !isAttachmentReferenced(
          existing.attachmentId,
          nextDrafts,
          this.storedPendingEvents,
          this.storedRooms,
        )
      ) {
        deleteBlobIds.push(existing.attachmentId);
      }

      await saveDraftInStore({
        roomId,
        draft: nextDraft,
        putBlob,
        deleteBlobIds,
        commit: options?.commit,
      });
      this.storedDrafts = nextDrafts;
      if (attachmentId && nextMeta) {
        assigned = { attachmentId, attachmentMeta: nextMeta };
      }
    });
    return assigned;
  }

  pendingRoomEvents(roomId?: string): PendingRoomEvent[] {
    const filtered =
      roomId === undefined
        ? this.storedPendingEvents
        : this.storedPendingEvents.filter((event) => event.roomId === roomId);
    return filtered.map(clonePendingEvent);
  }

  pendingReadMarkers(roomId?: string): PendingReadMarker[] {
    const filtered =
      roomId === undefined
        ? this.storedPendingReadMarkers
        : this.storedPendingReadMarkers.filter((item) => item.roomId === roomId);
    return filtered.map((item) => ({ roomId: item.roomId, eventId: item.eventId }));
  }

  async restore(): Promise<"sync" | "password" | "address"> {
    const snapshot = await loadV2Snapshot();
    if (!snapshot.meta?.baseUrl) {
      try {
        await pruneOrphanBlobs(new Set());
      } catch {
        // best-effort orphan cleanup
      }
      return "address";
    }
    const meta = snapshot.meta;
    const rawRooms: Record<string, unknown> = {};
    for (const [roomId, roomMeta] of Object.entries(snapshot.rooms)) {
      rawRooms[roomId] = {
        ...roomMeta,
        timelineEvents: snapshot.timelines[roomId] ?? [],
      };
    }
    for (const [roomId, timelineEvents] of Object.entries(snapshot.timelines)) {
      if (!(roomId in rawRooms)) {
        rawRooms[roomId] = { stateEvents: [], timelineEvents };
      }
    }

    const restoredRooms = normalizeStoredRooms(rawRooms);
    const restoredPending = clonePendingEvents(snapshot.pendingEvents);
    const restoredMarkers = clonePendingReadMarkers(snapshot.pendingReadMarkers);
    const restoredDrafts = cloneDrafts(snapshot.drafts);

    const referencedIds = collectReferencedAttachmentIds(
      restoredDrafts,
      restoredPending,
      restoredRooms,
    );
    try {
      await pruneOrphanBlobs(referencedIds);
    } catch {
      // best-effort orphan cleanup
    }

    this.baseUrl = meta.baseUrl;
    this.userId = meta.userId;
    this.syncCursor = meta.syncCursor;
    this.storedAccountData = isAccountData(meta.accountData) ? meta.accountData : {};
    this.storedRooms = restoredRooms;
    this.storedPendingEvents = restoredPending;
    this.storedPendingReadMarkers = restoredMarkers;
    this.storedDrafts = restoredDrafts;

    let maxOrder = restoredPending.length;
    for (const item of restoredPending) {
      if (item.order !== undefined && item.order + 1 > maxOrder) {
        maxOrder = item.order + 1;
      }
    }
    this.pendingOrderSeq = maxOrder;

    if (meta.accessToken && meta.deviceId) {
      this.accessToken = meta.accessToken;
      this.deviceId = meta.deviceId;
      return "sync";
    }
    if (meta.userId) {
      return "password";
    }
    return "address";
  }

  versions(baseUrl: string): Promise<TransportResult> {
    this.baseUrl = baseUrl;
    return this.transport.request({
      method: "GET",
      url: matrixUrl(baseUrl, "/_matrix/client/versions"),
    });
  }

  loginFlows(): Promise<TransportResult> {
    return this.transport.request({
      method: "GET",
      url: matrixUrl(this.baseUrl, "/_matrix/client/v3/login"),
    });
  }

  passwordLogin(
    user: string,
    password: string,
    displayName: string,
    deviceId?: string,
  ): Promise<TransportResult> {
    return this.transport.request({
      method: "POST",
      url: matrixUrl(this.baseUrl, "/_matrix/client/v3/login"),
      headers: { "Content-Type": "application/json" },
      body: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password,
        initial_device_display_name: displayName,
        ...(deviceId ? { device_id: deviceId } : {}),
      },
    });
  }

  async completeReauth(accessToken: string, deviceId?: string): Promise<void> {
    await this.enqueuePersist(async () => {
      const nextDeviceId = deviceId ?? this.deviceId;
      await saveMeta(
        this.sessionMeta({
          accessToken,
          deviceId: nextDeviceId,
        }),
      );
      this.tokenGeneration += 1;
      this.accessToken = accessToken;
      if (deviceId) {
        this.deviceId = deviceId;
      }
    });
  }

  async rememberLogin(userId: string, accessToken: string, deviceId: string): Promise<void> {
    await this.enqueuePersist(async () => {
      await resetSessionStores({
        baseUrl: this.baseUrl,
        userId,
        accessToken,
        deviceId,
      });
      this.tokenGeneration += 1;
      this.optimisticReadPositions.clear();
      this.userId = userId;
      this.accessToken = accessToken;
      this.deviceId = deviceId;
      this.syncCursor = undefined;
      this.storedAccountData = {};
      this.storedRooms = {};
      this.storedPendingEvents = [];
      this.storedPendingReadMarkers = [];
      this.storedDrafts = {};
      this.pendingOrderSeq = 0;
      this.leaveGeneration = 0;
      this.leftAtGeneration.clear();
      this.tagGeneration = 0;
      this.tagUpdatedAtGeneration.clear();
    });
  }

  private authedRequest(input: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    body?: unknown;
    json?: boolean;
    contentType?: string;
    responseType?: "json" | "bytes";
    signal?: AbortSignal;
  }): Promise<TransportResult> {
    const requestToken = this.accessToken;
    if (!requestToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    if (input.signal?.aborted) {
      return Promise.resolve({ type: "failure", failure: { type: "aborted" } });
    }
    const generation = this.tokenGeneration;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${requestToken}`,
    };
    if (input.json) {
      headers["Content-Type"] = "application/json";
    } else if (input.contentType) {
      headers["Content-Type"] = input.contentType;
    }
    const requestPromise = this.transport.request({
      method: input.method,
      url: input.url,
      headers,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.responseType ? { responseType: input.responseType } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!input.signal) {
      return requestPromise.then((result) => {
        if (
          isCredentialRejected(result) &&
          this.tokenGeneration === generation &&
          this.accessToken === requestToken
        ) {
          this.credentialRejectedHandler?.(result);
        }
        return result;
      });
    }
    const signal = input.signal;
    requestPromise.catch(() => undefined);
    return new Promise<TransportResult>((resolve, reject) => {
      const onAbort = () => {
        resolve({ type: "failure", failure: { type: "aborted" } });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      requestPromise.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            resolve({ type: "failure", failure: { type: "aborted" } });
            return;
          }
          if (
            isCredentialRejected(result) &&
            this.tokenGeneration === generation &&
            this.accessToken === requestToken
          ) {
            this.credentialRejectedHandler?.(result);
          }
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            resolve({ type: "failure", failure: { type: "aborted" } });
            return;
          }
          reject(error);
        },
      );
    });
  }

  sync(options?: { signal?: AbortSignal }): Promise<SyncAttempt> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    const cursor = this.syncCursor;
    const generation = this.leaveGeneration;
    const tagGen = this.tagGeneration;
    const url = cursor
      ? `${matrixUrl(this.baseUrl, "/_matrix/client/v3/sync")}?since=${encodeURIComponent(cursor)}`
      : matrixUrl(this.baseUrl, "/_matrix/client/v3/sync");
    return this.authedRequest({ method: "GET", url, signal: options?.signal }).then((result) => ({
      result,
      incremental: Boolean(cursor),
      leaveGeneration: generation,
      tagGeneration: tagGen,
    }));
  }

  async dropSyncCursor(): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      await saveMeta(this.sessionMeta({ syncCursor: undefined }));
      this.syncCursor = undefined;
    });
  }

  async retainSync(attempt: SyncAttempt): Promise<void> {
    if (attempt.result.type !== "response" || attempt.result.status !== 200) {
      return;
    }
    const body = attempt.result.body;
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const nextAccountData = mergeAccountData(this.storedAccountData, body);
      const roomMerge = mergeSyncRooms(
        this.storedRooms,
        body,
        this.userId,
        attempt.leaveGeneration,
        this.leftAtGeneration,
        attempt.tagGeneration,
        this.tagUpdatedAtGeneration,
      );
      const pendingMerge = reconcilePendingWithSync(this.storedPendingEvents, body);
      const markerMerge = reconcilePendingReadMarkersWithSync(
        this.storedPendingReadMarkers,
        roomMerge.rooms,
        body,
      );
      const draftMerge = reconcileDraftsWithSync(this.storedDrafts, body);
      const cursor = nextBatch(body);
      const nextCursor = cursor ?? this.syncCursor;

      const candidateDeleteBlobs = new Set<string>([
        ...roomMerge.removedAttachmentIds,
        ...pendingMerge.removedAttachmentIds,
        ...draftMerge.removedAttachmentIds,
      ]);
      const deleteBlobIds = Array.from(candidateDeleteBlobs).filter(
        (id) =>
          !isAttachmentReferenced(
            id,
            draftMerge.drafts,
            pendingMerge.pending,
            roomMerge.rooms,
          ),
      );

      const metaChanged =
        nextAccountData !== this.storedAccountData || nextCursor !== this.syncCursor;

      await saveSyncBatch({
        ...(metaChanged
          ? {
              meta: this.sessionMeta({
                syncCursor: nextCursor,
                accountData: nextAccountData,
              }),
            }
          : {}),
        putRooms: roomMerge.metaChangedRoomIds.map((roomId) => [
          roomId,
          extractRoomMeta(roomMerge.rooms[roomId]!),
        ]),
        deleteRoomIds: roomMerge.deletedRoomIds,
        putTimelines: roomMerge.timelineChangedRoomIds.map((roomId) => [
          roomId,
          roomMerge.rooms[roomId]!.timelineEvents,
        ]),
        deletePendingTxnIds: pendingMerge.deletedTxnIds,
        deleteReadMarkerRoomIds: markerMerge.deletedRoomIds,
        deleteDraftRoomIds: draftMerge.deletedRoomIds,
        deleteBlobIds,
      });

      this.storedAccountData = nextAccountData;
      this.storedRooms = roomMerge.rooms;
      for (const roomId of Array.from(this.optimisticReadPositions.keys())) {
        if (!(roomId in this.storedRooms)) {
          this.optimisticReadPositions.delete(roomId);
        }
      }
      this.storedPendingEvents = pendingMerge.pending;
      this.storedPendingReadMarkers = markerMerge.markers;
      this.storedDrafts = draftMerge.drafts;
      if (cursor) {
        this.syncCursor = cursor;
      }
    });
  }

  roomMessagesBackward(
    roomId: string,
    fromToken: string,
    limit = BACKFILL_PAGE_LIMIT,
  ): Promise<TransportResult> {
    const query = `dir=b&limit=${limit}&from=${encodeURIComponent(fromToken)}`;
    return this.authedRequest({
      method: "GET",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${query}`,
      ),
    });
  }

  async applyBackfillPage(
    roomId: string,
    options: {
      fromToken: string;
      body: unknown;
      gapIndex?: number;
      leaveGeneration?: number;
    },
  ): Promise<{ prependedCount: number; reachedStart: boolean; hasReadPosition: boolean }> {
    let outcome = { prependedCount: 0, reachedStart: false, hasReadPosition: false };
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      if (
        options.leaveGeneration !== undefined &&
        (this.leftAtGeneration.get(roomId) ?? 0) > options.leaveGeneration
      ) {
        return;
      }
      const room = this.storedRooms[roomId];
      if (!room) {
        return;
      }
      const applied = applyRoomBackfillPage(room, options.fromToken, options.body, options.gapIndex);
      if (!applied.changed) {
        outcome = {
          prependedCount: 0,
          reachedStart: Boolean(room.reachedStart),
          hasReadPosition:
            room.readPositionEventId !== undefined &&
            timelineIndexOf(room.timelineEvents, room.readPositionEventId) !== -1,
        };
        return;
      }
      await saveRoomAndTimeline(
        roomId,
        extractRoomMeta(applied.room),
        applied.room.timelineEvents,
      );
      this.storedRooms = {
        ...this.storedRooms,
        [roomId]: applied.room,
      };
      outcome = {
        prependedCount: applied.prependedCount,
        reachedStart: Boolean(applied.room.reachedStart),
        hasReadPosition:
          applied.room.readPositionEventId !== undefined &&
          timelineIndexOf(applied.room.timelineEvents, applied.room.readPositionEventId) !== -1,
      };
    });
    return outcome;
  }

  get currentLeaveGeneration(): number {
    return this.leaveGeneration;
  }

  getAccountData(type: string): Promise<TransportResult> {
    if (!this.accessToken || !this.userId) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.authedRequest({
      method: "GET",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent(type)}`,
      ),
    });
  }

  putAccountData(type: string, content: unknown): Promise<TransportResult> {
    if (!this.accessToken || !this.userId) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.authedRequest({
      method: "PUT",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent(type)}`,
      ),
      json: true,
      body: content,
    });
  }

  async retainAccountData(type: string, content: unknown): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const nextAccountData = { ...this.storedAccountData, [type]: content };
      await saveMeta(this.sessionMeta({ accountData: nextAccountData }));
      this.storedAccountData = nextAccountData;
    });
  }

  createRoom(body: Record<string, unknown>): Promise<TransportResult> {
    return this.authedRequest({
      method: "POST",
      url: matrixUrl(this.baseUrl, "/_matrix/client/v3/createRoom"),
      json: true,
      body,
    });
  }

  getRoomStateEvent(
    roomId: string,
    eventType: string,
    stateKey = "",
  ): Promise<TransportResult> {
    const basePath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}`;
    const path = stateKey === "" ? basePath : `${basePath}/${encodeURIComponent(stateKey)}`;
    return this.authedRequest({
      method: "GET",
      url: matrixUrl(this.baseUrl, path),
    });
  }

  putRoomTag(
    roomId: string,
    tag: string,
    content: Record<string, unknown>,
  ): Promise<TransportResult> {
    if (!this.accessToken || !this.userId) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.authedRequest({
      method: "PUT",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/rooms/${encodeURIComponent(roomId)}/tags/${encodeURIComponent(tag)}`,
      ),
      json: true,
      body: content,
    });
  }

  deleteRoomTag(roomId: string, tag: string): Promise<TransportResult> {
    if (!this.accessToken || !this.userId) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.authedRequest({
      method: "DELETE",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/rooms/${encodeURIComponent(roomId)}/tags/${encodeURIComponent(tag)}`,
      ),
    });
  }

  async retainRoomTag(
    roomId: string,
    tag: string,
    content: Record<string, unknown> | undefined,
  ): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const existing = this.storedRooms[roomId];
      if (!existing) {
        return;
      }
      const nextTags: Record<string, unknown> = isPlainObject(existing.tags)
        ? { ...existing.tags }
        : {};
      if (content !== undefined) {
        nextTags[tag] = cloneValue(content);
      } else {
        delete nextTags[tag];
      }
      const nextRoom: StoredRoomEvents = {
        ...existing,
      };
      if (Object.keys(nextTags).length > 0) {
        nextRoom.tags = nextTags;
      } else {
        delete nextRoom.tags;
      }
      await saveRoomMeta(roomId, extractRoomMeta(nextRoom));
      this.tagGeneration += 1;
      this.tagUpdatedAtGeneration.set(roomId, this.tagGeneration);
      this.storedRooms = {
        ...this.storedRooms,
        [roomId]: nextRoom,
      };
    });
  }

  putRoomStateEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    stateKey = "",
  ): Promise<TransportResult> {
    const basePath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}`;
    const path = stateKey === "" ? basePath : `${basePath}/${encodeURIComponent(stateKey)}`;
    return this.authedRequest({
      method: "PUT",
      url: matrixUrl(this.baseUrl, path),
      json: true,
      body: content,
    });
  }

  leaveRoom(roomId: string): Promise<TransportResult> {
    return this.authedRequest({
      method: "POST",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      ),
      json: true,
      body: {},
    });
  }

  async removeLeftRoom(roomId: string): Promise<void> {
    this.optimisticReadPositions.delete(roomId);
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const nextRooms = { ...this.storedRooms };
      const removedRoom = nextRooms[roomId];
      delete nextRooms[roomId];

      const removedPendingTxns: string[] = [];
      const candidateAttachmentIds = new Set<string>();
      const nextPending = this.storedPendingEvents.filter((item) => {
        if (item.roomId === roomId) {
          removedPendingTxns.push(item.txnId);
          if (item.attachmentId) {
            candidateAttachmentIds.add(item.attachmentId);
          }
          return false;
        }
        return true;
      });
      if (removedRoom) {
        for (const ev of removedRoom.timelineEvents) {
          const local = localPlaceholderOf(ev);
          if (local?.attachmentId) {
            candidateAttachmentIds.add(local.attachmentId);
          }
        }
      }
      const removedDraft = this.storedDrafts[roomId];
      if (removedDraft?.attachmentId) {
        candidateAttachmentIds.add(removedDraft.attachmentId);
      }

      const nextPendingReadMarkers = this.storedPendingReadMarkers.filter(
        (item) => item.roomId !== roomId,
      );
      const nextDrafts = { ...this.storedDrafts };
      delete nextDrafts[roomId];

      const deleteBlobIds = Array.from(candidateAttachmentIds).filter(
        (id) => !isAttachmentReferenced(id, nextDrafts, nextPending, nextRooms),
      );

      await saveLeftRoomRemoval({
        roomId,
        pendingTxnIds: removedPendingTxns,
        deleteBlobIds,
      });

      this.leaveGeneration += 1;
      this.leftAtGeneration.set(roomId, this.leaveGeneration);
      this.storedRooms = nextRooms;
      this.storedPendingEvents = nextPending;
      this.storedPendingReadMarkers = nextPendingReadMarkers;
      this.storedDrafts = nextDrafts;
    });
  }

  forgetRoom(roomId: string): Promise<TransportResult> {
    return this.authedRequest({
      method: "POST",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`,
      ),
      json: true,
      body: {},
    });
  }

  uploadMedia(
    data: Uint8Array,
    mimeType: string,
    filename: string,
  ): Promise<TransportResult> {
    const query = filename ? `?filename=${encodeURIComponent(filename)}` : "";
    return this.authedRequest({
      method: "POST",
      url: matrixUrl(this.baseUrl, `/_matrix/media/v3/upload${query}`),
      contentType: mimeType || "application/octet-stream",
      body: new Uint8Array(data),
    });
  }

  downloadMedia(mxcUri: string): Promise<TransportResult> {
    const parsed = parseMxcUri(mxcUri);
    if (!parsed) {
      return Promise.resolve({ type: "failure", failure: { type: "network" } });
    }
    return this.authedRequest({
      method: "GET",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v1/media/download/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`,
      ),
      responseType: "bytes",
    });
  }

  async recordUploadedMediaUrl(
    roomId: string,
    txnId: string,
    mxcUrl: string,
  ): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      let updatedPending: PendingRoomEvent | undefined;
      const nextPending = this.storedPendingEvents.map((item) => {
        if (item.roomId === roomId && item.txnId === txnId) {
          updatedPending = {
            ...clonePendingEvent(item),
            content: {
              ...(cloneValue(item.content) as Record<string, unknown>),
              url: mxcUrl,
            },
          };
          return updatedPending;
        }
        return item;
      });

      let nextRooms = this.storedRooms;
      let updatedTimeline: RawMatrixEvent[] | undefined;
      const room = this.storedRooms[roomId];
      if (room) {
        const placeholderIndex = room.timelineEvents.findIndex(
          (ev) => localPlaceholderOf(ev)?.txnId === txnId,
        );
        if (placeholderIndex !== -1) {
          const placeholder = room.timelineEvents[placeholderIndex];
          const existingContent = isPlainObject(placeholder.content) ? placeholder.content : {};
          const nextTimeline = [...room.timelineEvents];
          nextTimeline[placeholderIndex] = {
            ...placeholder,
            content: {
              ...existingContent,
              url: mxcUrl,
            },
          };
          updatedTimeline = nextTimeline;
          nextRooms = {
            ...this.storedRooms,
            [roomId]: {
              ...room,
              timelineEvents: nextTimeline,
            },
          };
        }
      }

      if (!updatedPending && !updatedTimeline) {
        return;
      }

      await saveUploadedMediaUrl({
        pendingEvent: updatedPending,
        roomId,
        timelineEvents: updatedTimeline,
      });
      this.storedPendingEvents = nextPending;
      this.storedRooms = nextRooms;
    });
  }

  async enqueueRoomEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
    options?: {
      clearDraft?: boolean;
      attachmentId?: string;
      attachmentMeta?: AttachmentMeta;
      attachmentData?: Uint8Array;
      attachment?: DraftAttachment;
    },
  ): Promise<PendingRoomEvent> {
    if (!this.accessToken || !this.userId) {
      throw new Error("没有 access token");
    }
    let created!: PendingRoomEvent;
    await this.enqueuePersist(async () => {
      if (!this.accessToken || !this.userId) {
        throw new Error("没有 access token");
      }

      let attachmentId = options?.attachmentId;
      let attachmentMeta = options?.attachmentMeta ? { ...options.attachmentMeta } : undefined;
      let putBlob: BlobRecord | undefined;

      if (attachmentId && attachmentMeta) {
        if (options?.attachmentData) {
          putBlob = {
            id: attachmentId,
            name: attachmentMeta.name,
            mimeType: attachmentMeta.mimeType,
            size: attachmentMeta.size,
            data: new Uint8Array(options.attachmentData),
          };
        }
      } else if (options?.attachment) {
        attachmentId = generateAttachmentId();
        attachmentMeta = {
          name: options.attachment.name,
          mimeType: options.attachment.mimeType,
          size: options.attachment.size,
        };
        putBlob = {
          id: attachmentId,
          name: attachmentMeta.name,
          mimeType: attachmentMeta.mimeType,
          size: attachmentMeta.size,
          data: new Uint8Array(options.attachment.data),
        };
      }

      const item: PendingRoomEvent = {
        txnId: this.nextTxnId(),
        roomId,
        type,
        sender: this.userId,
        content: cloneValue(content) as Record<string, unknown>,
        order: this.pendingOrderSeq,
        ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
      };

      const nextPending = [...this.storedPendingEvents, clonePendingEvent(item)];
      let nextRooms = this.storedRooms;
      let nextRoom: StoredRoomEvents | undefined;
      let isNewRoom = false;

      if (type === "m.room.message") {
        isNewRoom = !(roomId in this.storedRooms);
        const existingRoom = this.storedRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
        const placeholderEvent: RawMatrixEvent = {
          type,
          sender: this.userId,
          content: cloneValue(content),
          waypoint_local: {
            id: item.txnId,
            status: "unconfirmed",
            txnId: item.txnId,
            ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
          },
        };
        nextRoom = {
          ...existingRoom,
          timelineEvents: [...existingRoom.timelineEvents, placeholderEvent],
        };
        nextRooms = {
          ...this.storedRooms,
          [roomId]: nextRoom,
        };
      }

      let nextDrafts = this.storedDrafts;
      const clearDraft = Boolean(options?.clearDraft && roomId in this.storedDrafts);
      const deleteBlobIds: string[] = [];
      if (clearDraft) {
        const prevDraft = this.storedDrafts[roomId];
        nextDrafts = { ...this.storedDrafts };
        delete nextDrafts[roomId];
        if (
          prevDraft?.attachmentId &&
          !isAttachmentReferenced(prevDraft.attachmentId, nextDrafts, nextPending, nextRooms)
        ) {
          deleteBlobIds.push(prevDraft.attachmentId);
        }
      }

      await saveEnqueuedEvent({
        pendingEvent: item,
        roomId,
        roomMeta: isNewRoom && nextRoom ? extractRoomMeta(nextRoom) : undefined,
        timelineEvents: nextRoom?.timelineEvents,
        clearDraft,
        putBlob,
        deleteBlobIds,
      });

      this.pendingOrderSeq += 1;
      this.storedPendingEvents = nextPending;
      this.storedRooms = nextRooms;
      this.storedDrafts = nextDrafts;
      created = clonePendingEvent(item);
    });
    return clonePendingEvent(created);
  }

  async enqueueOrReplacePromptReaction(
    roomId: string,
    targetEventId: string,
    key: string,
  ): Promise<PendingRoomEvent> {
    if (!this.accessToken || !this.userId) {
      throw new Error("没有 access token");
    }
    let created!: PendingRoomEvent;
    await this.enqueuePersist(async () => {
      if (!this.accessToken || !this.userId) {
        throw new Error("没有 access token");
      }
      const existingIndex = this.storedPendingEvents.findIndex((pending) => {
        if (
          pending.roomId !== roomId ||
          pending.type !== "m.reaction" ||
          pending.sender !== this.userId
        ) {
          return false;
        }
        const relatesTo = pending.content["m.relates_to"];
        return (
          isPlainObject(relatesTo) &&
          relatesTo.rel_type === "m.annotation" &&
          relatesTo.event_id === targetEventId
        );
      });
      const replaced = existingIndex !== -1 ? this.storedPendingEvents[existingIndex] : undefined;
      const item: PendingRoomEvent = {
        txnId: this.nextTxnId(),
        roomId,
        type: "m.reaction",
        sender: this.userId,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: targetEventId,
            key,
          },
        },
        order: replaced?.order ?? this.pendingOrderSeq,
      };
      const nextPending = [...this.storedPendingEvents];
      if (existingIndex !== -1) {
        nextPending[existingIndex] = item;
      } else {
        nextPending.push(item);
      }

      await replacePendingEvent(replaced?.txnId, item);
      if (replaced?.order === undefined) {
        this.pendingOrderSeq += 1;
      }
      this.storedPendingEvents = nextPending;
      created = clonePendingEvent(item);
    });
    return clonePendingEvent(created);
  }

  sendRoomEvent(
    roomId: string,
    eventType: string,
    txnId: string,
    content: Record<string, unknown>,
  ): Promise<TransportResult> {
    return this.authedRequest({
      method: "PUT",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`,
      ),
      json: true,
      body: content,
    });
  }

  async advanceReadPosition(roomId: string, eventId: string): Promise<boolean> {
    if (!this.accessToken || !this.userId || !eventId) {
      return false;
    }
    const currentRoom = this.storedRooms[roomId];
    const effectiveCurrent =
      this.optimisticReadPositions.get(roomId) ?? currentRoom?.readPositionEventId;
    let setOptimistic = false;
    if (currentRoom && canAdvanceReadPosition(currentRoom, eventId, effectiveCurrent)) {
      this.optimisticReadPositions.set(roomId, eventId);
      setOptimistic = true;
    }
    let changed = false;
    try {
      await this.enqueuePersist(async () => {
        if (!this.accessToken || !this.userId) {
          return;
        }
        const room = this.storedRooms[roomId];
        if (!room || !canAdvanceReadPosition(room, eventId, room.readPositionEventId)) {
          return;
        }
        const nextRoom: StoredRoomEvents = {
          ...room,
          readPositionEventId: eventId,
        };
        const nextRooms = {
          ...this.storedRooms,
          [roomId]: nextRoom,
        };
        const nextPendingReadMarkers = this.storedPendingReadMarkers.filter(
          (item) => item.roomId !== roomId,
        );
        const newMarker: PendingReadMarker = { roomId, eventId };
        nextPendingReadMarkers.push(newMarker);
        await saveRoomMetaAndReadMarker(roomId, extractRoomMeta(nextRoom), newMarker);
        this.storedRooms = nextRooms;
        this.storedPendingReadMarkers = nextPendingReadMarkers;
        changed = true;
      });
    } finally {
      if (setOptimistic && this.optimisticReadPositions.get(roomId) === eventId) {
        this.optimisticReadPositions.delete(roomId);
      }
    }
    return changed;
  }

  sendReadMarkers(roomId: string, eventId: string): Promise<TransportResult> {
    return this.authedRequest({
      method: "POST",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      ),
      json: true,
      body: {
        "m.fully_read": eventId,
        "m.read.private": eventId,
      },
    });
  }

  async confirmSentReadMarker(roomId: string, eventId: string): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const currentPending = this.storedPendingReadMarkers.find(
        (item) => item.roomId === roomId,
      );
      const deletePendingMarker = Boolean(currentPending && currentPending.eventId === eventId);
      const nextPendingReadMarkers = deletePendingMarker
        ? this.storedPendingReadMarkers.filter((item) => item.roomId !== roomId)
        : this.storedPendingReadMarkers;

      const room = this.storedRooms[roomId];
      let nextRooms = this.storedRooms;
      let updatedRoom: StoredRoomEvents | undefined;
      if (room) {
        const eventIdx = timelineIndexOf(room.timelineEvents, eventId);
        const fullyIdx = timelineIndexOf(room.timelineEvents, room.fullyReadEventId);
        const privateIdx = timelineIndexOf(room.timelineEvents, room.privateReadEventId);
        const nextFully =
          room.fullyReadEventId === undefined ||
          (eventIdx !== -1 && (fullyIdx === -1 || eventIdx > fullyIdx))
            ? eventId
            : room.fullyReadEventId;
        const nextPrivate =
          room.privateReadEventId === undefined ||
          (eventIdx !== -1 && (privateIdx === -1 || eventIdx > privateIdx))
            ? eventId
            : room.privateReadEventId;
        const readIdx = timelineIndexOf(room.timelineEvents, room.readPositionEventId);
        const nextRead =
          room.readPositionEventId === undefined ||
          (eventIdx !== -1 && readIdx !== -1 && eventIdx > readIdx)
            ? eventId
            : room.readPositionEventId;
        if (
          nextFully !== room.fullyReadEventId ||
          nextPrivate !== room.privateReadEventId ||
          nextRead !== room.readPositionEventId
        ) {
          updatedRoom = {
            ...room,
            readPositionEventId: nextRead,
            fullyReadEventId: nextFully,
            privateReadEventId: nextPrivate,
          };
          nextRooms = {
            ...this.storedRooms,
            [roomId]: updatedRoom,
          };
        }
      }
      if (!deletePendingMarker && !updatedRoom) {
        return;
      }
      await saveReadMarkerConfirmation({
        roomId,
        roomMeta: updatedRoom ? extractRoomMeta(updatedRoom) : undefined,
        deletePendingMarker,
      });
      if (updatedRoom) {
        this.storedRooms = nextRooms;
      }
      this.storedPendingReadMarkers = nextPendingReadMarkers;
    });
  }

  async confirmSentRoomEvent(roomId: string, txnId: string, eventId: string): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const pending = this.storedPendingEvents.find(
        (item) => item.roomId === roomId && item.txnId === txnId,
      );
      const nextPending = this.storedPendingEvents.filter(
        (item) => !(item.roomId === roomId && item.txnId === txnId),
      );
      const isNewRoom = !(roomId in this.storedRooms);
      const existingRoom = this.storedRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const alreadyConfirmed = existingRoom.timelineEvents.some(
        (ev) => !localPlaceholderOf(ev) && (eventIdOf(ev) === eventId || transactionIdOf(ev) === txnId),
      );
      const placeholderIndex = existingRoom.timelineEvents.findIndex(
        (ev) => localPlaceholderOf(ev)?.txnId === txnId,
      );
      const placeholder =
        placeholderIndex !== -1 ? existingRoom.timelineEvents[placeholderIndex] : undefined;
      const placeholderMeta = placeholder ? localPlaceholderOf(placeholder) : undefined;

      let nextTimeline = existingRoom.timelineEvents;
      if (!alreadyConfirmed) {
        const source =
          pending ??
          (placeholder &&
          typeof placeholder.type === "string" &&
          typeof placeholder.sender === "string" &&
          isPlainObject(placeholder.content)
            ? {
                type: placeholder.type,
                sender: placeholder.sender,
                content: placeholder.content,
              }
            : undefined);
        if (source) {
          const confirmedEvent: RawMatrixEvent = {
            type: source.type,
            event_id: eventId,
            sender: source.sender,
            content: cloneValue(source.content),
            unsigned: { transaction_id: txnId },
          };
          nextTimeline = [...existingRoom.timelineEvents];
          if (placeholderIndex !== -1) {
            nextTimeline[placeholderIndex] = confirmedEvent;
          } else {
            nextTimeline.push(confirmedEvent);
          }
        }
      } else if (placeholderIndex !== -1) {
        nextTimeline = [...existingRoom.timelineEvents];
        nextTimeline.splice(placeholderIndex, 1);
      }

      const nextRoom: StoredRoomEvents =
        nextTimeline !== existingRoom.timelineEvents
          ? { ...existingRoom, timelineEvents: nextTimeline }
          : existingRoom;
      const nextRooms =
        nextRoom !== existingRoom || isNewRoom
          ? { ...this.storedRooms, [roomId]: nextRoom }
          : this.storedRooms;

      const candidateIds = new Set<string>();
      if (pending?.attachmentId) {
        candidateIds.add(pending.attachmentId);
      }
      if (placeholderMeta?.attachmentId) {
        candidateIds.add(placeholderMeta.attachmentId);
      }
      const deleteBlobIds = Array.from(candidateIds).filter(
        (id) => !isAttachmentReferenced(id, this.storedDrafts, nextPending, nextRooms),
      );

      await saveConfirmedEvent({
        roomId,
        txnId,
        timelineEvents: nextRoom.timelineEvents,
        roomMeta: isNewRoom ? extractRoomMeta(nextRoom) : undefined,
        deleteBlobIds,
      });

      this.storedPendingEvents = nextPending;
      this.storedRooms = nextRooms;
    });
  }

  async resendFailedRoomEvent(roomId: string, localId: string): Promise<PendingRoomEvent | undefined> {
    let created: PendingRoomEvent | undefined;
    await this.enqueuePersist(async () => {
      if (!this.accessToken || !this.userId) {
        return;
      }
      const existingRoom = this.storedRooms[roomId];
      if (!existingRoom) {
        return;
      }
      const placeholderIndex = existingRoom.timelineEvents.findIndex((ev) => {
        const meta = localPlaceholderOf(ev);
        return meta?.id === localId && meta.status === "failed";
      });
      if (placeholderIndex === -1) {
        return;
      }
      const placeholder = existingRoom.timelineEvents[placeholderIndex];
      if (
        typeof placeholder.type !== "string" ||
        placeholder.type === "" ||
        typeof placeholder.sender !== "string" ||
        placeholder.sender === "" ||
        !isPlainObject(placeholder.content)
      ) {
        return;
      }
      const placeholderMeta = localPlaceholderOf(placeholder);
      const attachmentId = placeholderMeta?.attachmentId;
      const attachmentMeta = placeholderMeta?.attachmentMeta
        ? { ...placeholderMeta.attachmentMeta }
        : undefined;
      const newTxnId = this.nextTxnId();
      const item: PendingRoomEvent = {
        txnId: newTxnId,
        roomId,
        type: placeholder.type,
        sender: placeholder.sender,
        content: cloneValue(placeholder.content) as Record<string, unknown>,
        order: this.pendingOrderSeq,
        ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
      };
      const nextTimeline = [...existingRoom.timelineEvents];
      nextTimeline[placeholderIndex] = {
        ...placeholder,
        waypoint_local: {
          id: localId,
          status: "unconfirmed",
          txnId: newTxnId,
          ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
        },
      };
      const nextRooms = {
        ...this.storedRooms,
        [roomId]: {
          ...existingRoom,
          timelineEvents: nextTimeline,
        },
      };
      const nextPending = [...this.storedPendingEvents, item];
      await saveResendEvent({
        roomId,
        pendingEvent: item,
        timelineEvents: nextTimeline,
      });
      this.pendingOrderSeq += 1;
      this.storedPendingEvents = nextPending;
      this.storedRooms = nextRooms;
      created = clonePendingEvent(item);
    });
    return created ? clonePendingEvent(created) : undefined;
  }

  async discardFailedRoomEvent(roomId: string, localId: string): Promise<boolean> {
    let removed = false;
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const existingRoom = this.storedRooms[roomId];
      if (!existingRoom) {
        return;
      }
      const placeholderIndex = existingRoom.timelineEvents.findIndex((ev) => {
        const meta = localPlaceholderOf(ev);
        return meta?.id === localId && meta.status === "failed";
      });
      if (placeholderIndex === -1) {
        return;
      }
      const removedMeta = localPlaceholderOf(existingRoom.timelineEvents[placeholderIndex]);
      const nextTimeline = [...existingRoom.timelineEvents];
      nextTimeline.splice(placeholderIndex, 1);
      const nextRooms = {
        ...this.storedRooms,
        [roomId]: {
          ...existingRoom,
          timelineEvents: nextTimeline,
        },
      };
      const deleteBlobIds: string[] = [];
      if (
        removedMeta?.attachmentId &&
        !isAttachmentReferenced(
          removedMeta.attachmentId,
          this.storedDrafts,
          this.storedPendingEvents,
          nextRooms,
        )
      ) {
        deleteBlobIds.push(removedMeta.attachmentId);
      }
      await saveDiscardFailedEvent({
        roomId,
        timelineEvents: nextTimeline,
        deleteBlobIds,
      });
      this.storedRooms = nextRooms;
      removed = true;
    });
    return removed;
  }

  async failPendingRoomEvent(roomId: string, txnId: string): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const pending = this.storedPendingEvents.find(
        (item) => item.roomId === roomId && item.txnId === txnId,
      );
      const nextPending = this.storedPendingEvents.filter(
        (item) => !(item.roomId === roomId && item.txnId === txnId),
      );
      const isNewRoom = !(roomId in this.storedRooms);
      const existingRoom = this.storedRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const placeholderIndex = existingRoom.timelineEvents.findIndex(
        (ev) => localPlaceholderOf(ev)?.txnId === txnId,
      );
      let nextTimeline = existingRoom.timelineEvents;
      if (placeholderIndex !== -1) {
        const placeholder = existingRoom.timelineEvents[placeholderIndex];
        const meta = localPlaceholderOf(placeholder)!;
        const attachmentId = meta.attachmentId ?? pending?.attachmentId;
        const attachmentMeta = meta.attachmentMeta ?? pending?.attachmentMeta;
        nextTimeline = [...existingRoom.timelineEvents];
        nextTimeline[placeholderIndex] = {
          ...placeholder,
          waypoint_local: {
            id: meta.id,
            status: "failed",
            txnId,
            ...(attachmentId && attachmentMeta
              ? { attachmentId, attachmentMeta: { ...attachmentMeta } }
              : {}),
          },
        };
      } else if (pending && pending.type === "m.room.message") {
        nextTimeline = [
          ...existingRoom.timelineEvents,
          {
            type: pending.type,
            sender: pending.sender,
            content: cloneValue(pending.content),
            waypoint_local: {
              id: pending.txnId,
              status: "failed",
              txnId: pending.txnId,
              ...(pending.attachmentId && pending.attachmentMeta
                ? {
                    attachmentId: pending.attachmentId,
                    attachmentMeta: { ...pending.attachmentMeta },
                  }
                : {}),
            },
          },
        ];
      }
      const nextRoom: StoredRoomEvents =
        nextTimeline !== existingRoom.timelineEvents
          ? { ...existingRoom, timelineEvents: nextTimeline }
          : existingRoom;
      const nextRooms =
        nextRoom !== existingRoom || isNewRoom
          ? { ...this.storedRooms, [roomId]: nextRoom }
          : this.storedRooms;

      await saveFailedEvent({
        roomId,
        txnId,
        timelineEvents: nextRoom.timelineEvents,
        roomMeta: isNewRoom ? extractRoomMeta(nextRoom) : undefined,
      });
      this.storedPendingEvents = nextPending;
      this.storedRooms = nextRooms;
    });
  }

  async rememberRoomStateEvents(
    roomId: string,
    stateEvents: RawMatrixEvent[],
    options?: { inviteFailed?: boolean },
  ): Promise<void> {
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const existing = this.storedRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const gaps = roomTimelineGaps(existing).map((g) => ({ ...g }));
      const nextInviteFailed =
        options?.inviteFailed === true
          ? true
          : options?.inviteFailed === false
            ? undefined
            : existing.inviteFailed;
      const nextRoom: StoredRoomEvents = {
        ...existing,
        stateEvents: mergeStateEvents(existing.stateEvents, stateEvents),
        timelineEvents: existing.timelineEvents,
        ...(gaps.length > 0 ? { timelineGap: { ...gaps[0] }, timelineGaps: gaps } : {}),
        ...(existing.encryptedIrreversible ? { encryptedIrreversible: true as const } : {}),
        ...(nextInviteFailed ? { inviteFailed: true as const } : {}),
      };
      if (!nextInviteFailed) {
        delete nextRoom.inviteFailed;
      }
      await saveRoomMeta(roomId, extractRoomMeta(nextRoom));
      this.storedRooms = {
        ...this.storedRooms,
        [roomId]: nextRoom,
      };
    });
  }

  abandonBeforeList(): Promise<void> {
    return this.exitDevice();
  }

  async exitDevice(): Promise<void> {
    const base = this.baseUrl;
    const token = this.accessToken;
    this.tokenGeneration += 1;
    this.accessToken = undefined;
    this.deviceId = undefined;
    if (base && token) {
      try {
        void this.transport
          .request({
            method: "POST",
            url: matrixUrl(base, "/_matrix/client/v3/logout"),
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: {},
          })
          .then(
            () => undefined,
            () => undefined,
          );
      } catch {
        // best-effort logout
      }
    }
    this.optimisticReadPositions.clear();
    await this.enqueuePersist(async () => {
      await dropPreListSession();
      this.accessToken = undefined;
      this.deviceId = undefined;
      this.syncCursor = undefined;
      this.storedAccountData = {};
      this.storedRooms = {};
      this.storedPendingEvents = [];
      this.storedPendingReadMarkers = [];
      this.storedDrafts = {};
      this.pendingOrderSeq = 0;
      this.leaveGeneration = 0;
      this.leftAtGeneration.clear();
      this.tagGeneration = 0;
      this.tagUpdatedAtGeneration.clear();
    });
  }

  async forgetCredential(): Promise<void> {
    this.tokenGeneration += 1;
    this.optimisticReadPositions.clear();
    await this.enqueuePersist(async () => {
      await dropCredential();
      this.accessToken = undefined;
      this.deviceId = undefined;
    });
  }

  private sessionMeta(overrides?: {
    accessToken?: string;
    deviceId?: string;
    syncCursor?: string;
    accountData?: Record<string, unknown>;
  }): SessionMeta {
    const syncCursor = overrides && "syncCursor" in overrides ? overrides.syncCursor : this.syncCursor;
    const accountData = overrides?.accountData ?? this.storedAccountData;
    const accessToken =
      overrides && "accessToken" in overrides ? overrides.accessToken : this.accessToken;
    const deviceId = overrides && "deviceId" in overrides ? overrides.deviceId : this.deviceId;
    return {
      baseUrl: this.baseUrl,
      userId: this.userId,
      ...(accessToken ? { accessToken } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(syncCursor ? { syncCursor } : {}),
      ...(Object.keys(accountData).length > 0 ? { accountData } : {}),
    };
  }

  private nextTxnId(): string {
    this.txnCounter += 1;
    const suffix =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return `txn-${this.txnCounter}-${suffix}`;
  }

  private enqueuePersist(write: () => Promise<void>): Promise<void> {
    this.persistActiveCount += 1;
    let run: Promise<void>;
    if (this.persistActiveCount === 1) {
      try {
        run = write();
      } catch (error) {
        run = Promise.reject(error);
      }
    } else {
      run = this.persistTail.then(() => write());
    }
    const settled = run.then(
      () => {
        this.persistActiveCount -= 1;
      },
      () => {
        this.persistActiveCount -= 1;
      },
    );
    this.persistTail = settled;
    return run;
  }
}

function extractRoomMeta(room: StoredRoomEvents): StoredRoomMeta {
  const { timelineEvents: _ignored, ...meta } = room;
  void _ignored;
  return meta;
}

function collectReferencedAttachmentIds(
  drafts: Record<string, DraftRecord>,
  pendingEvents: PendingRoomEvent[],
  rooms: Record<string, StoredRoomEvents>,
): Set<string> {
  const ids = new Set<string>();
  for (const draft of Object.values(drafts)) {
    if (draft.attachmentId) {
      ids.add(draft.attachmentId);
    }
  }
  for (const pending of pendingEvents) {
    if (pending.attachmentId) {
      ids.add(pending.attachmentId);
    }
  }
  for (const room of Object.values(rooms)) {
    for (const ev of room.timelineEvents) {
      const local = localPlaceholderOf(ev);
      if (local?.attachmentId) {
        ids.add(local.attachmentId);
      }
    }
  }
  return ids;
}

function isAttachmentReferenced(
  attachmentId: string,
  drafts: Record<string, DraftRecord>,
  pendingEvents: PendingRoomEvent[],
  rooms: Record<string, StoredRoomEvents>,
): boolean {
  for (const draft of Object.values(drafts)) {
    if (draft.attachmentId === attachmentId) {
      return true;
    }
  }
  for (const pending of pendingEvents) {
    if (pending.attachmentId === attachmentId) {
      return true;
    }
  }
  for (const room of Object.values(rooms)) {
    for (const ev of room.timelineEvents) {
      const local = localPlaceholderOf(ev);
      if (local?.attachmentId === attachmentId) {
        return true;
      }
    }
  }
  return false;
}

function matrixUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = cloneValue(v);
    }
    return copy;
  }
  return value;
}

function cloneObject(obj: RawMatrixEvent): RawMatrixEvent {
  return cloneValue(obj) as RawMatrixEvent;
}

function cloneStoredGap(raw: unknown): StoredTimelineGap | undefined {
  if (!isPlainObject(raw) || raw.limited !== true) {
    return undefined;
  }
  return {
    limited: true,
    ...(typeof raw.prevBatch === "string" && raw.prevBatch !== ""
      ? { prevBatch: raw.prevBatch }
      : {}),
    ...(typeof raw.gapBeforeEventId === "string" && raw.gapBeforeEventId !== ""
      ? { gapBeforeEventId: raw.gapBeforeEventId }
      : {}),
    ...(raw.pendingGapAtEnd === true ? { pendingGapAtEnd: true as const } : {}),
  };
}

export function roomTimelineGaps(room: StoredRoomEvents): StoredTimelineGap[] {
  if (Array.isArray(room.timelineGaps) && room.timelineGaps.length > 0) {
    return room.timelineGaps;
  }
  if (room.timelineGap) {
    return [room.timelineGap];
  }
  return [];
}

export function nextBackfillTargetForReadPosition(
  room: StoredRoomEvents | undefined,
): { fromToken: string; gapIndex?: number } | undefined {
  if (!room || !room.readPositionEventId) {
    return undefined;
  }
  const gaps = roomTimelineGaps(room);
  const readIdx = timelineIndexOf(room.timelineEvents, room.readPositionEventId);
  if (readIdx !== -1) {
    for (let i = gaps.length - 1; i >= 0; i -= 1) {
      const gap = gaps[i];
      if (!gap.limited || !gap.prevBatch) {
        continue;
      }
      if (gap.pendingGapAtEnd) {
        return { fromToken: gap.prevBatch, gapIndex: i };
      }
      if (gap.gapBeforeEventId) {
        const gapIdx = timelineIndexOf(room.timelineEvents, gap.gapBeforeEventId);
        if (gapIdx > readIdx) {
          return { fromToken: gap.prevBatch, gapIndex: i };
        }
      }
    }
    return undefined;
  }
  for (let i = gaps.length - 1; i >= 0; i -= 1) {
    const gap = gaps[i];
    if (gap.prevBatch) {
      return { fromToken: gap.prevBatch, gapIndex: i };
    }
  }
  if (!room.reachedStart && room.backwardToken) {
    return { fromToken: room.backwardToken };
  }
  return undefined;
}

export function nextBackfillTargetForScrollUp(
  room: StoredRoomEvents | undefined,
): { fromToken: string; gapIndex?: number } | undefined {
  if (!room) {
    return undefined;
  }
  const gaps = roomTimelineGaps(room);
  if (!room.reachedStart && room.backwardToken) {
    const firstConfirmedId = room.timelineEvents
      .map(eventIdOf)
      .find((id): id is string => id !== undefined);
    const startGapIdx = gaps.findIndex(
      (g) =>
        (g.prevBatch && g.prevBatch === room.backwardToken) ||
        (firstConfirmedId !== undefined && g.gapBeforeEventId === firstConfirmedId),
    );
    return {
      fromToken: room.backwardToken,
      ...(startGapIdx !== -1 ? { gapIndex: startGapIdx } : {}),
    };
  }
  for (let i = 0; i < gaps.length; i += 1) {
    const gap = gaps[i];
    if (gap.prevBatch) {
      return { fromToken: gap.prevBatch, gapIndex: i };
    }
  }
  return undefined;
}

function normalizeGaps(
  gaps: StoredTimelineGap[],
  timeline: RawMatrixEvent[],
): StoredTimelineGap[] {
  if (gaps.length === 0) {
    return [];
  }
  const seenKey = new Set<string>();
  const deduped: StoredTimelineGap[] = [];
  for (const gap of gaps) {
    const key = gap.gapBeforeEventId
      ? `before:${gap.gapBeforeEventId}`
      : gap.pendingGapAtEnd
        ? "pendingEnd"
        : `token:${gap.prevBatch ?? ""}`;
    if (seenKey.has(key)) {
      const idx = deduped.findIndex((item) =>
        gap.gapBeforeEventId
          ? item.gapBeforeEventId === gap.gapBeforeEventId
          : gap.pendingGapAtEnd
            ? Boolean(item.pendingGapAtEnd)
            : item.prevBatch === gap.prevBatch,
      );
      if (idx !== -1) {
        deduped[idx] = { ...gap };
      }
      continue;
    }
    seenKey.add(key);
    deduped.push({ ...gap });
  }
  deduped.sort((a, b) => {
    const aIdx = a.gapBeforeEventId
      ? timelineIndexOf(timeline, a.gapBeforeEventId)
      : timeline.length;
    const bIdx = b.gapBeforeEventId
      ? timelineIndexOf(timeline, b.gapBeforeEventId)
      : timeline.length;
    return aIdx - bIdx;
  });
  return deduped;
}

function sanitizePlaceholderForMemory(event: RawMatrixEvent): RawMatrixEvent {
  if (!isPlainObject(event.waypoint_local)) {
    return event;
  }
  const local = localPlaceholderOf(event);
  if (!local) {
    return event;
  }
  return {
    ...event,
    waypoint_local: local,
  };
}

function normalizeStoredRooms(rooms: Record<string, unknown>): Record<string, StoredRoomEvents> {
  const cloned: Record<string, StoredRoomEvents> = {};
  for (const [roomId, value] of Object.entries(rooms)) {
    if (!isPlainObject(value)) {
      continue;
    }
    const stateEvents = Array.isArray(value.stateEvents)
      ? value.stateEvents.filter(isPlainObject).map(cloneObject)
      : [];
    const timelineEvents = Array.isArray(value.timelineEvents)
      ? value.timelineEvents.filter(isPlainObject).map(sanitizePlaceholderForMemory)
      : [];
    const gaps: StoredTimelineGap[] = [];
    if (Array.isArray(value.timelineGaps)) {
      for (const rawGap of value.timelineGaps) {
        const g = cloneStoredGap(rawGap);
        if (g) {
          gaps.push(g);
        }
      }
    }
    if (gaps.length === 0) {
      const single = cloneStoredGap(value.timelineGap);
      if (single) {
        gaps.push(single);
      }
    }
    const backwardToken =
      typeof value.backwardToken === "string" && value.backwardToken !== ""
        ? value.backwardToken
        : gaps.length === 1 &&
            gaps[0].prevBatch &&
            (timelineEvents.findIndex((ev) => !localPlaceholderOf(ev)) === -1 ||
              gaps[0].gapBeforeEventId ===
                eventIdOf(
                  timelineEvents[timelineEvents.findIndex((ev) => !localPlaceholderOf(ev))] ?? {},
                ))
          ? gaps[0].prevBatch
          : undefined;
    const reachedStart = value.reachedStart === true;
    cloned[roomId] = {
      stateEvents,
      timelineEvents,
      ...(gaps.length > 0 ? { timelineGap: { ...gaps[0] }, timelineGaps: gaps } : {}),
      ...(backwardToken && !reachedStart ? { backwardToken } : {}),
      ...(reachedStart ? { reachedStart: true } : {}),
      ...(typeof value.readPositionEventId === "string" && value.readPositionEventId !== ""
        ? { readPositionEventId: value.readPositionEventId }
        : {}),
      ...(typeof value.fullyReadEventId === "string" && value.fullyReadEventId !== ""
        ? { fullyReadEventId: value.fullyReadEventId }
        : {}),
      ...(typeof value.privateReadEventId === "string" && value.privateReadEventId !== ""
        ? { privateReadEventId: value.privateReadEventId }
        : {}),
      ...(isPlainObject(value.tags) && Object.keys(value.tags).length > 0
        ? { tags: cloneValue(value.tags) as Record<string, unknown> }
        : {}),
      ...(value.encryptedIrreversible === true ? { encryptedIrreversible: true as const } : {}),
      ...(value.inviteFailed === true ? { inviteFailed: true as const } : {}),
    };
  }
  return cloned;
}

function reconcileGapsAfterTimelineChange(
  gaps: StoredTimelineGap[],
  oldTimeline: RawMatrixEvent[],
  mergedIds: Set<string>,
  firstNewInBatch: string | undefined,
): StoredTimelineGap[] {
  const next: StoredTimelineGap[] = [];
  for (const gap of gaps) {
    if (!gap.limited) {
      continue;
    }
    if (gap.pendingGapAtEnd) {
      if (firstNewInBatch) {
        next.push({
          limited: true,
          ...(gap.prevBatch ? { prevBatch: gap.prevBatch } : {}),
          gapBeforeEventId: firstNewInBatch,
        });
      } else {
        next.push({ ...gap });
      }
      continue;
    }
    if (gap.gapBeforeEventId && !mergedIds.has(gap.gapBeforeEventId)) {
      const oldGapIdx = timelineIndexOf(oldTimeline, gap.gapBeforeEventId);
      const nextExistingAnchor =
        oldGapIdx !== -1
          ? oldTimeline
              .slice(oldGapIdx + 1)
              .map(eventIdOf)
              .find((id): id is string => id !== undefined && mergedIds.has(id))
          : undefined;
      const replacementAnchor = nextExistingAnchor ?? firstNewInBatch;
      next.push({
        limited: true,
        ...(gap.prevBatch ? { prevBatch: gap.prevBatch } : {}),
        ...(replacementAnchor
          ? { gapBeforeEventId: replacementAnchor }
          : { pendingGapAtEnd: true as const }),
      });
      continue;
    }
    next.push({ ...gap });
  }
  return next;
}

function mergeSyncRooms(
  current: Record<string, StoredRoomEvents>,
  body: unknown,
  ownerUserId: string,
  leaveGeneration?: number,
  leftAtGeneration?: Map<string, number>,
  tagGeneration?: number,
  tagUpdatedAtGeneration?: Map<string, number>,
): {
  rooms: Record<string, StoredRoomEvents>;
  metaChangedRoomIds: string[];
  timelineChangedRoomIds: string[];
  deletedRoomIds: string[];
  removedAttachmentIds: string[];
} {
  const next: Record<string, StoredRoomEvents> = { ...current };
  const metaChangedRoomIds: string[] = [];
  const timelineChangedRoomIds: string[] = [];
  const deletedRoomIds: string[] = [];
  const removedAttachmentIds: string[] = [];

  if (!isPlainObject(body) || !isPlainObject(body.rooms)) {
    return {
      rooms: next,
      metaChangedRoomIds,
      timelineChangedRoomIds,
      deletedRoomIds,
      removedAttachmentIds,
    };
  }

  const joinRooms = body.rooms.join;
  if (isPlainObject(joinRooms)) {
    for (const [roomId, roomSync] of Object.entries(joinRooms)) {
      if (!isPlainObject(roomSync)) {
        continue;
      }
      if (
        leaveGeneration !== undefined &&
        leftAtGeneration !== undefined &&
        (leftAtGeneration.get(roomId) ?? 0) > leaveGeneration
      ) {
        continue;
      }
      const existing = next[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const isNewRoom = !(roomId in next);
      const existingConfirmedCount = existing.timelineEvents.filter(
        (ev) => !localPlaceholderOf(ev),
      ).length;
      const rawState =
        isPlainObject(roomSync.state) && Array.isArray(roomSync.state.events)
          ? roomSync.state.events.filter(isPlainObject)
          : [];
      const rawTimelineAll =
        isPlainObject(roomSync.timeline) && Array.isArray(roomSync.timeline.events)
          ? roomSync.timeline.events.filter(isPlainObject)
          : [];
      const serverLimited =
        isPlainObject(roomSync.timeline) && roomSync.timeline.limited === true;
      const rawTimeline = serverLimited
        ? rawTimelineAll.slice(-MAX_SYNC_TIMELINE_EVENTS_PER_ROOM)
        : rawTimelineAll;
      const isLimited = serverLimited;
      const prevBatch =
        isPlainObject(roomSync.timeline) &&
        typeof roomSync.timeline.prev_batch === "string" &&
        roomSync.timeline.prev_batch !== ""
          ? roomSync.timeline.prev_batch
          : undefined;
      const {
        timeline: mergedTimeline,
        redactedIds,
        changed: timelineChanged,
        removedAttachmentIds: roomRemovedAttachments,
      } = mergeTimelineEventsWithRedactions(existing.timelineEvents, rawTimeline);
      for (const attId of roomRemovedAttachments) {
        removedAttachmentIds.push(attId);
      }

      const existingIds = new Set(
        existing.timelineEvents.map(eventIdOf).filter((id): id is string => id !== undefined),
      );
      const mergedIds = new Set(
        mergedTimeline.map(eventIdOf).filter((id): id is string => id !== undefined),
      );
      const firstNewInBatch = mergedTimeline
        .map(eventIdOf)
        .find((id): id is string => id !== undefined && !existingIds.has(id));

      const overlapsExistingTimeline = rawTimeline.some((event) => {
        const id = eventIdOf(event);
        return id !== undefined && existingIds.has(id);
      });

      let nextGaps = reconcileGapsAfterTimelineChange(
        roomTimelineGaps(existing),
        existing.timelineEvents,
        mergedIds,
        firstNewInBatch,
      );
      if (isLimited && !overlapsExistingTimeline) {
        const survivingIncomingAnchor = rawTimeline
          .map(eventIdOf)
          .find((id): id is string => id !== undefined && mergedIds.has(id));
        const anchor = firstNewInBatch ?? survivingIncomingAnchor;
        const incomingGap: StoredTimelineGap = {
          limited: true,
          ...(prevBatch ? { prevBatch } : {}),
          ...(anchor ? { gapBeforeEventId: anchor } : { pendingGapAtEnd: true as const }),
        };
        if (nextGaps.length > 0 && nextGaps[nextGaps.length - 1].pendingGapAtEnd && !anchor) {
          nextGaps[nextGaps.length - 1] = incomingGap;
        } else {
          nextGaps.push(incomingGap);
        }
      }
      nextGaps = normalizeGaps(nextGaps, mergedTimeline);

      let nextBackwardToken = existing.backwardToken;
      let nextReachedStart = Boolean(existing.reachedStart);
      if (existingConfirmedCount === 0 && prevBatch) {
        nextBackwardToken = prevBatch;
        nextReachedStart = false;
      }

      const timelineStateEvents = rawTimeline.filter(
        (event) => typeof event.state_key === "string",
      );

      let effectivePrevReadPos = existing.readPositionEventId;
      if (effectivePrevReadPos !== undefined && !mergedIds.has(effectivePrevReadPos)) {
        const oldReadIdx = timelineIndexOf(existing.timelineEvents, effectivePrevReadPos);
        if (oldReadIdx !== -1) {
          let fallback: string | undefined;
          for (let i = oldReadIdx - 1; i >= 0; i -= 1) {
            const candidate = eventIdOf(existing.timelineEvents[i]);
            if (candidate !== undefined && mergedIds.has(candidate)) {
              fallback = candidate;
              break;
            }
          }
          effectivePrevReadPos = fallback;
        }
      }

      const syncTags = extractRoomTags(roomSync);
      const tagLocked =
        tagGeneration !== undefined &&
        tagUpdatedAtGeneration !== undefined &&
        (tagUpdatedAtGeneration.get(roomId) ?? 0) > tagGeneration;
      const nextTags = tagLocked ? existing.tags : (syncTags ?? existing.tags);
      const syncFullyReadId = extractFullyReadEventId(roomSync);
      const syncPrivateReadIds = extractPrivateReadEventIds(roomSync, ownerUserId);
      const nextFullyReadEventId = syncFullyReadId ?? existing.fullyReadEventId;
      const bestIncomingPrivateReadId =
        resolveFurthestInTimeline(mergedTimeline, syncPrivateReadIds) ??
        syncPrivateReadIds[syncPrivateReadIds.length - 1];
      const nextPrivateReadEventId =
        resolveFurthestInTimeline(
          mergedTimeline,
          [existing.privateReadEventId, bestIncomingPrivateReadId].filter(
            (id): id is string => id !== undefined,
          ),
        ) ??
        bestIncomingPrivateReadId ??
        existing.privateReadEventId;

      const effectiveSyncFullyReadId =
        syncFullyReadId && !redactedIds.has(syncFullyReadId) ? syncFullyReadId : undefined;
      const effectiveSyncPrivateReadIds = syncPrivateReadIds.filter((id) => !redactedIds.has(id));

      const nextReadPositionEventId = resolveNextReadPosition(
        mergedTimeline,
        nextGaps,
        effectivePrevReadPos,
        effectiveSyncFullyReadId,
        effectiveSyncPrivateReadIds,
      );

      const incomingStateEvents = [...rawState, ...timelineStateEvents];
      const mergedStateEvents =
        incomingStateEvents.length > 0
          ? mergeStateEvents(existing.stateEvents, incomingStateEvents)
          : existing.stateEvents;
      const hasEncInExisting =
        existing.encryptedIrreversible === true ||
        existing.stateEvents.some((ev) => ev.type === "m.room.encryption");
      const hasEncInRawState = rawState.some((ev) => ev.type === "m.room.encryption");
      const hasEncInRawTimeline = rawTimelineAll.some((ev) => ev.type === "m.room.encryption");
      const encryptedIrreversible: true | undefined =
        hasEncInExisting || hasEncInRawState || hasEncInRawTimeline ? true : undefined;

      let inviteFailed: true | undefined = existing.inviteFailed;
      if (inviteFailed) {
        const boundAgentId = boundAgentUserIdFromState(mergedStateEvents);
        if (boundAgentId) {
          const incomingAgentMember = [...rawState, ...timelineStateEvents]
            .reverse()
            .find((ev) => ev.type === "m.room.member" && ev.state_key === boundAgentId);
          if (incomingAgentMember && isPlainObject(incomingAgentMember.content)) {
            const m = incomingAgentMember.content.membership;
            if (m === "join" || m === "invite") {
              inviteFailed = undefined;
            }
          }
        }
      }

      const nextRoom: StoredRoomEvents = {
        stateEvents: mergedStateEvents,
        timelineEvents: mergedTimeline,
        ...(nextGaps.length > 0 ? { timelineGap: { ...nextGaps[0] }, timelineGaps: nextGaps } : {}),
        ...(nextBackwardToken && !nextReachedStart ? { backwardToken: nextBackwardToken } : {}),
        ...(nextReachedStart ? { reachedStart: true } : {}),
        ...(nextReadPositionEventId ? { readPositionEventId: nextReadPositionEventId } : {}),
        ...(nextFullyReadEventId ? { fullyReadEventId: nextFullyReadEventId } : {}),
        ...(nextPrivateReadEventId ? { privateReadEventId: nextPrivateReadEventId } : {}),
        ...(nextTags && Object.keys(nextTags).length > 0 ? { tags: nextTags } : {}),
        ...(encryptedIrreversible ? { encryptedIrreversible: true as const } : {}),
        ...(inviteFailed ? { inviteFailed: true as const } : {}),
      };

      const metaChanged =
        isNewRoom ||
        incomingStateEvents.length > 0 ||
        nextReadPositionEventId !== existing.readPositionEventId ||
        nextFullyReadEventId !== existing.fullyReadEventId ||
        nextPrivateReadEventId !== existing.privateReadEventId ||
        nextBackwardToken !== existing.backwardToken ||
        nextReachedStart !== Boolean(existing.reachedStart) ||
        syncTags !== undefined ||
        encryptedIrreversible !== existing.encryptedIrreversible ||
        inviteFailed !== existing.inviteFailed ||
        JSON.stringify(nextGaps) !== JSON.stringify(roomTimelineGaps(existing));

      next[roomId] = nextRoom;
      if (metaChanged) {
        metaChangedRoomIds.push(roomId);
      }
      if (isNewRoom || timelineChanged) {
        timelineChangedRoomIds.push(roomId);
      }
    }
  }

  const leaveRooms = body.rooms.leave;
  if (isPlainObject(leaveRooms)) {
    for (const roomId of Object.keys(leaveRooms)) {
      const removed = next[roomId];
      if (removed) {
        for (const ev of removed.timelineEvents) {
          const local = localPlaceholderOf(ev);
          if (local?.attachmentId) {
            removedAttachmentIds.push(local.attachmentId);
          }
        }
        delete next[roomId];
        deletedRoomIds.push(roomId);
      }
    }
  }

  return {
    rooms: next,
    metaChangedRoomIds,
    timelineChangedRoomIds,
    deletedRoomIds,
    removedAttachmentIds,
  };
}

function extractRoomTags(roomSync: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isPlainObject(roomSync.account_data) || !Array.isArray(roomSync.account_data.events)) {
    return undefined;
  }
  let found: Record<string, unknown> | undefined;
  for (const event of roomSync.account_data.events) {
    if (isPlainObject(event) && event.type === "m.tag" && isPlainObject(event.content)) {
      found = isPlainObject(event.content.tags)
        ? (cloneValue(event.content.tags) as Record<string, unknown>)
        : {};
    }
  }
  return found;
}

function applyRoomBackfillPage(
  room: StoredRoomEvents,
  fromToken: string,
  body: unknown,
  gapIndex?: number,
): { changed: boolean; room: StoredRoomEvents; prependedCount: number } {
  if (!isPlainObject(body)) {
    return { changed: false, room, prependedCount: 0 };
  }
  const rawChunk = Array.isArray(body.chunk) ? body.chunk.filter(isPlainObject) : [];
  const rawState = Array.isArray(body.state) ? body.state.filter(isPlainObject) : [];
  const endToken =
    typeof body.end === "string" && body.end !== "" ? body.end : undefined;
  const atEnd = rawChunk.length === 0 || !endToken || endToken === fromToken;

  const incomingChronological = [...rawChunk].reverse();
  const gaps = roomTimelineGaps(room);
  const resolvedGapIndex =
    gapIndex !== undefined && gapIndex >= 0 && gapIndex < gaps.length
      ? gapIndex
      : gaps.findIndex((g) => g.prevBatch === fromToken);
  const targetGap = resolvedGapIndex !== -1 ? gaps[resolvedGapIndex] : undefined;

  let insertIdx = 0;
  if (targetGap?.gapBeforeEventId) {
    const foundIdx = timelineIndexOf(room.timelineEvents, targetGap.gapBeforeEventId);
    insertIdx = foundIdx !== -1 ? foundIdx : 0;
  } else if (targetGap?.pendingGapAtEnd) {
    insertIdx = room.timelineEvents.length;
  }

  const beforeSlice = room.timelineEvents.slice(0, insertIdx);
  const afterSlice = room.timelineEvents.slice(insertIdx);
  const beforeHasConfirmed = beforeSlice.some((ev) => !localPlaceholderOf(ev));

  const redactedIds = new Set<string>();
  for (const event of [...room.timelineEvents, ...incomingChronological]) {
    const targetId = redactedEventIdOf(event);
    if (targetId !== undefined) {
      redactedIds.add(targetId);
    }
    if (isRedactedStub(event)) {
      const id = eventIdOf(event);
      if (id !== undefined) {
        redactedIds.add(id);
      }
    }
  }

  const shouldOmit = (event: RawMatrixEvent): boolean => {
    if (event.type === "m.room.redaction" || isRedactedStub(event)) {
      return true;
    }
    const id = eventIdOf(event);
    if (id !== undefined && redactedIds.has(id)) {
      return true;
    }
    const replaceTarget = replaceTargetIdOf(event);
    if (replaceTarget !== undefined && redactedIds.has(replaceTarget)) {
      return true;
    }
    const reactionTarget = reactionTargetIdOf(event);
    if (reactionTarget !== undefined && redactedIds.has(reactionTarget)) {
      return true;
    }
    return false;
  };

  let effectiveReadPos = room.readPositionEventId;
  if (effectiveReadPos !== undefined) {
    const readIdxInIncoming = incomingChronological.findIndex(
      (ev) => eventIdOf(ev) === effectiveReadPos,
    );
    if (readIdxInIncoming !== -1 && shouldOmit(incomingChronological[readIdxInIncoming])) {
      let fallback: string | undefined;
      for (let i = readIdxInIncoming - 1; i >= 0; i -= 1) {
        const candidate = incomingChronological[i];
        const id = eventIdOf(candidate);
        if (id !== undefined && !shouldOmit(candidate)) {
          fallback = id;
          break;
        }
      }
      if (fallback === undefined) {
        for (let i = beforeSlice.length - 1; i >= 0; i -= 1) {
          const candidate = beforeSlice[i];
          const id = eventIdOf(candidate);
          if (id !== undefined && !shouldOmit(candidate)) {
            fallback = id;
            break;
          }
        }
      }
      effectiveReadPos = fallback;
    }
  }

  const beforeIds = new Set(
    beforeSlice.map(eventIdOf).filter((id): id is string => id !== undefined),
  );
  const afterIds = new Set(
    afterSlice.map(eventIdOf).filter((id): id is string => id !== undefined),
  );
  const overlappedBefore =
    beforeHasConfirmed &&
    incomingChronological.some((ev) => {
      const id = eventIdOf(ev);
      return id !== undefined && beforeIds.has(id);
    });

  const filterPreserveRedactedPrompt = (ev: RawMatrixEvent): RawMatrixEvent | undefined => {
    if (!shouldOmit(ev)) {
      return cloneObject(ev);
    }
    if (shouldPreserveRedactedReaction(ev, redactedIds)) {
      return markRedactedReaction(ev);
    }
    return undefined;
  };
  const filteredBefore = beforeSlice
    .map(filterPreserveRedactedPrompt)
    .filter((ev): ev is RawMatrixEvent => ev !== undefined);
  const filteredAfter = afterSlice
    .map(filterPreserveRedactedPrompt)
    .filter((ev): ev is RawMatrixEvent => ev !== undefined);

  const seenIncomingIds = new Set<string>();
  const dedupedIncoming: RawMatrixEvent[] = [];
  for (const rawEvent of incomingChronological) {
    const transformed = filterPreserveRedactedPrompt(rawEvent);
    if (!transformed) {
      continue;
    }
    const id = eventIdOf(transformed);
    if (id !== undefined) {
      if (beforeIds.has(id) || afterIds.has(id) || seenIncomingIds.has(id)) {
        continue;
      }
      seenIncomingIds.add(id);
    }
    dedupedIncoming.push(transformed);
  }

  const mergedTimeline = [...filteredBefore, ...dedupedIncoming, ...filteredAfter];
  const mergedIds = new Set(
    mergedTimeline.map(eventIdOf).filter((id): id is string => id !== undefined),
  );
  if (effectiveReadPos !== undefined && !mergedIds.has(effectiveReadPos)) {
    const oldReadIdx = timelineIndexOf(room.timelineEvents, effectiveReadPos);
    if (oldReadIdx !== -1) {
      let fallback: string | undefined;
      for (let i = oldReadIdx - 1; i >= 0; i -= 1) {
        const candidate = eventIdOf(room.timelineEvents[i]);
        if (candidate !== undefined && mergedIds.has(candidate)) {
          fallback = candidate;
          break;
        }
      }
      effectiveReadPos = fallback;
    }
  }

  let nextGaps: StoredTimelineGap[] = [];
  for (let i = 0; i < gaps.length; i += 1) {
    const gap = gaps[i];
    if (i === resolvedGapIndex) {
      if (beforeHasConfirmed) {
        if (!overlappedBefore && !atEnd) {
          const firstInsertedId = dedupedIncoming
            .map(eventIdOf)
            .find((id): id is string => id !== undefined);
          const fallbackAnchor =
            gap.gapBeforeEventId && mergedIds.has(gap.gapBeforeEventId)
              ? gap.gapBeforeEventId
              : filteredAfter.map(eventIdOf).find((id): id is string => id !== undefined);
          const nextAnchor = firstInsertedId ?? fallbackAnchor;
          nextGaps.push({
            limited: true,
            ...(endToken ? { prevBatch: endToken } : {}),
            ...(nextAnchor ? { gapBeforeEventId: nextAnchor } : { pendingGapAtEnd: true as const }),
          });
        }
      } else {
        if (!atEnd) {
          const earliestId = mergedTimeline
            .map(eventIdOf)
            .find((id): id is string => id !== undefined);
          nextGaps.push({
            limited: true,
            ...(endToken ? { prevBatch: endToken } : {}),
            ...(earliestId ? { gapBeforeEventId: earliestId } : { pendingGapAtEnd: true as const }),
          });
        }
      }
      continue;
    }
    nextGaps.push({ ...gap });
  }
  nextGaps = reconcileGapsAfterTimelineChange(
    nextGaps,
    room.timelineEvents,
    mergedIds,
    undefined,
  );
  nextGaps = normalizeGaps(nextGaps, mergedTimeline);

  let nextBackwardToken = room.backwardToken;
  let nextReachedStart = Boolean(room.reachedStart);
  if (!beforeHasConfirmed) {
    if (atEnd) {
      nextBackwardToken = undefined;
      nextReachedStart = true;
    } else {
      nextBackwardToken = endToken;
    }
  }

  const effectiveFullyReadId =
    room.fullyReadEventId && !redactedIds.has(room.fullyReadEventId)
      ? room.fullyReadEventId
      : undefined;
  const effectivePrivateReadId =
    room.privateReadEventId && !redactedIds.has(room.privateReadEventId)
      ? room.privateReadEventId
      : undefined;

  const nextReadPositionEventId = resolveNextReadPosition(
    mergedTimeline,
    nextGaps,
    effectiveReadPos,
    effectiveFullyReadId,
    effectivePrivateReadId ? [effectivePrivateReadId] : [],
  );

  const chunkStateEvents = incomingChronological.filter(
    (event) => typeof event.state_key === "string",
  );
  const nextStateEvents = mergeStateEvents(
    [...rawState, ...chunkStateEvents],
    room.stateEvents,
  );

  const hasEnc =
    room.encryptedIrreversible === true ||
    room.stateEvents.some((ev) => ev.type === "m.room.encryption") ||
    rawState.some((ev) => ev.type === "m.room.encryption") ||
    incomingChronological.some((ev) => ev.type === "m.room.encryption");

  const nextRoom: StoredRoomEvents = {
    stateEvents: nextStateEvents,
    timelineEvents: mergedTimeline,
    ...(nextGaps.length > 0 ? { timelineGap: { ...nextGaps[0] }, timelineGaps: nextGaps } : {}),
    ...(nextBackwardToken && !nextReachedStart ? { backwardToken: nextBackwardToken } : {}),
    ...(nextReachedStart ? { reachedStart: true } : {}),
    ...(nextReadPositionEventId ? { readPositionEventId: nextReadPositionEventId } : {}),
    ...(room.fullyReadEventId ? { fullyReadEventId: room.fullyReadEventId } : {}),
    ...(room.privateReadEventId ? { privateReadEventId: room.privateReadEventId } : {}),
    ...(isPlainObject(room.tags) && Object.keys(room.tags).length > 0
      ? { tags: cloneValue(room.tags) as Record<string, unknown> }
      : {}),
    ...(hasEnc ? { encryptedIrreversible: true as const } : {}),
    ...(room.inviteFailed ? { inviteFailed: true as const } : {}),
  };

  return {
    changed: true,
    room: nextRoom,
    prependedCount: dedupedIncoming.length,
  };
}

function extractFullyReadEventId(roomSync: Record<string, unknown>): string | undefined {
  if (!isPlainObject(roomSync.account_data) || !Array.isArray(roomSync.account_data.events)) {
    return undefined;
  }
  let found: string | undefined;
  for (const event of roomSync.account_data.events) {
    if (
      isPlainObject(event) &&
      event.type === "m.fully_read" &&
      isPlainObject(event.content) &&
      typeof event.content.event_id === "string" &&
      event.content.event_id !== ""
    ) {
      found = event.content.event_id;
    }
  }
  return found;
}

function extractPrivateReadEventIds(
  roomSync: Record<string, unknown>,
  ownerUserId: string,
): string[] {
  if (!ownerUserId || !isPlainObject(roomSync.ephemeral) || !Array.isArray(roomSync.ephemeral.events)) {
    return [];
  }
  const ids: string[] = [];
  for (const event of roomSync.ephemeral.events) {
    if (!isPlainObject(event) || event.type !== "m.receipt" || !isPlainObject(event.content)) {
      continue;
    }
    for (const [eventId, receiptTypes] of Object.entries(event.content)) {
      if (!eventId || !isPlainObject(receiptTypes)) {
        continue;
      }
      const privateReceipts = receiptTypes["m.read.private"];
      if (isPlainObject(privateReceipts) && ownerUserId in privateReceipts) {
        ids.push(eventId);
      }
    }
  }
  return ids;
}

export function timelineIndexOf(timeline: RawMatrixEvent[], eventId: string | undefined): number {
  if (!eventId) {
    return -1;
  }
  return timeline.findIndex((event) => eventIdOf(event) === eventId);
}

function canAdvanceReadPosition(
  room: StoredRoomEvents,
  eventId: string,
  currentReadPos: string | undefined,
): boolean {
  const targetIdx = timelineIndexOf(room.timelineEvents, eventId);
  if (targetIdx === -1) {
    return false;
  }
  if (currentReadPos !== undefined) {
    if (currentReadPos === eventId) {
      return false;
    }
    const currentIdx = timelineIndexOf(room.timelineEvents, currentReadPos);
    if (currentIdx === -1 || targetIdx <= currentIdx) {
      return false;
    }
  }
  return true;
}

function resolveFurthestInTimeline(
  timeline: RawMatrixEvent[],
  eventIds: string[],
): string | undefined {
  let bestId: string | undefined;
  let bestIdx = -1;
  for (const id of eventIds) {
    const idx = timelineIndexOf(timeline, id);
    if (idx > bestIdx) {
      bestIdx = idx;
      bestId = id;
    }
  }
  return bestId;
}

function resolveNextReadPosition(
  timeline: RawMatrixEvent[],
  timelineGaps: StoredTimelineGap[],
  prevReadPos: string | undefined,
  syncFullyReadId: string | undefined,
  syncPrivateReadIds: string[],
): string | undefined {
  const candidates: string[] = [];
  if (prevReadPos) {
    candidates.push(prevReadPos);
  }
  if (syncFullyReadId) {
    candidates.push(syncFullyReadId);
  }
  for (const id of syncPrivateReadIds) {
    candidates.push(id);
  }
  if (candidates.length === 0) {
    return undefined;
  }
  const bestKnown = resolveFurthestInTimeline(timeline, candidates);
  if (bestKnown !== undefined) {
    const bestKnownIdx = timelineIndexOf(timeline, bestKnown);
    const hasGapAfterBestKnown = timelineGaps.some((gap) => {
      if (!gap.limited) {
        return false;
      }
      if (gap.pendingGapAtEnd) {
        return true;
      }
      const gapIdx = gap.gapBeforeEventId
        ? timelineIndexOf(timeline, gap.gapBeforeEventId)
        : -1;
      return gapIdx > bestKnownIdx;
    });
    if (hasGapAfterBestKnown) {
      const unknownIncoming = [syncFullyReadId, ...syncPrivateReadIds].find(
        (id): id is string =>
          id !== undefined &&
          id !== prevReadPos &&
          timelineIndexOf(timeline, id) === -1,
      );
      if (unknownIncoming !== undefined) {
        return unknownIncoming;
      }
      if (prevReadPos !== undefined && timelineIndexOf(timeline, prevReadPos) === -1) {
        return prevReadPos;
      }
    }
    return bestKnown;
  }
  const incomingFallback =
    syncPrivateReadIds[syncPrivateReadIds.length - 1] ?? syncFullyReadId;
  return incomingFallback ?? prevReadPos;
}

function mergeStateEvents(
  existing: RawMatrixEvent[],
  incoming: RawMatrixEvent[],
): RawMatrixEvent[] {
  const byKey = new Map<string, RawMatrixEvent>();
  for (const event of existing) {
    if (typeof event.type === "string" && typeof event.state_key === "string") {
      byKey.set(`${event.type}\0${event.state_key}`, cloneObject(event));
    }
  }
  for (const event of incoming) {
    if (typeof event.type === "string" && typeof event.state_key === "string") {
      byKey.set(`${event.type}\0${event.state_key}`, cloneObject(event));
    }
  }
  return Array.from(byKey.values());
}

function eventIdOf(event: RawMatrixEvent): string | undefined {
  if (localPlaceholderOf(event)) {
    return undefined;
  }
  return typeof event.event_id === "string" && event.event_id !== "" ? event.event_id : undefined;
}

function redactedEventIdOf(event: RawMatrixEvent): string | undefined {
  if (event.type !== "m.room.redaction") {
    return undefined;
  }
  if (typeof event.redacts === "string" && event.redacts !== "") {
    return event.redacts;
  }
  if (
    isPlainObject(event.content) &&
    typeof event.content.redacts === "string" &&
    event.content.redacts !== ""
  ) {
    return event.content.redacts;
  }
  return undefined;
}

function isRedactedStub(event: RawMatrixEvent): boolean {
  return isPlainObject(event.unsigned) && isPlainObject(event.unsigned.redacted_because);
}

function isAnnotationReactionEvent(event: RawMatrixEvent): boolean {
  if (event.type !== "m.reaction" || !isPlainObject(event.content)) {
    return false;
  }
  const relatesTo = event.content["m.relates_to"];
  return (
    isPlainObject(relatesTo) &&
    relatesTo.rel_type === "m.annotation" &&
    typeof relatesTo.event_id === "string" &&
    relatesTo.event_id !== "" &&
    typeof relatesTo.key === "string" &&
    relatesTo.key !== ""
  );
}

function shouldPreserveRedactedReaction(
  event: RawMatrixEvent,
  redactedIds: Set<string>,
): boolean {
  if (!isAnnotationReactionEvent(event)) {
    return false;
  }
  const targetId = reactionTargetIdOf(event);
  if (targetId === undefined || redactedIds.has(targetId)) {
    return false;
  }
  const id = eventIdOf(event);
  return isRedactedStub(event) || (id !== undefined && redactedIds.has(id));
}

function markRedactedReaction(event: RawMatrixEvent): RawMatrixEvent {
  const copy = cloneObject(event);
  const unsigned = isPlainObject(copy.unsigned) ? { ...copy.unsigned } : {};
  if (!isPlainObject(unsigned.redacted_because)) {
    unsigned.redacted_because = {};
  }
  copy.unsigned = unsigned;
  return copy;
}

function reactionTargetIdOf(event: RawMatrixEvent): string | undefined {
  if (event.type !== "m.reaction" || !isPlainObject(event.content)) {
    return undefined;
  }
  const relatesTo = event.content["m.relates_to"];
  if (
    isPlainObject(relatesTo) &&
    relatesTo.rel_type === "m.annotation" &&
    typeof relatesTo.event_id === "string" &&
    relatesTo.event_id !== ""
  ) {
    return relatesTo.event_id;
  }
  return undefined;
}

function replaceTargetIdOf(event: RawMatrixEvent): string | undefined {
  if (event.type !== "m.room.message" || !isPlainObject(event.content)) {
    return undefined;
  }
  const relatesTo = event.content["m.relates_to"];
  if (
    isPlainObject(relatesTo) &&
    relatesTo.rel_type === "m.replace" &&
    typeof relatesTo.event_id === "string" &&
    relatesTo.event_id !== ""
  ) {
    return relatesTo.event_id;
  }
  return undefined;
}

function mergeTimelineEventsWithRedactions(
  existing: RawMatrixEvent[],
  incoming: RawMatrixEvent[],
): {
  timeline: RawMatrixEvent[];
  redactedIds: Set<string>;
  changed: boolean;
  removedAttachmentIds: string[];
} {
  if (incoming.length === 0) {
    return {
      timeline: existing,
      redactedIds: new Set<string>(),
      changed: false,
      removedAttachmentIds: [],
    };
  }
  const redactedIds = new Set<string>();
  for (const event of [...existing, ...incoming]) {
    const targetId = redactedEventIdOf(event);
    if (targetId !== undefined) {
      redactedIds.add(targetId);
    }
    if (isRedactedStub(event)) {
      const id = eventIdOf(event);
      if (id !== undefined) {
        redactedIds.add(id);
      }
    }
  }

  const shouldOmit = (event: RawMatrixEvent): boolean => {
    if (event.type === "m.room.redaction" || isRedactedStub(event)) {
      return true;
    }
    const id = eventIdOf(event);
    if (id !== undefined && redactedIds.has(id)) {
      return true;
    }
    const replaceTarget = replaceTargetIdOf(event);
    if (replaceTarget !== undefined && redactedIds.has(replaceTarget)) {
      return true;
    }
    const reactionTarget = reactionTargetIdOf(event);
    if (reactionTarget !== undefined && redactedIds.has(reactionTarget)) {
      return true;
    }
    return false;
  };

  const result = existing
    .map((event) => {
      if (!shouldOmit(event)) {
        return cloneObject(event);
      }
      if (shouldPreserveRedactedReaction(event, redactedIds)) {
        return markRedactedReaction(event);
      }
      return undefined;
    })
    .filter((event): event is RawMatrixEvent => event !== undefined);
  const indexByEventId = new Map<string, number>();
  const indexByLocalTxnId = new Map<string, number>();
  result.forEach((event, index) => {
    const local = localPlaceholderOf(event);
    if (local) {
      indexByLocalTxnId.set(local.txnId, index);
      return;
    }
    const id = eventIdOf(event);
    if (id !== undefined) {
      indexByEventId.set(id, index);
    }
  });

  const removedAttachmentIds: string[] = [];

  for (const rawEvent of incoming) {
    let event: RawMatrixEvent;
    if (!shouldOmit(rawEvent)) {
      event = cloneObject(rawEvent);
    } else if (shouldPreserveRedactedReaction(rawEvent, redactedIds)) {
      event = markRedactedReaction(rawEvent);
    } else {
      continue;
    }
    const id = eventIdOf(event);
    const txnId = transactionIdOf(event);
    if (id !== undefined && indexByEventId.has(id)) {
      const existingIndex = indexByEventId.get(id)!;
      result[existingIndex] = event;
      if (txnId !== undefined && indexByLocalTxnId.has(txnId)) {
        indexByLocalTxnId.delete(txnId);
      }
    } else if (txnId !== undefined && indexByLocalTxnId.has(txnId)) {
      const localIndex = indexByLocalTxnId.get(txnId)!;
      const replacedLocal = localPlaceholderOf(result[localIndex]!);
      if (replacedLocal?.attachmentId) {
        removedAttachmentIds.push(replacedLocal.attachmentId);
      }
      result[localIndex] = event;
      indexByLocalTxnId.delete(txnId);
      if (id !== undefined) {
        indexByEventId.set(id, localIndex);
      }
    } else if (id !== undefined) {
      indexByEventId.set(id, result.length);
      result.push(event);
    } else {
      result.push(event);
    }
  }

  return { timeline: result, redactedIds, changed: true, removedAttachmentIds };
}

function mergeAccountData(
  current: Record<string, unknown>,
  body: unknown,
): Record<string, unknown> {
  const events = accountDataEvents(body);
  if (events === undefined) {
    return current;
  }
  const next = { ...current };
  for (const event of events) {
    next[event.type] = event.content;
  }
  return next;
}

function accountDataEvents(body: unknown): Array<{ type: string; content: unknown }> | undefined {
  if (!isPlainObject(body) || !isPlainObject(body.account_data) || !Array.isArray(body.account_data.events)) {
    return undefined;
  }
  return body.account_data.events.flatMap((item) => {
    if (!isPlainObject(item) || typeof item.type !== "string" || item.type === "") {
      return [];
    }
    return [{ type: item.type, content: item.content }];
  });
}

function nextBatch(body: unknown): string | undefined {
  if (!isPlainObject(body)) {
    return undefined;
  }
  const value = body.next_batch;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isAccountData(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function clonePendingEvent(item: PendingRoomEvent): PendingRoomEvent {
  return {
    txnId: item.txnId,
    roomId: item.roomId,
    type: item.type,
    sender: item.sender,
    content: cloneValue(item.content) as Record<string, unknown>,
    ...(item.order !== undefined ? { order: item.order } : {}),
    ...(item.attachmentId && item.attachmentMeta
      ? {
          attachmentId: item.attachmentId,
          attachmentMeta: { ...item.attachmentMeta },
        }
      : {}),
  };
}

function clonePendingEvents(raw: unknown[]): PendingRoomEvent[] {
  const out: PendingRoomEvent[] = [];
  for (const item of raw) {
    if (
      isPlainObject(item) &&
      typeof item.txnId === "string" &&
      item.txnId !== "" &&
      typeof item.roomId === "string" &&
      item.roomId !== "" &&
      typeof item.type === "string" &&
      item.type !== "" &&
      typeof item.sender === "string" &&
      item.sender !== "" &&
      isPlainObject(item.content)
    ) {
      const attachmentId =
        typeof item.attachmentId === "string" && item.attachmentId !== ""
          ? item.attachmentId
          : undefined;
      const attachmentMeta = normalizeAttachmentMeta(item.attachmentMeta);
      out.push(
        clonePendingEvent({
          txnId: item.txnId,
          roomId: item.roomId,
          type: item.type,
          sender: item.sender,
          content: item.content,
          ...(typeof item.order === "number" && Number.isFinite(item.order)
            ? { order: item.order }
            : {}),
          ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
        }),
      );
    }
  }
  return out;
}

function transactionIdOf(event: RawMatrixEvent): string | undefined {
  if (!isPlainObject(event.unsigned)) {
    return undefined;
  }
  const txnId = event.unsigned.transaction_id;
  return typeof txnId === "string" && txnId !== "" ? txnId : undefined;
}

function reconcilePendingWithSync(
  pending: PendingRoomEvent[],
  body: unknown,
): {
  pending: PendingRoomEvent[];
  deletedTxnIds: string[];
  removedAttachmentIds: string[];
} {
  if (pending.length === 0 || !isPlainObject(body) || !isPlainObject(body.rooms)) {
    return { pending, deletedTxnIds: [], removedAttachmentIds: [] };
  }
  const confirmedByRoom = new Map<string, Set<string>>();
  const leftRooms = new Set<string>();

  if (isPlainObject(body.rooms.join)) {
    for (const [roomId, roomSync] of Object.entries(body.rooms.join)) {
      if (
        isPlainObject(roomSync) &&
        isPlainObject(roomSync.timeline) &&
        Array.isArray(roomSync.timeline.events)
      ) {
        const txnIds = new Set<string>();
        const serverLimited = roomSync.timeline.limited === true;
        const rawEvents = roomSync.timeline.events.filter(isPlainObject);
        const events = serverLimited
          ? rawEvents.slice(-MAX_SYNC_TIMELINE_EVENTS_PER_ROOM)
          : rawEvents;
        for (const event of events) {
          const txnId = transactionIdOf(event);
          if (txnId) {
            txnIds.add(txnId);
          }
        }
        if (txnIds.size > 0) {
          confirmedByRoom.set(roomId, txnIds);
        }
      }
    }
  }

  if (isPlainObject(body.rooms.leave)) {
    for (const roomId of Object.keys(body.rooms.leave)) {
      leftRooms.add(roomId);
    }
  }

  if (confirmedByRoom.size === 0 && leftRooms.size === 0) {
    return { pending, deletedTxnIds: [], removedAttachmentIds: [] };
  }

  const deletedTxnIds: string[] = [];
  const removedAttachmentIds: string[] = [];
  const next = pending.filter((item) => {
    const confirmedTxns = confirmedByRoom.get(item.roomId);
    const shouldDelete =
      leftRooms.has(item.roomId) || Boolean(confirmedTxns && confirmedTxns.has(item.txnId));
    if (shouldDelete) {
      deletedTxnIds.push(item.txnId);
      if (item.attachmentId) {
        removedAttachmentIds.push(item.attachmentId);
      }
      return false;
    }
    return true;
  });

  return {
    pending: deletedTxnIds.length > 0 ? next : pending,
    deletedTxnIds,
    removedAttachmentIds,
  };
}

function normalizeAttachmentMeta(raw: unknown): AttachmentMeta | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  if (
    typeof raw.name !== "string" ||
    raw.name === "" ||
    typeof raw.mimeType !== "string" ||
    typeof raw.size !== "number" ||
    !Number.isFinite(raw.size) ||
    raw.size < 0
  ) {
    return undefined;
  }
  return {
    name: raw.name,
    mimeType: raw.mimeType,
    size: raw.size,
  };
}

function normalizeDraftRecord(raw: unknown): DraftRecord | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const text = typeof raw.text === "string" && raw.text.trim() !== "" ? raw.text : undefined;
  const attachmentId =
    typeof raw.attachmentId === "string" && raw.attachmentId !== "" ? raw.attachmentId : undefined;
  const attachmentMeta = normalizeAttachmentMeta(raw.attachmentMeta);
  if (text === undefined && (!attachmentId || !attachmentMeta)) {
    return undefined;
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
  };
}

function cloneDraftRecord(draft: DraftRecord): DraftRecord {
  return {
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.attachmentId && draft.attachmentMeta
      ? {
          attachmentId: draft.attachmentId,
          attachmentMeta: { ...draft.attachmentMeta },
        }
      : {}),
  };
}

function cloneDrafts(raw: Record<string, unknown>): Record<string, DraftRecord> {
  const out: Record<string, DraftRecord> = {};
  for (const [roomId, value] of Object.entries(raw)) {
    if (!roomId) {
      continue;
    }
    const normalized = normalizeDraftRecord(value);
    if (normalized) {
      out[roomId] = normalized;
    }
  }
  return out;
}

function reconcileDraftsWithSync(
  drafts: Record<string, DraftRecord>,
  body: unknown,
): {
  drafts: Record<string, DraftRecord>;
  deletedRoomIds: string[];
  removedAttachmentIds: string[];
} {
  if (Object.keys(drafts).length === 0 || !isPlainObject(body) || !isPlainObject(body.rooms)) {
    return { drafts, deletedRoomIds: [], removedAttachmentIds: [] };
  }
  const leaveRooms = body.rooms.leave;
  if (!isPlainObject(leaveRooms)) {
    return { drafts, deletedRoomIds: [], removedAttachmentIds: [] };
  }
  const leaveKeys = Object.keys(leaveRooms);
  if (leaveKeys.length === 0) {
    return { drafts, deletedRoomIds: [], removedAttachmentIds: [] };
  }
  const deletedRoomIds: string[] = [];
  const removedAttachmentIds: string[] = [];
  const next = { ...drafts };
  for (const roomId of leaveKeys) {
    if (roomId in next) {
      const removed = next[roomId]!;
      if (removed.attachmentId) {
        removedAttachmentIds.push(removed.attachmentId);
      }
      delete next[roomId];
      deletedRoomIds.push(roomId);
    }
  }
  return {
    drafts: deletedRoomIds.length > 0 ? next : drafts,
    deletedRoomIds,
    removedAttachmentIds,
  };
}

function clonePendingReadMarkers(raw: unknown[]): PendingReadMarker[] {
  const byRoom = new Map<string, PendingReadMarker>();
  for (const item of raw) {
    if (
      isPlainObject(item) &&
      typeof item.roomId === "string" &&
      item.roomId !== "" &&
      typeof item.eventId === "string" &&
      item.eventId !== ""
    ) {
      byRoom.set(item.roomId, { roomId: item.roomId, eventId: item.eventId });
    }
  }
  return Array.from(byRoom.values());
}

function reconcilePendingReadMarkersWithSync(
  pending: PendingReadMarker[],
  rooms: Record<string, StoredRoomEvents>,
  body: unknown,
): { markers: PendingReadMarker[]; deletedRoomIds: string[] } {
  if (pending.length === 0) {
    return { markers: pending, deletedRoomIds: [] };
  }
  const leftRooms = new Set<string>();
  if (isPlainObject(body) && isPlainObject(body.rooms) && isPlainObject(body.rooms.leave)) {
    for (const roomId of Object.keys(body.rooms.leave)) {
      leftRooms.add(roomId);
    }
  }
  const deletedRoomIds: string[] = [];
  const markers = pending.filter((item) => {
    if (leftRooms.has(item.roomId)) {
      deletedRoomIds.push(item.roomId);
      return false;
    }
    const room = rooms[item.roomId];
    if (!room || !room.readPositionEventId) {
      return true;
    }
    if (room.readPositionEventId === item.eventId) {
      const syncedBoth =
        room.fullyReadEventId === item.eventId &&
        room.privateReadEventId === item.eventId;
      if (syncedBoth) {
        deletedRoomIds.push(item.roomId);
      }
      return !syncedBoth;
    }
    const pendingIdx = timelineIndexOf(room.timelineEvents, item.eventId);
    const adoptedIdx = timelineIndexOf(room.timelineEvents, room.readPositionEventId);
    if (pendingIdx !== -1 && adoptedIdx !== -1 && adoptedIdx > pendingIdx) {
      deletedRoomIds.push(item.roomId);
      return false;
    }
    if (pendingIdx !== -1 && adoptedIdx === -1) {
      deletedRoomIds.push(item.roomId);
      return false;
    }
    return true;
  });
  return {
    markers: deletedRoomIds.length > 0 ? markers : pending,
    deletedRoomIds,
  };
}

export function parseMxcUri(uri: string): { serverName: string; mediaId: string } | undefined {
  if (!uri.startsWith("mxc://")) {
    return undefined;
  }
  const rest = uri.slice("mxc://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) {
    return undefined;
  }
  const serverName = rest.slice(0, slashIdx);
  const mediaId = rest.slice(slashIdx + 1);
  if (!serverName || !mediaId || mediaId.includes("/")) {
    return undefined;
  }
  return { serverName, mediaId };
}

export function localPlaceholderOf(event: RawMatrixEvent): WaypointLocalMeta | undefined {
  if (!isPlainObject(event.waypoint_local)) {
    return undefined;
  }
  const raw = event.waypoint_local;
  if (
    typeof raw.id !== "string" ||
    raw.id === "" ||
    (raw.status !== "unconfirmed" && raw.status !== "failed") ||
    typeof raw.txnId !== "string" ||
    raw.txnId === ""
  ) {
    return undefined;
  }
  const attachmentId =
    typeof raw.attachmentId === "string" && raw.attachmentId !== ""
      ? raw.attachmentId
      : undefined;
  const attachmentMeta =
    normalizeAttachmentMeta(raw.attachmentMeta) ?? normalizeAttachmentMeta(raw.attachment);
  return {
    id: raw.id,
    status: raw.status,
    txnId: raw.txnId,
    ...(attachmentId ? { attachmentId } : {}),
    ...(attachmentMeta ? { attachmentMeta } : {}),
  };
}

function boundAgentUserIdFromState(stateEvents: RawMatrixEvent[]): string | undefined {
  for (let i = stateEvents.length - 1; i >= 0; i -= 1) {
    const ev = stateEvents[i];
    if (
      ev.type === "im.waypoint.topic" &&
      ev.state_key === "" &&
      isPlainObject(ev.content) &&
      ev.content.v === 1 &&
      typeof ev.content.agent_user_id === "string"
    ) {
      return ev.content.agent_user_id;
    }
  }
  return undefined;
}
