import type { HomeserverTransport, TransportResult } from "../adapters/types";
import { isCredentialRejected } from "./matrix-errors";
import {
  dropCredential,
  dropPreListSession,
  loadSession,
  saveSession,
  type DraftAttachment,
  type DraftRecord,
  type PendingReadMarker,
  type PendingRoomEvent,
  type RawMatrixEvent,
  type SessionRecord,
  type StoredRoomEvents,
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
  private leaveGeneration = 0;
  private tokenGeneration = 0;
  private credentialRejectedHandler?: (result: TransportResult) => void;
  private leftAtGeneration = new Map<string, number>();
  private tagGeneration = 0;
  private tagUpdatedAtGeneration = new Map<string, number>();
  private persistTail: Promise<void> = Promise.resolve();

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

  get currentDeviceId(): string | undefined {
    return this.deviceId;
  }

  setCredentialRejectedHandler(handler?: (result: TransportResult) => void): void {
    this.credentialRejectedHandler = handler;
  }

  accountData(type: string): unknown {
    return this.storedAccountData[type];
  }

  rooms(): Record<string, StoredRoomEvents> {
    return this.storedRooms;
  }

  draft(roomId: string): DraftRecord | undefined {
    const existing = this.storedDrafts[roomId];
    return existing ? cloneDraftRecord(existing) : undefined;
  }

  drafts(): Record<string, DraftRecord> {
    return cloneDrafts(this.storedDrafts);
  }

  async setDraft(roomId: string, draft: DraftRecord | undefined): Promise<void> {
    const normalized = normalizeDraftRecord(draft);
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const nextDrafts = cloneDrafts(this.storedDrafts);
      if (normalized) {
        nextDrafts[roomId] = normalized;
      } else {
        if (!(roomId in nextDrafts)) {
          return;
        }
        delete nextDrafts[roomId];
      }
      await saveSession(this.sessionRecord({ drafts: nextDrafts }));
      this.storedDrafts = nextDrafts;
    });
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
    const stored = await loadSession();
    if (!stored?.baseUrl) {
      return "address";
    }
    this.baseUrl = stored.baseUrl;
    this.userId = stored.userId;
    this.syncCursor = stored.syncCursor;
    this.storedAccountData = isAccountData(stored.accountData) ? stored.accountData : {};
    this.storedRooms = isPlainObject(stored.rooms) ? cloneStoredRooms(stored.rooms) : {};
    this.storedPendingEvents = Array.isArray(stored.pendingEvents)
      ? clonePendingEvents(stored.pendingEvents)
      : [];
    this.storedPendingReadMarkers = Array.isArray(stored.pendingReadMarkers)
      ? clonePendingReadMarkers(stored.pendingReadMarkers)
      : [];
    this.storedDrafts = isPlainObject(stored.drafts) ? cloneDrafts(stored.drafts) : {};
    if (stored.accessToken && stored.deviceId) {
      this.accessToken = stored.accessToken;
      this.deviceId = stored.deviceId;
      return "sync";
    }
    if (stored.userId) {
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
    this.tokenGeneration += 1;
    await this.enqueuePersist(() => {
      this.accessToken = accessToken;
      if (deviceId) {
        this.deviceId = deviceId;
      }
      return saveSession(this.sessionRecord());
    });
  }

  async rememberLogin(userId: string, accessToken: string, deviceId: string): Promise<void> {
    this.tokenGeneration += 1;
    await this.enqueuePersist(() => {
      this.userId = userId;
      this.accessToken = accessToken;
      this.deviceId = deviceId;
      this.syncCursor = undefined;
      this.storedAccountData = {};
      this.storedRooms = {};
      this.storedPendingEvents = [];
      this.storedPendingReadMarkers = [];
      this.storedDrafts = {};
      this.leaveGeneration = 0;
      this.leftAtGeneration.clear();
      this.tagGeneration = 0;
      this.tagUpdatedAtGeneration.clear();
      return saveSession({
        baseUrl: this.baseUrl,
        userId,
        accessToken,
        deviceId,
      });
    });
  }

  private authedRequest(input: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    body?: unknown;
    json?: boolean;
  }): Promise<TransportResult> {
    const requestToken = this.accessToken;
    if (!requestToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    const generation = this.tokenGeneration;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${requestToken}`,
    };
    if (input.json) {
      headers["Content-Type"] = "application/json";
    }
    return this.transport
      .request({
        method: input.method,
        url: input.url,
        headers,
        ...(input.body !== undefined ? { body: input.body } : {}),
      })
      .then((result) => {
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

  sync(): Promise<SyncAttempt> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    const cursor = this.syncCursor;
    const generation = this.leaveGeneration;
    const tagGen = this.tagGeneration;
    const url = cursor
      ? `${matrixUrl(this.baseUrl, "/_matrix/client/v3/sync")}?since=${encodeURIComponent(cursor)}`
      : matrixUrl(this.baseUrl, "/_matrix/client/v3/sync");
    return this.authedRequest({ method: "GET", url }).then((result) => ({
      result,
      incremental: Boolean(cursor),
      leaveGeneration: generation,
      tagGeneration: tagGen,
    }));
  }

  async dropSyncCursor(): Promise<void> {
    await this.enqueuePersist(() => {
      if (!this.accessToken) {
        return Promise.resolve();
      }
      this.syncCursor = undefined;
      return saveSession(this.sessionRecord());
    });
  }

  async retainSync(attempt: SyncAttempt): Promise<void> {
    if (attempt.result.type !== "response" || attempt.result.status !== 200) {
      return;
    }
    const body = attempt.result.body;
    await this.enqueuePersist(() => {
      if (!this.accessToken) {
        return Promise.resolve();
      }
      this.storedAccountData = mergeAccountData(this.storedAccountData, body);
      this.storedRooms = mergeSyncRooms(
        this.storedRooms,
        body,
        this.userId,
        attempt.leaveGeneration,
        this.leftAtGeneration,
        attempt.tagGeneration,
        this.tagUpdatedAtGeneration,
      );
      this.storedPendingEvents = reconcilePendingWithSync(this.storedPendingEvents, body);
      this.storedPendingReadMarkers = reconcilePendingReadMarkersWithSync(
        this.storedPendingReadMarkers,
        this.storedRooms,
        body,
      );
      this.storedDrafts = reconcileDraftsWithSync(this.storedDrafts, body);
      const cursor = nextBatch(body);
      if (cursor) {
        this.syncCursor = cursor;
      }
      return saveSession(this.sessionRecord());
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
      const nextRooms = cloneStoredRooms(this.storedRooms);
      nextRooms[roomId] = applied.room;
      await saveSession(this.sessionRecord({ rooms: nextRooms }));
      this.storedRooms = nextRooms;
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
    await this.enqueuePersist(() => {
      if (!this.accessToken) {
        return Promise.resolve();
      }
      this.storedAccountData = { ...this.storedAccountData, [type]: content };
      return saveSession(this.sessionRecord());
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
    this.tagGeneration += 1;
    this.tagUpdatedAtGeneration.set(roomId, this.tagGeneration);
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const existing = this.storedRooms[roomId];
      if (!existing) {
        return;
      }
      const nextRooms = cloneStoredRooms(this.storedRooms);
      const room = nextRooms[roomId];
      const nextTags: Record<string, unknown> = isPlainObject(room.tags) ? { ...room.tags } : {};
      if (content !== undefined) {
        nextTags[tag] = cloneValue(content);
      } else {
        delete nextTags[tag];
      }
      if (Object.keys(nextTags).length > 0) {
        room.tags = nextTags;
      } else {
        delete room.tags;
      }
      await saveSession(this.sessionRecord({ rooms: nextRooms }));
      this.storedRooms = nextRooms;
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
    this.leaveGeneration += 1;
    this.leftAtGeneration.set(roomId, this.leaveGeneration);
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        return;
      }
      const nextRooms = cloneStoredRooms(this.storedRooms);
      delete nextRooms[roomId];
      const nextPending = this.storedPendingEvents.filter((item) => item.roomId !== roomId);
      const nextPendingReadMarkers = this.storedPendingReadMarkers.filter(
        (item) => item.roomId !== roomId,
      );
      const nextDrafts = cloneDrafts(this.storedDrafts);
      delete nextDrafts[roomId];
      await saveSession(
        this.sessionRecord({
          rooms: nextRooms,
          pending: nextPending,
          pendingReadMarkers: nextPendingReadMarkers,
          drafts: nextDrafts,
        }),
      );
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

  async enqueueRoomEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
    options?: { clearDraft?: boolean },
  ): Promise<PendingRoomEvent> {
    if (!this.accessToken || !this.userId) {
      throw new Error("没有 access token");
    }
    const item: PendingRoomEvent = {
      txnId: this.nextTxnId(),
      roomId,
      type,
      sender: this.userId,
      content: cloneValue(content) as Record<string, unknown>,
    };
    await this.enqueuePersist(async () => {
      if (!this.accessToken) {
        throw new Error("没有 access token");
      }
      const nextPending = [...this.storedPendingEvents, item];
      let nextRooms = this.storedRooms;
      if (type === "m.room.message") {
        nextRooms = cloneStoredRooms(this.storedRooms);
        const existingRoom = nextRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
        existingRoom.timelineEvents.push({
          type,
          sender: this.userId,
          content: cloneValue(content),
          waypoint_local: {
            id: item.txnId,
            status: "unconfirmed",
            txnId: item.txnId,
          },
        });
        nextRooms[roomId] = existingRoom;
      }
      let nextDrafts = this.storedDrafts;
      if (options?.clearDraft && roomId in this.storedDrafts) {
        nextDrafts = cloneDrafts(this.storedDrafts);
        delete nextDrafts[roomId];
      }
      await saveSession(this.sessionRecord({ pending: nextPending, rooms: nextRooms, drafts: nextDrafts }));
      this.storedPendingEvents = nextPending;
      this.storedRooms = nextRooms;
      this.storedDrafts = nextDrafts;
    });
    return clonePendingEvent(item);
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
    let changed = false;
    await this.enqueuePersist(async () => {
      if (!this.accessToken || !this.userId) {
        return;
      }
      const room = this.storedRooms[roomId];
      if (!room) {
        return;
      }
      const targetIdx = timelineIndexOf(room.timelineEvents, eventId);
      if (targetIdx === -1) {
        return;
      }
      if (room.readPositionEventId !== undefined) {
        if (room.readPositionEventId === eventId) {
          return;
        }
        const currentIdx = timelineIndexOf(room.timelineEvents, room.readPositionEventId);
        if (currentIdx === -1 || targetIdx <= currentIdx) {
          return;
        }
      }
      const nextRooms = cloneStoredRooms(this.storedRooms);
      nextRooms[roomId] = {
        ...nextRooms[roomId],
        readPositionEventId: eventId,
      };
      const nextPendingReadMarkers = this.storedPendingReadMarkers.filter(
        (item) => item.roomId !== roomId,
      );
      nextPendingReadMarkers.push({ roomId, eventId });
      await saveSession(
        this.sessionRecord({ rooms: nextRooms, pendingReadMarkers: nextPendingReadMarkers }),
      );
      this.storedRooms = nextRooms;
      this.storedPendingReadMarkers = nextPendingReadMarkers;
      changed = true;
    });
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
      const nextPendingReadMarkers =
        currentPending && currentPending.eventId === eventId
          ? this.storedPendingReadMarkers.filter((item) => item.roomId !== roomId)
          : this.storedPendingReadMarkers;

      const nextRooms = cloneStoredRooms(this.storedRooms);
      const room = nextRooms[roomId];
      let roomsChanged = false;
      if (room) {
        const eventIdx = timelineIndexOf(room.timelineEvents, eventId);
        const fullyIdx = timelineIndexOf(room.timelineEvents, room.fullyReadEventId);
        const privateIdx = timelineIndexOf(room.timelineEvents, room.privateReadEventId);
        const nextFully =
          room.fullyReadEventId === undefined || (eventIdx !== -1 && (fullyIdx === -1 || eventIdx > fullyIdx))
            ? eventId
            : room.fullyReadEventId;
        const nextPrivate =
          room.privateReadEventId === undefined || (eventIdx !== -1 && (privateIdx === -1 || eventIdx > privateIdx))
            ? eventId
            : room.privateReadEventId;
        const readIdx = timelineIndexOf(room.timelineEvents, room.readPositionEventId);
        const nextRead =
          room.readPositionEventId === undefined || (eventIdx !== -1 && readIdx !== -1 && eventIdx > readIdx)
            ? eventId
            : room.readPositionEventId;
        if (
          nextFully !== room.fullyReadEventId ||
          nextPrivate !== room.privateReadEventId ||
          nextRead !== room.readPositionEventId
        ) {
          nextRooms[roomId] = {
            ...room,
            readPositionEventId: nextRead,
            fullyReadEventId: nextFully,
            privateReadEventId: nextPrivate,
          };
          roomsChanged = true;
        }
      }
      if (nextPendingReadMarkers === this.storedPendingReadMarkers && !roomsChanged) {
        return;
      }
      await saveSession(
        this.sessionRecord({
          ...(roomsChanged ? { rooms: nextRooms } : {}),
          pendingReadMarkers: nextPendingReadMarkers,
        }),
      );
      if (roomsChanged) {
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
      const nextRooms = cloneStoredRooms(this.storedRooms);
      const existingRoom = nextRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const alreadyConfirmed = existingRoom.timelineEvents.some(
        (ev) => !localPlaceholderOf(ev) && (eventIdOf(ev) === eventId || transactionIdOf(ev) === txnId),
      );
      const placeholderIndex = existingRoom.timelineEvents.findIndex(
        (ev) => localPlaceholderOf(ev)?.txnId === txnId,
      );
      if (!alreadyConfirmed) {
        const placeholder = placeholderIndex !== -1 ? existingRoom.timelineEvents[placeholderIndex] : undefined;
        const source = pending ?? (placeholder && typeof placeholder.type === "string" && typeof placeholder.sender === "string" && isPlainObject(placeholder.content) ? { type: placeholder.type, sender: placeholder.sender, content: placeholder.content } : undefined);
        if (source) {
          const confirmedEvent: RawMatrixEvent = {
            type: source.type,
            event_id: eventId,
            sender: source.sender,
            content: cloneValue(source.content),
            unsigned: { transaction_id: txnId },
          };
          if (placeholderIndex !== -1) {
            existingRoom.timelineEvents[placeholderIndex] = confirmedEvent;
          } else {
            existingRoom.timelineEvents.push(confirmedEvent);
          }
          nextRooms[roomId] = existingRoom;
        }
      } else if (placeholderIndex !== -1) {
        existingRoom.timelineEvents.splice(placeholderIndex, 1);
        nextRooms[roomId] = existingRoom;
      }
      await saveSession(this.sessionRecord({ pending: nextPending, rooms: nextRooms }));
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
      const nextRooms = cloneStoredRooms(this.storedRooms);
      const existingRoom = nextRooms[roomId];
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
      const newTxnId = this.nextTxnId();
      const item: PendingRoomEvent = {
        txnId: newTxnId,
        roomId,
        type: placeholder.type,
        sender: placeholder.sender,
        content: cloneValue(placeholder.content) as Record<string, unknown>,
      };
      existingRoom.timelineEvents[placeholderIndex] = {
        ...placeholder,
        waypoint_local: {
          id: localId,
          status: "unconfirmed",
          txnId: newTxnId,
        },
      };
      const nextPending = [...this.storedPendingEvents, item];
      await saveSession(this.sessionRecord({ pending: nextPending, rooms: nextRooms }));
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
      const nextRooms = cloneStoredRooms(this.storedRooms);
      const existingRoom = nextRooms[roomId];
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
      existingRoom.timelineEvents.splice(placeholderIndex, 1);
      await saveSession(this.sessionRecord({ rooms: nextRooms }));
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
      const nextRooms = cloneStoredRooms(this.storedRooms);
      const existingRoom = nextRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const placeholderIndex = existingRoom.timelineEvents.findIndex(
        (ev) => localPlaceholderOf(ev)?.txnId === txnId,
      );
      if (placeholderIndex !== -1) {
        const placeholder = existingRoom.timelineEvents[placeholderIndex];
        const meta = localPlaceholderOf(placeholder)!;
        existingRoom.timelineEvents[placeholderIndex] = {
          ...placeholder,
          waypoint_local: {
            id: meta.id,
            status: "failed",
            txnId,
          },
        };
        nextRooms[roomId] = existingRoom;
      } else if (pending && pending.type === "m.room.message") {
        existingRoom.timelineEvents.push({
          type: pending.type,
          sender: pending.sender,
          content: cloneValue(pending.content),
          waypoint_local: {
            id: pending.txnId,
            status: "failed",
            txnId: pending.txnId,
          },
        });
        nextRooms[roomId] = existingRoom;
      }
      await saveSession(this.sessionRecord({ pending: nextPending, rooms: nextRooms }));
      this.storedPendingEvents = nextPending;
      this.storedRooms = nextRooms;
    });
  }

  async rememberRoomStateEvents(
    roomId: string,
    stateEvents: RawMatrixEvent[],
  ): Promise<void> {
    await this.enqueuePersist(() => {
      if (!this.accessToken) {
        return Promise.resolve();
      }
      const existing = this.storedRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const gaps = roomTimelineGaps(existing).map((g) => ({ ...g }));
      this.storedRooms = {
        ...this.storedRooms,
        [roomId]: {
          ...existing,
          stateEvents: mergeStateEvents(existing.stateEvents, stateEvents),
          timelineEvents: existing.timelineEvents.map(cloneObject),
          ...(gaps.length > 0 ? { timelineGap: { ...gaps[0] }, timelineGaps: gaps } : {}),
        },
      };
      return saveSession(this.sessionRecord());
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
    await this.enqueuePersist(() => {
      this.accessToken = undefined;
      this.deviceId = undefined;
      this.syncCursor = undefined;
      this.storedAccountData = {};
      this.storedRooms = {};
      this.storedPendingEvents = [];
      this.storedPendingReadMarkers = [];
      this.storedDrafts = {};
      this.leaveGeneration = 0;
      this.leftAtGeneration.clear();
      this.tagGeneration = 0;
      this.tagUpdatedAtGeneration.clear();
      return dropPreListSession();
    });
  }

  async forgetCredential(): Promise<void> {
    this.tokenGeneration += 1;
    await this.enqueuePersist(() => {
      this.accessToken = undefined;
      this.deviceId = undefined;
      return dropCredential();
    });
  }

  private sessionRecord(overrides?: {
    pending?: PendingRoomEvent[];
    pendingReadMarkers?: PendingReadMarker[];
    rooms?: Record<string, StoredRoomEvents>;
    drafts?: Record<string, DraftRecord>;
  }): SessionRecord {
    const session: SessionRecord = {
      baseUrl: this.baseUrl,
      userId: this.userId,
      accessToken: this.accessToken,
      deviceId: this.deviceId,
    };
    if (this.syncCursor) {
      session.syncCursor = this.syncCursor;
    }
    if (Object.keys(this.storedAccountData).length > 0) {
      session.accountData = this.storedAccountData;
    }
    const rooms = overrides?.rooms ?? this.storedRooms;
    if (Object.keys(rooms).length > 0) {
      session.rooms = rooms;
    }
    const pending = overrides?.pending ?? this.storedPendingEvents;
    if (pending.length > 0) {
      session.pendingEvents = pending;
    }
    const pendingReadMarkers = overrides?.pendingReadMarkers ?? this.storedPendingReadMarkers;
    if (pendingReadMarkers.length > 0) {
      session.pendingReadMarkers = pendingReadMarkers;
    }
    const drafts = overrides?.drafts ?? this.storedDrafts;
    if (Object.keys(drafts).length > 0) {
      session.drafts = cloneDrafts(drafts);
    }
    return session;
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
    const run = this.persistTail.then(() => write());
    this.persistTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function matrixUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
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
  if (timelineIndexOf(room.timelineEvents, room.readPositionEventId) !== -1) {
    return undefined;
  }
  const gaps = roomTimelineGaps(room);
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

function cloneStoredRooms(rooms: Record<string, unknown>): Record<string, StoredRoomEvents> {
  const cloned: Record<string, StoredRoomEvents> = {};
  for (const [roomId, value] of Object.entries(rooms)) {
    if (!isPlainObject(value)) {
      continue;
    }
    const stateEvents = Array.isArray(value.stateEvents)
      ? value.stateEvents.filter(isPlainObject).map(cloneObject)
      : [];
    const timelineEvents = Array.isArray(value.timelineEvents)
      ? value.timelineEvents.filter(isPlainObject).map(cloneObject)
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
): Record<string, StoredRoomEvents> {
  const next: Record<string, StoredRoomEvents> = cloneStoredRooms(current);
  if (!isPlainObject(body) || !isPlainObject(body.rooms)) {
    return next;
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
      const rawTimeline = rawTimelineAll.slice(-MAX_SYNC_TIMELINE_EVENTS_PER_ROOM);
      const isLimited =
        (isPlainObject(roomSync.timeline) && roomSync.timeline.limited === true) ||
        rawTimelineAll.length > MAX_SYNC_TIMELINE_EVENTS_PER_ROOM;
      const prevBatch =
        isPlainObject(roomSync.timeline) &&
        typeof roomSync.timeline.prev_batch === "string" &&
        roomSync.timeline.prev_batch !== ""
          ? roomSync.timeline.prev_batch
          : undefined;
      const { timeline: mergedTimeline, redactedIds } = mergeTimelineEventsWithRedactions(
        existing.timelineEvents,
        rawTimeline,
      );
      const existingIds = new Set(
        existing.timelineEvents.map(eventIdOf).filter((id): id is string => id !== undefined),
      );
      const mergedIds = new Set(
        mergedTimeline.map(eventIdOf).filter((id): id is string => id !== undefined),
      );
      const firstNewInBatch = mergedTimeline
        .map(eventIdOf)
        .find((id): id is string => id !== undefined && !existingIds.has(id));

      let nextGaps = reconcileGapsAfterTimelineChange(
        roomTimelineGaps(existing),
        existing.timelineEvents,
        mergedIds,
        firstNewInBatch,
      );
      if (isLimited) {
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
      const tagLocked = tagGeneration !== undefined && tagUpdatedAtGeneration !== undefined && (tagUpdatedAtGeneration.get(roomId) ?? 0) > tagGeneration;
      const nextTags = tagLocked ? existing.tags : (syncTags ?? existing.tags);
      const syncFullyReadId = extractFullyReadEventId(roomSync);
      const syncPrivateReadIds = extractPrivateReadEventIds(roomSync, ownerUserId);
      const nextFullyReadEventId = syncFullyReadId ?? existing.fullyReadEventId;
      const bestIncomingPrivateReadId = resolveFurthestInTimeline(
        mergedTimeline,
        syncPrivateReadIds,
      ) ?? syncPrivateReadIds[syncPrivateReadIds.length - 1];
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

      next[roomId] = {
        stateEvents: mergeStateEvents(existing.stateEvents, [
          ...rawState,
          ...timelineStateEvents,
        ]),
        timelineEvents: mergedTimeline,
        ...(nextGaps.length > 0 ? { timelineGap: { ...nextGaps[0] }, timelineGaps: nextGaps } : {}),
        ...(nextBackwardToken && !nextReachedStart ? { backwardToken: nextBackwardToken } : {}),
        ...(nextReachedStart ? { reachedStart: true } : {}),
        ...(nextReadPositionEventId ? { readPositionEventId: nextReadPositionEventId } : {}),
        ...(nextFullyReadEventId ? { fullyReadEventId: nextFullyReadEventId } : {}),
        ...(nextPrivateReadEventId ? { privateReadEventId: nextPrivateReadEventId } : {}),
        ...(nextTags && Object.keys(nextTags).length > 0 ? { tags: nextTags } : {}),
      };
    }
  }

  const leaveRooms = body.rooms.leave;
  if (isPlainObject(leaveRooms)) {
    for (const roomId of Object.keys(leaveRooms)) {
      delete next[roomId];
    }
  }

  return next;
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

  const filteredBefore = beforeSlice.filter((ev) => !shouldOmit(ev)).map(cloneObject);
  const filteredAfter = afterSlice.filter((ev) => !shouldOmit(ev)).map(cloneObject);

  const seenIncomingIds = new Set<string>();
  const dedupedIncoming: RawMatrixEvent[] = [];
  for (const rawEvent of incomingChronological) {
    if (shouldOmit(rawEvent)) {
      continue;
    }
    const id = eventIdOf(rawEvent);
    if (id !== undefined) {
      if (beforeIds.has(id) || afterIds.has(id) || seenIncomingIds.has(id)) {
        continue;
      }
      seenIncomingIds.add(id);
    }
    dedupedIncoming.push(cloneObject(rawEvent));
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

function timelineIndexOf(timeline: RawMatrixEvent[], eventId: string | undefined): number {
  if (!eventId) {
    return -1;
  }
  return timeline.findIndex((event) => eventIdOf(event) === eventId);
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
): { timeline: RawMatrixEvent[]; redactedIds: Set<string> } {
  if (incoming.length === 0) {
    return { timeline: existing.map(cloneObject), redactedIds: new Set<string>() };
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
    return false;
  };

  const result = existing.filter((event) => !shouldOmit(event)).map(cloneObject);
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

  for (const rawEvent of incoming) {
    if (shouldOmit(rawEvent)) {
      continue;
    }
    const event = cloneObject(rawEvent);
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

  return { timeline: result, redactedIds };
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
      out.push(
        clonePendingEvent({
          txnId: item.txnId,
          roomId: item.roomId,
          type: item.type,
          sender: item.sender,
          content: item.content,
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
): PendingRoomEvent[] {
  if (pending.length === 0 || !isPlainObject(body) || !isPlainObject(body.rooms)) {
    return pending;
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
        const events = roomSync.timeline.events
          .filter(isPlainObject)
          .slice(-MAX_SYNC_TIMELINE_EVENTS_PER_ROOM);
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
    return pending;
  }

  return pending.filter((item) => {
    if (leftRooms.has(item.roomId)) {
      return false;
    }
    const confirmedTxns = confirmedByRoom.get(item.roomId);
    if (confirmedTxns && confirmedTxns.has(item.txnId)) {
      return false;
    }
    return true;
  });
}

function toUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return undefined;
}

function cloneDraftAttachment(raw: unknown): DraftAttachment | undefined {
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
  const data = toUint8Array(raw.data);
  if (!data) {
    return undefined;
  }
  return {
    name: raw.name,
    mimeType: raw.mimeType,
    size: raw.size,
    data,
  };
}

function normalizeDraftRecord(raw: unknown): DraftRecord | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const text = typeof raw.text === "string" && raw.text.trim() !== "" ? raw.text : undefined;
  const attachment = cloneDraftAttachment(raw.attachment);
  if (text === undefined && attachment === undefined) {
    return undefined;
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(attachment !== undefined ? { attachment } : {}),
  };
}

function cloneDraftRecord(draft: DraftRecord): DraftRecord {
  return {
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.attachment !== undefined
      ? {
          attachment: {
            name: draft.attachment.name,
            mimeType: draft.attachment.mimeType,
            size: draft.attachment.size,
            data: new Uint8Array(draft.attachment.data),
          },
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
): Record<string, DraftRecord> {
  if (Object.keys(drafts).length === 0 || !isPlainObject(body) || !isPlainObject(body.rooms)) {
    return drafts;
  }
  const leaveRooms = body.rooms.leave;
  if (!isPlainObject(leaveRooms)) {
    return drafts;
  }
  const leaveKeys = Object.keys(leaveRooms);
  if (leaveKeys.length === 0) {
    return drafts;
  }
  let changed = false;
  const next = cloneDrafts(drafts);
  for (const roomId of leaveKeys) {
    if (roomId in next) {
      delete next[roomId];
      changed = true;
    }
  }
  return changed ? next : drafts;
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
): PendingReadMarker[] {
  if (pending.length === 0) {
    return pending;
  }
  const leftRooms = new Set<string>();
  if (isPlainObject(body) && isPlainObject(body.rooms) && isPlainObject(body.rooms.leave)) {
    for (const roomId of Object.keys(body.rooms.leave)) {
      leftRooms.add(roomId);
    }
  }
  return pending.filter((item) => {
    if (leftRooms.has(item.roomId)) {
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
      return !syncedBoth;
    }
    const pendingIdx = timelineIndexOf(room.timelineEvents, item.eventId);
    const adoptedIdx = timelineIndexOf(room.timelineEvents, room.readPositionEventId);
    if (pendingIdx !== -1 && adoptedIdx !== -1 && adoptedIdx > pendingIdx) {
      return false;
    }
    if (pendingIdx !== -1 && adoptedIdx === -1) {
      return false;
    }
    return true;
  });
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
  return {
    id: raw.id,
    status: raw.status,
    txnId: raw.txnId,
  };
}
