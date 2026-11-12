import type { HomeserverTransport, TransportResult } from "../adapters/types";
import {
  dropCredential,
  dropPreListSession,
  loadSession,
  saveSession,
  type DraftAttachment,
  type DraftRecord,
  type PendingRoomEvent,
  type RawMatrixEvent,
  type SessionRecord,
  type StoredRoomEvents,
  type StoredTimelineGap,
} from "./session-store";

const MAX_SYNC_TIMELINE_EVENTS_PER_ROOM = 20;

export type SyncAttempt = {
  result: TransportResult;
  incremental: boolean;
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
  private storedDrafts: Record<string, DraftRecord> = {};
  private txnCounter = 0;
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

  passwordLogin(user: string, password: string, displayName: string): Promise<TransportResult> {
    return this.transport.request({
      method: "POST",
      url: matrixUrl(this.baseUrl, "/_matrix/client/v3/login"),
      headers: { "Content-Type": "application/json" },
      body: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password,
        initial_device_display_name: displayName,
      },
    });
  }

  async rememberLogin(userId: string, accessToken: string, deviceId: string): Promise<void> {
    await this.enqueuePersist(() => {
      this.userId = userId;
      this.accessToken = accessToken;
      this.deviceId = deviceId;
      this.syncCursor = undefined;
      this.storedAccountData = {};
      this.storedRooms = {};
      this.storedPendingEvents = [];
      this.storedDrafts = {};
      return saveSession({
        baseUrl: this.baseUrl,
        userId,
        accessToken,
        deviceId,
      });
    });
  }

  sync(): Promise<SyncAttempt> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    const cursor = this.syncCursor;
    const url = cursor
      ? `${matrixUrl(this.baseUrl, "/_matrix/client/v3/sync")}?since=${encodeURIComponent(cursor)}`
      : matrixUrl(this.baseUrl, "/_matrix/client/v3/sync");
    return this.transport
      .request({
        method: "GET",
        url,
        headers: { Authorization: `Bearer ${this.accessToken}` },
      })
      .then((result) => ({ result, incremental: Boolean(cursor) }));
  }

  async dropSyncCursor(): Promise<void> {
    await this.enqueuePersist(() => {
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
      this.storedAccountData = mergeAccountData(this.storedAccountData, body);
      this.storedRooms = mergeSyncRooms(this.storedRooms, body);
      this.storedPendingEvents = reconcilePendingWithSync(this.storedPendingEvents, body);
      this.storedDrafts = reconcileDraftsWithSync(this.storedDrafts, body);
      const cursor = nextBatch(body);
      if (cursor) {
        this.syncCursor = cursor;
      }
      return saveSession(this.sessionRecord());
    });
  }

  getAccountData(type: string): Promise<TransportResult> {
    if (!this.accessToken || !this.userId) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.transport.request({
      method: "GET",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent(type)}`,
      ),
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  putAccountData(type: string, content: unknown): Promise<TransportResult> {
    if (!this.accessToken || !this.userId) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.transport.request({
      method: "PUT",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent(type)}`,
      ),
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: content,
    });
  }

  async retainAccountData(type: string, content: unknown): Promise<void> {
    await this.enqueuePersist(() => {
      this.storedAccountData = { ...this.storedAccountData, [type]: content };
      return saveSession(this.sessionRecord());
    });
  }

  createRoom(body: Record<string, unknown>): Promise<TransportResult> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.transport.request({
      method: "POST",
      url: matrixUrl(this.baseUrl, "/_matrix/client/v3/createRoom"),
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body,
    });
  }

  getRoomStateEvent(
    roomId: string,
    eventType: string,
    stateKey = "",
  ): Promise<TransportResult> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    const basePath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}`;
    const path = stateKey === "" ? basePath : `${basePath}/${encodeURIComponent(stateKey)}`;
    return this.transport.request({
      method: "GET",
      url: matrixUrl(this.baseUrl, path),
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  putRoomStateEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    stateKey = "",
  ): Promise<TransportResult> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    const basePath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}`;
    const path = stateKey === "" ? basePath : `${basePath}/${encodeURIComponent(stateKey)}`;
    return this.transport.request({
      method: "PUT",
      url: matrixUrl(this.baseUrl, path),
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: content,
    });
  }

  leaveRoom(roomId: string): Promise<TransportResult> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.transport.request({
      method: "POST",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      ),
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: {},
    });
  }

  forgetRoom(roomId: string): Promise<TransportResult> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.transport.request({
      method: "POST",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`,
      ),
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
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
      const nextPending = [...this.storedPendingEvents, item];
      let nextDrafts = this.storedDrafts;
      if (options?.clearDraft && roomId in this.storedDrafts) {
        nextDrafts = cloneDrafts(this.storedDrafts);
        delete nextDrafts[roomId];
      }
      await saveSession(this.sessionRecord({ pending: nextPending, drafts: nextDrafts }));
      this.storedPendingEvents = nextPending;
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
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    return this.transport.request({
      method: "PUT",
      url: matrixUrl(
        this.baseUrl,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`,
      ),
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: content,
    });
  }

  async confirmSentRoomEvent(roomId: string, txnId: string, eventId: string): Promise<void> {
    await this.enqueuePersist(async () => {
      const pending = this.storedPendingEvents.find(
        (item) => item.roomId === roomId && item.txnId === txnId,
      );
      const nextPending = this.storedPendingEvents.filter(
        (item) => !(item.roomId === roomId && item.txnId === txnId),
      );
      const nextRooms = cloneStoredRooms(this.storedRooms);
      const existingRoom = nextRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      const alreadyConfirmed = existingRoom.timelineEvents.some(
        (ev) => eventIdOf(ev) === eventId || transactionIdOf(ev) === txnId,
      );
      if (!alreadyConfirmed && pending) {
        existingRoom.timelineEvents.push({
          type: pending.type,
          event_id: eventId,
          sender: pending.sender,
          content: cloneValue(pending.content),
          unsigned: { transaction_id: txnId },
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
      const existing = this.storedRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      this.storedRooms = {
        ...this.storedRooms,
        [roomId]: {
          stateEvents: mergeStateEvents(existing.stateEvents, stateEvents),
          timelineEvents: existing.timelineEvents.map(cloneObject),
          ...(existing.timelineGap ? { timelineGap: { ...existing.timelineGap } } : {}),
        },
      };
      return saveSession(this.sessionRecord());
    });
  }

  async abandonBeforeList(): Promise<void> {
    const base = this.baseUrl;
    const token = this.accessToken;
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
      this.storedDrafts = {};
      return dropPreListSession();
    });
  }

  async forgetCredential(): Promise<void> {
    await this.enqueuePersist(() => {
      this.accessToken = undefined;
      this.deviceId = undefined;
      return dropCredential();
    });
  }

  private sessionRecord(overrides?: {
    pending?: PendingRoomEvent[];
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
    let timelineGap: StoredTimelineGap | undefined;
    if (isPlainObject(value.timelineGap) && value.timelineGap.limited === true) {
      timelineGap = {
        limited: true,
        ...(typeof value.timelineGap.prevBatch === "string" && value.timelineGap.prevBatch !== ""
          ? { prevBatch: value.timelineGap.prevBatch }
          : {}),
      };
    }
    cloned[roomId] = {
      stateEvents,
      timelineEvents,
      ...(timelineGap ? { timelineGap } : {}),
    };
  }
  return cloned;
}

function mergeSyncRooms(
  current: Record<string, StoredRoomEvents>,
  body: unknown,
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
      const existing = next[roomId] ?? { stateEvents: [], timelineEvents: [] };
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
      const timelineGap: StoredTimelineGap | undefined = isLimited
        ? { limited: true, ...(prevBatch ? { prevBatch } : {}) }
        : existing.timelineGap;
      const timelineStateEvents = rawTimeline.filter(
        (event) => typeof event.state_key === "string",
      );

      next[roomId] = {
        stateEvents: mergeStateEvents(existing.stateEvents, [
          ...rawState,
          ...timelineStateEvents,
        ]),
        timelineEvents: mergeTimelineEvents(existing.timelineEvents, rawTimeline),
        ...(timelineGap ? { timelineGap } : {}),
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

function mergeTimelineEvents(
  existing: RawMatrixEvent[],
  incoming: RawMatrixEvent[],
): RawMatrixEvent[] {
  if (incoming.length === 0) {
    return existing.map(cloneObject);
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
  result.forEach((event, index) => {
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
    if (id !== undefined) {
      const existingIndex = indexByEventId.get(id);
      if (existingIndex !== undefined) {
        result[existingIndex] = event;
      } else {
        indexByEventId.set(id, result.length);
        result.push(event);
      }
    } else {
      result.push(event);
    }
  }

  return result;
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
