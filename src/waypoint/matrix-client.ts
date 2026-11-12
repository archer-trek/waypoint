import type { HomeserverTransport, TransportResult } from "../adapters/types";
import {
  dropCredential,
  dropPreListSession,
  loadSession,
  saveSession,
  type RawMatrixEvent,
  type SessionRecord,
  type StoredRoomEvents,
} from "./session-store";

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

  async retainSync(attempt: SyncAttempt): Promise<void> {
    if (attempt.result.type !== "response" || attempt.result.status !== 200) {
      return;
    }
    const body = attempt.result.body;
    await this.enqueuePersist(() => {
      this.storedAccountData = mergeAccountData(this.storedAccountData, body, attempt.incremental);
      this.storedRooms = mergeSyncRooms(this.storedRooms, body, attempt.incremental);
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

  async rememberCreatedRoom(
    roomId: string,
    initialStateEvents: RawMatrixEvent[],
  ): Promise<void> {
    await this.enqueuePersist(() => {
      const existing = this.storedRooms[roomId] ?? { stateEvents: [], timelineEvents: [] };
      this.storedRooms = {
        ...this.storedRooms,
        [roomId]: {
          stateEvents: mergeStateEvents(existing.stateEvents, initialStateEvents),
          timelineEvents: existing.timelineEvents.map(cloneObject),
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

  private sessionRecord(): SessionRecord {
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
    if (Object.keys(this.storedRooms).length > 0) {
      session.rooms = this.storedRooms;
    }
    return session;
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
    cloned[roomId] = { stateEvents, timelineEvents };
  }
  return cloned;
}

function mergeSyncRooms(
  current: Record<string, StoredRoomEvents>,
  body: unknown,
  incremental: boolean,
): Record<string, StoredRoomEvents> {
  const next: Record<string, StoredRoomEvents> = incremental ? cloneStoredRooms(current) : {};
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
      const rawTimeline =
        isPlainObject(roomSync.timeline) && Array.isArray(roomSync.timeline.events)
          ? roomSync.timeline.events.filter(isPlainObject)
          : [];
      const timelineStateEvents = rawTimeline.filter(
        (event) => typeof event.state_key === "string",
      );

      next[roomId] = {
        stateEvents: mergeStateEvents(existing.stateEvents, [
          ...rawState,
          ...timelineStateEvents,
        ]),
        timelineEvents: mergeTimelineEvents(existing.timelineEvents, rawTimeline),
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

function mergeTimelineEvents(
  existing: RawMatrixEvent[],
  incoming: RawMatrixEvent[],
): RawMatrixEvent[] {
  if (incoming.length === 0) {
    return existing.map(cloneObject);
  }
  const result = existing.map(cloneObject);
  const indexByEventId = new Map<string, number>();
  result.forEach((event, index) => {
    const id = eventIdOf(event);
    if (id !== undefined) {
      indexByEventId.set(id, index);
    }
  });

  for (const rawEvent of incoming) {
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
  incremental: boolean,
): Record<string, unknown> {
  const events = accountDataEvents(body);
  if (incremental && events === undefined) {
    return current;
  }
  const next = incremental ? { ...current } : {};
  for (const event of events ?? []) {
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
