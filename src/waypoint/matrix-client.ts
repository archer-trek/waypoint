import type { HomeserverTransport, TransportResult } from "../adapters/types";
import { dropCredential, dropPreListSession, loadSession, saveSession, type SessionRecord } from "./session-store";
import {
  appendDirectRoomMapping,
  isRecord,
  mergeSyncRooms,
  type StoredRoomRecord,
} from "./topics";

export type SyncAttempt = {
  result: TransportResult;
  incremental: boolean;
};

export type CreateTopicResult =
  | { ok: true; roomId: string }
  | { ok: false; message: string };

export class MatrixClient {
  private baseUrl = "";
  private userId = "";
  private accessToken?: string;
  private deviceId?: string;
  private syncCursor?: string;
  private storedAccountData: Record<string, unknown> = {};
  private storedRooms: Record<string, StoredRoomRecord> = {};
  private persistTail: Promise<void> = Promise.resolve();
  private persistEpoch = 0;

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

  rooms(): Record<string, StoredRoomRecord> {
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
    this.storedRooms = isRecord(stored.rooms) ? cloneRooms(stored.rooms) : {};
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
    return this.transport.request({
      method: "GET",
      url,
      headers: { Authorization: `Bearer ${this.accessToken}` },
    }).then((result) => ({ result, incremental: Boolean(cursor) }));
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

  async createTopicRoom(input: {
    name: string;
    description?: string;
    agentUserId: string;
    now: number;
  }): Promise<CreateTopicResult> {
    if (!this.accessToken) {
      return { ok: false, message: "新建 Topic 失败，因为尚未连接。" };
    }
    const body: Record<string, unknown> = {
      preset: "private_chat",
      is_direct: true,
      invite: [input.agentUserId],
      name: input.name,
      initial_state: [
        {
          type: "im.waypoint.topic",
          state_key: "",
          content: { v: 1, agent_user_id: input.agentUserId },
        },
        {
          type: "m.room.history_visibility",
          state_key: "",
          content: { history_visibility: "shared" },
        },
      ],
    };
    if (input.description) {
      body.topic = input.description;
    }

    let createResult: TransportResult;
    try {
      createResult = await this.transport.request({
        method: "POST",
        url: matrixUrl(this.baseUrl, "/_matrix/client/v3/createRoom"),
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch {
      return { ok: false, message: "新建 Topic 失败，因为到达不了。" };
    }

    if (createResult.type !== "response" || createResult.status !== 200 || !isRecord(createResult.body)) {
      return { ok: false, message: createFailureMessage(createResult) };
    }

    const rawRoomId = createResult.body.room_id;
    const roomId = typeof rawRoomId === "string" && rawRoomId.trim() !== "" ? rawRoomId.trim() : undefined;
    if (!roomId) {
      return { ok: false, message: "新建 Topic 失败，因为 Homeserver 没有返回房间 ID。" };
    }

    if (hasEncryptionInCreateResponse(createResult.body)) {
      await this.bestEffortLeaveAndForget(roomId);
      return {
        ok: false,
        message: "新建 Topic 失败，因为 Homeserver 强制开启了加密，Waypoint 不支持加密房间。",
      };
    }

    let encryptionResult: TransportResult;
    try {
      encryptionResult = await this.transport.request({
        method: "GET",
        url: matrixUrl(
          this.baseUrl,
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
        ),
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    } catch {
      await this.bestEffortLeaveAndForget(roomId);
      return { ok: false, message: "新建 Topic 失败，因为无法确认房间是否未加密。" };
    }

    if (encryptionResult.type === "response" && encryptionResult.status === 200) {
      await this.bestEffortLeaveAndForget(roomId);
      return {
        ok: false,
        message: "新建 Topic 失败，因为 Homeserver 强制开启了加密，Waypoint 不支持加密房间。",
      };
    }

    if (!(encryptionResult.type === "response" && encryptionResult.status === 404)) {
      await this.bestEffortLeaveAndForget(roomId);
      return { ok: false, message: createFailureMessage(encryptionResult) };
    }

    const room: StoredRoomRecord = {
      roomId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      hasTopicMarker: true,
      topicMarker: { v: 1, agent_user_id: input.agentUserId },
      encrypted: false,
      members: {
        [this.userId]: { membership: "join" },
        [input.agentUserId]: { membership: "invite" },
      },
      createdAt: input.now,
    };

    await this.enqueuePersist(() => {
      this.storedRooms = { ...this.storedRooms, [roomId]: room };
      return saveSession(this.sessionRecord());
    });

    return { ok: true, roomId };
  }

  async appendDirectRoom(agentUserId: string, roomId: string): Promise<void> {
    if (!this.accessToken || !this.userId) {
      return;
    }
    const nextDirect = appendDirectRoomMapping(this.storedAccountData["m.direct"], agentUserId, roomId);
    try {
      const result = await this.transport.request({
        method: "PUT",
        url: matrixUrl(
          this.baseUrl,
          `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent("m.direct")}`,
        ),
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: nextDirect,
      });
      if (result.type === "response" && result.status >= 200 && result.status < 300) {
        await this.enqueuePersist(() => {
          this.storedAccountData = { ...this.storedAccountData, "m.direct": nextDirect };
          return saveSession(this.sessionRecord());
        });
      }
    } catch {
      // Best-effort per ADR-0023: never fail or roll back created Topic
    }
  }

  private async bestEffortLeaveAndForget(roomId: string): Promise<void> {
    if (!this.accessToken) {
      return;
    }
    const encoded = encodeURIComponent(roomId);
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
    };
    try {
      await this.transport.request({
        method: "POST",
        url: matrixUrl(this.baseUrl, `/_matrix/client/v3/rooms/${encoded}/leave`),
        headers,
        body: {},
      });
    } catch {
      // Best-effort cleanup
    }
    try {
      await this.transport.request({
        method: "POST",
        url: matrixUrl(this.baseUrl, `/_matrix/client/v3/rooms/${encoded}/forget`),
        headers,
        body: {},
      });
    } catch {
      // Best-effort cleanup
    }
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
    const epoch = ++this.persistEpoch;
    const run = this.persistTail.then(async () => {
      if (epoch !== this.persistEpoch) {
        return;
      }
      await write();
    });
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

function cloneRooms(rooms: Record<string, unknown>): Record<string, StoredRoomRecord> {
  const cloned: Record<string, StoredRoomRecord> = {};
  for (const [roomId, value] of Object.entries(rooms)) {
    if (isRecord(value) && typeof value.roomId === "string") {
      cloned[roomId] = {
        roomId: value.roomId,
        name: typeof value.name === "string" ? value.name : undefined,
        description: typeof value.description === "string" ? value.description : undefined,
        hasTopicMarker: Boolean(value.hasTopicMarker),
        topicMarker: value.topicMarker,
        encrypted: Boolean(value.encrypted),
        members: isRecord(value.members) ? (value.members as StoredRoomRecord["members"]) : {},
        createdAt: typeof value.createdAt === "number" ? value.createdAt : undefined,
        lastMessageTs: typeof value.lastMessageTs === "number" ? value.lastMessageTs : undefined,
      };
    }
  }
  return cloned;
}

function hasEncryptionInCreateResponse(body: Record<string, unknown>): boolean {
  if (body.encrypted === true || "m.room.encryption" in body) {
    return true;
  }
  for (const key of ["state", "initial_state"]) {
    const value = body[key];
    if (Array.isArray(value)) {
      if (value.some((ev) => isRecord(ev) && ev.type === "m.room.encryption")) {
        return true;
      }
    }
  }
  return false;
}

function createFailureMessage(result: TransportResult): string {
  if (result.type === "failure") {
    switch (result.failure.type) {
      case "timeout":
        return "新建 Topic 失败，因为超时。";
      case "untrusted-certificate":
        return "新建 Topic 失败，因为到达不了，证书不受信任。";
      case "hostname-mismatch":
        return "新建 Topic 失败，因为到达不了，主机名对不上。";
      case "https-unavailable":
        return "新建 Topic 失败，因为到达不了，HTTPS 建不起来。";
      case "network":
        return "新建 Topic 失败，因为到达不了。";
    }
  }
  const serverError =
    isRecord(result.body) && typeof result.body.error === "string" && result.body.error.trim()
      ? result.body.error.trim()
      : undefined;
  const code =
    isRecord(result.body) && typeof result.body.errcode === "string" ? result.body.errcode : undefined;
  if (result.status === 429 || code === "M_LIMIT_EXCEEDED") {
    return serverError ? `新建 Topic 失败，因为被限流：${serverError}。` : "新建 Topic 失败，因为被限流。";
  }
  if (result.status >= 500) {
    return serverError
      ? `新建 Topic 失败，因为 Homeserver 暂时不能创建房间：${serverError}。`
      : "新建 Topic 失败，因为 Homeserver 暂时不能创建房间。";
  }
  return serverError
    ? `新建 Topic 失败，因为 Homeserver 拒绝了建房请求：${serverError}。`
    : "新建 Topic 失败，因为 Homeserver 拒绝了建房请求。";
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
  if (!isRecord(body) || !isRecord(body.account_data) || !Array.isArray(body.account_data.events)) {
    return undefined;
  }
  return body.account_data.events.flatMap((item) => {
    if (!isRecord(item) || typeof item.type !== "string" || item.type === "") {
      return [];
    }
    return [{ type: item.type, content: item.content }];
  });
}

function nextBatch(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const value = body.next_batch;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isAccountData(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}
