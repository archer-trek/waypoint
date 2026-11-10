import type { HomeserverTransport, TransportResult } from "../adapters/types";
import { dropCredential, loadSession, saveSession } from "./session-store";

export class MatrixClient {
  private baseUrl = "";
  private userId = "";
  private accessToken?: string;
  private deviceId?: string;
  private syncCursor?: string;

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

  async restore(): Promise<"sync" | "password" | "address"> {
    const stored = await loadSession();
    if (!stored?.baseUrl) {
      return "address";
    }
    this.baseUrl = stored.baseUrl;
    this.userId = stored.userId;
    this.syncCursor = stored.syncCursor;
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
    this.userId = userId;
    this.accessToken = accessToken;
    this.deviceId = deviceId;
    this.syncCursor = undefined;
    await saveSession({
      baseUrl: this.baseUrl,
      userId,
      accessToken,
      deviceId,
    });
  }

  sync(): Promise<TransportResult> {
    if (!this.accessToken) {
      return Promise.reject(new Error("没有 access token"));
    }
    const url = this.syncCursor
      ? `${matrixUrl(this.baseUrl, "/_matrix/client/v3/sync")}?since=${encodeURIComponent(this.syncCursor)}`
      : matrixUrl(this.baseUrl, "/_matrix/client/v3/sync");
    return this.transport.request({
      method: "GET",
      url,
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  async rememberCursor(cursor: string): Promise<void> {
    this.syncCursor = cursor;
    if (!this.accessToken || !this.deviceId) {
      return;
    }
    await saveSession({
      baseUrl: this.baseUrl,
      userId: this.userId,
      accessToken: this.accessToken,
      deviceId: this.deviceId,
      syncCursor: cursor,
    });
  }

  async forgetCredential(): Promise<void> {
    this.accessToken = undefined;
    this.deviceId = undefined;
    await dropCredential();
  }
}

function matrixUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}
