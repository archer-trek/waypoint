import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Clock,
  HomeserverRequest,
  HomeserverTransport,
  PlatformAdapter,
  TransportResult,
  ViewportMode,
} from "../adapters/types";
import { MatrixClient } from "./matrix-client";
import { saveSession, type RawMatrixEvent, type StoredRoomEvents } from "./session-store";
import { TopicsWorkspace } from "./TopicsWorkspace";
import { WaypointApp } from "./WaypointApp";

class ManualClock implements Clock {
  private nextId = 1;
  private timers = new Map<number, { at: number; handler: () => void }>();
  now = Date.UTC(2026, 10, 14, 12, 0, 0);

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
      const [id, timer] = due[0]!;
      this.timers.delete(id);
      timer.handler();
    }
  }
}

class FakeHomeserver implements HomeserverTransport {
  readonly requests: Array<HomeserverRequest & { headers: Record<string, string> }> = [];
  handler: (input: HomeserverRequest) => Promise<TransportResult> = async (input) => {
    throw new Error(`Unexpected request: ${input.method} ${input.url}`);
  };

  request(input: HomeserverRequest): Promise<TransportResult> {
    this.requests.push({ ...input, headers: input.headers ?? {} });
    return this.handler(input);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makePlatformHarness(initialMode: ViewportMode = "wide") {
  let mode: ViewportMode = initialMode;
  let navDepth = 0;
  const viewportListeners = new Set<(next: ViewportMode) => void>();
  const networkResumeListeners = new Set<() => void>();
  const backHandlers = new Set<() => boolean>();

  const platform: PlatformAdapter = {
    deviceDisplayName: initialMode === "narrow" ? "Waypoint Android" : "Waypoint macOS",
    viewportMode: () => mode,
    subscribeViewportMode: (listener) => {
      viewportListeners.add(listener);
      return () => viewportListeners.delete(listener);
    },
    isAppVisible: () => true,
    subscribeNetworkResume: (listener) => {
      networkResumeListeners.add(listener);
      return () => networkResumeListeners.delete(listener);
    },
    pushNavigationEntry: () => {
      navDepth += 1;
    },
    popNavigationEntry: () => {
      navDepth = Math.max(0, navDepth - 1);
    },
    onSystemBack: (handler) => {
      backHandlers.add(handler);
      return () => backHandlers.delete(handler);
    },
  };

  return {
    platform,
    get navDepth() {
      return navDepth;
    },
    setViewportMode(next: ViewportMode) {
      mode = next;
      for (const listener of viewportListeners) {
        listener(next);
      }
    },
    triggerNetworkResume() {
      for (const listener of networkResumeListeners) {
        listener();
      }
    },
    triggerSystemBack(): boolean {
      let handled = false;
      for (const handler of [...backHandlers].reverse()) {
        if (handler()) {
          navDepth = Math.max(0, navDepth - 1);
          handled = true;
          break;
        }
      }
      return handled;
    },
  };
}

function makeStoredRoom({
  name,
  description,
  agentUserId = "@bot:example.com",
  messages = [],
  readPositionEventId,
}: {
  name: string;
  description?: string;
  agentUserId?: string;
  messages?: RawMatrixEvent[];
  readPositionEventId?: string;
}): StoredRoomEvents {
  const stateEvents: RawMatrixEvent[] = [
    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: agentUserId } },
    { type: "m.room.name", state_key: "", content: { name } },
  ];
  if (description !== undefined) {
    stateEvents.push({ type: "m.room.topic", state_key: "", content: { topic: description } });
  }
  const lastEventId =
    readPositionEventId ??
    (messages.length > 0 ? String(messages[messages.length - 1]!.event_id ?? "") : undefined);
  return {
    stateEvents,
    timelineEvents: messages,
    ...(lastEventId ? { readPositionEventId: lastEventId } : {}),
  };
}

function makeTextEvent(
  eventId: string,
  sender: string,
  body: string,
  ts: number,
): RawMatrixEvent {
  return {
    type: "m.room.message",
    event_id: eventId,
    sender,
    origin_server_ts: ts,
    content: { msgtype: "m.text", body },
  };
}

async function seedRestoredClient({
  homeserver,
  rooms = {},
  syncCursor = "batch-init",
}: {
  homeserver: FakeHomeserver;
  rooms?: Record<string, StoredRoomEvents>;
  syncCursor?: string;
}) {
  await saveSession({
    baseUrl: "https://matrix.example.com",
    userId: "@alice:example.com",
    accessToken: "tok-initial",
    deviceId: "DEV1",
    syncCursor,
    accountData: {
      "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] },
    },
    rooms,
  });
  const client = new MatrixClient(homeserver);
  const restored = await client.restore();
  expect(restored).toBe("sync");
  return client;
}

async function advanceWhenTimerScheduled(clock: ManualClock, ms: number) {
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => {
    clock.advance(ms);
  });
}

describe("TopicsWorkspace state-transition integration tests (#95)", () => {
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  test("desktop wide viewport: list -> empty detail -> open topic -> switch topic preserves per-topic draft and resets transient UI", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "架构讨论",
          description: "这是第一条 Topic 的说明",
          messages: [
            makeTextEvent("$e1", "@bot:example.com", "欢迎来到架构讨论", clock.now - 20_000),
          ],
        }),
        "!t2:example.com": makeStoredRoom({
          name: "日常待办",
          messages: [
            makeTextEvent("$e2", "@bot:example.com", "今天的待办事项", clock.now - 10_000),
          ],
        }),
      },
    });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="wide"
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });
    const guide = screen.getByRole("region", { name: "Topic 引导" });
    expect(guide).toHaveTextContent("Alt + N");
    expect(screen.queryByRole("log", { name: "对话时间线" })).not.toBeInTheDocument();

    // Open Topic 1
    await user.click(within(sidebar).getByRole("button", { name: /架构讨论/ }));
    expect(screen.queryByRole("region", { name: "Topic 引导" })).not.toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent("架构讨论");
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("欢迎来到架构讨论");
    expect(within(sidebar).getByRole("button", { name: /架构讨论/ })).toHaveAttribute("data-active", "true");
    expect(harness.navDepth).toBe(0);

    // Expand description and type a local draft on Topic 1
    const descToggle = screen.getByRole("button", { name: /这是第一条 Topic 的说明/ });
    await user.click(descToggle);
    expect(descToggle).toHaveAttribute("aria-expanded", "true");
    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "留给架构讨论的草稿");

    // Switch to Topic 2
    await user.click(within(sidebar).getByRole("button", { name: /日常待办/ }));
    expect(screen.getByRole("banner")).toHaveTextContent("日常待办");
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("今天的待办事项");
    expect(within(sidebar).getByRole("button", { name: /日常待办/ })).toHaveAttribute("data-active", "true");
    expect(within(sidebar).getByRole("button", { name: /架构讨论/ })).not.toHaveAttribute("data-active", "true");
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

    // Switch back to Topic 1: description collapsed again and draft preserved
    await user.click(within(sidebar).getByRole("button", { name: /架构讨论/ }));
    expect(screen.getByRole("button", { name: /这是第一条 Topic 的说明/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("留给架构讨论的草稿");
  });

  test("narrow viewport push/back navigation and wide/narrow resize transitions keep navigation depth consistent", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("narrow");
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] } },
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "窄屏话题",
          messages: [makeTextEvent("$e1", "@bot:example.com", "窄屏消息内容", clock.now - 5_000)],
        }),
      },
    });

    const view = render(
      <WaypointApp homeserver={homeserver} platform={harness.platform} clock={clock} />,
    );

    // Initially at root list: Sidebar mounted, detail hidden, depth 0
    const row = await screen.findByRole("button", { name: /窄屏话题/ });
    expect(screen.queryByRole("log", { name: "对话时间线" })).not.toBeInTheDocument();
    expect(harness.navDepth).toBe(0);

    // Push into topic detail
    await user.click(row);
    expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("窄屏消息内容");
    expect(document.querySelector(".waypoint-detail")).toHaveClass("waypoint-page-enter-forward");
    expect(harness.navDepth).toBe(1);

    // Header back button returns to Sidebar with back animation
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(await screen.findByRole("complementary", { name: "Topic 列表" })).toHaveClass(
      "waypoint-page-enter-back",
    );
    expect(screen.queryByRole("log", { name: "对话时间线" })).not.toBeInTheDocument();
    expect(harness.navDepth).toBe(0);

    // Push Topic -> EditTopic (depth 2), then step back twice via Android system back
    await user.click(screen.getByRole("button", { name: /窄屏话题/ }));
    expect(harness.navDepth).toBe(1);
    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeInTheDocument();
    expect(document.querySelector(".waypoint-detail")).toHaveClass("waypoint-page-enter-forward");
    expect(harness.navDepth).toBe(2);

    // First system back pops EditTopic back to Topic detail
    let handled = false;
    await act(async () => {
      handled = harness.triggerSystemBack();
    });
    expect(handled).toBe(true);
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument();
    expect(document.querySelector(".waypoint-detail")).toHaveClass("waypoint-page-enter-back");
    expect(harness.navDepth).toBe(1);

    // Second system back pops Topic detail back to Topic list
    await act(async () => {
      handled = harness.triggerSystemBack();
    });
    expect(handled).toBe(true);
    expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeInTheDocument();
    expect(harness.navDepth).toBe(0);

    // System back at root returns false
    await act(async () => {
      handled = harness.triggerSystemBack();
    });
    expect(handled).toBe(false);

    // Open topic in narrow, resize to wide -> split pane with depth 0; resize back to narrow -> detail pushed with depth 1
    await user.click(screen.getByRole("button", { name: /窄屏话题/ }));
    expect(harness.navDepth).toBe(1);
    await act(async () => {
      harness.setViewportMode("wide");
    });
    expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument();
    expect(harness.navDepth).toBe(0);

    await act(async () => {
      harness.setViewportMode("narrow");
    });
    expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument();
    expect(harness.navDepth).toBe(1);

    view.unmount();
  });

  test("narrow viewport supports left edge swipe-back gesture within 24px and yields on inner horizontal scroll (ADR-0028)", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("narrow");
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] } },
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "边缘手势测试",
          messages: [makeTextEvent("$e1", "@bot:example.com", "手势消息内容", clock.now - 5_000)],
        }),
      },
    });

    render(
      <WaypointApp homeserver={homeserver} platform={harness.platform} clock={clock} />,
    );

    const row = await screen.findByRole("button", { name: /边缘手势测试/ });
    await user.click(row);

    const detailContainer = document.querySelector(".waypoint-detail") as HTMLElement;
    expect(detailContainer).toBeInTheDocument();

    // 1. Touch start beyond 24px (e.g. clientX = 40px) does not start swipe-back
    fireEvent.touchStart(detailContainer, {
      touches: [{ clientX: 40, clientY: 200 }],
    });
    fireEvent.touchMove(detailContainer, {
      touches: [{ clientX: 160, clientY: 200 }],
    });
    expect(detailContainer).not.toHaveAttribute("data-swiping-back");
    fireEvent.touchEnd(detailContainer);
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument();

    // 2. Touch start within 24px (e.g. clientX = 12px) and move right > 80px triggers edge swipe-back
    fireEvent.touchStart(detailContainer, {
      touches: [{ clientX: 12, clientY: 200 }],
    });
    fireEvent.touchMove(detailContainer, {
      touches: [{ clientX: 110, clientY: 200 }],
    });
    expect(detailContainer).toHaveAttribute("data-swiping-back", "true");
    expect(detailContainer).toHaveAttribute("data-swipe-offset", "98");

    fireEvent.touchEnd(detailContainer);
    // Pops back to Topic list
    expect(await screen.findByRole("complementary", { name: "Topic 列表" })).toBeInTheDocument();
    expect(screen.queryByRole("log", { name: "对话时间线" })).not.toBeInTheDocument();
  });

  test("empty list -> create first topic transitions into populated workspace on both wide and narrow viewports", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
        return { type: "response", status: 200, body: { room_id: "!first:example.com" } };
      }
      if (input.method === "GET" && input.url.includes("/state/m.room.encryption")) {
        return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("narrow");
    const client = await seedRestoredClient({ homeserver, rooms: {} });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="narrow"
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });
    expect(sidebar.querySelector(".waypoint-list-empty")).not.toBeNull();
    const emptyGuide = within(sidebar).getByRole("region", { name: "Topic 引导" });
    expect(emptyGuide).not.toHaveTextContent("Alt + N");

    await user.click(within(emptyGuide).getByRole("button", { name: "新建一条 Topic" }));
    const createPage = screen.getByRole("region", { name: "新建 Topic" });
    await user.type(within(createPage).getByLabelText("Topic 名字"), "第一条话题");
    await user.click(within(createPage).getByRole("button", { name: "创建 Topic" }));

    expect(await screen.findByRole("banner")).toHaveTextContent("第一条话题");
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument();

    // Back to list: empty state gone, created topic is listed
    await user.click(screen.getByRole("button", { name: "返回" }));
    const populatedSidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
    expect(populatedSidebar.querySelector(".waypoint-list-empty")).toBeNull();
    expect(within(populatedSidebar).getByRole("button", { name: /第一条话题/ })).toBeInTheDocument();
  });

  test("disconnected sync failure -> exponential backoff -> network resume recovers live sync and wakes retry queue", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let syncShouldFail = true;
    let syncCalls = 0;
    let sendAttempted = 0;
    let sendShouldFail = true;

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        syncCalls += 1;
        if (syncShouldFail) {
          return { type: "failure", failure: { type: "network" } };
        }
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: `batch-${syncCalls}`,
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      makeTextEvent("$bot-recovered", "@bot:example.com", "网络恢复后的同步消息", 5000),
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
        sendAttempted += 1;
        if (sendShouldFail) {
          return { type: "failure", failure: { type: "network" } };
        }
        return { type: "response", status: 200, body: { event_id: "$sent-after-resume" } };
      }
      if (input.method === "POST" && input.url.includes("/read_markers")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] } },
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "断网重连话题",
          messages: [makeTextEvent("$e1", "@bot:example.com", "缓存历史消息", 2000)],
        }),
      },
    });

    const view = render(
      <WaypointApp homeserver={homeserver} platform={harness.platform} clock={clock} />,
    );

    // Cached workspace opens immediately while initial sync fails and enters backoff
    await user.click(await screen.findByRole("button", { name: /断网重连话题/ }));
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("缓存历史消息");
    await waitFor(() => expect(syncCalls).toBe(1));

    // Send a message while offline -> enters RetryQueue backoff
    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "离线暂存发送");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(sendAttempted).toBe(1));
    expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

    // Advance 1000ms -> sync #2 and retry #2 both still fail -> both enter 2000ms backoff
    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => {
      expect(syncCalls).toBe(2);
      expect(sendAttempted).toBe(2);
    });

    // Network comes back and platform emits network resume -> wakes both sync and RetryQueue immediately without waiting 2000ms
    syncShouldFail = false;
    sendShouldFail = false;
    await act(async () => {
      harness.triggerNetworkResume();
    });

    await waitFor(() => {
      expect(syncCalls).toBeGreaterThanOrEqual(3);
      expect(sendAttempted).toBe(3);
      expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
      expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("网络恢复后的同步消息");
    });

    view.unmount();
  });

  test("reauth banner transition: 401 pauses sync/composer -> wrong password stays locked -> valid reauth resumes -> exit device returns to login", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let tokenValid = false;
    let syncPhase = "reject" as "reject" | "ok";

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        if (syncPhase === "reject") {
          return {
            type: "response",
            status: 401,
            body: { errcode: "M_UNKNOWN_TOKEN", error: "Token expired" },
          };
        }
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-reauthed",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      makeTextEvent("$bot-reauth", "@bot:example.com", "重新验证后同步到达", 6000),
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
        const body = input.body as { password?: string };
        if (body?.password !== "correct-pw") {
          return {
            type: "response",
            status: 403,
            body: { errcode: "M_FORBIDDEN", error: "Bad password" },
          };
        }
        tokenValid = true;
        syncPhase = "ok";
        return {
          type: "response",
          status: 200,
          body: { user_id: "@alice:example.com", access_token: "tok-reauthed", device_id: "DEV1" },
        };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
        return { type: "response", status: 200, body: {} };
      }
      if (input.method === "POST" && input.url.includes("/read_markers")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-expired",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] } },
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "重验证话题",
          messages: [makeTextEvent("$e1", "@bot:example.com", "旧消息", 2000)],
        }),
      },
    });

    const view = render(
      <WaypointApp homeserver={homeserver} platform={harness.platform} clock={clock} />,
    );

    await user.click(await screen.findByRole("button", { name: /重验证话题/ }));

    // 401 from initial sync triggers ReauthBanner and disables composer + create
    const banner = await screen.findByRole("status", { name: "重新验证提示" });
    expect(banner).toHaveTextContent("服务器不认这台设备的登录");
    expect(screen.getByRole("textbox", { name: "输入消息" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建 Topic" })).toBeDisabled();

    // Alt+N should be ignored while reauthRequired is true
    fireEvent.keyDown(window, { key: "n", altKey: true });
    expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();

    // Open reauth form, enter wrong password -> clears password, shows error, stays locked
    await user.click(within(banner).getByRole("button", { name: "重新验证" }));
    const reauthForm = screen.getByRole("form", { name: "重新验证" });
    await user.type(within(reauthForm).getByLabelText("密码"), "wrong-pw");
    await user.click(within(reauthForm).getByRole("button", { name: "确认验证" }));

    expect(await within(reauthForm).findByRole("alert")).toHaveTextContent("密码不正确");
    expect(within(reauthForm).getByLabelText("密码")).toHaveValue("");
    expect(tokenValid).toBe(false);
    expect(screen.getByRole("textbox", { name: "输入消息" })).toBeDisabled();

    // Submit valid password -> banner closes, composer/create re-enabled, sync resumes
    await user.type(within(reauthForm).getByLabelText("密码"), "correct-pw");
    await user.click(within(reauthForm).getByRole("button", { name: "确认验证" }));

    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "重新验证提示" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "输入消息" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "新建 Topic" })).toBeEnabled();
      expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("重新验证后同步到达");
    });

    // Trigger another 401 -> test exit device path back to password screen
    syncPhase = "reject";
    await advanceWhenTimerScheduled(clock, 1000);
    const secondBanner = await screen.findByRole("status", { name: "重新验证提示" });
    await user.click(within(secondBanner).getByRole("button", { name: "退出这台设备" }));
    const exitAlert = screen.getByRole("alertdialog", { name: "确认退出这台设备" });
    await user.click(within(exitAlert).getByRole("button", { name: "确认退出" }));

    expect(await screen.findByLabelText("密码")).toHaveValue("");
    expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();

    view.unmount();
  });

  test("editing a topic with partial failure keeps selection, preserves draft, and retries only the failed field", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    const statePutCalls: string[] = [];
    let topicPutAttempts = 0;

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      if (input.method === "PUT" && input.url.endsWith("/state/m.room.name")) {
        statePutCalls.push("m.room.name");
        return { type: "response", status: 200, body: { event_id: "$name-updated" } };
      }
      if (input.method === "PUT" && input.url.endsWith("/state/m.room.topic")) {
        statePutCalls.push("m.room.topic");
        topicPutAttempts += 1;
        if (topicPutAttempts === 1) {
          return {
            type: "response",
            status: 500,
            body: { errcode: "M_UNKNOWN", error: "Server error" },
          };
        }
        return { type: "response", status: 200, body: { event_id: "$topic-updated" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "原始名称",
          description: "原始描述",
          messages: [makeTextEvent("$e1", "@bot:example.com", "已有对话", 1500)],
        }),
        "!t2:example.com": makeStoredRoom({ name: "另一个话题" }),
      },
    });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="wide"
      />,
    );

    await user.click(screen.getByRole("button", { name: /原始名称/ }));
    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "编辑时保留的草稿");

    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));

    const editDialog = screen.getByRole("region", { name: "编辑 Topic" });
    await user.clear(within(editDialog).getByLabelText("Topic 名字"));
    await user.type(within(editDialog).getByLabelText("Topic 名字"), "更新后名称");
    await user.clear(within(editDialog).getByLabelText("Description（可选）"));
    await user.type(within(editDialog).getByLabelText("Description（可选）"), "更新后描述");
    await user.click(within(editDialog).getByRole("button", { name: "保存" }));

    // Name succeeded immediately, description failed -> dialog stays open showing only pending description field
    expect(await within(editDialog).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("banner", { hidden: true })).toHaveTextContent("更新后名称");
    expect(within(editDialog).queryByLabelText("Topic 名字")).not.toBeInTheDocument();
    expect(within(editDialog).getByLabelText("Description（可选）")).toHaveValue("更新后描述");
    expect(statePutCalls).toEqual(["m.room.name", "m.room.topic"]);

    // Retry save -> only sends m.room.topic, closes cleanly, keeps selection & draft intact
    await user.click(within(editDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
    });
    expect(statePutCalls).toEqual(["m.room.name", "m.room.topic", "m.room.topic"]);
    expect(screen.getByRole("button", { name: /更新后名称/ })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("编辑时保留的草稿");
  });

  test("deleting active topic: leave failure preserves selection -> retry succeeds without auto-selecting next topic -> external sync leave clears selection cleanly", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let leaveAttempts = 0;
    let externalLeaveSecondTopic = false;

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        if (externalLeaveSecondTopic) {
          return {
            type: "response",
            status: 200,
            body: {
              next_batch: "batch-leave",
              rooms: { leave: { "!t2:example.com": {} } },
            },
          };
        }
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      if (input.method === "POST" && input.url.includes("/rooms/!t1%3Aexample.com/leave")) {
        leaveAttempts += 1;
        if (leaveAttempts === 1) {
          return {
            type: "response",
            status: 500,
            body: { errcode: "M_UNKNOWN", error: "Leave failed" },
          };
        }
        return { type: "response", status: 200, body: {} };
      }
      if (input.method === "POST" && input.url.includes("/forget")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "待删话题",
          messages: [makeTextEvent("$e1", "@bot:example.com", "待删内容", 1500)],
        }),
        "!t2:example.com": makeStoredRoom({
          name: "保留话题",
          messages: [makeTextEvent("$e2", "@bot:example.com", "保留内容", 2000)],
        }),
      },
    });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="wide"
      />,
    );

    await user.click(screen.getByRole("button", { name: /待删话题/ }));
    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "待删话题草稿");

    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "确认删除 Topic" });

    // First leave fails -> dialog stays open with error, selection and draft stay intact
    await user.click(within(deleteDialog).getByRole("button", { name: "确认删除" }));
    expect(await within(deleteDialog).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /待删话题/, hidden: true })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("textbox", { name: "输入消息", hidden: true })).toHaveValue("待删话题草稿");

    // Retry delete -> succeeds, removes !t1, does NOT auto-select !t2
    await user.click(within(deleteDialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "确认删除 Topic" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /待删话题/ })).not.toBeInTheDocument();
    const keptRow = screen.getByRole("button", { name: /保留话题/ });
    expect(keptRow).not.toHaveAttribute("data-active", "true");
    expect(screen.getByRole("region", { name: "Topic 引导" })).toBeInTheDocument();

    // Select !t2, then simulate external leave via /sync -> cleans up selection cleanly
    await user.click(keptRow);
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("保留内容");
    externalLeaveSecondTopic = true;
    await advanceWhenTimerScheduled(clock, 1000);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /保留话题/ })).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Topic 引导" })).toBeInTheDocument();
    });
  });

  test("composer send failure -> retry queue backoff -> auto-retry reconciles in-place without duplication", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    const sentTxnIds: string[] = [];
    let sendAttempts = 0;

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events:
                      sendAttempts >= 2 && sentTxnIds[0]
                        ? [
                            {
                              type: "m.room.message",
                              event_id: "$reconciled-auto",
                              sender: "@alice:example.com",
                              origin_server_ts: 4000,
                              content: { msgtype: "m.text", body: "自动重试成功消息" },
                              unsigned: { transaction_id: sentTxnIds[0] },
                            },
                          ]
                        : [],
                  },
                },
              },
            },
          },
        };
      }
      if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
        sendAttempts += 1;
        sentTxnIds.push(decodeURIComponent(input.url.split("/").pop() ?? ""));
        if (sendAttempts === 1) {
          return { type: "failure", failure: { type: "network" } };
        }
        return { type: "response", status: 200, body: { event_id: "$reconciled-auto" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    const client = await seedRestoredClient({
      homeserver,
      rooms: { "!t1:example.com": makeStoredRoom({ name: "重试队列话题" }) },
    });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="wide"
      />,
    );

    const row = screen.getByRole("button", { name: /重试队列话题/ });
    await user.click(row);

    const composer = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(composer, "自动重试成功消息");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // Initial transient failure -> stays unconfirmed in timeline & sidebar
    await waitFor(() => expect(sendAttempts).toBe(1));
    expect(composer).toHaveValue("");
    expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
    expect(within(row).getByRole("img", { name: "未确认" })).toBeInTheDocument();

    // Advance 1000ms for RetryQueue backoff -> retries same txnId and reconciles in-place
    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => {
      expect(sendAttempts).toBe(2);
      expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
    });
    expect(sentTxnIds[0]).toBe(sentTxnIds[1]);
    expect(within(row).queryByRole("img", { name: "未确认" })).not.toBeInTheDocument();
    const timeline = screen.getByRole("log", { name: "对话时间线" });
    expect(timeline.querySelectorAll('[data-event-id="$reconciled-auto"]')).toHaveLength(1);
    expect(timeline.querySelectorAll("[data-side]")).toHaveLength(1);
  });

  test("permanent 4xx send failure -> manual resend reconciles on early sync echo -> discard cleans failed state", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let sendCalls = 0;
    let resentTxnId = "";
    const pendingResend = deferred<TransportResult>();

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-sync",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: resentTxnId
                      ? [
                          {
                            type: "m.room.message",
                            event_id: "$echo-resent",
                            sender: "@alice:example.com",
                            origin_server_ts: 5000,
                            content: { msgtype: "m.text", body: "重发的消息" },
                            unsigned: { transaction_id: resentTxnId },
                          },
                        ]
                      : [],
                  },
                },
              },
            },
          },
        };
      }
      if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
        sendCalls += 1;
        const txnId = decodeURIComponent(input.url.split("/").pop() ?? "");
        if (sendCalls <= 2) {
          return { type: "response", status: 403, body: { errcode: "M_FORBIDDEN", error: "Forbidden" } };
        }
        resentTxnId = txnId;
        return pendingResend.promise;
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    const client = await seedRestoredClient({
      homeserver,
      rooms: { "!t1:example.com": makeStoredRoom({ name: "失败重发话题" }) },
    });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="wide"
      />,
    );

    const row = screen.getByRole("button", { name: /失败重发话题/ });
    await user.click(row);

    const composer = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(composer, "重发的消息");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(composer).toBeEnabled();
      expect(composer).toHaveValue("");
    });

    await user.type(composer, "丢掉的消息");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getAllByRole("button", { name: "失败" })).toHaveLength(2));
    expect(within(row).getByRole("img", { name: "失败" })).toBeInTheDocument();

    // Resend first failed message -> transitions to unconfirmed; sync echo arrives before PUT response
    await user.click(screen.getAllByRole("button", { name: "失败" })[0]!);
    await waitFor(() => expect(resentTxnId).not.toBe(""));
    expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "失败" })).toHaveLength(1);

    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
    });

    // Late HTTP 200 does not create duplicate bubble
    await act(async () => {
      pendingResend.resolve({ type: "response", status: 200, body: { event_id: "$echo-resent" } });
    });
    const timeline = screen.getByRole("log", { name: "对话时间线" });
    const getBodies = () =>
      Array.from(timeline.querySelectorAll("[data-side] .waypoint-bubble")).map((el) => el.textContent);
    expect(getBodies()).toEqual(["重发的消息", "丢掉的消息"]);

    // Discard second failed message -> clears bubble and sidebar failed indicator
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(within(screen.getByRole("menu", { name: "消息操作" })).getByRole("menuitem", { name: "丢掉" }));
    await waitFor(() => expect(getBodies()).toEqual(["重发的消息"]));
    expect(within(row).queryByRole("img")).not.toBeInTheDocument();
  });

  test("queued message transitions to failed and composer locks (preserving draft) when sync marks topic unavailable", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let syncShouldEncryptRoom = false;

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-unavail",
            rooms: syncShouldEncryptRoom
              ? {
                  join: {
                    "!t1:example.com": {
                      state: {
                        events: [
                          { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
                        ],
                      },
                    },
                  },
                }
              : {},
          },
        };
      }
      if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
        return { type: "failure", failure: { type: "network" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    const client = await seedRestoredClient({
      homeserver,
      rooms: { "!t1:example.com": makeStoredRoom({ name: "不可用转换话题" }) },
    });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="wide"
      />,
    );

    const row = screen.getByRole("button", { name: /不可用转换话题/ });
    await user.click(row);

    const composer = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(composer, "待发送队列消息");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument());

    // Type a new draft while first message is waiting in RetryQueue backoff
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, "保留的未发草稿");

    // Sync delivers m.room.encryption -> room becomes unavailable -> pending event fails, banner shown, draft preserved
    syncShouldEncryptRoom = true;
    await advanceWhenTimerScheduled(clock, 1000);

    const unavailableBanner = await screen.findByRole("status", { name: "Topic 不可用" });
    expect(unavailableBanner).toHaveTextContent("加密");
    expect(screen.getByRole("button", { name: "失败" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
    expect(composer).toBeDisabled();
    expect(composer).toHaveValue("保留的未发草稿");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(row).toHaveAttribute("data-unavailable", "true");
  });

  test("WaypointApp syncing failure -> retry recovers into empty wide workspace -> EmptyDetailView CTA creates first topic", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let syncAttempts = 0;

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        syncAttempts += 1;
        if (syncAttempts === 1) {
          return { type: "failure", failure: { type: "network" } };
        }
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: `batch-${syncAttempts}`,
            account_data: {
              events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] } }],
            },
          },
        };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
        return { type: "response", status: 200, body: { room_id: "!created-wide:example.com" } };
      }
      if (input.method === "GET" && input.url.includes("/state/m.room.encryption")) {
        return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("wide");
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
    });

    const view = render(
      <WaypointApp homeserver={homeserver} platform={harness.platform} clock={clock} />,
    );

    // Pre-list syncing screen shows error & retry button on initial disconnect
    expect(await screen.findByText("正在增量同步…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "立刻再试" }));

    // Transitions into wide empty workspace with EmptyDetailView CTA
    const guide = await screen.findByRole("region", { name: "Topic 引导" });
    expect(guide).toHaveTextContent("Alt + N");
    expect(screen.getByText("暂无 Topic")).toBeInTheDocument();

    await user.click(within(guide).getByRole("button", { name: "新建一条 Topic" }));
    const createDialog = screen.getByRole("region", { name: "新建 Topic" });
    await user.type(within(createDialog).getByLabelText("Topic 名字"), "宽屏首条话题");
    await user.click(within(createDialog).getByRole("button", { name: "创建 Topic" }));

    expect(await screen.findByRole("banner")).toHaveTextContent("宽屏首条话题");
    expect(screen.getByRole("button", { name: /宽屏首条话题/ })).toHaveAttribute("data-active", "true");

    view.unmount();
  });

  test("narrow viewport: deleting active topic and external leave pop back to list with depth 0, and 401 at list shows ReauthBanner in sidebar", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    let syncRound = 0;

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        syncRound += 1;
        if (syncRound === 1) {
          return {
            type: "response",
            status: 200,
            body: {
              next_batch: "batch-left-ext",
              rooms: { leave: { "!t2:example.com": {} } },
            },
          };
        }
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Token expired" },
        };
      }
      if (input.method === "POST" && input.url.includes("/rooms/!t1%3Aexample.com/leave")) {
        return { type: "response", status: 200, body: {} };
      }
      if (input.method === "POST" && input.url.includes("/forget")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("narrow");
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!t1:example.com": makeStoredRoom({ name: "窄屏待删" }),
        "!t2:example.com": makeStoredRoom({ name: "窄屏外部离开" }),
      },
    });

    render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="narrow"
      />,
    );

    // Open !t1 and delete -> returns to list with depth 0, !t2 remains unselected
    await user.click(screen.getByRole("button", { name: /窄屏待删/ }));
    expect(harness.navDepth).toBe(1);
    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "确认删除 Topic" })).getByRole("button", { name: "确认删除" }));

    expect(await screen.findByRole("complementary", { name: "Topic 列表" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /窄屏待删/ })).not.toBeInTheDocument();
    expect(harness.navDepth).toBe(0);

    // Open !t2, then sync delivers external leave -> pops cleanly back to list with depth 0
    await user.click(screen.getByRole("button", { name: /窄屏外部离开/ }));
    expect(harness.navDepth).toBe(1);
    expect(screen.getByRole("banner")).toHaveTextContent("窄屏外部离开");

    await advanceWhenTimerScheduled(clock, 1000);
    expect(await screen.findByRole("complementary", { name: "Topic 列表" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /窄屏外部离开/ })).not.toBeInTheDocument();
    expect(harness.navDepth).toBe(0);

    // Next sync returns 401 while on narrow list -> ReauthBanner renders inside Sidebar
    await advanceWhenTimerScheduled(clock, 1000);
    const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });
    expect(await within(sidebar).findByRole("status", { name: "重新验证提示" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "新建 Topic" })).toBeDisabled();
  });

  test("timeline stays anchored to bottom on keyboard inset and ResizeObserver shrink, while preserving history scroll position and expanded description", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: { next_batch: "batch-stay" },
        };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const messages = Array.from({ length: 10 }, (_, idx) =>
      makeTextEvent(`$m${idx + 1}`, "@bot:example.com", `消息 ${idx + 1}`, 1000 + idx * 100),
    );
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "锚定测试",
          description: "Topic 详细描述内容",
          messages,
        }),
      },
    });

    const originalResizeObserver = globalThis.ResizeObserver;
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const offsetTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");

    let timelineViewportHeight = 600;
    const observers = new Set<{ target: Element; callback: ResizeObserverCallback }>();
    class FakeResizeObserver {
      private callback: ResizeObserverCallback;
      private observed = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.observed.add(target);
        observers.add({ target, callback: this.callback });
      }
      unobserve(target: Element) {
        this.observed.delete(target);
      }
      disconnect() {
        for (const entry of [...observers]) {
          if (this.observed.has(entry.target) && entry.callback === this.callback) {
            observers.delete(entry);
          }
        }
        this.observed.clear();
      }
    }
    const triggerTimelineResize = (nextHeight: number) => {
      timelineViewportHeight = nextHeight;
      for (const entry of observers) {
        if ((entry.target as HTMLElement).classList?.contains("waypoint-timeline")) {
          entry.callback([], {} as ResizeObserver);
        }
      }
    };

    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) {
          return timelineViewportHeight;
        }
        return clientHeightDesc?.get ? clientHeightDesc.get.call(this) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) {
          return this.querySelectorAll("[data-event-id]").length * 100;
        }
        return scrollHeightDesc?.get ? scrollHeightDesc.get.call(this) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        if (this.dataset?.eventId) {
          return 100;
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
            return idx * 100;
          }
        }
        return offsetTopDesc?.get ? offsetTopDesc.get.call(this) : 0;
      },
    });

    try {
      const clock = new ManualClock();
      const harness = makePlatformHarness("narrow");
      const view = render(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={0}
        />,
      );

      await user.click(screen.getByRole("button", { name: /锚定测试/ }));
      const timeline = screen.getByRole("log", { name: "对话时间线" });
      // Initial landing at bottom: 10*100 - 600 = 400
      expect(timeline.scrollTop).toBe(400);

      // Expand description; programmatic scroll later must not collapse it
      const descBtn = screen.getByRole("button", { name: "Topic 详细描述内容" });
      await user.click(descBtn);
      expect(descBtn).toHaveAttribute("aria-expanded", "true");

      // 1. Soft keyboard opens (600 -> 288) while at bottom -> scrollTop moves up to 712
      timelineViewportHeight = 288;
      view.rerender(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={312}
        />,
      );
      expect(timeline.scrollTop).toBe(712);
      // Simulating native scroll event fired for programmatic scrollTop assignment
      fireEvent.scroll(timeline);
      expect(descBtn).toHaveAttribute("aria-expanded", "true");

      // 2. Composer grows multiline via ResizeObserver (288 -> 240) while at bottom -> scrollTop moves up to 760
      act(() => {
        triggerTimelineResize(240);
      });
      expect(timeline.scrollTop).toBe(760);

      // 3. Keyboard closes (240 -> 600) while at bottom -> scrollTop clamps back to 400
      timelineViewportHeight = 600;
      view.rerender(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={0}
        />,
      );
      expect(timeline.scrollTop).toBe(400);

      // 4. User scrolls up to read history (scrollTop = 100) -> collapses description and unlocks from bottom
      timeline.scrollTop = 100;
      fireEvent.scroll(timeline);
      expect(descBtn).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("button", { name: "回到底部" })).toBeInTheDocument();

      // Keyboard opens while reading history -> scrollTop stays at 100 (does not jump to bottom)
      timelineViewportHeight = 288;
      view.rerender(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={312}
        />,
      );
      expect(timeline.scrollTop).toBe(100);

      // Composer multiline while reading history -> scrollTop still stays at 100
      act(() => {
        triggerTimelineResize(240);
      });
      expect(timeline.scrollTop).toBe(100);

      view.unmount();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
      if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
      if (offsetTopDesc) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTopDesc);
    }
  });

  test("short timeline initially fitting viewport scrolls up when keyboard shrinks viewport below scrollHeight", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: { next_batch: "batch-short" },
        };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const messages = Array.from({ length: 4 }, (_, idx) =>
      makeTextEvent(`$s${idx + 1}`, "@bot:example.com", `短对话 ${idx + 1}`, 2000 + idx * 100),
    );
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!short:example.com": makeStoredRoom({
          name: "短对话锚定",
          messages,
        }),
      },
    });

    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    let timelineViewportHeight = 600;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) {
          return timelineViewportHeight;
        }
        return clientHeightDesc?.get ? clientHeightDesc.get.call(this) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) {
          return this.querySelectorAll("[data-event-id]").length * 100;
        }
        return scrollHeightDesc?.get ? scrollHeightDesc.get.call(this) : 0;
      },
    });

    try {
      const clock = new ManualClock();
      const harness = makePlatformHarness("narrow");
      const view = render(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={0}
        />,
      );

      await user.click(screen.getByRole("button", { name: /短对话锚定/ }));
      const timeline = screen.getByRole("log", { name: "对话时间线" });
      expect(timeline.scrollTop).toBe(0);

      // Keyboard opens (600 -> 288 < scrollHeight 400) -> scrollTop shifts to 112
      timelineViewportHeight = 288;
      view.rerender(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={312}
        />,
      );
      expect(timeline.scrollTop).toBe(112);

      // Keyboard closes (288 -> 600) -> scrollTop returns to 0
      timelineViewportHeight = 600;
      view.rerender(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={0}
        />,
      );
      expect(timeline.scrollTop).toBe(0);

      view.unmount();
    } finally {
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
    }
  });

  test("edge swipe enforces 10px touch slop and handles same-frame fast flicks via ref state", async () => {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    const clock = new ManualClock();
    const harness = makePlatformHarness("narrow");
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com", name: "Hermes" }] } },
      rooms: {
        "!t1:example.com": makeStoredRoom({
          name: "快速轻扫测试",
          messages: [makeTextEvent("$e1", "@bot:example.com", "消息内容", clock.now - 5_000)],
        }),
      },
    });

    const view = render(
      <WaypointApp homeserver={homeserver} platform={harness.platform} clock={clock} />,
    );

    await user.click(await screen.findByRole("button", { name: /快速轻扫测试/ }));
    const detailContainer = document.querySelector(".waypoint-detail") as HTMLElement;

    // Small movement within 10px slop must NOT engage swipe translation
    fireEvent.touchStart(detailContainer, { touches: [{ clientX: 10, clientY: 200 }] });
    fireEvent.touchMove(detailContainer, { touches: [{ clientX: 18, clientY: 200 }] });
    expect(detailContainer).not.toHaveAttribute("data-swiping-back");
    expect(detailContainer).not.toHaveAttribute("data-swipe-offset");
    fireEvent.touchEnd(detailContainer);
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument();

    // Fast flick > 80px within same synchronous frame (without waiting for re-render between touchMove and touchEnd)
    fireEvent.touchStart(detailContainer, { touches: [{ clientX: 10, clientY: 200 }] });
    fireEvent.touchMove(detailContainer, { touches: [{ clientX: 105, clientY: 200 }] });
    fireEvent.touchEnd(detailContainer);
    expect(await screen.findByRole("complementary", { name: "Topic 列表" })).toBeInTheDocument();
    view.unmount();
  });

  test("opening a long Topic that programmatically scrolls past 4px immediately sets TopicHeaderView data-elevated=true", async () => {
    const user = userEvent.setup();
    const messages = Array.from({ length: 12 }, (_, idx) =>
      makeTextEvent(`$m${idx}`, idx % 2 === 0 ? "@alice:example.com" : "@bot:example.com", `消息 ${idx}`, 1_700_000_000_000 + idx * 1000),
    );
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-long" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!long:example.com": makeStoredRoom({
          name: "长对话顶栏",
          messages,
        }),
      },
    });

    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) return 400;
        return clientHeightDesc?.get ? clientHeightDesc.get.call(this) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) return 1200;
        return scrollHeightDesc?.get ? scrollHeightDesc.get.call(this) : 0;
      },
    });

    try {
      const clock = new ManualClock();
      const harness = makePlatformHarness("narrow");
      const view = render(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
        />,
      );

      await user.click(screen.getByRole("button", { name: /长对话顶栏/ }));
      const header = document.querySelector(".waypoint-topic-header") as HTMLElement;
      expect(header).toHaveAttribute("data-elevated", "true");
      view.unmount();
    } finally {
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
    }
  });

  test("mobile soft keyboard locks root/visual viewport against vertical composer drag while keeping timeline and scrollable textarea functional (#115)", async () => {
    const user = userEvent.setup();
    const messages = Array.from({ length: 10 }, (_, idx) =>
      makeTextEvent(`$k${idx}`, idx % 2 === 0 ? "@alice:example.com" : "@bot:example.com", `消息 ${idx}`, 1_700_000_000_000 + idx * 1000),
    );
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-lock" } };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!lock:example.com": makeStoredRoom({
          name: "键盘视口锁定",
          messages,
        }),
      },
    });

    const originalVv = window.visualViewport;
    const originalScrollIntoView = document.documentElement.scrollIntoView;
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const vvListeners = new Map<string, Set<EventListener>>();
    const fakeVv = {
      height: 500,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: (type: string, fn: EventListener) => {
        if (!vvListeners.has(type)) vvListeners.set(type, new Set());
        vvListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        vvListeners.get(type)?.delete(fn);
      },
    };
    const scrollIntoViewMock = vi.fn(() => {
      fakeVv.offsetTop = 0;
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: fakeVv });
    document.documentElement.scrollIntoView = scrollIntoViewMock;

    let textareaScrollableMock = false;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) return 320;
        if (this.tagName === "TEXTAREA") return 92;
        return clientHeightDesc?.get ? clientHeightDesc.get.call(this) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) return 1000;
        if (this.tagName === "TEXTAREA") return textareaScrollableMock ? 220 : 28;
        return scrollHeightDesc?.get ? scrollHeightDesc.get.call(this) : 0;
      },
    });

    const dispatchTouch = (target: EventTarget, type: string, x: number, y: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      Object.defineProperty(ev, "touches", {
        configurable: true,
        value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
      });
      target.dispatchEvent(ev);
      return ev;
    };

    try {
      const clock = new ManualClock();
      const harness = makePlatformHarness("narrow");
      const view = render(
        <TopicsWorkspace
          client={client}
          clock={clock}
          platform={harness.platform}
          viewportMode="narrow"
          keyboardInsetBottom={300}
        />,
      );

      await user.click(screen.getByRole("button", { name: /键盘视口锁定/ }));
      const timeline = screen.getByRole("log", { name: "对话时间线" });
      const textarea = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
      const safeArea = document.querySelector(".waypoint-composer-safe-area") as HTMLElement;

      expect(safeArea).toHaveClass("touch-none");
      expect(textarea).toHaveClass("touch-none", "overscroll-contain");

      // Scroll timeline upward then back to bottom
      timeline.scrollTop = 680;
      fireEvent.scroll(timeline);

      // Dragging on single-line textarea is prevented (cannot pan visualViewport)
      dispatchTouch(textarea, "touchstart", 180, 460);
      const dragTextarea = dispatchTouch(textarea, "touchmove", 180, 380);
      expect(dragTextarea.defaultPrevented).toBe(true);
      dispatchTouch(textarea, "touchend", 180, 380);

      // At bottom of timeline, dragging past bottom is prevented; dragging down to scroll up is allowed
      dispatchTouch(timeline, "touchstart", 180, 300);
      const pastBottom = dispatchTouch(timeline, "touchmove", 180, 260);
      expect(pastBottom.defaultPrevented).toBe(true);
      dispatchTouch(timeline, "touchend", 180, 260);

      dispatchTouch(timeline, "touchstart", 180, 300);
      const scrollHistory = dispatchTouch(timeline, "touchmove", 180, 340);
      expect(scrollHistory.defaultPrevented).toBe(false);
      dispatchTouch(timeline, "touchend", 180, 340);

      // If visualViewport.offsetTop shifts anyway (e.g. long-press selection auto-scroll), lock snaps it back while keeping timeline scrollTop
      fakeVv.offsetTop = 210;
      for (const fn of vvListeners.get("scroll") ?? []) {
        fn(new Event("scroll"));
      }
      expect(scrollIntoViewMock).toHaveBeenCalled();
      expect(fakeVv.offsetTop).toBe(0);
      expect(timeline.scrollTop).toBe(680);

      // Multiline (>4 lines) textarea allows internal scrolling within bounds and prevents boundary drag
      textareaScrollableMock = true;
      await user.type(textarea, "1\n2\n3\n4\n5\n6");
      expect(textarea).toHaveClass("touch-pan-y", "overscroll-contain");
      textarea.scrollTop = 40;
      dispatchTouch(textarea, "touchstart", 180, 440);
      const internalScroll = dispatchTouch(textarea, "touchmove", 180, 460);
      expect(internalScroll.defaultPrevented).toBe(false);
      dispatchTouch(textarea, "touchend", 180, 460);

      textarea.scrollTop = 0;
      dispatchTouch(textarea, "touchstart", 180, 440);
      const pastTopTextarea = dispatchTouch(textarea, "touchmove", 180, 470);
      expect(pastTopTextarea.defaultPrevented).toBe(true);
      dispatchTouch(textarea, "touchend", 180, 470);

      view.unmount();
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: originalVv });
      document.documentElement.scrollIntoView = originalScrollIntoView;
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
    }
  });

  function createReadMarkersHomeserver(
    readMarkerPosts: Array<{ url: string; body: unknown }>,
    nextBatch: string,
  ): FakeHomeserver {
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: nextBatch } };
      }
      if (input.method === "POST" && input.url.includes("/read_markers")) {
        readMarkerPosts.push({ url: input.url, body: input.body });
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };
    return homeserver;
  }

  async function withTimelineLayoutGeometry<T>(
    options: {
      clientHeight: number;
      scrollHeight: number | ((timelineEl: HTMLElement) => number);
      rowHeight?: number;
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const offsetTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) return options.clientHeight;
        return clientHeightDesc?.get ? clientHeightDesc.get.call(this) : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("waypoint-timeline")) {
          return typeof options.scrollHeight === "function"
            ? options.scrollHeight(this)
            : options.scrollHeight;
        }
        return scrollHeightDesc?.get ? scrollHeightDesc.get.call(this) : 0;
      },
    });
    if (options.rowHeight !== undefined) {
      const rowHeight = options.rowHeight;
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get() {
          if (this.dataset?.eventId) return rowHeight;
          return offsetHeightDesc?.get ? offsetHeightDesc.get.call(this) : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "offsetTop", {
        configurable: true,
        get() {
          if (this.dataset?.eventId && this.parentElement) {
            const rows = Array.from(this.parentElement.querySelectorAll("[data-event-id]"));
            const idx = rows.indexOf(this);
            if (idx >= 0) return idx * rowHeight;
          }
          return offsetTopDesc?.get ? offsetTopDesc.get.call(this) : 0;
        },
      });
    }

    try {
      return await fn();
    } finally {
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
      if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
      if (offsetTopDesc) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTopDesc);
    }
  }

  test("narrow viewport: viewing unread topics to the bottom clears unread indicator immediately upon header back, edge swipe, and system back (#122)", async () => {
    const user = userEvent.setup();
    const readMarkerPosts: Array<{ url: string; body: unknown }> = [];
    const homeserver = createReadMarkersHomeserver(readMarkerPosts, "batch-next");

    const clock = new ManualClock();
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!general:example.com": makeStoredRoom({
          name: "general",
          readPositionEventId: "$g1",
          messages: [
            makeTextEvent("$g1", "@bot:example.com", "已读消息", clock.now - 40_000),
            makeTextEvent("$g2", "@bot:example.com", "第一条未读", clock.now - 30_000),
            makeTextEvent("$g3", "@bot:example.com", "第二条未读", clock.now - 20_000),
            makeTextEvent("$g4", "@bot:example.com", "最后一条未读", clock.now - 10_000),
          ],
        }),
        "!stock:example.com": makeStoredRoom({
          name: "stock",
          readPositionEventId: "$s1",
          messages: [
            makeTextEvent("$s1", "@bot:example.com", "stock 已读", clock.now - 30_000),
            makeTextEvent("$s2", "@bot:example.com", "stock 未读 1", clock.now - 20_000),
            makeTextEvent("$s3", "@bot:example.com", "stock 未读 2", clock.now - 10_000),
          ],
        }),
        "!sys:example.com": makeStoredRoom({
          name: "sys",
          readPositionEventId: "$y1",
          messages: [
            makeTextEvent("$y1", "@bot:example.com", "sys 已读", clock.now - 20_000),
            makeTextEvent("$y2", "@bot:example.com", "sys 未读", clock.now - 10_000),
          ],
        }),
      },
    });

    await withTimelineLayoutGeometry(
      {
        clientHeight: 200,
        scrollHeight: (el) => el.querySelectorAll("[data-event-id]").length * 100,
        rowHeight: 100,
      },
      async () => {
        const harness = makePlatformHarness("narrow");
        const view = render(
          <TopicsWorkspace
            client={client}
            clock={clock}
            platform={harness.platform}
            viewportMode="narrow"
          />,
        );

        const generalRow = screen.getByRole("button", { name: /general/ });
        expect(generalRow).toHaveAttribute("data-unread", "true");
        expect(generalRow.querySelector(".waypoint-unread-dot")).not.toBeNull();
        expect(generalRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "700" });

        // 1. Open general, scroll to bottom, then tap header back button
        await user.click(generalRow);
        const timeline = screen.getByRole("log", { name: "对话时间线" });
        await act(async () => {
          timeline.scrollTop = 200;
          fireEvent.scroll(timeline);
        });
        await user.click(screen.getByRole("button", { name: "返回" }));

        const generalAfterBack = await screen.findByRole("button", { name: /general/ });
        expect(generalAfterBack).not.toHaveAttribute("data-unread", "true");
        expect(generalAfterBack.querySelector(".waypoint-unread-dot")).toBeNull();
        expect(generalAfterBack.querySelector(".waypoint-topic-name")).not.toHaveClass("unread");
        expect(generalAfterBack.querySelector(".waypoint-topic-name")).toHaveStyle({
          fontWeight: "500",
        });

        // 2. Re-opening the same Topic retains read status upon returning
        await user.click(generalAfterBack);
        expect(screen.getByRole("log", { name: "对话时间线" }).scrollTop).toBe(200);
        await user.click(screen.getByRole("button", { name: "返回" }));
        expect(await screen.findByRole("button", { name: /general/ })).not.toHaveAttribute(
          "data-unread",
          "true",
        );

        // 3. Open stock, scroll to bottom, then exit via left-edge swipe back
        await user.click(screen.getByRole("button", { name: /stock/ }));
        const stockTimeline = screen.getByRole("log", { name: "对话时间线" });
        await act(async () => {
          stockTimeline.scrollTop = 100;
          fireEvent.scroll(stockTimeline);
        });
        const detail = document.querySelector(".waypoint-detail") as HTMLElement;
        fireEvent.touchStart(detail, { touches: [{ clientX: 10, clientY: 200 }] });
        fireEvent.touchMove(detail, { touches: [{ clientX: 120, clientY: 202 }] });
        fireEvent.touchEnd(detail);

        const stockAfterSwipe = await screen.findByRole("button", { name: /stock/ });
        expect(stockAfterSwipe).not.toHaveAttribute("data-unread", "true");
        expect(stockAfterSwipe.querySelector(".waypoint-unread-dot")).toBeNull();

        // 4. Open sys, view messages, then exit via Android system back
        await user.click(screen.getByRole("button", { name: /sys/ }));
        await act(async () => {
          harness.triggerSystemBack();
        });

        const sysAfterSystemBack = await screen.findByRole("button", { name: /sys/ });
        expect(sysAfterSystemBack).not.toHaveAttribute("data-unread", "true");
        expect(sysAfterSystemBack.querySelector(".waypoint-unread-dot")).toBeNull();

        // Verify read markers reached the server and sync keeps read state
        await waitFor(() => {
          expect(readMarkerPosts).toContainEqual({
            url: "https://matrix.example.com/_matrix/client/v3/rooms/!general%3Aexample.com/read_markers",
            body: { "m.fully_read": "$g4", "m.read.private": "$g4" },
          });
          expect(readMarkerPosts).toContainEqual({
            url: "https://matrix.example.com/_matrix/client/v3/rooms/!stock%3Aexample.com/read_markers",
            body: { "m.fully_read": "$s3", "m.read.private": "$s3" },
          });
          expect(readMarkerPosts).toContainEqual({
            url: "https://matrix.example.com/_matrix/client/v3/rooms/!sys%3Aexample.com/read_markers",
            body: { "m.fully_read": "$y2", "m.read.private": "$y2" },
          });
        });

        await advanceWhenTimerScheduled(clock, 1000);
        expect(screen.getByRole("button", { name: /general/ })).not.toHaveAttribute(
          "data-unread",
          "true",
        );
        view.unmount();
      },
    );
  });

  test("narrow viewport: rapid back while advanceReadPosition is pending shows read immediately, and false/rejected results allow retry without locking (#122)", async () => {
    const user = userEvent.setup();
    const readMarkerPosts: Array<{ url: string; body: unknown }> = [];
    const homeserver = createReadMarkersHomeserver(readMarkerPosts, "batch-retry");

    const clock = new ManualClock();
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!race:example.com": makeStoredRoom({
          name: "竞态 Topic",
          readPositionEventId: "$r1",
          messages: [
            makeTextEvent("$r1", "@bot:example.com", "已读", clock.now - 30_000),
            makeTextEvent("$r2", "@bot:example.com", "未读一", clock.now - 20_000),
            makeTextEvent("$r3", "@bot:example.com", "未读二", clock.now - 10_000),
          ],
        }),
      },
    });

    const origAdvance = client.advanceReadPosition.bind(client);
    const pendingInFlight = deferred<boolean>();
    let rejectSecond!: (err: Error) => void;
    const pendingReject = new Promise<boolean>((_, reject) => {
      rejectSecond = reject;
    });
    let callCount = 0;
    const advanceSpy = vi
      .spyOn(client, "advanceReadPosition")
      .mockImplementation(async (roomId, eventId) => {
        callCount += 1;
        if (callCount === 1) {
          // Return false without persisting to verify lastRequestedReadRef does not lock out retries
          return false;
        }
        if (callCount === 2) {
          // Simulate reject after rapid back while waiting on persistence
          return await pendingReject;
        }
        if (callCount === 3) {
          // Keep real optimistic update in-flight while user navigates back rapidly
          const realPromise = origAdvance(roomId, eventId);
          await pendingInFlight.promise;
          return await realPromise;
        }
        return await origAdvance(roomId, eventId);
      });

    const harness = makePlatformHarness("narrow");
    const view = render(
      <TopicsWorkspace
        client={client}
        clock={clock}
        platform={harness.platform}
        viewportMode="narrow"
      />,
    );

    const row = screen.getByRole("button", { name: /竞态 Topic/ });
    expect(row).toHaveAttribute("data-unread", "true");

    // 1. Open topic: call 1 returns false; clicking back triggers call 2 (pending reject)
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Reject call 2 after returning to list: UI rolls back cleanly and does not lock future retries
    await act(async () => {
      rejectSecond(new Error("idb write failed"));
    });
    const rowAfterReject = await screen.findByRole("button", { name: /竞态 Topic/ });
    expect(rowAfterReject).toHaveAttribute("data-unread", "true");

    // 2. Re-open topic: call 3 holds before resolving; rapid back while in-flight still renders read immediately via optimistic state
    await user.click(rowAfterReject);
    await user.click(screen.getByRole("button", { name: "返回" }));

    const rowDuringInFlight = await screen.findByRole("button", { name: /竞态 Topic/ });
    expect(rowDuringInFlight).not.toHaveAttribute("data-unread", "true");
    expect(rowDuringInFlight.querySelector(".waypoint-unread-dot")).toBeNull();

    await act(async () => {
      pendingInFlight.resolve(true);
    });

    expect(advanceSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    await waitFor(() => {
      expect(readMarkerPosts).toContainEqual({
        url: "https://matrix.example.com/_matrix/client/v3/rooms/!race%3Aexample.com/read_markers",
        body: { "m.fully_read": "$r3", "m.read.private": "$r3" },
      });
    });
    expect(screen.getByRole("button", { name: /竞态 Topic/ })).not.toHaveAttribute(
      "data-unread",
      "true",
    );

    view.unmount();
  });

  test("bottom-most message is marked visible and read when timeline is scrolled to physical bottom despite subpixel rect boundary (#122)", async () => {
    const user = userEvent.setup();
    const readMarkerPosts: Array<{ url: string; body: unknown }> = [];
    const homeserver = createReadMarkersHomeserver(readMarkerPosts, "batch-subpixel");

    const clock = new ManualClock();
    const client = await seedRestoredClient({
      homeserver,
      rooms: {
        "!subpixel:example.com": makeStoredRoom({
          name: "底部边界 Topic",
          readPositionEventId: "$b1",
          messages: [
            makeTextEvent("$b1", "@bot:example.com", "旧消息", clock.now - 20_000),
            makeTextEvent("$b2", "@bot:example.com", "最新消息", clock.now - 10_000),
          ],
        }),
      },
    });

    const getBcrSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList?.contains("waypoint-timeline")) {
        return { top: 100, bottom: 300, left: 0, right: 360, width: 360, height: 200, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
      }
      if (this.dataset?.eventId === "$b1") {
        return { top: 120, bottom: 220, left: 0, right: 360, width: 360, height: 100, x: 0, y: 120, toJSON: () => ({}) } as DOMRect;
      }
      if (this.dataset?.eventId === "$b2") {
        // Simulate subpixel boundary where rect.top equals containerRect.bottom at physical bottom
        return { top: 300, bottom: 301, left: 0, right: 360, width: 360, height: 1, x: 0, y: 300, toJSON: () => ({}) } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });

    try {
      await withTimelineLayoutGeometry(
        { clientHeight: 200, scrollHeight: 201 },
        async () => {
          const harness = makePlatformHarness("narrow");
          const view = render(
            <TopicsWorkspace
              client={client}
              clock={clock}
              platform={harness.platform}
              viewportMode="narrow"
            />,
          );

          await user.click(screen.getByRole("button", { name: /底部边界 Topic/ }));
          await user.click(screen.getByRole("button", { name: "返回" }));

          const rowAfterBack = await screen.findByRole("button", { name: /底部边界 Topic/ });
          expect(rowAfterBack).not.toHaveAttribute("data-unread", "true");
          await waitFor(() => {
            expect(readMarkerPosts).toContainEqual({
              url: "https://matrix.example.com/_matrix/client/v3/rooms/!subpixel%3Aexample.com/read_markers",
              body: { "m.fully_read": "$b2", "m.read.private": "$b2" },
            });
          });
          view.unmount();
        },
      );
    } finally {
      getBcrSpy.mockRestore();
    }
  });
});
