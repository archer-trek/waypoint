import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { TransportResult } from "../../adapters/types";
import { detectPlatform } from "../../adapters/production";
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

test("Owner 发出的文字走同一套渲染，不注入 HTML 也不内联 http(s) 图片 (#63)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const ts = new Date(2026, 10, 12, 10, 15, 0).getTime();

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
                    { type: "m.room.name", state_key: "", content: { name: "Owner同款渲染话题" } },
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
      return {
        type: "response",
        status: 200,
        body: { event_id: "$owner-rich-1" },
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
  await user.click(await screen.findByRole("button", { name: "Owner同款渲染话题" }));

  const ownerMessage = [
    "**加粗**文本与公式 $a^2 + b^2 = c^2$",
    "",
    "```python",
    "print(42)",
    "```",
    "",
    "| K | V |",
    "| --- | --- |",
    "| x | 1 |",
    "",
    "![外链图](https://evil.example/track.png)",
    "",
    "<script>window.__ownerXss=true</script> <img src=x onerror=window.__ownerXss=true> <div onclick=window.__ownerXss=true>hi</div>",
  ].join("\n");

  const composer = screen.getByRole("textbox", { name: "输入消息" });
  await user.click(composer);
  await user.paste(ownerMessage);
  await user.click(screen.getByRole("button", { name: "发送" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  await waitFor(() => {
    expect(timeline.querySelector("[data-side=\"right\"]")).not.toBeNull();
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  const rightRow = timeline.querySelector("[data-side=\"right\"]") as HTMLElement;
  const bubble = rightRow.querySelector(".waypoint-bubble") as HTMLElement;
  expect(bubble).not.toBeNull();

  // Owner 气泡同样渲染 CJK 加粗、公式、代码、表格
  expect(bubble.querySelector("[data-streamdown=\"strong\"]")?.textContent).toBe("加粗");
  expect(bubble.querySelector(".katex")).not.toBeNull();
  expect(bubble.querySelector("[data-streamdown=\"code-block\"][data-language=\"python\"]")).not.toBeNull();
  expect(within(bubble).getByRole("button", { name: "复制代码" })).toBeInTheDocument();
  expect(within(bubble).getByRole("table")).toBeInTheDocument();

  // 不注入 HTML、不执行脚本、不内联 http(s) 图片
  expect(bubble.querySelector("script")).toBeNull();
  expect(bubble.querySelector("img")).toBeNull();
  expect(bubble.querySelector("[onclick]")).toBeNull();
  expect((window as { __ownerXss?: boolean }).__ownerXss).toBeUndefined();
  expect(bubble.textContent).toContain("<script>window.__ownerXss=true</script>");
  expect(bubble.textContent).toContain("外链图");
});

test("渲染在旧设备上异常时提示并回退原文，不拒绝打开 Topic 或设 WebView 版本门槛 (#63)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const ts = new Date(2026, 10, 12, 10, 20, 0).getTime();
  const codeBody = "```rust\nfn main() { println!(\"hi\"); }\n```";

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
                    { type: "m.room.name", state_key: "", content: { name: "旧WebView兜底话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$ok-msg",
                      sender: "@bot:example.com",
                      origin_server_ts: ts,
                      content: { msgtype: "m.text", body: "普通消息仍可正常显示" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$crash-msg",
                      sender: "@bot:example.com",
                      origin_server_ts: ts + 1000,
                      content: { msgtype: "m.text", body: codeBody },
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

  const origAt = Array.prototype.at;
  const origUaDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () =>
        "Mozilla/5.0 (Linux; Android 8.1.0; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.158 Mobile Safari/537.36",
    });

    // 模拟旧 WebView 缺少/抛出 Array.prototype.at 导致 Streamdown 代码块分支抛错
    Array.prototype.at = function (index: number) {
      if (Array.isArray(this) && typeof this[0] === "string" && this[0].includes("language-rust")) {
        throw new TypeError("Array.prototype.at is not supported on old WebView");
      }
      return origAt.call(this, index);
    };

    const clock = new ManualClock();
    clock.now = ts;
    render(
      <WaypointApp
        homeserver={homeserver}
        platform={{ deviceDisplayName: "Waypoint Android" }}
        clock={clock}
      />,
    );
    await login(user);

    // 不设 WebView 版本硬门槛，仍能进入列表并打开 Topic
    const topicButton = await screen.findByRole("button", { name: "旧WebView兜底话题" });
    await user.click(topicButton);

    const timeline = screen.getByRole("log", { name: "对话时间线" });
    const bubbles = Array.from(timeline.querySelectorAll(".waypoint-bubble")) as HTMLElement[];
    expect(bubbles).toHaveLength(2);

    // 第一条普通消息不受影响
    expect(bubbles[0]?.textContent).toBe("普通消息仍可正常显示");

    // 第二条渲染失败：给出柔和提示并回退到原文，Topic 仍保持打开且输入框可用
    const fallbackBubble = bubbles[1]!;
    expect(within(fallbackBubble).getByRole("note")).toHaveTextContent("渲染异常，已显示原文");
    expect(fallbackBubble.textContent).toContain("fn main()");
    expect(fallbackBubble.textContent).toContain("```rust");
    expect(screen.getByRole("textbox", { name: "输入消息" })).toBeEnabled();
  } finally {
    Array.prototype.at = origAt;
    if (origUaDescriptor) {
      Object.defineProperty(Navigator.prototype, "userAgent", origUaDescriptor);
    }
    errorSpy.mockRestore();
  }
});

test("只在输入是斜杠且还没写参数时提示四条命令，选定后作为普通消息发出且不在本地执行", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const sentBodies: Array<{ url: string; body: unknown }> = [];
  let syncRound = 0;

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/_matrix/client/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "GET") {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "POST") {
      return {
        type: "response",
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV-1" },
      };
    }
    if (input.url.includes("/_matrix/client/v3/sync")) {
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
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "斜杠测试话题" } },
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
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sentBodies.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: { event_id: `$sent-${sentBodies.length}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "斜杠测试话题" }));

  const input = screen.getByRole("textbox", { name: "输入消息" });
  expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();

  // 只打一个斜杠时出现四条提示，且不包含 /sethome、/yolo、/approve
  await user.type(input, "/");
  const hintRegion = screen.getByRole("region", { name: "斜杠命令提示" });
  const hintButtons = within(hintRegion).getAllByRole("button");
  expect(hintButtons.map((btn) => btn.textContent)).toEqual([
    "/model",
    "/stop",
    "/status",
    "/commands",
  ]);
  expect(hintRegion).not.toHaveTextContent("/sethome");
  expect(hintRegion).not.toHaveTextContent("/yolo");
  expect(hintRegion).not.toHaveTextContent("/approve");

  // 写了其他字符或参数后提示消失
  await user.type(input, "m");
  expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();
  await user.type(input, "odel fast");
  expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();

  // 中间带斜杠或前导空格也不触发提示
  await user.clear(input);
  await user.type(input, "hello /");
  expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();

  await user.clear(input);
  await user.type(input, "/sethome");
  expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();

  // 清空后重新只打 / ，选定 /status 直接作为消息发出，本地不执行
  await user.clear(input);
  await user.type(input, "/");
  const refreshedHints = screen.getByRole("region", { name: "斜杠命令提示" });
  await user.click(within(refreshedHints).getByRole("button", { name: "/status" }));

  await waitFor(() => {
    expect(sentBodies).toHaveLength(1);
  });
  expect(sentBodies[0].url).toContain("!t1%3Aexample.com/send/m.room.message/");
  expect(sentBodies[0].body).toEqual({ msgtype: "m.text", body: "/status" });
  expect(input).toHaveValue("");
  expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("log", { name: "对话时间线" })).getByText("/status")).toBeInTheDocument();
});

test("其余内容整段原样发送（含 /yolo、/approve、!approve、/sethome、带参斜杠与直接发 /），四条提示选中后均不拦截不改写", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const sentBodies: string[] = [];
  let syncRound = 0;

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/_matrix/client/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "GET") {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "POST") {
      return {
        type: "response",
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV-1" },
      };
    }
    if (input.url.includes("/_matrix/client/v3/sync")) {
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
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "原样发送话题" } },
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
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      const payload = input.body as { msgtype: string; body: string };
      expect(payload.msgtype).toBe("m.text");
      sentBodies.push(payload.body);
      return { type: "response", status: 200, body: { event_id: `$sent-${sentBodies.length}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "原样发送话题" }));

  const input = screen.getByRole("textbox", { name: "输入消息" });

  // 逐一选定其余三条斜杠提示（/model、/stop、/commands），均原样发出且不中断同步
  for (const cmd of ["/model", "/stop", "/commands"]) {
    await user.type(input, "/");
    const hintRegion = screen.getByRole("region", { name: "斜杠命令提示" });
    await user.click(within(hintRegion).getByRole("button", { name: cmd }));
    await waitFor(() => {
      expect(sentBodies).toContain(cmd);
    });
  }

  // 选定 /stop 后同步仍然照常进行（Waypoint 未在本地执行 /stop）
  const syncCountBefore = homeserver.requests.filter((r) => r.url.includes("/_matrix/client/v3/sync")).length;
  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(homeserver.requests.filter((r) => r.url.includes("/_matrix/client/v3/sync")).length).toBeGreaterThan(
      syncCountBefore,
    );
  });

  // 其余内容整段原样发送，包括 /yolo、/approve、!approve、/sethome、带参斜杠与单独 /
  const verbatimInputs = [
    "/yolo",
    "/approve",
    "!approve",
    "/sethome",
    "/sethome #home:example.com",
    "/model gpt-4o",
    "/",
  ];

  for (const text of verbatimInputs) {
    await user.type(input, text);
    if (text === "/") {
      expect(screen.getByRole("region", { name: "斜杠命令提示" })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(sentBodies[sentBodies.length - 1]).toBe(text);
    });
  }

  expect(sentBodies).toEqual([
    "/model",
    "/stop",
    "/commands",
    "/yolo",
    "/approve",
    "!approve",
    "/sethome",
    "/sethome #home:example.com",
    "/model gpt-4o",
    "/",
  ]);
});

test("正在回应（消息挂着 👀）时输入框照常立即发送，不在本地排队，也不改写成 steer 或 stop", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const sentMessages: Array<{ url: string; body: unknown }> = [];
  let syncRound = 0;

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/_matrix/client/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "GET") {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "POST") {
      return {
        type: "response",
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV-1" },
      };
    }
    if (input.url.includes("/_matrix/client/v3/sync")) {
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
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "正在回应话题" } },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$bot-ack",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "我先查一下" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$bot-eyes",
                        sender: "@bot:example.com",
                        origin_server_ts: 2001,
                        content: {
                          "m.relates_to": {
                            rel_type: "m.annotation",
                            event_id: "$bot-ack",
                            key: "👀",
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
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sentMessages.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: { event_id: `$owner-${sentMessages.length}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "正在回应话题" }));

  const input = screen.getByRole("textbox", { name: "输入消息" });
  expect(input).toBeEnabled();

  // 在 👀 未撤回期间直接发普通消息，立刻发出，不排队、不改写成 steer 或 stop
  await user.type(input, "顺便把日志也贴出来");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => {
    expect(sentMessages).toHaveLength(1);
  });
  expect(sentMessages[0].body).toEqual({
    msgtype: "m.text",
    body: "顺便把日志也贴出来",
  });

  // 在 👀 未撤回期间点斜杠提示，也照常立即原样发出
  await user.type(input, "/");
  const hintRegion = screen.getByRole("region", { name: "斜杠命令提示" });
  await user.click(within(hintRegion).getByRole("button", { name: "/status" }));

  await waitFor(() => {
    expect(sentMessages).toHaveLength(2);
  });
  expect(sentMessages[1].body).toEqual({
    msgtype: "m.text",
    body: "/status",
  });
  expect(JSON.stringify(sentMessages)).not.toContain("steer");
});

test("Topic 变为不可用或需重新验证时隐藏斜杠提示并保留 / 草稿，恢复后重新提示", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  homeserver.handler = async (input) => {
    if (input.url.endsWith("/_matrix/client/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "GET") {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.url.endsWith("/_matrix/client/v3/login") && input.method === "POST") {
      return {
        type: "response",
        status: 200,
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV-1" },
      };
    }
    if (input.url.includes("/_matrix/client/v3/sync")) {
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
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "可恢复斜杠话题" } },
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
                "!t1:example.com": {
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
      if (syncRound === 3) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-3",
            rooms: {
              join: {
                "!t1:example.com": {
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
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "可恢复斜杠话题" }));

  const input = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(input, "/");
  expect(screen.getByRole("region", { name: "斜杠命令提示" })).toBeInTheDocument();

  // 第三人加入 -> Topic 不可用，提示消失但 / 草稿还在
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(screen.getByRole("status", { name: "Topic 不可用" })).toBeInTheDocument();
  });
  expect(screen.queryByRole("region", { name: "斜杠命令提示" })).not.toBeInTheDocument();
  expect(input).toHaveValue("/");

  // 第三人离开 -> Topic 恢复可用，/ 草稿触发四条提示再次出现
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "Topic 不可用" })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("region", { name: "斜杠命令提示" })).toBeInTheDocument();
});

test("Android 切后台或锁屏时立刻中止正在等的同步长轮询并暂停重试计时，中断不计入失败退避 (#73)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendCalls = 0;
  let visible = true;
  const visibilityListeners = new Set<(v: boolean) => void>();
  const pendingLongPoll = deferred<TransportResult>();
  const syncSignals: Array<AbortSignal | undefined> = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      syncSignals.push(input.signal);
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
                      { type: "m.room.name", state_key: "", content: { name: "Android挂起话题" } },
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
        return pendingLongPoll.promise;
      }
      return { type: "failure", failure: { type: "network" } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendCalls += 1;
      return { type: "failure", failure: { type: "network" } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const clock = new ManualClock();
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{
        deviceDisplayName: "Waypoint Android",
        isAppVisible: () => visible,
        subscribeAppVisibility: (onChange) => {
          visibilityListeners.add(onChange);
          return () => visibilityListeners.delete(onChange);
        },
      }}
      clock={clock}
    />,
  );

  await login(user);
  await user.click(await screen.findByRole("button", { name: "Android挂起话题" }));

  // 发起一条会失败进重试队列的消息（首次失败后进入 1s 退避）
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "后台暂停消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(sendCalls).toBe(1));

  // 推进 1s：触发长轮询 /sync #2（挂起等待）以及队列第 1 次重试（失败后进入 2s 退避）
  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(syncCalls).toBe(2);
    expect(sendCalls).toBe(2);
  });
  expect(syncSignals[1]).toBeDefined();
  expect(syncSignals[1]?.aborted).toBe(false);

  // Android 切后台 / 锁屏
  await act(async () => {
    visible = false;
    for (const listener of visibilityListeners) listener(false);
  });

  // 当前挂起的 /sync 长轮询被立即 abort
  expect(syncSignals[1]?.aborted).toBe(true);

  // 在后台推进 60s：同步和重试队列都已挂起，不再发出任何请求
  await act(async () => {
    clock.advance(60_000);
  });
  expect(syncCalls).toBe(2);
  expect(sendCalls).toBe(2);

  // 回到前台：立刻恢复同步（不计入之前的 abort 退避，所以如果再次失败，首次退避仍是 1s 而非 2s）
  await act(async () => {
    visible = true;
    for (const listener of visibilityListeners) listener(true);
  });
  await waitFor(() => expect(syncCalls).toBe(3));
  // 验证第 3 次 /sync 失败后，退避仍是 1s（推进 999ms 不重试，1000ms 才重试）
  await act(async () => {
    clock.advance(999);
  });
  expect(syncCalls).toBe(3);
  await act(async () => {
    clock.advance(1);
  });
  await waitFor(() => expect(syncCalls).toBe(4));
});

test("Android 回到前台时立刻清零退避、携带已有同步游标增量同步，并按交出顺序立即重放重试队列（不等待同步完成） (#73)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let offline = false;
  let holdResumeSync = false;
  const resumeSyncDeferred = deferred<TransportResult>();
  const syncUrls: string[] = [];
  const sentBodies: string[] = [];
  let visible = true;
  const visibilityListeners = new Set<(v: boolean) => void>();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      syncUrls.push(input.url);
      if (syncCalls === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-cursor-42",
            account_data: validAgents,
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "前台恢复话题" } },
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
      if (holdResumeSync) {
        holdResumeSync = false;
        return resumeSyncDeferred.promise;
      }
      return { type: "response", status: 200, body: { next_batch: `batch-after-${syncCalls}` } };
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

  const clock = new ManualClock();
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{
        deviceDisplayName: "Waypoint Android",
        isAppVisible: () => visible,
        subscribeAppVisibility: (onChange) => {
          visibilityListeners.add(onChange);
          return () => visibilityListeners.delete(onChange);
        },
      }}
      clock={clock}
    />,
  );

  await login(user);
  await user.click(await screen.findByRole("button", { name: "前台恢复话题" }));

  // 断网并发送两条消息进入重试队列，推进退避至较高步数（1s + 2s）
  offline = true;
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncCalls).toBe(2));

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "队列消息一");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(""));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "队列消息二");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getAllByRole("status", { name: "未确认" })).toHaveLength(2));

  await act(async () => { clock.advance(1000); });
  const syncCountBeforeBg = syncCalls;

  // 切后台暂停：即使此时触发 online 也不应唤醒
  await act(async () => {
    visible = false;
    for (const listener of visibilityListeners) listener(false);
  });
  offline = false;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    clock.advance(10_000);
  });
  expect(syncCalls).toBe(syncCountBeforeBg);
  expect(sentBodies).toEqual([]);

  // 回到前台：阻塞这次增量同步返回，验证立刻带上 since=batch-cursor-42 发出同步且队列不等同步完成就按序重放
  holdResumeSync = true;
  await act(async () => {
    visible = true;
    for (const listener of visibilityListeners) listener(true);
  });

  await waitFor(() => {
    expect(syncCalls).toBe(syncCountBeforeBg + 1);
    expect(syncUrls[syncUrls.length - 1]).toBe(
      "https://matrix.example.com/_matrix/client/v3/sync?since=batch-cursor-42",
    );
    expect(sentBodies).toEqual(["队列消息一", "队列消息二"]);
  });
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });

  await act(async () => {
    resumeSyncDeferred.resolve({ type: "response", status: 200, body: { next_batch: "batch-done" } });
  });
});

test("macOS 窗口失焦或不可见不挂起同步，且桌面从休眠或断网恢复时立刻清零退避、增量同步并按序重放重试队列 (#73)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let sendCalls = 0;
  let offline = false;
  let staleSync: ReturnType<typeof deferred<TransportResult>> | null = null;
  const syncSignals: Array<AbortSignal | undefined> = [];
  const syncUrls: string[] = [];
  const sentBodies: string[] = [];
  const visibilityListeners = new Set<(v: boolean) => void>();
  const resumeListeners = new Set<() => void>();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      syncSignals.push(input.signal);
      syncUrls.push(input.url);
      if (syncCalls === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-mac-1",
            account_data: validAgents,
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "macOS同步话题" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (staleSync) {
        const pending = staleSync;
        staleSync = null;
        return pending.promise;
      }
      if (offline) {
        return { type: "failure", failure: { type: "network" } };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-mac-${syncCalls}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sendCalls += 1;
      if (offline) {
        return { type: "failure", failure: { type: "network" } };
      }
      const body = (input.body as { body: string }).body;
      sentBodies.push(body);
      return { type: "response", status: 200, body: { event_id: `$ev-${sentBodies.length}` } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const clock = new ManualClock();
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{
        deviceDisplayName: "Waypoint macOS",
        isAppVisible: () => true,
        subscribeAppVisibility: (onChange) => {
          visibilityListeners.add(onChange);
          return () => visibilityListeners.delete(onChange);
        },
        subscribeNetworkResume: (onResume) => {
          resumeListeners.add(onResume);
          return () => resumeListeners.delete(onResume);
        },
      }}
      clock={clock}
    />,
  );

  await login(user);
  await user.click(await screen.findByRole("button", { name: "macOS同步话题" }));

  // macOS 窗口失焦 (blur) 和不可见 (visibility=false)：不挂起同步，不中止长轮询
  const stale1 = deferred<TransportResult>();
  staleSync = stale1;
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncCalls).toBe(2));

  await act(async () => {
    window.dispatchEvent(new Event("blur"));
    for (const listener of visibilityListeners) listener(false);
  });
  expect(syncSignals[1]?.aborted).toBe(false);

  // 让第 2 轮完成并投递新消息，验证失焦期间正常保留并按 1s 周期继续发起第 3 轮同步
  await act(async () => {
    stale1.resolve({
      type: "response",
      status: 200,
      body: {
        next_batch: "batch-mac-2",
        rooms: {
          join: {
            "!t1:example.com": {
              timeline: {
                events: [
                  {
                    type: "m.room.message",
                    event_id: "$mac-blur-msg",
                    sender: "@bot:example.com",
                    origin_server_ts: 2000,
                    content: { msgtype: "m.text", body: "失焦期间照常收到" },
                  },
                ],
              },
            },
          },
        },
      },
    });
  });
  await waitFor(() => {
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("失焦期间照常收到");
  });
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => expect(syncCalls).toBe(3));

  // 断网并入队两条消息，进入退避；再挂起一轮休眠前僵死的 /sync #4。
  // 必须等上一条本地写入结束、发送按钮恢复后再点下一次，否则慢速环境下第二次点击会落在禁用按钮上。
  offline = true;
  const composer = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(composer, "桌面消息1");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(sendCalls).toBe(1);
    expect(composer).toBeEnabled();
    expect(composer).toHaveValue("");
  });
  await user.type(composer, "桌面消息2");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(sendCalls).toBe(2);
    expect(composer).toHaveValue("");
  });

  const stale2 = deferred<TransportResult>();
  staleSync = stale2;
  await advanceWhenTimerScheduled(clock, 1000);
  await waitFor(() => expect(syncCalls).toBe(4));

  // 桌面从休眠/断网恢复：立刻中止僵死的同步 #4、清零退避、带 since=batch-mac-2 增量同步，并按序重放两条消息
  offline = false;
  await act(async () => {
    for (const listener of resumeListeners) listener();
  });
  expect(syncSignals[3]?.aborted).toBe(true);
  await waitFor(() => {
    expect(syncCalls).toBe(5);
    expect(syncUrls[syncUrls.length - 1]).toBe(
      "https://matrix.example.com/_matrix/client/v3/sync?since=batch-mac-3",
    );
    expect(sentBodies).toEqual(["桌面消息1", "桌面消息2"]);
  });
});

test("回到前台时若正打开 Topic，新同步到的消息出现在屏幕上才前移已读位置，视口下方消息不算读过也不把视口拉走 (#73)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let visible = true;
  const visibilityListeners = new Set<(v: boolean) => void>();
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-rp-1",
            account_data: validAgents,
            rooms: {
              join: {
                "!t-scroll:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "视口外不拉走话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m1" } }],
                  },
                  timeline: {
                    events: [
                      { type: "m.room.message", event_id: "$m1", sender: "@bot:example.com", origin_server_ts: 1100, content: { msgtype: "m.text", body: "m1" } },
                      { type: "m.room.message", event_id: "$m2", sender: "@bot:example.com", origin_server_ts: 1200, content: { msgtype: "m.text", body: "m2" } },
                      { type: "m.room.message", event_id: "$m3", sender: "@bot:example.com", origin_server_ts: 1300, content: { msgtype: "m.text", body: "m3" } },
                      { type: "m.room.message", event_id: "$m4", sender: "@bot:example.com", origin_server_ts: 1400, content: { msgtype: "m.text", body: "m4" } },
                    ],
                  },
                },
                "!t-bottom:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "在底部回前台话题" } },
                    ],
                  },
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$b2" } }],
                  },
                  timeline: {
                    events: [
                      { type: "m.room.message", event_id: "$b1", sender: "@bot:example.com", origin_server_ts: 2100, content: { msgtype: "m.text", body: "b1" } },
                      { type: "m.room.message", event_id: "$b2", sender: "@bot:example.com", origin_server_ts: 2200, content: { msgtype: "m.text", body: "b2" } },
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
            next_batch: "batch-rp-2",
            rooms: {
              join: {
                "!t-scroll:example.com": {
                  timeline: {
                    events: [
                      { type: "m.room.message", event_id: "$m5", sender: "@bot:example.com", origin_server_ts: 3100, content: { msgtype: "m.text", body: "m5" } },
                      { type: "m.room.message", event_id: "$m6", sender: "@bot:example.com", origin_server_ts: 3200, content: { msgtype: "m.text", body: "m6" } },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      if (syncCalls === 3) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-rp-3",
            rooms: {
              join: {
                "!t-bottom:example.com": {
                  timeline: {
                    events: [
                      { type: "m.room.message", event_id: "$b3", sender: "@bot:example.com", origin_server_ts: 4100, content: { msgtype: "m.text", body: "b3" } },
                      { type: "m.room.message", event_id: "$b4", sender: "@bot:example.com", origin_server_ts: 4200, content: { msgtype: "m.text", body: "b4" } },
                      { type: "m.room.message", event_id: "$b5", sender: "@bot:example.com", origin_server_ts: 4300, content: { msgtype: "m.text", body: "b5" } },
                      { type: "m.room.message", event_id: "$b6", sender: "@bot:example.com", origin_server_ts: 4400, content: { msgtype: "m.text", body: "b6" } },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: `batch-rp-${syncCalls}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 200, async () => {
    const clock = new ManualClock();
    render(
      <WaypointApp
        homeserver={homeserver}
        platform={{
          deviceDisplayName: "Waypoint Android",
          isAppVisible: () => visible,
          subscribeAppVisibility: (onChange) => {
            visibilityListeners.add(onChange);
            return () => visibilityListeners.delete(onChange);
          },
        }}
        clock={clock}
      />,
    );

    await login(user);

    // Part A: 打开有未读的 Topic，停在 $m2 (scrollTop=100)，视口只看到 $m2 和 $m3
    const scrollRow = await screen.findByRole("button", { name: "视口外不拉走话题" });
    await user.click(scrollRow);
    const timeline1 = screen.getByRole("log", { name: "对话时间线" });
    expect(timeline1.scrollTop).toBe(100);
    await waitFor(() => expect(readMarkerPosts).toHaveLength(1));
    expect(readMarkerPosts[0].body).toEqual({ "m.fully_read": "$m3", "m.read.private": "$m3" });

    // 切后台 -> 回到前台同步到 $m5, $m6：不拉走视口，也不把视口外消息算作已读
    await act(async () => {
      visible = false;
      for (const listener of visibilityListeners) listener(false);
    });
    await act(async () => {
      visible = true;
      for (const listener of visibilityListeners) listener(true);
    });
    await waitFor(() => expect(timeline1).toHaveTextContent("m6"));
    expect(timeline1.scrollTop).toBe(100);
    expect(readMarkerPosts).toHaveLength(1);
    expect(scrollRow).toHaveAttribute("data-unread", "true");

    // Part B: 切到原本在底部已读的 Topic，再切后台 -> 回到前台同步到 4 条超出一屏的新消息 ($b3..$b6)
    const bottomRow = screen.getByRole("button", { name: "在底部回前台话题" });
    await user.click(bottomRow);
    const timeline2 = screen.getByRole("log", { name: "对话时间线" });
    expect(timeline2.scrollTop).toBe(0);

    await act(async () => {
      visible = false;
      for (const listener of visibilityListeners) listener(false);
    });
    await act(async () => {
      visible = true;
      for (const listener of visibilityListeners) listener(true);
    });
    await waitFor(() => expect(timeline2).toHaveTextContent("b6"));

    // 停在第一条新消息 $b3 (scrollTop=200，视口 200..400 只看见 $b3 和 $b4)，不跳过未读跳到底 (400)
    expect(timeline2.scrollTop).toBe(200);
    await waitFor(() => expect(readMarkerPosts).toHaveLength(2));
    expect(readMarkerPosts[1].body).toEqual({ "m.fully_read": "$b4", "m.read.private": "$b4" });
    expect(bottomRow).toHaveAttribute("data-unread", "true");

    // Owner 自己滚到底 (scrollTop=400)，$b5 和 $b6 出现在屏幕上后才前移到 $b6
    await act(async () => {
      timeline2.scrollTop = 400;
      timeline2.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitFor(() => expect(readMarkerPosts).toHaveLength(3));
    expect(readMarkerPosts[2].body).toEqual({ "m.fully_read": "$b6", "m.read.private": "$b6" });
    expect(bottomRow).not.toHaveAttribute("data-unread", "true");
  });
});

test("双端都不申请通知权限、不发系统通知、不设角标、不接入推送，Agent 主动投进仍管理的 Topic 的消息只在前景通过未读指示和排序呈现 (#73)", async () => {
  const user = userEvent.setup();
  const notificationCalls: string[] = [];
  const requestPermissionSpy = vi.fn(async () => "denied");
  class MockNotification {
    static permission = "default";
    static requestPermission = requestPermissionSpy;
    constructor(title: string) {
      notificationCalls.push(title);
    }
  }
  const origNotification = globalThis.Notification;
  const origSetAppBadge = (navigator as Navigator & { setAppBadge?: unknown }).setAppBadge;
  const setAppBadgeSpy = vi.fn(async () => undefined);
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: MockNotification });
  Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: setAppBadgeSpy });

  try {
    for (const deviceDisplayName of ["Waypoint macOS", "Waypoint Android"] as const) {
      globalThis.indexedDB = new IDBFactory();
      const homeserver = new FakeHomeserver();
      let syncCalls = 0;
      let visible = true;
      let releaseProactive = false;
      const visibilityListeners = new Set<(v: boolean) => void>();

      homeserver.handler = passwordLoginHandler(async (input) => {
        if (input.url.includes("/sync")) {
          syncCalls += 1;
          if (syncCalls === 1) {
            return {
              type: "response",
              status: 200,
              body: {
                next_batch: "batch-notif-1",
                account_data: validAgents,
                rooms: {
                  join: {
                    "!t-old:example.com": {
                      state: {
                        events: [
                          { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                          { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                          { type: "m.room.name", state_key: "", content: { name: "定时投递旧话题" } },
                        ],
                      },
                      account_data: {
                        events: [{ type: "m.fully_read", content: { event_id: "$old-1" } }],
                      },
                      timeline: {
                        events: [
                          { type: "m.room.message", event_id: "$old-1", sender: "@bot:example.com", origin_server_ts: 1100, content: { msgtype: "m.text", body: "旧消息" } },
                        ],
                      },
                    },
                    "!t-new:example.com": {
                      state: {
                        events: [
                          { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                          { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                          { type: "m.room.name", state_key: "", content: { name: "较新无未读话题" } },
                        ],
                      },
                      account_data: {
                        events: [{ type: "m.fully_read", content: { event_id: "$new-1" } }],
                      },
                      timeline: {
                        events: [
                          { type: "m.room.message", event_id: "$new-1", sender: "@bot:example.com", origin_server_ts: 2100, content: { msgtype: "m.text", body: "新消息" } },
                        ],
                      },
                    },
                  },
                },
              },
            };
          }
          // 登录后的增量 sync 次数在慢速 CI 上不稳定。只要测试已经放开投递，
          // 下一次成功的 /sync 就要带上这条主动消息，而不是写死 syncCalls === 2。
          if (releaseProactive) {
            return {
              type: "response",
              status: 200,
              body: {
                next_batch: "batch-notif-2",
                rooms: {
                  join: {
                    "!t-old:example.com": {
                      timeline: {
                        events: [
                          {
                            type: "m.room.message",
                            event_id: "$proactive-1",
                            sender: "@bot:example.com",
                            origin_server_ts: 5000,
                            content: { msgtype: "m.text", body: "Agent 主动投递的定时总结" },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            };
          }
          return { type: "response", status: 200, body: { next_batch: `batch-notif-${syncCalls}` } };
        }
        throw new Error(`${input.method} ${input.url}`);
      });

      const clock = new ManualClock();
      const view = render(
        <WaypointApp
          homeserver={homeserver}
          platform={{
            deviceDisplayName,
            isAppVisible: () => visible,
            subscribeAppVisibility: (onChange) => {
              visibilityListeners.add(onChange);
              return () => visibilityListeners.delete(onChange);
            },
          }}
          clock={clock}
        />,
      );

      await login(user);
      const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
      const listBefore = within(sidebar)
        .getAllByRole("button")
        .filter((b) => b.classList.contains("waypoint-topic-row"));
      expect(listBefore.map((b) => b.getAttribute("aria-label"))).toEqual([
        "较新无未读话题",
        "定时投递旧话题",
      ]);

      releaseProactive = true;
      if (deviceDisplayName === "Waypoint macOS") {
        // macOS 窗口失焦不挂起同步。失焦后要等前台 sync 定时器真正排上，
        // 再推进 ManualClock；在 act 里提前 advance 会把这一跳丢掉，CI 上 waitFor 就会超时。
        await act(async () => {
          window.dispatchEvent(new Event("blur"));
        });
        await advanceWhenTimerScheduled(clock, 1000);
      } else {
        // Android 切后台再回到前台收到 Agent 主动投递消息
        await waitFor(() => expect(visibilityListeners.size).toBeGreaterThan(0));
        await act(async () => {
          visible = false;
          for (const listener of visibilityListeners) listener(false);
        });
        await act(async () => {
          visible = true;
          for (const listener of visibilityListeners) listener(true);
        });
      }

      const oldRow = await screen.findByRole("button", { name: "定时投递旧话题" });
      await waitFor(() => expect(oldRow).toHaveAttribute("data-unread", "true"));
      expect(oldRow.querySelector(".waypoint-unread-dot")).not.toBeNull();
      expect(oldRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "700" });

      const listAfter = within(screen.getByRole("complementary", { name: "Topic 列表" }))
        .getAllByRole("button")
        .filter((b) => b.classList.contains("waypoint-topic-row"));
      expect(listAfter.map((b) => b.getAttribute("aria-label"))).toEqual([
        "定时投递旧话题",
        "较新无未读话题",
      ]);

      expect(homeserver.requests.some((r) => r.url.includes("/pushers"))).toBe(false);
      expect(notificationCalls).toEqual([]);
      expect(requestPermissionSpy).not.toHaveBeenCalled();
      expect(setAppBadgeSpy).not.toHaveBeenCalled();

      view.unmount();
    }
  } finally {
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: origNotification });
    if (origSetAppBadge === undefined) {
      delete (navigator as unknown as Record<string, unknown>).setAppBadge;
    } else {
      Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: origSetAppBadge });
    }
  }
});

test("生产适配器 createFetchTransport 与 detectPlatform 正确透传并中止 AbortSignal 且响应页面可见性切换 (#73)", async () => {
  const { createFetchTransport, detectPlatform } = await import("../../adapters/production");
  const user = userEvent.setup();
  let syncCalls = 0;
  const syncSignals: Array<AbortSignal | undefined> = [];

  const origUserAgent = navigator.userAgent;
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 14)",
  });
  let docVis: DocumentVisibilityState = "visible";
  const origVisibilityDesc = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => docVis,
  });

  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/_matrix/client/versions")) {
      return Promise.resolve(new Response(JSON.stringify({ versions: ["v1.11"] }), { status: 200 }));
    }
    if (url.endsWith("/_matrix/client/v3/login") && (!init?.method || init.method === "GET")) {
      return Promise.resolve(
        new Response(JSON.stringify({ flows: [{ type: "m.login.password" }] }), { status: 200 }),
      );
    }
    if (url.endsWith("/_matrix/client/v3/login") && init?.method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ user_id: "@owner:example.com", access_token: "tok-prod", device_id: "DEV-PROD" }),
          { status: 200 },
        ),
      );
    }
    if (url.includes("/_matrix/client/v3/sync")) {
      syncCalls += 1;
      syncSignals.push(init?.signal ?? undefined);
      if (syncCalls === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              next_batch: "batch-prod-1",
              account_data: validAgents,
              rooms: { join: {} },
            }),
            { status: 200 },
          ),
        );
      }
      if (syncCalls === 2) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ next_batch: `batch-prod-${syncCalls}` }), { status: 200 }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });

  try {
    const clock = new ManualClock();
    const view = render(
      <WaypointApp
        homeserver={createFetchTransport()}
        platform={detectPlatform()}
        clock={clock}
      />,
    );

    await login(user);
    await screen.findByText("暂无 Topic");

    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => expect(syncCalls).toBe(2));
    expect(syncSignals[1]).toBeDefined();
    expect(syncSignals[1]?.aborted).toBe(false);

    await act(async () => {
      docVis = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(syncSignals[1]?.aborted).toBe(true);

    await act(async () => {
      docVis = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(syncCalls).toBe(3));
    view.unmount();
  } finally {
    fetchSpy.mockRestore();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: origUserAgent });
    if (origVisibilityDesc) {
      Object.defineProperty(document, "visibilityState", origVisibilityDesc);
    } else {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  }
});

test("审批按钮只认 Agent 预种 reaction 且不猜正文，明确展示会话内与跨 Topic 范围，点选后代发并藏起预种与代发反应 (#57)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const sentReactions: Array<{ url: string; body: unknown }> = [];

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
                "!ap-1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "审批话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$prose-only",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: {
                          msgtype: "m.text",
                          body: "请选择：\n1. 仅此次\n2. 会话内允许\n3. 始终允许\n4. 拒绝",
                        },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$ap-full",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "确认执行 rm -rf /tmp/demo ?" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$seed-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 3010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-full", key: "✅" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$seed-2",
                        sender: "@bot:example.com",
                        origin_server_ts: 3020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-full", key: "🌀" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$seed-3",
                        sender: "@bot:example.com",
                        origin_server_ts: 3030,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-full", key: "♾️" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$seed-4",
                        sender: "@bot:example.com",
                        origin_server_ts: 3040,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-full", key: "❌" } },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$ap-partial",
                        sender: "@bot:example.com",
                        origin_server_ts: 4000,
                        content: { msgtype: "m.text", body: "只种了两档的确认" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$pseed-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 4010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-partial", key: "✅" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$pseed-2",
                        sender: "@bot:example.com",
                        origin_server_ts: 4020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-partial", key: "❌" } },
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
                "!ap-1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.reaction",
                        event_id: "$owner-rx-echo",
                        sender: "@alice:example.com",
                        origin_server_ts: 5000,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-partial", key: "✅" } },
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
    if (input.method === "PUT" && input.url.includes("/send/m.reaction/")) {
      sentReactions.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: { event_id: "$owner-rx-echo" } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "审批话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const proseRow = timeline.querySelector('[data-event-id="$prose-only"]') as HTMLElement;
  const fullRow = timeline.querySelector('[data-event-id="$ap-full"]') as HTMLElement;
  const partialRow = timeline.querySelector('[data-event-id="$ap-partial"]') as HTMLElement;

  // 正文写着 1/2/3/4 也不猜按钮
  expect(within(proseRow).queryAllByRole("button")).toHaveLength(0);

  // $ap-full 是旧审批（因为 $ap-partial 是更新的同一种审批提示），$ap-partial 只有 ✅ 和 ❌
  expect(within(fullRow).getAllByRole("button")).toHaveLength(4);
  expect(within(fullRow).getByRole("button", { name: /仅此次/ })).toBeDisabled();
  const sessionBtn = within(fullRow).getByRole("button", { name: /会话内允许/ });
  expect(sessionBtn).toHaveTextContent(/当前会话/);
  const alwaysBtn = within(fullRow).getByRole("button", { name: /始终允许/ });
  expect(alwaysBtn).toHaveTextContent(/该 Bot 的其他 Topic/);
  expect(within(fullRow).getByRole("button", { name: /拒绝/ })).toBeDisabled();

  // $ap-partial 只渲染实际种下的两档，且预种表情不作为角标显示
  expect(within(partialRow).getAllByRole("button")).toHaveLength(2);
  expect(within(partialRow).queryByRole("button", { name: /会话内允许/ })).not.toBeInTheDocument();
  expect(within(partialRow).queryByRole("button", { name: /始终允许/ })).not.toBeInTheDocument();
  expect(within(partialRow).queryByText("✅")).not.toBeInTheDocument();
  expect(within(partialRow).queryByText("❌")).not.toBeInTheDocument();

  const onceBtn = within(partialRow).getByRole("button", { name: /仅此次/ });
  const denyBtn = within(partialRow).getByRole("button", { name: /拒绝/ });
  expect(onceBtn).toBeEnabled();
  expect(denyBtn).toBeEnabled();

  // 点击「仅此次」，代发 ✅ 并藏起预种与代发表情，按钮停用
  await user.click(onceBtn);
  await waitFor(() => expect(sentReactions).toHaveLength(1));
  expect(sentReactions[0].url).toContain("/rooms/!ap-1%3Aexample.com/send/m.reaction/");
  expect(sentReactions[0].body).toEqual({
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: "$ap-partial",
      key: "✅",
    },
  });
  await waitFor(() => {
    expect(within(partialRow).getByRole("button", { name: /仅此次/ })).toBeDisabled();
    expect(within(partialRow).getByRole("button", { name: /拒绝/ })).toBeDisabled();
  });
  expect(within(partialRow).queryByText("✅")).not.toBeInTheDocument();

  // 同步回声到达后依然隐藏且按钮停用
  await act(async () => { clock.advance(1000); });
  expect(within(partialRow).queryByText("✅")).not.toBeInTheDocument();
  expect(within(partialRow).getByRole("button", { name: /仅此次/ })).toBeDisabled();
});

test("选择器按预种顺序渲染 1 到 10 与 A/B 按钮，点选代发原 reaction 并藏起预种与代发表情 (#57)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  const sentReactions: Array<{ url: string; body: unknown }> = [];

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
                "!sel-1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "选择器话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$sel-num",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "选一个方案" },
                      },
                      ...["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"].map((key, idx) => ({
                        type: "m.reaction",
                        event_id: `$snum-${idx}`,
                        sender: "@bot:example.com",
                        origin_server_ts: 2010 + idx,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$sel-num", key } },
                      })),
                      {
                        type: "m.room.message",
                        event_id: "$sel-ab",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "逆序 A/B 选择" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$sab-b",
                        sender: "@bot:example.com",
                        origin_server_ts: 3010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$sel-ab", key: "🅱️" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$sab-a",
                        sender: "@bot:example.com",
                        origin_server_ts: 3020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$sel-ab", key: "🅰️" } },
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
    if (input.method === "PUT" && input.url.includes("/send/m.reaction/")) {
      sentReactions.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: { event_id: `$rx-${sentReactions.length}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "选择器话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const numRow = timeline.querySelector('[data-event-id="$sel-num"]') as HTMLElement;
  const abRow = timeline.querySelector('[data-event-id="$sel-ab"]') as HTMLElement;

  // $sel-num 是旧选择器（被 $sel-ab 顶掉），仍保留 1..10 顺序且停用
  const numButtons = within(numRow).getAllByRole("button");
  expect(numButtons.map((b) => b.textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  for (const btn of numButtons) {
    expect(btn).toBeDisabled();
  }
  expect(within(numRow).queryByText("1️⃣")).not.toBeInTheDocument();
  expect(within(numRow).queryByText("🔟")).not.toBeInTheDocument();

  // $sel-ab 按种下顺序显示 B, A
  const abButtons = within(abRow).getAllByRole("button");
  expect(abButtons.map((b) => b.textContent)).toEqual(["B", "A"]);
  expect(abButtons[0]).toBeEnabled();
  expect(abButtons[1]).toBeEnabled();
  expect(within(abRow).queryByText("🅱️")).not.toBeInTheDocument();
  expect(within(abRow).queryByText("🅰️")).not.toBeInTheDocument();

  await user.click(abButtons[0]);
  await waitFor(() => expect(sentReactions).toHaveLength(1));
  expect(sentReactions[0].body).toEqual({
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: "$sel-ab",
      key: "🅱️",
    },
  });
  await waitFor(() => {
    expect(within(abRow).getByRole("button", { name: "B" })).toBeDisabled();
    expect(within(abRow).getByRole("button", { name: "A" })).toBeDisabled();
  });
  expect(within(abRow).queryByText("🅱️")).not.toBeInTheDocument();
});

test("预种 reaction 被撤回、跨种类提示互不顶替、不猜超时、且 👀 与原消息 ✅ ❌ 保留原样不变成按钮 (#57)", async () => {
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
                "!stale-1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "停用条件话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$owner-task",
                        sender: "@alice:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "跑一下构建" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$owner-eyes",
                        sender: "@bot:example.com",
                        origin_server_ts: 2010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-task", key: "👀" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$owner-done-ok",
                        sender: "@bot:example.com",
                        origin_server_ts: 2020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-task", key: "✅" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$owner-done-err",
                        sender: "@bot:example.com",
                        origin_server_ts: 2030,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$owner-task", key: "❌" } },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$ap-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "需要审批一" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$ap1-ok",
                        sender: "@bot:example.com",
                        origin_server_ts: 3010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-1", key: "✅" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$ap1-no",
                        sender: "@bot:example.com",
                        origin_server_ts: 3020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-1", key: "❌" } },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$sel-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 4000,
                        content: { msgtype: "m.text", body: "请选其一" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$sel1-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 4010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$sel-1", key: "1️⃣" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$sel1-2",
                        sender: "@bot:example.com",
                        origin_server_ts: 4020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$sel-1", key: "2️⃣" } },
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
        // 撤回 $sel-1 的全部预种 reaction（同时测试撤回其中一条或全部）
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!stale-1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.redaction",
                        event_id: "$red-sel1-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 5000,
                        redacts: "$sel1-1",
                        content: {},
                      },
                      {
                        type: "m.room.redaction",
                        event_id: "$red-sel1-2",
                        sender: "@bot:example.com",
                        origin_server_ts: 5010,
                        redacts: "$sel1-2",
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
        // 新的审批到达，旧审批 $ap-1 才停用
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-3",
            rooms: {
              join: {
                "!stale-1:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ap-2",
                        sender: "@bot:example.com",
                        origin_server_ts: 6000,
                        content: { msgtype: "m.text", body: "新的审批二" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$ap2-ok",
                        sender: "@bot:example.com",
                        origin_server_ts: 6010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-2", key: "✅" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$ap2-no",
                        sender: "@bot:example.com",
                        origin_server_ts: 6020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-2", key: "❌" } },
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

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "停用条件话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const ownerTaskRow = timeline.querySelector('[data-event-id="$owner-task"]') as HTMLElement;
  const ap1Row = timeline.querySelector('[data-event-id="$ap-1"]') as HTMLElement;
  const sel1Row = timeline.querySelector('[data-event-id="$sel-1"]') as HTMLElement;

  // Owner 消息上的 👀、✅、❌ 保留原样，绝不变成按钮
  expect(ownerTaskRow).toHaveTextContent("正在回应");
  expect(within(ownerTaskRow).getByText("✅")).toBeInTheDocument();
  expect(within(ownerTaskRow).getByText("❌")).toBeInTheDocument();
  expect(within(ownerTaskRow).queryAllByRole("button")).toHaveLength(0);

  // 即使有了更新的 selector ($sel-1)，不同种类的 approval ($ap-1) 仍然可用
  expect(within(ap1Row).getByRole("button", { name: /仅此次/ })).toBeEnabled();
  expect(within(sel1Row).getByRole("button", { name: "1" })).toBeEnabled();
  expect(within(sel1Row).getByRole("button", { name: "2" })).toBeEnabled();

  // 推进时间 1 小时（假设只有空 sync）：不猜超时，按钮依然可用
  for (let i = 0; i < 1; i += 1) {
    // 下一轮 sync 2 撤回 $sel-1 的预种表情
    await advanceWhenTimerScheduled(first.clock, 1000);
  }
  await waitFor(() => {
    expect(within(sel1Row).getByRole("button", { name: "1" })).toBeDisabled();
    expect(within(sel1Row).getByRole("button", { name: "2" })).toBeDisabled();
  });
  // $ap-1 仍可用
  expect(within(ap1Row).getByRole("button", { name: /仅此次/ })).toBeEnabled();

  // sync 3 带来更新的审批 $ap-2 -> $ap-1 停用，$ap-2 可用
  await advanceWhenTimerScheduled(first.clock, 1000);
  await waitFor(() => {
    expect(within(ap1Row).getByRole("button", { name: /仅此次/ })).toBeDisabled();
    expect(within(ap1Row).getByRole("button", { name: /拒绝/ })).toBeDisabled();
  });
  const ap2Row = timeline.querySelector('[data-event-id="$ap-2"]') as HTMLElement;
  expect(within(ap2Row).getByRole("button", { name: /仅此次/ })).toBeEnabled();

  // 长时间没有新事件也不猜超时（推进 3600s）
  await act(async () => { first.clock.advance(3600_000); });
  expect(within(ap2Row).getByRole("button", { name: /仅此次/ })).toBeEnabled();

  // 重启恢复后，被撤回的 $sel-1 按钮依然保持停用，且 $ap-2 依然可用
  first.unmount();
  const second = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "停用条件话题" }));
  const timeline2 = screen.getByRole("log", { name: "对话时间线" });
  const sel1Row2 = timeline2.querySelector('[data-event-id="$sel-1"]') as HTMLElement;
  const ap2Row2 = timeline2.querySelector('[data-event-id="$ap-2"]') as HTMLElement;
  expect(within(sel1Row2).getByRole("button", { name: "1" })).toBeDisabled();
  expect(within(sel1Row2).getByRole("button", { name: "2" })).toBeDisabled();
  expect(within(ap2Row2).getByRole("button", { name: /仅此次/ })).toBeEnabled();
  second.unmount();
});

test("代发进队列未成功时可点另一档原地替换不双发，永久 4xx 失败不生成失败气泡只恢复按钮且列表无转圈叹号 (#57)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  let reactionSendMode: "offline" | "reject-403" | "ok" = "offline";
  const attemptedReactions: Array<{ txnId: string; key: string }> = [];
  const acceptedReactions: Array<{ txnId: string; key: string }> = [];

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
                "!rq-1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "队列替换与恢复话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ap-q",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "是否允许写入配置？" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$q-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-q", key: "✅" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$q-2",
                        sender: "@bot:example.com",
                        origin_server_ts: 2020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-q", key: "🌀" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$q-3",
                        sender: "@bot:example.com",
                        origin_server_ts: 2030,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-q", key: "❌" } },
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
    if (input.method === "PUT" && input.url.includes("/send/m.reaction/")) {
      const txnId = input.url.split("/").pop() ?? "";
      const rel = (input.body as Record<string, Record<string, string>>)["m.relates_to"];
      const key = rel.key;
      attemptedReactions.push({ txnId, key });
      if (reactionSendMode === "offline") {
        return { type: "failure", failure: { type: "network" } };
      }
      if (reactionSendMode === "reject-403") {
        return { type: "response", status: 403, body: { errcode: "M_FORBIDDEN", error: "Forbidden" } };
      }
      acceptedReactions.push({ txnId, key });
      return { type: "response", status: 200, body: { event_id: `$rx-${acceptedReactions.length}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  const topicRow = await screen.findByRole("button", { name: "队列替换与恢复话题" });
  await user.click(topicRow);

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const promptRow = timeline.querySelector('[data-event-id="$ap-q"]') as HTMLElement;

  // 1. 断网状态下点「仅此次」，进入重试队列并触发一次失败后退避
  await user.click(within(promptRow).getByRole("button", { name: /仅此次/ }));
  await waitFor(() => expect(attemptedReactions).toHaveLength(1));
  expect(attemptedReactions[0].key).toBe("✅");

  // 列表行绝不出现未确认转圈或失败红叹号
  expect(within(topicRow).queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  expect(within(topicRow).queryByRole("img", { name: "失败" })).not.toBeInTheDocument();

  // 当前已排队的「仅此次」呈已选/停用，但其他两档仍可点击以替换队列
  expect(within(promptRow).getByRole("button", { name: /仅此次/ })).toBeDisabled();
  expect(within(promptRow).getByRole("button", { name: /会话内允许/ })).toBeEnabled();
  const denyBtn = within(promptRow).getByRole("button", { name: /拒绝/ });
  expect(denyBtn).toBeEnabled();

  // 2. 仍在退避队列里时，Owner 改点「拒绝」并把下次请求设为 403 永久拒绝
  reactionSendMode = "reject-403";
  await user.click(denyBtn);
  await waitFor(() => expect(attemptedReactions).toHaveLength(2));
  expect(attemptedReactions[1].key).toBe("❌");
  expect(attemptedReactions[1].txnId).not.toBe(attemptedReactions[0].txnId);

  // 403 永久失败：不生成失败消息气泡、列表无红叹号、三个按钮全部恢复可点
  await waitFor(() => {
    expect(within(promptRow).getByRole("button", { name: /仅此次/ })).toBeEnabled();
    expect(within(promptRow).getByRole("button", { name: /会话内允许/ })).toBeEnabled();
    expect(within(promptRow).getByRole("button", { name: /拒绝/ })).toBeEnabled();
  });
  expect(within(timeline).queryByRole("button", { name: "失败" })).not.toBeInTheDocument();
  expect(within(topicRow).queryByRole("img", { name: "失败" })).not.toBeInTheDocument();

  // 3. 再次断网点「仅此次」-> 在队列中改点「会话内允许」-> 恢复网络 -> 只把「会话内允许」发出去，绝不双发
  reactionSendMode = "offline";
  await user.click(within(promptRow).getByRole("button", { name: /仅此次/ }));
  await waitFor(() => expect(attemptedReactions).toHaveLength(3));
  expect(attemptedReactions[2].key).toBe("✅");

  await user.click(within(promptRow).getByRole("button", { name: /会话内允许/ }));
  await waitFor(() => expect(attemptedReactions).toHaveLength(4));
  expect(attemptedReactions[3].key).toBe("🌀");

  reactionSendMode = "ok";
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(acceptedReactions).toHaveLength(1));
  expect(acceptedReactions[0].key).toBe("🌀");
  expect(acceptedReactions[0].txnId).toBe(attemptedReactions[3].txnId);

  // 确认后按钮停用且无角标
  await waitFor(() => {
    expect(within(promptRow).getByRole("button", { name: /仅此次/ })).toBeDisabled();
    expect(within(promptRow).getByRole("button", { name: /会话内允许/ })).toBeDisabled();
    expect(within(promptRow).getByRole("button", { name: /拒绝/ })).toBeDisabled();
  });
  expect(within(promptRow).queryByText("🌀")).not.toBeInTheDocument();
});

test("单档预种撤回仅停用该档、非提示 reaction 仍可见、且 Topic 不可用时队列中 reaction 静默清理无失败气泡 (#57)", async () => {
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
                "!unavail-rx:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "局部撤回与不可用话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ap-mix",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "含普通表情与局部撤回的审批" },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$mix-thumb",
                        sender: "@bot:example.com",
                        origin_server_ts: 2005,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-mix", key: "👍" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$mix-once",
                        sender: "@bot:example.com",
                        origin_server_ts: 2010,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-mix", key: "✅" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$mix-always",
                        sender: "@bot:example.com",
                        origin_server_ts: 2020,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-mix", key: "♾️" } },
                      },
                      {
                        type: "m.reaction",
                        event_id: "$mix-deny",
                        sender: "@bot:example.com",
                        origin_server_ts: 2030,
                        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ap-mix", key: "❌" } },
                      },
                      {
                        type: "m.room.redaction",
                        event_id: "$red-mix-always",
                        sender: "@bot:example.com",
                        origin_server_ts: 2040,
                        redacts: "$mix-always",
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
      if (syncRound === 2) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!unavail-rx:example.com": {
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
      return { type: "response", status: 200, body: { next_batch: `batch-${syncRound}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.reaction/")) {
      return { type: "failure", failure: { type: "network" } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  const topicRow = await screen.findByRole("button", { name: "局部撤回与不可用话题" });
  const sidebar = screen.getByRole("complementary", { name: "Topic 列表" });
  await user.click(topicRow);

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const promptRow = timeline.querySelector('[data-event-id="$ap-mix"]') as HTMLElement;

  // 普通表情 👍 仍留在气泡下，预种表情不显示为角标
  expect(within(promptRow).getByText("👍")).toBeInTheDocument();
  expect(within(promptRow).queryByText("✅")).not.toBeInTheDocument();

  // 单档 ♾️ 被撤回 -> 仅「始终允许」停用，其余两档仍可点击
  expect(within(promptRow).getByRole("button", { name: /始终允许/ })).toBeDisabled();
  expect(within(promptRow).getByRole("button", { name: /仅此次/ })).toBeEnabled();
  expect(within(promptRow).getByRole("button", { name: /拒绝/ })).toBeEnabled();

  // 点「仅此次」进入退避队列，随后 sync 2 使 Topic 变为不可用 -> 队列内 reaction 静默失败清理，无失败气泡与红叹号
  await user.click(within(promptRow).getByRole("button", { name: /仅此次/ }));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => {
    expect(screen.getByRole("status", { name: "Topic 不可用" })).toBeInTheDocument();
  });
  await act(async () => { clock.advance(1000); });

  expect(within(promptRow).getByRole("button", { name: /仅此次/ })).toBeDisabled();
  expect(within(promptRow).getByRole("button", { name: /拒绝/ })).toBeDisabled();
  expect(within(timeline).queryByRole("button", { name: "失败" })).not.toBeInTheDocument();
  expect(within(sidebar).queryByRole("img", { name: "失败" })).not.toBeInTheDocument();
});

test("发送单个附件：图片用 m.image、文件及音视频用 m.file，说明进正文无说明用文件名，交出时复制字节进本机支持重启后重传 (#62)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let uploadOnline = true;
  let uploadCount = 0;
  const uploadedPayloads: Array<{ url: string; headers: Record<string, string>; bytes: Uint8Array }> = [];
  const sentEvents: Array<{ url: string; body: unknown }> = [];

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
              "!t-att:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "附件发送话题" } },
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
      if (!uploadOnline) {
        return { type: "failure", failure: { type: "network" } };
      }
      uploadCount += 1;
      const bytes = input.body instanceof Uint8Array ? new Uint8Array(input.body) : new Uint8Array();
      uploadedPayloads.push({ url: input.url, headers: input.headers ?? {}, bytes });
      return {
        type: "response",
        status: 200,
        body: { content_uri: `mxc://example.com/media-${uploadCount}` },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      sentEvents.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: { event_id: `$ev-${sentEvents.length}` } };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v1/media/download/")) {
      return {
        type: "response",
        status: 200,
        body: new Uint8Array([1, 2, 3, 4]),
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const app1 = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "附件发送话题" }));

  // 1. 图片 + 说明文字
  const imgBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([imgBytes], "shot.png", { type: "image/png" }),
  );
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "报错截图");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => {
    expect(sentEvents).toHaveLength(1);
  });
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  expect(uploadedPayloads[0]!.url).toBe("https://matrix.example.com/_matrix/media/v3/upload?filename=shot.png");
  expect(uploadedPayloads[0]!.headers.Authorization).toBe("Bearer tok-1");
  expect(uploadedPayloads[0]!.headers["Content-Type"]).toBe("image/png");
  expect(Array.from(uploadedPayloads[0]!.bytes)).toEqual(Array.from(imgBytes));
  expect(sentEvents[0]!.body).toEqual({
    msgtype: "m.image",
    body: "报错截图",
    filename: "shot.png",
    url: "mxc://example.com/media-1",
    info: { mimetype: "image/png", size: imgBytes.byteLength },
  });

  // 2. 语音/视频没有说明时当 m.file 发送，body 用文件名
  const audioBytes = new Uint8Array([73, 68, 51, 3, 0]);
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([audioBytes], "voice.mp3", { type: "audio/mpeg" }),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => {
    expect(sentEvents).toHaveLength(2);
  });
  expect(sentEvents[1]!.body).toEqual({
    msgtype: "m.file",
    body: "voice.mp3",
    filename: "voice.mp3",
    url: "mxc://example.com/media-2",
    info: { mimetype: "audio/mpeg", size: audioBytes.byteLength },
  });

  // 3. 离线交出后字节已复制进设备：重启后无需原 File 对象也能上传并确认
  uploadOnline = false;
  const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]);
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([pdfBytes], "report.pdf", { type: "application/pdf" }),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));

  const timeline1 = screen.getByRole("log", { name: "对话时间线" });
  expect(await within(timeline1).findByText("report.pdf")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();

  app1.unmount();

  uploadOnline = true;
  const app2 = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "附件发送话题" }));

  await waitFor(() => {
    expect(sentEvents).toHaveLength(3);
  });
  expect(Array.from(uploadedPayloads[2]!.bytes)).toEqual(Array.from(pdfBytes));
  expect(sentEvents[2]!.body).toEqual({
    msgtype: "m.file",
    body: "report.pdf",
    filename: "report.pdf",
    url: "mxc://example.com/media-3",
    info: { mimetype: "application/pdf", size: pdfBytes.byteLength },
  });
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  app2.unmount();
});

test("上传成功后记住媒体地址不重复上传，使用固定事务 ID，同步或确认后仍是同一条气泡，且 4xx 失败可原地重发 (#62)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let uploadCalls = 0;
  let uploadMode: "ok" | "4xx" = "ok";
  let sendMode: "500" | "4xx" | "sync-echo" | "ok" = "500";
  const sendAttempts: Array<{ txnId: string; urlField: unknown }> = [];
  let syncRound = 0;
  let lastEchoTxnId: string | undefined;

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
                "!t-retry:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "附件重试话题" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (sendMode === "sync-echo" && lastEchoTxnId) {
        const echoTxn = lastEchoTxnId;
        lastEchoTxnId = undefined;
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: `batch-${syncRound}`,
            rooms: {
              join: {
                "!t-retry:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$echo-att-1",
                        sender: "@alice:example.com",
                        origin_server_ts: 2000,
                        unsigned: { transaction_id: echoTxn },
                        content: {
                          msgtype: "m.file",
                          body: "once.bin",
                          filename: "once.bin",
                          url: "mxc://example.com/remembered-1",
                          info: { mimetype: "application/octet-stream", size: 4 },
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
    if (input.method === "POST" && input.url.includes("/_matrix/media/v3/upload")) {
      uploadCalls += 1;
      if (uploadMode === "4xx") {
        return { type: "response", status: 413, body: { errcode: "M_TOO_LARGE", error: "too big" } };
      }
      return {
        type: "response",
        status: 200,
        body: { content_uri: `mxc://example.com/remembered-${uploadCalls}` },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      const txnId = input.url.split("/").pop()!;
      const body = input.body as { url?: unknown };
      sendAttempts.push({ txnId, urlField: body.url });
      if (sendMode === "500") {
        return { type: "response", status: 500, body: { errcode: "M_UNKNOWN", error: "temporary" } };
      }
      if (sendMode === "4xx") {
        return { type: "response", status: 403, body: { errcode: "M_FORBIDDEN", error: "rejected" } };
      }
      if (sendMode === "sync-echo") {
        lastEchoTxnId = txnId;
        return { type: "failure", failure: { type: "network" } };
      }
      return { type: "response", status: 200, body: { event_id: `$sent-${sendAttempts.length}` } };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const app1 = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "附件重试话题" }));

  // 1. 上传成功但 send 返回 500；重启后继续重发：不重新上传、沿用同一个 txnId、sync 回声确认后仍只有一条气泡
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([new Uint8Array([1, 2, 3, 4])], "once.bin", { type: "application/octet-stream" }),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => {
    expect(uploadCalls).toBe(1);
    expect(sendAttempts).toHaveLength(1);
  });
  expect(sendAttempts[0]!.urlField).toBe("mxc://example.com/remembered-1");

  // 退避重试一次，仍是同一 txnId 且未再上传
  await act(async () => {
    app1.clock.advance(1000);
  });
  await waitFor(() => {
    expect(sendAttempts).toHaveLength(2);
  });
  expect(uploadCalls).toBe(1);
  expect(sendAttempts[1]!.txnId).toBe(sendAttempts[0]!.txnId);
  expect(sendAttempts[1]!.urlField).toBe("mxc://example.com/remembered-1");

  // 重启设备：依然记住已上传地址和同一 txnId，并由 /sync 回声确认成同一条气泡
  app1.unmount();
  sendMode = "sync-echo";
  const app2 = renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "附件重试话题" }));

  await waitFor(() => {
    expect(sendAttempts).toHaveLength(3);
  });
  expect(uploadCalls).toBe(1);
  expect(sendAttempts[2]!.txnId).toBe(sendAttempts[0]!.txnId);
  expect(sendAttempts[2]!.urlField).toBe("mxc://example.com/remembered-1");

  await act(async () => {
    app2.clock.advance(1000);
  });
  const timeline2 = screen.getByRole("log", { name: "对话时间线" });
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  expect(timeline2.querySelectorAll(".waypoint-bubble")).toHaveLength(1);
  expect(timeline2.querySelector("[data-event-id=\"$echo-att-1\"]")).not.toBeNull();

  // 2. 发送阶段 4xx 永久失败后，点红叹号重发仍复用已记住的 mxc://，不重新上传
  sendMode = "4xx";
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([new Uint8Array([5, 6])], "second.txt", { type: "text/plain" }),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));

  const failBtn1 = await screen.findByRole("button", { name: "失败" });
  expect(uploadCalls).toBe(2);

  sendMode = "ok";
  await user.click(failBtn1);
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "失败" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  expect(uploadCalls).toBe(2);
  expect(sendAttempts[sendAttempts.length - 1]!.urlField).toBe("mxc://example.com/remembered-2");

  // 3. 上传阶段 4xx 失败后，点红叹号重发会重新上传已复制的字节并最终确认
  uploadMode = "4xx";
  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([new Uint8Array([7, 8, 9])], "third.txt", { type: "text/plain" }),
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  const failBtn2 = await screen.findByRole("button", { name: "失败" });
  expect(uploadCalls).toBe(3);

  uploadMode = "ok";
  await user.click(failBtn2);
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "失败" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  expect(uploadCalls).toBe(4);
  expect(sendAttempts[sendAttempts.length - 1]!.urlField).toBe("mxc://example.com/remembered-4");
  expect(timeline2.querySelectorAll(".waypoint-bubble")).toHaveLength(3);

  app2.unmount();
});

test("选择器多选多个附件时按选择顺序逐条上传发送 (#62)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const sequence: string[] = [];

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
              "!t-multi:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "多选附件话题" } },
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
      const filename = decodeURIComponent(new URL(input.url).searchParams.get("filename") ?? "");
      sequence.push(`upload:${filename}`);
      return {
        type: "response",
        status: 200,
        body: { content_uri: `mxc://example.com/${filename}` },
      };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      const body = input.body as { msgtype: string; body: string; filename?: string; url?: string };
      sequence.push(`send:${body.msgtype}:${body.filename}:${body.body}`);
      return { type: "response", status: 200, body: { event_id: `$ev-${sequence.length}` } };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v1/media/download/")) {
      return { type: "response", status: 200, body: new Uint8Array([1, 2, 3]) };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "多选附件话题" }));

  const fileInput = screen.getByLabelText("选择附件") as HTMLInputElement;
  expect(fileInput.multiple).toBe(true);

  await user.upload(fileInput, [
    new File([new Uint8Array([1])], "one.txt", { type: "text/plain" }),
    new File([new Uint8Array([2])], "two.png", { type: "image/png" }),
    new File([new Uint8Array([3])], "three.mp4", { type: "video/mp4" }),
  ]);

  await waitFor(() => {
    expect(sequence).toHaveLength(6);
  });
  expect(sequence).toEqual([
    "upload:one.txt",
    "send:m.file:one.txt:one.txt",
    "upload:two.png",
    "send:m.image:two.png:two.png",
    "upload:three.mp4",
    "send:m.file:three.mp4:three.mp4",
  ]);
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline.querySelectorAll(".waypoint-bubble")).toHaveLength(3);
});

test("图片缩在气泡宽度内认证下载、音视频当文件、http(s)不内联，点开交系统查看器且下载媒体不入耐久库 (#62)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const openMediaFile = vi.fn();
  const openExternalUrl = vi.fn();
  const downloadReqs: Array<{ url: string; auth?: string }> = [];
  let failFileDownloadOnce = true;

  const imgBytes = new Uint8Array([10, 20, 30, 40]);
  const docBytes = new Uint8Array([50, 60, 70]);
  const audioBytes = new Uint8Array([80, 90]);
  const videoBytes = new Uint8Array([100, 110]);

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
              "!t-view:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "媒体查看话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$m-img",
                      sender: "@bot:example.com",
                      origin_server_ts: 2000,
                      content: {
                        msgtype: "m.image",
                        body: "架构图",
                        filename: "arch.png",
                        url: "mxc://example.com/img-1",
                        info: { mimetype: "image/png", size: 4 },
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$m-http-img",
                      sender: "@bot:example.com",
                      origin_server_ts: 2100,
                      content: {
                        msgtype: "m.image",
                        body: "外链图不内联",
                        filename: "remote.png",
                        url: "https://evil.example/remote.png",
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$m-file",
                      sender: "@bot:example.com",
                      origin_server_ts: 2200,
                      content: {
                        msgtype: "m.file",
                        body: "spec.pdf",
                        filename: "spec.pdf",
                        url: "mxc://example.com/file-1",
                        info: { mimetype: "application/pdf", size: 3 },
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$m-audio",
                      sender: "@bot:example.com",
                      origin_server_ts: 2300,
                      content: {
                        msgtype: "m.audio",
                        body: "note.ogg",
                        filename: "note.ogg",
                        url: "mxc://example.com/audio-1",
                        info: { mimetype: "audio/ogg", size: 2 },
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$m-video",
                      sender: "@bot:example.com",
                      origin_server_ts: 2400,
                      content: {
                        msgtype: "m.video",
                        body: "demo.mp4",
                        filename: "demo.mp4",
                        url: "mxc://example.com/video-1",
                        info: { mimetype: "video/mp4", size: 2 },
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
    if (input.method === "GET" && input.url.includes("/_matrix/client/v1/media/download/")) {
      downloadReqs.push({ url: input.url, auth: input.headers?.Authorization });
      if (input.url.endsWith("/example.com/img-1")) {
        return { type: "response", status: 200, body: imgBytes };
      }
      if (input.url.endsWith("/example.com/file-1")) {
        if (failFileDownloadOnce) {
          failFileDownloadOnce = false;
          return { type: "failure", failure: { type: "network" } };
        }
        return { type: "response", status: 200, body: docBytes };
      }
      if (input.url.endsWith("/example.com/audio-1")) {
        return { type: "response", status: 200, body: audioBytes };
      }
      if (input.url.endsWith("/example.com/video-1")) {
        return { type: "response", status: 200, body: videoBytes };
      }
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const app1 = renderApp(homeserver, "Waypoint macOS", { openMediaFile, openExternalUrl });
  await login(user);
  await user.click(await screen.findByRole("button", { name: "媒体查看话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });

  // 1. mxc 图片走通信层认证下载并缩在气泡宽度内；非 mxc http(s) 图片不内联；音视频不出现 audio/video 元素
  const imgEl = await within(timeline).findByAltText("arch.png");
  expect(getComputedStyle(imgEl).maxWidth).toBe("100%");
  expect(downloadReqs).toEqual([
    {
      url: "https://matrix.example.com/_matrix/client/v1/media/download/example.com/img-1",
      auth: "Bearer tok-1",
    },
  ]);
  expect(timeline.querySelectorAll("img")).toHaveLength(1);
  expect(timeline.querySelector("img[src^=\"https://\"]")).toBeNull();
  expect(timeline.querySelector("audio")).toBeNull();
  expect(timeline.querySelector("video")).toBeNull();
  expect(within(timeline).getByText("架构图")).toBeInTheDocument();

  // 2. 点击图片直接交给系统查看器（不做画廊），且不重复下载
  await user.click(screen.getByRole("button", { name: "查看图片 arch.png" }));
  await waitFor(() => {
    expect(openMediaFile).toHaveBeenCalledTimes(1);
  });
  expect(openMediaFile).toHaveBeenLastCalledWith({
    data: imgBytes,
    mimeType: "image/png",
    filename: "arch.png",
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(downloadReqs).toHaveLength(1);

  // 3. 点击 http(s) 非 mxc 媒体仅走外链打开
  await user.click(within(timeline).getByRole("button", { name: "remote.png" }));
  expect(openExternalUrl).toHaveBeenCalledWith("https://evil.example/remote.png");

  // 4. 文件、语音、视频仅在点击时才认证下载并交给系统查看器；下载失败轻提示且不崩溃
  await user.click(within(timeline).getByRole("button", { name: "spec.pdf" }));
  expect(await screen.findByText("打开附件失败，请重试。")).toBeInTheDocument();
  expect(openMediaFile).toHaveBeenCalledTimes(1);

  await user.click(within(timeline).getByRole("button", { name: "spec.pdf" }));
  await waitFor(() => {
    expect(openMediaFile).toHaveBeenCalledTimes(2);
  });
  expect(openMediaFile).toHaveBeenLastCalledWith({
    data: docBytes,
    mimeType: "application/pdf",
    filename: "spec.pdf",
  });

  await user.click(within(timeline).getByRole("button", { name: "note.ogg" }));
  await waitFor(() => {
    expect(openMediaFile).toHaveBeenCalledTimes(3);
  });
  expect(openMediaFile).toHaveBeenLastCalledWith({
    data: audioBytes,
    mimeType: "audio/ogg",
    filename: "note.ogg",
  });

  await user.click(within(timeline).getByRole("button", { name: "demo.mp4" }));
  await waitFor(() => {
    expect(openMediaFile).toHaveBeenCalledTimes(4);
  });
  expect(openMediaFile).toHaveBeenLastCalledWith({
    data: videoBytes,
    mimeType: "video/mp4",
    filename: "demo.mp4",
  });

  openMediaFile.mockRejectedValueOnce(new Error("NO_VIEWER_APP"));
  await user.click(within(timeline).getByRole("button", { name: "spec.pdf" }));
  expect(
    await screen.findByText("未找到可打开该附件的应用，请先安装对应的查看器后再试。"),
  ).toBeInTheDocument();

  // 5. 下载下来的媒体文件不写入 IndexedDB；重启后需要重新认证下载
  app1.unmount();
  const countBeforeRestart = downloadReqs.length;
  const app2 = renderApp(homeserver, "Waypoint macOS", { openMediaFile, openExternalUrl });
  await user.click(await screen.findByRole("button", { name: "媒体查看话题" }));
  await waitFor(() => {
    expect(downloadReqs.length).toBeGreaterThan(countBeforeRestart);
  });
  app2.unmount();
});

test("消息正文外链通过系统浏览器打开，不在应用 WebView 内导航，危险协议不作为可点链接 (#62)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const openExternalUrl = vi.fn();

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
              "!t-links:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "外链测试话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$link-1",
                      sender: "@bot:example.com",
                      origin_server_ts: 2000,
                      content: {
                        msgtype: "m.text",
                        body: "查看 [文档](https://docs.example.com/guide) 或联系 [邮箱](mailto:support@example.com) 或 [危险](javascript:alert(1))",
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
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver, "Waypoint macOS", { openExternalUrl });
  await login(user);
  await user.click(await screen.findByRole("button", { name: "外链测试话题" }));

  const docsLink = await screen.findByRole("link", { name: "文档" });
  expect(docsLink).not.toHaveAttribute("target", "_blank");

  let docsDefaultPrevented = false;
  document.addEventListener(
    "click",
    (e) => {
      docsDefaultPrevented = e.defaultPrevented;
    },
    { once: true },
  );
  await user.click(docsLink);
  expect(docsDefaultPrevented).toBe(true);
  expect(openExternalUrl).toHaveBeenCalledWith("https://docs.example.com/guide");

  const mailLink = screen.getByRole("link", { name: "邮箱" });
  await user.click(mailLink);
  expect(openExternalUrl).toHaveBeenCalledWith("mailto:support@example.com");

  expect(screen.queryByRole("link", { name: "危险" })).not.toBeInTheDocument();
});

test("粘贴和拖文件只在 macOS 生效（单文件进草稿、多文件逐条发送），Android 只走选择器 (#62)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const sentFilenames: string[] = [];

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
              "!t-dnd:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "粘贴拖拽话题" } },
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
      const filename = decodeURIComponent(new URL(input.url).searchParams.get("filename") ?? "");
      return { type: "response", status: 200, body: { content_uri: `mxc://example.com/${filename}` } };
    }
    if (input.method === "PUT" && input.url.includes("/send/m.room.message/")) {
      const body = input.body as { filename?: string };
      if (body.filename) {
        sentFilenames.push(body.filename);
      }
      return { type: "response", status: 200, body: { event_id: `$ev-${sentFilenames.length}` } };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v1/media/download/")) {
      return { type: "response", status: 200, body: new Uint8Array([1]) };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  // 1. macOS: 支持粘贴与拖拽（单文件进草稿，多文件按顺序发送）
  const macApp = renderApp(homeserver, "Waypoint macOS");
  await login(user);
  await user.click(await screen.findByRole("button", { name: "粘贴拖拽话题" }));

  const macInput = screen.getByRole("textbox", { name: "输入消息" });
  const pastedSingle = new File([new Uint8Array([1, 2])], "pasted.png", { type: "image/png" });
  fireEvent.paste(macInput, {
    clipboardData: {
      files: [pastedSingle],
      items: [{ kind: "file", getAsFile: () => pastedSingle }],
    },
  });
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("pasted.png");
  await user.click(screen.getByRole("button", { name: "移除附件" }));

  const p1 = new File([new Uint8Array([11])], "paste-1.txt", { type: "text/plain" });
  const p2 = new File([new Uint8Array([12])], "paste-2.txt", { type: "text/plain" });
  fireEvent.paste(macInput, {
    clipboardData: {
      files: [p1, p2],
      items: [
        { kind: "file", getAsFile: () => p1 },
        { kind: "file", getAsFile: () => p2 },
      ],
    },
  });
  await waitFor(() => {
    expect(sentFilenames).toEqual(["paste-1.txt", "paste-2.txt"]);
  });

  const dropZone = screen.getByRole("log", { name: "对话时间线" });
  const droppedSingle = new File([new Uint8Array([3, 4])], "dropped.txt", { type: "text/plain" });
  fireEvent.drop(dropZone, {
    dataTransfer: { files: [droppedSingle] },
  });
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("dropped.txt");
  await user.click(screen.getByRole("button", { name: "移除附件" }));

  const d1 = new File([new Uint8Array([5])], "drop-1.txt", { type: "text/plain" });
  const d2 = new File([new Uint8Array([6])], "drop-2.txt", { type: "text/plain" });
  fireEvent.drop(dropZone, {
    dataTransfer: { files: [d1, d2] },
  });
  await waitFor(() => {
    expect(sentFilenames).toEqual(["paste-1.txt", "paste-2.txt", "drop-1.txt", "drop-2.txt"]);
  });
  macApp.unmount();

  // 2. Android: 粘贴与拖拽文件均不生效，只能用选择器
  globalThis.indexedDB = new IDBFactory();
  const androidApp = renderApp(homeserver, "Waypoint Android");
  await login(user);
  await user.click(await screen.findByRole("button", { name: "粘贴拖拽话题" }));

  const androidInput = screen.getByRole("textbox", { name: "输入消息" });
  const androidPaste = new File([new Uint8Array([7])], "android-paste.png", { type: "image/png" });
  fireEvent.paste(androidInput, {
    clipboardData: {
      files: [androidPaste],
      items: [{ kind: "file", getAsFile: () => androidPaste }],
    },
  });
  const androidDrop = new File([new Uint8Array([8])], "android-drop.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByRole("log", { name: "对话时间线" }), {
    dataTransfer: { files: [androidDrop] },
  });
  await act(async () => {
    androidApp.clock.advance(500);
  });
  expect(screen.queryByRole("region", { name: "已选附件" })).not.toBeInTheDocument();
  expect(sentFilenames).toEqual(["paste-1.txt", "paste-2.txt", "drop-1.txt", "drop-2.txt"]);

  await user.upload(
    screen.getByLabelText("选择附件"),
    new File([new Uint8Array([9])], "android-picker.pdf", { type: "application/pdf" }),
  );
  expect(await screen.findByRole("region", { name: "已选附件" })).toHaveTextContent("android-picker.pdf");
  androidApp.unmount();
});

test("reauthRequired 期间禁用失败消息的感叹号重发按钮且点击不会转成未确认或入队 (#72)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;
  let revokeToken = false;
  let sendAttempts = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncRound += 1;
      if (revokeToken) {
        return {
          type: "response",
          status: 401,
          body: { errcode: "M_UNKNOWN_TOKEN", error: "Token revoked" },
        };
      }
      if (syncRound === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            account_data: validAgents,
            rooms: {
              join: {
                "!reauth-fail:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      {
                        type: "im.waypoint.topic",
                        state_key: "",
                        content: { v: 1, agent_user_id: "@bot:example.com" },
                      },
                      { type: "m.room.name", state_key: "", content: { name: "重连期间禁止重发" } },
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
      return {
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Forbidden" },
      };
    }
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "重连期间禁止重发" }));

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第一条失败消息");
  await user.click(screen.getByRole("button", { name: "发送" }));

  const failedBtn = await screen.findByRole("button", { name: "失败" });
  expect(failedBtn).toBeEnabled();
  expect(sendAttempts).toBe(1);

  revokeToken = true;
  await act(async () => {
    clock.advance(1000);
  });
  await screen.findByRole("status", { name: "重新验证提示" });

  expect(screen.getByRole("button", { name: "失败" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "失败" }));
  await act(async () => {
    clock.advance(1000);
  });

  expect(screen.getByRole("button", { name: "失败" })).toBeDisabled();
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  expect(sendAttempts).toBe(1);
});

test("Agent 消息上的单个 ✅ 或 ❌ 完成反应保留为普通 reaction 徽章，不劫持成审批按钮 (#56 #57)", async () => {
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
          rooms: {
            join: {
              "!single-react:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    {
                      type: "im.waypoint.topic",
                      state_key: "",
                      content: { v: 1, agent_user_id: "@bot:example.com" },
                    },
                    { type: "m.room.name", state_key: "", content: { name: "单反应不劫持话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$agent-done-ok",
                      sender: "@bot:example.com",
                      origin_server_ts: 2000,
                      content: { msgtype: "m.text", body: "任务已完成" },
                    },
                    {
                      type: "m.reaction",
                      event_id: "$rx-single-ok",
                      sender: "@bot:example.com",
                      origin_server_ts: 2010,
                      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-done-ok", key: "✅" } },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$agent-done-err",
                      sender: "@bot:example.com",
                      origin_server_ts: 3000,
                      content: { msgtype: "m.text", body: "任务失败了" },
                    },
                    {
                      type: "m.reaction",
                      event_id: "$rx-single-err",
                      sender: "@bot:example.com",
                      origin_server_ts: 3010,
                      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-done-err", key: "❌" } },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$agent-real-ap",
                      sender: "@bot:example.com",
                      origin_server_ts: 4000,
                      content: { msgtype: "m.text", body: "需要审批确认" },
                    },
                    {
                      type: "m.reaction",
                      event_id: "$rx-ap-ok",
                      sender: "@bot:example.com",
                      origin_server_ts: 4010,
                      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-real-ap", key: "✅" } },
                    },
                    {
                      type: "m.reaction",
                      event_id: "$rx-ap-no",
                      sender: "@bot:example.com",
                      origin_server_ts: 4020,
                      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$agent-real-ap", key: "❌" } },
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
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "单反应不劫持话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const okRow = timeline.querySelector("[data-event-id=\"$agent-done-ok\"]") as HTMLElement;
  const errRow = timeline.querySelector("[data-event-id=\"$agent-done-err\"]") as HTMLElement;
  const apRow = timeline.querySelector("[data-event-id=\"$agent-real-ap\"]") as HTMLElement;

  expect(within(okRow).queryByRole("group", { name: "审批操作" })).not.toBeInTheDocument();
  expect(within(okRow).queryAllByRole("button")).toHaveLength(0);
  expect(okRow.querySelector(".waypoint-message-reaction")).toHaveTextContent("✅");

  expect(within(errRow).queryByRole("group", { name: "审批操作" })).not.toBeInTheDocument();
  expect(within(errRow).queryAllByRole("button")).toHaveLength(0);
  expect(errRow.querySelector(".waypoint-message-reaction")).toHaveTextContent("❌");

  expect(within(apRow).getByRole("group", { name: "审批操作" })).toBeInTheDocument();
  expect(within(apRow).getByRole("button", { name: /仅此次/ })).toBeEnabled();
  expect(within(apRow).getByRole("button", { name: /拒绝/ })).toBeEnabled();
});

test("已停在存在中间 limited 缺口的 Topic 底部时，新同步消息到达不会把视口向上拉回旧的 firstUnreadEventId (#64 #65)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncRound = 0;

  const makeAgentMsg = (id: string, body: string, ts: number) => ({
    type: "m.room.message",
    event_id: id,
    sender: "@bot:example.com",
    origin_server_ts: ts,
    content: { msgtype: "m.text", body },
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
                "!mid-gap-stay:example.com": {
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$m1" } }],
                  },
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      {
                        type: "im.waypoint.topic",
                        state_key: "",
                        content: { v: 1, agent_user_id: "@bot:example.com" },
                      },
                      { type: "m.room.name", state_key: "", content: { name: "中间缺口底部留驻话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      makeAgentMsg("$m1", "m-1", 2000),
                      makeAgentMsg("$m2", "m-2", 2100),
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
                "!mid-gap-stay:example.com": {
                  timeline: {
                    limited: true,
                    prev_batch: "pb-mid-stay",
                    events: [
                      makeAgentMsg("$m10", "m-10", 5000),
                      makeAgentMsg("$m11", "m-11", 5100),
                      makeAgentMsg("$m12", "m-12", 5200),
                      makeAgentMsg("$m13", "m-13", 5300),
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
                "!mid-gap-stay:example.com": {
                  timeline: {
                    events: [makeAgentMsg("$m14", "m-14", 6000)],
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

  await withMockedTimelineLayout(100, 200, async () => {
    const { clock } = renderApp(homeserver);
    await login(user);

    const row = await screen.findByRole("button", { name: "中间缺口底部留驻话题" });
    await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
    await act(async () => {
      clock.advance(1000);
    });
    await waitFor(() => expect(syncRound).toBe(2));

    await user.click(row);
    const timeline = screen.getByRole("log", { name: "对话时间线" });
    await waitFor(() => {
      expect(timeline.querySelectorAll("[data-side]")).toHaveLength(6);
    });

    // Owner 主动滚到底部 (scrollTop=400, 视口 400..600)
    await act(async () => {
      timeline.scrollTop = 400;
      fireEvent.scroll(timeline);
    });
    expect(timeline.scrollTop).toBe(400);

    // 增量 sync 3 带来新消息 $m14：绝不能把视口向上拉回 $m10 (200)
    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => {
      expect(timeline).toHaveTextContent("m-14");
    });
    expect(timeline.scrollTop).toBe(500);
  });
});

test("无游标回退 sync 返回 limited: true 且与现有时间线重叠时不伪造断层、不阻断已读位置推进 (#60 #64 #65)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  const readMarkerPosts: Array<{ url: string; body: unknown }> = [];

  const makeAgentMsg = (id: string, body: string, ts: number) => ({
    type: "m.room.message",
    event_id: id,
    sender: "@bot:example.com",
    origin_server_ts: ts,
    content: { msgtype: "m.text", body },
  });

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
                "!overlap-sync:example.com": {
                  account_data: {
                    events: [{ type: "m.fully_read", content: { event_id: "$e2" } }],
                  },
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      {
                        type: "im.waypoint.topic",
                        state_key: "",
                        content: { v: 1, agent_user_id: "@bot:example.com" },
                      },
                      { type: "m.room.name", state_key: "", content: { name: "回退重叠不伪造缺口" } },
                    ],
                  },
                  timeline: {
                    events: [
                      makeAgentMsg("$e1", "e-1", 2000),
                      makeAgentMsg("$e2", "e-2", 2100),
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
          status: 400,
          body: { errcode: "M_UNKNOWN", error: "Invalid since token" },
        };
      }
      if (syncCalls === 3) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-fallback",
            rooms: {
              join: {
                "!overlap-sync:example.com": {
                  timeline: {
                    limited: true,
                    prev_batch: "pb-overlap",
                    events: [
                      makeAgentMsg("$e1", "e-1", 2000),
                      makeAgentMsg("$e2", "e-2", 2100),
                      makeAgentMsg("$e3", "e-3", 2200),
                      makeAgentMsg("$e4", "e-4", 2300),
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
    if (input.method === "POST" && input.url.includes("/read_markers")) {
      readMarkerPosts.push({ url: input.url, body: input.body });
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  await withMockedTimelineLayout(100, 400, async () => {
    const { clock } = renderApp(homeserver);
    await login(user);

    const row = await screen.findByRole("button", { name: "回退重叠不伪造缺口" });
    await advanceWhenTimerScheduled(clock, 1000);
    await waitFor(() => expect(syncCalls).toBe(3));
    expect(row).toHaveAttribute("data-unread", "true");

    await user.click(row);
    const timeline = screen.getByRole("log", { name: "对话时间线" });
    await waitFor(() => {
      expect(timeline.querySelectorAll("[data-side]")).toHaveLength(4);
    });

    await waitFor(() => {
      expect(readMarkerPosts).toContainEqual({
        url: "https://matrix.example.com/_matrix/client/v3/rooms/!overlap-sync%3Aexample.com/read_markers",
        body: { "m.fully_read": "$e4", "m.read.private": "$e4" },
      });
    });
    expect(row).not.toHaveAttribute("data-unread", "true");
  });
});

test("Tauri 环境下外链打开失败绝不静默回退到 window.open，且打开媒体走系统查看器命令 open_media_file (#48 #62)", async () => {
  const prevIsTauri = (globalThis as { isTauri?: boolean }).isTauri;
  const prevInternals = (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  const invokeSpy = vi.fn();

  try {
    (globalThis as { isTauri?: boolean }).isTauri = true;
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: unknown) => invokeSpy(cmd, args),
    };

    const platform = detectPlatform();

    invokeSpy.mockRejectedValueOnce(new Error("opener failed"));
    await expect(platform.openExternalUrl!("https://docs.example.com/guide")).rejects.toThrow("opener failed");
    expect(invokeSpy).toHaveBeenCalledWith("plugin:opener|open_url", {
      url: "https://docs.example.com/guide",
    });
    expect(openSpy).not.toHaveBeenCalled();

    invokeSpy.mockResolvedValueOnce(undefined);
    await platform.openMediaFile!({
      data: new Uint8Array([1, 2, 3]),
      mimeType: "application/pdf",
      filename: "report.pdf",
    });
    expect(invokeSpy).toHaveBeenLastCalledWith("open_media_file", {
      bytes: [1, 2, 3],
      filename: "report.pdf",
      mimeType: "application/pdf",
    });
    expect(openSpy).not.toHaveBeenCalled();

    invokeSpy.mockRejectedValueOnce(new Error("open_media_file failed"));
    await expect(
      platform.openMediaFile!({
        data: new Uint8Array([4, 5]),
        mimeType: "image/png",
        filename: "shot.png",
      }),
    ).rejects.toThrow("open_media_file failed");
    expect(openSpy).not.toHaveBeenCalled();
  } finally {
    openSpy.mockRestore();
    if (prevIsTauri === undefined) {
      delete (globalThis as { isTauri?: boolean }).isTauri;
    } else {
      (globalThis as { isTauri?: boolean }).isTauri = prevIsTauri;
    }
    if (prevInternals === undefined) {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    } else {
      (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = prevInternals;
    }
  }
});

test("已进入 Topic 列表后刷新重开，不等下一次 sync 完成就立即进入 Topic 列表并展示本地缓存，同时后台发起增量 sync (#48)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  const heldSync = deferred<TransportResult>();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      if (syncCalls === 1) {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-cached",
            account_data: validAgents,
            rooms: {
              join: {
                "!cached:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "本地缓存话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$ev-cached-1",
                        sender: "@bot:example.com",
                        origin_server_ts: 2000,
                        content: { msgtype: "m.text", body: "缓存里的消息" },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return heldSync.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  expect(await screen.findByRole("button", { name: /本地缓存话题/ })).toBeInTheDocument();
  first.unmount();

  // 刷新重开时让下一次 /sync 挂起不返回：应立即看到 Topic 列表而非「尚未进入 Topic 列表」
  renderApp(homeserver);
  expect(await screen.findByRole("button", { name: /本地缓存话题/ })).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.queryByText("尚未进入 Topic 列表")).not.toBeInTheDocument();

  await waitFor(() => {
    expect(syncCalls).toBe(2);
  });
  expect(
    homeserver.requests.filter((r) => r.url.includes("/sync")).at(-1)?.url,
  ).toBe("https://matrix.example.com/_matrix/client/v3/sync?since=batch-cached");

  await user.click(screen.getByRole("button", { name: /本地缓存话题/ }));
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("缓存里的消息");
});

test("桌面宽视口下通过 Esc 键与点击毛玻璃遮罩关闭「新建 Topic」与「设置」模态弹窗，保持底层对话上下文连贯 (#81)", async () => {
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
          rooms: {
            join: {
              "!desktop-modal:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "模态弹窗话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "-modal-1",
                      sender: "@bot:example.com",
                      origin_server_ts: 2000,
                      content: { msgtype: "m.text", body: "底层阅读上下文消息" },
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

  renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "模态弹窗话题" }));
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("底层阅读上下文消息");

  // 打开「新建 Topic」：弹出居中模态弹窗，底层内容保持挂载
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  const createModal = screen.getByRole("region", { name: "新建 Topic" });
  expect(createModal).toBeVisible();
  expect(createModal).toHaveAttribute("aria-modal", "true");
  expect(document.querySelector(".waypoint-modal-backdrop")).not.toBeNull();

  // 按 Esc 键关闭新建弹窗，底层上下文保持可见
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("底层阅读上下文消息");

  // 再次打开并点击遮罩外部关闭
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
  fireEvent.click(document.querySelector(".waypoint-modal-backdrop")!);
  expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();

  // 打开「设置」：弹出居中模态弹窗
  await user.click(screen.getByRole("button", { name: "设置" }));
  const settingsModal = screen.getByRole("region", { name: "设置" });
  expect(settingsModal).toBeVisible();
  expect(settingsModal).toHaveAttribute("aria-modal", "true");

  // 按 Esc 键退出设置
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "设置" })).not.toBeInTheDocument();
  expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("底层阅读上下文消息");
});

test("桌面端回车直接发送消息，且未选 Topic 时展示 Muse 式引导卡与 Alt+N 快捷键提示并支持快捷键触发新建 (#81)", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const sendCalls: Array<{ url: string; body: unknown }> = [];

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
              "!enter-send:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "回车发送话题" } },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.url.includes("/send/")) {
      sendCalls.push({ url: input.url, body: typeof input.body === "string" ? JSON.parse(input.body) : input.body });
      return {
        type: "response",
        status: 200,
        body: { event_id: `-sent-${sendCalls.length}` },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  // 未选 Topic 时展示 Muse 式引导卡与快捷键提示
  const emptyGuide = await screen.findByRole("region", { name: "Topic 引导" });
  expect(emptyGuide).toHaveTextContent("Alt + N");
  expect(within(emptyGuide).getByRole("button", { name: "新建一条 Topic" })).toBeInTheDocument();

  // 触发 Alt+N 快捷键打开新建 Topic 弹窗
  fireEvent.keyDown(window, { key: "n", altKey: true });
  expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();

  // 进入话题输入消息：Enter 直接发送
  await user.click(screen.getByRole("button", { name: "回车发送话题" }));
  const inputEl = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(inputEl, "回车直接发出");
  fireEvent.keyDown(inputEl, { key: "Enter", code: "Enter" });

  await waitFor(() => {
    expect(sendCalls.length).toBe(1);
    expect((sendCalls[0]?.body as { body?: string })?.body).toBe("回车直接发出");
  });

  // Shift + Enter 不发送消息
  await user.type(inputEl, "第二条消息");
  fireEvent.keyDown(inputEl, { key: "Enter", code: "Enter", shiftKey: true });
  expect(sendCalls.length).toBe(1);
});

test("CSS Design Tokens 验证：包含 Grokbot Light/Dark 语义变量定义，无未声明硬编码色值 (#81 #90)", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const css = readFileSync(resolve((globalThis as unknown as { process: { cwd: () => string } }).process.cwd(), "src/App.css"), "utf-8");

  // 验证关键 Grokbot 语义 Token 声明
  const requiredTokens = [
    "--background",
    "--foreground",
    "--card",
    "--popover",
    "--primary",
    "--primary-foreground",
    "--secondary",
    "--muted",
    "--muted-foreground",
    "--accent",
    "--destructive",
    "--border",
    "--input",
    "--ring",
    "--warning",
    "--warning-foreground",
    "--warning-border",
  ];
  for (const token of requiredTokens) {
    expect(css).toContain(`${token}:`);
  }

  // 验证系统暗黑模式与显式暗黑主题声明
  expect(css).toContain("@media (prefers-color-scheme: dark)");
  expect(css).toContain(".dark");
  expect(css).toContain('[data-theme="dark"]');

  // 验证规则体内无硬编码十六进制色值（仅允许在 :root 变量定义区出现）
  const lines = css.split(String.fromCharCode(10));
  let insideRootTokens = false;
  const offendingLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === ":root {") {
      insideRootTokens = true;
    }
    if (insideRootTokens && line.trim() === "}") {
      insideRootTokens = false;
    }
    if (!insideRootTokens && /#[0-9a-fA-F]{3,8}\b/.test(line)) {
      offendingLines.push(line.trim());
    }
  }
  expect(offendingLines).toEqual([]);
});

test("输入框处于单行与多行临界宽度时不会因 padding 变化触发 Maximum update depth exceeded 白屏 (#84)", async () => {
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
          rooms: {
            join: {
              "!borderline:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "临界宽度话题" } },
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

  const origClientWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const origGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const origGetComputedStyle = window.getComputedStyle;

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      if ((this as HTMLElement).classList?.contains("waypoint-composer")) {
        return 407;
      }
      return origClientWidthDesc?.get ? origClientWidthDesc.get.call(this) : 0;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "SPAN" && this.style.whiteSpace === "pre") {
      return {
        width: this.textContent === "borderline-draft" ? 250 : 320,
        height: 24,
        top: 0,
        left: 0,
        bottom: 24,
        right: 250,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return origGetBoundingClientRect.call(this);
  });
  vi.spyOn(window, "getComputedStyle").mockImplementation((elt, pseudoElt) => {
    const style = origGetComputedStyle(elt, pseudoElt);
    if ((elt as HTMLElement).classList?.contains("waypoint-composer")) {
      const isMultiline = (elt as HTMLElement).classList.contains("multiline");
      return new Proxy(style, {
        get(target, prop) {
          if (prop === "paddingLeft" || prop === "paddingRight") {
            return isMultiline ? "16px" : "48px";
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return style;
  });

  try {
    renderApp(homeserver, "Waypoint Android", { viewportMode: () => "narrow" });
    await login(user);
    await user.click(await screen.findByRole("button", { name: "临界宽度话题" }));

    const inputEl = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(inputEl, "borderline-draft");
    expect(inputEl).toHaveValue("borderline-draft");

    await user.clear(inputEl);
    await user.type(inputEl, "exceeds-single-line");
    const form = document.querySelector("form.waypoint-composer") as HTMLFormElement;
    expect(form).toHaveClass("multiline");
  } finally {
    if (origClientWidthDesc) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", origClientWidthDesc);
    }
    vi.restoreAllMocks();
  }
});
