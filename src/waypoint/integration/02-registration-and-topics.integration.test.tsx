import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { TransportResult } from "../../adapters/types";
import { WaypointApp } from "../WaypointApp";
import {
  setupIntegrationTestEnv,
  FakeHomeserver,
  ManualClock,
  deferred,
  enterRegistration,
  login,
  passwordLoginHandler,
  renderApp,
  validAgents,
} from "./harness";

setupIntegrationTestEnv();

test("名册条目可以没有手写名，只要用户 ID 合法就进入列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = passwordLoginHandler(async () => ({
    type: "response",
    status: 200,
    body: {
      next_batch: "batch-3",
      account_data: {
        events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com" }] } }],
      },
    },
  }));
  renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户名"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
});

test("已经同步过再打开时，继续用同步游标，不改去 well_known，也不再要密码", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
  homeserver.handler = passwordLoginHandler(async (input) => {
    syncs += 1;
    if (syncs === 1) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-kept",
          account_data: {
            events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com" }] } }],
          },
        },
      };
    }
    if (!input.url.includes("since=batch-kept")) {
      throw new Error(`续同步没有带上游标：${input.url}`);
    }
    return {
      type: "response",
      status: 200,
      body: { next_batch: "batch-next" },
    };
  });
  const first = renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户名"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(homeserver.requests.find((request) => request.url.includes("/sync"))?.url).toBe(
    "https://matrix.example.com/_matrix/client/v3/sync",
  );
  first.unmount();

  renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  await waitFor(() => {
    const continued = homeserver.requests.filter((request) => request.url.includes("/sync"));
    expect(continued.at(-1)?.url).toBe("https://matrix.example.com/_matrix/client/v3/sync?since=batch-kept");
    expect(continued.at(-1)?.headers.Authorization).toBe("Bearer tok-1");
  });
  expect(homeserver.requests.some((request) => request.url.includes("/account_data"))).toBe(false);
  expect(homeserver.requests.some((request) => request.url.includes("/profile"))).toBe(false);
});

test("开发模式重挂载中止已有游标的前台同步后，仍会再同步并刷新列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let phase: "login" | "restore" = "login";
  homeserver.handler = passwordLoginHandler(async (input) => {
    if (!input.url.includes("/sync")) {
      throw new Error(input.url);
    }
    if (phase === "login") {
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
                    {
                      type: "im.waypoint.topic",
                      state_key: "",
                      content: { v: 1, agent_user_id: "@bot:example.com" },
                    },
                    { type: "m.room.name", state_key: "", content: { name: "旧话题" } },
                  ],
                },
              },
            },
          },
        },
      };
    }
    await Promise.resolve();
    if (input.signal?.aborted) {
      return new Promise(() => {});
    }
    return {
      type: "response",
      status: 200,
      body: {
        next_batch: "batch-2",
        rooms: {
          join: {
            "!t1:example.com": {
              state: {
                events: [{ type: "m.room.name", state_key: "", content: { name: "刷新后的话题" } }],
              },
            },
          },
        },
      },
    };
  });

  const first = renderApp(homeserver);
  await login(user);
  expect(await screen.findByRole("button", { name: "旧话题" })).toBeInTheDocument();
  first.unmount();

  phase = "restore";
  const clock = new ManualClock();
  render(
    <StrictMode>
      <WaypointApp
        homeserver={homeserver}
        platform={{ deviceDisplayName: "Waypoint macOS" }}
        clock={clock}
      />
    </StrictMode>,
  );

  expect(await screen.findByRole("button", { name: "刷新后的话题" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "旧话题" })).not.toBeInTheDocument();
});

test("增量同步只有别的 account data 时，仍留在 Topic 列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
  homeserver.handler = passwordLoginHandler(async (input) => {
    syncs += 1;
    if (syncs === 1) {
      return {
        type: "response",
        status: 200,
        body: { next_batch: "batch-kept", account_data: validAgents },
      };
    }
    if (!input.url.includes("since=batch-kept")) {
      throw new Error(input.url);
    }
    return {
      type: "response",
      status: 200,
      body: {
        next_batch: "batch-direct",
        account_data: { events: [{ type: "m.direct", content: { "@bot:example.com": ["!room:example.com"] } }] },
      },
    };
  });
  const first = renderApp(homeserver);
  await login(user);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  first.unmount();

  renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
});

test("快照没有合法 Agent 时，再打开的增量同步仍不进入列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
  homeserver.handler = passwordLoginHandler(async (input) => {
    syncs += 1;
    if (syncs === 1) {
      return { type: "response", status: 200, body: { next_batch: "batch-empty" } };
    }
    if (!input.url.includes("since=batch-empty")) {
      throw new Error(input.url);
    }
    return { type: "response", status: 200, body: { next_batch: "batch-empty-2" } };
  });
  const first = renderApp(homeserver);
  await login(user);
  await waitFor(() => {
    expect(homeserver.requests.some((request) => request.url.includes("/sync"))).toBe(true);
  });
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  first.unmount();

  renderApp(homeserver);
  await waitFor(() => {
    expect(homeserver.requests.some((request) => request.url.includes("since=batch-empty"))).toBe(true);
  });
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
});

test("增量同步带来合法 Agent 时进入列表，换成不合法条目时离开", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
  homeserver.handler = passwordLoginHandler(async (input) => {
    syncs += 1;
    if (syncs === 1) {
      return { type: "response", status: 200, body: { next_batch: "batch-hold" } };
    }
    if (syncs === 2) {
      if (!input.url.includes("since=batch-hold")) {
        throw new Error(input.url);
      }
      return { type: "response", status: 200, body: { next_batch: "batch-joined", account_data: validAgents } };
    }
    if (!input.url.includes("since=batch-joined")) {
      throw new Error(input.url);
    }
    return {
      type: "response",
      status: 200,
      body: {
        next_batch: "batch-cleared",
        account_data: { events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@alice:example.com" }] } }] },
      },
    };
  });
  const first = renderApp(homeserver);
  await login(user);
  await waitFor(() => {
    expect(homeserver.requests.some((request) => request.url.includes("/sync"))).toBe(true);
  });
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  first.unmount();

  const second = renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  second.unmount();

  renderApp(homeserver);
  await waitFor(() => {
    expect(homeserver.requests.some((request) => request.url.includes("since=batch-joined"))).toBe(true);
  });
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
});

test("立刻再试作废还在路上的失败，迟到的失败不能离开 Topic 列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const firstSync = deferred<TransportResult>();
  let syncs = 0;
  homeserver.handler = passwordLoginHandler(async () => {
    syncs += 1;
    if (syncs === 1) {
      return firstSync.promise;
    }
    return { type: "response", status: 200, body: { next_batch: "batch-retry", account_data: validAgents } };
  });
  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "立刻再试" }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();

  await act(async () => {
    firstSync.resolve({ type: "failure", failure: { type: "network" } });
  });
  expect(screen.getByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.queryByText("无法连接到服务器，请检查网络或地址。")).not.toBeInTheDocument();
  const initialSyncCount = homeserver.requests.filter((request) => request.url.endsWith("/_matrix/client/v3/sync")).length;
  await act(async () => {
    clock.advance(60_000);
  });
  expect(homeserver.requests.filter((request) => request.url.endsWith("/_matrix/client/v3/sync"))).toHaveLength(initialSyncCount);
  const laterSyncs = homeserver.requests.filter((request) => request.url.includes("/sync")).slice(initialSyncCount);
  expect(laterSyncs.every((request) => request.url.includes("since=batch-retry"))).toBe(true);
});

test("迟到的未知 token 不能清掉更新一次同步已经留下的登录", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const firstSync = deferred<TransportResult>();
  let syncs = 0;
  homeserver.handler = passwordLoginHandler(async (input) => {
    syncs += 1;
    if (syncs === 1) {
      return firstSync.promise;
    }
    if (input.url.includes("since=")) {
      return { type: "response", status: 200, body: { next_batch: "batch-ok-2" } };
    }
    return { type: "response", status: 200, body: { next_batch: "batch-ok", account_data: validAgents } };
  });
  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "立刻再试" }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();

  await act(async () => {
    firstSync.resolve({
      type: "response",
      status: 401,
      body: { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" },
    });
  });
  expect(screen.getByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  first.unmount();

  renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  await waitFor(() => {
    const continued = homeserver.requests.filter((request) => request.url.includes("/sync"));
    expect(continued.at(-1)?.url).toContain("since=batch-ok");
    expect(continued.at(-1)?.headers.Authorization).toBe("Bearer tok-1");
  });
});

test("首次登记允许同服 localpart 自动补全，并拒绝空值、残缺 ID、邮箱/电话、跨服或大小写不同的 server name，以及 Owner 自己，且不请求 profile", async () => {
  const user = userEvent.setup();
  {
    const homeserver = new FakeHomeserver();
    const view = renderApp(homeserver);
    const input = await enterRegistration(user, homeserver, "@alice:example.com");
    const submitBtn = screen.getByRole("button", { name: /登记/ });
    expect(submitBtn).toBeDisabled();
    await user.type(input, "   ");
    expect(submitBtn).toBeDisabled();
    view.unmount();
  }

  const cases = [
    { owner: "@alice:example.com", typed: "bot:example.com", reason: "有效的 Bot 用户名" },
    { owner: "@alice:example.com", typed: "@bot", reason: "有效的 Bot 用户名" },
    { owner: "@alice:example.com", typed: "@bot:", reason: "有效的 Bot 用户名" },
    { owner: "@alice:example.com", typed: "@:example.com", reason: "有效的 Bot 用户名" },
    { owner: "@alice:example.com", typed: "bot@example.com", reason: "有效的 Bot 用户名" },
    { owner: "@alice:example.com", typed: "+8613800138000", reason: "有效的 Bot 用户名" },
    { owner: "@alice:example.com", typed: "@bot:other.example", reason: "同一台 Homeserver" },
    { owner: "@alice:example.com", typed: "@bot:EXAMPLE.COM", reason: "同一台 Homeserver" },
    { owner: "@alice:example.com:8448", typed: "@bot:example.com", reason: "同一台 Homeserver" },
    { owner: "@alice:example.com", typed: "@alice:example.com", reason: "不能将自己登记为 Bot" },
    { owner: "@alice:example.com", typed: "alice", reason: "不能将自己登记为 Bot" },
  ];

  for (const item of cases) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    const view = renderApp(homeserver);
    const input = await enterRegistration(user, homeserver, item.owner);
    const requestCountBeforeSubmit = homeserver.requests.length;

    await user.type(input, item.typed);
    await user.click(screen.getByRole("button", { name: /登记/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(item.reason);
    expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    expect(homeserver.requests).toHaveLength(requestCountBeforeSubmit);
    expect(homeserver.requests.some((request) => request.url.includes("/profile"))).toBe(false);
    view.unmount();
  }
});

test("首次登记输入 Bot 的 localpart 时自动按 Owner server name 补全（保留大小写与端口）并写入名册", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let writtenBody: unknown;
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
        body: { user_id: "@alice:example.com:8448", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      return { type: "response", status: 200, body: { next_batch: "batch-1" } };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com%3A8448/account_data/im.waypoint.agents")
    ) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com%3A8448/account_data/im.waypoint.agents")
    ) {
      writtenBody = input.body;
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };

  renderApp(homeserver);
  await login(user);
  const input = await screen.findByLabelText("Bot 用户名");
  expect(input).not.toHaveAttribute("placeholder");
  await user.type(input, "  NewBot  ");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(writtenBody).toEqual({ agents: [{ user_id: "@NewBot:example.com:8448" }] });
});

test("提交登记前再读名册时若已有合法 Agent，不再写入且不清理其余条目，丢掉已填 ID 直接进列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
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
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      syncs += 1;
      return {
        type: "response",
        status: 200,
        body: { next_batch: syncs === 1 ? "batch-1" : "batch-2" },
      };
    }
    if (
      input.method === "GET" &&
      input.url ===
        "https://matrix.example.com/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents"
    ) {
      return {
        type: "response",
        status: 200,
        body: {
          agents: [
            { user_id: "bad" },
            { user_id: "@other:elsewhere.example" },
            { user_id: "@existing:example.com", name: "已存在" },
          ],
          extra: "keep",
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const first = renderApp(homeserver);
  await login(user);
  const input = await screen.findByLabelText("Bot 用户名");
  await user.type(input, "@NewBot:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.queryByText("尚未进入 Topic 列表")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Bot 用户名")).not.toBeInTheDocument();
  expect(homeserver.requests.some((request) => request.method === "PUT")).toBe(false);
  expect(homeserver.requests.some((request) => request.url.includes("createRoom"))).toBe(false);
  expect(homeserver.requests.some((request) => request.url.includes("/profile"))).toBe(false);
  const readReq = homeserver.requests.find((request) => request.url.includes("/account_data/im.waypoint.agents"));
  expect(readReq?.headers.Authorization).toBe("Bearer tok-1");

  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
});

test("名册为 404 时不当成用户不存在，去掉前后空白并保留大小写写入后立刻进列表，不自动建 Topic 也不接着登记第二个", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
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
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      syncs += 1;
      return {
        type: "response",
        status: 200,
        body: { next_batch: syncs === 1 ? "batch-1" : "batch-2" },
      };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return {
        type: "response",
        status: 404,
        body: { errcode: "M_NOT_FOUND", error: "Account data not found" },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const first = renderApp(homeserver);
  await login(user);
  const input = await screen.findByLabelText("Bot 用户名");
  await user.type(input, "  @MyBot:example.com  ");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.queryByText("尚未进入 Topic 列表")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Bot 用户名")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /登记/ })).not.toBeInTheDocument();
  expect(homeserver.requests.some((request) => request.url.includes("createRoom"))).toBe(false);
  expect(homeserver.requests.some((request) => request.url.includes("/profile"))).toBe(false);

  const put = homeserver.requests.find((request) => request.method === "PUT");
  expect(put).toMatchObject({
    method: "PUT",
    url: "https://matrix.example.com/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents",
    headers: { Authorization: "Bearer tok-1" },
    body: { agents: [{ user_id: "@MyBot:example.com" }] },
  });

  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
});

test("提交前重读发现只有不合法条目时，保留原有条目并追加新登记的 Bot，提交期间锁定防连点", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const putDeferred = deferred<TransportResult>();
  homeserver.handler = async (input) => {
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return {
        type: "response",
        status: 200,
        body: {
          agents: [{ user_id: "@other:elsewhere.example" }, { user_id: "@alice:example.com" }],
          extra: "kept",
        },
      };
    }
    if (input.method === "PUT") {
      return putDeferred.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver);
  const input = await enterRegistration(user, homeserver);

  await user.type(input, "@bot:example.com");
  const submit = screen.getByRole("button", { name: /登记/ });
  await user.click(submit);
  expect(submit).toBeDisabled();
  await user.click(submit);
  expect(homeserver.requests.filter((request) => request.method === "PUT")).toHaveLength(1);

  await act(async () => {
    putDeferred.resolve({ type: "response", status: 200, body: {} });
  });

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  const put = homeserver.requests.find((request) => request.method === "PUT");
  expect(put?.body).toEqual({
    agents: [
      { user_id: "@other:elsewhere.example" },
      { user_id: "@alice:example.com" },
      { user_id: "@bot:example.com" },
    ],
    extra: "kept",
  });
});

test("提交前重读名册失败时留在登记步，保留已填用户 ID，不进入重试队列，可以再次提交成功", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let gets = 0;
  homeserver.handler = async (input) => {
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      gets += 1;
      if (gets === 1) {
        return {
          type: "response",
          status: 500,
          body: { errcode: "M_UNKNOWN", error: "Database busy" },
        };
      }
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT") {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const { clock } = renderApp(homeserver);
  const input = await enterRegistration(user, homeserver);
  await user.type(input, "@BotOne:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("服务器暂时无法响应，请稍后重试。");
  expect(alert).not.toHaveTextContent("Database busy");
  expect(alert).not.toHaveTextContent("M_UNKNOWN");
  expect(alert).not.toHaveTextContent("500");
  expect(screen.getByLabelText("Bot 用户名")).toHaveValue("@BotOne:example.com");
  expect(screen.getByRole("button", { name: /登记/ })).toBeEnabled();
  expect(homeserver.requests.some((request) => request.method === "PUT")).toBe(false);

  clock.advance(60_000);
  expect(
    homeserver.requests.filter((request) => request.url.includes("/account_data/im.waypoint.agents")),
  ).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: /登记/ }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
});

test("写入名册失败时留在登记步，保留已填用户 ID，不进入重试队列，可再次提交", async () => {
  const user = userEvent.setup();
  const cases = [
    {
      name: "网络失败",
      respond: { type: "failure" as const, failure: { type: "network" as const } },
      expected: "无法连接到服务器，请检查网络或地址。",
    },
    {
      name: "被限流",
      respond: {
        type: "response" as const,
        status: 429,
        body: { errcode: "M_LIMIT_EXCEEDED", error: "Slow down" },
      },
      expected: "请求过于频繁，请稍后再试。",
    },
    {
      name: "拒绝写入",
      respond: {
        type: "response" as const,
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Read only" },
      },
      expected: "被服务器拒绝",
    },
  ];
  for (const item of cases) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    let puts = 0;
    homeserver.handler = async (input) => {
      if (
        input.method === "GET" &&
        input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
      ) {
        return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
      }
      if (input.method === "PUT") {
        puts += 1;
        if (puts === 1) {
          return item.respond;
        }
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    };
    const view = renderApp(homeserver);
    const { clock } = view;
    const input = await enterRegistration(user, homeserver);
    await user.type(input, "@BotOne:example.com");
    await user.click(screen.getByRole("button", { name: /登记/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(item.expected);
    expect(alert).not.toHaveTextContent("M_");
    expect(alert).not.toHaveTextContent("429");
    expect(alert).not.toHaveTextContent("403");
    expect(screen.getByLabelText("Bot 用户名")).toHaveValue("@BotOne:example.com");
    expect(screen.getByRole("button", { name: /登记/ })).toBeEnabled();
    expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();

    clock.advance(60_000);
    expect(homeserver.requests.filter((request) => request.method === "PUT")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /登记/ }));
    expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
    expect(homeserver.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
    view.unmount();
  }
});

test("登记时服务器不认 token，只丢掉凭证回到密码步，不保留已填的 Agent 用户 ID", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let logins = 0;
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
        body: { user_id: "@alice:example.com", access_token: `tok-${logins}`, device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      return { type: "response", status: 200, body: { next_batch: "batch-1" } };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT") {
      return {
        type: "response",
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", error: "Token expired" },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver);
  await login(user);
  await user.type(await screen.findByLabelText("Bot 用户名"), "@BotOne:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("当前设备登录已失效，请重新登录。");
  expect(alert).not.toHaveTextContent("Token expired");
  expect(alert).not.toHaveTextContent("M_UNKNOWN_TOKEN");
  expect(alert).not.toHaveTextContent("401");
  expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();

  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  expect(await screen.findByLabelText("Bot 用户名")).toHaveValue("");
});

test("停在同步重试时可以放弃：停掉重试并尽量注销，不删设备，丢掉本地凭证回到保留地址和用户标识的密码步", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
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
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      syncs += 1;
      return { type: "failure", failure: { type: "network" } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const first = renderApp(homeserver);
  await login(user);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法连接到服务器，请检查网络或地址。");

  await user.click(screen.getByRole("button", { name: "放弃" }));

  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "立刻再试" })).not.toBeInTheDocument();

  first.clock.advance(60_000);
  expect(syncs).toBe(1);

  const logout = homeserver.requests.find((request) => request.url.endsWith("/logout"));
  expect(logout).toMatchObject({
    method: "POST",
    url: "https://matrix.example.com/_matrix/client/v3/logout",
    headers: { Authorization: "Bearer tok-1" },
  });
  expect(homeserver.requests.some((request) => request.url.includes("/devices"))).toBe(false);

  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(syncs).toBe(1);
});

test("同步还在路上时放弃，迟到的同步结果不能把 Owner 拉进列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingSync = deferred<TransportResult>();
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
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      return pendingSync.promise;
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const view = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "放弃" }));
  expect(await screen.findByLabelText("密码")).toHaveValue("");

  await act(async () => {
    pendingSync.resolve({
      type: "response",
      status: 200,
      body: { next_batch: "batch-late", account_data: validAgents },
    });
  });

  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();

  view.unmount();
  renderApp(homeserver);
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
});

test("停在登记时可以放弃，即使注销返回跨主机重定向、错误、超时或卡住也不阻塞且不跟随重定向，重登从空白游标开始", async () => {
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
    let logins = 0;
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
          body: { user_id: "@alice:example.com", access_token: `tok-${logins}`, device_id: `DEV${logins}` },
        };
      }
      if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
        syncUrls.push(input.url);
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: `batch-${logins}`,
            ...(logins >= 2 ? { account_data: validAgents } : {}),
          },
        };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
        return item.respond();
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    };
    const first = renderApp(homeserver);
    await login(user);
    const input = await screen.findByLabelText("Bot 用户名");
    await user.type(input, "@bot:example.com");
    await user.click(screen.getByRole("button", { name: "放弃" }));

    expect(await screen.findByLabelText("密码")).toHaveValue("");
    expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
    expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
    expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();

    const logouts = homeserver.requests.filter((request) => request.url.includes("logout"));
    expect(logouts).toHaveLength(1);
    expect(logouts[0]).toMatchObject({
      method: "POST",
      url: "https://matrix.example.com/_matrix/client/v3/logout",
      headers: { Authorization: "Bearer tok-1" },
    });
    expect(homeserver.requests.some((request) => request.url.includes("evil.example.com"))).toBe(false);
    expect(homeserver.requests.some((request) => request.url.includes("/devices"))).toBe(false);

    first.unmount();
    const second = renderApp(homeserver);
    expect(await screen.findByLabelText("密码")).toHaveValue("");
    expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
    expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();

    await user.type(screen.getByLabelText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: "用密码登录" }));
    expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
    expect(syncUrls).toEqual([
      "https://matrix.example.com/_matrix/client/v3/sync",
      "https://matrix.example.com/_matrix/client/v3/sync",
    ]);
    second.unmount();
  }
});

test("登记写入还在路上时放弃，迟到的写入成功也不能把 Owner 拉进列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingPut = deferred<TransportResult>();
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
        body: { user_id: "@alice:example.com", access_token: "tok-1", device_id: "DEV1" },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      return { type: "response", status: 200, body: { next_batch: "batch-1" } };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT") {
      return pendingPut.promise;
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const view = renderApp(homeserver);
  await login(user);
  await user.type(await screen.findByLabelText("Bot 用户名"), "@bot:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));
  await waitFor(() => {
    expect(homeserver.requests.some((request) => request.method === "PUT")).toBe(true);
  });

  await user.click(screen.getByRole("button", { name: "放弃" }));
  expect(await screen.findByLabelText("密码")).toHaveValue("");

  await act(async () => {
    pendingPut.resolve({ type: "response", status: 200, body: {} });
  });

  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();

  view.unmount();
  renderApp(homeserver);
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
});

test("提交前重读名册时账号已停用，丢掉凭证回到密码步且不保留已填 Bot ID", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return {
        type: "response",
        status: 403,
        body: { errcode: "M_USER_DEACTIVATED", error: "Account deactivated" },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver);
  const input = await enterRegistration(user, homeserver);
  await user.type(input, "@BotOne:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("该账号已停用。");
  expect(alert).not.toHaveTextContent("Account deactivated");
  expect(alert).not.toHaveTextContent("M_USER_DEACTIVATED");
  expect(alert).not.toHaveTextContent("403");
  expect(screen.getByLabelText("用户名")).toHaveValue("@alice:example.com");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.queryByLabelText("Bot 用户名")).not.toBeInTheDocument();
});

test("空列表上有新建 Topic 入口，单 Bot 时不显示选择，名字为空不发送请求且保留已填 Description", async () => {
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
                content: { agents: [{ user_id: "@bot:example.com", name: "代码助理" }] },
              },
            ],
          },
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();

  const newTopicButton = screen.getByRole("button", { name: "新建 Topic" });
  await user.click(newTopicButton);

  expect(screen.getByLabelText("Topic 名字")).toBeInTheDocument();
  const descriptionInput = screen.getByLabelText(/Description/);
  expect(descriptionInput).toBeInTheDocument();
  expect(screen.getByText(/不是私密备忘/)).toBeInTheDocument();
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();

  const createSubmit = screen.getByRole("button", { name: "创建 Topic" });
  expect(createSubmit).toBeDisabled();

  await user.type(descriptionInput, "这是给 Bot 看的上下文");
  expect(createSubmit).toBeDisabled();

  await user.type(screen.getByLabelText("Topic 名字"), "   ");
  expect(createSubmit).toBeDisabled();
  expect(screen.getByLabelText(/Description/)).toHaveValue("这是给 Bot 看的上下文");
  expect(homeserver.requests.some((request) => request.url.includes("/createRoom"))).toBe(false);
});

test("单 Bot 新建不带 Description 的 Topic，发送一次 createRoom、检查加密、追加 m.direct 并立即打开且持久化", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const createDeferred = deferred<TransportResult>();
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
                  content: { agents: [{ user_id: "@hermes:example.com", name: "工作助理" }] },
                },
                {
                  type: "m.direct",
                  content: {
                    "@other:example.com": ["!old:example.com"],
                    "@hermes:example.com": ["!prev:example.com"],
                  },
                },
              ],
            },
          },
        };
      }
      return { type: "response", status: 200, body: { next_batch: "batch-2" } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return createDeferred.promise;
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/rooms/!topic1%3Aexample.com/state/m.room.encryption")
    ) {
      return {
        type: "response",
        status: 404,
        body: { errcode: "M_NOT_FOUND", error: "Event not found." },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/m.direct")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "架构讨论");

  const submitButton = screen.getByRole("button", { name: "创建 Topic" });
  await user.click(submitButton);

  // 提交期间锁定按钮，不做乐观更新
  await waitFor(() => {
    expect(submitButton).toBeDisabled();
  });
  await user.click(submitButton);
  expect(homeserver.requests.filter((r) => r.url.endsWith("/createRoom"))).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /架构讨论/ })).not.toBeInTheDocument();

  const createReq = homeserver.requests.find((r) => r.url.endsWith("/createRoom"));
  expect(createReq?.headers.Authorization).toBe("Bearer tok-1");
  expect(createReq?.body).toEqual({
    preset: "private_chat",
    is_direct: true,
    invite: ["@hermes:example.com"],
    name: "架构讨论",
    initial_state: [
      {
        type: "im.waypoint.topic",
        state_key: "",
        content: { v: 1, agent_user_id: "@hermes:example.com" },
      },
      {
        type: "m.room.history_visibility",
        state_key: "",
        content: { history_visibility: "shared" },
      },
    ],
  });
  expect(createReq?.body).not.toHaveProperty("topic");

  await act(async () => {
    createDeferred.resolve({
      type: "response",
      status: 200,
      body: { room_id: "!topic1:example.com" },
    });
  });

  // 立即打开。顶栏展示 Topic 名字和解析后的 Bot 名字，不放完整用户 ID
  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("架构讨论");
  expect(header.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("工作助理");
  expect(header).not.toHaveTextContent("@hermes:example.com");
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();

  // m.direct 保留原有条目并追加新房间
  await waitFor(() => {
    const directPut = homeserver.requests.find((r) => r.method === "PUT" && r.url.includes("/account_data/m.direct"));
    expect(directPut).toBeDefined();
    expect(directPut?.body).toEqual({
      "@other:example.com": ["!old:example.com"],
      "@hermes:example.com": ["!prev:example.com", "!topic1:example.com"],
    });
  });

  // 重启后仍在列表里
  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("架构讨论")).toBeInTheDocument();
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
});

test("多 Bot 且没有可参照活动时不预选，允许改选与重名，带 Description 创建并支持标题栏展开/收起与滚动收起", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let createCount = 0;

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
                    { user_id: "@bot1:example.com", name: "一号助理" },
                    { user_id: "@bot2:example.com" },
                  ],
                },
              },
            ],
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      createCount += 1;
      return {
        type: "response",
        status: 200,
        body: { room_id: `!topic${createCount}:example.com` },
      };
    }
    if (input.method === "GET" && input.url.endsWith("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  const botSelect = screen.getByRole("combobox", { name: "绑定 Bot" });
  expect(botSelect).toHaveTextContent("请选择 Bot");
  await user.click(botSelect);
  const botListbox = await screen.findByRole("listbox");
  // 不显示完整用户 ID
  expect(botListbox).not.toHaveTextContent("@bot1:example.com");
  expect(botListbox).not.toHaveTextContent("@bot2:example.com");
  expect(screen.getByRole("option", { name: "一号助理" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "bot2" })).toBeInTheDocument();
  await user.keyboard("{Escape}");

  await user.type(screen.getByLabelText("Topic 名字"), "重复名字");
  await user.type(screen.getByLabelText(/Description/), "第一段上下文\n第二行内容");

  // 未选 Bot 时创建按钮不可点击
  expect(screen.getByRole("button", { name: "创建 Topic" })).toBeDisabled();
  expect(homeserver.requests.some((r) => r.url.endsWith("/createRoom"))).toBe(false);

  // 选择 bot2 后创建
  await user.click(botSelect);
  await user.click(await screen.findByRole("option", { name: "bot2" }));
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("重复名字");
  expect(header.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("bot2");
  expect(header).not.toHaveTextContent("@bot2:example.com");
  expect(screen.getByRole("button", { name: /重复名字/ })).not.toHaveTextContent("bot2");

  const descButton = screen.getByRole("button", { name: /第一段上下文/ });
  expect(descButton).toHaveAttribute("aria-expanded", "false");
  expect(header.querySelector(".waypoint-topic-meta-separator")).toHaveTextContent("·");
  await user.click(descButton);
  expect(descButton).toHaveAttribute("aria-expanded", "true");
  expect(header.querySelector(".waypoint-topic-meta-separator")).toBeNull();
  expect(header.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("bot2");
  await user.click(descButton);
  expect(descButton).toHaveAttribute("aria-expanded", "false");
  expect(header.querySelector(".waypoint-topic-meta-separator")).toHaveTextContent("·");

  // 再展开并在时间线滚动时收起
  await user.click(descButton);
  expect(descButton).toHaveAttribute("aria-expanded", "true");
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.scroll(timeline, { target: { scrollTop: 120 } });
  expect(descButton).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("banner")).toBeInTheDocument();

  const firstCreate = homeserver.requests.find((r) => r.url.endsWith("/createRoom"));
  expect(firstCreate?.body).toMatchObject({
    name: "重复名字",
    topic: "第一段上下文\n第二行内容",
    invite: ["@bot2:example.com"],
  });

  // 再次新建：此时有最近活动的 Topic（绑定 bot2），默认预选 bot2，且确认前可以改选 bot1，并允许重名
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  const secondSelect = screen.getByRole("combobox", { name: "绑定 Bot" });
  expect(secondSelect).toHaveTextContent("bot2");
  await user.click(secondSelect);
  await user.click(await screen.findByRole("option", { name: "一号助理" }));
  await user.type(screen.getByLabelText("Topic 名字"), "重复名字");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const secondHeader = await screen.findByRole("banner");
  expect(secondHeader).toHaveTextContent("重复名字");
  expect(secondHeader.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("一号助理");
  expect(screen.getAllByRole("button", { name: /重复名字/ }).every((button) => !button.textContent?.includes("一号助理"))).toBe(true);
  expect(screen.queryByRole("button", { name: /第一段上下文/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /重复名字/ })).toHaveLength(2);
});

test("预选最近有活动 Topic 绑定的 Bot；若该 Bot 不在名册则不预选", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();

  // Case 1: 最新活动在 bot2（消息 ts=2000 > Topic1 建房 ts=1500），默认预选 bot2
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
                    { type: "m.room.create", state_key: "", origin_server_ts: 1500, content: { creator: "@alice:example.com" } },
                    { type: "im.waypoint.topic", state_key: "", origin_server_ts: 1500, content: { v: 1, agent_user_id: "@bot1:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "新建空话题" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: { creator: "@alice:example.com" } },
                    { type: "im.waypoint.topic", state_key: "", origin_server_ts: 1000, content: { v: 1, agent_user_id: "@bot2:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "活跃话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$m1",
                      sender: "@bot2:example.com",
                      origin_server_ts: 2000,
                      content: { msgtype: "m.text", body: "回复" },
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

  const view = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  expect(screen.getByRole("combobox", { name: "绑定 Bot" })).toHaveTextContent("二号");
  view.unmount();

  // Case 2: 最近有活动的 Topic 绑定的 Bot 已不在名册，不预选
  globalThis.indexedDB = new IDBFactory();
  const hs2 = new FakeHomeserver();
  hs2.handler = passwordLoginHandler(async (input) => {
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
                    { user_id: "@bot1:example.com", name: "一号" },
                    { user_id: "@bot2:example.com", name: "二号" },
                  ],
                },
              },
            ],
          },
          rooms: {
            join: {
              "!t-old:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "老话题" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!t-removed:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1200, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@removed:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "已移除Bot的话题" } },
                  ],
                },
                timeline: {
                  events: [
                    { type: "m.room.message", event_id: "$m2", sender: "@removed:example.com", origin_server_ts: 3000, content: { msgtype: "m.text", body: "hi" } },
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

  renderApp(hs2);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  expect(screen.getByRole("combobox", { name: "绑定 Bot" })).toHaveTextContent("请选择 Bot");
});

test("建房失败时表单保持打开且保留输入，不留残留房间，可立即重试成功", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let attempts = 0;

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
                    { user_id: "@bot1:example.com", name: "一号" },
                    { user_id: "@bot2:example.com", name: "二号" },
                  ],
                },
              },
            ],
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      attempts += 1;
      if (attempts === 1) {
        return {
          type: "response",
          status: 500,
          body: { errcode: "M_UNKNOWN", error: "Room creation failed" },
        };
      }
      return {
        type: "response",
        status: 200,
        body: { room_id: "!retry-ok:example.com" },
      };
    }
    if (input.method === "GET" && input.url.endsWith("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "不丢草稿的话题");
  await user.type(screen.getByLabelText(/Description/), "保留这些描述");
  await user.click(screen.getByRole("combobox", { name: "绑定 Bot" }));
  await user.click(await screen.findByRole("option", { name: "二号" }));
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("服务器暂时无法创建 Topic，请稍后重试。");
  expect(alert).not.toHaveTextContent("Room creation failed");
  expect(alert).not.toHaveTextContent("M_UNKNOWN");
  expect(alert).not.toHaveTextContent("500");
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("不丢草稿的话题");
  expect(screen.getByLabelText(/Description/)).toHaveValue("保留这些描述");
  expect(screen.getByRole("combobox", { name: "绑定 Bot" })).toHaveTextContent("二号");
  expect(screen.getByText("暂无 Topic")).toBeInTheDocument();
  expect(homeserver.requests.some((r) => r.url.includes("/leave") || r.url.includes("/forget"))).toBe(false);

  // 直接点击重试成功
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));
  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("不丢草稿的话题");
  expect(header).toHaveTextContent("保留这些描述");
  expect(header.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("二号");
  expect(screen.getByRole("button", { name: /不丢草稿的话题/ })).not.toHaveTextContent("二号");
});

test("服务器在建房时强制开启加密，尽力 leave 再 forget，不进列表并在表单报错", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncs += 1;
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncs}`,
          account_data: {
            events: [
              {
                type: "im.waypoint.agents",
                content: { agents: [{ user_id: "@bot:example.com", name: "助手" }] },
              },
            ],
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return {
        type: "response",
        status: 200,
        body: { room_id: "!forced-enc:example.com" },
      };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/rooms/!forced-enc%3Aexample.com/state/m.room.encryption")
    ) {
      return {
        type: "response",
        status: 200,
        body: { algorithm: "m.megolm.v1.aes-sha2" },
      };
    }
    if (
      input.method === "POST" &&
      input.url.endsWith("/_matrix/client/v3/rooms/!forced-enc%3Aexample.com/leave")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    if (
      input.method === "POST" &&
      input.url.endsWith("/_matrix/client/v3/rooms/!forced-enc%3Aexample.com/forget")
    ) {
      // 即使 forget 失败也要尽力完成流程且不进列表
      return { type: "failure", failure: { type: "network" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "加密被拒的话题");
  await user.type(screen.getByLabelText(/Description/), "保留描述");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("加密");
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("加密被拒的话题");
  expect(screen.getByLabelText(/Description/)).toHaveValue("保留描述");
  expect(screen.getByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();

  const cleanupUrls = homeserver.requests
    .filter((r) => r.method === "POST" && (r.url.endsWith("/leave") || r.url.endsWith("/forget")))
    .map((r) => r.url);
  expect(cleanupUrls).toEqual([
    "https://matrix.example.com/_matrix/client/v3/rooms/!forced-enc%3Aexample.com/leave",
    "https://matrix.example.com/_matrix/client/v3/rooms/!forced-enc%3Aexample.com/forget",
  ]);
  expect(homeserver.requests.some((r) => r.url.includes("/account_data/m.direct"))).toBe(false);

  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.queryByText("加密被拒的话题")).not.toBeInTheDocument();
});

test("m.direct 追加失败时不报错也不回滚已建成的 Topic", async () => {
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
                content: { agents: [{ user_id: "@bot:example.com", name: "助手" }] },
              },
            ],
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return { type: "response", status: 200, body: { room_id: "!ok-room:example.com" } };
    }
    if (input.method === "GET" && input.url.endsWith("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      return { type: "response", status: 500, body: { errcode: "M_UNKNOWN", error: "Server error" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "照常打开的话题");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("照常打开的话题");
  expect(header.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("助手");

  await waitFor(() => {
    expect(homeserver.requests.some((r) => r.method === "PUT" && r.url.includes("/m.direct"))).toBe(true);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("banner")).toHaveTextContent("照常打开的话题");

  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("照常打开的话题")).toBeInTheDocument();
});

test("列表只收 Owner 仍在其中且带 im.waypoint.topic 的房间，列表不放 Bot 名字而顶栏第二行展示绑定 Bot 名字且启动不自动打开", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncs += 1;
      if (syncs === 1) {
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
                      { user_id: "@bot1:example.com", name: "手写一号" },
                      { user_id: "@bot2:example.com" },
                      { user_id: "@bot3:example.com" },
                    ],
                  },
                },
                {
                  type: "m.direct",
                  content: {
                    "@bot1:example.com": ["!legacy-dm:example.com"],
                  },
                },
              ],
            },
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 3000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题一" } },
                      { type: "m.room.member", state_key: "@bot1:example.com", content: { membership: "join", displayname: "服务器显示名不应覆盖手写" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot2:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题二" } },
                      { type: "m.room.topic", state_key: "", content: { topic: "话题二说明" } },
                      { type: "m.room.member", state_key: "@bot2:example.com", content: { membership: "join", displayname: "小赫显示名" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t3:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot3:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题三" } },
                      { type: "m.room.member", state_key: "@bot3:example.com", content: { membership: "invite" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!legacy-dm:example.com": {
                  state: {
                    events: [
                      { type: "m.room.name", state_key: "", content: { name: "历史旧私聊" } },
                      { type: "m.room.member", state_key: "@bot1:example.com", content: { membership: "join" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!legacy-encrypted:example.com": {
                  state: {
                    events: [
                      { type: "m.room.name", state_key: "", content: { name: "旧加密房间" } },
                      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
              leave: {
                "!left-topic:example.com": {
                  state: {
                    events: [
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "已离开房间" } },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
              invite: {
                "!invited-topic:example.com": {
                  state: {
                    events: [
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "仅被邀请房间" } },
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
          next_batch: "batch-2",
          rooms: {
            leave: {
              "!t3:example.com": {},
            },
          },
        },
      };
    }
    throw new Error(input.url);
  });

  const first = renderApp(homeserver);
  await login(user);

  expect(await screen.findByText("话题一")).toBeInTheDocument();
  expect(screen.getByText("话题二")).toBeInTheDocument();
  expect(screen.getByText("话题三")).toBeInTheDocument();
  // 启动后不自动打开第一条 Topic，且列表行不放 Description
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(screen.queryByText("话题二说明")).not.toBeInTheDocument();

  // 不认领历史房间、旧私聊、旧加密房间、已离开或仅邀请的房间
  expect(screen.queryByText("历史旧私聊")).not.toBeInTheDocument();
  expect(screen.queryByText("旧加密房间")).not.toBeInTheDocument();
  expect(screen.queryByText("已离开房间")).not.toBeInTheDocument();
  expect(screen.queryByText("仅被邀请房间")).not.toBeInTheDocument();

  // 不显示任何完整用户 ID
  expect(document.body).not.toHaveTextContent("@bot1:example.com");
  expect(document.body).not.toHaveTextContent("@bot2:example.com");
  expect(document.body).not.toHaveTextContent("@bot3:example.com");

  // 逐条打开。列表行仍不放 Bot 名字，顶栏第二行展示按优先级解析的 Bot 名字且不放完整用户 ID
  const list = screen.getByRole("complementary", { name: "Topic 列表" });
  await user.click(within(list).getByRole("button", { name: "话题一" }));
  expect(within(list).getByRole("button", { name: "话题一" })).not.toHaveTextContent("手写一号");
  expect(within(list).getByRole("button", { name: "话题一" }).querySelector(".waypoint-topic-row-bot")).toBeNull();
  expect(screen.getByRole("banner")).toHaveTextContent("话题一");
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-bot-name")).toHaveTextContent("手写一号");
  expect(screen.getByRole("banner")).not.toHaveTextContent("服务器显示名不应覆盖手写");

  await user.click(within(list).getByRole("button", { name: "话题二" }));
  expect(within(list).getByRole("button", { name: "话题二" })).not.toHaveTextContent("小赫显示名");
  expect(screen.getByRole("banner")).toHaveTextContent("话题二说明");
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-bot-name")).toHaveTextContent("小赫显示名");

  await user.click(within(list).getByRole("button", { name: "话题三" }));
  expect(within(list).getByRole("button", { name: "话题三" })).not.toHaveTextContent("bot3");
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-bot-name")).toHaveTextContent("bot3");
  expect(screen.getByRole("banner")).not.toHaveTextContent("@bot3:example.com");

  // 重启后先展示本地缓存，再等增量 sync 的 rooms.leave 把离开的房间移出列表
  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("话题一")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByText("话题三")).not.toBeInTheDocument();
  });
});

test("名册里只有一个合法 Bot（忽略自己、跨服和重复项）时不显示选择与列表副标题，顶栏展示 Topic 与绑定 Bot 名字且空 Description 不占元素", async () => {
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
                    { user_id: "@alice:example.com", name: "自己" },
                    { user_id: "@foreign:other.example", name: "跨服" },
                    { user_id: "@solo:example.com", name: "唯一助理" },
                    { user_id: "@solo:example.com", name: "重复" },
                  ],
                },
              },
            ],
          },
          rooms: {
            join: {
              "!existing:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@solo:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "已有话题" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return { type: "response", status: 200, body: { room_id: "!created:example.com" } };
    }
    if (input.method === "GET" && input.url.endsWith("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(input.url);
  });

  renderApp(homeserver);
  await login(user);

  const existingRow = await screen.findByRole("button", { name: "已有话题" });
  expect(existingRow).not.toHaveTextContent("唯一助理");

  await user.click(existingRow);
  const header1 = screen.getByRole("banner");
  expect(header1).toHaveTextContent("已有话题");
  expect(header1.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("唯一助理");
  expect(header1.querySelector(".waypoint-topic-description")).toBeNull();

  // 打开新建表单后取消，回到原打开的 Topic
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("banner")).toHaveTextContent("已有话题");

  // 仅填空白 Description 时不发送 topic 字段且标题栏不渲染 Description（第二行仅展示 Bot 名字）
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "无上下文话题");
  await user.type(screen.getByLabelText(/Description/), "   ");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const header2 = await screen.findByRole("banner");
  expect(header2).toHaveTextContent("无上下文话题");
  expect(header2.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("唯一助理");
  expect(header2.querySelector(".waypoint-topic-description")).toBeNull();

  const createReq = homeserver.requests.find((r) => r.url.endsWith("/createRoom"));
  expect(createReq?.body).not.toHaveProperty("topic");
});

test("createRoom 响应本身带加密标记时立即尽力 leave 并 forget，不进列表", async () => {
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
                content: { agents: [{ user_id: "@bot:example.com", name: "助手" }] },
              },
            ],
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return {
        type: "response",
        status: 200,
        body: {
          room_id: "!enc-inline:example.com",
          state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/leave")) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.endsWith("/forget")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "响应带加密");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("加密");
  expect(screen.getByText("暂无 Topic")).toBeInTheDocument();
  expect(homeserver.requests.filter((r) => r.url.endsWith("/leave") || r.url.endsWith("/forget")).map((r) => r.url)).toEqual([
    "https://matrix.example.com/_matrix/client/v3/rooms/!enc-inline%3Aexample.com/leave",
    "https://matrix.example.com/_matrix/client/v3/rooms/!enc-inline%3Aexample.com/forget",
  ]);
});

test("完成首次登记后进入工作区可看到已同步的 Topic 并立即新建 Topic；进列表前放弃会清掉未进列表前同步到的房间", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let phaseStep: "first-login" | "second-login" = "first-login";

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
        body: {
          user_id: "@alice:example.com",
          access_token: phaseStep === "first-login" ? "tok-1" : "tok-2",
          device_id: phaseStep === "first-login" ? "DEV1" : "DEV2",
        },
      };
    }
    if (input.method === "GET" && input.url.includes("/_matrix/client/v3/sync")) {
      if (phaseStep === "first-login") {
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-1",
            rooms: {
              join: {
                "!prelist:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "m.room.name", state_key: "", content: { name: "放弃前残留 Topic" } },
                      {
                        type: "im.waypoint.topic",
                        state_key: "",
                        content: { v: 1, agent_user_id: "@bot:example.com" },
                      },
                      { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                      { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
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
          next_batch: "batch-2",
          rooms: {
            join: {
              "!synced:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "m.room.name", state_key: "", content: { name: "同步到的 Topic" } },
                    {
                      type: "im.waypoint.topic",
                      state_key: "",
                      content: { v: 1, agent_user_id: "@bot:example.com" },
                    },
                    { type: "m.room.member", state_key: "@alice:example.com", content: { membership: "join" } },
                    { type: "m.room.member", state_key: "@bot:example.com", content: { membership: "join" } },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return { type: "response", status: 200, body: { room_id: "!created:example.com" } };
    }
    if (
      input.method === "GET" &&
      input.url.endsWith("/_matrix/client/v3/rooms/!created%3Aexample.com/state/m.room.encryption")
    ) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/m.direct")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };

  renderApp(homeserver);
  await login(user);
  await screen.findByLabelText("Bot 用户名");
  await user.click(screen.getByRole("button", { name: "放弃" }));
  expect(await screen.findByLabelText("密码")).toHaveValue("");

  phaseStep = "second-login";
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const regInput = await screen.findByLabelText("Bot 用户名");
  await user.type(regInput, "@bot:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  expect(await screen.findByText("同步到的 Topic")).toBeInTheDocument();
  expect(screen.queryByText("放弃前残留 Topic")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Topic 名字"), "登记后首条 Topic");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("登记后首条 Topic");
  expect(header.querySelector(".waypoint-topic-bot-name")).toHaveTextContent("bot");
  expect(header).not.toHaveTextContent("@bot:example.com");
});

test("宽视口常驻左右两栏、不自动打开第一条 Topic，未选中时右侧显示选择或新建引导且无隐藏左栏或新窗口入口", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncs += 1;
      if (syncs === 1) {
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
                      { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "首条话题" } },
                    ],
                  },
                  timeline: { events: [] },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "第二条话题" } },
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
          next_batch: "batch-2",
          rooms: {
            leave: {
              "!t1:example.com": {},
            },
          },
        },
      };
    }
    throw new Error(input.url);
  });

  const first = renderApp(homeserver);
  await login(user);

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  expect(sidebar).toBeVisible();
  expect(screen.getByText("首条话题")).toBeInTheDocument();
  expect(screen.getByText("第二条话题")).toBeInTheDocument();

  // 不自动打开第一条 Topic，右侧展示选择或新建引导
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(screen.getByText(/选择一条 Topic/)).toBeInTheDocument();
  const quickCreate = screen.getByRole("button", { name: "新建一条 Topic" });
  expect(quickCreate).toBeInTheDocument();

  // 不允许折叠隐藏左栏，也不提供新建窗口或在新窗口打开 Topic
  expect(screen.queryByRole("button", { name: /收起|折叠|隐藏/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /新窗口/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /新窗口/ })).not.toBeInTheDocument();

  // 点击右侧快捷新建按钮打开新建表单，且左栏依然常驻可见
  await user.click(quickCreate);
  expect(screen.getByRole("region", { name: "新建 Topic" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "首条话题" }));
  expect(screen.getByRole("banner")).toHaveTextContent("首条话题");
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();

  // 当前打开的 Topic 被移出后，不自动打开剩余的第一条，而是回到未选中引导。
  // 重开先展示缓存，需等增量 sync 的 rooms.leave 落地后再断言已离开的房间消失。
  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("第二条话题")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByText("首条话题")).not.toBeInTheDocument();
  });
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(screen.getByText(/选择一条 Topic/)).toBeInTheDocument();
});
