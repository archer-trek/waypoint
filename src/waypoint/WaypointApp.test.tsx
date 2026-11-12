import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import type { Clock, HomeserverRequest, HomeserverTransport, TransportResult } from "../adapters/types";
import { WaypointApp } from "./WaypointApp";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

class ManualClock implements Clock {
  private nextId = 1;
  private timers = new Map<number, { at: number; handler: () => void }>();
  now = 0;

  currentTimeMs(): number {
    return this.now;
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

class FakeHomeserver implements HomeserverTransport {
  readonly requests: Array<HomeserverRequest & { headers: Record<string, string> }> = [];
  handler: (input: HomeserverRequest) => Promise<TransportResult> = async () => {
    throw new Error("Homeserver 不应收到请求");
  };

  request(input: HomeserverRequest): Promise<TransportResult> {
    this.requests.push({ ...input, headers: input.headers ?? {} });
    return this.handler(input);
  }
}

function renderApp(homeserver = new FakeHomeserver(), deviceDisplayName = "Waypoint macOS") {
  const clock = new ManualClock();
  const view = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName }}
      clock={clock}
    />,
  );
  return { homeserver, clock, ...view };
}

test("Owner 打开应用时尚未进入 Topic 列表，地址是空白的", async () => {
  const homeserver = new FakeHomeserver();
  renderApp(homeserver);

  const address = await screen.findByLabelText("Homeserver 地址");
  expect(address).toHaveValue("");
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(homeserver.requests).toEqual([]);
});

test("Owner 提交 server name 时不把它当成 Homeserver 地址", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  renderApp(homeserver);

  const address = await screen.findByLabelText("Homeserver 地址");
  await user.type(address, "matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(homeserver.requests).toEqual([]);
  expect(screen.getByRole("alert")).toHaveTextContent("确认 Homeserver 失败，因为只接受完整的 https 地址。");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
});

test("Owner 提交 http 地址时不发送请求", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "http://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(homeserver.requests).toEqual([]);
  expect(screen.getByRole("alert")).toHaveTextContent("确认 Homeserver 失败，因为只接受完整的 https 地址。");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
});

test("Owner 提交不带协议的主机名时不发送请求", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "homeserver.local");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(homeserver.requests).toEqual([]);
  expect(screen.getByRole("alert")).toHaveTextContent("确认 Homeserver 失败，因为只接受完整的 https 地址。");
});

test("Owner 提交完整 https 地址时先请求 versions，并且不发送密码", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = () => new Promise(() => {});
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "  https://matrix.example.com/  ");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(homeserver.requests.map((request) => [request.method, request.url])).toEqual([
    ["GET", "https://matrix.example.com/_matrix/client/versions"],
  ]);
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(JSON.stringify(homeserver.requests)).not.toContain("password");
});

test("versions 为空列表时停住，说明这不是 Matrix Homeserver，并且不发送密码", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async () => ({
    type: "response",
    status: 200,
    body: { versions: [] },
  });
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "确认 Homeserver 失败，因为这不是 Matrix Homeserver。",
  );
  expect(homeserver.requests).toHaveLength(1);
  expect(homeserver.requests[0]?.method).toBe("GET");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Homeserver 地址")).toHaveValue("https://matrix.example.com");
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
});

test("确认 Homeserver 时不跟随重定向，也不把重定向当成可用的 versions", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async () => ({
    type: "response",
    status: 302,
    body: { versions: ["v1.11"] },
  });
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "确认 Homeserver 失败，因为这不是 Matrix Homeserver。",
  );
  expect(homeserver.requests.map((request) => request.url)).toEqual([
    "https://matrix.example.com/_matrix/client/versions",
  ]);
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
});

test("versions 可用后才询问密码，并且这时还不发送密码", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async () => ({
    type: "response",
    status: 200,
    body: { versions: ["v1.11"] },
  });
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com/synapse/");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户标识")).toHaveValue("");
  expect(screen.queryByLabelText("访问令牌")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /SSO|单点登录/ })).not.toBeInTheDocument();
  expect(screen.getByText("https://matrix.example.com/synapse")).toBeInTheDocument();
  expect(homeserver.requests.map((request) => [request.method, request.url])).toEqual([
    ["GET", "https://matrix.example.com/synapse/_matrix/client/versions"],
  ]);
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
});

test("证书不受信任时停住，没有仍然信任", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async () => ({
    type: "failure",
    failure: { type: "untrusted-certificate" },
  });
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "确认 Homeserver 失败，因为到达不了，证书不受信任。",
  );
  expect(screen.queryByText("仍然信任")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "仍然信任" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(homeserver.requests).toHaveLength(1);
});

test("主机名对不上或 HTTPS 建不起来时停住，没有仍然信任", async () => {
  const user = userEvent.setup();
  for (const [failure, reason] of [
    ["hostname-mismatch", "主机名对不上"],
    ["https-unavailable", "HTTPS 建不起来"],
  ] as const) {
    const homeserver = new FakeHomeserver();
    homeserver.handler = async () => ({ type: "failure", failure: { type: failure } });
    const view = renderApp(homeserver);
    await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `确认 Homeserver 失败，因为到达不了，${reason}。`,
    );
    expect(screen.queryByText("仍然信任")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    view.unmount();
  }
});

test("确认 Homeserver 被限流时留下说明，不展示 errcode，也不自动重发", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async () => ({
    type: "response",
    status: 429,
    body: { errcode: "M_LIMIT_EXCEEDED", error: "Too many requests" },
  });
  const { clock } = renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("确认 Homeserver 失败，因为被限流：Too many requests。");
  expect(alert).not.toHaveTextContent("M_LIMIT_EXCEEDED");
  expect(alert).not.toHaveTextContent("429");
  clock.advance(60_000);
  expect(homeserver.requests).toHaveLength(1);
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
});

test("只去掉末尾一个斜杠后请求 versions", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = () => new Promise(() => {});
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com//");
  await user.click(screen.getByRole("button", { name: "继续" }));

  expect(homeserver.requests.map((request) => request.url)).toEqual([
    "https://matrix.example.com/_matrix/client/versions",
  ]);
});

test("用户标识去掉空白后是空的时不发送，密码保留", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("密码"), "secret");
  await user.type(screen.getByLabelText("用户标识"), "   ");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  expect(homeserver.requests).toHaveLength(1);
  expect(screen.getByLabelText("密码")).toHaveValue("secret");
  expect(await screen.findByRole("alert")).toHaveTextContent("登录失败，因为用户标识是空的。");
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
});

test("用户标识是邮箱或电话时不发送，密码保留", async () => {
  const user = userEvent.setup();
  for (const identifier of ["alice@example.com", "+15551212"]) {
    const homeserver = new FakeHomeserver();
    homeserver.handler = async (input) => {
      if (input.url.endsWith("/versions")) {
        return { type: "response", status: 200, body: { versions: ["v1.11"] } };
      }
      throw new Error(`不应发送 ${input.method} ${input.url}`);
    };
    const view = renderApp(homeserver);
    await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.type(await screen.findByLabelText("用户标识"), identifier);
    await user.type(screen.getByLabelText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: "用密码登录" }));

    expect(homeserver.requests).toHaveLength(1);
    expect(screen.getByLabelText("密码")).toHaveValue("secret");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录失败，因为用户标识只能是 localpart 或完整用户 ID，不接受邮箱或电话。",
    );
    view.unmount();
  }
});

test("登录流程里没有密码登录时停住，这不是密码错误，并且不发送密码", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.sso" }] } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "登录失败，因为这台 Homeserver 没有密码登录，这不是密码错误。",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("用户标识或密码被拒绝");
  expect(screen.getByLabelText("密码")).toHaveValue("secret");
  expect(homeserver.requests.map((request) => [request.method, request.url])).toEqual([
    ["GET", "https://matrix.example.com/_matrix/client/versions"],
    ["GET", "https://matrix.example.com/_matrix/client/v3/login"],
  ]);
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
});

test("首次密码登录不携带 device id，设备显示名来自平台，也不申请 refresh token", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/login")) {
      return new Promise(() => {});
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver, "Waypoint macOS");

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "  alice  ");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  await waitFor(() => {
    expect(homeserver.requests.some((request) => request.method === "POST")).toBe(true);
  });
  const post = homeserver.requests.find((request) => request.method === "POST");
  expect(post).toMatchObject({
    method: "POST",
    url: "https://matrix.example.com/_matrix/client/v3/login",
    body: {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "alice" },
      password: "secret",
      initial_device_display_name: "Waypoint macOS",
    },
  });
  expect(post?.body).not.toHaveProperty("device_id");
  expect(post?.body).not.toHaveProperty("refresh_token");
  expect(post?.headers.authorization ?? post?.headers.Authorization).toBeUndefined();
});

test("同步成功且名册里有当前 Homeserver 的合法 Agent 时，进入 Topic 列表并看到暂无 Topic", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
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
          access_token: "tok-1",
          device_id: "DEV1",
          well_known: { "m.homeserver": { base_url: "https://other.example.com" } },
          refresh_token: "should-not-be-used",
        },
      };
    }
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
                  agents: [{ user_id: "@bot:example.com", name: "可选手写名" }],
                },
              },
            ],
          },
          rooms: {
            join: {
              "!room:example.com": { timeline: { limited: true, events: [] } },
            },
          },
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver, "Waypoint Android");

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "@alice:example.com");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.queryByText("尚未进入 Topic 列表")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();

  const sync = homeserver.requests.find((request) => request.url.includes("/sync"));
  expect(sync).toMatchObject({
    method: "GET",
    url: "https://matrix.example.com/_matrix/client/v3/sync",
    headers: { Authorization: "Bearer tok-1" },
  });
  expect(sync?.url).not.toContain("since=");
  expect(sync?.url).not.toContain("other.example.com");
  expect(homeserver.requests.some((request) => request.url.includes("/profile"))).toBe(false);
  expect(homeserver.requests.some((request) => request.url.includes("/messages"))).toBe(false);
  expect(homeserver.requests.some((request) => JSON.stringify(request.body ?? {}).includes("refresh_token"))).toBe(false);
  const login = homeserver.requests.find((request) => request.method === "POST");
  expect(login?.body).toMatchObject({
    initial_device_display_name: "Waypoint Android",
    identifier: { type: "m.id.user", user: "@alice:example.com" },
  });
});

test("同步成功但名册没有合法 Agent 时不进入 Topic 列表，而是先登记第一个 Bot 且没有可选名字", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
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
                    { user_id: "@alice:example.com" },
                    { user_id: "@bot:matrix.example.com" },
                    { user_id: "not-a-user" },
                    { name: "缺身份" },
                  ],
                },
              },
            ],
          },
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  await waitFor(() => {
    expect(homeserver.requests.some((request) => request.url.includes("/sync"))).toBe(true);
  });
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  expect(await screen.findByLabelText("Matrix 用户 ID")).toHaveValue("");
  expect(screen.queryByLabelText(/名字|名称|昵称/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /登记/ })).toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(homeserver.requests.some((request) => request.url.includes("account_data"))).toBe(false);
});

test("用户标识或密码被拒绝时清掉密码，停在密码步，不展示 errcode，也不自动重发", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
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
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Invalid username or password" },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const { clock } = renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("登录失败，因为用户标识或密码被拒绝：Invalid username or password。");
  expect(alert).not.toHaveTextContent("M_FORBIDDEN");
  expect(alert).not.toHaveTextContent("403");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户标识")).toHaveValue("alice");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  clock.advance(60_000);
  expect(homeserver.requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("同步遇到网络问题时留在同步重试，不再要密码，退避后自动再试，也可以立刻再试", async () => {
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
    if (input.url.includes("/sync")) {
      syncs += 1;
      if (syncs < 3) {
        return { type: "failure", failure: { type: "network" } };
      }
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: {
            events: [
              { type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com" }] } },
            ],
          },
        },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const { clock } = renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("同步失败，因为到达不了。");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "立刻再试" })).toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  expect(homeserver.requests.filter((request) => request.url.includes("/sync"))).toHaveLength(1);

  clock.advance(0);
  expect(homeserver.requests.filter((request) => request.url.includes("/sync"))).toHaveLength(1);

  clock.advance(60_000);
  await waitFor(() => {
    expect(homeserver.requests.filter((request) => request.url.includes("/sync")).length).toBeGreaterThan(1);
  });
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "立刻再试" }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(homeserver.requests.filter((request) => request.url.includes("/sync")).every((request) => !request.url.includes("since="))).toBe(true);
});

test("还没进列表时服务器不认 token，就停掉自动重试，只丢掉凭证，回到密码步并显示登录响应里的用户 ID", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
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
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" },
      };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const first = renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("同步失败，因为服务器不认这台设备的登录：Unrecognised access token。");
  expect(alert).not.toHaveTextContent("M_UNKNOWN_TOKEN");
  expect(alert).not.toHaveTextContent("401");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "立刻再试" })).not.toBeInTheDocument();
  expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();

  first.clock.advance(60_000);
  expect(homeserver.requests.filter((request) => request.url.includes("/sync"))).toHaveLength(1);

  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.queryByLabelText("Homeserver 地址")).not.toBeInTheDocument();
  expect(homeserver.requests.filter((request) => request.url.includes("/sync"))).toHaveLength(1);
});

test("登录请求到达不了时密码留着，不自动重发", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "failure", failure: { type: "network" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  };
  const { clock } = renderApp(homeserver);

  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("登录失败，因为到达不了。");
  expect(screen.getByRole("alert")).not.toHaveTextContent("密码错误");
  expect(screen.getByLabelText("密码")).toHaveValue("secret");
  expect(homeserver.requests.some((request) => request.method === "POST")).toBe(false);
  clock.advance(60_000);
  expect(homeserver.requests.filter((request) => request.url.includes("/login"))).toHaveLength(1);
});

test("登录被限流时密码留着，不展示 errcode，也不自动重发", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST") {
      return { type: "response", status: 429, body: { errcode: "M_LIMIT_EXCEEDED", error: "Too many requests" } };
    }
    throw new Error(input.url);
  };
  const { clock } = renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("登录失败，因为被限流：Too many requests。");
  expect(alert).not.toHaveTextContent("M_LIMIT_EXCEEDED");
  expect(alert).not.toHaveTextContent("429");
  expect(screen.getByLabelText("密码")).toHaveValue("secret");
  clock.advance(60_000);
  expect(homeserver.requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("账号已停用时清掉密码，这不是密码错误", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    return {
      type: "response",
      status: 403,
      body: { errcode: "M_USER_DEACTIVATED", error: "This account has been deactivated" },
    };
  };
  renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("登录失败，因为账号已停用：This account has been deactivated。");
  expect(alert).not.toHaveTextContent("M_USER_DEACTIVATED");
  expect(alert).not.toHaveTextContent("用户标识或密码被拒绝");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户标识")).toHaveValue("alice");
});

test("还要验证码或其他交互式验证时停住，不打开网页，不保存 token", async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST") {
      return {
        type: "response",
        status: 401,
        body: {
          errcode: "M_FORBIDDEN",
          error: "Complete the captcha",
          session: "sess",
          flows: [{ stages: ["m.login.recaptcha"] }],
          access_token: "should-not-save",
          params: { "m.login.recaptcha": { public_key: "key" } },
        },
      };
    }
    throw new Error(input.url);
  };
  const view = renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("登录失败，因为还要验证码或其他交互式验证，Waypoint 做不了。");
  expect(alert).not.toHaveTextContent("M_FORBIDDEN");
  expect(screen.getByLabelText("密码")).toHaveValue("secret");
  expect(homeserver.requests.some((request) => request.url.includes("/sync"))).toBe(false);
  expect(open).not.toHaveBeenCalled();
  view.unmount();
  renderApp(homeserver);
  expect(await screen.findByLabelText("Homeserver 地址")).toHaveValue("");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  open.mockRestore();
});

function passwordLoginHandler(sync: (input: { method: string; url: string }) => Promise<import("../adapters/types").TransportResult>) {
  return async (input: { method: string; url: string }) => {
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

test("登录响应缺 device id 时不写入，关掉再打开回到空白的地址步", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    if (input.method === "GET" && input.url.endsWith("/_matrix/client/v3/login")) {
      return { type: "response", status: 200, body: { flows: [{ type: "m.login.password" }] } };
    }
    if (input.method === "POST") {
      return { type: "response", status: 200, body: { user_id: "@alice:example.com", access_token: "tok-1" } };
    }
    throw new Error(input.url);
  };
  const view = renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("登录失败，因为 Homeserver 没有返回完整的登录结果。");
  expect(homeserver.requests.some((request) => request.url.includes("/sync"))).toBe(false);
  expect(screen.getByLabelText("密码")).toHaveValue("secret");
  view.unmount();
  renderApp(homeserver);
  expect(await screen.findByLabelText("Homeserver 地址")).toHaveValue("");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
});

test("token 还没写入就关掉时，下次回到空白的地址步", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = async (input) => {
    if (input.url.endsWith("/versions")) {
      return { type: "response", status: 200, body: { versions: ["v1.11"] } };
    }
    return new Promise(() => {});
  };
  const view = renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  view.unmount();

  renderApp(homeserver);
  expect(await screen.findByLabelText("Homeserver 地址")).toHaveValue("");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(homeserver.requests.some((request) => request.method === "POST")).toBe(false);
});

test("关掉再打开时，有 token 就从同步继续，不再要密码", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncs = 0;
  homeserver.handler = passwordLoginHandler(async (input) => {
    if (!input.url.includes("/sync")) {
      throw new Error(input.url);
    }
    syncs += 1;
    if (syncs === 1) {
      return { type: "failure", failure: { type: "timeout" } };
    }
    return {
      type: "response",
      status: 200,
      body: {
        next_batch: "batch-9",
        account_data: {
          events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com" }] } }],
        },
      },
    };
  });
  const first = renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("同步失败，因为超时。");
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  first.unmount();

  renderApp(homeserver);
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  const syncsAfter = homeserver.requests.filter((request) => request.url.includes("/sync"));
  expect(syncsAfter.length).toBeGreaterThan(1);
  expect(syncsAfter.every((request) => request.headers.Authorization === "Bearer tok-1")).toBe(true);
  expect(homeserver.requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("同步遇到超时、5xx 或限流时留在同步重试，不展示状态码", async () => {
  const user = userEvent.setup();
  const cases = [
    {
      name: "超时",
      respond: { type: "failure" as const, failure: { type: "timeout" as const } },
      text: "同步失败，因为超时。",
    },
    {
      name: "5xx",
      respond: { type: "response" as const, status: 502, body: { errcode: "M_UNKNOWN", error: "Bad gateway" } },
      text: "同步失败，因为 Homeserver 暂时不能完成同步：Bad gateway。",
    },
    {
      name: "限流",
      respond: { type: "response" as const, status: 429, body: { errcode: "M_LIMIT_EXCEEDED", error: "Slow down" } },
      text: "同步失败，因为被限流：Slow down。",
    },
  ];
  for (const item of cases) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    homeserver.handler = passwordLoginHandler(async () => item.respond);
    const view = renderApp(homeserver);
    await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.type(await screen.findByLabelText("用户标识"), "alice");
    await user.type(screen.getByLabelText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: "用密码登录" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(item.text);
    expect(alert).not.toHaveTextContent("M_");
    expect(alert).not.toHaveTextContent("502");
    expect(alert).not.toHaveTextContent("429");
    expect(screen.getByRole("button", { name: "立刻再试" })).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByText("诊断")).not.toBeInTheDocument();
    view.unmount();
  }
});

test("还没进列表时账号已停用，就回到密码步并清掉密码", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = passwordLoginHandler(async () => ({
    type: "response",
    status: 403,
    body: { errcode: "M_USER_DEACTIVATED", error: "deactivated" },
  }));
  const { clock } = renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("同步失败，因为账号已停用：deactivated。");
  expect(alert).not.toHaveTextContent("M_USER_DEACTIVATED");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "立刻再试" })).not.toBeInTheDocument();
  clock.advance(60_000);
  expect(homeserver.requests.filter((request) => request.url.includes("/sync"))).toHaveLength(1);
});

test("名册里只要有一个合法的当前 Homeserver 用户 ID，就忽略其余条目并进入列表", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  homeserver.handler = passwordLoginHandler(async () => ({
    type: "response",
    status: 200,
    body: {
      next_batch: "batch-2",
      account_data: {
        events: [
          {
            type: "im.waypoint.agents",
            content: {
              agents: [
                { user_id: "bot" },
                { user_id: "@alice:example.com" },
                { user_id: "@other:elsewhere.example" },
                { user_id: "@bot:example.com" },
              ],
            },
          },
        ],
      },
    },
  }));
  renderApp(homeserver);
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(homeserver.requests.some((request) => request.url.includes("/profile"))).toBe(false);
  expect(homeserver.requests.some((request) => request.method !== "GET" && request.url.includes("account_data"))).toBe(false);
});

test("名册缺事件、读不懂或没有合法条目时不进入 Topic 列表", async () => {
  const user = userEvent.setup();
  const bodies: unknown[] = [
    { next_batch: "a" },
    { next_batch: "b", account_data: { events: [{ type: "im.waypoint.agents", content: { agents: "nope" } }] } },
    { next_batch: "c", account_data: { events: [{ type: "m.direct", content: { "@bot:example.com": ["!room"] } }] } },
  ];
  for (const body of bodies) {
    globalThis.indexedDB = new IDBFactory();
    const homeserver = new FakeHomeserver();
    homeserver.handler = passwordLoginHandler(async () => ({ type: "response", status: 200, body }));
    const view = renderApp(homeserver);
    await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.type(await screen.findByLabelText("用户标识"), "alice");
    await user.type(screen.getByLabelText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: "用密码登录" }));
    await waitFor(() => {
      expect(homeserver.requests.some((request) => request.url.includes("/sync"))).toBe(true);
    });
    expect(screen.queryByText("暂无 Topic")).not.toBeInTheDocument();
    expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /登记/ })).toBeInTheDocument();
    view.unmount();
  }
});

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
  await user.type(await screen.findByLabelText("用户标识"), "alice");
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
  await user.type(await screen.findByLabelText("用户标识"), "alice");
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
  const continued = homeserver.requests.filter((request) => request.url.includes("/sync"));
  expect(continued.at(-1)?.url).toBe("https://matrix.example.com/_matrix/client/v3/sync?since=batch-kept");
  expect(continued.at(-1)?.headers.Authorization).toBe("Bearer tok-1");
  expect(homeserver.requests.some((request) => request.url.includes("/account_data"))).toBe(false);
  expect(homeserver.requests.some((request) => request.url.includes("/profile"))).toBe(false);
});

async function login(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const validAgents = {
  events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com" }] } }],
};

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
  expect(screen.queryByText("同步失败，因为到达不了。")).not.toBeInTheDocument();
  const syncCount = homeserver.requests.filter((request) => request.url.includes("/sync")).length;
  clock.advance(60_000);
  expect(homeserver.requests.filter((request) => request.url.includes("/sync"))).toHaveLength(syncCount);
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
  const continued = homeserver.requests.filter((request) => request.url.includes("/sync"));
  expect(continued.at(-1)?.url).toContain("since=batch-ok");
  expect(continued.at(-1)?.headers.Authorization).toBe("Bearer tok-1");
});

async function enterRegistration(
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

test("首次登记拒绝空值、非完整用户 ID、跨服或大小写不同的 server name，以及 Owner 自己，且不请求 profile", async () => {
  const user = userEvent.setup();
  const cases = [
    { owner: "@alice:example.com", typed: "   ", reason: "空的" },
    { owner: "@alice:example.com", typed: "bot", reason: "完整" },
    { owner: "@alice:example.com", typed: "bot:example.com", reason: "完整" },
    { owner: "@alice:example.com", typed: "@bot", reason: "完整" },
    { owner: "@alice:example.com", typed: "@bot:", reason: "完整" },
    { owner: "@alice:example.com", typed: "@:example.com", reason: "完整" },
    { owner: "@alice:example.com", typed: "@bot:other.example", reason: "server name" },
    { owner: "@alice:example.com", typed: "@bot:EXAMPLE.COM", reason: "server name" },
    { owner: "@alice:example.com:8448", typed: "@bot:example.com", reason: "server name" },
    { owner: "@alice:example.com", typed: "@alice:example.com", reason: "自己" },
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
  const input = await screen.findByLabelText("Matrix 用户 ID");
  await user.type(input, "@NewBot:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.queryByText("尚未进入 Topic 列表")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Matrix 用户 ID")).not.toBeInTheDocument();
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
  const input = await screen.findByLabelText("Matrix 用户 ID");
  await user.type(input, "  @MyBot:example.com  ");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  expect(await screen.findByText("暂无 Topic")).toBeInTheDocument();
  expect(screen.getByText("已连接")).toBeInTheDocument();
  expect(screen.queryByText("尚未进入 Topic 列表")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Matrix 用户 ID")).not.toBeInTheDocument();
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
  expect(alert).toHaveTextContent("Database busy");
  expect(alert).not.toHaveTextContent("M_UNKNOWN");
  expect(alert).not.toHaveTextContent("500");
  expect(screen.getByLabelText("Matrix 用户 ID")).toHaveValue("@BotOne:example.com");
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
      expected: "到达不了",
    },
    {
      name: "被限流",
      respond: {
        type: "response" as const,
        status: 429,
        body: { errcode: "M_LIMIT_EXCEEDED", error: "Slow down" },
      },
      expected: "Slow down",
    },
    {
      name: "拒绝写入",
      respond: {
        type: "response" as const,
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Read only" },
      },
      expected: "Read only",
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
    expect(screen.getByLabelText("Matrix 用户 ID")).toHaveValue("@BotOne:example.com");
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
  await user.type(await screen.findByLabelText("Matrix 用户 ID"), "@BotOne:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Token expired");
  expect(alert).not.toHaveTextContent("M_UNKNOWN_TOKEN");
  expect(alert).not.toHaveTextContent("401");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();

  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  expect(await screen.findByLabelText("Matrix 用户 ID")).toHaveValue("");
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
  expect(await screen.findByRole("alert")).toHaveTextContent("同步失败，因为到达不了。");

  await user.click(screen.getByRole("button", { name: "放弃" }));

  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
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
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
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
    const input = await screen.findByLabelText("Matrix 用户 ID");
    await user.type(input, "@bot:example.com");
    await user.click(screen.getByRole("button", { name: "放弃" }));

    expect(await screen.findByLabelText("密码")).toHaveValue("");
    expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
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
    expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
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
  await user.type(await screen.findByLabelText("Matrix 用户 ID"), "@bot:example.com");
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
  expect(alert).toHaveTextContent("Account deactivated");
  expect(alert).not.toHaveTextContent("M_USER_DEACTIVATED");
  expect(alert).not.toHaveTextContent("403");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByLabelText("密码")).toHaveValue("");
  expect(screen.queryByLabelText("Matrix 用户 ID")).not.toBeInTheDocument();
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

  await user.type(descriptionInput, "这是给 Bot 看的上下文");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("请输入 Topic 名字");
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

  // 立即打开，同时可见 Topic 名字和 Bot 名字（不显示完整用户 ID）
  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("架构讨论");
  expect(header).toHaveTextContent("工作助理");
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
  const botSelect = screen.getByLabelText("绑定 Bot") as HTMLSelectElement;
  expect(botSelect.value).toBe("");
  // 不显示完整用户 ID
  expect(botSelect).not.toHaveTextContent("@bot1:example.com");
  expect(botSelect).not.toHaveTextContent("@bot2:example.com");
  expect(botSelect).toHaveTextContent("一号助理");
  expect(botSelect).toHaveTextContent("bot2");

  await user.type(screen.getByLabelText("Topic 名字"), "重复名字");
  await user.type(screen.getByLabelText(/Description/), "第一段上下文\n第二行内容");

  // 不选 Bot 提交会被本地挡住
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请选择要绑定的 Bot");
  expect(homeserver.requests.some((r) => r.url.endsWith("/createRoom"))).toBe(false);

  // 选择 bot2 后创建
  await user.selectOptions(botSelect, "@bot2:example.com");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("重复名字");
  expect(header).toHaveTextContent("bot2");
  expect(header).not.toHaveTextContent("@bot2:example.com");

  const descButton = screen.getByRole("button", { name: /第一段上下文/ });
  expect(descButton).toHaveAttribute("aria-expanded", "false");
  await user.click(descButton);
  expect(descButton).toHaveAttribute("aria-expanded", "true");
  await user.click(descButton);
  expect(descButton).toHaveAttribute("aria-expanded", "false");

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
  const secondSelect = screen.getByLabelText("绑定 Bot") as HTMLSelectElement;
  expect(secondSelect.value).toBe("@bot2:example.com");
  await user.selectOptions(secondSelect, "@bot1:example.com");
  await user.type(screen.getByLabelText("Topic 名字"), "重复名字");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const secondHeader = await screen.findByRole("banner");
  expect(secondHeader).toHaveTextContent("重复名字");
  expect(secondHeader).toHaveTextContent("一号助理");
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
  expect((screen.getByLabelText("绑定 Bot") as HTMLSelectElement).value).toBe("@bot2:example.com");
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
  expect((screen.getByLabelText("绑定 Bot") as HTMLSelectElement).value).toBe("");
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
  await user.selectOptions(screen.getByLabelText("绑定 Bot"), "@bot2:example.com");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Room creation failed");
  expect(alert).not.toHaveTextContent("M_UNKNOWN");
  expect(alert).not.toHaveTextContent("500");
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("不丢草稿的话题");
  expect(screen.getByLabelText(/Description/)).toHaveValue("保留这些描述");
  expect((screen.getByLabelText("绑定 Bot") as HTMLSelectElement).value).toBe("@bot2:example.com");
  expect(screen.getByText("暂无 Topic")).toBeInTheDocument();
  expect(homeserver.requests.some((r) => r.url.includes("/leave") || r.url.includes("/forget"))).toBe(false);

  // 直接点击重试成功
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));
  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("不丢草稿的话题");
  expect(header).toHaveTextContent("二号");
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
  expect(header).toHaveTextContent("助手");

  await waitFor(() => {
    expect(homeserver.requests.some((r) => r.method === "PUT" && r.url.includes("/m.direct"))).toBe(true);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("banner")).toHaveTextContent("照常打开的话题");

  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("照常打开的话题")).toBeInTheDocument();
});

test("列表只收 Owner 仍在其中且带 im.waypoint.topic 的房间，按手写名、显示名、localpart 解析 Bot 名字且启动不自动打开", async () => {
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

  // 逐条打开并检查 Bot 名字解析顺序
  await user.click(screen.getByRole("button", { name: /话题一/ }));
  expect(screen.getByRole("banner")).toHaveTextContent("手写一号");
  expect(screen.getByRole("banner")).not.toHaveTextContent("服务器显示名不应覆盖手写");

  await user.click(screen.getByRole("button", { name: /话题二/ }));
  expect(screen.getByRole("banner")).toHaveTextContent("小赫显示名");
  expect(screen.getByRole("banner")).toHaveTextContent("话题二说明");

  await user.click(screen.getByRole("button", { name: /话题三/ }));
  expect(screen.getByRole("banner")).toHaveTextContent("bot3");
  expect(screen.getByRole("banner")).not.toHaveTextContent("@bot3:example.com");

  // 重启后收到 rooms.leave 时，离开的房间从列表移除
  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("话题一")).toBeInTheDocument();
  expect(screen.queryByText("话题三")).not.toBeInTheDocument();
});

test("名册里只有一个合法 Bot（忽略自己、跨服和重复项）时不显示选择与列表副标题，但打开后标题栏仍同时显示 Topic 与 Bot 名字且空 Description 不占元素", async () => {
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
  expect(header1).toHaveTextContent("唯一助理");
  expect(header1.querySelector(".waypoint-topic-description")).toBeNull();

  // 打开新建表单后取消，回到原打开的 Topic
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("banner")).toHaveTextContent("已有话题");

  // 仅填空白 Description 时不发送 topic 字段且标题栏不渲染 Description
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "无上下文话题");
  await user.type(screen.getByLabelText(/Description/), "   ");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const header2 = await screen.findByRole("banner");
  expect(header2).toHaveTextContent("无上下文话题");
  expect(header2).toHaveTextContent("唯一助理");
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
                      { type: "m.room.name", state_key: "", content: { name: "旧会话残留 Topic" } },
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
  await screen.findByLabelText("Matrix 用户 ID");
  await user.click(screen.getByRole("button", { name: "放弃" }));
  expect(await screen.findByLabelText("密码")).toHaveValue("");

  phaseStep = "second-login";
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  const regInput = await screen.findByLabelText("Matrix 用户 ID");
  await user.type(regInput, "@bot:example.com");
  await user.click(screen.getByRole("button", { name: /登记/ }));

  expect(await screen.findByText("同步到的 Topic")).toBeInTheDocument();
  expect(screen.queryByText("旧会话残留 Topic")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Topic 名字"), "登记后首条 Topic");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("登记后首条 Topic");
  expect(header).toHaveTextContent("bot");
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
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "首条话题" }));
  expect(screen.getByRole("banner")).toHaveTextContent("首条话题");
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();

  // 当前打开的 Topic 被移出后，不自动打开剩余的第一条，而是回到未选中引导
  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("第二条话题")).toBeInTheDocument();
  expect(screen.queryByText("首条话题")).not.toBeInTheDocument();
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(screen.getByText(/选择一条 Topic/)).toBeInTheDocument();
});

test("窄视口先见全屏 Topic 列表（不显示右侧引导，无抽屉），点开推入全屏对话或新建页，并用顶栏返回回到列表", async () => {
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
                content: { agents: [{ user_id: "@bot:example.com", name: "小助理" }] },
              },
            ],
          },
          rooms: {
            join: {
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "窄屏话题" } },
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
      return { type: "response", status: 200, body: { room_id: "!t2:example.com" } };
    }
    if (input.method === "GET" && input.url.endsWith("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(input.url);
  });

  const clock = new ManualClock();
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint Android", viewportMode: () => "narrow" } as import("../adapters/types").PlatformAdapter}
      clock={clock}
    />,
  );
  await login(user);

  // 窄视口先见全屏 Topic 列表，不自动打开第一条，不展示宽屏右侧引导，不做侧滑抽屉
  expect(await screen.findByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.getByText("窄屏话题")).toBeInTheDocument();
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Topic 引导" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /抽屉|菜单/ })).not.toBeInTheDocument();

  // 点击 Topic 推入全屏对话，隐藏列表页，固定顶栏有返回按钮
  await user.click(screen.getByRole("button", { name: "窄屏话题" }));
  expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();
  const header = screen.getByRole("banner");
  expect(header).toHaveTextContent("窄屏话题");
  expect(header).toHaveTextContent("小助理");
  const backBtn = screen.getByRole("button", { name: "返回" });
  expect(backBtn).toBeVisible();

  // 点击顶栏返回回到全屏 Topic 列表
  await user.click(backBtn);
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();

  // 点击新建 Topic 推入全屏新建页（隐藏列表），可用顶栏返回回到列表
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();

  // 窄屏下新建成功推入新 Topic 对话，返回后可在列表中看到新 Topic
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "窄屏新建话题");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));
  expect(await screen.findByRole("banner")).toHaveTextContent("窄屏新建话题");
  expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.getByText("窄屏新建话题")).toBeInTheDocument();
});

test("窄视口支持系统返回（adapter onSystemBack 与浏览器 popstate）从对话或新建页回到 Topic 列表并保持历史栈对齐", async () => {
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
                      { type: "m.room.name", state_key: "", content: { name: "系统返回话题" } },
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
            leave: { "!t1:example.com": {} },
          },
        },
      };
    }
    throw new Error(input.url);
  });

  // Case 1: 通过 PlatformAdapter 的 onSystemBack 触发系统返回
  let backHandler: (() => boolean) | undefined;
  let pushed = 0;
  let popped = 0;
  const clock = new ManualClock();
  const view = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{
        deviceDisplayName: "Waypoint Android",
        viewportMode: () => "narrow",
        onSystemBack: (handler: () => boolean) => {
          backHandler = handler;
          return () => {
            backHandler = undefined;
          };
        },
        pushNavigationEntry: () => {
          pushed += 1;
        },
        popNavigationEntry: () => {
          popped += 1;
        },
      } as import("../adapters/types").PlatformAdapter}
      clock={clock}
    />,
  );
  await login(user);
  expect(await screen.findByText("系统返回话题")).toBeInTheDocument();
  expect(pushed).toBe(0);
  // 列表页时系统返回不消费事件
  expect(backHandler?.()).toBe(false);

  // 打开 Topic 推入历史项；系统返回消费事件并回到列表，不再额外 pop
  await user.click(screen.getByRole("button", { name: "系统返回话题" }));
  expect(screen.getByRole("banner")).toHaveTextContent("系统返回话题");
  expect(pushed).toBe(1);
  expect(popped).toBe(0);

  act(() => {
    expect(backHandler?.()).toBe(true);
  });
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(popped).toBe(0);

  // 打开新建 Topic 页后通过系统返回回到列表
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
  expect(pushed).toBe(2);
  act(() => {
    expect(backHandler?.()).toBe(true);
  });
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();
  expect(popped).toBe(0);

  // 点击顶栏返回按钮时主动清理压入的历史项
  await user.click(screen.getByRole("button", { name: "系统返回话题" }));
  expect(pushed).toBe(3);
  await user.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(popped).toBe(1);

  view.unmount();

  // Case 2: 通过生产平台适配器的 matchMedia (48em) 与 popstate 触发系统返回
  const { detectPlatform } = await import("../adapters/production");
  const originalMatchMedia = window.matchMedia;
  const pushStateSpy = vi.spyOn(window.history, "pushState");
  const backSpy = vi.spyOn(window.history, "back");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(min-width: 48em)" ? false : true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  });
  try {
    globalThis.indexedDB = new IDBFactory();
    syncs = 0;
    const prodView = render(
      <WaypointApp
        homeserver={homeserver}
        platform={detectPlatform()}
        clock={new ManualClock()}
      />,
    );
    await login(user);
    await user.click(await screen.findByRole("button", { name: "系统返回话题" }));
    expect(screen.getByRole("banner")).toHaveTextContent("系统返回话题");
    expect(pushStateSpy).toHaveBeenCalledTimes(1);

    // 模拟系统返回触发 popstate
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(backSpy).not.toHaveBeenCalled();

    // 再次打开并点 UI 返回按钮时，会调用 history.back() 弹出历史项
    await user.click(screen.getByRole("button", { name: "系统返回话题" }));
    expect(pushStateSpy).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
    expect(backSpy).toHaveBeenCalledTimes(1);

    prodView.unmount();
  } finally {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    pushStateSpy.mockRestore();
    backSpy.mockRestore();
  }
});

test("宽窄视口切换时保留已打开 Topic 与新建表单草稿且不重建同步循环，全局阻止第二个界面实例并发运行并聚焦主窗口", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCount = 0;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCount += 1;
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
                    { type: "m.room.name", state_key: "", content: { name: "正在讨论的话题" } },
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

  let currentMode: "wide" | "narrow" = "narrow";
  const listeners = new Set<(mode: "wide" | "narrow") => void>();
  const setViewport = (mode: "wide" | "narrow") => {
    currentMode = mode;
    for (const listener of listeners) {
      listener(mode);
    }
  };
  let focusCalls = 0;

  const platform: import("../adapters/types").PlatformAdapter = {
    deviceDisplayName: "Waypoint macOS",
    viewportMode: () => currentMode,
    subscribeViewportMode: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focusMainWindow: () => {
      focusCalls += 1;
    },
  } as import("../adapters/types").PlatformAdapter;

  const first = render(
    <WaypointApp homeserver={homeserver} platform={platform} clock={new ManualClock()} />,
  );
  await login(user);

  // 窄视口打开 Topic，再切宽视口，再切回窄视口
  await user.click(await screen.findByRole("button", { name: "正在讨论的话题" }));
  expect(screen.getByRole("banner")).toHaveTextContent("正在讨论的话题");
  expect(syncCount).toBe(1);

  act(() => {
    setViewport("wide");
  });
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.getByRole("banner")).toHaveTextContent("正在讨论的话题");
  expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();
  expect(syncCount).toBe(1);

  act(() => {
    setViewport("narrow");
  });
  expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();
  expect(screen.getByRole("banner")).toHaveTextContent("正在讨论的话题");
  expect(screen.getByRole("button", { name: "返回" })).toBeVisible();
  expect(syncCount).toBe(1);

  // 返回列表并打开新建表单输入草稿，在窄<->宽之间切换时表单内容不丢失
  await user.click(screen.getByRole("button", { name: "返回" }));
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "草稿标题");
  await user.type(screen.getByLabelText(/Description/), "未提交上下文");

  act(() => {
    setViewport("wide");
  });
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("草稿标题");
  expect(screen.getByLabelText(/Description/)).toHaveValue("未提交上下文");
  expect(syncCount).toBe(1);

  act(() => {
    setViewport("narrow");
  });
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("草稿标题");
  expect(screen.getByLabelText(/Description/)).toHaveValue("未提交上下文");
  expect(syncCount).toBe(1);

  // 同时尝试挂载第二个 WaypointApp 实例时，不启动第二套同步/客户端，改为聚焦主窗口
  const requestCountBeforeSecond = homeserver.requests.length;
  const second = render(
    <WaypointApp homeserver={homeserver} platform={platform} clock={new ManualClock()} />,
  );
  await waitFor(() => {
    expect(focusCalls).toBe(1);
  });
  expect(screen.getByText(/主窗口/)).toBeInTheDocument();
  expect(homeserver.requests).toHaveLength(requestCountBeforeSecond);
  expect(syncCount).toBe(1);

  second.unmount();
  first.unmount();

  // 第一个实例卸载后，重新打开单个主窗口可正常恢复同步
  const third = render(
    <WaypointApp homeserver={homeserver} platform={platform} clock={new ManualClock()} />,
  );
  expect(await screen.findByText("正在讨论的话题")).toBeInTheDocument();
  expect(syncCount).toBe(2);
  third.unmount();
});

test("软键盘弹出时将 keyboard inset 传入界面与输入区容器，收起时恢复（含生产 visualViewport 监听）", async () => {
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
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "键盘避让话题" } },
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

  // Case 1: 通过 PlatformAdapter 传递动态软键盘 inset
  let inset = 0;
  const insetListeners = new Set<(next: number) => void>();
  const setInset = (next: number) => {
    inset = next;
    for (const listener of insetListeners) {
      listener(next);
    }
  };

  const view = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{
        deviceDisplayName: "Waypoint Android",
        viewportMode: () => "narrow",
        keyboardInsetBottom: () => inset,
        subscribeKeyboardInsetBottom: (listener: (next: number) => void) => {
          insetListeners.add(listener);
          return () => {
            insetListeners.delete(listener);
          };
        },
      } as import("../adapters/types").PlatformAdapter}
      clock={new ManualClock()}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "键盘避让话题" }));

  const conversationMain = screen.getByRole("main");
  expect(conversationMain.style.paddingBottom).toBe("0px");

  act(() => {
    setInset(312);
  });
  const workspace = conversationMain.closest(".waypoint-workspace") as HTMLElement;
  expect(workspace.style.getPropertyValue("--keyboard-inset")).toBe("312px");
  expect(conversationMain.style.paddingBottom).toBe("312px");
  const safeArea = conversationMain.querySelector(".waypoint-composer-safe-area") as HTMLElement;
  expect(safeArea).toBeInTheDocument();
  expect(safeArea).toHaveAttribute("data-keyboard-inset", "312");

  act(() => {
    setInset(0);
  });
  expect(workspace.style.getPropertyValue("--keyboard-inset")).toBe("0px");
  expect(conversationMain.style.paddingBottom).toBe("0px");
  expect(safeArea).toHaveAttribute("data-keyboard-inset", "0");

  view.unmount();

  // Case 2: 生产 detectPlatform 从 visualViewport 推导软键盘 inset
  const { detectPlatform } = await import("../adapters/production");
  const originalInnerHeight = window.innerHeight;
  const originalVisualViewport = window.visualViewport;
  const vvListeners = new Map<string, Set<EventListener>>();
  const fakeVisualViewport = {
    height: 800,
    offsetTop: 0,
    addEventListener: (type: string, listener: EventListener) => {
      if (!vvListeners.has(type)) {
        vvListeners.set(type, new Set());
      }
      vvListeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      vvListeners.get(type)?.delete(listener);
    },
  };
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: fakeVisualViewport });
  try {
    globalThis.indexedDB = new IDBFactory();
    const prodView = render(
      <WaypointApp
        homeserver={homeserver}
        platform={detectPlatform()}
        clock={new ManualClock()}
      />,
    );
    await login(user);
    await user.click(await screen.findByRole("button", { name: "键盘避让话题" }));

    const prodMain = screen.getByRole("main");
    expect(prodMain.style.paddingBottom).toBe("0px");

    act(() => {
      fakeVisualViewport.height = 500;
      for (const listener of vvListeners.get("resize") ?? []) {
        listener(new Event("resize"));
      }
    });
    expect(prodMain.style.paddingBottom).toBe("300px");

    act(() => {
      fakeVisualViewport.height = 800;
      for (const listener of vvListeners.get("resize") ?? []) {
        listener(new Event("resize"));
      }
    });
    expect(prodMain.style.paddingBottom).toBe("0px");

    prodView.unmount();
  } finally {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: originalVisualViewport });
  }
});
