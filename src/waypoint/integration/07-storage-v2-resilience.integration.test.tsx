import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PENDING_EVENTS_STORE, ROOMS_STORE, META_STORE } from "../session-store";
import {
  FakeHomeserver,
  advanceWhenTimerScheduled,
  login,
  passwordLoginHandler,
  renderApp,
  setupIntegrationTestEnv,
  validAgents,
} from "./harness";

setupIntegrationTestEnv();

afterEach(() => {
  vi.restoreAllMocks();
});

function abortStoreWrites(targetStores: string[], active: () => boolean) {
  const origTx = IDBDatabase.prototype.transaction;
  return vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    stores: string | Iterable<string>,
    mode?: IDBTransactionMode,
  ) {
    const tx = origTx.call(this, stores, mode);
    const list = typeof stores === "string" ? [stores] : Array.from(stores);
    if (active() && mode === "readwrite" && list.some((s) => targetStores.includes(s))) {
      queueMicrotask(() => {
        try {
          tx.abort();
        } catch {
          // ignore
        }
        tx.onerror?.(new Event("error") as Event);
      });
      Object.defineProperty(tx, "error", {
        configurable: true,
        get: () => new DOMException("Quota exceeded", "QuotaExceededError"),
      });
    }
    return tx;
  });
}

test("发消息写盘 QuotaExceededError 时保留输入框文本与附件草稿，不进时间线与队列并内联报错 (#132)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendCalls = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncCalls}`,
          account_data: validAgents,
          rooms: {
            join: {
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "写盘失败话题" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "POST" && input.url.includes("/_matrix/media/v3/upload")) {
      return { type: "response", status: 200, body: { content_uri: "mxc://example.com/ok-1" } };
    }
    if (input.method === "PUT" && input.url.includes("/send/")) {
      sendCalls += 1;
      return { type: "response", status: 200, body: { event_id: `$ev-${sendCalls}` } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const app = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "写盘失败话题" }));

  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([new Uint8Array([1, 2, 3])], "note.txt", { type: "text/plain" }),
  );
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("note.txt");
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "待发送内容");

  let failPendingWrite = true;
  const spy = abortStoreWrites([PENDING_EVENTS_STORE], () => failPendingWrite);

  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByText("本地存储空间不足，消息未发送")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("待发送内容");
  expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("note.txt");
  expect(screen.getByRole("log", { name: "对话时间线" }).querySelectorAll(".waypoint-bubble")).toHaveLength(0);
  expect(sendCalls).toBe(0);

  // 恢复可写后再次发送成功
  failPendingWrite = false;
  spy.mockRestore();

  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(sendCalls).toBe(1);
  });
  expect(screen.queryByText("本地存储空间不足，消息未发送")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  app.unmount();
});

test("/sync 写盘连续失败时按 5s->15s->30s 退避，不推进游标与房间，3 次后顶栏提示并在下次成功写入后自动恢复 (#132)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const syncUrls: string[] = [];
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncUrls.push(input.url);
      syncRound += 1;
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: validAgents,
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "同步韧性话题" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncRound}`,
          rooms: {
            join: {
              "!t1:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: `$msg-${syncRound}`,
                      sender: "@bot:example.com",
                      origin_server_ts: 2000 + syncRound,
                      content: { msgtype: "m.text", body: `新消息-${syncRound}` },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const app = renderApp(homeserver);
  await login(user);
  expect(await screen.findByRole("button", { name: "同步韧性话题" })).toBeInTheDocument();

  // 让后续 3 次 /sync 写盘失败
  let failSyncWrite = true;
  const spy = abortStoreWrites([META_STORE, ROOMS_STORE], () => failSyncWrite);

  // 1st foreground /sync (1000ms after mount) -> fails retainSync -> schedules 5000ms
  await advanceWhenTimerScheduled(app.clock, 1000);
  await waitFor(() => expect(syncRound).toBe(2));
  expect(screen.queryByText("本地存储空间不足，已暂停接收新消息")).not.toBeInTheDocument();

  // Before 5000ms elapses, no 3rd sync should run
  await act(async () => {
    app.clock.advance(4999);
  });
  expect(syncRound).toBe(2);

  // At 5000ms -> 2nd failure -> schedules 15000ms
  await act(async () => {
    app.clock.advance(1);
  });
  await waitFor(() => expect(syncRound).toBe(3));
  expect(screen.queryByText("本地存储空间不足，已暂停接收新消息")).not.toBeInTheDocument();

  // Before 15000ms elapses, no 4th sync
  await act(async () => {
    app.clock.advance(14999);
  });
  expect(syncRound).toBe(3);

  // At 15000ms -> 3rd failure -> shows warning banner & schedules 30000ms
  await act(async () => {
    app.clock.advance(1);
  });
  await waitFor(() => expect(syncRound).toBe(4));
  expect(await screen.findByText("本地存储空间不足，已暂停接收新消息")).toBeInTheDocument();

  // Cursor did NOT advance: all failed syncs still requested since=batch-1
  expect(syncUrls.slice(1).every((u) => u.includes("since=batch-1"))).toBe(true);

  // Before 30000ms elapses, no 5th sync
  await act(async () => {
    app.clock.advance(29999);
  });
  expect(syncRound).toBe(4);

  // Restore disk writes and advance 1ms -> succeeds, auto-recovers & hides banner
  failSyncWrite = false;
  spy.mockRestore();

  await act(async () => {
    app.clock.advance(1);
  });
  await waitFor(() => expect(syncRound).toBe(5));
  await waitFor(() => {
    expect(screen.queryByText("本地存储空间不足，已暂停接收新消息")).not.toBeInTheDocument();
  });

  // Subsequent sync uses updated cursor batch-5
  await advanceWhenTimerScheduled(app.clock, 1000);
  await waitFor(() => expect(syncRound).toBe(6));
  expect(syncUrls[syncUrls.length - 1]).toContain("since=batch-5");

  app.unmount();
});

test("置顶标签与 Bot 名册写盘失败时回滚内存状态并立即提示错误 (#132)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncCalls}`,
          account_data: validAgents,
          rooms: {
            join: {
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "标签测试话题" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/tags/im.waypoint.pinned")) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/im.waypoint.agents")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const app = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const row = within(sidebar).getByRole("button", { name: "标签测试话题" });
  await user.click(row);

  // 1. Pin tag write failure -> stays unpinned + toast shown
  let failPin = true;
  const pinSpy = abortStoreWrites([ROOMS_STORE], () => failPin);

  await user.click(screen.getByRole("button", { name: "置顶" }));

  expect(
    await screen.findByText("本地存储空间不足，未能保存置顶状态，请清理空间后重试。"),
  ).toBeInTheDocument();
  expect(row).not.toHaveAttribute("data-pinned", "true");
  failPin = false;
  pinSpy.mockRestore();

  // 2. Agent registration write failure -> stays rolled back + inline error shown
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "登记新 Bot" }));
  await user.type(screen.getByLabelText("Bot 用户名"), "bot2");

  const agentSpy = abortStoreWrites([META_STORE], () => true);
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));

  expect(
    await screen.findByText("本地存储空间不足，未能保存 Bot 名册，请清理空间后重试。"),
  ).toBeInTheDocument();
  agentSpy.mockRestore();
  app.unmount();
});

test("已读位置写盘失败时不弹窗报错，在后续自然触发时静默重试成功 (#132)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  const readMarkerPosts: string[] = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncCalls}`,
          account_data: validAgents,
          rooms: {
            join: {
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "已读静默重试话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$e1",
                      sender: "@bot:example.com",
                      origin_server_ts: 2000,
                      content: { msgtype: "m.text", body: "未读消息" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerPosts.push((input.body as { "m.fully_read": string })["m.fully_read"]);
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const app = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const row = within(sidebar).getByRole("button", { name: "已读静默重试话题" });
  expect(row).toHaveAttribute("data-unread", "true");

  // First open fails read position persistence silently
  let failReadMarkerWrite = true;
  const spy = abortStoreWrites(["pending_read_markers"], () => failReadMarkerWrite);
  await user.click(row);
  await waitFor(() => {
    expect(spy).toHaveBeenCalled();
  });
  expect(screen.queryByText(/本地存储空间不足/)).not.toBeInTheDocument();
  expect(readMarkerPosts).toEqual([]);

  // Restore disk writes and trigger naturally via scroll -> silently succeeds
  failReadMarkerWrite = false;
  spy.mockRestore();

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  timeline.dispatchEvent(new Event("scroll", { bubbles: true }));

  await waitFor(() => {
    expect(readMarkerPosts).toEqual(["$e1"]);
  });
  expect(row).not.toHaveAttribute("data-unread", "true");
  app.unmount();
});
