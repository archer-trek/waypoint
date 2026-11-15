import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { TransportResult } from "../../adapters/types";
import { WaypointApp } from "../WaypointApp";
import {
  setupIntegrationTestEnv,
  FakeHomeserver,
  ManualClock,
  advanceWhenTimerScheduled,
  deferred,
  login,
  passwordLoginHandler,
  renderApp,
  validAgents,
  withMockedTimelineLayout,
} from "./harness";

setupIntegrationTestEnv();

test("点一下红叹号就在原处再交出（新 txnId、不动草稿、不挪末尾、无二次确认），断网转圈重试再失败回红叹号，确认后原地收成同一条气泡", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendBehavior: "first-403-then-200" | "offline" | "400" | "200" = "first-403-then-200";
  const sentRequests: Array<{ txnId: string; body: unknown }> = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
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
                      { type: "m.room.name", state_key: "", content: { name: "原处重发测试" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m0",
                        sender: "@bot:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "第0条Bot消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (syncCalls === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m2-bot",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "后来Bot插进来的消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      const lastResentTxn = sentRequests[sentRequests.length - 1]?.txnId;
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncCalls}`,
          rooms: {
            join: {
              "!t1:example.com": {
                timeline: {
                  events:
                    sendBehavior === "200" && lastResentTxn
                      ? [
                          {
                            type: "m.room.message",
                            event_id: "$m1-resent",
                            sender: "@alice:example.com",
                            origin_server_ts: 4000,
                            content: { msgtype: "m.text", body: "第1条会失败的消息" },
                            unsigned: { transaction_id: lastResentTxn },
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
      const txnId = decodeURIComponent(input.url.split("/").pop() ?? "");
      sentRequests.push({ txnId, body: input.body });
      if (sendBehavior === "first-403-then-200") {
        if (sentRequests.length === 1) {
          return {
            type: "response",
            status: 403,
            body: { errcode: "M_FORBIDDEN", error: "Rejected first" },
          };
        }
        return { type: "response", status: 200, body: { event_id: "$m1-ok" } };
      }
      if (sendBehavior === "offline") {
        return { type: "failure", failure: { type: "network" } };
      }
      if (sendBehavior === "400") {
        return {
          type: "response",
          status: 400,
          body: { errcode: "M_BAD_JSON", error: "Rejected again" },
        };
      }
      return { type: "response", status: 200, body: { event_id: "$m1-resent" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "原处重发测试" }));

  // 发送第1条（被403拒绝）与第2条（成功）
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第1条会失败的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  const failBtn = await screen.findByRole("button", { name: "失败" });
  expect(failBtn).toBeInTheDocument();

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第2条正常消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sentRequests).toHaveLength(2));

  // 推进同步，收到 Bot 后来发的消息
  await act(async () => { first.clock.advance(1000); });

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const getBodies = () => Array.from(timeline.querySelectorAll("[data-side] .waypoint-bubble")).map((el) => el.textContent);
  await waitFor(() => {
    expect(syncCalls).toBeGreaterThanOrEqual(2);
    expect(getBodies()).toEqual([
      "第0条Bot消息",
      "第1条会失败的消息",
      "第2条正常消息",
      "后来Bot插进来的消息",
    ]);
  });

  // 正在输入新草稿 + 附件草稿，且在断网时点击红叹号重发
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "未发出的草稿");
  const draftFile = new File(["bytes"], "draft.txt", { type: "text/plain" });
  await user.upload(screen.getByLabelText("选择附件"), draftFile);
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("draft.txt");

  const firstAttemptTxnId = sentRequests[0]!.txnId;
  sendBehavior = "offline";
  await user.click(screen.getByRole("button", { name: "失败" }));

  // 立刻在原处变回转圈，不弹窗确认，不清掉草稿，不挪到末尾，发出新的 txnId
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("未发出的草稿");
  expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("draft.txt");
  expect(getBodies()).toEqual([
    "第0条Bot消息",
    "第1条会失败的消息",
    "第2条正常消息",
    "后来Bot插进来的消息",
  ]);
  await waitFor(() => expect(sentRequests).toHaveLength(3));
  const secondAttemptTxnId = sentRequests[2]!.txnId;
  expect(secondAttemptTxnId).not.toBe(firstAttemptTxnId);
  expect(sentRequests[2]!.body).toEqual({ msgtype: "m.text", body: "第1条会失败的消息" });
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
  expect(timeline.querySelectorAll("[data-side]")[1].contains(screen.getByRole("status", { name: "未确认" }))).toBe(true);

  // 重试队列 1s 后再试，这次又被 400 永久拒绝 -> 又变回红叹号，仍在原处
  sendBehavior = "400";
  await act(async () => { first.clock.advance(1000); });
  await waitFor(() => expect(sentRequests).toHaveLength(4));
  expect(sentRequests[3]!.txnId).toBe(secondAttemptTxnId);
  const failBtnAgain = await screen.findByRole("button", { name: "失败" });
  expect(timeline.querySelectorAll("[data-side]")[1].contains(failBtnAgain)).toBe(true);

  // 再次点击红叹号 -> 这次成功确认（新 txnId），在原处收成同一条已确认气泡，不出现第二条
  sendBehavior = "200";
  await user.click(failBtnAgain);
  await waitFor(() => expect(sentRequests).toHaveLength(5));
  const thirdAttemptTxnId = sentRequests[4]!.txnId;
  expect(thirdAttemptTxnId).not.toBe(secondAttemptTxnId);

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "失败" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  expect(getBodies()).toEqual([
    "第0条Bot消息",
    "第1条会失败的消息",
    "第2条正常消息",
    "后来Bot插进来的消息",
  ]);

  // 同步回声到达后仍不重复、保持原位
  await act(async () => { first.clock.advance(1000); });
  await waitFor(() => expect(syncCalls).toBeGreaterThanOrEqual(3));
  expect(getBodies()).toEqual([
    "第0条Bot消息",
    "第1条会失败的消息",
    "第2条正常消息",
    "后来Bot插进来的消息",
  ]);
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("未发出的草稿");

  // 重启后仍在原位且无重复
  first.unmount();
  const second = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "原处重发测试" }));
  const restoredTimeline = screen.getByRole("log", { name: "对话时间线" });
  const restoredBodies = Array.from(restoredTimeline.querySelectorAll("[data-side] .waypoint-bubble")).map((el) => el.textContent);
  expect(restoredBodies).toEqual([
    "第0条Bot消息",
    "第1条会失败的消息",
    "第2条正常消息",
    "后来Bot插进来的消息",
  ]);
  second.unmount();
});

test("失败气泡在 macOS 和 Android 用同一个菜单且只有丢掉（无时刻），点一次立即从本机消失无确认无撤销；未确认消息没有此菜单", async () => {
  const user = userEvent.setup();
  for (const viewportMode of ["wide", "narrow"] as const) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    let sendCount = 0;

    homeserver.handler = passwordLoginHandler(async (input) => {
      if (input.url.includes("/sync")) {
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
                      { type: "m.room.name", state_key: "", content: { name: "丢掉菜单话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$c1",
                        sender: "@bot:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "已确认的Bot消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
        sendCount += 1;
        if (sendCount === 1) {
          return {
            type: "response",
            status: 403,
            body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
          };
        }
        return { type: "failure", failure: { type: "network" } };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    });

    const clock = new ManualClock();
    const view = render(
      <WaypointApp
        homeserver={homeserver}
        platform={{
          deviceDisplayName: viewportMode === "wide" ? "Waypoint macOS" : "Waypoint Android",
          viewportMode: () => viewportMode,
        }}
        clock={clock}
      />,
    );
    await login(user);
    await user.click(await screen.findByRole("button", { name: "丢掉菜单话题" }));

    // 发送一条永久失败消息和一条未确认消息
    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "要被丢掉的失败消息");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "失败" });

    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "还在转圈的未确认消息");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("status", { name: "未确认" });

    // 未确认消息和已确认消息都没有菜单，右键也不能打开丢掉菜单
    const menuTriggers = screen.getAllByRole("button", { name: "更多操作" });
    expect(menuTriggers).toHaveLength(1);
    fireEvent.contextMenu(screen.getByText("还在转圈的未确认消息"));
    fireEvent.contextMenu(screen.getByText("已确认的Bot消息"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "丢掉" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

    // 点击失败气泡的菜单触发按钮，打开只有「丢掉」的菜单，不显示时刻
    await user.click(menuTriggers[0]!);
    const menu = screen.getByRole("menu", { name: "消息操作" });
    const menuItems = menu.querySelectorAll("[role=menuitem]");
    expect(menuItems).toHaveLength(1);
    expect(menuItems[0]).toHaveTextContent("丢掉");
    expect(menu).not.toHaveTextContent(/\d{1,2}:\d{2}/);
    expect(menu).not.toHaveTextContent(/撤回|删除|复制|重发|撤销/);

    // 点击「丢掉」：无需二次确认，不发请求，不回填草稿，无撤销，立即从本机消失
    const reqCountBeforeDiscard = homeserver.requests.length;
    await user.click(menuItems[0]!);
    await waitFor(() => {
      expect(screen.queryByText("要被丢掉的失败消息")).not.toBeInTheDocument();
    });
    expect(homeserver.requests).toHaveLength(reqCountBeforeDiscard);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/撤销/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "失败" })).not.toBeInTheDocument();
    expect(screen.getByText("还在转圈的未确认消息")).toBeInTheDocument();

    // 重启后失败消息仍已彻底消失，未确认消息仍在
    view.unmount();
    const restarted = renderApp(homeserver);
    await user.click(await screen.findByRole("button", { name: "丢掉菜单话题" }));
    const restoredTimeline = screen.getByRole("log", { name: "对话时间线" });
    expect(restoredTimeline).toHaveTextContent("已确认的Bot消息");
    expect(restoredTimeline).toHaveTextContent("还在转圈的未确认消息");
    expect(restoredTimeline).not.toHaveTextContent("要被丢掉的失败消息");
    expect(screen.queryByRole("button", { name: "失败" })).not.toBeInTheDocument();
    restarted.unmount();
  }
});

test("未确认和失败消息不推进已读位置、不重排 Topic 列表、不发 read_markers，且另一台设备看不到", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let sendCount = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: validAgents,
          rooms: {
            join: {
              "!older:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "旧Topic" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$old-1" } }],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$old-1",
                      sender: "@bot:example.com",
                      origin_server_ts: 1500,
                      content: { msgtype: "m.text", body: "旧Topic已确认消息" },
                    },
                  ],
                },
              },
              "!newer:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "新Topic" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendCount += 1;
      if (sendCount === 1) {
        return {
          type: "response",
          status: 403,
          body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
        };
      }
      return { type: "failure", failure: { type: "network" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const device1 = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const listOrder = () =>
    Array.from(sidebar.querySelectorAll(".waypoint-topic-name")).map((el) => el.textContent);
  expect(listOrder()).toEqual(["新Topic", "旧Topic"]);

  // 在旧Topic发出一条失败消息和一条未确认消息
  await user.click(screen.getByRole("button", { name: "旧Topic" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "本地失败消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "失败" });

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "本地未确认消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("status", { name: "未确认" });

  // 不改变 Topic 列表顺序，不写 read_markers / account_data
  expect(listOrder()).toEqual(["新Topic", "旧Topic"]);
  expect(homeserver.requests.some((r) => r.url.includes("read_markers"))).toBe(false);
  expect(homeserver.requests.some((r) => r.url.includes("account_data"))).toBe(false);

  // 切走再重新打开旧Topic，不发 read_markers，也不把未确认/失败当成未读
  await user.click(screen.getByRole("button", { name: "新Topic" }));
  await user.click(screen.getByRole("button", { name: "旧Topic" }));
  expect(homeserver.requests.some((r) => r.url.includes("read_markers"))).toBe(false);

  device1.unmount();

  // 另一台设备登录同步，看不到第一台设备上的未确认和失败消息
  globalThis.indexedDB = new IDBFactory();
  const device2 = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "旧Topic" }));
  const timeline2 = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline2).toHaveTextContent("旧Topic已确认消息");
  expect(timeline2).not.toHaveTextContent("本地失败消息");
  expect(timeline2).not.toHaveTextContent("本地未确认消息");
  device2.unmount();
});

test("Topic 列表行最多显示一个发送状态标记且失败优先于未确认，不计条数、不预览正文、点列表红叹号只打开 Topic 不重发，非消息待重放项不触发标记", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let sendBehavior: "offline" | "first-403-rest-offline" | "200" = "offline";
  let sendCalls = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                    { type: "m.room.name", state_key: "", content: { name: "列表标记话题" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "另一条话题" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/")) {
      sendCalls += 1;
      if (sendBehavior === "first-403-rest-offline" && sendCalls === 3) {
        return {
          type: "response",
          status: 403,
          body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
        };
      }
      if (sendBehavior === "200") {
        return { type: "response", status: 200, body: { event_id: `$ev-${sendCalls}` } };
      }
      return { type: "failure", failure: { type: "network" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  expect(within(sidebar).queryByRole("img")).not.toBeInTheDocument();

  // 打开列表标记话题，离线连发两条消息 -> 列表行最多一个转圈，不显示条数与消息正文预览
  await user.click(within(sidebar).getByRole("button", { name: "列表标记话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第一条秘密正文");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第二条秘密正文");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => expect(sendCalls).toBeGreaterThanOrEqual(1));
  const row1 = within(sidebar).getByRole("button", { name: "列表标记话题" });
  const rowTextWithoutTime = (row: HTMLElement) => {
    const clone = row.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".waypoint-topic-row-time").forEach((el) => el.remove());
    return clone.textContent ?? "";
  };
  expect(within(row1).getAllByRole("img", { name: "未确认" })).toHaveLength(1);
  expect(within(row1).queryByRole("img", { name: "失败" })).not.toBeInTheDocument();
  expect(rowTextWithoutTime(row1)).not.toMatch(/2|第一条秘密正文|第二条秘密正文/);

  // 第一条被 403 永久拒绝，第二条仍未确认 -> 同一行既有失败又有未确认，优先显示红叹号（最多一个）
  sendBehavior = "first-403-rest-offline";
  await act(async () => { first.clock.advance(2000); });
  await screen.findByRole("button", { name: "失败" });

  expect(within(row1).getAllByRole("img", { name: "失败" })).toHaveLength(1);
  expect(within(row1).queryByRole("img", { name: "未确认" })).not.toBeInTheDocument();
  expect(row1).toHaveTextContent("!");
  expect(rowTextWithoutTime(row1)).not.toMatch(/失败|2|第一条秘密正文|第二条秘密正文/);

  // 切换到另一条话题，再直接点击列表行上的红叹号：只打开该 Topic，不直接重发
  await user.click(within(sidebar).getByRole("button", { name: "另一条话题" }));
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("另一条话题");
  const sendsBeforeRowClick = sendCalls;
  await user.click(within(row1).getByRole("img", { name: "失败" }));
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("列表标记话题");
  expect(sendCalls).toBe(sendsBeforeRowClick);

  // 丢掉失败消息后只剩未确认消息 -> 列表行从红叹号变回转圈
  await user.click(screen.getByRole("button", { name: "更多操作" }));
  await user.click(within(screen.getByRole("menu", { name: "消息操作" })).getByRole("menuitem", { name: "丢掉" }));
  await waitFor(() => {
    expect(within(row1).queryByRole("img", { name: "失败" })).not.toBeInTheDocument();
  });
  expect(within(row1).getByRole("img", { name: "未确认" })).toBeInTheDocument();

  // 待未确认消息也确认 -> 列表行标记消失
  sendBehavior = "200";
  await act(async () => { first.clock.advance(30_000); });
  await waitFor(() => {
    expect(within(row1).queryByRole("img")).not.toBeInTheDocument();
  });

  // 给「另一条话题」持久化一个待重放的 reaction（非 m.room.message），重启后重试队列重放期间列表行不显示任何标记
  first.unmount();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("waypoint", 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("records", "readwrite");
      const store = tx.objectStore("records");
      const getReq = store.get("session");
      getReq.onsuccess = () => {
        const session = getReq.result;
        session.pendingEvents = [
          {
            txnId: "txn-reaction-1",
            roomId: "!t2:example.com",
            type: "m.reaction",
            sender: "@alice:example.com",
            content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$x", key: "✅" } },
          },
        ];
        store.put(session, "session");
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });

  sendBehavior = "offline";
  const second = renderApp(homeserver);
  const sidebar2 = await screen.findByRole("complementary", { name: "Topic 列表" });
  await waitFor(() => expect(sendCalls).toBeGreaterThan(sendsBeforeRowClick));
  const row2 = within(sidebar2).getByRole("button", { name: "另一条话题" });
  expect(within(row2).queryByRole("img")).not.toBeInTheDocument();
  second.unmount();
});

test("原处重发时若同步回声先于发送响应到达，仍收成原处同一条已确认气泡；同话题多条失败时各自独立重发或丢掉", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendCount = 0;
  let resentTxnId = "";
  const pendingResendResponse = deferred<TransportResult>();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
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
                      { type: "m.room.name", state_key: "", content: { name: "同步先回声重发" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (syncCalls === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$bot-mid",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        content: { msgtype: "m.text", body: "中间插入的Bot消息" },
                      },
                    ],
                  },
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
          next_batch: `batch-${syncCalls}`,
          rooms: {
            join: {
              "!t1:example.com": {
                timeline: {
                  events: resentTxnId
                    ? [
                        {
                          type: "m.room.message",
                          event_id: "$resent-echo",
                          sender: "@alice:example.com",
                          origin_server_ts: 5000,
                          content: { msgtype: "m.text", body: "第一条失败" },
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
      sendCount += 1;
      const txnId = decodeURIComponent(input.url.split("/").pop() ?? "");
      if (sendCount <= 2) {
        return {
          type: "response",
          status: 403,
          body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
        };
      }
      resentTxnId = txnId;
      return pendingResendResponse.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const view = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "同步先回声重发" }));

  const composer = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(composer, "第一条失败");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(composer).toBeEnabled();
    expect(composer).toHaveValue("");
  });
  await user.type(composer, "第二条失败");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "失败" })).toHaveLength(2));

  // 同步带来 Bot 消息（排在两条失败消息之后）
  await act(async () => { view.clock.advance(1000); });
  await waitFor(() => expect(syncCalls).toBeGreaterThanOrEqual(2));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const getBodies = () => Array.from(timeline.querySelectorAll("[data-side] .waypoint-bubble")).map((el) => el.textContent);
  await waitFor(() => expect(getBodies()).toEqual(["第一条失败", "第二条失败", "中间插入的Bot消息"]));

  // 点第一条的红叹号重发，让同步回声先到，PUT 200 后到
  await user.click(screen.getAllByRole("button", { name: "失败" })[0]!);
  await waitFor(() => expect(resentTxnId).not.toBe(""));
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "失败" })).toHaveLength(1);

  await act(async () => { view.clock.advance(1000); });
  await waitFor(() => expect(syncCalls).toBeGreaterThanOrEqual(3));
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  expect(getBodies()).toEqual(["第一条失败", "第二条失败", "中间插入的Bot消息"]);

  // PUT 200 迟到后仍不产生重复气泡
  await act(async () => {
    pendingResendResponse.resolve({
      type: "response",
      status: 200,
      body: { event_id: "$resent-echo" },
    });
  });
  expect(getBodies()).toEqual(["第一条失败", "第二条失败", "中间插入的Bot消息"]);

  // 丢掉剩下的第二条失败，列表标记彻底消失
  await user.click(screen.getByRole("button", { name: "更多操作" }));
  await user.click(within(screen.getByRole("menu", { name: "消息操作" })).getByRole("menuitem", { name: "丢掉" }));
  await waitFor(() => {
    expect(getBodies()).toEqual(["第一条失败", "中间插入的Bot消息"]);
  });
  const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });
  expect(within(sidebar).queryByRole("img")).not.toBeInTheDocument();

  view.unmount();
});

test("集成回归：本地未确认/失败占位不误判未读、不阻断 limited 断层与已读位置推进，且删除含失败消息的 Topic 会彻底清理", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  let sendCount = 0;
  const readMarkersPosted: Array<{ roomId: string; eventId: string }> = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                      { type: "m.room.name", state_key: "", content: { name: "跨功能集成话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$c1" } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$c1",
                        sender: "@bot:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "已读基线消息" },
                      },
                    ],
                  },
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
                  limited: true,
                  prev_batch: "prev-gap",
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$after-gap",
                      sender: "@bot:example.com",
                      origin_server_ts: 3000,
                      content: { msgtype: "m.text", body: "断层后的新消息" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendCount += 1;
      return {
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      const body = input.body as { "m.fully_read": string };
      readMarkersPosted.push({ roomId: "!t1:example.com", eventId: body["m.fully_read"] });
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.includes("/leave")) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.includes("/forget")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const view = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const row = within(sidebar).getByRole("button", { name: "跨功能集成话题" });
  expect(row).not.toHaveAttribute("data-unread", "true");

  // 打开话题并发送一条会永久失败的消息 -> 不产生未读，不发 read_markers
  await user.click(row);
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "失败占位消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "失败" });
  expect(sendCount).toBe(1);
  expect(readMarkersPosted).toEqual([]);
  expect(row).not.toHaveAttribute("data-unread", "true");

  // 触发一次 limited: true 增量 sync，在本地失败占位之后插入断层新消息；
  // 断层 anchor 应锚定到 $after-gap（不是本地占位），且失败占位未推进 readPositionEventId
  await act(async () => { view.clock.advance(5000); });
  await screen.findByText("断层后的新消息");
  expect(row).toHaveAttribute("data-unread", "true");
  expect(within(row).getByRole("img", { name: "失败" })).toBeInTheDocument();

  // 删除含失败消息的 Topic，验证 leave + forget 后本地房间和失败占位彻底消失
  await user.click(screen.getByRole("button", { name: "删除" }));
  const deleteDialog = screen.getByRole("alertdialog", { name: "确认删除 Topic" });
  await user.click(within(deleteDialog).getByRole("button", { name: "确认删除" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "跨功能集成话题" })).not.toBeInTheDocument();
  });
  view.unmount();
});

test("列表行右侧按本地日历和区域设置显示最近活动时刻（今天时刻/昨天/今年内月日/跨年年月日/空话题取诞生时间），忽略编辑与撤回且不放头像和预览", async () => {
  const todayTs = new Date(2026, 10, 12, 9, 5, 0).getTime();
  const yesterdayTs = new Date(2026, 10, 11, 21, 30, 0).getTime();
  const earlierThisYearTs = new Date(2026, 4, 3, 14, 20, 0).getTime();
  const redactedLaterTs = new Date(2026, 10, 12, 10, 0, 0).getTime();
  const lastYearCreateTs = new Date(2025, 11, 20, 18, 0, 0).getTime();
  const nowMs = new Date(2026, 10, 12, 15, 0, 0).getTime();

  const expectedToday = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(todayTs));
  const expectedEarlierThisYear = new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
  }).format(new Date(earlierThisYearTs));
  const expectedLastYear = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(lastYearCreateTs));

  function makeHs() {
    const hs = new FakeHomeserver();
    hs.handler = passwordLoginHandler(async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: validAgents,
            rooms: {
              join: {
                "!t-today:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: lastYearCreateTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "今天话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m-today",
                        sender: "@bot:example.com",
                        origin_server_ts: todayTs,
                        content: { msgtype: "m.text", body: "今天的消息正文不应预览" },
                      },
                    ],
                  },
                },
                "!t-yesterday:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: lastYearCreateTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "昨天话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m-yday",
                        sender: "@alice:example.com",
                        origin_server_ts: yesterdayTs,
                        content: { msgtype: "m.text", body: "昨天的消息正文" },
                      },
                    ],
                  },
                },
                "!t-this-year:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: lastYearCreateTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "今年更早话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m-may",
                        sender: "@bot:example.com",
                        origin_server_ts: earlierThisYearTs,
                        content: { msgtype: "m.text", body: "五月的原消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m-may-edit",
                        sender: "@bot:example.com",
                        origin_server_ts: todayTs,
                        content: {
                          msgtype: "m.text",
                          body: "* 五月的编辑后消息",
                          "m.new_content": { msgtype: "m.text", body: "五月的编辑后消息" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$m-may" },
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m-redacted",
                        sender: "@bot:example.com",
                        origin_server_ts: redactedLaterTs,
                        content: {},
                        unsigned: { redacted_because: { event_id: "$red" } },
                      },
                    ],
                  },
                },
                "!t-empty-last-year:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: lastYearCreateTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "去年空话题" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      throw new Error(input.url);
    });
    return hs;
  }

  const user = userEvent.setup();
  const clock = new ManualClock();
  clock.now = nowMs;
  const view = render(
    <WaypointApp
      homeserver={makeHs()}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const rowToday = within(sidebar).getByRole("button", { name: "今天话题" });
  const rowYesterday = within(sidebar).getByRole("button", { name: "昨天话题" });
  const rowThisYear = within(sidebar).getByRole("button", { name: "今年更早话题" });
  const rowLastYear = within(sidebar).getByRole("button", { name: "去年空话题" });

  expect(rowToday.querySelector(".waypoint-topic-row-time")).toHaveTextContent(expectedToday);
  expect(rowYesterday.querySelector(".waypoint-topic-row-time")).toHaveTextContent("昨天");
  expect(rowThisYear.querySelector(".waypoint-topic-row-time")).toHaveTextContent(expectedEarlierThisYear);
  expect(rowLastYear.querySelector(".waypoint-topic-row-time")).toHaveTextContent(expectedLastYear);

  // 无头像、无消息正文预览、单 Bot 不显示 Bot 名、无搜索/筛选/分组
  expect(within(sidebar).queryByRole("img")).not.toBeInTheDocument();
  expect(within(sidebar).queryByRole("searchbox")).not.toBeInTheDocument();
  expect(sidebar).not.toHaveTextContent("今天的消息正文不应预览");
  expect(sidebar).not.toHaveTextContent("五月的编辑后消息");
  expect(sidebar).not.toHaveTextContent("bot");

  // 排序按最近活动时间倒序
  const titles = Array.from(sidebar.querySelectorAll(".waypoint-topic-row-title")).map(
    (el) => el.textContent,
  );
  expect(titles).toEqual(["今天话题", "昨天话题", "今年更早话题", "去年空话题"]);

  view.unmount();

  // 跨年零点时区边界：UTC 2025-12-31 20:00 在 Asia/Shanghai 是 2026-01-01 04:00（今年/今天），在 America/New_York 是 2025-12-31 15:00（昨天）
  try {
    const boundaryMsgUtc = Date.UTC(2025, 11, 31, 20, 0, 0);
    const boundaryNowUtc = Date.UTC(2026, 0, 1, 6, 0, 0);
    function makeBoundaryHs() {
      const hs = new FakeHomeserver();
      hs.handler = passwordLoginHandler(async (input) => {
        if (input.url.includes("/sync")) {
          return {
            type: "response",
            status: 200,
            body: {
              next_batch: "batch-1",
              account_data: validAgents,
              rooms: {
                join: {
                  "!t-tz:example.com": {
                    state: {
                      events: [
                        { type: "m.room.create", state_key: "", origin_server_ts: boundaryMsgUtc, content: {} },
                        { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                        { type: "m.room.name", state_key: "", content: { name: "跨日跨年时区话题" } },
                      ],
                    },
                    timeline: {
                      events: [
                        {
                          type: "m.room.message",
                          event_id: "$m-tz",
                          sender: "@bot:example.com",
                          origin_server_ts: boundaryMsgUtc,
                          content: { msgtype: "m.text", body: "跨年边界" },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        }
        throw new Error(input.url);
      });
      return hs;
    }

    globalThis.indexedDB = new IDBFactory();
    vi.stubEnv("TZ", "Asia/Shanghai");
    const clockSh = new ManualClock();
    clockSh.now = boundaryNowUtc;
    const viewSh = render(
      <WaypointApp
        homeserver={makeBoundaryHs()}
        platform={{ deviceDisplayName: "Waypoint macOS" }}
        clock={clockSh}
      />,
    );
    await login(userEvent.setup());
    const shRow = await screen.findByRole("button", { name: "跨日跨年时区话题" });
    const expectedShTime = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(boundaryMsgUtc));
    expect(shRow.querySelector(".waypoint-topic-row-time")).toHaveTextContent(expectedShTime);
    viewSh.unmount();

    globalThis.indexedDB = new IDBFactory();
    vi.stubEnv("TZ", "America/New_York");
    const clockNy = new ManualClock();
    clockNy.now = boundaryNowUtc;
    const viewNy = render(
      <WaypointApp
        homeserver={makeBoundaryHs()}
        platform={{ deviceDisplayName: "Waypoint Android" }}
        clock={clockNy}
      />,
    );
    await login(userEvent.setup());
    const nyRow = await screen.findByRole("button", { name: "跨日跨年时区话题" });
    expect(nyRow.querySelector(".waypoint-topic-row-time")).toHaveTextContent("昨天");
    viewNy.unmount();
  } finally {
    vi.unstubAllEnvs();
  }
});

test("置顶写在 Owner 的 im.waypoint.pinned 标签（不用 order 和 favourite），置顶区与未置顶区各自按最近活动倒序，支持不限数量、取消置顶回原位、跨端同步与重启恢复", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: {
                    agents: [
                      { user_id: "@bot1:example.com", name: "一号" },
                      { user_id: "@bot2:example.com", name: "二号" },
                    ],
                  },
                },
              ],
            },
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题一(置顶旧)" } },
                    ],
                  },
                  account_data: {
                    events: [
                      { type: "m.tag", content: { tags: { "im.waypoint.pinned": { order: 0 } } } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 3000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot2:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题二(收藏未置顶最新)" } },
                    ],
                  },
                  account_data: {
                    events: [
                      { type: "m.tag", content: { tags: { "m.favourite": { order: 0 } } } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t3:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题三(置顶新)" } },
                    ],
                  },
                  account_data: {
                    events: [
                      { type: "m.tag", content: { tags: { "im.waypoint.pinned": { order: 0.9 } } } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (syncCalls === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!t1:example.com": {
                  account_data: {
                    events: [{ type: "m.tag", content: { tags: {} } }],
                  },
                },
                "!t3:example.com": {
                  account_data: {
                    events: [
                      { type: "m.tag", content: { tags: { "im.waypoint.pinned": { order: 0 } } } },
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
    if (
      (input.method === "PUT" || input.method === "DELETE") &&
      input.url.includes("/tags/im.waypoint.pinned")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const getTitles = () =>
    Array.from(sidebar.querySelectorAll(".waypoint-topic-row-title")).map((el) => el.textContent);

  expect(getTitles()).toEqual(["话题三(置顶新)", "话题一(置顶旧)", "话题二(收藏未置顶最新)"]);
  expect(within(sidebar).getByRole("button", { name: "话题三(置顶新)" })).toHaveAttribute("data-pinned", "true");
  expect(within(sidebar).getByRole("button", { name: "话题一(置顶旧)" })).toHaveAttribute("data-pinned", "true");
  expect(within(sidebar).getByRole("button", { name: "话题二(收藏未置顶最新)" })).not.toHaveAttribute("data-pinned");

  // 新建 Topic 仍预选最近活动的话题二所绑定的二号 Bot
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.getByRole("combobox", { name: "绑定 Bot" })).toHaveTextContent("二号");
  await user.click(screen.getByRole("button", { name: "取消" }));

  // 置顶话题二 -> 发送 PUT tags/im.waypoint.pinned { order: 0 }，三条全部可置顶
  await user.click(within(sidebar).getByRole("button", { name: "话题二(收藏未置顶最新)" }));
  await user.click(screen.getByRole("button", { name: "置顶" }));

  await waitFor(() => {
    expect(getTitles()).toEqual(["话题二(收藏未置顶最新)", "话题三(置顶新)", "话题一(置顶旧)"]);
  });
  expect(screen.getByRole("button", { name: "取消置顶" })).toBeInTheDocument();

  const putTagReq = homeserver.requests.find(
    (r) => r.method === "PUT" && r.url.includes("/tags/im.waypoint.pinned"),
  );
  expect(putTagReq).toMatchObject({
    method: "PUT",
    url: "https://matrix.example.com/_matrix/client/v3/user/%40alice%3Aexample.com/rooms/!t2%3Aexample.com/tags/im.waypoint.pinned",
    headers: { Authorization: "Bearer tok-1" },
    body: { order: 0 },
  });

  // 取消置顶话题三 -> 发送 DELETE tags/im.waypoint.pinned，回到最近活动位置（未置顶区）
  await user.click(within(sidebar).getByRole("button", { name: "话题三(置顶新)" }));
  await user.click(screen.getByRole("button", { name: "取消置顶" }));

  await waitFor(() => {
    expect(getTitles()).toEqual(["话题二(收藏未置顶最新)", "话题一(置顶旧)", "话题三(置顶新)"]);
  });
  expect(screen.getByRole("button", { name: "置顶" })).toBeInTheDocument();

  const deleteTagReq = homeserver.requests.find(
    (r) => r.method === "DELETE" && r.url.includes("/tags/im.waypoint.pinned"),
  );
  expect(deleteTagReq).toMatchObject({
    method: "DELETE",
    url: "https://matrix.example.com/_matrix/client/v3/user/%40alice%3Aexample.com/rooms/!t3%3Aexample.com/tags/im.waypoint.pinned",
    headers: { Authorization: "Bearer tok-1" },
  });

  // 另一台设备通过 /sync 取消置顶话题一并置顶话题三
  await advanceWhenTimerScheduled(first.clock, 1000);
  await waitFor(() => {
    expect(getTitles()).toEqual(["话题二(收藏未置顶最新)", "话题三(置顶新)", "话题一(置顶旧)"]);
  });

  // 重启后离线恢复，置顶状态与排序保留
  first.unmount();
  const second = renderApp(homeserver);
  const sidebar2 = await screen.findByRole("complementary", { name: "Topic 列表" });
  const getTitles2 = () =>
    Array.from(sidebar2.querySelectorAll(".waypoint-topic-row-title")).map((el) => el.textContent);
  expect(getTitles2()).toEqual(["话题二(收藏未置顶最新)", "话题三(置顶新)", "话题一(置顶旧)"]);
  second.unmount();
});

test("置顶与取消置顶不做乐观更新、操作期间防抖防连点；失败时保持原状态与排序并给轻量提示，不进重试队列", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingPut = deferred<TransportResult>();
  const pendingDelete = deferred<TransportResult>();
  let putCalls = 0;
  let deleteCalls = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: validAgents,
          rooms: {
            join: {
              "!t-pinned:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "已置顶老话题" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.tag", content: { tags: { "im.waypoint.pinned": { order: 0 } } } }],
                },
                timeline: { events: [] },
              },
              "!t-normal:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "普通新话题" } },
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
      putCalls += 1;
      if (putCalls === 1) {
        return pendingPut.promise;
      }
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "DELETE" && input.url.includes("/tags/im.waypoint.pinned")) {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        return pendingDelete.promise;
      }
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const view = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const getTitles = () =>
    Array.from(sidebar.querySelectorAll(".waypoint-topic-row-title")).map((el) => el.textContent);
  expect(getTitles()).toEqual(["已置顶老话题", "普通新话题"]);

  // 打开普通新话题，点击置顶 -> 请求在途期间：不做乐观更新、按钮禁用防连点
  await user.click(within(sidebar).getByRole("button", { name: "普通新话题" }));
  const pinBtn = screen.getByRole("button", { name: "置顶" });
  await user.click(pinBtn);
  expect(putCalls).toBe(1);
  expect(pinBtn).toBeDisabled();
  expect(screen.getByRole("button", { name: "置顶" })).toBeInTheDocument();
  expect(getTitles()).toEqual(["已置顶老话题", "普通新话题"]);
  expect(within(sidebar).getByRole("button", { name: "普通新话题" })).not.toHaveAttribute("data-pinned");

  // 再次点击被忽略，不会发送第二个 PUT
  fireEvent.click(pinBtn);
  expect(putCalls).toBe(1);

  // 第一次置顶失败（网络错误） -> 保持原状态和排序，给轻量提示，不进重试队列
  await act(async () => {
    pendingPut.resolve({ type: "failure", failure: { type: "network" } });
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "置顶" })).not.toBeDisabled();
  });
  expect(getTitles()).toEqual(["已置顶老话题", "普通新话题"]);
  expect(within(sidebar).getByRole("button", { name: "普通新话题" })).not.toHaveAttribute("data-pinned");
  expect(screen.getByRole("status")).toHaveTextContent(/置顶失败/);

  // 推进时钟不会自动重试置顶，且 4 秒后轻量提示自动收起
  await act(async () => {
    view.clock.advance(10_000);
  });
  expect(putCalls).toBe(1);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();

  // 手动重试置顶成功
  await user.click(screen.getByRole("button", { name: "置顶" }));
  await waitFor(() => {
    expect(getTitles()).toEqual(["普通新话题", "已置顶老话题"]);
  });
  expect(putCalls).toBe(2);

  // 对已置顶老话题尝试取消置顶并遇到 500 失败 -> 防抖、不做乐观更新、保持置顶状态与顺序、给轻量提示且不自动重试
  await user.click(within(sidebar).getByRole("button", { name: "已置顶老话题" }));
  const unpinBtn = screen.getByRole("button", { name: "取消置顶" });
  await user.click(unpinBtn);
  expect(deleteCalls).toBe(1);
  expect(unpinBtn).toBeDisabled();
  fireEvent.click(unpinBtn);
  expect(deleteCalls).toBe(1);
  expect(getTitles()).toEqual(["普通新话题", "已置顶老话题"]);

  await act(async () => {
    pendingDelete.resolve({
      type: "response",
      status: 500,
      body: { errcode: "M_UNKNOWN", error: "Server busy" },
    });
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "取消置顶" })).not.toBeDisabled();
  });
  expect(getTitles()).toEqual(["普通新话题", "已置顶老话题"]);
  expect(within(sidebar).getByRole("button", { name: "已置顶老话题" })).toHaveAttribute("data-pinned", "true");
  expect(screen.getByRole("status")).toHaveTextContent(/取消置顶失败/);

  await act(async () => {
    view.clock.advance(10_000);
  });
  expect(deleteCalls).toBe(1);
  view.unmount();
});

test("未确认和失败消息不提前修改列表行时刻也不重排，确认回声到达后按服务器时间更新时刻并在各自置顶/未置顶区重排", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingSend = deferred<TransportResult>();
  let sendCount = 0;
  let capturedTxnId = "";
  let syncCount = 0;

  const yesterdayTs = new Date(2026, 10, 11, 10, 0, 0).getTime();
  const todayEarlierTs = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const todayEchoTs = new Date(2026, 10, 12, 11, 30, 0).getTime();
  const nowMs = new Date(2026, 10, 12, 12, 0, 0).getTime();

  const expectedEarlierTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(todayEarlierTs));
  const expectedEchoTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(todayEchoTs));

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCount += 1;
      if (syncCount === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: validAgents,
            rooms: {
              join: {
                "!pin-old:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: yesterdayTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "置顶旧" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.tag", content: { tags: { "im.waypoint.pinned": { order: 0 } } } }],
                  },
                  timeline: { events: [] },
                },
                "!pin-new:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: todayEarlierTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "置顶新" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.tag", content: { tags: { "im.waypoint.pinned": { order: 0 } } } }],
                  },
                  timeline: { events: [] },
                },
                "!unpinned:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: todayEarlierTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "普通话题" } },
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
          next_batch: `batch-${syncCount}`,
          rooms: {
            join: {
              "!pin-old:example.com": {
                timeline: {
                  events: capturedTxnId
                    ? [
                        {
                          type: "m.room.message",
                          event_id: "$echo-pin-old",
                          sender: "@alice:example.com",
                          origin_server_ts: todayEchoTs,
                          content: { msgtype: "m.text", body: "重发确认" },
                          unsigned: { transaction_id: capturedTxnId },
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
      sendCount += 1;
      capturedTxnId = decodeURIComponent(input.url.split("/").pop() ?? "");
      if (sendCount === 1) {
        return {
          type: "response",
          status: 403,
          body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
        };
      }
      return pendingSend.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const clock = new ManualClock();
  clock.now = nowMs;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const getTitles = () =>
    Array.from(sidebar.querySelectorAll(".waypoint-topic-row-title")).map((el) => el.textContent);
  const pinOldRow = () => within(sidebar).getByRole("button", { name: "置顶旧" });
  const pinNewRow = () => within(sidebar).getByRole("button", { name: "置顶新" });

  expect(getTitles()).toEqual(["置顶新", "置顶旧", "普通话题"]);
  expect(pinOldRow().querySelector(".waypoint-topic-row-time")).toHaveTextContent("昨天");
  expect(pinNewRow().querySelector(".waypoint-topic-row-time")).toHaveTextContent(expectedEarlierTime);

  // 打开「置顶旧」发送一条会 403 失败的消息 -> 列表行时刻仍是「昨天」，排序不变，无正文预览
  await user.click(pinOldRow());
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "不会改时刻的失败消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "失败" });

  expect(pinOldRow().querySelector(".waypoint-topic-row-time")).toHaveTextContent("昨天");
  expect(pinOldRow()).not.toHaveTextContent("不会改时刻的失败消息");
  expect(getTitles()).toEqual(["置顶新", "置顶旧", "普通话题"]);

  // 点红叹号重发（未确认状态），PUT 200 先到但尚无同步回声 -> 时刻仍是「昨天」，排序不变
  await user.click(screen.getByRole("button", { name: "失败" }));
  await screen.findByRole("status", { name: "未确认" });
  expect(pinOldRow().querySelector(".waypoint-topic-row-time")).toHaveTextContent("昨天");
  expect(getTitles()).toEqual(["置顶新", "置顶旧", "普通话题"]);

  await act(async () => {
    pendingSend.resolve({ type: "response", status: 200, body: { event_id: "$echo-pin-old" } });
  });
  expect(pinOldRow().querySelector(".waypoint-topic-row-time")).toHaveTextContent("昨天");
  expect(getTitles()).toEqual(["置顶新", "置顶旧", "普通话题"]);

  // 同步回声到达并带来 origin_server_ts -> 时刻更新为服务器时刻，在置顶区内重排到「置顶新」之前
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(pinOldRow().querySelector(".waypoint-topic-row-time")).toHaveTextContent(expectedEchoTime);
  });
  expect(getTitles()).toEqual(["置顶旧", "置顶新", "普通话题"]);
});

test("已连接后服务器不认 token 时顶栏显示静默提示（不弹窗不踢回全屏登录），仍可只读浏览时间线和草稿，禁用新建与输入发送", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendCalls = 0;
  let rejectToken = false;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
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
                      { type: "m.room.name", state_key: "", content: { name: "草稿话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-t1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "话题一的本地消息" },
                      },
                    ],
                  },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1500, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "队列话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-t2",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        content: { msgtype: "m.text", body: "话题二的本地消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (rejectToken) {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncCalls}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendCalls += 1;
      return {
        type: "response",
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock, container } = renderApp(homeserver);
  await login(user);

  // 在话题一保留草稿与附件
  await user.click(await screen.findByRole("button", { name: "草稿话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "未发出的草稿");
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File(["hello"], "draft.txt", { type: "text/plain" }),
  );
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("draft.txt");

  // 切到话题二并发送消息，触发服务器返回 M_UNKNOWN_TOKEN
  await user.click(screen.getByRole("button", { name: "队列话题" }));
  rejectToken = true;
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "未确认消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sendCalls).toBe(1));

  // 1) 不弹窗、不切回全屏登录，仍算已连接
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.queryByText("尚未进入 Topic 列表")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();

  // 2) 顶栏显示静默提示，贴在钉住的标题栏下方，包含「重新验证」与「退出这台设备」
  const banner = await screen.findByRole("status", { name: "重新验证提示" });
  const stickyHeader = container.querySelector(".waypoint-topic-header");
  expect(stickyHeader).not.toBeNull();
  expect(stickyHeader?.nextElementSibling).toBe(banner);
  expect(within(banner).getByRole("button", { name: "重新验证" })).toBeInTheDocument();
  expect(within(banner).getByRole("button", { name: "退出这台设备" })).toBeInTheDocument();

  // 3) 禁用新建 Topic、输入与发送；未确认消息仍在时间线中
  expect(screen.getByRole("button", { name: "新建 Topic" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toBeDisabled();
  expect(screen.getByLabelText("选择附件")).toBeDisabled();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("未确认消息");
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

  // 4) 仍可只读切换并浏览本地时间线和已有草稿
  await user.click(screen.getByRole("button", { name: "草稿话题" }));
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("话题一的本地消息");
  const draftBox = screen.getByRole("textbox", { name: "输入消息" });
  expect(draftBox).toHaveValue("未发出的草稿");
  expect(draftBox).toBeDisabled();
  expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("draft.txt");
  expect(screen.getByRole("button", { name: "移除附件" })).toBeDisabled();

  // 5) 同步与重试队列暂停，不再发网络请求
  const requestsAtPause = homeserver.requests.length;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    clock.advance(60_000);
  });
  expect(homeserver.requests.length).toBe(requestsAtPause);
});

test("在顶栏提示点击退出这台设备，复用相同的确认弹窗与清空流程，取消保留状态，确认后清空并回到空密码步", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let logoutCalls = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
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
                      { type: "m.room.name", state_key: "", content: { name: "保留或退出话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "本地已有消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return {
        type: "response",
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", error: "Unknown token" },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return {
        type: "response",
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", error: "Unknown token" },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      logoutCalls += 1;
      return { type: "response", status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  // 打开话题写一段草稿，再通过「新建 Topic」触发 M_UNKNOWN_TOKEN
  await user.click(await screen.findByRole("button", { name: "保留或退出话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "草稿保留文字");
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "触发失效的新Topic");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const banner = await screen.findByRole("status", { name: "重新验证提示" });
  expect(screen.getByRole("button", { name: "创建 Topic" })).toBeDisabled();

  // 点击顶栏提示上的「退出这台设备」，弹出同一个确认弹窗
  await user.click(within(banner).getByRole("button", { name: "退出这台设备" }));
  const confirmDialog = screen.getByRole("alertdialog", { name: "确认退出这台设备" });
  expect(confirmDialog).toHaveTextContent("本地时间线");
  expect(confirmDialog).toHaveTextContent("未发送草稿");
  expect(confirmDialog).toHaveTextContent("重试队列");
  expect(logoutCalls).toBe(0);

  // 取消退出：仍算已连接，提示条还在
  await user.click(within(confirmDialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog", { name: "确认退出这台设备" })).not.toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "重新验证提示" })).toBeInTheDocument();

  // 再次点击并确认退出：走完整退出清理流程
  await user.click(within(banner).getByRole("button", { name: "退出这台设备" }));
  await user.click(screen.getByRole("button", { name: "确认退出" }));

  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  expect(logoutCalls).toBe(1);
  first.unmount();

  // 重启后仍留在密码步，不带旧游标，本地时间线与草稿已清空
  let secondSyncCalls = 0;
  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      secondSyncCalls += 1;
      expect(input.url).not.toContain("since=");
      return { type: "response", status: 200, body: { next_batch: "batch-fresh", account_data: validAgents } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });
  renderApp(homeserver);
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(secondSyncCalls).toBe(1);
});

test("点击重新验证仅输入密码并携带原 device id，成功后保留本地时间线与草稿，按序恢复重试队列，并沿用旧同步游标（游标被拒时降级合并不清库）", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let tokenRevoked = false;
  let loginReauthCalls = 0;
  const sentBodies: Array<{ body: string; auth: string }> = [];

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
      const reqBody = input.body as Record<string, unknown>;
      if (tokenRevoked || reqBody.device_id) {
        loginReauthCalls += 1;
        return {
          type: "response",
          status: 200,
          body: { user_id: "@alice:example.com", access_token: "tok-2", device_id: "DEV1" },
        };
      }
      return {
        type: "response",
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
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
                      { type: "m.room.name", state_key: "", content: { name: "草稿留存话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-old-draft",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "草稿话题的本地消息" },
                      },
                    ],
                  },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1500, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "恢复重放话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-hist",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        content: { msgtype: "m.text", body: "已有本地消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (input.headers?.Authorization === "Bearer tok-1") {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Token revoked" },
        };
      }
      if (input.url.includes("since=batch-1")) {
        return {
          type: "response",
          status: 400,
          body: { errcode: "M_UNKNOWN", error: "Invalid since token" },
        };
      }
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-merged",
          account_data: validAgents,
          rooms: {
            join: {
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1500, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "恢复重放话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$ev-new-after-reauth",
                      sender: "@bot:example.com",
                      origin_server_ts: 3000,
                      content: { msgtype: "m.text", body: "同步补回的新消息" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      if (input.headers?.Authorization === "Bearer tok-1") {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Token revoked" },
        };
      }
      const msg = (input.body as { body: string }).body;
      sentBodies.push({ body: msg, auth: input.headers?.Authorization ?? "" });
      return { type: "response", status: 200, body: { event_id: `$ev-sent-${sentBodies.length}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  };

  renderApp(homeserver);
  await login(user);

  // 在话题一保留草稿
  await user.click(await screen.findByRole("button", { name: "草稿留存话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "未发出的草稿");

  // 切到话题二，先让发送入队两项：先触发 401 暂停，第一条和第二条都在队列里
  await user.click(screen.getByRole("button", { name: "恢复重放话题" }));
  const firstSend = deferred<TransportResult>();
  const origHandler = homeserver.handler;
  let holdFirstSend = true;
  homeserver.handler = async (input) => {
    if (holdFirstSend && input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      holdFirstSend = false;
      return firstSend.promise;
    }
    return origHandler(input);
  };

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "队列第一条");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "队列第二条");
  await user.click(screen.getByRole("button", { name: "发送" }));

  tokenRevoked = true;
  await act(async () => {
    firstSend.resolve({
      type: "response",
      status: 401,
      body: { errcode: "M_UNKNOWN_TOKEN", error: "Token revoked" },
    });
  });

  const banner = await screen.findByRole("status", { name: "重新验证提示" });
  await user.click(within(banner).getByRole("button", { name: "重新验证" }));

  const reauthForm = screen.getByRole("form", { name: "重新验证" });
  const addressInput = within(reauthForm).getByLabelText("Homeserver 地址");
  const userIdInput = within(reauthForm).getByLabelText("用户 ID");
  expect(addressInput).toHaveValue("https://matrix.example.com");
  expect(addressInput).toBeDisabled();
  expect(userIdInput).toHaveValue("@alice:example.com");
  expect(userIdInput).toBeDisabled();
  expect(within(reauthForm).queryByRole("button", { name: "更改地址" })).not.toBeInTheDocument();

  const passwordInput = within(reauthForm).getByLabelText("密码");
  expect(passwordInput).toHaveValue("");
  await user.type(passwordInput, "secret");
  await user.click(within(reauthForm).getByRole("button", { name: "确认验证" }));

  // 提示消失，禁用解除
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "重新验证提示" })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: "新建 Topic" })).not.toBeDisabled();
  expect(screen.getByRole("textbox", { name: "输入消息" })).not.toBeDisabled();

  // 检查 /login 请求体携带原 device_id，不申请 refresh_token
  expect(loginReauthCalls).toBe(1);
  const reauthLoginReq = homeserver.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/_matrix/client/v3/login"),
  ).at(-1);
  expect(reauthLoginReq?.body).toMatchObject({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: "@alice:example.com" },
    password: "secret",
    device_id: "DEV1",
  });
  expect(reauthLoginReq?.body).not.toHaveProperty("refresh_token");

  // 重试队列按交出顺序用新 token 恢复重放
  await waitFor(() => expect(sentBodies).toHaveLength(2));
  expect(sentBodies).toEqual([
    { body: "队列第一条", auth: "Bearer tok-2" },
    { body: "队列第二条", auth: "Bearer tok-2" },
  ]);

  // 同步先用原游标 since=batch-1，被 400 拒绝后降级无游标合并且不清库
  await waitFor(() => {
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("同步补回的新消息");
  });
  const postReauthSyncs = homeserver.requests.filter(
    (r) => r.url.includes("/sync") && r.headers.Authorization === "Bearer tok-2",
  );
  expect(postReauthSyncs[0]?.url).toContain("since=batch-1");
  expect(postReauthSyncs[1]?.url).not.toContain("since=");

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("已有本地消息");
  expect(timeline).toHaveTextContent("队列第一条");
  expect(timeline).toHaveTextContent("队列第二条");
  expect(timeline).toHaveTextContent("同步补回的新消息");

  // 话题一的草稿与本地时间线原样保留
  await user.click(screen.getByRole("button", { name: "草稿留存话题" }));
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("草稿话题的本地消息");
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("未发出的草稿");
});

test("重新验证只有在服务器明确拒绝原 device id 时才接受新分配并更新本地保存，未明确拒绝时不换掉原 device id", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let activeToken = "tok-1";
  let rejectDeviceId = false;

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
      const body = input.body as Record<string, unknown>;
      if (!body.device_id && !rejectDeviceId) {
        return {
          type: "response",
          status: 200,
          body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
        };
      }
      if (body.device_id === "DEV1" && !rejectDeviceId) {
        // 服务器没有明确拒绝 DEV1，却在 200 里带了另一个 device_id：不能替换本地 DEV1
        activeToken = "tok-2";
        return {
          type: "response",
          status: 200,
          body: { user_id: "@alice:example.com", access_token: "tok-2", device_id: "DEV-IGNORED" },
        };
      }
      if (body.device_id === "DEV1" && rejectDeviceId) {
        // 明确拒绝原 device_id
        return {
          type: "response",
          status: 400,
          body: { errcode: "M_INVALID_PARAM", error: "Unknown device_id DEV1" },
        };
      }
      if (!body.device_id && rejectDeviceId) {
        activeToken = "tok-3";
        return {
          type: "response",
          status: 200,
          body: { user_id: "@alice:example.com", access_token: "tok-3", device_id: "DEV2" },
        };
      }
      activeToken = "tok-4";
      return {
        type: "response",
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-4", device_id: String(body.device_id) },
      };
    }
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (input.headers?.Authorization !== `Bearer ${activeToken}`) {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Unknown token" },
        };
      }
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncCalls}`,
          account_data: validAgents,
        },
      };
    }
    throw new Error(`${input.method} ${input.url}`);
  };

  const first = renderApp(homeserver);
  await login(user);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();

  // 1) 让当前 token 失效并重新验证（服务器未明确拒绝 DEV1，只返回 DEV-IGNORED）
  activeToken = "expired";
  await act(async () => {
    // trigger next sync tick via online
    window.dispatchEvent(new Event("online"));
  });
  const banner1 = await screen.findByRole("status", { name: "重新验证提示" });
  await user.click(within(banner1).getByRole("button", { name: "重新验证" }));
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "确认验证" }));
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "重新验证提示" })).not.toBeInTheDocument();
  });

  // 2) 再次失效并重启后重新验证，验证本地保存的仍是 DEV1（没有被 DEV-IGNORED 覆盖），这次服务器明确拒绝 DEV1
  rejectDeviceId = true;
  activeToken = "expired-2";
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  const banner2 = await screen.findByRole("status", { name: "重新验证提示" });
  await user.click(within(banner2).getByRole("button", { name: "重新验证" }));
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "确认验证" }));
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "重新验证提示" })).not.toBeInTheDocument();
  });

  const loginPosts = homeserver.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/_matrix/client/v3/login"),
  );
  expect(loginPosts).toHaveLength(4);
  expect(loginPosts[1].body).toMatchObject({ device_id: "DEV1" });
  expect(loginPosts[2].body).toMatchObject({ device_id: "DEV1" });
  expect(loginPosts[3].body).not.toHaveProperty("device_id");
  first.unmount();

  // 3) 重启后 token 再失效，重验证请求应携带更新后的新 device_id: DEV2
  activeToken = "expired-3";
  renderApp(homeserver);
  const banner3 = await screen.findByRole("status", { name: "重新验证提示" });
  await user.click(within(banner3).getByRole("button", { name: "重新验证" }));
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "确认验证" }));
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "重新验证提示" })).not.toBeInTheDocument();
  });

  const finalLoginPost = homeserver.requests
    .filter((r) => r.method === "POST" && r.url.endsWith("/_matrix/client/v3/login"))
    .at(-1);
  expect(finalLoginPost?.body).toMatchObject({ device_id: "DEV2" });
});

test("重新验证密码错误只清密码并提示重试，网络/5xx异常保留密码并提示重试，任何失败不清耐久状态，且窄视口与迟到旧token均正确处理", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let loginStep = 0;
  let activeToken = "tok-1";
  const lateOldSync = deferred<TransportResult>();
  let holdOldSync = false;

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
      const body = input.body as Record<string, unknown>;
      if (!body.device_id) {
        return {
          type: "response",
          status: 200,
          body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
        };
      }
      loginStep += 1;
      if (loginStep === 1) {
        return {
          type: "response",
          status: 403,
          body: { errcode: "M_FORBIDDEN", error: "Invalid password" },
        };
      }
      if (loginStep === 2) {
        return { type: "failure", failure: { type: "network" } };
      }
      if (loginStep === 3) {
        return {
          type: "response",
          status: 503,
          body: { errcode: "M_UNKNOWN", error: "Service unavailable" },
        };
      }
      activeToken = "tok-2";
      return {
        type: "response",
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-2", device_id: "DEV1" },
      };
    }
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
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
                      { type: "m.room.name", state_key: "", content: { name: "窄屏失败重试话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "本地历史消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (holdOldSync) {
        holdOldSync = false;
        return lateOldSync.promise;
      }
      if (input.headers?.Authorization !== `Bearer ${activeToken}`) {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Token revoked" },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncCalls}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      if (input.headers?.Authorization !== `Bearer ${activeToken}`) {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Token revoked" },
        };
      }
      return { type: "response", status: 200, body: { event_id: "$ev-queued" } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  };

  const clock = new ManualClock();
  const narrowView = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint iOS", viewportMode: () => "narrow" }}
      clock={clock}
    />,
  );
  await login(user);

  // 打开话题留一份草稿，再在窄屏返回列表，等后台同步和队列失效
  await user.click(await screen.findByRole("button", { name: "窄屏失败重试话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "草稿内容");
  await user.click(screen.getByRole("button", { name: "返回" }));

  // 触发一个挂起的旧 sync（用来验证重验证后迟到的旧 401 不能重新拉起提示）
  await user.click(screen.getByRole("button", { name: "窄屏失败重试话题" }));
  holdOldSync = true;
  await act(async () => { clock.advance(1000); });

  const heldSend = deferred<TransportResult>();
  const baseHandler = homeserver.handler;
  let holdSend = true;
  homeserver.handler = async (input) => {
    if (holdSend && input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      holdSend = false;
      return heldSend.promise;
    }
    return baseHandler(input);
  };

  await user.clear(screen.getByRole("textbox", { name: "输入消息" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "队列消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "保留草稿");
  activeToken = "expired";
  await act(async () => {
    heldSend.resolve({
      type: "response",
      status: 401,
      body: { errcode: "M_UNKNOWN_TOKEN", error: "Token revoked" },
    });
  });
  await user.click(screen.getByRole("button", { name: "返回" }));

  // 窄视口列表页上只有唯一一条顶栏静默提示
  const banners = await screen.findAllByRole("status", { name: "重新验证提示" });
  expect(banners).toHaveLength(1);
  await user.click(within(banners[0]).getByRole("button", { name: "重新验证" }));

  // 1) 密码错误（M_FORBIDDEN）：只清密码，提示重试
  const passwordInput = screen.getByLabelText("密码");
  await user.type(passwordInput, "wrong-pass");
  await user.click(screen.getByRole("button", { name: "确认验证" }));

  const alert1 = await screen.findByRole("alert");
  expect(alert1).toHaveTextContent("密码被拒绝");
  expect(alert1).toHaveTextContent("重试");
  expect(screen.getByLabelText("密码")).toHaveValue("");

  // 2) 网络异常：保留已输入的密码，提示重试
  await user.type(screen.getByLabelText("密码"), "right-pass");
  await user.click(screen.getByRole("button", { name: "确认验证" }));
  const alert2 = await screen.findByRole("alert");
  expect(alert2).toHaveTextContent("到达不了");
  expect(alert2).toHaveTextContent("重试");
  expect(screen.getByLabelText("密码")).toHaveValue("right-pass");

  // 3) 5xx 异常：保留已输入的密码，提示重试
  await user.click(screen.getByRole("button", { name: "确认验证" }));
  const alert3 = await screen.findByRole("alert");
  expect(alert3).toHaveTextContent("Service unavailable");
  expect(alert3).toHaveTextContent("请重试");
  expect(screen.getByLabelText("密码")).toHaveValue("right-pass");

  // 4) 再次提交成功：不需重输密码，直接通过；随后迟到的旧 token 401 sync 响应不能再拉起提示
  await user.click(screen.getByRole("button", { name: "确认验证" }));
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "重新验证提示" })).not.toBeInTheDocument();
  });

  await act(async () => {
    lateOldSync.resolve({
      type: "response",
      status: 401,
      body: { errcode: "M_UNKNOWN_TOKEN", error: "Stale token rejected" },
    });
  });
  expect(screen.queryByRole("status", { name: "重新验证提示" })).not.toBeInTheDocument();

  // 进入话题验证本地历史、队列已确认消息、草稿都在
  await user.click(screen.getByRole("button", { name: "窄屏失败重试话题" }));
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("本地历史消息");
  expect(timeline).toHaveTextContent("队列消息");
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("保留草稿");
  narrowView.unmount();
});

test("已读位置不在本地时打开Topic才按每页50条向后补页，找到就停并停在第一条未读且仅标可见消息为已读，启动与未打开Topic不预拉", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const messagesRequests: string[] = [];
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

  function makeMsgs(from: number, to: number, baseTs = 1000) {
    const out = [];
    for (let n = from; n <= to; n += 1) {
      out.push({
        type: "m.room.message",
        event_id: `$m${n}`,
        sender: "@bot:example.com",
        origin_server_ts: baseTs + n * 100,
        content: { msgtype: "m.text", body: `消息-${n}` },
      });
    }
    return out;
  }

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: validAgents,
          rooms: {
            join: {
              "!backfill-read:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "补页定位未读" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$m3" } }],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-1",
                  events: makeMsgs(101, 120),
                },
              },
              "!unopened-gap:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 500, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "未打开的缺口话题" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$u1" } }],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-unopened",
                  events: makeMsgs(50, 60).map((ev) => ({ ...ev, event_id: `$u${ev.event_id.slice(2)}` })),
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "GET" && input.url.includes("/messages")) {
      messagesRequests.push(input.url);
      const u = new URL(input.url);
      expect(u.searchParams.get("dir")).toBe("b");
      expect(u.searchParams.get("limit")).toBe("50");
      const from = u.searchParams.get("from");
      if (from === "pb-1") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-1",
            end: "pb-2",
            chunk: makeMsgs(51, 100).reverse(),
          },
        };
      }
      if (from === "pb-2") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-2",
            end: "pb-3",
            chunk: makeMsgs(1, 50).reverse(),
          },
        };
      }
      throw new Error(`不应请求更多分页：${input.url}`);
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 200, async () => {
    const { clock } = renderApp(homeserver);
    await login(user);

    const row = await screen.findByRole("button", { name: "补页定位未读" });
    expect(screen.getByRole("button", { name: "未打开的缺口话题" })).toBeInTheDocument();

    // 启动及后台同步几轮，不为任何 Topic 预拉历史
    await act(async () => { clock.advance(3000); });
    expect(messagesRequests).toEqual([]);

    // 打开补页定位未读：按 limit=50 翻两页找到 $m3 即停（不请求 pb-3）
    await user.click(row);
    await waitFor(() => {
      expect(messagesRequests).toEqual([
        "https://matrix.example.com/_matrix/client/v3/rooms/!backfill-read%3Aexample.com/messages?dir=b&limit=50&from=pb-1",
        "https://matrix.example.com/_matrix/client/v3/rooms/!backfill-read%3Aexample.com/messages?dir=b&limit=50&from=pb-2",
      ]);
    });

    const timeline = screen.getByRole("log", { name: "对话时间线" });
    await waitFor(() => {
      expect(timeline.querySelectorAll("[data-side]")).toHaveLength(120);
    });
    const bubbles = Array.from(timeline.querySelectorAll(".waypoint-bubble")).map((el) => el.textContent);
    expect(bubbles[0]).toBe("消息-1");
    expect(bubbles[119]).toBe("消息-120");

    // 停在第一条未读 $m4（index=3 -> scrollTop=300），视口 300..500 只看见 $m4 和 $m5
    expect(timeline.scrollTop).toBe(300);
    await waitFor(() => {
      expect(readMarkerPosts).toEqual([
        {
          url: "https://matrix.example.com/_matrix/client/v3/rooms/!backfill-read%3Aexample.com/read_markers",
          body: { "m.fully_read": "$m5", "m.read.private": "$m5" },
        },
      ]);
    });
    // 后面还有 $m6..$m120 未读，不能整段标成已读
    expect(row).toHaveAttribute("data-unread", "true");
    // 未打开的 Topic 从未拉取 /messages
    expect(messagesRequests.some((url) => url.includes("unopened-gap"))).toBe(false);
  });
});

test("无未解决缺口（已读在本地或无已读位置）打开时不向后翻页；翻到房间开头（空chunk或无end）即停且不再重复拉取也不假装读完", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const messagesRequests: string[] = [];
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: validAgents,
          rooms: {
            join: {
              "!no-gap-known:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 4000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "已读在本地" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$k2" } }],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-known",
                  events: [1, 2, 3].map((n) => ({
                    type: "m.room.message",
                    event_id: `$k${n}`,
                    sender: "@bot:example.com",
                    origin_server_ts: 4000 + n * 100,
                    content: { msgtype: "m.text", body: `本地-${n}` },
                  })),
                },
              },
              "!no-readpos:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 3000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "无已读位置" } },
                  ],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-noread",
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$n1",
                      sender: "@bot:example.com",
                      origin_server_ts: 3100,
                      content: { msgtype: "m.text", body: "无已读-1" },
                    },
                  ],
                },
              },
              "!reach-start-empty:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "翻到空chunk开头" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$c-gone" } }],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-c1",
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$c10",
                      sender: "@bot:example.com",
                      origin_server_ts: 2100,
                      content: { msgtype: "m.text", body: "空chunk-10" },
                    },
                  ],
                },
              },
              "!reach-start-noend:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "翻到无end开头" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$d-gone" } }],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-d1",
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$d10",
                      sender: "@bot:example.com",
                      origin_server_ts: 1100,
                      content: { msgtype: "m.text", body: "无end-10" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "GET" && input.url.includes("/messages")) {
      messagesRequests.push(input.url);
      const u = new URL(input.url);
      const from = u.searchParams.get("from");
      if (from === "pb-c1") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-c1",
            end: "pb-c2",
            chunk: [
              {
                type: "m.room.message",
                event_id: "$c9",
                sender: "@bot:example.com",
                origin_server_ts: 2050,
                content: { msgtype: "m.text", body: "空chunk-9" },
              },
            ],
          },
        };
      }
      if (from === "pb-c2") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-c2",
            end: "pb-c2",
            chunk: [],
          },
        };
      }
      if (from === "pb-d1") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-d1",
            chunk: [
              {
                type: "m.room.message",
                event_id: "$d9",
                sender: "@bot:example.com",
                origin_server_ts: 1050,
                content: { msgtype: "m.text", body: "无end-9" },
              },
            ],
          },
        };
      }
      throw new Error(`不应请求：${input.url}`);
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  // 1. 打开已读在本地的 Topic & 无已读位置的 Topic：都不触发 /messages
  await user.click(await screen.findByRole("button", { name: "已读在本地" }));
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("本地-3");
  await user.click(screen.getByRole("button", { name: "无已读位置" }));
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("无已读-1");
  expect(messagesRequests).toEqual([]);

  // 2. 打开翻到空chunk开头：请求 pb-c1 -> pb-c2，停住且不标 read_markers
  await user.click(screen.getByRole("button", { name: "翻到空chunk开头" }));
  await waitFor(() => {
    expect(messagesRequests).toHaveLength(2);
  });
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("空chunk-9");
  expect(readMarkerPosts.some((p) => p.url.includes("reach-start-empty"))).toBe(false);

  // 3. 打开翻到无end开头：只请求 pb-d1，停住且不标 read_markers
  await user.click(screen.getByRole("button", { name: "翻到无end开头" }));
  await waitFor(() => {
    expect(messagesRequests).toHaveLength(3);
  });
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("无end-9");
  expect(readMarkerPosts.some((p) => p.url.includes("reach-start-noend"))).toBe(false);

  // 4. 切回重开这两个已翻到开头的 Topic，不再重复发 /messages
  await user.click(screen.getByRole("button", { name: "翻到空chunk开头" }));
  await user.click(screen.getByRole("button", { name: "翻到无end开头" }));
  expect(messagesRequests).toHaveLength(3);
});

test("Owner 向上滚到顶部时按每页50条再要一页，反序前置并保持滚动位置不变，翻到房间开头后不再继续请求", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const messagesRequests: string[] = [];

  function makeMsgs(from: number, to: number, baseTs = 1000) {
    const out = [];
    for (let n = from; n <= to; n += 1) {
      out.push({
        type: "m.room.message",
        event_id: `$s${n}`,
        sender: "@bot:example.com",
        origin_server_ts: baseTs + n * 100,
        content: { msgtype: "m.text", body: `历史-${n}` },
      });
    }
    return out;
  }

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: validAgents,
          rooms: {
            join: {
              "!scroll-backfill:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "上滚翻页话题" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$s120" } }],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-scroll-1",
                  events: makeMsgs(101, 120),
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "GET" && input.url.includes("/messages")) {
      messagesRequests.push(input.url);
      const u = new URL(input.url);
      expect(u.searchParams.get("dir")).toBe("b");
      expect(u.searchParams.get("limit")).toBe("50");
      const from = u.searchParams.get("from");
      if (from === "pb-scroll-1") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-scroll-1",
            end: "pb-scroll-2",
            chunk: makeMsgs(51, 100).reverse(),
          },
        };
      }
      if (from === "pb-scroll-2") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-scroll-2",
            chunk: makeMsgs(1, 50).reverse(),
          },
        };
      }
      throw new Error(`不应请求更多分页：${input.url}`);
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 200, async () => {
    renderApp(homeserver);
    await login(user);

    const row = await screen.findByRole("button", { name: "上滚翻页话题" });
    await user.click(row);

    const timeline = screen.getByRole("log", { name: "对话时间线" });
    // 已读到最后一条 $s120 -> 打开停在底部，不触发 /messages
    expect(timeline.scrollTop).toBe(1800);
    expect(messagesRequests).toEqual([]);

    // Owner 向上滚到顶部 -> 只拉一页 pb-scroll-1
    await act(async () => {
      timeline.scrollTop = 0;
      fireEvent.scroll(timeline);
    });
    await waitFor(() => {
      expect(timeline.querySelectorAll("[data-side]")).toHaveLength(70);
    });
    expect(messagesRequests).toEqual([
      "https://matrix.example.com/_matrix/client/v3/rooms/!scroll-backfill%3Aexample.com/messages?dir=b&limit=50&from=pb-scroll-1",
    ]);
    // 保持滚动位置：前置 50 条 * 100px = 5000px，原先顶部的 历史-101 仍在原位
    expect(timeline.scrollTop).toBe(5000);
    const bubbles1 = Array.from(timeline.querySelectorAll(".waypoint-bubble")).map((el) => el.textContent);
    expect(bubbles1[0]).toBe("历史-51");
    expect(bubbles1[50]).toBe("历史-101");

    // 没有再滚到顶部时，不会自动连拉第二页
    expect(messagesRequests).toHaveLength(1);

    // Owner 再次向上滚到顶部 -> 再拉一页 pb-scroll-2（无 end -> 到房间开头）
    await act(async () => {
      timeline.scrollTop = 0;
      fireEvent.scroll(timeline);
    });
    await waitFor(() => {
      expect(timeline.querySelectorAll("[data-side]")).toHaveLength(120);
    });
    expect(messagesRequests).toHaveLength(2);
    expect(timeline.scrollTop).toBe(5000);
    const bubbles2 = Array.from(timeline.querySelectorAll(".waypoint-bubble")).map((el) => el.textContent);
    expect(bubbles2[0]).toBe("历史-1");

    // 已经到房间开头，再次滚动到顶部不再发请求
    await act(async () => {
      timeline.scrollTop = 0;
      fireEvent.scroll(timeline);
    });
    expect(messagesRequests).toHaveLength(2);
  });
});

test("多个中间limited缺口均不在后台补完且绝不越过缺口标为已读；已读位置落在中间缺口里时打开才补该缺口、插在正确位置并停在第一条未读", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const messagesRequests: string[] = [];
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

  function makeRange(prefix: string, from: number, to: number, baseTs = 1000) {
    const out = [];
    for (let n = from; n <= to; n += 1) {
      out.push({
        type: "m.room.message",
        event_id: `$${prefix}${n}`,
        sender: "@bot:example.com",
        origin_server_ts: baseTs + n * 100,
        content: { msgtype: "m.text", body: `${prefix}-${n}` },
      });
    }
    return out;
  }

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                "!multi-gap:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "多缺口不可越过" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$g1" } }],
                  },
                  timeline: {
                    events: makeRange("g", 1, 2),
                  },
                },
                "!mid-gap-read:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "已读在中间缺口" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m1" } }],
                  },
                  timeline: {
                    events: makeRange("m", 1, 2, 2000),
                  },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!multi-gap:example.com": {
                  timeline: {
                    limited: true,
                    prev_batch: "pb-g-mid-1",
                    events: makeRange("g", 10, 11, 5000),
                  },
                },
                "!mid-gap-read:example.com": {
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m6" } }],
                  },
                  timeline: {
                    limited: true,
                    prev_batch: "pb-m-mid",
                    events: makeRange("m", 10, 13, 6000),
                  },
                },
              },
            },
          },
        };
      }
      if (syncRound === 3) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-3",
            rooms: {
              join: {
                "!multi-gap:example.com": {
                  timeline: {
                    limited: true,
                    prev_batch: "pb-g-mid-2",
                    events: makeRange("g", 20, 21, 9000),
                  },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "GET" && input.url.includes("/messages")) {
      messagesRequests.push(input.url);
      const u = new URL(input.url);
      const from = u.searchParams.get("from");
      if (from === "pb-m-mid") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-m-mid",
            end: "pb-m-bridge",
            chunk: makeRange("m", 3, 9, 2000).reverse(),
          },
        };
      }
      if (from === "pb-m-bridge") {
        return {
          type: "response",
          status: 200,
          body: {
            start: "pb-m-bridge",
            chunk: makeRange("m", 1, 2, 2000).reverse(),
          },
        };
      }
      throw new Error(`不应请求：${input.url}`);
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 200, async () => {
    const { clock } = renderApp(homeserver);
    await login(user);

    const multiGapRow = await screen.findByRole("button", { name: "多缺口不可越过" });
    await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
    await act(async () => { clock.advance(1000); });
    await waitFor(() => expect(syncRound).toBe(2));
    await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
    await act(async () => { clock.advance(1000); });
    await waitFor(() => expect(syncRound).toBe(3));

    // 同步里记下的 limited 缺口不在后台补完
    expect(messagesRequests).toEqual([]);

    // 1. 打开多缺口话题：$g1 在本地 -> 不请求 /messages；滚动到底部时也只能推进到 $g2，不能越过第一处缺口到 $g11 或 $g21

    await user.click(multiGapRow);
    expect(messagesRequests).toEqual([]);
    const tl1 = screen.getByRole("log", { name: "对话时间线" });
    await act(async () => {
      tl1.scrollTop = 400;
      fireEvent.scroll(tl1);
    });
    await waitFor(() => {
      expect(readMarkerPosts).toContainEqual({
        url: "https://matrix.example.com/_matrix/client/v3/rooms/!multi-gap%3Aexample.com/read_markers",
        body: { "m.fully_read": "$g2", "m.read.private": "$g2" },
      });
    });
    expect(
      readMarkerPosts.some(
        (p) =>
          p.url.includes("multi-gap") &&
          ((p.body as Record<string, string>)["m.fully_read"] === "$g10" ||
            (p.body as Record<string, string>)["m.fully_read"] === "$g11" ||
            (p.body as Record<string, string>)["m.fully_read"] === "$g20" ||
            (p.body as Record<string, string>)["m.fully_read"] === "$g21"),
      ),
    ).toBe(false);
    expect(multiGapRow).toHaveAttribute("data-unread", "true");

    // 2. 打开已读在中间缺口的话题：向后补页 pb-m-mid，把 m-3..m-9 插在 m-2 和 m-10 之间，停在 $m7，只标可见的 $m7,$m8
    const midGapRow = screen.getByRole("button", { name: "已读在中间缺口" });
    await user.click(midGapRow);
    await waitFor(() => {
      expect(messagesRequests).toEqual([
        "https://matrix.example.com/_matrix/client/v3/rooms/!mid-gap-read%3Aexample.com/messages?dir=b&limit=50&from=pb-m-mid",
      ]);
    });
    const tl2 = screen.getByRole("log", { name: "对话时间线" });
    await waitFor(() => {
      expect(tl2.querySelectorAll("[data-side]")).toHaveLength(13);
    });
    const bubbles = Array.from(tl2.querySelectorAll(".waypoint-bubble")).map((el) => el.textContent);
    expect(bubbles).toEqual([
      "m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7", "m-8", "m-9", "m-10", "m-11", "m-12", "m-13",
    ]);
    // 停在 $m7 (index 6 -> scrollTop = 600), 视口 600..800 只可见 $m7 和 $m8
    expect(tl2.scrollTop).toBe(600);
    await waitFor(() => {
      expect(readMarkerPosts).toContainEqual({
        url: "https://matrix.example.com/_matrix/client/v3/rooms/!mid-gap-read%3Aexample.com/read_markers",
        body: { "m.fully_read": "$m8", "m.read.private": "$m8" },
      });
    });
    expect(midGapRow).toHaveAttribute("data-unread", "true");

    // 3. 上滚到顶部触发补齐剩余桥接重叠（m-1, m-2 不重复）
    await act(async () => {
      tl2.scrollTop = 0;
      fireEvent.scroll(tl2);
    });
    await waitFor(() => {
      expect(messagesRequests).toHaveLength(2);
    });
    expect(tl2.querySelectorAll("[data-side]")).toHaveLength(13);
  });
});

test("补页里的编辑、撤回及已读位置本身被撤回都能正确处理；补页遇网络失败不死循环并在重开或再次上滚时可重试成功", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let allowMessages = false;
  let messagesCount = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: validAgents,
          rooms: {
            join: {
              "!edit-redact-backfill:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "补页编辑撤回" } },
                  ],
                },
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$er2" } }],
                },
                timeline: {
                  limited: true,
                  prev_batch: "pb-er-1",
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$er5",
                      sender: "@bot:example.com",
                      origin_server_ts: 5000,
                      content: { msgtype: "m.text", body: "最新消息5" },
                    },
                  ],
                },
              },
              "!other:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 500, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "对照话题" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "GET" && input.url.includes("/messages")) {
      messagesCount += 1;
      if (!allowMessages) {
        return { type: "failure", failure: { type: "network" } };
      }
      return {
        type: "response",
        status: 200,
        body: {
          start: "pb-er-1",
          chunk: [
            {
              type: "m.room.redaction",
              event_id: "$red-er2",
              sender: "@bot:example.com",
              origin_server_ts: 4200,
              redacts: "$er2",
              content: {},
            },
            {
              type: "m.room.message",
              event_id: "$er3-edit",
              sender: "@bot:example.com",
              origin_server_ts: 4100,
              content: {
                msgtype: "m.text",
                body: "* 补页改后3",
                "m.new_content": { msgtype: "m.text", body: "补页改后3" },
                "m.relates_to": { rel_type: "m.replace", event_id: "$er3" },
              },
            },
            {
              type: "m.room.message",
              event_id: "$er3",
              sender: "@bot:example.com",
              origin_server_ts: 3000,
              content: { msgtype: "m.text", body: "补页原3" },
            },
            {
              type: "m.room.message",
              event_id: "$er2",
              sender: "@bot:example.com",
              origin_server_ts: 2500,
              content: { msgtype: "m.text", body: "将被撤回的已读2" },
            },
            {
              type: "m.room.message",
              event_id: "$er1",
              sender: "@bot:example.com",
              origin_server_ts: 2000,
              content: { msgtype: "m.text", body: "最早消息1" },
            },
          ],
        },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 200, async () => {
    const { clock } = renderApp(homeserver);
    await login(user);

    const row = await screen.findByRole("button", { name: "补页编辑撤回" });
    // 1. 网络失败时打开：只尝试 1 次，不死循环
    await user.click(row);
    await waitFor(() => expect(messagesCount).toBe(1));
    await act(async () => { clock.advance(3000); });
    expect(messagesCount).toBe(1);

    // 2. 切走再重开，网络恢复：重试成功
    await user.click(screen.getByRole("button", { name: "对照话题" }));
    allowMessages = true;
    await user.click(row);

    const timeline = screen.getByRole("log", { name: "对话时间线" });
    await waitFor(() => {
      expect(timeline.querySelectorAll("[data-side]")).toHaveLength(3);
    });
    const bubbles = Array.from(timeline.querySelectorAll(".waypoint-bubble")).map((el) => el.textContent);
    expect(bubbles).toEqual(["最早消息1", "补页改后3", "最新消息5"]);
    // $er2 被撤回回退到 $er1，第一条未读是 $er3 (index=1 -> scrollTop=100)
    expect(timeline.scrollTop).toBe(100);
  });
});

test("标记版本不是 1 或绑定 Agent 用户 ID 不合法时 Topic 不可用，保留名字、不编名字也不显示用户 ID 或未知，只显示 Owner 消息且恢复后可用", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncRound += 1;
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: {
                    agents: [{ user_id: "@bot:example.com", name: "小赫" }],
                  },
                },
              ],
            },
            rooms: {
              join: {
                "!bad-ver:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 3000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 2, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "高版本话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$bv-1",
                        sender: "@alice:example.com",
                        origin_server_ts: 3100,
                        content: { msgtype: "m.text", body: "Owner 说过的话" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$bv-2",
                        sender: "@bot:example.com",
                        origin_server_ts: 3200,
                        content: { msgtype: "m.text", body: "旧版绑定不应展示的 Bot 消息" },
                      },
                    ],
                  },
                },
                "!bad-agent-foreign:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@stranger:other.example" } },
                      { type: "m.room.name", state_key: "", content: { name: "跨服绑定话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$bf-1",
                        sender: "@alice:example.com",
                        origin_server_ts: 2100,
                        content: { msgtype: "m.text", body: "跨服话题里 Owner 的消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$bf-2",
                        sender: "@stranger:other.example",
                        origin_server_ts: 2200,
                        content: { msgtype: "m.text", body: "跨服发送者不应展示" },
                      },
                    ],
                  },
                },
                "!bad-agent-self:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@alice:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "绑定自己话题" } },
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
              "!bad-ver:example.com": {
                state: {
                  events: [
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  const badVerRow = await screen.findByRole("button", { name: "高版本话题" });
  expect(badVerRow).toHaveAttribute("data-unavailable", "true");
  expect(within(badVerRow).getByText("不可用")).toBeInTheDocument();

  const foreignRow = screen.getByRole("button", { name: "跨服绑定话题" });
  expect(foreignRow).toHaveAttribute("data-unavailable", "true");
  expect(within(foreignRow).getByText("不可用")).toBeInTheDocument();

  const selfRow = screen.getByRole("button", { name: "绑定自己话题" });
  expect(selfRow).toHaveAttribute("data-unavailable", "true");
  expect(within(selfRow).getByText("不可用")).toBeInTheDocument();

  expect(document.body).not.toHaveTextContent("@stranger:other.example");
  expect(document.body).not.toHaveTextContent("@alice:example.com");
  expect(document.body).not.toHaveTextContent("未知");

  // 打开跨服绑定话题
  await user.click(foreignRow);
  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("跨服绑定话题");
  expect(header).not.toHaveTextContent("小赫");
  expect(header).not.toHaveTextContent("@stranger:other.example");
  expect(header).not.toHaveTextContent("未知");

  const statusBanner = screen.getByRole("status", { name: "Topic 不可用" });
  expect(statusBanner).toHaveTextContent("不合法");
  expect(statusBanner).toHaveTextContent("无法发送新消息");

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(within(timeline).getByText("跨服话题里 Owner 的消息")).toBeInTheDocument();
  expect(within(timeline).queryByText("跨服发送者不应展示")).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("未知");
  expect(document.body).not.toHaveTextContent("@stranger:other.example");

  const input = screen.getByRole("textbox", { name: "输入消息" });
  expect(input).toBeDisabled();
  expect(input).not.toHaveAttribute("placeholder");
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(screen.getByLabelText("选择附件")).toBeDisabled();

  // 打开高版本话题，确认只显示 Owner 消息、横幅点明版本原因
  await user.click(badVerRow);
  expect(screen.getByRole("banner")).toHaveTextContent("高版本话题");
  const verBanner = screen.getByRole("status", { name: "Topic 不可用" });
  expect(verBanner).toHaveTextContent("版本");
  expect(verBanner).toHaveTextContent("无法发送新消息");
  expect(within(screen.getByRole("log", { name: "对话时间线" })).getByText("Owner 说过的话")).toBeInTheDocument();
  expect(screen.queryByText("旧版绑定不应展示的 Bot 消息")).not.toBeInTheDocument();

  // 后续同步把高版本话题的标记修回 v: 1，不可用自动消失
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(badVerRow).not.toHaveAttribute("data-unavailable", "true");
  });
  expect(within(badVerRow).queryByText("不可用")).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Topic 不可用" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  expect(screen.getByText("旧版绑定不应展示的 Bot 消息")).toBeInTheDocument();
});

test("普通加密房间不进列表；已有加密标记或诞生后才加密的 Topic 留在列表并标不可用，保留未读且可前移已读位置，重启后永不自动恢复", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncRound += 1;
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: {
                    agents: [{ user_id: "@bot:example.com", name: "小赫" }],
                  },
                },
              ],
            },
            rooms: {
              join: {
                "!legacy-enc:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "m.room.name", state_key: "", content: { name: "旧加密房间不应入列" } },
                      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!enc-later:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "后来被加密" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$e1" } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$e1",
                        sender: "@alice:example.com",
                        origin_server_ts: 1100,
                        content: { msgtype: "m.text", body: "早先的提问" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$e2",
                        sender: "@bot:example.com",
                        origin_server_ts: 1200,
                        content: { msgtype: "m.text", body: "未读回复" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!enc-later:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.encryption",
                        state_key: "",
                        event_id: "$enc-ev",
                        sender: "@alice:example.com",
                        origin_server_ts: 1300,
                        content: { algorithm: "m.megolm.v1.aes-sha2" },
                      },
                    ],
                  },
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
        },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  const encLaterRow = await screen.findByRole("button", { name: "后来被加密" });
  expect(screen.queryByText("旧加密房间不应入列")).not.toBeInTheDocument();
  expect(encLaterRow).not.toHaveAttribute("data-unavailable", "true");
  expect(encLaterRow).toHaveAttribute("data-unread", "true");

  // 下一轮同步收到 m.room.encryption -> 留在列表且标不可用，未读圆点与加粗仍在
  await advanceWhenTimerScheduled(first.clock, 1000);
  await waitFor(() => {
    expect(encLaterRow).toHaveAttribute("data-unavailable", "true");
  });
  expect(within(encLaterRow).getByText("不可用")).toBeInTheDocument();
  expect(encLaterRow).toHaveAttribute("data-unread", "true");
  expect(encLaterRow.querySelector(".waypoint-unread-dot")).not.toBeNull();
  expect(encLaterRow.querySelector(".waypoint-topic-name")).toHaveClass("unread");

  // 打开后顶部横幅说明加密原因和无法发送新消息，历史消息正常显示，且已读位置正常前移
  await user.click(encLaterRow);
  const banner = screen.getByRole("status", { name: "Topic 不可用" });
  expect(banner).toHaveTextContent("加密");
  expect(banner).toHaveTextContent("无法发送新消息");
  expect(screen.getByText("早先的提问")).toBeInTheDocument();
  expect(screen.getByText("未读回复")).toBeInTheDocument();

  await waitFor(() => {
    expect(
      homeserver.requests.some(
        (req) =>
          req.method === "POST" &&
          req.url.includes("/rooms/!enc-later%3Aexample.com/read_markers") &&
          JSON.stringify(req.body).includes("$e2"),
      ),
    ).toBe(true);
  });
  await waitFor(() => {
    expect(encLaterRow).not.toHaveAttribute("data-unread", "true");
  });

  // 重启恢复后，即使后续同步没有再带 m.room.encryption，也永久保持不可用
  first.unmount();
  renderApp(homeserver);

  const restoredRow = await screen.findByRole("button", { name: "后来被加密" });
  expect(restoredRow).toHaveAttribute("data-unavailable", "true");
  expect(within(restoredRow).getByText("不可用")).toBeInTheDocument();
  expect(screen.queryByText("旧加密房间不应入列")).not.toBeInTheDocument();
});

test("Agent 被 ban、多于两人（含其他人未接受邀请）或邀请明确失败时 Topic 不可用；恢复后自动可用，且 Waypoint 不踢人、不撤邀请、不解除 ban、不重复邀请", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncRound += 1;
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: {
                    agents: [{ user_id: "@bot:example.com", name: "小赫" }],
                  },
                },
              ],
            },
            rooms: {
              join: {
                "!banned:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 4000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "被封禁话题" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "ban" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!three-invite:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 3000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "三人待接受" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@eve:example.com", content: { membership: "invite" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!invite-rejected:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "拒绝邀请话题" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "leave" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!pending-invite:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "等待接受邀请" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "invite" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!banned:example.com": {
                  state: {
                    events: [
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!three-invite:example.com": {
                  state: {
                    events: [
                      { type: "m.room.member", state_key: "@eve:example.com", content: { membership: "leave" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!invite-rejected:example.com": {
                  state: {
                    events: [
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "invite" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return {
        type: "response",
        status: 200,
        body: {
          room_id: "!create-invite-fail:example.com",
          failed_invites: ["@bot:example.com"],
        },
      };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/rooms/!create-invite-fail%3Aexample.com/state/m.room.encryption")
    ) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND", error: "Not found" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  const bannedRow = await screen.findByRole("button", { name: "被封禁话题" });
  const threeRow = screen.getByRole("button", { name: "三人待接受" });
  const rejectedRow = screen.getByRole("button", { name: "拒绝邀请话题" });
  const pendingRow = screen.getByRole("button", { name: "等待接受邀请" });

  expect(bannedRow).toHaveAttribute("data-unavailable", "true");
  expect(threeRow).toHaveAttribute("data-unavailable", "true");
  expect(rejectedRow).toHaveAttribute("data-unavailable", "true");
  expect(pendingRow).not.toHaveAttribute("data-unavailable", "true");

  await user.click(bannedRow);
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent(/ban|封禁/);
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("无法发送新消息");

  await user.click(threeRow);
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("多于两人");
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("无法发送新消息");

  await user.click(rejectedRow);
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("邀请");
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("无法发送新消息");

  // 后续同步恢复成只有 Owner 与绑定 Bot
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(bannedRow).not.toHaveAttribute("data-unavailable", "true");
    expect(threeRow).not.toHaveAttribute("data-unavailable", "true");
    expect(rejectedRow).not.toHaveAttribute("data-unavailable", "true");
  });
  expect(screen.queryByRole("status", { name: "Topic 不可用" })).not.toBeInTheDocument();

  // 新建 Topic 时若返回明确邀请失败，房间进入列表并呈不可用
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "建房邀请失败");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const createdRow = await screen.findByRole("button", { name: "建房邀请失败" });
  expect(createdRow).toHaveAttribute("data-unavailable", "true");
  expect(within(createdRow).getByText("不可用")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("邀请");
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("无法发送新消息");

  // 确认 Waypoint 绝不发送 kick / unban / invite 请求
  expect(
    homeserver.requests.some(
      (r) => r.url.includes("/kick") || r.url.includes("/unban") || r.url.includes("/invite"),
    ),
  ).toBe(false);
});

test("Topic 不可用时保留草稿（含文字与附件）并在恢复后可继续编辑发送，且改名、改 Description、置顶与删除入口一致可用", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncRound += 1;
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: {
                    agents: [{ user_id: "@bot:example.com", name: "小赫" }],
                  },
                },
              ],
            },
            rooms: {
              join: {
                "!t-draft:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "带草稿的话题" } },
                      { type: "m.room.topic", state_key: "", content: { topic: "旧说明" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t-del:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "可删不可用话题" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "ban" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!t-draft:example.com": {
                  state: {
                    events: [
                      { type: "m.room.member", state_key: "@eve:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (syncRound === 4) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-4",
            rooms: {
              join: {
                "!t-draft:example.com": {
                  state: {
                    events: [
                      { type: "m.room.member", state_key: "@eve:example.com", content: { membership: "leave" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (
      input.method === "PUT" &&
      input.url.includes("/tags/im.waypoint.pinned")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    if (
      input.method === "PUT" &&
      (input.url.includes("/state/m.room.name") || input.url.includes("/state/m.room.topic"))
    ) {
      return { type: "response", status: 200, body: { event_id: "$state-ok" } };
    }
    if (input.method === "POST" && input.url.includes("/rooms/!t-del%3Aexample.com/leave")) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.includes("/rooms/!t-del%3Aexample.com/forget")) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      return { type: "response", status: 200, body: { event_id: "$sent-draft" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "带草稿的话题" }));
  const input = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(input, "写一半的草稿");
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  await user.upload(screen.getByLabelText("选择附件"), file);
  expect(await screen.findByText("notes.txt")).toBeInTheDocument();

  // 第三人加入 -> 话题变不可用，草稿（文字与附件）完整保留且输入/发送/移除附件全部禁用
  await advanceWhenTimerScheduled(first.clock, 1000);
  await waitFor(() => {
    expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("多于两人");
  });
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("写一半的草稿");
  expect(screen.getByRole("textbox", { name: "输入消息" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "输入消息" })).not.toHaveAttribute("placeholder");
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(screen.getByText("notes.txt")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移除附件" })).toBeDisabled();

  // 不可用时可置顶、改名、改 Description（不能换绑定的 Bot）
  await user.click(screen.getByRole("button", { name: "置顶" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "取消置顶" })).toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();
  const editName = screen.getByLabelText("Topic 名字");
  await user.clear(editName);
  await user.type(editName, "不可用也可改名");
  const editDesc = screen.getByLabelText(/Description/);
  await user.clear(editDesc);
  await user.type(editDesc, "更新后的说明");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(screen.getByRole("banner")).toHaveTextContent("不可用也可改名");
  });
  expect(screen.getByRole("banner")).toHaveTextContent("更新后的说明");
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("多于两人");

  // 重启后草稿仍保留在本地
  first.unmount();
  const second = renderApp(homeserver);
  const renamedRow = await screen.findByRole("button", { name: "不可用也可改名" });
  expect(renamedRow).toHaveAttribute("data-unavailable", "true");
  expect(renamedRow).toHaveAttribute("data-pinned", "true");
  await user.click(renamedRow);
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("写一半的草稿");
  expect(screen.getByRole("textbox", { name: "输入消息" })).toBeDisabled();
  expect(screen.getByText("notes.txt")).toBeInTheDocument();

  // 第三人离开 -> 恢复可用，草稿可继续编辑并发送
  await advanceWhenTimerScheduled(second.clock, 1000);
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "Topic 不可用" })).not.toBeInTheDocument();
  });
  const recoveredInput = screen.getByRole("textbox", { name: "输入消息" });
  expect(recoveredInput).toBeEnabled();
  expect(recoveredInput).toHaveValue("写一半的草稿");
  await user.click(screen.getByRole("button", { name: "移除附件" }));
  await user.type(recoveredInput, "补充内容");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(
      homeserver.requests.some(
        (req) =>
          req.method === "PUT" &&
          req.url.includes("/rooms/!t-draft%3Aexample.com/send/m.room.message/") &&
          (req.body as { body?: string }).body === "写一半的草稿补充内容",
      ),
    ).toBe(true);
  });

  // 不可用 Topic 的删除流程与正常 Topic 一致
  await user.click(screen.getByRole("button", { name: "可删不可用话题" }));
  await user.click(screen.getByRole("button", { name: "删除" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "可删不可用话题" })).not.toBeInTheDocument();
  });
});

test("Topic 不可用时失败消息的红叹号仍在，点击马上又失败且不发请求也不在气泡解释原因；重试队列里的未确认消息在不可用时立即转为失败", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  let sendAttempts = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncRound += 1;
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: {
                    agents: [{ user_id: "@bot:example.com", name: "小赫" }],
                  },
                },
              ],
            },
            rooms: {
              join: {
                "!t-fail:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "含失败消息话题" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t-queued:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "排队重试话题" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!t-fail:example.com": {
                  state: {
                    events: [
                      { type: "m.room.member", state_key: "@eve:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t-queued:example.com": {
                  state: {
                    events: [
                      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendAttempts += 1;
      if (input.url.includes("!t-fail%3Aexample.com")) {
        return { type: "response", status: 403, body: { errcode: "M_FORBIDDEN", error: "Forbidden" } };
      }
      if (input.url.includes("!t-queued%3Aexample.com")) {
        return { type: "response", status: 500, body: { errcode: "M_UNKNOWN", error: "Server Error" } };
      }
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  // 1) 在「含失败消息话题」发送一条会被 403 拒绝的消息 -> 红叹号出现
  await user.click(await screen.findByRole("button", { name: "含失败消息话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "被拒绝的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("button", { name: "失败" })).toBeInTheDocument();

  // 2) 在「排队重试话题」发送一条遇到 500 进入退避重试的未确认消息（先推进 500ms 错开下次同步与退避定时器）
  await act(async () => {
    clock.advance(500);
  });
  await user.click(screen.getByRole("button", { name: "排队重试话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "排队中的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(sendAttempts).toBe(2);
  });
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

  const sendCountBeforeUnavailable = homeserver.requests.filter((r) =>
    r.url.includes("/send/m.room.message/"),
  ).length;
  expect(sendCountBeforeUnavailable).toBe(2);

  // 3) 下一轮同步让两个话题都变成不可用 -> 排队中的消息立刻转为失败，且之后即使过了退避时间也不再发任何 send 请求
  await act(async () => {
    clock.advance(500);
  });
  await waitFor(() => {
    expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("加密");
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "失败" })).toBeInTheDocument();
  });
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  await act(async () => {
    clock.advance(2000);
  });
  expect(
    homeserver.requests.filter((r) => r.url.includes("/send/m.room.message/")).length,
  ).toBe(sendCountBeforeUnavailable);

  // 4) 打开「含失败消息话题」，红叹号还在；点击红叹号马上又失败，不发请求且不在气泡上解释原因
  await user.click(screen.getByRole("button", { name: "含失败消息话题" }));
  expect(screen.getByRole("status", { name: "Topic 不可用" })).toHaveTextContent("多于两人");
  const failedButton = screen.getByRole("button", { name: "失败" });
  await user.click(failedButton);

  // 点击后仍是失败红叹号（不变成未确认、不发送请求、不在气泡周围显示原因）
  expect(screen.getByRole("button", { name: "失败" })).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  expect(
    homeserver.requests.filter((r) => r.url.includes("/send/m.room.message/")).length,
  ).toBe(sendCountBeforeUnavailable);
  const bubbleRow = screen.getByText("被拒绝的消息").closest(".waypoint-message-row") as HTMLElement;
  expect(bubbleRow).not.toHaveTextContent("多于两人");
  expect(bubbleRow).not.toHaveTextContent("无法发送");
});

test("列表行正在回应只认绑定 Agent 未撤回的 👀，多条 👀 只显示一次，回答出现未撤回前仍在，typing 与非绑定者 👀 不触发，单 Bot 无状态时不显示次行", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                      { type: "m.room.name", state_key: "", content: { name: "处理中话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$a1" } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$u0",
                        sender: "@alice:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "问题零" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$u1",
                        sender: "@alice:example.com",
                        origin_server_ts: 2100,
                        content: { msgtype: "m.text", body: "问题一" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$eyes-0",
                        sender: "@bot:example.com",
                        origin_server_ts: 2200,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u0", key: "👀" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$eyes-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2300,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u1", key: "👀" } },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$a1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2400,
                        content: { msgtype: "m.text", body: "已经出现的回答" },
                      },
                    ],
                  },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "仅typing话题" } },
                    ],
                  },
                  ephemeral: {
                    events: [{ type: "m.typing", content: { user_ids: ["@bot:example.com"] } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$u2",
                        sender: "@alice:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "纯文本" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$owner-eyes",
                        sender: "@alice:example.com",
                        origin_server_ts: 2100,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u2", key: "👀" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$other-eyes",
                        sender: "@stranger:example.com",
                        origin_server_ts: 2200,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$u2", key: "👀" } },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$red-0",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        redacts: "$eyes-0",
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
      if (syncRound === 3) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-3",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$red-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2600,
                        redacts: "$eyes-1",
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
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  const row1 = await screen.findByRole("button", { name: "处理中话题" });
  expect(within(row1).getAllByText("正在回应")).toHaveLength(1);
  expect(row1).not.toHaveAttribute("data-unread", "true");
  expect(row1.querySelector(".waypoint-topic-row-bot")).toBeNull();

  const row2 = screen.getByRole("button", { name: "仅typing话题" });
  expect(row2).not.toHaveTextContent("正在回应");
  expect(row2.querySelector(".waypoint-topic-row-secondary")).toBeNull();

  // 撤回第一条 👀，第二条 👀 还在，依然显示一次正在回应
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBeGreaterThanOrEqual(2));
  expect(within(row1).getAllByText("正在回应")).toHaveLength(1);

  // 撤回第二条 👀，正在回应消失，单 Bot 次行也消失
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => {
    expect(row1).not.toHaveTextContent("正在回应");
  });
  expect(row1.querySelector(".waypoint-topic-row-secondary")).toBeNull();
});

test("多 Bot 时列表次行同时显示 Bot 名字与正在回应，并与未读圆点、置顶及发送状态共存，且不认非绑定 Bot 的 👀", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: {
            events: [
              {
                type: "im.waypoint.agents",
                content: {
                  agents: [
                    { user_id: "@bot1:example.com", name: "研究助理" },
                    { user_id: "@bot2:example.com", name: "编程助理" },
                  ],
                },
              },
            ],
          },
          rooms: {
            join: {
              "!multi-1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "全状态话题" } },
                  ],
                },
                account_data: {
                  events: [
                    { type: "m.tag", content: { tags: { "im.waypoint.pinned": { order: 0 } } } },
                    { type: "m.fully_read", content: { event_id: "$m1" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$m1",
                      sender: "@alice:example.com",
                      origin_server_ts: 2000,
                      content: { msgtype: "m.text", body: "老问题" },
                    },
                    {
                      type: "m.reaction",
                      event_id: "$m-eyes",
                      sender: "@bot1:example.com",
                      origin_server_ts: 2100,
                      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$m1", key: "👀" } },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$m2",
                      sender: "@bot1:example.com",
                      origin_server_ts: 2200,
                      content: { msgtype: "m.text", body: "新进度消息" },
                    },
                  ],
                },
              },
              "!multi-2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot2:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "空闲多Bot话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$b2-m1",
                      sender: "@alice:example.com",
                      origin_server_ts: 2000,
                      content: { msgtype: "m.text", body: "问编程助理" },
                    },
                    {
                      type: "m.reaction",
                      event_id: "$wrong-bot-eyes",
                      sender: "@bot1:example.com",
                      origin_server_ts: 2100,
                      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$b2-m1", key: "👀" } },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      return { type: "response", status: 403, body: { errcode: "M_FORBIDDEN", error: "Forbidden" } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  const row1 = await screen.findByRole("button", { name: "全状态话题" });
  expect(row1).toHaveAttribute("data-unread", "true");
  expect(row1).toHaveAttribute("data-pinned", "true");
  expect(row1.querySelector(".waypoint-unread-dot")).not.toBeNull();
  expect(within(row1).getByText("置顶")).toBeInTheDocument();
  expect(within(row1).getByText("研究助理")).toBeInTheDocument();
  expect(within(row1).getByText("正在回应")).toBeInTheDocument();
  expect(row1.querySelector(".waypoint-topic-row-time")).not.toBeNull();

  // 在另一个 Topic 上发送失败，然后验证未读+置顶+Bot名+正在回应+失败红叹号五者共存
  await user.click(row1);
  const input = screen.getByLabelText("输入消息");
  await user.type(input, "这句会失败");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(within(row1).getByRole("img", { name: "失败" })).toBeInTheDocument();
  });
  expect(within(row1).getByText("研究助理")).toBeInTheDocument();
  expect(within(row1).getByText("正在回应")).toBeInTheDocument();
  expect(within(row1).getByText("置顶")).toBeInTheDocument();

  const row2 = screen.getByRole("button", { name: "空闲多Bot话题" });
  expect(within(row2).getByText("编程助理")).toBeInTheDocument();
  expect(row2).not.toHaveTextContent("正在回应");
});

test("打开 Topic 时只在挂着绑定 Agent 的 👀 的消息下方显示正在回应（不设全局横幅），进度文字按普通气泡渲染，撤回 👀 后消失", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                "!open-1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "对话内指示话题" } },
                    ],
                  },
                  ephemeral: {
                    events: [{ type: "m.typing", content: { user_ids: ["@bot:example.com"] } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$msg-old",
                        sender: "@alice:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "早先的问题" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$msg-q1",
                        sender: "@alice:example.com",
                        origin_server_ts: 2100,
                        content: { msgtype: "m.text", body: "请分析日志" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$eyes-q1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2200,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg-q1", key: "👀" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$eyes-old-owner",
                        sender: "@alice:example.com",
                        origin_server_ts: 2250,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg-old", key: "👀" } },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$msg-prog",
                        sender: "@bot:example.com",
                        origin_server_ts: 2300,
                        content: { msgtype: "m.text", body: "🔧 正在读取日志文件" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$msg-prog-edit",
                        sender: "@bot:example.com",
                        origin_server_ts: 2350,
                        content: {
                          msgtype: "m.text",
                          body: "* 🔧 已读取 3 个日志",
                          "m.new_content": { msgtype: "m.text", body: "🔧 已读取 3 个日志" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$msg-prog" },
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$msg-q2",
                        sender: "@alice:example.com",
                        origin_server_ts: 2400,
                        content: { msgtype: "m.text", body: "顺便看下配置" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$eyes-q2",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg-q2", key: "👀" } },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!open-1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$msg-ans",
                        sender: "@bot:example.com",
                        origin_server_ts: 2600,
                        content: { msgtype: "m.text", body: "分析完成，一切正常" },
                      },
                      {
                        type: "m.room.redaction",
                        event_id: "$red-q1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2700,
                        redacts: "$eyes-q1",
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
      if (syncRound === 3) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-3",
            rooms: {
              join: {
                "!open-1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$red-q2",
                        sender: "@bot:example.com",
                        origin_server_ts: 2800,
                        redacts: "$eyes-q2",
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
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  const row = await screen.findByRole("button", { name: "对话内指示话题" });
  expect(within(row).getAllByText("正在回应")).toHaveLength(1);

  await user.click(row);
  const timeline = screen.getByRole("log", { name: "对话时间线" });

  // 不存在全局横幅：正在回应只在挂着 👀 的消息行内
  const topicView = timeline.closest(".waypoint-topic-view") as HTMLElement;
  expect(topicView.querySelector(".waypoint-topic-header")).not.toHaveTextContent("正在回应");

  // 进度文字作为普通气泡渲染
  const bubbles = Array.from(timeline.querySelectorAll(".waypoint-bubble")).map((el) => el.textContent);
  expect(bubbles).toEqual(["早先的问题", "请分析日志", "🔧 已读取 3 个日志", "顺便看下配置"]);

  const msgOldRow = timeline.querySelector("[data-event-id=\"$msg-old\"]") as HTMLElement;
  const msgQ1Row = timeline.querySelector("[data-event-id=\"$msg-q1\"]") as HTMLElement;
  const msgProgRow = timeline.querySelector("[data-event-id=\"$msg-prog\"]") as HTMLElement;
  const msgQ2Row = timeline.querySelector("[data-event-id=\"$msg-q2\"]") as HTMLElement;

  expect(msgOldRow).not.toHaveTextContent("正在回应");
  expect(msgQ1Row).toHaveTextContent("正在回应");
  expect(msgProgRow).not.toHaveTextContent("正在回应");
  expect(msgQ2Row).toHaveTextContent("正在回应");

  // 回答出现且撤回 $eyes-q1 后：$msg-q1 取消，但 $msg-q2 仍有 👀，所以 $msg-q2 和列表行仍在
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(timeline.querySelector("[data-event-id=\"$msg-ans\"]")).not.toBeNull();
  });
  expect(msgQ1Row).not.toHaveTextContent("正在回应");
  expect(msgQ2Row).toHaveTextContent("正在回应");
  expect(within(row).getAllByText("正在回应")).toHaveLength(1);

  // 撤回 $eyes-q2 后，所有正在回应消失
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(msgQ2Row).not.toHaveTextContent("正在回应");
  });
  expect(row).not.toHaveTextContent("正在回应");
});

test("消息上的 ✅ 和 ❌ 留在原消息上可见，不藏起、不升级为正在回应或失败状态，撤回 👀 后 ✅ 仍保留", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                "!rx-1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "反应保留话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ok-msg",
                        sender: "@alice:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "执行任务一" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$ok-eyes",
                        sender: "@bot:example.com",
                        origin_server_ts: 2100,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ok-msg", key: "👀" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$ok-check",
                        sender: "@bot:example.com",
                        origin_server_ts: 2200,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ok-msg", key: "✅" } },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$err-msg",
                        sender: "@alice:example.com",
                        origin_server_ts: 2300,
                        content: { msgtype: "m.text", body: "执行任务二" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$err-cross",
                        sender: "@bot:example.com",
                        origin_server_ts: 2400,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$err-msg", key: "❌" } },
                      },
                    ],
                  },
                },
                "!rx-only-done:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "仅完成叉号话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$done-msg",
                        sender: "@alice:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "只有叉号" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$done-cross",
                        sender: "@bot:example.com",
                        origin_server_ts: 2100,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$done-msg", key: "❌" } },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!rx-1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$red-ok-eyes",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        redacts: "$ok-eyes",
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
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  // 仅 ✅/❌ 的 Topic 列表行不显示正在回应、也不显示失败红叹号
  const doneRow = await screen.findByRole("button", { name: "仅完成叉号话题" });
  expect(doneRow).not.toHaveTextContent("正在回应");
  expect(within(doneRow).queryByRole("img", { name: "失败" })).not.toBeInTheDocument();

  const rxRow = screen.getByRole("button", { name: "反应保留话题" });
  await user.click(rxRow);

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const okMsgRow = timeline.querySelector("[data-event-id=\"$ok-msg\"]") as HTMLElement;
  const errMsgRow = timeline.querySelector("[data-event-id=\"$err-msg\"]") as HTMLElement;

  expect(within(okMsgRow).getByText("✅")).toBeInTheDocument();
  expect(okMsgRow).toHaveTextContent("正在回应");
  expect(within(okMsgRow).queryByRole("button")).not.toBeInTheDocument();

  expect(within(errMsgRow).getByText("❌")).toBeInTheDocument();
  expect(errMsgRow).not.toHaveTextContent("正在回应");
  expect(within(errMsgRow).queryByRole("button")).not.toBeInTheDocument();
  // 气泡正文保持纯净
  expect(okMsgRow.querySelector(".waypoint-bubble")).toHaveTextContent("执行任务一");
  expect(okMsgRow.querySelector(".waypoint-bubble")).not.toHaveTextContent("✅");

  // 撤回 👀 后，正在回应消失，但 ✅ 仍留在原消息上
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(okMsgRow).not.toHaveTextContent("正在回应");
  });
  expect(within(okMsgRow).getByText("✅")).toBeInTheDocument();
  expect(within(errMsgRow).getByText("❌")).toBeInTheDocument();
  expect(rxRow).not.toHaveTextContent("正在回应");
});

test("代码块横向滚动、不换行、可复制，且 mermaid 围栏只当代码块不作图 (#63)", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  const homeserver = new FakeHomeserver();
  const tsCode = "const veryLongVariableName = \"alpha-beta-gamma-delta-epsilon-zeta-eta-theta\";\nconsole.log(veryLongVariableName);";
  const mermaidCode = "graph TD;\nA-->B;";
  const agentBody = [
    "代码示例如下：",
    "```typescript",
    tsCode,
    "```",
    "",
    "```mermaid",
    mermaidCode,
    "```",
  ].join("\n");

  const ts = new Date(2026, 10, 12, 10, 0, 0).getTime();
  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                    { type: "m.room.create", state_key: "", origin_server_ts: ts, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "代码渲染话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$code-1",
                      sender: "@bot:example.com",
                      origin_server_ts: ts,
                      content: { msgtype: "m.text", body: agentBody },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    throw new Error(input.url);
  });

  const clock = new ManualClock();
  clock.now = ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "代码渲染话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const bubble = timeline.querySelector("[data-side=\"left\"] .waypoint-bubble") as HTMLElement;
  expect(bubble).not.toBeNull();

  // 代码块应渲染成 code-block，而不是原始 ```typescript 文本
  expect(bubble.textContent).not.toContain("```typescript");
  expect(bubble.textContent).not.toContain("```mermaid");

  const codeBodies = bubble.querySelectorAll("[data-streamdown=\"code-block-body\"]");
  expect(codeBodies).toHaveLength(2);
  const firstBody = codeBodies[0] as HTMLElement;
  const firstPre = firstBody.querySelector("pre") as HTMLElement;
  expect(firstPre).not.toBeNull();
  expect(getComputedStyle(firstBody).overflowX).toBe("auto");
  expect(getComputedStyle(firstPre).whiteSpace).toBe("pre");

  // mermaid 围栏作为普通代码块渲染，不作图
  const mermaidBlock = bubble.querySelector("[data-streamdown=\"code-block\"][data-language=\"mermaid\"]");
  expect(mermaidBlock).not.toBeNull();
  expect(mermaidBlock?.textContent).toContain("graph TD;");
  expect(mermaidBlock?.textContent).toContain("A-->B;");
  expect(bubble.querySelector("[data-streamdown=\"mermaid\"]")).toBeNull();
  expect(bubble.querySelector("[data-streamdown=\"mermaid-block\"]")).toBeNull();

  // 复制代码按钮工作正常
  const copyButtons = within(bubble).getAllByRole("button", { name: "复制代码" });
  expect(copyButtons).toHaveLength(2);
  await user.click(copyButtons[0]!);
  expect(writeText).toHaveBeenCalledWith(`${tsCode}\n`);
  expect(within(bubble).getByText("已复制")).toBeInTheDocument();
});

test("GFM 表格在气泡内渲染并支持横向滚动 (#63)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const tableBody = [
    "| 字段 | 类型 | 说明 | 示例值 |",
    "| --- | --- | --- | --- |",
    "| room_id | string | Topic 标识 | !abc123:example.com |",
    "| status | string | 当前状态 | confirmed |",
  ].join("\n");
  const ts = new Date(2026, 10, 12, 10, 5, 0).getTime();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                    { type: "m.room.create", state_key: "", origin_server_ts: ts, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "表格渲染话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$table-1",
                      sender: "@bot:example.com",
                      origin_server_ts: ts,
                      content: { msgtype: "m.text", body: tableBody },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    throw new Error(input.url);
  });

  const clock = new ManualClock();
  clock.now = ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "表格渲染话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const bubble = timeline.querySelector("[data-side=\"left\"] .waypoint-bubble") as HTMLElement;
  const table = within(bubble).getByRole("table");
  expect(table).toBeInTheDocument();
  expect(within(table).getAllByRole("columnheader").map((el) => el.textContent)).toEqual([
    "字段",
    "类型",
    "说明",
    "示例值",
  ]);
  expect(within(table).getByText("!abc123:example.com")).toBeInTheDocument();

  const wrapper = bubble.querySelector("[data-streamdown=\"table-wrapper\"]") as HTMLElement;
  expect(wrapper).not.toBeNull();
  const scrollContainer = wrapper.lastElementChild as HTMLElement;
  expect(scrollContainer).not.toBeNull();
  expect(getComputedStyle(scrollContainer).overflowX).toBe("auto");
});

test("成对单/双美元按公式排版，不成对美元保持原文，渲染失败显示源码且不折叠 (#63)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const ts = new Date(2026, 10, 12, 10, 10, 0).getTime();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
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
                    { type: "m.room.create", state_key: "", origin_server_ts: ts, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "公式渲染话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$math-paired",
                      sender: "@bot:example.com",
                      origin_server_ts: ts,
                      content: {
                        msgtype: "m.text",
                        body: "行内公式 $E = mc^2$ 与块级公式：\n\n$$\n\\int_0^1 x^2 \\, dx\n$$",
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$math-unpaired",
                      sender: "@bot:example.com",
                      origin_server_ts: ts + 1000,
                      content: {
                        msgtype: "m.text",
                        body: "价格是 $5，或者 $5 or $10，还有未闭合 $$a + b",
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$math-broken",
                      sender: "@bot:example.com",
                      origin_server_ts: ts + 2000,
                      content: {
                        msgtype: "m.text",
                        body: "坏公式：$$\\frac{1}{$$ 与 $\\noSuchLatexCmd$",
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    throw new Error(input.url);
  });

  const clock = new ManualClock();
  clock.now = ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "公式渲染话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const bubbles = Array.from(timeline.querySelectorAll(".waypoint-bubble")) as HTMLElement[];
  expect(bubbles).toHaveLength(3);

  // 1. 成对的单美元与双美元渲染为 KaTeX 公式
  const pairedBubble = bubbles[0]!;
  expect(pairedBubble.querySelectorAll(".katex")).toHaveLength(2);
  expect(pairedBubble.querySelector(".katex-display")).not.toBeNull();

  // 2. 不成对的美元保持原文
  const unpairedBubble = bubbles[1]!;
  expect(unpairedBubble.querySelector(".katex")).toBeNull();
  expect(unpairedBubble.textContent).toBe("价格是 $5，或者 $5 or $10，还有未闭合 $$a + b");

  // 3. 公式渲染失败时直接显示源码、不自动折叠
  const brokenBubble = bubbles[2]!;
  expect(brokenBubble.querySelector("details")).toBeNull();
  expect(brokenBubble.textContent).toContain("\\frac{1}{");
  expect(brokenBubble.textContent).toContain("\\noSuchLatexCmd");
  const errorEl = brokenBubble.querySelector(".katex-error") as HTMLElement | null;
  expect(errorEl).not.toBeNull();
  expect(errorEl?.textContent).toContain("\\frac{1}{");
});
