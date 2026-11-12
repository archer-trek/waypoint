import type { HomeserverTransport, TransportResult } from "../adapters/types";
import { dropCredential, dropPreListSession, loadSession, saveSession, type SessionRecord } from "./session-store";

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

  async restore(): Promise<"sync" | "password" | "address"> {
    const stored = await loadSession();
    if (!stored?.baseUrl) {
      return "address";
    }
    this.baseUrl = stored.baseUrl;
    this.userId = stored.userId;
    this.syncCursor = stored.syncCursor;
    this.storedAccountData = isAccountData(stored.accountData) ? stored.accountData : {};
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
