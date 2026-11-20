import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

test("两台设备时区不同时，同一批服务器时间戳按各自本地日历日显示不同日期分隔", async () => {
  const msg1Utc = Date.UTC(2026, 10, 11, 15, 0, 0); // Shanghai: Nov 11 23:00; New_York: Nov 11 10:00
  const msg2Utc = Date.UTC(2026, 10, 11, 17, 0, 0); // Shanghai: Nov 12 01:00; New_York: Nov 11 12:00
  const nowUtc = Date.UTC(2026, 10, 12, 6, 0, 0);   // Shanghai: Nov 12 14:00; New_York: Nov 12 01:00

  function makeHomeserver() {
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
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: msg1Utc, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "时区话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m1",
                        sender: "@bot:example.com",
                        origin_server_ts: msg1Utc,
                        content: { msgtype: "m.text", body: "第一条UTC消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m2",
                        sender: "@bot:example.com",
                        origin_server_ts: msg2Utc,
                        content: { msgtype: "m.text", body: "第二条UTC消息" },
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

  try {
    vi.stubEnv("TZ", "Asia/Shanghai");
    const userA = userEvent.setup();
    const clockA = new ManualClock();
    clockA.now = nowUtc;
    const viewA = render(
      <WaypointApp
        homeserver={makeHomeserver()}
        platform={{ deviceDisplayName: "Waypoint macOS" }}
        clock={clockA}
      />,
    );
    await login(userA);
    await userA.click(await screen.findByRole("button", { name: "时区话题" }));
    const timelineA = screen.getByRole("log", { name: "对话时间线" });
    const sepsA = timelineA.querySelectorAll('[role="separator"]');
    expect(sepsA).toHaveLength(1);
    expect(sepsA[0]).toHaveTextContent("今天");
    viewA.unmount();

    globalThis.indexedDB = new IDBFactory();
    vi.stubEnv("TZ", "America/New_York");
    const userB = userEvent.setup();
    const clockB = new ManualClock();
    clockB.now = nowUtc;
    const viewB = render(
      <WaypointApp
        homeserver={makeHomeserver()}
        platform={{ deviceDisplayName: "Waypoint Android" }}
        clock={clockB}
      />,
    );
    await login(userB);
    await userB.click(await screen.findByRole("button", { name: "时区话题" }));
    const timelineB = screen.getByRole("log", { name: "对话时间线" });
    expect(timelineB.querySelectorAll('[role="separator"]')).toHaveLength(0);
    viewB.unmount();
  } finally {
    vi.unstubAllEnvs();
  }
});

test("加入、邀请、改名、改 Description 不画成气泡；第三人消息不显示、不占左右也不参与分隔；绑定不合法只显示 Owner 靠右", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const day1Ts = new Date(2026, 10, 10, 10, 0, 0).getTime();
  const day2Ts = new Date(2026, 10, 11, 10, 0, 0).getTime();
  const day3Ts = new Date(2026, 10, 12, 10, 0, 0).getTime();

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
                    { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "干净时间线" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.member",
                      event_id: "$mem-invite",
                      state_key: "@bot:example.com",
                      sender: "@alice:example.com",
                      origin_server_ts: day1Ts,
                      content: { membership: "invite" },
                    },
                    {
                      type: "m.room.member",
                      event_id: "$mem-join",
                      state_key: "@bot:example.com",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts + 1000,
                      content: { membership: "join" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$owner-d1",
                      sender: "@alice:example.com",
                      origin_server_ts: day1Ts + 2000,
                      content: { msgtype: "m.text", body: "第一天的 Owner 消息" },
                    },
                    {
                      type: "m.room.name",
                      event_id: "$rename-d2",
                      state_key: "",
                      sender: "@alice:example.com",
                      origin_server_ts: day2Ts,
                      content: { name: "干净时间线" },
                    },
                    {
                      type: "m.room.topic",
                      event_id: "$retopic-d2",
                      state_key: "",
                      sender: "@alice:example.com",
                      origin_server_ts: day2Ts + 1000,
                      content: { topic: "不会画成气泡的Description" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$third-d2",
                      sender: "@intruder:example.com",
                      origin_server_ts: day2Ts + 2000,
                      content: { msgtype: "m.text", body: "第三人的跨日消息" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$agent-d1",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts + 5000,
                      content: { msgtype: "m.text", body: "同一天的 Agent 消息" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$third-d3",
                      sender: "@intruder:example.com",
                      origin_server_ts: day3Ts,
                      content: { msgtype: "m.text", body: "第三人今天的另一条" },
                    },
                  ],
                },
              },
              "!t-bad:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 2, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "无效绑定话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$bad-bot",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts,
                      content: { msgtype: "m.text", body: "无效绑定时不该显示的Bot消息" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$bad-owner",
                      sender: "@alice:example.com",
                      origin_server_ts: day2Ts,
                      content: { msgtype: "m.text", body: "无效绑定仍显示的Owner消息" },
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
  clock.now = day3Ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "干净时间线" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAttribute("data-side", "right");
  expect(rows[0]).toHaveTextContent("第一天的 Owner 消息");
  expect(rows[1]).toHaveAttribute("data-side", "left");
  expect(rows[1]).toHaveTextContent("同一天的 Agent 消息");

  expect(timeline).not.toHaveTextContent("不会画成气泡的Description");
  expect(timeline).not.toHaveTextContent("第三人的跨日消息");
  expect(timeline).not.toHaveTextContent("第三人今天的另一条");
  expect(timeline).not.toHaveTextContent(/invite|join|干净时间线/);
  expect(timeline.querySelectorAll('[role="separator"]')).toHaveLength(0);

  // 绑定不合法时不编名字，只显示 Owner 的消息靠右
  await user.click(await screen.findByRole("button", { name: "无效绑定话题" }));
  const badTimeline = screen.getByRole("log", { name: "对话时间线" });
  const badRows = badTimeline.querySelectorAll("[data-side]");
  expect(badRows).toHaveLength(1);
  expect(badRows[0]).toHaveAttribute("data-side", "right");
  expect(badRows[0]).toHaveTextContent("无效绑定仍显示的Owner消息");
  expect(badTimeline).not.toHaveTextContent("无效绑定时不该显示的Bot消息");
  expect(badTimeline.querySelectorAll('[role="separator"]')).toHaveLength(0);
});

test("落在仍由 Waypoint 管理的 Topic 里的 home 投递当作普通消息，不另建收件 Topic，也不发 /sethome", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  const day1Ts = new Date(2026, 10, 11, 9, 0, 0).getTime();
  const day2Ts = new Date(2026, 10, 12, 8, 0, 0).getTime();

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
                "!home-topic:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "日常助手" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$owner-1",
                        sender: "@alice:example.com",
                        origin_server_ts: day1Ts,
                        content: { msgtype: "m.text", body: "以后早报发这里" },
                      },
                    ],
                  },
                },
                "!legacy-dm:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                      { type: "m.room.name", state_key: "", content: { name: "旧私聊不应进列表" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$legacy-msg",
                        sender: "@bot:example.com",
                        origin_server_ts: day1Ts,
                        content: { msgtype: "m.text", body: "旧私聊消息" },
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
              "!home-topic:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$home-delivery",
                      sender: "@bot:example.com",
                      origin_server_ts: day2Ts,
                      content: { msgtype: "m.text", body: "今日早报：定时汇总已送达" },
                    },
                  ],
                },
              },
              "!legacy-dm:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$legacy-delivery",
                      sender: "@bot:example.com",
                      origin_server_ts: day2Ts,
                      content: { msgtype: "m.text", body: "旧房间投递不应出现" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const clock = new ManualClock();
  clock.now = day2Ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  expect(sidebar).toHaveTextContent("日常助手");
  expect(sidebar).not.toHaveTextContent("旧私聊不应进列表");
  expect(sidebar).not.toHaveTextContent(/收件|inbox/i);

  await user.click(screen.getByRole("button", { name: "日常助手" }));
  await act(async () => {
    clock.advance(1000);
  });

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  await waitFor(() => {
    expect(timeline).toHaveTextContent("今日早报：定时汇总已送达");
  });
  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAttribute("data-side", "right");
  expect(rows[1]).toHaveAttribute("data-side", "left");
  expect(rows[1]).toHaveTextContent("今日早报：定时汇总已送达");
  expect(timeline.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(timeline.querySelector('[role="separator"]')).toHaveTextContent("今天");

  expect(sidebar).toHaveTextContent("日常助手");
  expect(sidebar.querySelectorAll(".waypoint-topic-row")).toHaveLength(1);
  expect(homeserver.requests.some((req) => req.url.includes("/createRoom"))).toBe(false);
  expect(JSON.stringify(homeserver.requests)).not.toContain("/sethome");
});

test("文字草稿只留在这台设备：空或空白不保存，切走和重启后仍在，不进重试队列且另一台设备看不到", async () => {
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
                    { type: "m.room.name", state_key: "", content: { name: "草稿话题一" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "草稿话题二" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const device1 = renderApp(homeserver);
  await login(user);

  // 在话题一写文字草稿，在话题二写纯空白（不应保存）
  await user.click(await screen.findByRole("button", { name: "草稿话题一" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "只留在这台设备的文字");
  await user.click(screen.getByRole("button", { name: "草稿话题二" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "   \n  ");

  // 切回话题一再切回话题二：话题一保留，话题二空白输入未保存
  await user.click(screen.getByRole("button", { name: "草稿话题一" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("只留在这台设备的文字");
  await user.click(screen.getByRole("button", { name: "草稿话题二" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  // 前台同步推进也不触发草稿进入重试队列或同步给服务器
  await act(async () => {
    device1.clock.advance(1000);
  });
  expect(
    homeserver.requests.some(
      (r) =>
        r.url.includes("/send/") ||
        r.url.includes("/account_data/") ||
        r.url.includes("/createRoom"),
    ),
  ).toBe(false);

  // 重启这台设备后，话题一的文字草稿还在
  device1.unmount();
  const device1Restarted = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "草稿话题一" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("只留在这台设备的文字");
  await user.click(screen.getByRole("button", { name: "草稿话题二" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  // 确认没有进入重试队列或变成未确认气泡
  await user.click(screen.getByRole("button", { name: "草稿话题一" }));
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).not.toHaveTextContent("只留在这台设备的文字");
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();

  // 清空文字草稿并重启：已清空的草稿不再恢复
  await user.clear(screen.getByRole("textbox", { name: "输入消息" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "再留一句");
  await user.clear(screen.getByRole("textbox", { name: "输入消息" }));
  device1Restarted.unmount();

  const device1AfterClear = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "草稿话题一" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  // 重新写入一份草稿，再换一台设备（全新的 IndexedDB）登录同一账号：另一台设备看不到
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "设备一私密草稿");
  device1AfterClear.unmount();

  const device1Db = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    const device2 = renderApp(homeserver);
    await login(user);
    await user.click(await screen.findByRole("button", { name: "草稿话题一" }));
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
    device2.unmount();
  } finally {
    globalThis.indexedDB = device1Db;
  }
});

test("附件草稿至多一个、可无文字或图文共存，拿掉其一另一个还在，切走和重启后保留，另一台设备看不到且不进重试队列", async () => {
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
                    { type: "m.room.name", state_key: "", content: { name: "附件草稿话题一" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "附件草稿话题二" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const device1 = renderApp(homeserver);
  await login(user);

  // 1. 只有附件没有文字；再选第二个附件时只保留一个（至多一个）
  await user.click(await screen.findByRole("button", { name: "附件草稿话题一" }));
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File(["first-bytes"], "first.txt", { type: "text/plain" }),
  );
  const attachmentRegion = await screen.findByRole("region", { name: "已选附件" });
  expect(attachmentRegion).toHaveTextContent("first.txt");
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  await user.upload(
    screen.getByLabelText("选择附件"),
    new File(["png-bytes"], "second.png", { type: "image/png" }),
  );
  await waitFor(() => {
    expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("second.png");
  });
  expect(screen.getByRole("region", { name: "已选附件" })).not.toHaveTextContent("first.txt");

  // 2. 切走再回来还在
  await user.click(screen.getByRole("button", { name: "附件草稿话题二" }));
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "附件草稿话题一" }));
  expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("second.png");
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  // 3. 重启后只有附件的草稿还在
  device1.unmount();
  const device1Restarted = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "附件草稿话题一" }));
  expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("second.png");
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  // 4. 补写文字后拿掉附件，文字还在，且重启后仍保留文字
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "附件说明文字");
  await user.click(screen.getByRole("button", { name: "移除附件" }));
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("附件说明文字");

  await user.click(screen.getByRole("button", { name: "附件草稿话题二" }));
  await user.click(screen.getByRole("button", { name: "附件草稿话题一" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("附件说明文字");
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();

  device1Restarted.unmount();
  const device1AfterRemoveAttachment = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "附件草稿话题一" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("附件说明文字");
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();

  // 5. 再选上附件后拿掉文字，附件还在，且重启后仍在
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File(["pdf-bytes"], "third.pdf", { type: "application/pdf" }),
  );
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("third.pdf");
  await user.clear(screen.getByRole("textbox", { name: "输入消息" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("third.pdf");

  device1AfterRemoveAttachment.unmount();
  const device1AfterClearText = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "附件草稿话题一" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  expect(screen.getByRole("region", { name: "已选附件" })).toHaveTextContent("third.pdf");

  // 6. 移除最后一个附件变成空输入，重启后不再保留
  await user.click(screen.getByRole("button", { name: "移除附件" }));
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  device1AfterClearText.unmount();

  const device1Empty = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "附件草稿话题一" }));
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  // 7. 重写带附件草稿，确认不进重试队列且另一台设备看不到
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "仅本机图文");
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File(["bin"], "secret.bin", { type: "application/octet-stream" }),
  );
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("secret.bin");

  await act(async () => {
    device1Empty.clock.advance(1000);
  });
  expect(
    homeserver.requests.some(
      (r) =>
        r.url.includes("/send/") ||
        r.url.includes("/upload") ||
        r.url.includes("/account_data/") ||
        r.url.includes("/createRoom"),
    ),
  ).toBe(false);
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  device1Empty.unmount();

  const device1Db = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    const device2 = renderApp(homeserver);
    await login(user);
    await user.click(await screen.findByRole("button", { name: "附件草稿话题一" }));
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
    expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
    device2.unmount();
  } finally {
    globalThis.indexedDB = device1Db;
  }
});

test("点发送后等本地写入成功才离开输入区，服务器发送失败时不填回输入区且重启后草稿仍已清空", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let sendAttempts = 0;

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
                    { type: "m.room.name", state_key: "", content: { name: "写入时机话题" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "其他话题" } },
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
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return {
          type: "response",
          status: 500,
          body: { errcode: "M_UNKNOWN", error: "temporary server error" },
        };
      }
      return { type: "failure", failure: { type: "network" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "写入时机话题" }));

  const input = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(input, "必须落盘后才离开输入区");

  // 拦住 IndexedDB put 完成回调，模拟本地写入尚未完成
  const writeGate = deferred<void>();
  const origPut = IDBObjectStore.prototype.put;
  let putIntercepted = false;
  const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    const req = origPut.call(this, value, key);
    if (!putIntercepted) {
      putIntercepted = true;
      let userOnSuccess: ((this: IDBRequest<IDBValidKey>, ev: Event) => unknown) | null = null;
      let firedEvent: Event | null = null;
      Object.defineProperty(req, "onsuccess", {
        configurable: true,
        get() {
          return null;
        },
        set(fn) {
          userOnSuccess = fn;
        },
      });
      req.addEventListener("success", (ev) => {
        firedEvent = ev;
        void writeGate.promise.then(() => {
          userOnSuccess?.call(req, firedEvent!);
        });
      });
    }
    return req;
  });

  try {
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(putIntercepted).toBe(true);
    });
    // 本地写入完成前，内容仍在输入区，不进入时间线也不发请求
    expect(input).toHaveValue("必须落盘后才离开输入区");
    expect(screen.getByRole("log", { name: "对话时间线" })).not.toHaveTextContent(
      "必须落盘后才离开输入区",
    );
    expect(homeserver.requests.some((r) => r.url.includes("/send/"))).toBe(false);

    // 放行本地写入
    await act(async () => {
      writeGate.resolve();
    });
  } finally {
    putSpy.mockRestore();
  }

  // 本地写入成功后内容离开输入区，进入时间线并触发发送
  await waitFor(() => {
    expect(input).toHaveValue("");
  });
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("必须落盘后才离开输入区");

  await waitFor(() => {
    expect(sendAttempts).toBe(1);
  });
  // 服务器返回 500 失败后，不把内容填回输入区
  expect(input).toHaveValue("");

  // 退避重试网络失败后，仍不把内容填回输入区
  await act(async () => {
    first.clock.advance(1000);
  });
  await waitFor(() => {
    expect(sendAttempts).toBe(2);
  });
  expect(input).toHaveValue("");

  // 切走再回来、以及重启后，输入区仍为空（已清除的草稿不会复活）
  await user.click(screen.getByRole("button", { name: "其他话题" }));
  await user.click(screen.getByRole("button", { name: "写入时机话题" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");

  first.unmount();
  const restarted = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "写入时机话题" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  restarted.unmount();
});

test("断线后保留同步游标，只有服务器不认游标时才丢掉并做不带游标的合并同步而不清空本地时间线与队列", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncStage = 0;
  let allowSend = false;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncStage += 1;
      if (syncStage === 1) {
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
                      { type: "m.room.name", state_key: "", content: { name: "游标恢复话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-old",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "更早的本地消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$ev-overlap",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "重叠消息旧版" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (syncStage === 2) {
        expect(input.url).toContain("since=batch-1");
        return { type: "failure", failure: { type: "network" } };
      }
      if (syncStage === 3) {
        expect(input.url).toContain("since=batch-1");
        return {
          type: "response",
          status: 502,
          body: { errcode: "M_UNKNOWN", error: "Bad gateway" },
        };
      }
      if (syncStage === 4) {
        expect(input.url).toContain("since=batch-1");
        return {
          type: "response",
          status: 429,
          body: { errcode: "M_LIMIT_EXCEEDED", error: "Too fast" },
        };
      }
      if (syncStage === 5) {
        expect(input.url).toContain("since=batch-1");
        return {
          type: "response",
          status: 400,
          body: { errcode: "M_UNKNOWN", error: "Invalid since token" },
        };
      }
      if (syncStage === 6) {
        expect(input.url).toBe("https://matrix.example.com/_matrix/client/v3/sync");
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-recovered",
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "游标恢复话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-overlap",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "重叠消息新版" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$ev-new",
                        sender: "@bot:example.com",
                        origin_server_ts: 4000,
                        content: { msgtype: "m.text", body: "错过的消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      expect(input.url).toContain("since=batch-recovered");
      return { type: "response", status: 200, body: { next_batch: "batch-recovered-2" } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      if (!allowSend) {
        return { type: "failure", failure: { type: "network" } };
      }
      return { type: "response", status: 200, body: { event_id: "$ev-sent" } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "游标恢复话题" }));

  // 交出一条未确认消息，保持在重试队列里
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "队列里的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("status", { name: "未确认" })).toBeInTheDocument();

  // 第2轮：网络错误（保留游标）
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncStage).toBe(2));

  // 第3轮：502 M_UNKNOWN（保留游标）
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncStage).toBe(3));

  // 第4轮：429（保留游标）
  await act(async () => { clock.advance(2000); });
  await waitFor(() => expect(syncStage).toBe(4));

  // 第5轮：400 M_UNKNOWN 拒绝游标 -> 立即发起第6轮不带游标的同步
  await act(async () => { clock.advance(4000); });
  await waitFor(() => expect(syncStage).toBeGreaterThanOrEqual(6));

  // 已有本地时间线保留、重叠事件按 event_id 合并、新事件追加、队列仍在
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("更早的本地消息");
  expect(timeline).toHaveTextContent("重叠消息新版");
  expect(timeline).not.toHaveTextContent("重叠消息旧版");
  expect(timeline).toHaveTextContent("错过的消息");
  expect(timeline).toHaveTextContent("队列里的消息");
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(4);
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

  // 没有重新登录
  expect(homeserver.requests.filter((r) => r.method === "POST" && r.url.endsWith("/_matrix/client/v3/login"))).toHaveLength(1);

  // 后续同步携带新游标，且重试队列恢复后仍能确认原消息
  allowSend = true;
  await act(async () => { clock.advance(30000); });
  await waitFor(() => {
    expect(syncStage).toBeGreaterThanOrEqual(7);
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
});

test("limited 缺口先记着不在后台补完且列表照常更新，每房间每轮同步最多处理 20 条时间线事件", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  let topicOpened = false;

  function makeMessages(start: number, count: number, baseTs: number) {
    return Array.from({ length: count }, (_, idx) => {
      const n = start + idx;
      return {
        type: "m.room.message",
        event_id: `$msg-${n}`,
        sender: "@bot:example.com",
        origin_server_ts: baseTs + idx * 1000,
        content: { msgtype: "m.text", body: `消息-${n}` },
      };
    });
  }

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/messages")) {
      if (!topicOpened) {
        throw new Error(`不应在后台拉取历史消息：${input.url}`);
      }
      return {
        type: "response",
        status: 500,
        body: { errcode: "M_UNKNOWN", error: "temporary messages failure" },
      };
    }
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
                      { type: "m.room.name", state_key: "", content: { name: "话题一" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$msg-0",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "初始消息" },
                      },
                    ],
                  },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 5000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题二" } },
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
                "!t1:example.com": {
                  timeline: {
                    limited: true,
                    prev_batch: "pb-gap-1",
                    events: makeMessages(1, 25, 10_000),
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
                    limited: false,
                    events: makeMessages(26, 5, 40_000),
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

  const topicTitles = () =>
    Array.from(document.querySelectorAll(".waypoint-topic-row-title")).map((el) => el.textContent);

  await waitFor(() => expect(topicTitles()).toEqual(["话题二", "话题一"]));

  // 第 2 轮同步带来 limited: true 与 25 条事件：列表照常重排，后台不补齐缺口，本轮最多处理 20 条
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(2));
  await waitFor(() => expect(topicTitles()).toEqual(["话题一", "话题二"]));
  expect(homeserver.requests.some((r) => r.url.includes("/messages"))).toBe(false);

  topicOpened = true;
  await user.click(screen.getByRole("button", { name: "话题一" }));
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(21); // 初始 1 条 + 本轮最多 20 条
  const bubblesAfterRound2 = Array.from(timeline.querySelectorAll(".waypoint-bubble")).map(
    (el) => el.textContent,
  );
  expect(bubblesAfterRound2[0]).toBe("初始消息");
  for (let i = 1; i <= 5; i += 1) {
    expect(bubblesAfterRound2).not.toContain(`消息-${i}`);
  }
  expect(bubblesAfterRound2).toContain("消息-6");
  expect(bubblesAfterRound2).toContain("消息-25");

  // 第 3 轮再带来 5 条增量事件：追加到现有时间线（非全量上限 20）
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(3));
  await waitFor(() => expect(timeline.querySelectorAll("[data-side]")).toHaveLength(26));
  expect(timeline).toHaveTextContent("消息-26");
  expect(timeline).toHaveTextContent("消息-30");

  // 打开后因已读在缺口前触发一次补页；失败止损后等待一段时间也不会重复循环发 /messages
  await waitFor(() => {
    expect(homeserver.requests.filter((r) => r.url.includes("/messages"))).toHaveLength(1);
  });
  await act(async () => { clock.advance(10_000); });
  expect(homeserver.requests.filter((r) => r.url.includes("/messages"))).toHaveLength(1);
});

test("限流留在重试队列退避后再试，其他 4xx 不进入自动重试", async () => {
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
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "限流与4xx话题" } },
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
          status: 429,
          body: { errcode: "M_LIMIT_EXCEEDED", error: "Slow down" },
        };
      }
      if (sendCount === 2) {
        return {
          type: "response",
          status: 429,
          body: { errcode: "M_LIMIT_EXCEEDED", error: "Still slow" },
        };
      }
      if (sendCount === 3) {
        return { type: "response", status: 200, body: { event_id: "$ev-rate-ok" } };
      }
      return {
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Not allowed" },
      };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "限流与4xx话题" }));

  // 1) 限流：第 1 次 429 后退避 1s，第 2 次 429 后退避 2s，第 3 次成功
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "被限流的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sendCount).toBe(1));
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

  await act(async () => { clock.advance(999); });
  expect(sendCount).toBe(1);
  await act(async () => { clock.advance(1); });
  await waitFor(() => expect(sendCount).toBe(2));

  await act(async () => { clock.advance(1999); });
  expect(sendCount).toBe(2);
  await act(async () => { clock.advance(1); });
  await waitFor(() => expect(sendCount).toBe(3));
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });

  // 2) 其他 4xx (403)：不自动重试
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "被永久拒绝的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sendCount).toBe(4));

  await act(async () => { clock.advance(60_000); });
  expect(sendCount).toBe(4);
});

test("服务器不认 token 时暂停同步和重试队列，不丢队列也不清空本地时间线", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendCalls = 0;
  const rejectTokenOnSend = true;

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
                      { type: "m.room.name", state_key: "", content: { name: "Token失效话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-hist",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
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
      return {
        type: "response",
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", error: "Unknown access token" },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendCalls += 1;
      if (rejectTokenOnSend) {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Unknown access token" },
        };
      }
      return { type: "response", status: 200, body: { event_id: "$ev-sent" } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "Token失效话题" }));

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "暂停在队列的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sendCalls).toBeGreaterThanOrEqual(1));

  // 不切回密码页，不清空本地时间线与未确认气泡，且已停止后续同步与重试
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("已有本地消息");
  expect(timeline).toHaveTextContent("暂停在队列的消息");
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

  const syncsAtPause = syncCalls;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    clock.advance(60_000);
  });
  expect(syncCalls).toBe(syncsAtPause);
  expect(sendCalls).toBe(1);
});

test("重新连上后同步立刻恢复，重试队列按交出顺序重放且不等这一轮同步做完", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let offline = false;
  let holdReconnectSync = false;
  const reconnectSync = deferred<TransportResult>();
  const sentBodies: string[] = [];

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
                      { type: "m.room.name", state_key: "", content: { name: "重连重放话题" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (offline) {
        return { type: "failure", failure: { type: "network" } };
      }
      if (holdReconnectSync) {
        holdReconnectSync = false;
        return reconnectSync.promise;
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncCalls}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      if (offline) {
        return { type: "failure", failure: { type: "network" } };
      }
      const body = (input.body as { body: string }).body;
      sentBodies.push(body);
      return { type: "response", status: 200, body: { event_id: `$ev-${sentBodies.length}` } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "重连重放话题" }));

  // 断线：同步与队列都进入退避等待
  offline = true;
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncCalls).toBe(2));

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第一条");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getAllByRole("status", { name: "未确认" })).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第二条");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getAllByRole("status", { name: "未确认" })).toHaveLength(2));

  // 推进 1s 让队列再失败一次，进入 2s 退避等待
  await act(async () => { clock.advance(1000); });
  const syncsBeforeReconnect = syncCalls;

  // 重新连上：但让这一轮同步挂起不返回，验证同步立刻发出、队列立刻按序重放且不等同步做完
  offline = false;
  holdReconnectSync = true;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });

  await waitFor(() => {
    expect(syncCalls).toBe(syncsBeforeReconnect + 1);
    expect(sentBodies).toEqual(["第一条", "第二条"]);
  });
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });

  // 随后同步完成
  await act(async () => {
    reconnectSync.resolve({ type: "response", status: 200, body: { next_batch: "batch-after" } });
  });
});

test("进程被回收后重新打开，恢复凭证、游标、本地时间线与重试队列，增量同步同时按序重放且不等初始同步做完", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let offline = false;
  let holdRestartSync = false;
  const restartSync = deferred<TransportResult>();
  const replayedTxns: Array<{ body: string; txnId: string }> = [];
  const offlineTxns: Array<{ body: string; txnId: string }> = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      if (holdRestartSync) {
        expect(input.url).toBe("https://matrix.example.com/_matrix/client/v3/sync?since=batch-1");
        expect(input.headers?.Authorization).toBe("Bearer tok-1");
        holdRestartSync = false;
        return restartSync.promise;
      }
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
                    { type: "m.room.name", state_key: "", content: { name: "进程回收恢复话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$ev-hist",
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
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      const txnId = decodeURIComponent(input.url.split("/").pop() ?? "");
      const body = (input.body as { body: string }).body;
      if (offline) {
        offlineTxns.push({ body, txnId });
        return { type: "failure", failure: { type: "network" } };
      }
      replayedTxns.push({ body, txnId });
      return { type: "response", status: 200, body: { event_id: `$ev-replay-${replayedTxns.length}` } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "进程回收恢复话题" }));

  offline = true;
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "离线第一条");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "离线第二条");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(offlineTxns.length).toBeGreaterThanOrEqual(1));
  await waitFor(() => expect(screen.getAllByRole("status", { name: "未确认" })).toHaveLength(2));

  // 模拟进程被系统回收
  first.unmount();

  // 重新打开且网络恢复，但让重启后的增量 /sync 挂起不返回
  offline = false;
  holdRestartSync = true;
  renderApp(homeserver);

  // 不等初始 /sync 做完，重启后的重试队列已按原顺序、用原 txnId 重放
  await waitFor(() => {
    expect(replayedTxns.map((item) => item.body)).toEqual(["离线第一条", "离线第二条"]);
  });
  expect(replayedTxns[0].txnId).toBe(offlineTxns[0].txnId);
  expect(homeserver.requests.filter((r) => r.method === "POST" && r.url.endsWith("/_matrix/client/v3/login"))).toHaveLength(1);

  // 初始增量 /sync 随后带回回声：收成各自单一气泡，本地历史也在
  await act(async () => {
    restartSync.resolve({
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
                    event_id: "$ev-replay-1",
                    sender: "@alice:example.com",
                    origin_server_ts: 5000,
                    content: { msgtype: "m.text", body: "离线第一条" },
                    unsigned: { transaction_id: replayedTxns[0].txnId },
                  },
                  {
                    type: "m.room.message",
                    event_id: "$ev-replay-2",
                    sender: "@alice:example.com",
                    origin_server_ts: 6000,
                    content: { msgtype: "m.text", body: "离线第二条" },
                    unsigned: { transaction_id: replayedTxns[1].txnId },
                  },
                ],
              },
            },
          },
        },
      },
    });
  });

  await user.click(await screen.findByRole("button", { name: "进程回收恢复话题" }));
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(3);
  expect(timeline).toHaveTextContent("本地历史消息");
  expect(timeline).toHaveTextContent("离线第一条");
  expect(timeline).toHaveTextContent("离线第二条");
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
});

test("同步从断线退避中恢复时立刻唤醒处于退避中的重试队列，且重启后游标被拒绝时保留本地时间线合并同步", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendCalls = 0;
  let offline = false;
  let rejectCursorOnce = false;

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
                      { type: "m.room.name", state_key: "", content: { name: "退避唤醒话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-base",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "已有历史" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (rejectCursorOnce && input.url.includes("since=batch-1")) {
        rejectCursorOnce = false;
        return {
          type: "response",
          status: 400,
          body: { errcode: "M_INVALID_PARAM", error: "Unknown since token" },
        };
      }
      if (offline) {
        return { type: "failure", failure: { type: "network" } };
      }
      if (!input.url.includes("since=")) {
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
                        event_id: "$ev-after-gap",
                        sender: "@bot:example.com",
                        origin_server_ts: 9000,
                        content: { msgtype: "m.text", body: "游标失效后补到的消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: "batch-1" } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendCalls += 1;
      if (offline) {
        return { type: "failure", failure: { type: "network" } };
      }
      return { type: "response", status: 200, body: { event_id: `$ev-send-${sendCalls}` } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "退避唤醒话题" }));

  // 断网后交出消息并使其退避到 4s（1s + 2s 已用完，下一次原本要等 4s）
  offline = true;
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "退避中的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sendCalls).toBe(1));
  await act(async () => { first.clock.advance(1000); });
  await waitFor(() => expect(sendCalls).toBe(2));
  await act(async () => { first.clock.advance(2000); });
  await waitFor(() => expect(sendCalls).toBe(3));
  // 此刻队列已进入 4000ms 退避（t=7000 触发），而同步在 t=5000 触发并恢复成功
  offline = false;
  await act(async () => { first.clock.advance(2000); });
  await waitFor(() => {
    expect(sendCalls).toBe(4);
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });

  // 重启后若服务器拒绝旧游标，只丢游标并合并新消息，原有本地历史仍保留
  first.unmount();
  rejectCursorOnce = true;
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "退避唤醒话题" }));
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("已有历史");
  expect(timeline).toHaveTextContent("退避中的消息");
  expect(timeline).toHaveTextContent("游标失效后补到的消息");
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(3);
});

test("m.replace 编辑就地更新同一条气泡、去掉末尾光标、不画回退星号气泡，且不改变原消息的本地日与日期分隔", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  const day1Ts = new Date(2026, 10, 10, 9, 0, 0).getTime();
  const day2Ts = new Date(2026, 10, 11, 10, 0, 0).getTime();
  const day3Ts = new Date(2026, 10, 12, 11, 0, 0).getTime();

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
                      { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "编辑就地更新" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$bot-d1",
                        sender: "@bot:example.com",
                        origin_server_ts: day1Ts,
                        content: { msgtype: "m.text", body: "初始流式输出 ▉" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$owner-d2",
                        sender: "@alice:example.com",
                        origin_server_ts: day2Ts,
                        content: { msgtype: "m.text", body: "昨天的提问" },
                      },
                    ],
                  },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: day2Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "较新活跃话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$t2-msg",
                        sender: "@bot:example.com",
                        origin_server_ts: day2Ts + 60_000,
                        content: { msgtype: "m.text", body: "第二条话题消息" },
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
                        event_id: "$edit-1",
                        sender: "@bot:example.com",
                        origin_server_ts: day3Ts,
                        content: {
                          msgtype: "m.text",
                          body: "* 第一版替换 ▉",
                          "m.new_content": { msgtype: "m.text", body: "第一版替换 ▉" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$bot-d1" },
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$edit-forged",
                        sender: "@alice:example.com",
                        origin_server_ts: day3Ts + 1000,
                        content: {
                          msgtype: "m.text",
                          body: "* 冒充他人编辑",
                          "m.new_content": { msgtype: "m.text", body: "冒充他人编辑" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$bot-d1" },
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$edit-2",
                        sender: "@bot:example.com",
                        origin_server_ts: day3Ts + 2000,
                        content: {
                          msgtype: "m.text",
                          body: "* 最终替换内容（含内嵌▉符号） ▉",
                          "m.new_content": { body: "最终替换内容（含内嵌▉符号） ▉" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$bot-d1" },
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
      return {
        type: "response",
        status: 200,
        body: { next_batch: `batch-${syncCalls}` },
      };
    }
    throw new Error(input.url);
  });

  const clock = new ManualClock();
  clock.now = day3Ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "编辑就地更新" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(2);
  expect(timeline.querySelectorAll("[data-side]")[0]).toHaveTextContent("初始流式输出");
  expect(timeline).not.toHaveTextContent("▉");

  await act(async () => {
    clock.advance(1000);
  });

  await waitFor(() => {
    expect(timeline).toHaveTextContent("最终替换内容（含内嵌▉符号）");
  });

  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAttribute("data-side", "left");
  expect(rows[0].textContent).toBe("最终替换内容（含内嵌▉符号）");
  expect(rows[1]).toHaveAttribute("data-side", "right");
  expect(rows[1]).toHaveTextContent("昨天的提问");
  expect(timeline).not.toHaveTextContent("* ");
  expect(timeline).not.toHaveTextContent("冒充他人编辑");
  expect(timeline).not.toHaveTextContent("第一版替换");

  // 编辑发生在第 3 天，但不改变第 1 天消息的本地日与日期分隔，也不改 Topic 排序
  const separators = timeline.querySelectorAll('[role="separator"]');
  expect(separators).toHaveLength(1);
  expect(separators[0]).toHaveTextContent("昨天");

  const topicButtons = screen
    .getByRole("complementary", { name: "Topic 列表" })
    .querySelectorAll(".waypoint-topic-row");
  expect(topicButtons[0]).toHaveTextContent("较新活跃话题");
  expect(topicButtons[1]).toHaveTextContent("编辑就地更新");
});

test("m.room.redaction 撤回事件后从时间线与本机离线时间线消失，并同步更新日期分隔与被撤回的编辑", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  const day1Ts = new Date(2026, 10, 10, 9, 0, 0).getTime();
  const day2Ts = new Date(2026, 10, 11, 10, 0, 0).getTime();
  const day3Ts = new Date(2026, 10, 12, 11, 0, 0).getTime();

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
                      { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "撤回测试话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m1",
                        sender: "@bot:example.com",
                        origin_server_ts: day1Ts,
                        content: { msgtype: "m.text", body: "第1天保留消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m2",
                        sender: "@alice:example.com",
                        origin_server_ts: day2Ts,
                        content: { msgtype: "m.text", body: "第2天将被撤回的消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m3",
                        sender: "@bot:example.com",
                        origin_server_ts: day2Ts + 1000,
                        content: { msgtype: "m.text", body: "编辑前的原始文本" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m3-edit",
                        sender: "@bot:example.com",
                        origin_server_ts: day2Ts + 2000,
                        content: {
                          msgtype: "m.text",
                          body: "* 被改写后的文本",
                          "m.new_content": { msgtype: "m.text", body: "被改写后的文本" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$m3" },
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m4",
                        sender: "@bot:example.com",
                        origin_server_ts: day3Ts,
                        content: { msgtype: "m.text", body: "第3天将被撤回的消息" },
                      },
                    ],
                  },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: day2Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "另一条话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$t2-msg",
                        sender: "@bot:example.com",
                        origin_server_ts: day2Ts + 60_000,
                        content: { msgtype: "m.text", body: "另一条话题的较新消息" },
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
                        type: "m.room.redaction",
                        event_id: "$red-m4",
                        sender: "@bot:example.com",
                        origin_server_ts: day3Ts + 1000,
                        redacts: "$m4",
                        content: {},
                      },
                      {
                        type: "m.room.redaction",
                        event_id: "$red-m2",
                        sender: "@alice:example.com",
                        origin_server_ts: day3Ts + 2000,
                        content: { redacts: "$m2" },
                      },
                      {
                        type: "m.room.redaction",
                        event_id: "$red-m3-edit",
                        sender: "@bot:example.com",
                        origin_server_ts: day3Ts + 3000,
                        content: { redacts: "$m3-edit" },
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
        body: { next_batch: `batch-${syncCalls}` },
      };
    }
    throw new Error(input.url);
  });

  const clock = new ManualClock();
  clock.now = day3Ts;
  const first = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "撤回测试话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("第3天将被撤回的消息");
  expect(timeline).toHaveTextContent("第2天将被撤回的消息");
  expect(timeline).toHaveTextContent("被改写后的文本");
  expect(timeline.querySelectorAll('[role="separator"]')).toHaveLength(2);

  await act(async () => {
    clock.advance(1000);
  });

  await waitFor(() => {
    expect(timeline).not.toHaveTextContent("第3天将被撤回的消息");
  });

  expect(timeline).not.toHaveTextContent("第2天将被撤回的消息");
  expect(timeline).toHaveTextContent("第1天保留消息");
  expect(timeline).toHaveTextContent("编辑前的原始文本");
  expect(timeline).not.toHaveTextContent("被改写后的文本");

  const separators = timeline.querySelectorAll('[role="separator"]');
  expect(separators).toHaveLength(1);
  expect(separators[0]).toHaveTextContent("昨天");

  const topicButtons = screen
    .getByRole("complementary", { name: "Topic 列表" })
    .querySelectorAll(".waypoint-topic-row");
  expect(topicButtons[0]).toHaveTextContent("另一条话题");
  expect(topicButtons[1]).toHaveTextContent("撤回测试话题");

  // 重新打开应用（增量同步不再包含历史），确认被撤回的事件从这台设备的本地时间线里也已移除
  first.unmount();
  const clock2 = new ManualClock();
  clock2.now = day3Ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock2}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "撤回测试话题" }));
  const reloadedTimeline = screen.getByRole("log", { name: "对话时间线" });
  expect(reloadedTimeline).toHaveTextContent("第1天保留消息");
  expect(reloadedTimeline).toHaveTextContent("编辑前的原始文本");
  expect(reloadedTimeline).not.toHaveTextContent("第3天将被撤回的消息");
  expect(reloadedTimeline).not.toHaveTextContent("第2天将被撤回的消息");
  expect(reloadedTimeline).not.toHaveTextContent("被改写后的文本");
});

test("没有续片关系的多条 Agent 分片不合并，带 m.thread 关系的事件按时间排进同一 Topic 且不另画线程", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const baseTs = new Date(2026, 10, 12, 10, 0, 0).getTime();

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
                    { type: "m.room.create", state_key: "", origin_server_ts: baseTs, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "分片与线程话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$chunk-1",
                      sender: "@bot:example.com",
                      origin_server_ts: baseTs + 1000,
                      content: { msgtype: "m.text", body: "第一片长回复" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$chunk-2",
                      sender: "@bot:example.com",
                      origin_server_ts: baseTs + 1010,
                      content: { msgtype: "m.text", body: "紧接的第二片回复" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$owner-plain",
                      sender: "@alice:example.com",
                      origin_server_ts: baseTs + 2000,
                      content: { msgtype: "m.text", body: "主时间线追问" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$thread-bot",
                      sender: "@bot:example.com",
                      origin_server_ts: baseTs + 3000,
                      content: {
                        msgtype: "m.text",
                        body: "线程里的 Bot 回复",
                        "m.relates_to": {
                          rel_type: "m.thread",
                          event_id: "$chunk-1",
                          is_falling_back: true,
                          "m.in_reply_to": { event_id: "$chunk-1" },
                        },
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$thread-owner",
                      sender: "@alice:example.com",
                      origin_server_ts: baseTs + 4000,
                      content: {
                        msgtype: "m.text",
                        body: "线程里的 Owner 回复",
                        "m.relates_to": {
                          rel_type: "m.thread",
                          event_id: "$chunk-1",
                          is_falling_back: true,
                          "m.in_reply_to": { event_id: "$thread-bot" },
                        },
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
  clock.now = baseTs + 5000;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "分片与线程话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(5);
  expect(rows[0]).toHaveAttribute("data-side", "left");
  expect(rows[0].textContent).toBe("第一片长回复");
  expect(rows[1]).toHaveAttribute("data-side", "left");
  expect(rows[1].textContent).toBe("紧接的第二片回复");
  expect(rows[2]).toHaveAttribute("data-side", "right");
  expect(rows[2].textContent).toBe("主时间线追问");
  expect(rows[3]).toHaveAttribute("data-side", "left");
  expect(rows[3].textContent).toBe("线程里的 Bot 回复");
  expect(rows[4]).toHaveAttribute("data-side", "right");
  expect(rows[4].textContent).toBe("线程里的 Owner 回复");

  const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });
  expect(sidebar.querySelectorAll(".waypoint-topic-row")).toHaveLength(1);
});

test("Owner 停在底部时编辑跟着往下，已经上翻了就不把视口拉回去", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let mockScrollHeight = 800;
  const baseTs = new Date(2026, 10, 12, 10, 0, 0).getTime();

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
                      { type: "m.room.create", state_key: "", origin_server_ts: baseTs, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "滚动锚定话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$stream-1",
                        sender: "@bot:example.com",
                        origin_server_ts: baseTs,
                        content: { msgtype: "m.text", body: "第一版内容 ▉" },
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
        mockScrollHeight = 1100;
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
                        event_id: "$edit-2",
                        sender: "@bot:example.com",
                        origin_server_ts: baseTs + 1000,
                        content: {
                          msgtype: "m.text",
                          body: "* 第二版更长的内容 ▉",
                          "m.new_content": { msgtype: "m.text", body: "第二版更长的内容 ▉" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$stream-1" },
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
      if (syncCalls === 3) {
        mockScrollHeight = 1500;
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
                        type: "m.room.message",
                        event_id: "$edit-3",
                        sender: "@bot:example.com",
                        origin_server_ts: baseTs + 2000,
                        content: {
                          msgtype: "m.text",
                          body: "* 第三版超长内容 ▉",
                          "m.new_content": { msgtype: "m.text", body: "第三版超长内容 ▉" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$stream-1" },
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
      if (syncCalls === 4) {
        mockScrollHeight = 1700;
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-4",
            rooms: {
              join: {
                "!t1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$edit-4",
                        sender: "@bot:example.com",
                        origin_server_ts: baseTs + 3000,
                        content: {
                          msgtype: "m.text",
                          body: "* 第四版最终内容",
                          "m.new_content": { msgtype: "m.text", body: "第四版最终内容" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$stream-1" },
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
      return {
        type: "response",
        status: 200,
        body: { next_batch: `batch-${syncCalls}` },
      };
    }
    throw new Error(input.url);
  });

  const clock = new ManualClock();
  clock.now = baseTs + 4000;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "滚动锚定话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(timeline, "scrollHeight", {
    configurable: true,
    get: () => mockScrollHeight,
  });

  // Owner 停在底部
  timeline.scrollTop = 400;
  fireEvent.scroll(timeline);

  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(timeline).toHaveTextContent("第二版更长的内容");
  });
  expect(timeline.scrollTop).toBe(700);

  // Owner 向上翻看历史消息
  timeline.scrollTop = 180;
  fireEvent.scroll(timeline);

  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(timeline).toHaveTextContent("第三版超长内容");
  });
  expect(timeline.scrollTop).toBe(180);

  // Owner 再次回到底部后，后续编辑继续跟着往下
  timeline.scrollTop = 1100;
  fireEvent.scroll(timeline);

  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(timeline).toHaveTextContent("第四版最终内容");
  });
  expect(timeline.scrollTop).toBe(1300);
});

test("设置里有退出入口，点击后必须二次确认并说明清空本地时间线、未发送草稿和重试队列，取消不发送注销且保持已连接", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: validAgents,
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "设置" }));

  const exitButton = screen.getByRole("button", { name: "退出这台设备" });
  await user.click(exitButton);

  const confirmDialog = screen.getByRole("alertdialog", { name: "确认退出这台设备" });
  expect(confirmDialog).toHaveTextContent("本地时间线");
  expect(confirmDialog).toHaveTextContent("未发送草稿");
  expect(confirmDialog).toHaveTextContent("重试队列");
  expect(homeserver.requests.some((r) => r.url.includes("/logout"))).toBe(false);
  expect(screen.getByText("已连接")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog", { name: "确认退出这台设备" })).not.toBeInTheDocument();
  expect(homeserver.requests.some((r) => r.url.includes("/logout"))).toBe(false);
  expect(screen.getByText("已连接")).toBeInTheDocument();
});

test("确认退出后尽量注销（不删设备），清空 token、device id、同步游标、本地时间线、草稿与重试队列，停掉同步与重试并回到保留地址和用户标识的空密码步，重登从空白游标开始", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let logins = 0;
  let syncCalls = 0;
  let sendCalls = 0;
  let readMarkerCalls = 0;
  const syncUrls: string[] = [];

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
      logins += 1;
      return {
        type: "response",
        status: 200,
        body: {
          user_id: "@alice:example.com",
          access_token: `tok-${logins}`,
          device_id: `DEV${logins}`,
        },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      syncCalls += 1;
      syncUrls.push(input.url);
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
                    { type: "m.room.name", state_key: "", content: { name: "退出清理测试" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$srv-1",
                      sender: "@bot:example.com",
                      origin_server_ts: 1500,
                      content: { msgtype: "m.text", body: "服务端已有回复" },
                    },
                  ],
                },
              },
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "草稿话题" } },
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
      sendCalls += 1;
      return {
        type: "response",
        status: 500,
        body: { errcode: "M_UNKNOWN", error: "temporary server error" },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerCalls += 1;
      return {
        type: "response",
        status: 500,
        body: { errcode: "M_UNKNOWN", error: "temporary server error" },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };

  const first = renderApp(homeserver);
  await login(user);

  // 在 t1 发一条会进入重试队列的未确认消息
  await user.click(await screen.findByRole("button", { name: "退出清理测试" }));
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("服务端已有回复");
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "还在重试队列里的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(sendCalls).toBe(1);
  });
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("还在重试队列里的消息");

  // 在 t2 留下文字和附件草稿
  await user.click(screen.getByRole("button", { name: "草稿话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "未发送草稿文字");
  const draftFile = new File(["draft-bytes"], "notes.txt", { type: "text/plain" });
  await user.upload(screen.getByLabelText("选择附件"), draftFile);
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("notes.txt");

  // 打开设置并确认退出这台设备
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "退出这台设备" }));
  const requestsBeforeExit = homeserver.requests.length;
  await user.click(screen.getByRole("button", { name: "确认退出" }));

  // 回到保留地址和用户标识的密码步，密码为空，不再处于已连接
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();

  // 发送了 logout，且退出本身未删除设备、未退房、未删消息、未写已读位置或 account_data
  const logouts = homeserver.requests.filter((r) => r.url.endsWith("/_matrix/client/v3/logout"));
  expect(logouts).toHaveLength(1);
  expect(logouts[0]).toMatchObject({
    method: "POST",
    url: "https://matrix.example.com/_matrix/client/v3/logout",
    headers: { Authorization: "Bearer tok-1" },
  });
  const requestsSinceExit = homeserver.requests.slice(requestsBeforeExit);
  expect(
    requestsSinceExit.some(
      (r) =>
        r.url.includes("/devices") ||
        r.url.includes("/leave") ||
        r.url.includes("/forget") ||
        r.url.includes("/redact") ||
        r.url.includes("/read_markers") ||
        r.url.includes("/account_data"),
    ),
  ).toBe(false);

  // 停掉前台同步与重试定时器（含消息发送与已读标记重试）
  const syncsBeforeAdvance = syncCalls;
  const sendsBeforeAdvance = sendCalls;
  const readMarkersBeforeAdvance = readMarkerCalls;
  await act(async () => {
    first.clock.advance(60_000);
  });
  expect(syncCalls).toBe(syncsBeforeAdvance);
  expect(sendCalls).toBe(sendsBeforeAdvance);
  expect(readMarkerCalls).toBe(readMarkersBeforeAdvance);

  // 重启应用：直接停在保留地址和用户标识的空密码步，不发起同步
  first.unmount();
  const second = renderApp(homeserver);
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  expect(syncCalls).toBe(syncsBeforeAdvance);

  // 重新登录：同步游标已清空（首次同步不带 since），原未发送草稿与重试队列都已清空
  const syncCountBeforeRelogin = syncUrls.length;
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  await screen.findByRole("button", { name: "退出清理测试" });
  expect(readMarkerCalls).toBe(readMarkersBeforeAdvance);
  await user.click(screen.getByRole("button", { name: "退出清理测试" }));
  expect(syncUrls[syncCountBeforeRelogin]).toBe("https://matrix.example.com/_matrix/client/v3/sync");
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("服务端已有回复");
  expect(timeline).not.toHaveTextContent("还在重试队列里的消息");

  await user.click(screen.getByRole("button", { name: "草稿话题" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  expect(sendCalls).toBe(sendsBeforeAdvance);

  second.unmount();
});

test("退出这台设备时即使注销返回跨主机重定向、4xx、5xx、网络错误、超时或卡住也不阻塞且不跟随重定向，且不影响另一台设备的远端房间、已读位置与 Agent 记忆", async () => {
  const user = userEvent.setup();
  const logoutCases: Array<{ name: string; respond: () => Promise<TransportResult> }> = [
    {
      name: "302 跨主机重定向",
      respond: async () => ({
        type: "response",
        status: 302,
        body: { location: "https://evil.example.com/logout" },
      }),
    },
    {
      name: "403 拒绝",
      respond: async () => ({
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
      }),
    },
    {
      name: "500 错误",
      respond: async () => ({
        type: "response",
        status: 500,
        body: { errcode: "M_UNKNOWN", error: "Logout broken" },
      }),
    },
    {
      name: "网络错误",
      respond: async () => ({ type: "failure", failure: { type: "network" } }),
    },
    {
      name: "超时",
      respond: async () => ({ type: "failure", failure: { type: "timeout" } }),
    },
    {
      name: "无响应卡住",
      respond: () => new Promise<TransportResult>(() => {}),
    },
  ];

  for (const item of logoutCases) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    homeserver.handler = passwordLoginHandler(async (input) => {
      if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
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
                      { type: "m.room.name", state_key: "", content: { name: "远端话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m1",
                        sender: "@bot:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "Agent 记住的上下文" },
                      },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m1" } }],
                  },
                },
              },
            },
          },
        };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
        return item.respond();
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    });

    const first = renderApp(homeserver);
    await login(user);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "退出这台设备" }));
    await user.click(screen.getByRole("button", { name: "确认退出" }));

    expect(await screen.findByLabelText("密码")).toHaveValue("");
    expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
    expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();

    const logouts = homeserver.requests.filter((r) => r.url.endsWith("/_matrix/client/v3/logout"));
    expect(logouts).toHaveLength(1);
    expect(homeserver.requests.some((r) => r.url.includes("evil.example.com"))).toBe(false);
    expect(homeserver.requests.some((r) => r.url.includes("/devices"))).toBe(false);

    first.unmount();

    // 另一台设备登录同一账号，仍能看到远端房间和 Agent 回复（远端与另一台设备不受影响）
    globalThis.indexedDB = new IDBFactory();
    const device2 = renderApp(homeserver);
    await login(user);
    await user.click(await screen.findByRole("button", { name: "远端话题" }));
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("Agent 记住的上下文");
    device2.unmount();
  }
});

test("窄视口在设置里退出这台设备对齐历史栈，且还在路上的同步响应迟到后不能写回本地或拉回列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  const lateSync = deferred<TransportResult>();
  let pushCount = 0;
  let popCount = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: validAgents,
          },
        };
      }
      return lateSync.promise;
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const clock = new ManualClock();
  const view = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{
        deviceDisplayName: "Waypoint Android",
        viewportMode: () => "narrow",
        pushNavigationEntry: () => {
          pushCount += 1;
        },
        popNavigationEntry: () => {
          popCount += 1;
        },
      }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "设置" }));
  expect(pushCount).toBe(1);
  expect(popCount).toBe(0);

  // 触发一次前台增量同步，让其停在路上
  await act(async () => {
    clock.advance(1000);
  });
  expect(syncCalls).toBe(2);

  await user.click(screen.getByRole("button", { name: "退出这台设备" }));
  await user.click(screen.getByRole("button", { name: "确认退出" }));

  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(popCount).toBe(1);

  // 迟到的增量同步带着房间和 next_batch 到达，不能写回本地也不能拉回列表
  await act(async () => {
    lateSync.resolve({
      type: "response",
      status: 200,
      body: {
        next_batch: "batch-late",
        account_data: validAgents,
        rooms: {
          join: {
            "!late:example.com": {
              state: {
                events: [
                  { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                  { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                  { type: "m.room.name", state_key: "", content: { name: "迟到房间" } },
                ],
              },
              timeline: { events: [] },
            },
          },
        },
      },
    });
  });

  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();

  view.unmount();
  const restarted = renderApp(homeserver);
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.queryByText("迟到房间")).not.toBeInTheDocument();
  restarted.unmount();
});

test("列表按已读位置标出左侧实心圆点与加粗标题，忽略通知计数、marked unread、Hermes回执、Owner消息、reaction、编辑与撤回", async () => {
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
                "!unread-no-marker:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "未读无标记" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$u1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "第一条未读" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$u2",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "第二条未读" },
                      },
                    ],
                  },
                },
                "!read-but-noisy:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "已读含噪音" } },
                    ],
                  },
                  unread_notifications: { notification_count: 9, highlight_count: 3 },
                  account_data: {
                    events: [
                      { type: "m.fully_read", content: { event_id: "$r1" } },
                      { type: "m.marked_unread", content: { unread: true } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$r1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "已读消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$r-owner",
                        sender: "@alice:example.com",
                        origin_server_ts: 2100,
                        content: { msgtype: "m.text", body: "Owner 自己刚发出的" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$r-react",
                        sender: "@bot:example.com",
                        origin_server_ts: 2200,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$r1", key: "👀" } },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$r-edit",
                        sender: "@bot:example.com",
                        origin_server_ts: 2300,
                        content: {
                          msgtype: "m.text",
                          body: "* 改后",
                          "m.new_content": { msgtype: "m.text", body: "改后" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$r1" },
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$r-retracted",
                        sender: "@bot:example.com",
                        origin_server_ts: 2400,
                        content: { msgtype: "m.text", body: "将被撤回的消息" },
                      },
                      {
                        type: "m.room.redaction",
                        event_id: "$r-redaction",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        redacts: "$r-retracted",
                        content: {},
                      },
                    ],
                  },
                },
                "!hermes-receipt-only:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "Hermes回执不顶替Owner" } },
                    ],
                  },
                  ephemeral: {
                    events: [
                      {
                        type: "m.receipt",
                        content: {
                          "$h2": {
                            "m.read.private": { "@bot:example.com": { ts: 5000 } },
                            "m.read": { "@alice:example.com": { ts: 5000 } },
                          },
                        },
                      },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$h1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "早消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$h2",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "新消息" },
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

  const unreadRow = await screen.findByRole("button", { name: "未读无标记" });
  expect(unreadRow).toHaveAttribute("data-unread", "true");
  expect(unreadRow.querySelector(".waypoint-unread-dot")).not.toBeNull();
  const unreadNameEl = unreadRow.querySelector(".waypoint-topic-name");
  expect(unreadNameEl).toHaveClass("unread");
  const unreadRowClone = unreadRow.cloneNode(true) as HTMLElement;
  unreadRowClone.querySelectorAll(".waypoint-topic-row-time").forEach((el) => el.remove());
  expect(unreadRowClone.textContent ?? "").not.toContain("2");

  const noisyReadRow = screen.getByRole("button", { name: "已读含噪音" });
  expect(noisyReadRow).not.toHaveAttribute("data-unread", "true");
  expect(noisyReadRow.querySelector(".waypoint-unread-dot")).toBeNull();
  expect(noisyReadRow.querySelector(".waypoint-topic-name")).not.toHaveClass("unread");

  const hermesReceiptRow = screen.getByRole("button", { name: "Hermes回执不顶替Owner" });
  expect(hermesReceiptRow).toHaveAttribute("data-unread", "true");
  expect(hermesReceiptRow.querySelector(".waypoint-unread-dot")).not.toBeNull();

  // 停在列表不打开 Topic、即使后台又同步几轮，也不会前移已读位置或发 read_markers
  await act(async () => { clock.advance(3000); });
  expect(homeserver.requests.some((r) => r.url.includes("/read_markers"))).toBe(false);
  expect(unreadRow).toHaveAttribute("data-unread", "true");
});

test("已读位置按时间线顺序只往前走，两标记不一致取靠后者且不写回更早位置，位置不在本地时不标未读也不假装读完", async () => {
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
                "!order-conflict:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "时间线顺序话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$e-later-in-tl" } }],
                  },
                  ephemeral: {
                    events: [
                      {
                        type: "m.receipt",
                        content: {
                          "$e-earlier-in-tl": {
                            "m.read.private": { "@alice:example.com": { ts: 9500 } },
                          },
                        },
                      },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$e-earlier-in-tl",
                        sender: "@bot:example.com",
                        origin_server_ts: 9000,
                        content: { msgtype: "m.text", body: "时间线靠前但ts更大" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$e-later-in-tl",
                        sender: "@bot:example.com",
                        origin_server_ts: 1000,
                        content: { msgtype: "m.text", body: "时间线靠后但ts更小" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$e-newest",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "最新未读" },
                      },
                    ],
                  },
                },
                "!missing-anchor:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "锚点不在本地话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$not-in-local" } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m-local-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 5000,
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
      if (syncRound === 2) {
        // 另一台设备把 m.read.private 前移到了 $e-newest，即使 m.fully_read 还是旧的
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!order-conflict:example.com": {
                  ephemeral: {
                    events: [
                      {
                        type: "m.receipt",
                        content: {
                          "$e-newest": {
                            "m.read.private": { "@alice:example.com": { ts: 9900 } },
                          },
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
      if (syncRound === 3) {
        // 迟到/陈旧标记试图退回 $e-earlier-in-tl：绝不能倒退
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-3",
            rooms: {
              join: {
                "!order-conflict:example.com": {
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$e-earlier-in-tl" } }],
                  },
                  ephemeral: {
                    events: [
                      {
                        type: "m.receipt",
                        content: {
                          "$e-earlier-in-tl": {
                            "m.read.private": { "@alice:example.com": { ts: 9999 } },
                          },
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
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  const conflictRow = await screen.findByRole("button", { name: "时间线顺序话题" });
  expect(conflictRow).toHaveAttribute("data-unread", "true");
  expect(conflictRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "700" });

  // 位置不在本地时：不显示未读
  const missingRow = screen.getByRole("button", { name: "锚点不在本地话题" });
  expect(missingRow).not.toHaveAttribute("data-unread", "true");
  expect(missingRow.querySelector(".waypoint-unread-dot")).toBeNull();
  expect(missingRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "500" });

  // 打开锚点不在本地的 Topic：不能假装读完（不发 read_markers）
  await user.click(missingRow);
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("本地已有消息");
  expect(homeserver.requests.some((r) => r.url.includes("/read_markers"))).toBe(false);

  // 第 2 轮：另一台设备把 m.read.private 前移到 $e-newest -> 列表立刻变成已读，圆点消失，字重恢复
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(2));
  await waitFor(() => {
    expect(conflictRow).not.toHaveAttribute("data-unread", "true");
  });
  expect(conflictRow.querySelector(".waypoint-unread-dot")).toBeNull();
  expect(conflictRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "500" });

  // 第 3 轮：陈旧标记试图回退到 $e-earlier-in-tl -> 仍保持已读且不写回服务器
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(3));
  expect(conflictRow).not.toHaveAttribute("data-unread", "true");
  expect(homeserver.requests.some((r) => r.url.includes("/read_markers"))).toBe(false);
});

test("打开未读Topic停在第一条未读且仅把屏上可见消息标为已读，人已在内时不拉走视口，滚到最新才到最后一条，已读Topic打开停在最新", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

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
                "!t-unread:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "部分可见未读" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m1" } }],
                  },
                  timeline: {
                    events: [1, 2, 3, 4, 5].map((n) => ({
                      type: "m.room.message",
                      event_id: `$m${n}`,
                      sender: "@bot:example.com",
                      origin_server_ts: 1000 + n * 1000,
                      content: { msgtype: "m.text", body: `消息-${n}` },
                    })),
                  },
                },
                "!t-read:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 500, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "全部已读话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$r4" } }],
                  },
                  timeline: {
                    events: [1, 2, 3, 4].map((n) => ({
                      type: "m.room.message",
                      event_id: `$r${n}`,
                      sender: "@bot:example.com",
                      origin_server_ts: 500 + n * 100,
                      content: { msgtype: "m.text", body: `已读-${n}` },
                    })),
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
                "!t-unread:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m6",
                        sender: "@bot:example.com",
                        origin_server_ts: 7000,
                        content: { msgtype: "m.text", body: "消息-6" },
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
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 200, async () => {
    const { clock } = renderApp(homeserver);
    await login(user);

    const unreadRow = await screen.findByRole("button", { name: "部分可见未读" });
    expect(unreadRow).toHaveAttribute("data-unread", "true");

    // 1. 打开有未读的 Topic：停在第一条未读 $m2（scrollTop=100），不跳到底（300）
    await user.click(unreadRow);
    const timeline = screen.getByRole("log", { name: "对话时间线" });
    expect(timeline.scrollTop).toBe(100);

    // 视口 100..300 只显示了 $m2 和 $m3 -> 已读位置前移到 $m3，$m4/$m5 仍在下方未读
    await waitFor(() => {
      expect(readMarkerPosts).toEqual([
        {
          url: "https://matrix.example.com/_matrix/client/v3/rooms/!t-unread%3Aexample.com/read_markers",
          body: { "m.fully_read": "$m3", "m.read.private": "$m3" },
        },
      ]);
    });
    expect(unreadRow).toHaveAttribute("data-unread", "true");

    // 2. 人已经在 Topic 里，新消息 $m6 同步到达：不把视口拉走（scrollTop 仍为 100）
    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => expect(timeline).toHaveTextContent("消息-6"));
    expect(timeline.scrollTop).toBe(100);
    expect(readMarkerPosts).toHaveLength(1);
    expect(unreadRow).toHaveAttribute("data-unread", "true");

    // 3. 自己滚到最新（scrollTop=400，视口 400..600），上方 $m4 滚过去算读过，位置前移到 $m6
    await act(async () => {
      timeline.scrollTop = 400;
      timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitFor(() => {
      expect(readMarkerPosts).toHaveLength(2);
    });
    expect(readMarkerPosts[1]).toEqual({
      url: "https://matrix.example.com/_matrix/client/v3/rooms/!t-unread%3Aexample.com/read_markers",
      body: { "m.fully_read": "$m6", "m.read.private": "$m6" },
    });
    expect(unreadRow).not.toHaveAttribute("data-unread", "true");
    expect(unreadRow.querySelector(".waypoint-unread-dot")).toBeNull();

    // 4. 打开没有未读的 Topic：停在最新（scrollTop = 4*100 - 200 = 200）
    await user.click(screen.getByRole("button", { name: "全部已读话题" }));
    const readTimeline = screen.getByRole("log", { name: "对话时间线" });
    expect(readTimeline.scrollTop).toBe(200);
  });
});

test("已读标记写失败不回退已采纳位置、队列每条Topic只留最靠前一条、重启后重放且列表行不出现转圈或红叹号", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  let allowReadMarkers = false;
  const sentReadMarkers: Array<{ url: string; body: unknown }> = [];

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
                "!retry-rm:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "重试已读位置话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$rm1" } }],
                  },
                  timeline: {
                    events: [1, 2, 3, 4, 5].map((n) => ({
                      type: "m.room.message",
                      event_id: `$rm${n}`,
                      sender: "@bot:example.com",
                      origin_server_ts: 1000 + n * 1000,
                      content: { msgtype: "m.text", body: `消息-${n}` },
                    })),
                  },
                },
              },
            },
          },
        };
      }
      // 即使后续增量 /sync 还没收到新标记或带回旧标记，也不能把本地已采纳的更前位置打回去
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncRound}`,
          rooms: {
            join: {
              "!retry-rm:example.com": {
                account_data: {
                  events: [{ type: "m.fully_read", content: { event_id: "$rm1" } }],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      sentReadMarkers.push({ url: input.url, body: input.body });
      if (!allowReadMarkers) {
        return { type: "failure", failure: { type: "network" } };
      }
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 200, async () => {
    const first = renderApp(homeserver);
    await login(user);

    const row = await screen.findByRole("button", { name: "重试已读位置话题" });
    expect(row).toHaveAttribute("data-unread", "true");

    // 打开停在 $rm2，屏上看到 $rm2、$rm3 -> 尝试写 $rm3 但失败
    await user.click(row);
    const timeline = screen.getByRole("log", { name: "对话时间线" });
    await waitFor(() => expect(sentReadMarkers).toHaveLength(1));
    expect(sentReadMarkers[0].body).toEqual({ "m.fully_read": "$rm3", "m.read.private": "$rm3" });

    // 列表行绝不出现转圈或红叹号
    expect(row.querySelector("[role=\"status\"]")).toBeNull();
    expect(row).not.toHaveTextContent("!");

    // 趁队列还在退避时滚到底部看到 $rm5 -> 队列里只保留更靠前的 $rm5，且不回退已采纳位置
    await act(async () => {
      timeline.scrollTop = 300;
      timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitFor(() => expect(sentReadMarkers.length).toBeGreaterThanOrEqual(2));
    expect(sentReadMarkers[sentReadMarkers.length - 1].body).toEqual({
      "m.fully_read": "$rm5",
      "m.read.private": "$rm5",
    });
    expect(row).not.toHaveAttribute("data-unread", "true");
    expect(row.querySelector("[role=\"status\"]")).toBeNull();
    expect(row).not.toHaveTextContent("!");

    // 即使服务器在下一轮同步带回旧的 $rm1，也不回退到本地未读
    await advanceWhenTimerScheduled(first.clock, 1000);
    expect(row).not.toHaveAttribute("data-unread", "true");

    // 模拟进程重启，网络恢复：只重放队列里留下的最靠前一条 $rm5
    first.unmount();
    sentReadMarkers.length = 0;
    allowReadMarkers = true;
    renderApp(homeserver);

    const restoredRow = await screen.findByRole("button", { name: "重试已读位置话题" });
    expect(restoredRow).not.toHaveAttribute("data-unread", "true");
    await waitFor(() => expect(sentReadMarkers).toHaveLength(1));
    expect(sentReadMarkers[0].body).toEqual({ "m.fully_read": "$rm5", "m.read.private": "$rm5" });

    // 不发公开回执，不按线程另记，不自造 account data
    expect(homeserver.requests.some((r) => r.url.includes("/receipt/m.read"))).toBe(false);
    expect(JSON.stringify(homeserver.requests)).not.toContain("thread_id");
    expect(homeserver.requests.some((r) => r.url.includes("/account_data/") && !r.url.includes("im.waypoint.agents"))).toBe(false);
  });
});

test("就地编辑不挡住后续前移且更新后气泡在屏上时包含编辑；缺口不连续时不越过缺口前移；撤回后不再算未读", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const sentReadMarkers: Array<{ url: string; body: unknown }> = [];

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
                "!edit-topic:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "编辑与撤回话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$ed-1" } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ed-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "原消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$ed-replace-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: {
                          msgtype: "m.text",
                          body: "* 改后",
                          "m.new_content": { msgtype: "m.text", body: "改后" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$ed-1" },
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$ed-will-redact",
                        sender: "@bot:example.com",
                        origin_server_ts: 4000,
                        content: { msgtype: "m.text", body: "即将撤回" },
                      },
                    ],
                  },
                },
                "!gap-topic:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "中间有缺口话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$g1" } }],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$g1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "缺口前消息" },
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
                "!edit-topic:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$ed-redaction",
                        sender: "@bot:example.com",
                        origin_server_ts: 5000,
                        redacts: "$ed-will-redact",
                        content: {},
                      },
                    ],
                  },
                },
                "!gap-topic:example.com": {
                  timeline: {
                    limited: true,
                    prev_batch: "pb-gap",
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$g10",
                        sender: "@bot:example.com",
                        origin_server_ts: 9000,
                        content: { msgtype: "m.text", body: "缺口后消息" },
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
      sentReadMarkers.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  const editRow = await screen.findByRole("button", { name: "编辑与撤回话题" });
  const gapRow = screen.getByRole("button", { name: "中间有缺口话题" });
  expect(editRow).toHaveAttribute("data-unread", "true");
  expect(gapRow).not.toHaveAttribute("data-unread", "true");

  // 第 2 轮同步：撤回 $ed-will-redact -> 编辑与撤回话题不再未读；缺口话题收到 limited:true 后变成未读
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(2));
  await waitFor(() => {
    expect(editRow).not.toHaveAttribute("data-unread", "true");
    expect(gapRow).toHaveAttribute("data-unread", "true");
  });

  // 打开编辑与撤回话题：$ed-1 在屏幕上 -> 位置前移并包含 $ed-replace-1
  await user.click(editRow);
  await waitFor(() => {
    expect(sentReadMarkers).toContainEqual({
      url: "https://matrix.example.com/_matrix/client/v3/rooms/!edit-topic%3Aexample.com/read_markers",
      body: { "m.fully_read": "$ed-replace-1", "m.read.private": "$ed-replace-1" },
    });
  });

  // 打开中间有缺口话题：因 $g1 到 $g10 中间不连续，不能越过缺口把已读位置跳到 $g10
  await user.click(gapRow);
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("缺口后消息");
  expect(sentReadMarkers.some((m) => m.url.includes("gap-topic"))).toBe(false);
  expect(gapRow).toHaveAttribute("data-unread", "true");
});

test("已读指针指向的消息被撤回并从时间线移除后，回退到前一条存活消息，后续 Agent 消息仍标为未读且可继续前移已读位置", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const sentReadMarkers: Array<{ url: string; body: unknown }> = [];

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
                "!redacted-readpos:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "已读锚点撤回" } },
                    ],
                  },
                  timeline: {
                    events: [
                      { type: "m.room.message", event_id: "$r1", sender: "@bot:example.com", origin_server_ts: 1100, content: { msgtype: "m.text", body: "第一条" } },
                      { type: "m.room.message", event_id: "$r2", sender: "@bot:example.com", origin_server_ts: 1200, content: { msgtype: "m.text", body: "第二条将被撤回" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$r2" } }],
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
                "!redacted-readpos:example.com": {
                  timeline: {
                    events: [
                      { type: "m.room.redaction", event_id: "$red-r2", redacts: "$r2", sender: "@bot:example.com", origin_server_ts: 1300, content: {} },
                      { type: "m.room.message", event_id: "$r3", sender: "@bot:example.com", origin_server_ts: 1400, content: { msgtype: "m.text", body: "撤回后的新回复" } },
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
      sentReadMarkers.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);

  const row = await screen.findByRole("button", { name: "已读锚点撤回" });
  expect(row).not.toHaveAttribute("data-unread", "true");

  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(2));
  await waitFor(() => {
    expect(row).toHaveAttribute("data-unread", "true");
  });

  await user.click(row);
  await waitFor(() => {
    expect(sentReadMarkers).toContainEqual({
      url: "https://matrix.example.com/_matrix/client/v3/rooms/!redacted-readpos%3Aexample.com/read_markers",
      body: { "m.fully_read": "$r3", "m.read.private": "$r3" },
    });
  });
  expect(row).not.toHaveAttribute("data-unread", "true");
});

test("空 Topic 与不可用 Topic 都有删除入口（无归档），点删除弹出单次确认说明 home 投递与回到本房间的提醒，点取消不发请求", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
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
                    { user_id: "@bot1:example.com", name: "工作助理" },
                    { user_id: "@bot2:example.com", name: "研究助理" },
                  ],
                },
              },
            ],
          },
          rooms: {
            join: {
              "!empty:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "空 Topic" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!unavail:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 900, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot2:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "被加密的 Topic" } },
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
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  expect(screen.queryByRole("button", { name: /归档/ })).not.toBeInTheDocument();

  // 打开空 Topic：有删除入口且无归档
  await user.click(await screen.findByRole("button", { name: /空 Topic/ }));
  expect(screen.queryByRole("button", { name: /归档/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "删除" }));

  const dialog1 = screen.getByRole("alertdialog", { name: "确认删除 Topic" });
  expect(dialog1).toBeVisible();
  expect(dialog1.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(dialog1).toHaveTextContent("该 Bot");
  expect(dialog1).not.toHaveTextContent(/所有\s*Hermes|Hermes/);
  expect(dialog1).toHaveTextContent("看不出这条是不是该 Bot 的 home");
  expect(dialog1).toHaveTextContent("走 home 的投递会进已离开的房间");
  expect(dialog1).toHaveTextContent("追不回");
  expect(dialog1).toHaveTextContent("也不会再提示");
  expect(dialog1).toHaveTextContent("/sethome");
  expect(dialog1).toHaveTextContent("Waypoint 不代发 /sethome");
  expect(dialog1).toHaveTextContent("在这条 Topic 里跟该 Bot 约定的、回到本房间的提醒仍会发进已离开的房间");
  expect(dialog1).toHaveTextContent("/sethome 不会把它们改投走");

  const reqCountBeforeCancel = homeserver.requests.length;
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(homeserver.requests).toHaveLength(reqCountBeforeCancel);

  // 打开不可用（被加密）Topic：同样有删除入口，且只展示这一次单步确认
  await user.click(screen.getByRole("button", { name: /被加密的 Topic/ }));
  expect(screen.queryByRole("button", { name: /归档/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "删除" }));

  const dialog2 = screen.getByRole("alertdialog", { name: "确认删除 Topic" });
  expect(dialog2).toBeVisible();
  expect(dialog2.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(dialog2).toHaveTextContent("确认删除");
  expect(dialog2).toHaveTextContent("取消");
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("确认删除先发 leave；leave 失败时删除未生效，Topic、本地时间线、草稿与重试队列都保留且重开仍在，弹窗内可重试成功", async () => {
  const user = userEvent.setup();
  const failureCases: Array<{
    name: string;
    respond: () => Promise<TransportResult>;
    expectedAlert: string;
  }> = [
    {
      name: "网络失败",
      respond: async () => ({ type: "failure", failure: { type: "network" } }),
      expectedAlert: "无法连接到服务器，请检查网络或地址。",
    },
    {
      name: "超时",
      respond: async () => ({ type: "failure", failure: { type: "timeout" } }),
      expectedAlert: "删除 Topic 超时，请稍后重试。",
    },
    {
      name: "500 错误",
      respond: async () => ({
        type: "response",
        status: 500,
        body: { errcode: "M_UNKNOWN", error: "Leave failed" },
      }),
      expectedAlert: "服务器暂时无法响应，请稍后重试。",
    },
    {
      name: "403 拒绝",
      respond: async () => ({
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Cannot leave" },
      }),
      expectedAlert: "服务器拒绝了该请求。",
    },
  ];

  for (const failureCase of failureCases) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    let leaveAttempts = 0;

    homeserver.handler = passwordLoginHandler(async (input) => {
      if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: { agents: [{ user_id: "@bot:example.com", name: "助理" }] },
                },
                {
                  type: "m.direct",
                  content: { "@bot:example.com": ["!t1:example.com", "!other:example.com"] },
                },
              ],
            },
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "保留验证话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$hist-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "已有历史消息" },
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
        return { type: "failure", failure: { type: "network" } };
      }
      if (
        input.method === "POST" &&
        input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/leave")
      ) {
        leaveAttempts += 1;
        if (leaveAttempts === 1) {
          return failureCase.respond();
        }
        return { type: "response", status: 200, body: {} };
      }
      if (
        input.method === "POST" &&
        input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/forget")
      ) {
        return { type: "response", status: 200, body: {} };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    });

    const first = renderApp(homeserver);
    await login(user);

    await user.click(await screen.findByRole("button", { name: "保留验证话题" }));
    const composer = screen.getByLabelText("输入消息");
    await user.type(composer, "未确认排队消息");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("status", { name: "未确认" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("输入消息"), "还没发出的草稿");
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    const dialog = await screen.findByRole("alertdialog", { name: "确认删除 Topic" });
    expect(await screen.findByRole("alert")).toHaveTextContent(failureCase.expectedAlert);
    expect(dialog).toBeVisible();
    expect(screen.getByRole("button", { name: "保留验证话题", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "对话时间线", hidden: true })).toHaveTextContent("已有历史消息");
    expect(screen.getByRole("log", { name: "对话时间线", hidden: true })).toHaveTextContent("未确认排队消息");
    expect(screen.getByLabelText("输入消息")).toHaveValue("还没发出的草稿");
    expect(homeserver.requests.some((r) => r.url.endsWith("/forget"))).toBe(false);
    expect(homeserver.requests.some((r) => r.method === "PUT" && r.url.includes("/m.direct"))).toBe(
      false,
    );

    // 重启后仍在（sync 继续失败也不丢失本地时间线、草稿和重试队列）
    first.unmount();
    const restarted = renderApp(homeserver);
    await user.click(await screen.findByRole("button", { name: "保留验证话题" }));
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("已有历史消息");
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("未确认排队消息");
    expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
    expect(screen.getByLabelText("输入消息")).toHaveValue("还没发出的草稿");

    // 重试确认删除，leave 成功后立即移除
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "保留验证话题" })).not.toBeInTheDocument();
    });
    restarted.unmount();
  }
});

test("leave 一成功就立即移除 Topic、清掉本地时间线、草稿与重试队列且不自动打开另一条（宽/窄视口均成立），删后各处不再提警告文案", async () => {
  const user = userEvent.setup();
  for (const viewport of ["wide", "narrow"] as const) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    const pendingForget = deferred<TransportResult>();
    const pendingDirect = deferred<TransportResult>();
    let allowOtherSend = false;
    let deletedOnServer = false;
    const sentBodies: Array<{ url: string; body: unknown }> = [];
    let pushCount = 0;
    let popCount = 0;

    homeserver.handler = passwordLoginHandler(async (input) => {
      if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: { agents: [{ user_id: "@bot:example.com", name: "助理" }] },
                },
                {
                  type: "m.direct",
                  content: { "@bot:example.com": ["!del:example.com", "!keep:example.com"] },
                },
              ],
            },
            rooms: {
              join: {
                ...(deletedOnServer
                  ? {}
                  : {
                      "!del:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "要删掉的 Topic" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$del-m1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2500,
                        content: { msgtype: "m.text", body: "即将清除的对话" },
                      },
                    ],
                  },
                },
                    }),
                "!keep:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "留下的 Topic" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$keep-m1",
                        sender: "@bot:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "留在列表里的消息" },
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
        sentBodies.push({ url: input.url, body: input.body });
        if (!allowOtherSend) {
          return { type: "failure", failure: { type: "network" } };
        }
        return { type: "response", status: 200, body: { event_id: "$sent-ok" } };
      }
      if (
        input.method === "POST" &&
        input.url.endsWith("/_matrix/client/v3/rooms/!del%3Aexample.com/leave")
      ) {
        deletedOnServer = true;
        return { type: "response", status: 200, body: {} };
      }
      if (
        input.method === "POST" &&
        input.url.endsWith("/_matrix/client/v3/rooms/!del%3Aexample.com/forget")
      ) {
        return pendingForget.promise;
      }
      if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
        return pendingDirect.promise;
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    });

    const clock = new ManualClock();
    const view = render(
      <WaypointApp
        homeserver={homeserver}
        platform={{
          deviceDisplayName: viewport === "narrow" ? "Waypoint Android" : "Waypoint macOS",
          viewportMode: () => viewport,
          pushNavigationEntry: () => {
            pushCount += 1;
          },
          popNavigationEntry: () => {
            popCount += 1;
          },
        }}
        clock={clock}
      />,
    );
    await login(user);

    // 在要删除的 Topic 里产生排队未确认消息 + 草稿
    await user.click(await screen.findByRole("button", { name: "要删掉的 Topic" }));
    await user.type(screen.getByLabelText("输入消息"), "将被删掉的未确认消息");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("status", { name: "未确认" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("输入消息"), "将被删掉的草稿");

    // 另一条留下的 Topic 也放一条未确认消息（仍在重试队列里）
    if (viewport === "narrow") {
      await user.click(screen.getByRole("button", { name: "返回" }));
    }
    await user.click(screen.getByRole("button", { name: "留下的 Topic" }));
    await user.type(screen.getByLabelText("输入消息"), "留下来的排队消息");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // 回到要删掉的 Topic 并确认删除（forget 和 m.direct 仍处于挂起中）
    if (viewport === "narrow") {
      await user.click(screen.getByRole("button", { name: "返回" }));
    }
    await user.click(screen.getByRole("button", { name: "要删掉的 Topic" }));
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    // leave 刚一成功，forget/m.direct 尚未返回时，Topic 已立刻消失且不自动打开留下的 Topic
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "要删掉的 Topic" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("留下的 Topic")).toBeInTheDocument();
    if (viewport === "wide") {
      expect(screen.getByText(/选择一条 Topic/)).toBeInTheDocument();
    } else {
      expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
      expect(popCount).toBe(pushCount);
    }

    // 删完之后，列表、新建 Topic 与其他 Topic 里都不再提 home/提醒警告
    expect(document.body).not.toHaveTextContent("/sethome");
    expect(document.body).not.toHaveTextContent("回到本房间的提醒");
    await user.click(screen.getByRole("button", { name: "新建 Topic" }));
    expect(document.body).not.toHaveTextContent("/sethome");
    expect(document.body).not.toHaveTextContent("回到本房间的提醒");
    await user.click(screen.getByRole("button", { name: viewport === "narrow" ? "返回" : "取消" }));
    await user.click(screen.getByRole("button", { name: "留下的 Topic" }));
    expect(document.body).not.toHaveTextContent("/sethome");
    expect(document.body).not.toHaveTextContent("回到本房间的提醒");

    // 恢复发送后推进重试队列：只发留下 Topic 的消息，不再重发已删除 Topic 的排队消息
    sentBodies.length = 0;
    allowOtherSend = true;
    await act(async () => {
      clock.advance(5000);
    });
    await waitFor(() => {
      expect(
        sentBodies.some((item) => item.url.includes("/rooms/!keep%3Aexample.com/send/")),
      ).toBe(true);
    });
    expect(
      sentBodies.some((item) => item.url.includes("/rooms/!del%3Aexample.com/send/")),
    ).toBe(false);

    view.unmount();

    // 重启后已删除 Topic 及其本地时间线、草稿、重试队列都不再出现（即使 sync 把房间从 join 去掉/还没连上）
    const restarted = renderApp(homeserver);
    expect(await screen.findByText("留下的 Topic")).toBeInTheDocument();
    expect(screen.queryByText("要删掉的 Topic")).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    restarted.unmount();
  }
});

test("leave 成功后按顺序尽力 forget 与清理 m.direct（仅在包含时更新），forget/m.direct 失败不报错不恢复，不踢 Agent/不删消息/不代发 /sethome，且迟到同步不拉回已删 Topic", async () => {
  const user = userEvent.setup();

  // Case A: m.direct 包含待删房间，且 forget 与 m.direct 均失败；同时验证迟到的增量 sync 不复活已删房间
  {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    let syncCalls = 0;
    const staleSync = deferred<TransportResult>();
    const requestLog: string[] = [];

    homeserver.handler = passwordLoginHandler(async (input) => {
      requestLog.push(`${input.method} ${input.url}`);
      if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
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
                  {
                    type: "m.direct",
                    content: {
                      "@bot1:example.com": ["!del:example.com", "!stay:example.com"],
                      "@bot2:example.com": ["!other:example.com"],
                    },
                  },
                ],
              },
              rooms: {
                join: {
                  "!del:example.com": {
                    state: {
                      events: [
                        { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                        { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                        { type: "m.room.name", state_key: "", content: { name: "待删房间" } },
                      ],
                    },
                    timeline: {
                      events: [
                        {
                          type: "m.room.message",
                          event_id: "$ev1",
                          sender: "@bot1:example.com",
                          origin_server_ts: 1500,
                          content: { msgtype: "m.text", body: "不要撤回我" },
                        },
                      ],
                    },
                  },
                  "!stay:example.com": {
                    state: {
                      events: [
                        { type: "m.room.create", state_key: "", origin_server_ts: 900, content: {} },
                        { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                        { type: "m.room.name", state_key: "", content: { name: "保留房间" } },
                      ],
                    },
                    timeline: { events: [] },
                  },
                },
              },
            },
          };
        }
        return staleSync.promise;
      }
      if (
        input.method === "POST" &&
        input.url.endsWith("/_matrix/client/v3/rooms/!del%3Aexample.com/leave")
      ) {
        return { type: "response", status: 200, body: {} };
      }
      if (
        input.method === "POST" &&
        input.url.endsWith("/_matrix/client/v3/rooms/!del%3Aexample.com/forget")
      ) {
        return {
          type: "response",
          status: 500,
          body: { errcode: "M_UNKNOWN", error: "Forget failed" },
        };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
        return { type: "failure", failure: { type: "network" } };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    });

    const firstView = renderApp(homeserver);
    const { clock } = firstView;
    await login(user);

    await user.click(await screen.findByRole("button", { name: /待删房间/ }));
    // 发起一次前台同步并停在路上（包含 !del:example.com）
    await act(async () => {
      clock.advance(1000);
    });
    expect(syncCalls).toBe(2);

    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /待删房间/ })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(homeserver.requests.some((r) => r.url.endsWith("/forget"))).toBe(true);
      expect(
        homeserver.requests.some((r) => r.method === "PUT" && r.url.includes("/account_data/m.direct")),
      ).toBe(true);
    });

    // forget 和 m.direct 失败后，不报错、不恢复 Topic
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /待删房间/ })).not.toBeInTheDocument();

    // 顺序验证：leave 在 forget 与 m.direct 之前
    const leaveIdx = requestLog.findIndex((entry) => entry.endsWith("/leave"));
    const forgetIdx = requestLog.findIndex((entry) => entry.endsWith("/forget"));
    const directIdx = requestLog.findIndex((entry) => entry.includes("/account_data/m.direct"));
    expect(leaveIdx).toBeGreaterThan(-1);
    expect(forgetIdx).toBeGreaterThan(leaveIdx);
    expect(directIdx).toBeGreaterThan(leaveIdx);

    const directPut = homeserver.requests.find(
      (r) => r.method === "PUT" && r.url.includes("/account_data/m.direct"),
    );
    expect(directPut?.body).toEqual({
      "@bot1:example.com": ["!stay:example.com"],
      "@bot2:example.com": ["!other:example.com"],
    });

    // 没踢 Agent、没撤回事件、没发任何消息（包括 /sethome 或让 Agent 遗忘）
    expect(homeserver.requests.some((r) => r.url.includes("/kick"))).toBe(false);
    expect(homeserver.requests.some((r) => r.url.includes("/redact"))).toBe(false);
    expect(homeserver.requests.some((r) => r.url.includes("/send/"))).toBe(false);

    // 迟到的增量 sync 带着 !del:example.com 返回时，不能把它拉回列表
    await act(async () => {
      staleSync.resolve({
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-2",
          rooms: {
            join: {
              "!del:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "待删房间" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      });
    });
    expect(screen.queryByRole("button", { name: /待删房间/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保留房间/ })).toBeInTheDocument();
    firstView.unmount();
  }

  // Case B: m.direct 不包含待删房间时，不发 PUT m.direct，且删掉最后一个房间后 m.direct 移除空 key
  {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    homeserver.handler = passwordLoginHandler(async (input) => {
      if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: {
              events: [
                {
                  type: "im.waypoint.agents",
                  content: { agents: [{ user_id: "@bot:example.com", name: "助理" }] },
                },
                {
                  type: "m.direct",
                  content: { "@bot:example.com": ["!only-direct:example.com"] },
                },
              ],
            },
            rooms: {
              join: {
                "!not-in-direct:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "不在 direct 里" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!only-direct:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "最后一个 direct" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (input.method === "POST" && (input.url.endsWith("/leave") || input.url.endsWith("/forget"))) {
        return { type: "response", status: 200, body: {} };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    });

    const secondView = renderApp(homeserver);
    await login(user);

    await user.click(await screen.findByRole("button", { name: "不在 direct 里" }));
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(
        homeserver.requests.some((r) =>
          r.url.endsWith("/_matrix/client/v3/rooms/!not-in-direct%3Aexample.com/forget"),
        ),
      ).toBe(true);
    });
    expect(
      homeserver.requests.some((r) => r.method === "PUT" && r.url.includes("/account_data/m.direct")),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "最后一个 direct" }));
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(
        homeserver.requests.some((r) => r.method === "PUT" && r.url.includes("/account_data/m.direct")),
      ).toBe(true);
    });
    const directPut = homeserver.requests.find(
      (r) => r.method === "PUT" && r.url.includes("/account_data/m.direct"),
    );
    expect(directPut?.body).toEqual({});
    expect(screen.getByText("暂无 Topic")).toBeInTheDocument();
    secondView.unmount();
  }
});

test("消息被 Homeserver 永久拒绝（其他 4xx）时转圈换成红叹号，不写失败或错误码，重启后仍留原地且不自动重发；网络错误和限流不变红叹号", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let sendCalls = 0;
  let sendMode: "403" | "429" | "network" = "403";

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
                    { type: "m.room.name", state_key: "", content: { name: "永久拒绝测试话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$prev-1",
                      sender: "@bot:example.com",
                      origin_server_ts: 1500,
                      content: { msgtype: "m.text", body: "Bot 先说的话" },
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
      sendCalls += 1;
      if (sendMode === "403") {
        return {
          type: "response",
          status: 403,
          body: { errcode: "M_FORBIDDEN", error: "Forbidden to send" },
        };
      }
      if (sendMode === "429") {
        return {
          type: "response",
          status: 429,
          body: { errcode: "M_LIMIT_EXCEEDED", error: "Rate limited" },
        };
      }
      return { type: "failure", failure: { type: "network" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "永久拒绝测试话题" }));

  // 1) 发送一条会被 403 永久拒绝的消息
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "被拒绝的文本");
  await user.click(screen.getByRole("button", { name: "发送" }));

  const failBtn = await screen.findByRole("button", { name: "失败" });
  expect(failBtn).toHaveTextContent("!");
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/失败|Not Delivered|M_FORBIDDEN|403|Forbidden to send/);

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(2);
  expect(rows[1]).toHaveAttribute("data-side", "right");
  expect(rows[1]).toHaveTextContent("被拒绝的文本");
  expect(rows[1].contains(failBtn)).toBe(true);

  // 2) 网络错误和限流不变红叹号，仍保留在重试队列（转圈）
  sendMode = "429";
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "限流消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sendCalls).toBe(2));
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "失败" })).toHaveLength(1);

  sendMode = "network";
  await act(async () => { first.clock.advance(1000); });
  await waitFor(() => expect(sendCalls).toBe(3));
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "失败" })).toHaveLength(1);

  // 3) 重启恢复后，失败气泡仍在原地且不自动重发，只有未确认项在重试队列
  first.unmount();
  const sendsBeforeRestart = sendCalls;
  const second = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "永久拒绝测试话题" }));

  await waitFor(() => expect(sendCalls).toBe(sendsBeforeRestart + 1));
  const restoredTimeline = screen.getByRole("log", { name: "对话时间线" });
  const restoredRows = restoredTimeline.querySelectorAll("[data-side]");
  expect(restoredRows).toHaveLength(3);
  expect(restoredRows[1]).toHaveTextContent("被拒绝的文本");
  expect(restoredRows[1].contains(screen.getByRole("button", { name: "失败" }))).toBe(true);
  expect(restoredRows[2]).toHaveTextContent("限流消息");
  expect(restoredRows[2].contains(screen.getByRole("status", { name: "未确认" }))).toBe(true);

  second.unmount();
});

test("已有数据的 Topic 收到超过 20 条连续增量消息（limited: false）后滚到底部并返回，不伪造缺口且清除未读、重进停在底部", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

  const makeMsg = (n: number) => ({
    type: "m.room.message",
    event_id: `$m${n}`,
    sender: n % 2 === 0 ? "@bot:example.com" : "@alice:example.com",
    origin_server_ts: 1000 + n * 1000,
    content: { msgtype: "m.text", body: `连续消息-${n}` },
  });

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
                "!contig-21:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      {
                        type: "im.waypoint.topic",
                        state_key: "",
                        content: { v: 1, agent_user_id: "@bot:example.com" },
                      },
                      { type: "m.room.name", state_key: "", content: { name: "超过20条连续增量" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m1" } }],
                  },
                  timeline: { events: [makeMsg(1)], limited: false },
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
                "!contig-21:example.com": {
                  timeline: {
                    limited: false,
                    events: Array.from({ length: 21 }, (_, idx) => makeMsg(idx + 2)),
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
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 400, async () => {
    const { clock } = renderApp(homeserver, "Waypoint Android", {
      viewportMode: () => "narrow",
    });
    await login(user);

    await screen.findByRole("button", { name: "超过20条连续增量" });
    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => expect(syncRound).toBe(2));

    const row = await screen.findByRole("button", { name: "超过20条连续增量" });
    await waitFor(() => expect(row).toHaveAttribute("data-unread", "true"));

    await user.click(row);
    const timeline = await screen.findByRole("log", { name: "对话时间线" });
    expect(timeline.querySelectorAll("[data-event-id]")).toHaveLength(22);

    await act(async () => {
      timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
      fireEvent.scroll(timeline);
    });

    await waitFor(() => {
      expect(readMarkerPosts).toContainEqual({
        url: "https://matrix.example.com/_matrix/client/v3/rooms/!contig-21%3Aexample.com/read_markers",
        body: { "m.fully_read": "$m22", "m.read.private": "$m22" },
      });
    });

    await user.click(screen.getByRole("button", { name: "返回" }));
    const rowAfterBack = await screen.findByRole("button", { name: "超过20条连续增量" });
    expect(rowAfterBack).not.toHaveAttribute("data-unread", "true");

    await user.click(rowAfterBack);
    const reopenedTimeline = await screen.findByRole("log", { name: "对话时间线" });
    expect(reopenedTimeline.scrollTop).toBe(
      reopenedTimeline.scrollHeight - reopenedTimeline.clientHeight,
    );
  });
});


test("已有数据的 Topic 收到 limited: true 增量缺口后打开自动补齐中间缺口，滚到底部返回即清除未读且重进停在底部", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

  const makeMsg = (n: number) => ({
    type: "m.room.message",
    event_id: `$m${n}`,
    sender: n % 2 === 0 ? "@bot:example.com" : "@alice:example.com",
    origin_server_ts: 1000 + n * 1000,
    content: { msgtype: "m.text", body: `缺口消息-${n}` },
  });

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
                "!gap-20:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      {
                        type: "im.waypoint.topic",
                        state_key: "",
                        content: { v: 1, agent_user_id: "@bot:example.com" },
                      },
                      { type: "m.room.name", state_key: "", content: { name: "增量有限缺口话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m1" } }],
                  },
                  timeline: { events: [makeMsg(1)], limited: false },
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
                "!gap-20:example.com": {
                  timeline: {
                    limited: true,
                    prev_batch: "pb-gap-mid",
                    events: Array.from({ length: 20 }, (_, idx) => makeMsg(idx + 11)),
                  },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "GET" && input.url.includes("/messages") && input.url.includes("pb-gap-mid")) {
      return {
        type: "response",
        status: 200,
        body: {
          start: "pb-gap-mid",
          end: "pb-gap-end",
          chunk: Array.from({ length: 10 }, (_, idx) => makeMsg(idx + 1)).reverse(),
        },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 400, async () => {
    const { clock } = renderApp(homeserver, "Waypoint Android", {
      viewportMode: () => "narrow",
    });
    await login(user);

    await screen.findByRole("button", { name: "增量有限缺口话题" });
    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => expect(syncRound).toBe(2));

    const row = await screen.findByRole("button", { name: "增量有限缺口话题" });
    await waitFor(() => expect(row).toHaveAttribute("data-unread", "true"));

    await user.click(row);
    const timeline = await screen.findByRole("log", { name: "对话时间线" });
    await waitFor(() => {
      expect(timeline.querySelectorAll("[data-event-id]")).toHaveLength(30);
    });

    await act(async () => {
      timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
      fireEvent.scroll(timeline);
    });

    await waitFor(() => {
      expect(readMarkerPosts).toContainEqual({
        url: "https://matrix.example.com/_matrix/client/v3/rooms/!gap-20%3Aexample.com/read_markers",
        body: { "m.fully_read": "$m30", "m.read.private": "$m30" },
      });
    });

    await user.click(screen.getByRole("button", { name: "返回" }));
    const rowAfterBack = await screen.findByRole("button", { name: "增量有限缺口话题" });
    expect(rowAfterBack).not.toHaveAttribute("data-unread", "true");

    await user.click(rowAfterBack);
    const reopenedTimeline = await screen.findByRole("log", { name: "对话时间线" });
    expect(reopenedTimeline.scrollTop).toBe(
      reopenedTimeline.scrollHeight - reopenedTimeline.clientHeight,
    );
  });
});
