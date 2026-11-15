import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect } from "vitest";
import type { Clock, HomeserverRequest, HomeserverTransport, PlatformAdapter, TransportResult } from "../../adapters/types";
import { WaypointApp } from "../WaypointApp";

export function setupIntegrationTestEnv() {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });
}

export class ManualClock implements Clock {
  private nextId = 1;
  private timers = new Map<number, { at: number; handler: () => void }>();
  now = 0;

  currentTimeMs(): number {
    return this.now;
  }

  get timerCount(): number {
    return this.timers.size;
  }

  setTimeout(handler: () => void, timeoutMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + timeoutMs, handler });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) {
        return;
      }
      const [id, timer] = due[0];
      this.timers.delete(id);
      timer.handler();
    }
  }
}

export async function advanceWhenTimerScheduled(clock: ManualClock, ms: number) {
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => {
    clock.advance(ms);
  });
}

export class FakeHomeserver implements HomeserverTransport {
  readonly requests: Array<HomeserverRequest & { headers: Record<string, string> }> = [];
  handler: (input: HomeserverRequest) => Promise<TransportResult> = async () => {
    throw new Error("Homeserver 不应收到请求");
  };

  request(input: HomeserverRequest): Promise<TransportResult> {
    this.requests.push({ ...input, headers: input.headers ?? {} });
    return this.handler(input);
  }
}

export function renderApp(
  homeserver = new FakeHomeserver(),
  deviceDisplayName = "Waypoint macOS",
  extraPlatform?: Partial<PlatformAdapter>,
) {
  const clock = new ManualClock();
  const view = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName, ...extraPlatform }}
      clock={clock}
    />,
  );
  return { homeserver, clock, ...view };
}

export function passwordLoginHandler(sync: (input: HomeserverRequest) => Promise<TransportResult>) {
  return async (input: HomeserverRequest) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response" as const, status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response" as const, status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
      return {
        type: "response" as const,
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    return sync(input);
  };
}

export async function login(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(await screen.findByLabelText("Homeserver 地址"), {
    target: { value: "https://matrix.example.com" },
  });
  await user.click(screen.getByRole("button", { name: "继续" }));
  fireEvent.change(await screen.findByLabelText("用户标识"), {
    target: { value: "alice" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "secret" },
  });
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const validAgents = {
  events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com" }] } }],
};

export async function enterRegistration(
  user: ReturnType<typeof userEvent.setup>,
  homeserver: FakeHomeserver,
  ownerUserId = "@alice:example.com",
  syncAccountData?: unknown,
) {
  const baseHandler = homeserver.handler;
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
      return {
        type: "response",
        status: 200,
        body: { user_id: ownerUserId, access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          ...(syncAccountData !== undefined ? { account_data: syncAccountData } : {}),
        },
      };
    }
    return baseHandler(input);
  };
  await login(user);
  return await screen.findByLabelText("Matrix 用户 ID");
}

export function withMockedTimelineLayout<T>(
  rowHeight: number,
  viewportHeight: number,
  fn: () => Promise<T>,
): Promise<T> {
  const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const offsetTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("waypoint-timeline")) {
        return viewportHeight;
      }
      return clientHeightDesc?.get ? clientHeightDesc.get.call(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("waypoint-timeline")) {
        return this.querySelectorAll("[data-event-id]").length * rowHeight;
      }
      return scrollHeightDesc?.get ? scrollHeightDesc.get.call(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      if (this.dataset?.eventId) {
        return rowHeight;
      }
      return offsetHeightDesc?.get ? offsetHeightDesc.get.call(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() {
      if (this.dataset?.eventId && this.parentElement) {
        const rows = Array.from(this.parentElement.querySelectorAll("[data-event-id]"));
        const idx = rows.indexOf(this);
        if (idx >= 0) {
          return idx * rowHeight;
        }
      }
      return offsetTopDesc?.get ? offsetTopDesc.get.call(this) : 0;
    },
  });

  return fn().finally(() => {
    if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
    if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
    if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
    if (offsetTopDesc) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTopDesc);
  });
}
