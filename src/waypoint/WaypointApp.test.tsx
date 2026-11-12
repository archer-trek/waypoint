import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function passwordLoginHandler(sync: (input: HomeserverRequest) => Promise<TransportResult>) {
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
  expect(screen.queryByText("放弃前残留 Topic")).not.toBeInTheDocument();

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

test("窄视口提交新建 Topic 期间触发系统返回时留在新建页并重对齐历史深度，失败或成功后按返回均回到 Topic 列表而非退出应用", async () => {
  const user = userEvent.setup();
  const { detectPlatform } = await import("../adapters/production");
  const originalMatchMedia = window.matchMedia;
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
    // 子场景 A：提交期间触发系统返回，随后建房失败留在表单，再次系统返回回到 Topic 列表
    globalThis.indexedDB = new IDBFactory();
    const hsFail = new FakeHomeserver();
    const failCreateDeferred = deferred<TransportResult>();
    hsFail.handler = passwordLoginHandler(async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: { next_batch: "batch-1", account_data: validAgents },
        };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
        return failCreateDeferred.promise;
      }
      throw new Error(input.url);
    });

    window.history.replaceState({ testRoot: "submitting-fail" }, "");
    const pushSpyFail = vi.spyOn(window.history, "pushState");
    const viewFail = render(
      <WaypointApp homeserver={hsFail} platform={detectPlatform()} clock={new ManualClock()} />,
    );
    await login(user);
    await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
    expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
    expect(pushSpyFail).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual({ waypointDepth: 1 });

    await user.type(screen.getByLabelText("Topic 名字"), "提交中返回失败");
    await user.click(screen.getByRole("button", { name: "创建 Topic" }));
    expect(screen.getByRole("button", { name: "正在创建…" })).toBeDisabled();

    // 真实浏览器/jsdom history.back() 触发系统返回
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 仍停留在新建表单，且浏览器历史深度已被重新压回 depth=1
    expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
    expect(screen.getByLabelText("Topic 名字")).toHaveValue("提交中返回失败");
    expect(screen.getByRole("button", { name: "正在创建…" })).toBeDisabled();
    expect(pushSpyFail).toHaveBeenCalledTimes(2);
    expect(window.history.state).toEqual({ waypointDepth: 1 });

    // 建房失败后留在表单报错
    await act(async () => {
      failCreateDeferred.resolve({
        type: "response",
        status: 500,
        body: { errcode: "M_UNKNOWN", error: "Temporary failure" },
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary failure");
    expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();

    // 再次按下系统返回应回到 Topic 列表（不漏出应用外）
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();
    expect(window.history.state).toEqual({ testRoot: "submitting-fail" });
    viewFail.unmount();
    pushSpyFail.mockRestore();

    // 子场景 B：提交期间触发系统返回，随后建房成功打开新 Topic，按系统返回回到 Topic 列表
    globalThis.indexedDB = new IDBFactory();
    const hsSuccess = new FakeHomeserver();
    const okCreateDeferred = deferred<TransportResult>();
    hsSuccess.handler = passwordLoginHandler(async (input) => {
      if (input.url.includes("/sync")) {
        return {
          type: "response",
          status: 200,
          body: { next_batch: "batch-1", account_data: validAgents },
        };
      }
      if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
        return okCreateDeferred.promise;
      }
      if (input.method === "GET" && input.url.endsWith("/state/m.room.encryption")) {
        return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
      }
      if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
        return { type: "response", status: 200, body: {} };
      }
      throw new Error(input.url);
    });

    window.history.replaceState({ testRoot: "submitting-ok" }, "");
    const pushSpyOk = vi.spyOn(window.history, "pushState");
    const viewOk = render(
      <WaypointApp homeserver={hsSuccess} platform={detectPlatform()} clock={new ManualClock()} />,
    );
    await login(user);
    await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
    await user.type(screen.getByLabelText("Topic 名字"), "提交中返回成功");
    await user.click(screen.getByRole("button", { name: "创建 Topic" }));

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
    expect(pushSpyOk).toHaveBeenCalledTimes(2);
    expect(window.history.state).toEqual({ waypointDepth: 1 });

    await act(async () => {
      okCreateDeferred.resolve({
        type: "response",
        status: 200,
        body: { room_id: "!created-ok:example.com" },
      });
    });
    expect(await screen.findByRole("banner")).toHaveTextContent("提交中返回成功");
    expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();

    // 建房成功后按系统返回应退回 Topic 列表
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
    expect(screen.getByText("提交中返回成功")).toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(window.history.state).toEqual({ testRoot: "submitting-ok" });
    viewOk.unmount();
    pushSpyOk.mockRestore();
  } finally {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  }
});

test("宽视口同时打开 Topic 与新建表单时快速切换 宽 -> 窄 -> 宽，两次异步 popstate 均被抑制且不会意外关闭表单或当前 Topic", async () => {
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
                    { type: "m.room.name", state_key: "", content: { name: "双层栈话题" } },
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

  const { detectPlatform } = await import("../adapters/production");
  const originalMatchMedia = window.matchMedia;
  let isWide = true;
  const mqListeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      get matches() {
        return query === "(min-width: 48em)" ? isWide : !isWide;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        mqListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        mqListeners.delete(listener);
      },
      addListener: (listener: () => void) => {
        mqListeners.add(listener);
      },
      removeListener: (listener: () => void) => {
        mqListeners.delete(listener);
      },
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  });

  window.history.replaceState({ testRoot: "rapid-switch" }, "");
  const backSpy = vi.spyOn(window.history, "back");
  const pushSpy = vi.spyOn(window.history, "pushState");
  const setWide = (next: boolean) => {
    isWide = next;
    for (const listener of mqListeners) {
      listener();
    }
  };

  try {
    const view = render(
      <WaypointApp homeserver={homeserver} platform={detectPlatform()} clock={new ManualClock()} />,
    );
    await login(user);

    // 宽视口先打开 Topic，再点击新建 Topic 并写入草稿
    await user.click(await screen.findByRole("button", { name: "双层栈话题" }));
    expect(screen.getByRole("banner")).toHaveTextContent("双层栈话题");
    await user.click(screen.getByRole("button", { name: "新建 Topic" }));
    await user.type(screen.getByLabelText("Topic 名字"), "切屏保留草稿");
    expect(pushSpy).not.toHaveBeenCalled();

    // 快速切换 宽 -> 窄 -> 宽（触发两次 pushNavigationEntry 后紧接着两次 popNavigationEntry）
    act(() => {
      setWide(false);
    });
    expect(pushSpy).toHaveBeenCalledTimes(2);
    act(() => {
      setWide(true);
    });

    // 等待两次异步 history.back() 与 popstate 全部完成
    await waitFor(() => {
      expect(backSpy).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 新建表单与草稿仍完好保留，取消后原打开的 Topic 也仍保持打开
    expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();
    expect(screen.getByLabelText("Topic 名字")).toHaveValue("切屏保留草稿");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("banner")).toHaveTextContent("双层栈话题");
    expect(window.history.state).toEqual({ testRoot: "rapid-switch" });

    // 再次切到窄视口并触发真实系统返回，验证历史栈与抑制计数器未残留错位
    act(() => {
      setWide(false);
    });
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();

    view.unmount();
  } finally {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    backSpy.mockRestore();
    pushSpy.mockRestore();
  }
});

test("连续新建两条 Topic 时串行追加 m.direct，不会因前一次 PUT 未完成而覆盖丢掉前一条房间 ID", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let createIndex = 0;
  let directPutIndex = 0;
  const firstDirectPut = deferred<TransportResult>();

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
                content: { agents: [{ user_id: "@bot:example.com", name: "助理" }] },
              },
              {
                type: "m.direct",
                content: { "@bot:example.com": ["!old:example.com"] },
              },
            ],
          },
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      createIndex += 1;
      return { type: "response", status: 200, body: { room_id: `!room${createIndex}:example.com` } };
    }
    if (input.method === "GET" && input.url.endsWith("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      directPutIndex += 1;
      if (directPutIndex === 1) {
        return firstDirectPut.promise;
      }
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  // 创建第一条 Topic：此时第一次 m.direct PUT 仍处于挂起中
  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "连续话题一");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));
  expect(await screen.findByRole("banner")).toHaveTextContent("连续话题一");

  // 立即创建第二条 Topic
  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "连续话题二");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));
  expect(await screen.findByRole("banner")).toHaveTextContent("连续话题二");

  // 第一次 PUT 未完成前，第二次 PUT 尚未发出
  const directPutsBefore = homeserver.requests.filter(
    (r) => r.method === "PUT" && r.url.includes("/account_data/m.direct"),
  );
  expect(directPutsBefore).toHaveLength(1);
  expect(directPutsBefore[0]?.body).toEqual({
    "@bot:example.com": ["!old:example.com", "!room1:example.com"],
  });

  // 放行第一次 PUT，第二次 PUT 应基于最新 m.direct 追加，保留全部房间 ID
  await act(async () => {
    firstDirectPut.resolve({ type: "response", status: 200, body: {} });
  });

  await waitFor(() => {
    const directPuts = homeserver.requests.filter(
      (r) => r.method === "PUT" && r.url.includes("/account_data/m.direct"),
    );
    expect(directPuts).toHaveLength(2);
    expect(directPuts[1]?.body).toEqual({
      "@bot:example.com": ["!old:example.com", "!room1:example.com", "!room2:example.com"],
    });
  });
});

test("按房间保存原始事件：m.replace 编辑不提前抬高 Topic 活动排序，增量状态更新在重启后保持最新", async () => {
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
                      { type: "m.room.name", state_key: "", content: { name: "话题一" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$msg1",
                        sender: "@bot1:example.com",
                        origin_server_ts: 1500,
                        content: { msgtype: "m.text", body: "原消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$edit1",
                        sender: "@bot1:example.com",
                        origin_server_ts: 9000,
                        content: {
                          msgtype: "m.text",
                          body: "* 改后消息",
                          "m.new_content": { msgtype: "m.text", body: "改后消息" },
                          "m.relates_to": { rel_type: "m.replace", event_id: "$msg1" },
                        },
                      },
                    ],
                  },
                },
                "!t2:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot2:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题二" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$msg2",
                        sender: "@bot2:example.com",
                        origin_server_ts: 3000,
                        content: { msgtype: "m.text", body: "最新常规消息" },
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
          next_batch: "batch-2",
          rooms: {
            join: {
              "!t1:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.name",
                      event_id: "$rename1",
                      state_key: "",
                      origin_server_ts: 4000,
                      content: { name: "话题一已改名" },
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

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  // m.replace (ts=9000) 不算作新活动，最新活动仍是 !t2 (ts=3000) -> 预选 @bot2
  expect((screen.getByLabelText("绑定 Bot") as HTMLSelectElement).value).toBe("@bot2:example.com");
  first.unmount();

  // 重启后增量同步带来的 m.room.name 更新保留原 im.waypoint.topic 状态并生效
  renderApp(homeserver);
  expect(await screen.findByText("话题一已改名")).toBeInTheDocument();
  expect(screen.getByText("话题二")).toBeInTheDocument();
});

test("生产平台适配器支持 virtualKeyboard、waypoint:keyboard-inset 事件与 CSS --keyboard-inset 回退", async () => {
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
                    { type: "m.room.name", state_key: "", content: { name: "键盘多源话题" } },
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

  const { detectPlatform } = await import("../adapters/production");
  const vkListeners = new Set<EventListener>();
  const fakeVk = {
    boundingRect: { height: 0 },
    addEventListener: (_type: string, listener: EventListener) => {
      vkListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      vkListeners.delete(listener);
    },
  };
  const originalVkDescriptor = Object.getOwnPropertyDescriptor(navigator, "virtualKeyboard");
  Object.defineProperty(navigator, "virtualKeyboard", {
    configurable: true,
    value: fakeVk,
  });

  try {
    const view = render(
      <WaypointApp homeserver={homeserver} platform={detectPlatform()} clock={new ManualClock()} />,
    );
    await login(user);
    await user.click(await screen.findByRole("button", { name: "键盘多源话题" }));
    const main = screen.getByRole("main");
    expect(main.style.paddingBottom).toBe("0px");

    // 1. VirtualKeyboard geometrychange
    act(() => {
      fakeVk.boundingRect = { height: 275 };
      for (const listener of vkListeners) {
        listener(new Event("geometrychange"));
      }
    });
    expect(main.style.paddingBottom).toBe("275px");

    act(() => {
      fakeVk.boundingRect = { height: 0 };
      for (const listener of vkListeners) {
        listener(new Event("geometrychange"));
      }
    });
    expect(main.style.paddingBottom).toBe("0px");

    // 2. 自定义 waypoint:keyboard-inset DOM 事件
    act(() => {
      window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 324 } }));
    });
    expect(main.style.paddingBottom).toBe("324px");

    act(() => {
      window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 0 } }));
    });
    expect(main.style.paddingBottom).toBe("0px");

    // 3. :root CSS --keyboard-inset 变量回退
    act(() => {
      document.documentElement.style.setProperty("--keyboard-inset", "260px");
      window.dispatchEvent(new Event("resize"));
    });
    expect(main.style.paddingBottom).toBe("260px");

    act(() => {
      document.documentElement.style.removeProperty("--keyboard-inset");
      window.dispatchEvent(new Event("resize"));
    });
    expect(main.style.paddingBottom).toBe("0px");

    view.unmount();
  } finally {
    document.documentElement.style.removeProperty("--keyboard-inset");
    if (originalVkDescriptor) {
      Object.defineProperty(navigator, "virtualKeyboard", originalVkDescriptor);
    } else {
      delete (navigator as unknown as { virtualKeyboard?: unknown }).virtualKeyboard;
    }
  }
});

test("进入 Topic 列表后可在设置里查看 Bot 名册（展示名字优先级与用户 ID），并适配宽窄视口与返回", async () => {
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
                    { user_id: "@bot1:example.com", name: "手写大管家" },
                    { user_id: "@bot2:example.com" },
                    { user_id: "@bot3:example.com" },
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
                    { type: "m.room.name", state_key: "", content: { name: "话题一" } },
                    { type: "m.room.member", state_key: "@bot1:example.com", origin_server_ts: 1000, content: { membership: "join", displayname: "不应覆盖手写名" } },
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
                    { type: "m.room.member", state_key: "@bot2:example.com", origin_server_ts: 2000, content: { membership: "join", displayname: "矩阵显示名" } },
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

  let viewportMode: "wide" | "narrow" = "wide";
  const listeners = new Set<(mode: "wide" | "narrow") => void>();
  let backHandler: (() => boolean) | undefined;
  let pushCount = 0;
  let popCount = 0;

  const view = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{
        deviceDisplayName: "Waypoint macOS",
        viewportMode: () => viewportMode,
        subscribeViewportMode: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        pushNavigationEntry: () => {
          pushCount += 1;
        },
        popNavigationEntry: () => {
          popCount += 1;
        },
        onSystemBack: (handler) => {
          backHandler = handler;
          return () => {
            backHandler = undefined;
          };
        },
      }}
      clock={new ManualClock()}
    />,
  );
  await login(user);

  const settingsButton = await screen.findByRole("button", { name: "设置" });
  await user.click(settingsButton);

  const settingsRegion = screen.getByRole("region", { name: "设置" });
  expect(settingsRegion).toBeInTheDocument();
  const agentsSection = screen.getByRole("region", { name: "Bot 名册" });
  expect(agentsSection).toBeInTheDocument();

  // 展示手写名 -> 显示名 -> localpart，以及各自的 Matrix 用户 ID
  expect(agentsSection).toHaveTextContent("手写大管家");
  expect(agentsSection).toHaveTextContent("@bot1:example.com");
  expect(agentsSection).not.toHaveTextContent("不应覆盖手写名");

  expect(agentsSection).toHaveTextContent("矩阵显示名");
  expect(agentsSection).toHaveTextContent("@bot2:example.com");

  expect(agentsSection).toHaveTextContent("bot3");
  expect(agentsSection).toHaveTextContent("@bot3:example.com");

  // 宽视口不显示返回按钮，左侧栏仍可见
  expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();

  // 切到窄视口后，设置全屏显示并推入导航栈，顶栏有返回按钮
  act(() => {
    viewportMode = "narrow";
    for (const listener of listeners) {
      listener("narrow");
    }
  });
  expect(pushCount).toBe(1);
  expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeVisible();

  // 系统返回退出设置并回到 Topic 列表
  let consumed = false;
  act(() => {
    consumed = backHandler?.() ?? false;
  });
  expect(consumed).toBe(true);
  expect(screen.queryByRole("region", { name: "设置" })).not.toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();

  // 再次从窄视口进入设置并用顶栏返回按钮返回列表
  await user.click(screen.getByRole("button", { name: "设置" }));
  expect(pushCount).toBe(2);
  expect(screen.getByRole("region", { name: "设置" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "返回" }));
  expect(popCount).toBe(1);
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toBeVisible();

  view.unmount();
});

test("在设置里登记新 Bot：校验用户 ID 与重复项、提交期间锁定且不做乐观更新、失败保留输入并报错、成功后写入名册", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let putAttempt = 0;
  let storedAgentsContent: unknown = {
    agents: [{ user_id: "@bot1:example.com", name: "一号" }],
  };
  const firstPutDeferred = deferred<TransportResult>();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: {
            events: [{ type: "im.waypoint.agents", content: storedAgentsContent }],
          },
        },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      putAttempt += 1;
      if (putAttempt === 1) {
        return firstPutDeferred.promise;
      }
      storedAgentsContent = input.body;
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "登记新 Bot" }));

  const userIdInput = screen.getByLabelText("Matrix 用户 ID");
  const nameInput = screen.getByLabelText("手写名字（可选）");
  const submitButton = screen.getByRole("button", { name: "登记 Bot" });

  // 1. 空用户 ID
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("用户 ID 是空的");
  expect(putAttempt).toBe(0);

  // 2. 不完整用户 ID（缺 @ 或 server）
  await user.type(userIdInput, "bot2");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("完整的 Matrix 用户 ID");
  expect(putAttempt).toBe(0);

  // 3. 跨 server name
  await user.clear(userIdInput);
  await user.type(userIdInput, "@bot2:other.org");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("server name 必须与当前账号完全一致");
  expect(putAttempt).toBe(0);

  // 4. Owner 自身
  await user.clear(userIdInput);
  await user.type(userIdInput, "@alice:example.com");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("不能把自己登记成 Bot");
  expect(putAttempt).toBe(0);

  // 5. 名册内重复
  await user.clear(userIdInput);
  await user.type(userIdInput, "  @bot1:example.com  ");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("已经在名册里");
  expect(userIdInput).toHaveValue("@bot1:example.com");
  expect(putAttempt).toBe(0);

  // 6. 合法新 Bot（去前后空白、保留大小写、带手写名字），提交期间锁定且不做乐观更新
  await user.clear(userIdInput);
  await user.type(userIdInput, "  @BotTwo:example.com  ");
  await user.type(nameInput, "  二号助理  ");
  await user.click(submitButton);

  expect(putAttempt).toBe(1);
  expect(submitButton).toBeDisabled();
  const agentsSection = screen.getByRole("region", { name: "Bot 名册" });
  expect(agentsSection).not.toHaveTextContent("@BotTwo:example.com");

  // 7. 第一次写入失败：留在表单保留已填内容并报错，不进重试队列
  firstPutDeferred.resolve({ type: "failure", failure: { type: "network" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("登记 Bot 失败，因为到达不了。");
  expect(userIdInput).toHaveValue("@BotTwo:example.com");
  expect(nameInput).toHaveValue("  二号助理  ");
  expect(submitButton).not.toBeDisabled();
  expect(agentsSection).not.toHaveTextContent("@BotTwo:example.com");

  // 8. 重试成功
  await user.click(submitButton);
  await waitFor(() => {
    expect(agentsSection).toHaveTextContent("二号助理");
    expect(agentsSection).toHaveTextContent("@BotTwo:example.com");
  });

  const putRequests = homeserver.requests.filter(
    (req) =>
      req.method === "PUT" &&
      req.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents"),
  );
  expect(putRequests).toHaveLength(2);
  expect(putRequests[1].body).toEqual({
    agents: [
      { user_id: "@bot1:example.com", name: "一号" },
      { user_id: "@BotTwo:example.com", name: "二号助理" },
    ],
  });

  // 9. 重启后持久生效
  first.unmount();
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "设置" }));
  const reloadedAgents = screen.getByRole("region", { name: "Bot 名册" });
  expect(reloadedAgents).toHaveTextContent("二号助理");
  expect(reloadedAgents).toHaveTextContent("@BotTwo:example.com");
});

test("在设置里编辑 Bot 时用户 ID 锁死、可修改或清空手写名字并按显示名/localpart回退，且同步更新显示名时自动跟随", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let putAttempt = 0;
  let storedAgentsContent: unknown = {
    agents: [
      { user_id: "@bot1:example.com", name: "初始手写名" },
      { user_id: "@bot2:example.com" },
    ],
  };

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
              events: [{ type: "im.waypoint.agents", content: storedAgentsContent }],
            },
            rooms: {
              join: {
                "!t1:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot1:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "话题一" } },
                      { type: "m.room.member", state_key: "@bot1:example.com", origin_server_ts: 1000, content: { membership: "join", displayname: "Bot1矩阵名" } },
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
            join: {
              "!t1:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.member",
                      event_id: "$mem1",
                      state_key: "@bot1:example.com",
                      origin_server_ts: 5000,
                      content: { membership: "join", displayname: "Bot1同步新显示名" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      putAttempt += 1;
      if (putAttempt === 1) {
        return {
          type: "response",
          status: 500,
          body: { errcode: "M_UNKNOWN", error: "database busy" },
        };
      }
      storedAgentsContent = input.body;
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "设置" }));

  const editButtons = screen.getAllByRole("button", { name: "编辑" });
  expect(editButtons).toHaveLength(2);
  await user.click(editButtons[0]);

  const userIdField = screen.getByLabelText("Matrix 用户 ID");
  expect(userIdField).toHaveValue("@bot1:example.com");
  expect(userIdField).toBeDisabled();

  const nameField = screen.getByLabelText("手写名字（可选）");
  expect(nameField).toHaveValue("初始手写名");

  // 1. 改名失败时留在编辑表单保留输入、报错，且列表不做乐观更新
  await user.clear(nameField);
  await user.type(nameField, "改后名字");
  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("database busy");
  expect(screen.getByLabelText("手写名字（可选）")).toHaveValue("改后名字");
  const agentsSection = screen.getByRole("region", { name: "Bot 名册" });
  expect(agentsSection).toHaveTextContent("初始手写名");

  // 2. 重试保存成功，列表更新为新手写名
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    expect(agentsSection).toHaveTextContent("改后名字");
  });
  expect(agentsSection).not.toHaveTextContent("初始手写名");

  // 3. 再次编辑并清空手写名字 -> 写入移除 name 字段，回退到 Matrix 显示名
  await user.click(screen.getAllByRole("button", { name: "编辑" })[0]);
  await user.clear(screen.getByLabelText("手写名字（可选）"));
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(agentsSection).toHaveTextContent("Bot1矩阵名");
  });
  expect(agentsSection).not.toHaveTextContent("改后名字");
  expect(storedAgentsContent).toEqual({
    agents: [
      { user_id: "@bot1:example.com" },
      { user_id: "@bot2:example.com" },
    ],
  });

  // 4. 给原本只有 localpart 的 bot2 设置名字再清空 -> 回退到 localpart
  await user.click(screen.getAllByRole("button", { name: "编辑" })[1]);
  await user.type(screen.getByLabelText("手写名字（可选）"), "临时名字");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    expect(agentsSection).toHaveTextContent("临时名字");
  });

  await user.click(screen.getAllByRole("button", { name: "编辑" })[1]);
  await user.clear(screen.getByLabelText("手写名字（可选）"));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    expect(agentsSection).toHaveTextContent("bot2");
  });
  expect(agentsSection).not.toHaveTextContent("临时名字");

  // 5. 没有手写名时，增量同步带来 Matrix 显示名变更，名册展示自动跟着变
  first.unmount();
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "设置" }));
  const syncedAgents = screen.getByRole("region", { name: "Bot 名册" });
  expect(syncedAgents).toHaveTextContent("Bot1同步新显示名");
  expect(syncedAgents).not.toHaveTextContent("Bot1矩阵名");
});

test("移除 Bot 需二次确认且说明不影响已有 Topic 与交流，仅剩一个时禁止移除，移除后不删 Topic 不退房且标题不显示完整用户 ID", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let putAttempt = 0;
  let storedAgentsContent: unknown = {
    agents: [
      { user_id: "@bot1:example.com", name: "一号手写" },
      { user_id: "@bot2:example.com", name: "二号手写" },
      { user_id: "@bot3:example.com", name: "三号手写" },
    ],
  };

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: {
            events: [{ type: "im.waypoint.agents", content: storedAgentsContent }],
          },
          rooms: {
            join: {
              "!t2:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 2000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot2:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "二号的话题" } },
                    { type: "m.room.member", state_key: "@bot2:example.com", origin_server_ts: 2000, content: { membership: "join", displayname: "二号矩阵显示名" } },
                  ],
                },
                timeline: { events: [] },
              },
              "!t3:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 3000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot3:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "三号的话题" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      putAttempt += 1;
      if (putAttempt === 1) {
        return { type: "failure", failure: { type: "timeout" } };
      }
      storedAgentsContent = input.body;
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "设置" }));

  // 有 3 个 Bot 时均可点击移除
  let removeButtons = screen.getAllByRole("button", { name: "移除" });
  expect(removeButtons).toHaveLength(3);
  for (const btn of removeButtons) {
    expect(btn).not.toBeDisabled();
  }

  // 点击移除 @bot2：先二次确认，不立即发请求
  await user.click(removeButtons[1]);
  const confirmDialog = screen.getByRole("alertdialog", { name: "确认移除 Bot" });
  expect(confirmDialog).toHaveTextContent("不会删除已有 Topic");
  expect(confirmDialog).toHaveTextContent("已有交流不受影响");
  expect(putAttempt).toBe(0);

  // 取消确认不发送请求
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(putAttempt).toBe(0);

  // 再次点移除 @bot2 并确认：第一次超时失败，留在确认框并报错，列表不做乐观更新
  await user.click(screen.getAllByRole("button", { name: "移除" })[1]);
  await user.click(screen.getByRole("button", { name: "确认移除" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("移除 Bot 失败，因为超时。");
  expect(screen.getByRole("alertdialog", { name: "确认移除 Bot" })).toBeInTheDocument();
  const agentsSection = screen.getByRole("region", { name: "Bot 名册" });
  expect(agentsSection).toHaveTextContent("@bot2:example.com");

  // 重试确认成功移除 @bot2
  await user.click(screen.getByRole("button", { name: "确认移除" }));
  await waitFor(() => {
    expect(agentsSection).not.toHaveTextContent("@bot2:example.com");
  });

  // 移除 @bot3，使名册只剩 @bot1（1 个 Bot）
  await user.click(screen.getAllByRole("button", { name: "移除" })[1]);
  await user.click(screen.getByRole("button", { name: "确认移除" }));
  await waitFor(() => {
    expect(agentsSection).not.toHaveTextContent("@bot3:example.com");
  });

  // 名册只剩一个 Bot 时，移除按钮禁用
  removeButtons = screen.getAllByRole("button", { name: "移除" });
  expect(removeButtons).toHaveLength(1);
  expect(removeButtons[0]).toBeDisabled();

  // 不调用 leave 或 forget，已有 Topic 仍留在列表
  expect(homeserver.requests.some((req) => req.url.includes("/leave") || req.url.includes("/forget"))).toBe(false);
  expect(screen.getByRole("button", { name: /二号的话题/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /三号的话题/ })).toBeInTheDocument();

  // 打开已移除 Bot 的 Topic：按显示名或 localpart 显示，不显示完整用户 ID
  await user.click(screen.getByRole("button", { name: /二号的话题/ }));
  const banner2 = screen.getByRole("banner");
  expect(banner2).toHaveTextContent("二号矩阵显示名");
  expect(banner2).not.toHaveTextContent("二号手写");
  expect(banner2).not.toHaveTextContent("@bot2:example.com");

  await user.click(screen.getByRole("button", { name: /三号的话题/ }));
  const banner3 = screen.getByRole("banner");
  expect(banner3).toHaveTextContent("bot3");
  expect(banner3).not.toHaveTextContent("三号手写");
  expect(banner3).not.toHaveTextContent("@bot3:example.com");
});

test("新建 Topic 内可直接登记新 Bot：单 Bot 时不显示选择器，失败保留表单输入，成功后自动选中并可用于创建 Topic", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let putAttempt = 0;
  let storedAgentsContent: unknown = {
    agents: [{ user_id: "@bot1:example.com", name: "一号" }],
  };
  let createdBody: unknown;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: {
            events: [{ type: "im.waypoint.agents", content: storedAgentsContent }],
          },
        },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      putAttempt += 1;
      if (putAttempt === 1) {
        return {
          type: "response",
          status: 500,
          body: { errcode: "M_UNKNOWN", error: "temporary failure" },
        };
      }
      storedAgentsContent = input.body;
      return { type: "response", status: 200, body: {} };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/m.direct")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      createdBody = input.body;
      return { type: "response", status: 200, body: { room_id: "!newroom:example.com" } };
    }
    if (input.method === "GET" && input.url.includes("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);

  await user.click(await screen.findByRole("button", { name: "新建 Topic" }));
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("Topic 名字"), "跨项目协作");
  await user.type(screen.getByLabelText(/Description/), "需要二号 Bot 协助");

  // 点击新建 Topic 表单内的快捷登记入口
  await user.click(screen.getByRole("button", { name: "登记新 Bot" }));
  const quickRegion = screen.getByRole("region", { name: "登记新 Bot" });
  expect(quickRegion).toBeInTheDocument();

  // Topic 名字和 Description 仍留在表单里
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("跨项目协作");
  expect(screen.getByLabelText(/Description/)).toHaveValue("需要二号 Bot 协助");

  // 重复校验
  await user.type(screen.getByLabelText("Matrix 用户 ID"), "@bot1:example.com");
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已经在名册里");
  expect(putAttempt).toBe(0);

  // 填写新 Bot，第一次 PUT 失败保留输入并报错
  await user.clear(screen.getByLabelText("Matrix 用户 ID"));
  await user.type(screen.getByLabelText("Matrix 用户 ID"), "@bot2:example.com");
  await user.type(screen.getByLabelText("手写名字（可选）"), "协作二号");
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("temporary failure");
  expect(screen.getByLabelText("Matrix 用户 ID")).toHaveValue("@bot2:example.com");
  expect(screen.getByLabelText("手写名字（可选）")).toHaveValue("协作二号");
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();

  // 重试登记成功：显示绑定 Bot 下拉框并自动选中刚登记的 @bot2:example.com
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));
  const select = (await screen.findByLabelText("绑定 Bot")) as HTMLSelectElement;
  expect(select.value).toBe("@bot2:example.com");
  expect(screen.queryByRole("region", { name: "登记新 Bot" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("跨项目协作");
  expect(screen.getByLabelText(/Description/)).toHaveValue("需要二号 Bot 协助");

  // 提交创建 Topic，确认绑定的是新登记的 @bot2:example.com
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));
  await waitFor(() => {
    expect(screen.getByRole("banner")).toHaveTextContent("跨项目协作");
  });
  expect(screen.getByRole("banner")).toHaveTextContent("协作二号");
  expect(createdBody).toMatchObject({
    name: "跨项目协作",
    topic: "需要二号 Bot 协助",
    invite: ["@bot2:example.com"],
    initial_state: expect.arrayContaining([
      {
        type: "im.waypoint.topic",
        state_key: "",
        content: { v: 1, agent_user_id: "@bot2:example.com" },
      },
    ]),
  });
});

test("名册写入失败不进重试队列；两台设备同时改名册时直接 PUT 以最后写入为准", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let putAttempt = 0;
  let serverAgents: unknown = {
    agents: [{ user_id: "@bot1:example.com" }],
  };

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncCalls}`,
          account_data: {
            events: [{ type: "im.waypoint.agents", content: serverAgents }],
          },
        },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      putAttempt += 1;
      if (putAttempt === 1) {
        return { type: "failure", failure: { type: "network" } };
      }
      serverAgents = input.body;
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock, unmount } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "登记新 Bot" }));

  // 第一次提交失败后推进时钟，不会自动重试 PUT
  await user.type(screen.getByLabelText("Matrix 用户 ID"), "@bot3:example.com");
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("到达不了");
  expect(putAttempt).toBe(1);

  act(() => {
    clock.advance(60000);
  });
  expect(putAttempt).toBe(1);

  // 模拟另一台设备在服务端先写入了 @bot2:example.com
  serverAgents = {
    agents: [{ user_id: "@bot1:example.com" }, { user_id: "@bot2:example.com", name: "设备A" }],
  };

  // 本机再点提交：不先 GET，直接 PUT，后写入的本机结果覆盖为准
  const requestsBeforeRetry = homeserver.requests.length;
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));
  const agentsSection = screen.getByRole("region", { name: "Bot 名册" });
  await waitFor(() => {
    expect(agentsSection).toHaveTextContent("@bot3:example.com");
  });

  const retryRequests = homeserver.requests.slice(requestsBeforeRetry);
  expect(retryRequests.some((req) => req.method === "GET" && req.url.includes("account_data"))).toBe(false);
  expect(serverAgents).toEqual({
    agents: [{ user_id: "@bot1:example.com" }, { user_id: "@bot3:example.com" }],
  });

  // 重启同步以服务端后写入的结果为准
  unmount();
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "设置" }));
  const syncedAgents = screen.getByRole("region", { name: "Bot 名册" });
  expect(syncedAgents).toHaveTextContent("@bot3:example.com");
  expect(syncedAgents).not.toHaveTextContent("@bot2:example.com");
});

test("在 Topic 固定顶栏可编辑名字和 Description：提交期间锁定且不做乐观更新，确认后写入房间状态并持久化（不写 account data、列表不显示 Description）", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const namePutDeferred = deferred<TransportResult>();
  const topicPutDeferred = deferred<TransportResult>();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      if (input.url.includes("since=")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
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
                    { type: "m.room.name", state_key: "", content: { name: "旧名字" } },
                    { type: "m.room.topic", state_key: "", content: { topic: "旧上下文" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/state/m.room.name")) {
      return namePutDeferred.promise;
    }
    if (input.method === "PUT" && input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/state/m.room.topic")) {
      return topicPutDeferred.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);

  const rowBefore = await screen.findByRole("button", { name: "旧名字" });
  expect(rowBefore).not.toHaveTextContent("旧上下文");
  await user.click(rowBefore);

  const headerBefore = screen.getByRole("banner");
  expect(headerBefore).toHaveTextContent("旧名字");
  expect(headerBefore).toHaveTextContent("旧上下文");

  await user.click(screen.getByRole("button", { name: "编辑" }));
  const editRegion = screen.getByRole("region", { name: "编辑 Topic" });
  expect(editRegion).toBeVisible();

  const nameField = screen.getByLabelText("Topic 名字");
  const descField = screen.getByLabelText(/Description/);
  expect(nameField).toHaveValue("旧名字");
  expect(descField).toHaveValue("旧上下文");

  await user.clear(nameField);
  await user.type(nameField, "  新名字  ");
  await user.clear(descField);
  await user.type(descField, "  新上下文  ");

  const saveButton = screen.getByRole("button", { name: "保存" });
  await user.click(saveButton);

  // 提交期间锁定输入与提交按钮，确认前不做乐观更新
  await waitFor(() => {
    expect(saveButton).toBeDisabled();
  });
  expect(nameField).toBeDisabled();
  expect(descField).toBeDisabled();
  await user.click(saveButton);

  const namePuts = homeserver.requests.filter(
    (r) => r.method === "PUT" && r.url.includes("/state/m.room.name"),
  );
  const topicPuts = homeserver.requests.filter(
    (r) => r.method === "PUT" && r.url.includes("/state/m.room.topic"),
  );
  expect(namePuts).toHaveLength(1);
  expect(topicPuts).toHaveLength(1);
  expect(namePuts[0]?.headers.Authorization).toBe("Bearer tok-1");
  expect(namePuts[0]?.body).toEqual({ name: "新名字" });
  expect(topicPuts[0]?.body).toEqual({ topic: "新上下文" });
  expect(homeserver.requests.some((r) => r.url.includes("/account_data/"))).toBe(false);

  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toHaveTextContent("旧名字");
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).not.toHaveTextContent("新名字");
  expect(screen.getByRole("banner")).toHaveTextContent("旧名字");
  expect(screen.getByRole("banner")).toHaveTextContent("旧上下文");

  await act(async () => {
    namePutDeferred.resolve({ type: "response", status: 200, body: { event_id: "$ev-name" } });
    topicPutDeferred.resolve({ type: "response", status: 200, body: { event_id: "$ev-topic" } });
  });

  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
  });

  const rowAfter = screen.getByRole("button", { name: "新名字" });
  expect(rowAfter).not.toHaveTextContent("新上下文");
  const headerAfter = screen.getByRole("banner");
  expect(headerAfter).toHaveTextContent("新名字");
  expect(headerAfter).toHaveTextContent("新上下文");

  // 重启后从本地耐久状态保留更新后的名字与 Description
  first.unmount();
  renderApp(homeserver);
  const persistedRow = await screen.findByRole("button", { name: "新名字" });
  expect(persistedRow).not.toHaveTextContent("新上下文");
  await user.click(persistedRow);
  expect(screen.getByRole("banner")).toHaveTextContent("新名字");
  expect(screen.getByRole("banner")).toHaveTextContent("新上下文");
});

test("编辑 Topic 只对实际变更的字段发请求：校验空名字、跳过未改动字段、支持清空 Description 为空串", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      if (input.url.includes("since=")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
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
                    { type: "m.room.name", state_key: "", content: { name: "初始名" } },
                    { type: "m.room.topic", state_key: "", content: { topic: "初始说明" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/state/m.room.name")) {
      return { type: "response", status: 200, body: { event_id: "$ev-name" } };
    }
    if (input.method === "PUT" && input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/state/m.room.topic")) {
      return { type: "response", status: 200, body: { event_id: "$ev-topic" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "初始名" }));

  // 1. 清空名字只填空白时在本地拒绝且保留 Description 输入，不发请求
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.clear(screen.getByLabelText("Topic 名字"));
  await user.type(screen.getByLabelText("Topic 名字"), "   ");
  await user.clear(screen.getByLabelText(/Description/));
  await user.type(screen.getByLabelText(/Description/), "保留的草稿说明");
  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("请输入 Topic 名字");
  expect(screen.getByLabelText(/Description/)).toHaveValue("保留的草稿说明");
  expect(homeserver.requests.filter((r) => r.method === "PUT")).toHaveLength(0);

  // 2. 填回原值（仅带前后空白）提交时不发送任何请求
  await user.clear(screen.getByLabelText("Topic 名字"));
  await user.type(screen.getByLabelText("Topic 名字"), " 初始名 ");
  await user.clear(screen.getByLabelText(/Description/));
  await user.type(screen.getByLabelText(/Description/), " 初始说明 ");
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
  expect(homeserver.requests.filter((r) => r.method === "PUT")).toHaveLength(0);

  // 3. 只清空 Description（填空白）时只发送 m.room.topic: { topic: "" }，不发 m.room.name
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.clear(screen.getByLabelText(/Description/));
  await user.type(screen.getByLabelText(/Description/), "   ");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
  });
  const putsAfterClear = homeserver.requests.filter((r) => r.method === "PUT");
  expect(putsAfterClear).toHaveLength(1);
  expect(putsAfterClear[0]?.url).toContain("/state/m.room.topic");
  expect(putsAfterClear[0]?.body).toEqual({ topic: "" });
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-description")).toBeNull();

  // 4. Description 已为空时仅改名字，即使 Description 留空白也只发 m.room.name
  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.getByLabelText(/Description/)).toHaveValue("");
  await user.clear(screen.getByLabelText("Topic 名字"));
  await user.type(screen.getByLabelText("Topic 名字"), "仅改名字");
  await user.type(screen.getByLabelText(/Description/), "  ");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
  });
  const putsAfterRename = homeserver.requests.filter((r) => r.method === "PUT");
  expect(putsAfterRename).toHaveLength(2);
  expect(putsAfterRename[1]?.url).toContain("/state/m.room.name");
  expect(putsAfterRename[1]?.body).toEqual({ name: "仅改名字" });
  expect(screen.getByRole("banner")).toHaveTextContent("仅改名字");
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-description")).toBeNull();

  // 重启后仍保持新名字且 Description 为空
  first.unmount();
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "仅改名字" }));
  expect(screen.getByRole("banner")).toHaveTextContent("仅改名字");
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-description")).toBeNull();
});

test("编辑 Topic 全部失败时留在表单并保留所有输入，重试可成功", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let shouldFail = true;

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
                    { type: "m.room.name", state_key: "", content: { name: "原话题" } },
                    { type: "m.room.topic", state_key: "", content: { topic: "原说明" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/state/m.room.")) {
      if (shouldFail) {
        return { type: "response", status: 500, body: { errcode: "M_UNKNOWN", error: "Server busy" } };
      }
      return { type: "response", status: 200, body: { event_id: "$ok" } };
    }
    throw new Error(input.url);
  });

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "原话题" }));
  await user.click(screen.getByRole("button", { name: "编辑" }));

  await user.clear(screen.getByLabelText("Topic 名字"));
  await user.type(screen.getByLabelText("Topic 名字"), "失败保留名");
  await user.clear(screen.getByLabelText(/Description/));
  await user.type(screen.getByLabelText(/Description/), "失败保留说明");
  await user.click(screen.getByRole("button", { name: "保存" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Server busy");
  expect(alert).not.toHaveTextContent("M_UNKNOWN");
  expect(alert).not.toHaveTextContent("500");
  expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeVisible();
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("失败保留名");
  expect(screen.getByLabelText(/Description/)).toHaveValue("失败保留说明");
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toHaveTextContent("原话题");
  expect(screen.getByRole("banner")).toHaveTextContent("原说明");

  shouldFail = false;
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toHaveTextContent("失败保留名");
  expect(screen.getByRole("banner")).toHaveTextContent("失败保留名");
  expect(screen.getByRole("banner")).toHaveTextContent("失败保留说明");
});

test("同时修改名字和 Description 且只有一项成功时，成功的立即生效，失败项留在表单，重试只补发失败的那一项", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let failTopic = true;
  let failName = false;

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      if (input.url.includes("since=")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
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
                    { type: "m.room.name", state_key: "", content: { name: "最初名字" } },
                    { type: "m.room.topic", state_key: "", content: { topic: "最初说明" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/state/m.room.name")) {
      if (failName) {
        return { type: "failure", failure: { type: "network" } };
      }
      return { type: "response", status: 200, body: { event_id: "$name-ok" } };
    }
    if (input.method === "PUT" && input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/state/m.room.topic")) {
      if (failTopic) {
        return { type: "response", status: 500, body: { errcode: "M_UNKNOWN", error: "Topic write failed" } };
      }
      return { type: "response", status: 200, body: { event_id: "$topic-ok" } };
    }
    throw new Error(input.url);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "最初名字" }));

  // 子场景 A：名字成功、Description 失败
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.clear(screen.getByLabelText("Topic 名字"));
  await user.type(screen.getByLabelText("Topic 名字"), "已成新名");
  await user.clear(screen.getByLabelText(/Description/));
  await user.type(screen.getByLabelText(/Description/), "未成新说明");
  await user.click(screen.getByRole("button", { name: "保存" }));

  const alertA = await screen.findByRole("alert");
  expect(alertA).toHaveTextContent("Description");
  expect(alertA).toHaveTextContent("Topic write failed");
  expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeVisible();
  expect(screen.queryByLabelText("Topic 名字")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Description/)).toHaveValue("未成新说明");
  // 成功项立即在列表与顶栏生效
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toHaveTextContent("已成新名");
  expect(screen.getByRole("banner")).toHaveTextContent("已成新名");
  expect(screen.getByRole("banner")).toHaveTextContent("最初说明");

  // 重试：只补发 m.room.topic，不重发 m.room.name
  const putCountBeforeRetryA = homeserver.requests.filter((r) => r.method === "PUT").length;
  expect(putCountBeforeRetryA).toBe(2);
  failTopic = false;
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
  });
  const putsAfterRetryA = homeserver.requests.filter((r) => r.method === "PUT");
  expect(putsAfterRetryA).toHaveLength(3);
  expect(putsAfterRetryA[2]?.url).toContain("/state/m.room.topic");
  expect(putsAfterRetryA[2]?.body).toEqual({ topic: "未成新说明" });
  expect(screen.getByRole("banner")).toHaveTextContent("未成新说明");

  // 子场景 B：清空 Description 成功、改名失败
  failName = true;
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.clear(screen.getByLabelText("Topic 名字"));
  await user.type(screen.getByLabelText("Topic 名字"), "未成新名二");
  await user.clear(screen.getByLabelText(/Description/));
  await user.click(screen.getByRole("button", { name: "保存" }));

  const alertB = await screen.findByRole("alert");
  expect(alertB).toHaveTextContent("Topic 名字");
  expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeVisible();
  expect(screen.queryByLabelText(/Description/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("未成新名二");
  // 清空 Description 已立即生效，名字仍保持上一步的已成新名
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-description")).toBeNull();
  expect(screen.getByRole("complementary", { name: "Topic 列表" })).toHaveTextContent("已成新名");
  expect(screen.getByRole("banner")).toHaveTextContent("已成新名");

  // 重试：只补发 m.room.name，不重发 m.room.topic
  failName = false;
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
  });
  const putsAfterRetryB = homeserver.requests.filter((r) => r.method === "PUT");
  expect(putsAfterRetryB).toHaveLength(6);
  expect(putsAfterRetryB[5]?.url).toContain("/state/m.room.name");
  expect(putsAfterRetryB[5]?.body).toEqual({ name: "未成新名二" });

  // 重启后两侧更新均已持久化
  first.unmount();
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "未成新名二" }));
  expect(screen.getByRole("banner")).toHaveTextContent("未成新名二");
  expect(screen.getByRole("banner").querySelector(".waypoint-topic-description")).toBeNull();
});

test("窄视口下编辑 Topic 支持顶栏返回、系统返回逐级退回，提交中拦截返回并重对齐历史深度", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingPut = deferred<TransportResult>();

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
                    { type: "m.room.name", state_key: "", content: { name: "窄屏编辑话题" } },
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.endsWith("/_matrix/client/v3/rooms/!t1%3Aexample.com/state/m.room.name")) {
      return pendingPut.promise;
    }
    throw new Error(input.url);
  });

  const { detectPlatform } = await import("../adapters/production");
  const originalMatchMedia = window.matchMedia;
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

  window.history.replaceState({ testRoot: "narrow-edit" }, "");
  const pushSpy = vi.spyOn(window.history, "pushState");

  try {
    const view = render(
      <WaypointApp homeserver={homeserver} platform={detectPlatform()} clock={new ManualClock()} />,
    );
    await login(user);

    await user.click(await screen.findByRole("button", { name: "窄屏编辑话题" }));
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual({ waypointDepth: 1 });

    // 打开编辑推入第二层历史项
    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeVisible();
    expect(pushSpy).toHaveBeenCalledTimes(2);
    expect(window.history.state).toEqual({ waypointDepth: 2 });

    // 顶栏返回回到对话页（而非直接回到列表）
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Topic 列表" })).not.toBeInTheDocument();

    // 再次进入编辑并提交，在提交期间触发系统返回应停留在编辑页并重对齐深度=2
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("Topic 名字"));
    await user.type(screen.getByLabelText("Topic 名字"), "窄屏改名成功");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeVisible();
    expect(screen.getByLabelText("Topic 名字")).toHaveValue("窄屏改名成功");
    expect(window.history.state).toEqual({ waypointDepth: 2 });

    await act(async () => {
      pendingPut.resolve({ type: "response", status: 200, body: { event_id: "$ok" } });
    });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("banner")).toHaveTextContent("窄屏改名成功");
    expect(screen.getByRole("log", { name: "对话时间线" })).toBeVisible();

    // 等待退回对话页的异步 popstate 完成后，再触发系统返回回到 Topic 列表
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      window.history.back();
    });
    expect(await screen.findByRole("complementary", { name: "Topic 列表" })).toBeVisible();
    expect(screen.getByText("窄屏改名成功")).toBeInTheDocument();
    expect(window.history.state).toEqual({ testRoot: "narrow-edit" });

    view.unmount();
  } finally {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    pushSpy.mockRestore();
  }
});

test("另一台设备同步更新 Topic 名字与 Description（含清空）后列表与详情一致更新，列表行仍不显示 Description", async () => {
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
                      { type: "m.room.name", state_key: "", content: { name: "设备A旧名" } },
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
                    events: [
                      {
                        type: "m.room.name",
                        event_id: "$sync-name",
                        state_key: "",
                        origin_server_ts: 2000,
                        content: { name: "设备B新名" },
                      },
                      {
                        type: "m.room.topic",
                        event_id: "$sync-topic",
                        state_key: "",
                        origin_server_ts: 2001,
                        content: { topic: "设备B新上下文" },
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
          next_batch: "batch-3",
          rooms: {
            join: {
              "!t1:example.com": {
                state: {
                  events: [
                    {
                      type: "m.room.topic",
                      event_id: "$sync-topic-clear",
                      state_key: "",
                      origin_server_ts: 3000,
                      content: { topic: "" },
                    },
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

  // 设备 B 首次同步
  const deviceB1 = renderApp(homeserver);
  await login(user);
  expect(await screen.findByRole("button", { name: "设备A旧名" })).toBeInTheDocument();
  deviceB1.unmount();

  // 另一台设备改名并填写 Description 后同步回来
  const deviceB2 = renderApp(homeserver);
  const updatedRow = await screen.findByRole("button", { name: "设备B新名" });
  expect(updatedRow).not.toHaveTextContent("设备B新上下文");
  await user.click(updatedRow);
  const header2 = screen.getByRole("banner");
  expect(header2).toHaveTextContent("设备B新名");
  expect(header2).toHaveTextContent("设备B新上下文");
  deviceB2.unmount();

  // 另一台设备清空 Description 后同步回来
  renderApp(homeserver);
  const row3 = await screen.findByRole("button", { name: "设备B新名" });
  await user.click(row3);
  const header3 = screen.getByRole("banner");
  expect(header3).toHaveTextContent("设备B新名");
  expect(header3.querySelector(".waypoint-topic-description")).toBeNull();
});

test("点发送后，耐久写入失败时输入区不动、仍是草稿，不出现未确认气泡也不请求 Homeserver", async () => {
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
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "发消息话题" } },
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
  await user.click(await screen.findByRole("button", { name: "发消息话题" }));

  const input = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(input, "这条不能丢的草稿");

  const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw new DOMException("QuotaExceededError", "QuotaExceededError");
  });
  try {
    await user.click(screen.getByRole("button", { name: "发送" }));
  } finally {
    putSpy.mockRestore();
  }

  expect(input).toHaveValue("这条不能丢的草稿");
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).not.toHaveTextContent("这条不能丢的草稿");
  expect(screen.queryByLabelText("未确认")).not.toBeInTheDocument();
  expect(homeserver.requests.some((r) => r.url.includes("/send/"))).toBe(false);
});

test("发出文字后输入区清空，消息出现在时间线末尾靠右且只有未确认转圈，无时刻不可点不可丢掉，并按固定 txnId 发送 PUT", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingSend = deferred<TransportResult>();

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
                    { type: "m.room.name", state_key: "", content: { name: "发送气泡话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$prev1",
                      sender: "@bot:example.com",
                      origin_server_ts: 1500,
                      content: { msgtype: "m.text", body: "之前的回复" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }
    if (input.method === "PUT" && input.url.includes("/_matrix/client/v3/rooms/!t1%3Aexample.com/send/m.room.message/")) {
      return pendingSend.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "发送气泡话题" }));

  const input = screen.getByRole("textbox", { name: "输入消息" });
  await user.type(input, "你好，帮我查一下");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => {
    expect(input).toHaveValue("");
  });

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAttribute("data-side", "left");
  expect(rows[0]).toHaveTextContent("之前的回复");
  expect(rows[1]).toHaveAttribute("data-side", "right");
  expect(rows[1]).toHaveTextContent("你好，帮我查一下");

  // 画面上不写未确认、发送中或等登录；无障碍名称仍是未确认；转圈不可点击、不可丢掉
  expect(document.body).not.toHaveTextContent(/未确认|发送中|等登录/);
  const spinner = screen.getByRole("status", { name: "未确认" });
  expect(spinner).toBeInTheDocument();
  expect(spinner.tagName).not.toBe("BUTTON");
  expect(rows[1].contains(spinner)).toBe(true);
  expect(screen.queryByRole("button", { name: /丢掉|删除|撤回|未确认/ })).not.toBeInTheDocument();

  // 气泡上不显示时刻，也不能点开看时刻
  expect(rows[1]).not.toHaveTextContent(/\d{1,2}:\d{2}/);
  await user.click(screen.getByText("你好，帮我查一下"));
  await user.click(spinner);
  expect(document.body).not.toHaveTextContent(/\d{1,2}:\d{2}/);
  expect(screen.queryByRole("button", { name: /丢掉/ })).not.toBeInTheDocument();

  // 验证 PUT 请求格式与内容
  await waitFor(() => {
    const sendReqs = homeserver.requests.filter((r) => r.method === "PUT" && r.url.includes("/send/m.room.message/"));
    expect(sendReqs).toHaveLength(1);
    expect(sendReqs[0]?.headers.Authorization).toBe("Bearer tok-1");
    expect(sendReqs[0]?.body).toEqual({ msgtype: "m.text", body: "你好，帮我查一下" });
  });
});

test("发送响应先到达、同步回声后到达时，收成同一条已确认气泡且不出现第二条", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingSend = deferred<TransportResult>();
  let syncCalls = 0;
  let capturedTxnId = "";

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
                      { type: "m.room.name", state_key: "", content: { name: "先响应后同步" } },
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
            join: {
              "!t1:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$ev1",
                      sender: "@alice:example.com",
                      origin_server_ts: 5000,
                      content: { msgtype: "m.text", body: "先响应的消息" },
                      unsigned: { transaction_id: capturedTxnId },
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
      capturedTxnId = decodeURIComponent(input.url.split("/").pop() ?? "");
      return pendingSend.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "先响应后同步" }));

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "先响应的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByRole("status", { name: "未确认" })).toBeInTheDocument();
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(1);

  // 1. 发送响应先到达
  await act(async () => {
    pendingSend.resolve({
      type: "response",
      status: 200,
      body: { event_id: "$ev1" },
    });
  });

  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(1);
  expect(timeline).toHaveTextContent("先响应的消息");

  // 2. 随后增量 /sync 带来回声，仍收成同一条气泡
  await act(async () => {
    first.clock.advance(1000);
  });

  await waitFor(() => {
    expect(syncCalls).toBeGreaterThanOrEqual(2);
  });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(1);
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  expect(timeline).toHaveTextContent("先响应的消息");

  // 3. 重启后仍只有一条已确认气泡
  first.unmount();
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "先响应后同步" }));
  const restoredTimeline = screen.getByRole("log", { name: "对话时间线" });
  expect(restoredTimeline.querySelectorAll("[data-side]")).toHaveLength(1);
  expect(restoredTimeline).toHaveTextContent("先响应的消息");
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
});

test("同步回声先到达、发送响应后到达时，收成同一条已确认气泡且保留服务器时间戳", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingSend = deferred<TransportResult>();
  let syncCalls = 0;
  let capturedTxnId = "";

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
                      { type: "m.room.name", state_key: "", content: { name: "先同步后响应" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$day1",
                        sender: "@bot:example.com",
                        origin_server_ts: new Date(2026, 10, 11, 10, 0, 0).getTime(),
                        content: { msgtype: "m.text", body: "昨天的消息" },
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
          next_batch: "batch-2",
          rooms: {
            join: {
              "!t1:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$ev2",
                      sender: "@alice:example.com",
                      origin_server_ts: new Date(2026, 10, 12, 10, 0, 0).getTime(),
                      content: { msgtype: "m.text", body: "先同步的消息" },
                      unsigned: { transaction_id: capturedTxnId },
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
      capturedTxnId = decodeURIComponent(input.url.split("/").pop() ?? "");
      return pendingSend.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const clock = new ManualClock();
  clock.now = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const first = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "先同步后响应" }));

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "先同步的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByRole("status", { name: "未确认" })).toBeInTheDocument();
  await waitFor(() => {
    expect(capturedTxnId).not.toBe("");
  });

  // 1. 增量 /sync 回声先到达（PUT 仍在路上）
  await act(async () => {
    clock.advance(1000);
  });

  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });
  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(2);
  expect(timeline).toHaveTextContent("今天");

  // 2. 随后迟到的 PUT 响应到达，仍是一条气泡且不抹掉服务器时间戳（日期分隔仍在）
  await act(async () => {
    pendingSend.resolve({
      type: "response",
      status: 200,
      body: { event_id: "$ev2" },
    });
  });

  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(2);
  expect(timeline).toHaveTextContent("今天");
  expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();

  first.unmount();
});

test("同一次发送尝试在网络重试与重启恢复后始终使用固定的 txnId，确认后收成同一条气泡", async () => {
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
                    { type: "m.room.name", state_key: "", content: { name: "固定事务ID话题" } },
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
      if (sendAttempts <= 2) {
        return { type: "failure", failure: { type: "network" } };
      }
      return { type: "response", status: 200, body: { event_id: "$ev-fixed" } };
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
  });

  const first = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "固定事务ID话题" }));

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "重试仍同一个txnId");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => {
    expect(sendAttempts).toBe(1);
  });
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

  // 退避重试使用同一个 txnId
  await act(async () => {
    first.clock.advance(1000);
  });
  await waitFor(() => {
    expect(sendAttempts).toBe(2);
  });
  expect(screen.getByRole("status", { name: "未确认" })).toBeInTheDocument();

  // 卸载重启后恢复未确认气泡并继续使用同一个 txnId 重发，直到确认
  first.unmount();
  renderApp(homeserver);
  await user.click(await screen.findByRole("button", { name: "固定事务ID话题" }));

  await waitFor(() => {
    expect(sendAttempts).toBe(3);
  });
  await waitFor(() => {
    expect(screen.queryByRole("status", { name: "未确认" })).not.toBeInTheDocument();
  });

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline.querySelectorAll("[data-side]")).toHaveLength(1);
  expect(timeline).toHaveTextContent("重试仍同一个txnId");

  const putUrls = homeserver.requests
    .filter((r) => r.method === "PUT" && r.url.includes("/send/m.room.message/"))
    .map((r) => r.url);
  expect(putUrls).toHaveLength(3);
  expect(new Set(putUrls).size).toBe(1);
});

test("未确认的消息不撑开新的一天也不重排 Topic 列表，收到服务器确认回声的 origin_server_ts 后才跨日分隔并重排", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const pendingSend = deferred<TransportResult>();
  let syncCalls = 0;
  let capturedTxnId = "";

  const day1Ts = new Date(2026, 10, 10, 10, 0, 0).getTime();
  const day2Ts = new Date(2026, 10, 11, 10, 0, 0).getTime();
  const day3Ts = new Date(2026, 10, 12, 10, 0, 0).getTime();

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
                "!t-newer:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "较新话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$newer-msg",
                        sender: "@bot:example.com",
                        origin_server_ts: day2Ts,
                        content: { msgtype: "m.text", body: "昨天的新回复" },
                      },
                    ],
                  },
                },
                "!t-older:example.com": {
                  state: {
                    events: [
                      { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "较旧话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$older-msg",
                        sender: "@bot:example.com",
                        origin_server_ts: day1Ts,
                        content: { msgtype: "m.text", body: "前天的旧消息" },
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
          next_batch: "batch-2",
          rooms: {
            join: {
              "!t-older:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$ev-day3",
                      sender: "@alice:example.com",
                      origin_server_ts: day3Ts,
                      content: { msgtype: "m.text", body: "刚发出的文字" },
                      unsigned: { transaction_id: capturedTxnId },
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
      capturedTxnId = decodeURIComponent(input.url.split("/").pop() ?? "");
      return pendingSend.promise;
    }
    throw new Error(`不应发送 ${input.method} ${input.url}`);
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

  const sidebar = await screen.findByRole("complementary", { name: "Topic 列表" });
  const topicTitles = () =>
    Array.from(sidebar.querySelectorAll(".waypoint-topic-row-title")).map((el) => el.textContent);
  expect(topicTitles()).toEqual(["较新话题", "较旧话题"]);

  // 在较旧话题写草稿，切换话题不串草稿
  await user.click(screen.getByRole("button", { name: "较旧话题" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "刚发出的文字");
  await user.click(screen.getByRole("button", { name: "较新话题" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "较旧话题" }));
  expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("刚发出的文字");

  // 交出未确认消息：不撑开新的一天，也不重排 Topic 列表
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("status", { name: "未确认" })).toBeInTheDocument();

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  expect(timeline).toHaveTextContent("前天的旧消息");
  expect(timeline).toHaveTextContent("刚发出的文字");
  expect(timeline.querySelectorAll('[role="separator"]')).toHaveLength(0);
  expect(timeline).not.toHaveTextContent("今天");
  expect(topicTitles()).toEqual(["较新话题", "较旧话题"]);

  // 即使 PUT 响应先返回，在收到带 origin_server_ts 的同步回声前也不提前跨日或重排
  await act(async () => {
    pendingSend.resolve({ type: "response", status: 200, body: { event_id: "$ev-day3" } });
  });
  expect(timeline.querySelectorAll('[role="separator"]')).toHaveLength(0);
  expect(topicTitles()).toEqual(["较新话题", "较旧话题"]);

  // 同步回声带来服务器时间后，出现跨日分隔并重排到最前
  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(topicTitles()).toEqual(["较旧话题", "较新话题"]);
  });
  const separators = timeline.querySelectorAll('[role="separator"]');
  expect(separators).toHaveLength(1);
  expect(separators[0]).toHaveTextContent("今天");
});

test("新建尚未加入的 Topic 顶栏可从其他房间解析 Bot 的 Matrix 显示名，并在更新的 m.room.member 清空显示名后回退到 localpart", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let shouldClearDisplayName = false;
  let sentClearDisplayName = false;

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
                      { user_id: "@bot2:example.com" },
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
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot2:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "旧话题" } },
                      {
                        type: "m.room.member",
                        state_key: "@bot2:example.com",
                        origin_server_ts: 1000,
                        content: { membership: "join", displayname: "二号矩阵显示名" },
                      },
                    ],
                  },
                  timeline: { events: [] },
                },
              },
            },
          },
        };
      }
      if (shouldClearDisplayName && !sentClearDisplayName) {
        sentClearDisplayName = true;
        return {
          type: "response",
          status: 200,
          body: {
            next_batch: `batch-${syncCalls}`,
            rooms: {
              join: {
                "!t-old:example.com": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.member",
                        event_id: "$clear-name",
                        state_key: "@bot2:example.com",
                        origin_server_ts: 8000,
                        content: { membership: "join", displayname: "" },
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
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      return { type: "response", status: 200, body: { room_id: "!t-new:example.com" } };
    }
    if (input.method === "GET" && input.url.includes("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/m.direct")
    ) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await screen.findByRole("button", { name: /旧话题/ });

  // 让新建房间的时间戳大于旧房间的 1000，确保 invite 不会覆盖已知 displayname
  act(() => {
    clock.advance(5000);
  });

  await user.click(screen.getByRole("button", { name: "新建 Topic" }));
  await user.type(screen.getByLabelText("Topic 名字"), "新主题");
  await user.selectOptions(screen.getByLabelText("绑定 Bot"), "@bot2:example.com");
  await user.click(screen.getByRole("button", { name: "创建 Topic" }));

  await waitFor(() => {
    expect(screen.getByRole("banner")).toHaveTextContent("新主题");
  });
  expect(screen.getByRole("banner")).toHaveTextContent("二号矩阵显示名");
  expect(screen.getByRole("button", { name: /新主题/ })).toHaveTextContent("二号矩阵显示名");

  // 同步带来更新时间戳的 m.room.member 清空 displayname：覆盖旧房间显示名，回退为 localpart
  shouldClearDisplayName = true;
  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(screen.getByRole("banner")).toHaveTextContent("bot2");
  });
  expect(screen.getByRole("banner")).not.toHaveTextContent("二号矩阵显示名");
  expect(screen.getByRole("button", { name: /新主题/ })).toHaveTextContent("bot2");

  await user.click(screen.getByRole("button", { name: "设置" }));
  const agentsSection = screen.getByRole("region", { name: "Bot 名册" });
  expect(agentsSection).toHaveTextContent("bot2");
  expect(agentsSection).not.toHaveTextContent("二号矩阵显示名");
});

test("跨设备同时编辑与移除 Bot 时，另一设备同步移除后重试保存仍写回被编辑的 Bot（最后写入为准）", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;
  let putAttempt = 0;
  let serverAgents: unknown = {
    agents: [
      { user_id: "@bot1:example.com", name: "一号" },
      { user_id: "@bot2:example.com", name: "二号旧名" },
    ],
  };

  homeserver.handler = passwordLoginHandler(async (input) => {
    if (input.url.includes("/sync")) {
      syncCalls += 1;
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: `batch-${syncCalls}`,
          account_data: {
            events: [{ type: "im.waypoint.agents", content: serverAgents }],
          },
        },
      };
    }
    if (
      input.method === "PUT" &&
      input.url.endsWith("/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/im.waypoint.agents")
    ) {
      putAttempt += 1;
      if (putAttempt === 1) {
        return { type: "failure", failure: { type: "network" } };
      }
      serverAgents = input.body;
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`${input.method} ${input.url}`);
  });

  const { clock } = renderApp(homeserver);
  await login(user);
  await user.click(await screen.findByRole("button", { name: "设置" }));

  // 编辑 @bot2:example.com，首次保存失败
  await user.click(screen.getAllByRole("button", { name: "编辑" })[1]);
  const nameField = screen.getByLabelText("手写名字（可选）");
  await user.clear(nameField);
  await user.type(nameField, "二号新名");
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("到达不了");

  // 另一台设备在此期间移除了 @bot2:example.com，且本机同步到了该变更
  serverAgents = {
    agents: [{ user_id: "@bot1:example.com", name: "一号" }],
  };
  await act(async () => {
    clock.advance(1000);
  });
  const agentsSection = screen.getByRole("region", { name: "Bot 名册" });
  await waitFor(() => {
    expect(agentsSection).not.toHaveTextContent("@bot2:example.com");
  });

  // 本机重试保存编辑结果：仍 upsert 写回 @bot2:example.com 及其新名字
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => {
    expect(agentsSection).toHaveTextContent("二号新名");
  });
  expect(agentsSection).toHaveTextContent("@bot2:example.com");
  expect(serverAgents).toEqual({
    agents: [
      { user_id: "@bot1:example.com", name: "一号" },
      { user_id: "@bot2:example.com", name: "二号新名" },
    ],
  });
});

test("忽略非 m.text、空 body 与缺失 origin_server_ts 的异常边角，不画空气泡也不误插日期分隔", async () => {
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
                    { type: "m.room.name", state_key: "", content: { name: "消息边角话题" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$img-day1",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts,
                      content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.com/1" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$notice-day1",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts,
                      content: { msgtype: "m.notice", body: "系统通知文本" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$empty-day1",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts,
                      content: { msgtype: "m.text", body: "   " },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$missing-msgtype",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts,
                      content: { body: "缺msgtype的消息" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$valid-day2",
                      sender: "@bot:example.com",
                      origin_server_ts: day2Ts,
                      content: { msgtype: "m.text", body: "第一条真正会画出来的消息" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$no-ts",
                      sender: "@bot:example.com",
                      content: { msgtype: "m.text", body: "没有服务器时间的Agent消息" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$valid-day2-b",
                      sender: "@bot:example.com",
                      origin_server_ts: day2Ts + 60_000,
                      content: { msgtype: "m.text", body: "同一天的第二条" },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$empty-day3",
                      sender: "@bot:example.com",
                      origin_server_ts: day3Ts,
                      content: { msgtype: "m.text", body: "" },
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
  await user.click(await screen.findByRole("button", { name: "消息边角话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveAttribute("data-side", "left");
  expect(rows[0]).toHaveTextContent("第一条真正会画出来的消息");
  expect(rows[1]).toHaveAttribute("data-side", "left");
  expect(rows[1]).toHaveTextContent("没有服务器时间的Agent消息");
  expect(rows[2]).toHaveAttribute("data-side", "left");
  expect(rows[2]).toHaveTextContent("同一天的第二条");

  expect(timeline).not.toHaveTextContent("photo.png");
  expect(timeline).not.toHaveTextContent("系统通知文本");
  expect(timeline).not.toHaveTextContent("缺msgtype的消息");
  expect(timeline.querySelectorAll("[role=\"separator\"]")).toHaveLength(0);
});

test("Agent 消息靠左且气泡无名字头像时刻，只渲染 body（纯文本、不读 formatted_body、不注入 HTML），m.replace 不画第二条", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  const day1Ts = new Date(2026, 10, 10, 9, 45, 0).getTime();
  const day2Ts = new Date(2026, 10, 11, 14, 30, 0).getTime();

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
                  agents: [{ user_id: "@bot:example.com", name: "小助" }],
                },
              },
            ],
          },
          rooms: {
            join: {
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: day1Ts, content: {} },
                    { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                    { type: "m.room.name", state_key: "", content: { name: "只读正文话题" } },
                    {
                      type: "m.room.member",
                      state_key: "@bot:example.com",
                      origin_server_ts: day1Ts,
                      content: { membership: "join", displayname: "Matrix昵称", avatar_url: "mxc://example.com/avatar" },
                    },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$agent-1",
                      sender: "@bot:example.com",
                      origin_server_ts: day1Ts,
                      content: {
                        msgtype: "m.text",
                        body: "纯文本正文 <b>字面标签</b> <script>window.__waypointXss=true</script>",
                        format: "org.matrix.custom.html",
                        formatted_body: "<p>绝不应渲染的HTML</p><img src=\"x\" onerror=\"window.__waypointXss=true\"><script>window.__waypointXss=true</script>",
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$agent-only-html",
                      sender: "@bot:example.com",
                      origin_server_ts: day2Ts,
                      content: {
                        msgtype: "m.text",
                        format: "org.matrix.custom.html",
                        formatted_body: "<p>只有formatted_body没有body</p>",
                      },
                    },
                    {
                      type: "m.room.message",
                      event_id: "$agent-replace",
                      sender: "@bot:example.com",
                      origin_server_ts: day2Ts,
                      content: {
                        msgtype: "m.text",
                        body: "* 替换后的回退文本",
                        "m.new_content": { msgtype: "m.text", body: "替换后的新内容" },
                        "m.relates_to": { rel_type: "m.replace", event_id: "$agent-missing" },
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
  clock.now = day2Ts;
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "只读正文话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const rows = timeline.querySelectorAll("[data-side]");
  expect(rows).toHaveLength(1);
  const agentRow = rows[0];
  expect(agentRow).toHaveAttribute("data-side", "left");
  expect(agentRow).toHaveClass("left");

  // 只渲染 body 原文（作为纯文本节点），不读 formatted_body，不注入 HTML，不执行 script
  const bubble = agentRow.querySelector(".waypoint-bubble");
  expect(bubble).not.toBeNull();
  expect(bubble?.textContent).toBe(
    "纯文本正文 <b>字面标签</b> <script>window.__waypointXss=true</script>",
  );
  expect(bubble?.querySelector("b")).toBeNull();
  expect(bubble?.querySelector("script")).toBeNull();
  expect(bubble?.querySelector("img")).toBeNull();
  expect(bubble?.querySelector("p")).toBeNull();
  expect((window as { __waypointXss?: boolean }).__waypointXss).toBeUndefined();
  expect(timeline).not.toHaveTextContent("绝不应渲染的HTML");
  expect(timeline).not.toHaveTextContent("只有formatted_body没有body");

  // 气泡上不写名字（手写名、显示名、localpart、完整 ID）、不放头像、不显示时刻
  expect(agentRow).not.toHaveTextContent(/小助|Matrix昵称|@bot:example\.com|9:45|09:45/);
  expect(agentRow.querySelector("img")).toBeNull();
  expect(timeline.querySelector("img")).toBeNull();

  // m.replace 不画成第二条气泡，也不触发跨日分隔
  expect(timeline).not.toHaveTextContent("替换后的回退文本");
  expect(timeline).not.toHaveTextContent("替换后的新内容");
  expect(timeline.querySelectorAll("[role=\"separator\"]")).toHaveLength(0);
});

test("本地日历日变更才插入日期分隔（今天/昨天/无时刻本地日期），第一条上无分隔，空过日子不补，分隔不占左右", async () => {
  const user = userEvent.setup();
  const homeserver = new FakeHomeserver();
  let syncCalls = 0;

  const nov1Ts = new Date(2026, 10, 1, 12, 0, 0).getTime();
  const nov5Ts = new Date(2026, 10, 5, 22, 15, 0).getTime();
  const yesterdayMorningTs = new Date(2026, 10, 11, 8, 5, 0).getTime();
  const yesterdayNightTs = new Date(2026, 10, 11, 23, 59, 0).getTime();
  const todayTs = new Date(2026, 10, 12, 0, 1, 0).getTime();
  const expectedNov5Label = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(nov5Ts));

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
                      { type: "m.room.create", state_key: "", origin_server_ts: nov1Ts, content: {} },
                      { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
                      { type: "m.room.name", state_key: "", content: { name: "日期分隔话题" } },
                    ],
                  },
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        event_id: "$m-nov1",
                        sender: "@bot:example.com",
                        origin_server_ts: nov1Ts,
                        content: { msgtype: "m.text", body: "11月1日消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m-nov5",
                        sender: "@bot:example.com",
                        origin_server_ts: nov5Ts,
                        content: { msgtype: "m.text", body: "11月5日消息" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m-yday-1",
                        sender: "@alice:example.com",
                        origin_server_ts: yesterdayMorningTs,
                        content: { msgtype: "m.text", body: "昨天上午" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m-yday-2",
                        sender: "@bot:example.com",
                        origin_server_ts: yesterdayNightTs,
                        content: { msgtype: "m.text", body: "昨天深夜" },
                      },
                      {
                        type: "m.room.message",
                        event_id: "$m-today",
                        sender: "@bot:example.com",
                        origin_server_ts: todayTs,
                        content: { msgtype: "m.text", body: "今天凌晨" },
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
          next_batch: "batch-2",
          rooms: {
            join: {
              "!t1:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$m-today-2",
                      sender: "@bot:example.com",
                      origin_server_ts: todayTs + 30_000,
                      content: { msgtype: "m.text", body: "今天第二条" },
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
  clock.now = new Date(2026, 10, 12, 9, 0, 0).getTime();
  render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS" }}
      clock={clock}
    />,
  );
  await login(user);
  await user.click(await screen.findByRole("button", { name: "日期分隔话题" }));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const children = Array.from(timeline.children);
  expect(children.map((el) => el.getAttribute("role") ?? el.getAttribute("data-side"))).toEqual([
    "left",
    "separator",
    "left",
    "separator",
    "right",
    "left",
    "separator",
    "left",
  ]);

  const separators = Array.from(timeline.querySelectorAll('[role="separator"]'));
  expect(separators).toHaveLength(3);
  expect(separators[0].textContent).toBe(expectedNov5Label);
  expect(separators[0].textContent).not.toMatch(/\d{1,2}:\d{2}/);
  expect(separators[1].textContent).toBe("昨天");
  expect(separators[2].textContent).toBe("今天");
  for (const sep of separators) {
    expect(sep).not.toHaveAttribute("data-side");
    expect(sep).not.toHaveClass("waypoint-message-row");
    expect(sep.querySelector(".waypoint-bubble")).toBeNull();
  }

  // 增量同步同天消息不新增分隔，且原分隔 DOM 节点保持稳定
  const firstSepNode = separators[0];
  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(timeline).toHaveTextContent("今天第二条");
  });
  const separatorsAfter = Array.from(timeline.querySelectorAll('[role="separator"]'));
  expect(separatorsAfter).toHaveLength(3);
  expect(separatorsAfter[0]).toBe(firstSepNode);
});

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
      throw new Error(`不应在后台拉取历史消息：${input.url}`);
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
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(2));
  await waitFor(() => expect(topicTitles()).toEqual(["话题一", "话题二"]));

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
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(3));
  await waitFor(() => expect(timeline.querySelectorAll("[data-side]")).toHaveLength(26));
  expect(timeline).toHaveTextContent("消息-26");
  expect(timeline).toHaveTextContent("消息-30");

  // 等待一段时间也不会在后台发 /messages 补齐缺口
  await act(async () => { clock.advance(10_000); });
  expect(homeserver.requests.some((r) => r.url.includes("/messages"))).toBe(false);
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
  let rejectTokenOnSend = true;

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
  await waitFor(() => expect(sendCalls).toBe(1));

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
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第二条");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(screen.getAllByRole("status", { name: "未确认" })).toHaveLength(2);

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
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "离线第二条");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(offlineTxns.length).toBeGreaterThanOrEqual(1));
  expect(screen.getAllByRole("status", { name: "未确认" })).toHaveLength(2);

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
  await user.click(screen.getByRole("button", { name: "确认退出" }));

  // 回到保留地址和用户标识的密码步，密码为空，不再处于已连接
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.getByText("尚未进入 Topic 列表")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();

  // 发送了 logout，且未删除设备、未退房、未删消息、未写已读位置或 account_data
  const logouts = homeserver.requests.filter((r) => r.url.endsWith("/_matrix/client/v3/logout"));
  expect(logouts).toHaveLength(1);
  expect(logouts[0]).toMatchObject({
    method: "POST",
    url: "https://matrix.example.com/_matrix/client/v3/logout",
    headers: { Authorization: "Bearer tok-1" },
  });
  expect(
    homeserver.requests.some(
      (r) =>
        r.url.includes("/devices") ||
        r.url.includes("/leave") ||
        r.url.includes("/forget") ||
        r.url.includes("/redact") ||
        r.url.includes("/read_markers") ||
        r.url.includes("/account_data"),
    ),
  ).toBe(false);

  // 停掉前台同步与重试定时器
  const syncsBeforeAdvance = syncCalls;
  const sendsBeforeAdvance = sendCalls;
  await act(async () => {
    first.clock.advance(60_000);
  });
  expect(syncCalls).toBe(syncsBeforeAdvance);
  expect(sendCalls).toBe(sendsBeforeAdvance);

  // 重启应用：直接停在保留地址和用户标识的空密码步，不发起同步
  first.unmount();
  const second = renderApp(homeserver);
  expect(await screen.findByLabelText("密码")).toHaveValue("");
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
  expect(screen.getByText("https://matrix.example.com")).toBeInTheDocument();
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  expect(syncCalls).toBe(syncsBeforeAdvance);

  // 重新登录：同步游标已清空（首次同步不带 since），原未发送草稿与重试队列都已清空
  const syncCountBeforeRelogin = syncUrls.length;
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));

  await user.click(await screen.findByRole("button", { name: "退出清理测试" }));
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
    expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
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
