import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import type { Clock, HomeserverRequest, HomeserverTransport, PlatformAdapter, TransportResult } from "../adapters/types";
import { detectPlatform } from "../adapters/production";
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

async function advanceWhenTimerScheduled(clock: ManualClock, ms: number) {
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => {
    clock.advance(ms);
  });
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

function renderApp(
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

  // 立即打开。顶栏只显示 Topic 名字，不放 Bot 名字或完整用户 ID
  const header = await screen.findByRole("banner");
  expect(header).toHaveTextContent("架构讨论");
  expect(header).not.toHaveTextContent("工作助理");
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
  expect(header).not.toHaveTextContent("bot2");
  expect(header).not.toHaveTextContent("@bot2:example.com");
  expect(screen.getByRole("button", { name: /重复名字/ })).toHaveTextContent("bot2");

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
  expect(secondHeader).not.toHaveTextContent("一号助理");
  expect(screen.getAllByRole("button", { name: /重复名字/ }).some((button) => button.textContent?.includes("一号助理"))).toBe(true);
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
  expect(header).toHaveTextContent("保留这些描述");
  expect(header).not.toHaveTextContent("二号");
  expect(screen.getByRole("button", { name: /不丢草稿的话题/ })).toHaveTextContent("二号");
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
  expect(header).not.toHaveTextContent("助手");

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

  // 逐条打开。Bot 名字只在列表行解析，顶栏不放 Bot
  const list = screen.getByRole("complementary", { name: "Topic 列表" });
  await user.click(within(list).getByRole("button", { name: "话题一" }));
  expect(within(list).getByRole("button", { name: "话题一" })).toHaveTextContent("手写一号");
  expect(screen.getByRole("banner")).toHaveTextContent("话题一");
  expect(screen.getByRole("banner")).not.toHaveTextContent("手写一号");
  expect(screen.getByRole("banner")).not.toHaveTextContent("服务器显示名不应覆盖手写");

  await user.click(within(list).getByRole("button", { name: "话题二" }));
  expect(within(list).getByRole("button", { name: "话题二" })).toHaveTextContent("小赫显示名");
  expect(screen.getByRole("banner")).toHaveTextContent("话题二说明");
  expect(screen.getByRole("banner")).not.toHaveTextContent("小赫显示名");

  await user.click(within(list).getByRole("button", { name: "话题三" }));
  expect(within(list).getByRole("button", { name: "话题三" })).toHaveTextContent("bot3");
  expect(screen.getByRole("banner")).not.toHaveTextContent("bot3");
  expect(screen.getByRole("banner")).not.toHaveTextContent("@bot3:example.com");

  // 重启后先展示本地缓存，再等增量 sync 的 rooms.leave 把离开的房间移出列表
  first.unmount();
  renderApp(homeserver);
  expect(await screen.findByText("话题一")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByText("话题三")).not.toBeInTheDocument();
  });
});

test("名册里只有一个合法 Bot（忽略自己、跨服和重复项）时不显示选择与列表副标题，顶栏只显示 Topic 名字且空 Description 不占元素", async () => {
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
  expect(header1).not.toHaveTextContent("唯一助理");
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
  expect(header2).not.toHaveTextContent("唯一助理");
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
  expect(header).not.toHaveTextContent("bot");
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
  expect(header).not.toHaveTextContent("小助理");
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

  // 名册只剩一个 Bot 后，顶栏不放解析名，也不显示完整用户 ID
  await user.click(screen.getByRole("button", { name: /二号的话题/ }));
  const banner2 = screen.getByRole("banner");
  expect(banner2).toHaveTextContent("二号的话题");
  expect(banner2).not.toHaveTextContent("二号矩阵显示名");
  expect(banner2).not.toHaveTextContent("二号手写");
  expect(banner2).not.toHaveTextContent("@bot2:example.com");

  await user.click(screen.getByRole("button", { name: /三号的话题/ }));
  const banner3 = screen.getByRole("banner");
  expect(banner3).toHaveTextContent("三号的话题");
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
  expect(screen.getByRole("banner")).toHaveTextContent("需要二号 Bot 协助");
  expect(screen.getByRole("banner")).not.toHaveTextContent("协作二号");
  expect(screen.getByRole("button", { name: /跨项目协作/ })).toHaveTextContent("协作二号");
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
  expect(within(timeline).queryByRole("button", { name: /丢掉|删除|撤回|未确认/ })).not.toBeInTheDocument();

  // 气泡上不显示时刻，也不能点开看时刻
  expect(rows[1]).not.toHaveTextContent(/\d{1,2}:\d{2}/);
  await user.click(screen.getByText("你好，帮我查一下"));
  await user.click(spinner);
  expect(document.querySelector(".waypoint-detail")).not.toHaveTextContent(/\d{1,2}:\d{2}/);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
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
  expect(screen.getByRole("banner")).not.toHaveTextContent("二号矩阵显示名");
  expect(screen.getByRole("button", { name: /新主题/ })).toHaveTextContent("二号矩阵显示名");

  // 同步带来更新时间戳的 m.room.member 清空 displayname：覆盖旧房间显示名，回退为 localpart
  shouldClearDisplayName = true;
  await act(async () => {
    clock.advance(1000);
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /新主题/ })).toHaveTextContent("bot2");
  });
  expect(screen.getByRole("banner")).not.toHaveTextContent("bot2");
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
                      content: { msgtype: "m.emote", body: "photo.png" },
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
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
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
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
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
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
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
  expect(screen.getByLabelText("用户标识")).toHaveValue("@alice:example.com");
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
  expect(missingRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "400" });

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
  expect(conflictRow.querySelector(".waypoint-topic-name")).toHaveStyle({ fontWeight: "400" });

  // 第 3 轮：陈旧标记试图回退到 $e-earlier-in-tl -> 仍保持已读且不写回服务器
  await waitFor(() => expect(clock.timerCount).toBeGreaterThan(0));
  await act(async () => { clock.advance(1000); });
  await waitFor(() => expect(syncRound).toBe(3));
  expect(conflictRow).not.toHaveAttribute("data-unread", "true");
  expect(homeserver.requests.some((r) => r.url.includes("/read_markers"))).toBe(false);
});

function withMockedTimelineLayout<T>(
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
      expectedAlert: "删除 Topic 失败，因为到达不了。",
    },
    {
      name: "超时",
      respond: async () => ({ type: "failure", failure: { type: "timeout" } }),
      expectedAlert: "删除 Topic 失败，因为超时。",
    },
    {
      name: "500 错误",
      respond: async () => ({
        type: "response",
        status: 500,
        body: { errcode: "M_UNKNOWN", error: "Leave failed" },
      }),
      expectedAlert: "删除 Topic 失败，因为 Homeserver 暂时不能完成请求：Leave failed。",
    },
    {
      name: "403 拒绝",
      respond: async () => ({
        type: "response",
        status: 403,
        body: { errcode: "M_FORBIDDEN", error: "Cannot leave" },
      }),
      expectedAlert: "删除 Topic 失败，因为 Homeserver 拒绝了请求：Cannot leave。",
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
    expect(screen.getByRole("button", { name: "保留验证话题" })).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("已有历史消息");
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("未确认排队消息");
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
  await waitFor(() => expect(syncCalls).toBeGreaterThanOrEqual(2));

  const timeline = screen.getByRole("log", { name: "对话时间线" });
  const getBodies = () => Array.from(timeline.querySelectorAll("[data-side] .waypoint-bubble")).map((el) => el.textContent);
  expect(getBodies()).toEqual([
    "第0条Bot消息",
    "第1条会失败的消息",
    "第2条正常消息",
    "后来Bot插进来的消息",
  ]);

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

  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第一条失败");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.type(screen.getByRole("textbox", { name: "输入消息" }), "第二条失败");
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
  let readMarkersPosted: Array<{ roomId: string; eventId: string }> = [];

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
  expect((screen.getByLabelText("绑定 Bot") as HTMLSelectElement).value).toBe("@bot2:example.com");
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
          if (syncCalls === 2) {
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

      if (deviceDisplayName === "Waypoint macOS") {
        // macOS 窗口失焦时收到 Agent 主动投递消息
        await act(async () => {
          window.dispatchEvent(new Event("blur"));
          clock.advance(1000);
        });
      } else {
        // Android 切后台再回到前台收到 Agent 主动投递消息
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
  const { createFetchTransport, detectPlatform } = await import("../adapters/production");
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

test("CSS Design Tokens 验证：包含素纸与夜读语义变量定义，无未声明硬编码色值 (#81)", async () => {
  // @ts-expect-error Node.js built-in fs in Vitest test runner
  const { readFileSync } = await import("node:fs");
  // @ts-expect-error Node.js built-in path in Vitest test runner
  const { resolve } = await import("node:path");
  const css = readFileSync(resolve((globalThis as unknown as { process: { cwd: () => string } }).process.cwd(), "src/App.css"), "utf-8");

  // 验证关键语义 Token 声明
  const requiredTokens = [
    "--bg",
    "--sidebar",
    "--header",
    "--ink",
    "--muted",
    "--line",
    "--accent",
    "--owner-bg",
    "--owner-ink",
    "--code-bg",
    "--danger",
    "--warn-bg",
  ];
  for (const token of requiredTokens) {
    expect(css).toContain(`${token}:`);
  }

  // 验证 prefers-color-scheme: dark 声明
  expect(css).toContain("@media (prefers-color-scheme: dark)");

  // 验证规则体内无硬编码十六进制色值（仅允许在变量定义区出现）
  const lines = css.split(String.fromCharCode(10));
  let insideTokens = false;
  const offendingLines: string[] = [];

  for (const line of lines) {
    if (line.includes(":root {") || line.includes("prefers-color-scheme: dark")) {
      insideTokens = true;
    }
    if (insideTokens && line.trim() === "}") {
      insideTokens = false;
    }
    if (!insideTokens && /#[0-9a-fA-F]{3,6}/.test(line)) {
      offendingLines.push(line.trim());
    }
  }
  expect(offendingLines).toEqual([]);
});
