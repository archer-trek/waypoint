import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TIMELINE_CHUNK_SIZE, loadV2Snapshot, saveSession } from "../session-store";
import { FakeHomeserver, renderApp, setupIntegrationTestEnv } from "./harness";

setupIntegrationTestEnv();

afterEach(() => {
  vi.restoreAllMocks();
});

function installTimelineGeometryMock(viewportHeight = 600) {
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
        return this.querySelectorAll("[data-event-id]").length * 60;
      }
      return scrollHeightDesc?.get ? scrollHeightDesc.get.call(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.dataset?.eventId) {
        return 60;
      }
      return offsetHeightDesc?.get ? offsetHeightDesc.get.call(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.dataset?.eventId && this.parentElement) {
        const siblings = Array.from(this.parentElement.querySelectorAll("[data-event-id]"));
        const idx = siblings.indexOf(this);
        if (idx !== -1) {
          return idx * 60;
        }
      }
      return offsetTopDesc?.get ? offsetTopDesc.get.call(this) : 0;
    },
  });

  return () => {
    if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
    if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
    if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
    if (offsetTopDesc) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTopDesc);
  };
}

test("启动仅水合热窗口，冷未读与排序准确，打开未读与上滑优先加载本地冷块再回源，切走卸载冷块 (#126)", async () => {
  const restoreGeometry = installTimelineGeometryMock(600);
  try {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    const messageRequests: string[] = [];

    const topicAEvents = Array.from({ length: 120 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$a-${i}`,
      sender: i === 11 ? "@bot:example.com" : "@alice:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `A消息-${i}` },
    }));
    const topicBEvents = Array.from({ length: 110 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$b-${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 50000 + i * 10,
      content: { msgtype: "m.text", body: `B消息-${i}` },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-init",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] } },
      rooms: {
        "!ta:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 100, content: {} },
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
            { type: "m.room.name", state_key: "", content: { name: "冷块未读话题" } },
          ],
          timelineEvents: topicAEvents,
          readPositionEventId: "$a-10",
          backwardToken: "tok-a-old",
        },
        "!tb:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 200, content: {} },
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
            { type: "m.room.name", state_key: "", content: { name: "已读历史话题" } },
          ],
          timelineEvents: topicBEvents,
          readPositionEventId: "$b-109",
          backwardToken: "tok-b-old",
        },
      },
    });

    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-next" } };
      }
      if (input.url.includes("/messages")) {
        messageRequests.push(input.url);
        return {
          type: "response",
          status: 200,
          body: {
            chunk: [
              {
                type: "m.room.message",
                event_id: "$b-server-older",
                sender: "@bot:example.com",
                origin_server_ts: 49000,
                content: { msgtype: "m.text", body: "服务器更早历史" },
              },
            ],
            end: "",
          },
        };
      }
      if (input.url.includes("/read_markers")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`不应收到 ${input.method} ${input.url}`);
    };

    const app = renderApp(homeserver);

    const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
    const rows = within(within(sidebar).getByRole("list")).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "已读历史话题",
      "冷块未读话题",
    ]);
    expect(within(sidebar).getByRole("button", { name: "冷块未读话题" })).toHaveAttribute("data-unread", "true");
    expect(within(sidebar).getByRole("button", { name: "已读历史话题" })).not.toHaveAttribute("data-unread", "true");
    expect(messageRequests).toHaveLength(0);

    // 打开冷块未读话题 -> 从 IndexedDB 加载冷块直到 $a-10，不请求 Homeserver /messages
    await user.click(within(sidebar).getByRole("button", { name: "冷块未读话题" }));
    const timeline = await screen.findByRole("log", { name: "对话时间线" });
    expect(await within(timeline).findByText("A消息-11")).toBeInTheDocument();
    expect(messageRequests).toHaveLength(0);

    // 切换到已读历史话题 -> 卸载 Topic A 冷块，Topic B 初始只渲染热窗口 50 条
    await user.click(within(sidebar).getByRole("button", { name: "已读历史话题" }));
    await waitFor(() => {
      expect(within(timeline).getAllByText(/^B消息-/).length).toBe(TIMELINE_CHUNK_SIZE);
    });
    expect(within(timeline).queryByText("B消息-0")).not.toBeInTheDocument();
    expect(messageRequests).toHaveLength(0);

    // 向上滚动加载第 1 个本地冷块 ($b-10..$b-59) -> 仍不请求 Homeserver
    fireEvent.scroll(timeline, { target: { scrollTop: 0 } });
    await waitFor(() => {
      expect(within(timeline).getByText("B消息-10")).toBeInTheDocument();
    });
    expect(messageRequests).toHaveLength(0);

    // 再次向上滚动加载第 2 个本地冷块 ($b-0..$b-9) -> 仍不请求 Homeserver
    fireEvent.scroll(timeline, { target: { scrollTop: 0 } });
    await waitFor(() => {
      expect(within(timeline).getByText("B消息-0")).toBeInTheDocument();
    });
    expect(messageRequests).toHaveLength(0);

    // 本地冷块耗尽后再上滑 -> 才向 Homeserver 发起 /messages?dir=b
    fireEvent.scroll(timeline, { target: { scrollTop: 0 } });
    await waitFor(() => {
      expect(messageRequests).toHaveLength(1);
    });
    expect(messageRequests[0]).toContain("from=tok-b-old");
    expect(await within(timeline).findByText("服务器更早历史")).toBeInTheDocument();

    // 切回 Topic A 再切回 Topic B，Topic B 已被卸载回热窗口（重新打开只渲染 50 条）
    await user.click(within(sidebar).getByRole("button", { name: "冷块未读话题" }));
    await user.click(within(sidebar).getByRole("button", { name: "已读历史话题" }));
    await waitFor(() => {
      expect(within(timeline).queryByText("B消息-0")).not.toBeInTheDocument();
      expect(within(timeline).getByText("B消息-109")).toBeInTheDocument();
    });

    // IndexedDB 中 Topic A 的 120 条事件完整保留
    const snap = await loadV2Snapshot();
    expect(snap.timelines["!ta:example.com"]).toHaveLength(120);

    app.unmount();
  } finally {
    restoreGeometry();
  }
});

test("跨 chunk 的 m.replace 与 m.reaction 在冷块按需加载后准确合并渲染 (#126)", async () => {
  const restoreGeometry = installTimelineGeometryMock(600);
  try {
    const user = userEvent.setup();
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.includes("/sync")) {
        return { type: "response", status: 200, body: { next_batch: "batch-next" } };
      }
      if (input.url.includes("/read_markers")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`不应收到 ${input.method} ${input.url}`);
    };

    const events: Array<Record<string, unknown>> = Array.from({ length: 110 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$e-${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: i === 5 ? "原始冷块消息" : `消息-${i}` },
    }));
    // Put m.replace and m.reaction in the hot chunk targeting $e-5 (in cold chunk 0)
    events.push(
      {
        type: "m.room.message",
        event_id: "$edit-e5",
        sender: "@bot:example.com",
        origin_server_ts: 9000,
        content: {
          msgtype: "m.text",
          body: "* 已编辑冷块消息",
          "m.new_content": { msgtype: "m.text", body: "已编辑冷块消息" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$e-5" },
        },
      },
      {
        type: "m.reaction",
        event_id: "$react-e5",
        sender: "@alice:example.com",
        origin_server_ts: 9010,
        content: {
          "m.relates_to": { rel_type: "m.annotation", event_id: "$e-5", key: "👍" },
        },
      },
    );

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-init",
      accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] } },
      rooms: {
        "!t1:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 100, content: {} },
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
            { type: "m.room.name", state_key: "", content: { name: "跨块编辑与回应" } },
          ],
          timelineEvents: events,
          readPositionEventId: "$e-109",
        },
      },
    });

    const app = renderApp(homeserver);
    await user.click(await screen.findByRole("button", { name: "跨块编辑与回应" }));
    const timeline = await screen.findByRole("log", { name: "对话时间线" });

    // Scroll up twice to load cold chunks down to chunk 0
    fireEvent.scroll(timeline, { target: { scrollTop: 0 } });
    await waitFor(() => {
      expect(within(timeline).getByText("消息-20")).toBeInTheDocument();
    });
    fireEvent.scroll(timeline, { target: { scrollTop: 0 } });

    expect(await within(timeline).findByText("已编辑冷块消息")).toBeInTheDocument();
    expect(within(timeline).queryByText("原始冷块消息")).not.toBeInTheDocument();
    expect(within(timeline).getByText("👍")).toBeInTheDocument();

    app.unmount();
  } finally {
    restoreGeometry();
  }
});

test("热窗口无有效消息时按需逆序回溯本地冷块恢复最新预览，并在同步撤回冷块消息后刷新预览", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;

  homeserver.handler = async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-after-redaction",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$red-cold-latest",
                        sender: "@bot:example.com",
                        origin_server_ts: 9999,
                        redacts: "$cold-last",
                        content: {},
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncCalls}` } };
    }
    throw new Error(`不应收到 ${input.method} ${input.url}`);
  };

  // Cold chunks hold messages; hot chunk (last 50 events) holds only reactions so hot window has 0 renderable messages
  const events: Array<Record<string, unknown>> = [
    {
      type: "m.room.message",
      event_id: "$cold-prev",
      sender: "@bot:example.com",
      origin_server_ts: 1000,
      content: { msgtype: "m.text", body: "**更早的** 冷块消息" },
    },
    {
      type: "m.room.message",
      event_id: "$cold-last",
      sender: "@alice:example.com",
      origin_server_ts: 2000,
      content: { msgtype: "m.text", body: "即将被撤回的冷块消息" },
    },
    ...Array.from({ length: TIMELINE_CHUNK_SIZE }, (_, i) => ({
      type: "m.reaction",
      event_id: `$react-${i}`,
      sender: "@alice:example.com",
      origin_server_ts: 3000 + i,
      content: {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$cold-prev", key: `👍-${i}` },
      },
    })),
  ];

  await saveSession({
    baseUrl: "https://matrix.example.com",
    userId: "@alice:example.com",
    accessToken: "tok-1",
    deviceId: "DEV1",
    syncCursor: "batch-init",
    accountData: { "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] } },
    rooms: {
      "!t1:example.com": {
        stateEvents: [
          { type: "m.room.create", state_key: "", origin_server_ts: 100, content: {} },
          { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
          { type: "m.room.name", state_key: "", content: { name: "冷块预览话题" } },
        ],
        timelineEvents: events,
        readPositionEventId: "$cold-last",
      },
    },
  });

  const app = renderApp(homeserver);
  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const row = within(sidebar).getByRole("button", { name: "冷块预览话题" });

  await waitFor(() => {
    expect(row.querySelector(".waypoint-topic-row-preview")).toHaveTextContent("更早的 冷块消息");
  });
  void user;
  app.unmount();
});
