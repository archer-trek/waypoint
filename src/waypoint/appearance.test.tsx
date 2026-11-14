import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Clock, HomeserverRequest, HomeserverTransport, PlatformAdapter, TransportResult } from "../adapters/types";
import { WaypointApp } from "./WaypointApp";

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

const validAgents = {
  events: [{ type: "im.waypoint.agents", content: { agents: [{ user_id: "@bot:example.com" }] } }],
};

function makeConnectedHomeserver() {
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
          account_data: validAgents,
        },
      };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`Unexpected request: ${input.method} ${input.url}`);
  };
  return homeserver;
}

function renderApp(
  homeserver = new FakeHomeserver(),
  extraPlatform?: Partial<PlatformAdapter>,
) {
  const clock = new ManualClock();
  const view = render(
    <WaypointApp
      homeserver={homeserver}
      platform={{ deviceDisplayName: "Waypoint macOS", ...extraPlatform }}
      clock={clock}
    />,
  );
  return { homeserver, clock, ...view };
}

async function loginToTopics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  await screen.findByText("暂无 Topic");
}

function installMatchMediaMock(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const mql = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
      if (event === "change" && typeof listener === "function") {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    removeEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
      if (event === "change" && typeof listener === "function") {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;

  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation(() => mql);

  return {
    setSystemDark(nextDark: boolean) {
      dark = nextDark;
      const event = { matches: nextDark, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
    restore() {
      window.matchMedia = originalMatchMedia;
    },
  };
}

describe("本地外观三档切换与首次连接迁移 (#86)", () => {
  let restoreMatchMedia: (() => void) | undefined;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
  });

  afterEach(() => {
    restoreMatchMedia?.();
    restoreMatchMedia = undefined;
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
  });

  test("默认跟随系统，在无 matchMedia 时安全回退浅色，并在系统切换深浅色时实时同步根元素与 theme-color", async () => {
    const firstView = renderApp(new FakeHomeserver());
    await screen.findByLabelText("Homeserver 地址");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");
    firstView.unmount();

    const mm = installMatchMediaMock(true);
    restoreMatchMedia = mm.restore;

    const secondView = renderApp(new FakeHomeserver());
    await screen.findByLabelText("Homeserver 地址");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#09090b");

    act(() => {
      mm.setSystemDark(false);
    });
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");

    act(() => {
      mm.setSystemDark(true);
    });
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#09090b");
    secondView.unmount();
  });

  test("在「设置 → 这台设备」切换外观三档实时生效、覆盖现有媒体 theme-color 标签、仅本地持久化且不发送 Matrix 请求", async () => {
    const user = userEvent.setup();
    const mm = installMatchMediaMock(false);
    restoreMatchMedia = mm.restore;

    const lightMeta = document.createElement("meta");
    lightMeta.setAttribute("name", "theme-color");
    lightMeta.setAttribute("content", "#ffffff");
    lightMeta.setAttribute("media", "(prefers-color-scheme: light)");
    const darkMeta = document.createElement("meta");
    darkMeta.setAttribute("name", "theme-color");
    darkMeta.setAttribute("content", "#09090b");
    darkMeta.setAttribute("media", "(prefers-color-scheme: dark)");
    document.head.append(lightMeta, darkMeta);

    const homeserver = makeConnectedHomeserver();
    const view = renderApp(homeserver);
    await loginToTopics(user);

    await user.click(await screen.findByRole("button", { name: "设置" }));
    const deviceSection = screen.getByRole("region", { name: "这台设备" });
    const group = within(deviceSection).getByRole("radiogroup", { name: "外观" });
    const systemOption = within(group).getByRole("radio", { name: "跟随系统" });
    const lightOption = within(group).getByRole("radio", { name: "浅色" });
    const darkOption = within(group).getByRole("radio", { name: "深色" });

    expect(systemOption).toHaveAttribute("aria-checked", "true");
    expect(lightOption).toHaveAttribute("aria-checked", "false");
    expect(darkOption).toHaveAttribute("aria-checked", "false");

    const requestsBefore = homeserver.requests.length;

    // 切换为深色
    await user.click(darkOption);
    expect(darkOption).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#09090b");
    expect(document.querySelector('meta[name="theme-color"]')).not.toHaveAttribute("media");
    expect(localStorage.getItem("waypoint.appearance")).toBe("dark");
    expect(homeserver.requests.slice(requestsBefore)).toEqual([]);

    // 锁定深色时系统切到浅色不受影响
    act(() => {
      mm.setSystemDark(false);
    });
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // 切换为浅色，即使系统为深色也保持浅色
    act(() => {
      mm.setSystemDark(true);
    });
    await user.click(lightOption);
    expect(lightOption).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");
    expect(localStorage.getItem("waypoint.appearance")).toBe("light");
    expect(homeserver.requests.slice(requestsBefore)).toEqual([]);

    // 重启应用后保留本机设置
    view.unmount();
    renderApp(homeserver);
    await screen.findByText("暂无 Topic");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");

    await user.click(await screen.findByRole("button", { name: "设置" }));
    const restoredGroup = within(screen.getByRole("region", { name: "这台设备" })).getByRole("radiogroup", { name: "外观" });
    expect(within(restoredGroup).getByRole("radio", { name: "浅色" })).toHaveAttribute("aria-checked", "true");

    // 切回跟随系统后立即对齐当前系统深色
    await user.click(within(restoredGroup).getByRole("radio", { name: "跟随系统" }));
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#09090b");
    expect(homeserver.requests.some((req) => req.url.includes("account_data"))).toBe(false);
  });

  test("退出这台设备时清除本机外观偏好并重置回跟随系统", async () => {
    const user = userEvent.setup();
    const mm = installMatchMediaMock(false);
    restoreMatchMedia = mm.restore;

    const homeserver = makeConnectedHomeserver();
    renderApp(homeserver);
    await loginToTopics(user);

    await user.click(await screen.findByRole("button", { name: "设置" }));
    const group = within(screen.getByRole("region", { name: "这台设备" })).getByRole("radiogroup", { name: "外观" });
    await user.click(within(group).getByRole("radio", { name: "深色" }));
    expect(localStorage.getItem("waypoint.appearance")).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");

    await user.click(screen.getByRole("button", { name: "退出这台设备" }));
    const confirmDialog = screen.getByRole("alertdialog", { name: "确认退出这台设备" });
    await user.click(within(confirmDialog).getByRole("button", { name: "确认退出" }));

    await waitFor(() => {
      expect(screen.getByLabelText("密码")).toBeInTheDocument();
    });
    expect(localStorage.getItem("waypoint.appearance")).toBeNull();
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");

    // 重置回跟随系统后，系统切深色会再次响应
    act(() => {
      mm.setSystemDark(true);
    });
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#09090b");
  });

  test("首次连接与登记流程保留所有无障碍与表单契约", async () => {
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
          body: { next_batch: "batch-1", account_data: { events: [] } },
        };
      }
      throw new Error(`Unexpected request: ${input.method} ${input.url}`);
    };

    renderApp(homeserver);
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");

    const addressInput = await screen.findByLabelText("Homeserver 地址");
    expect(addressInput).toHaveAttribute("name", "address");
    expect(screen.getByText("尚未进入 Topic 列表")).toHaveClass("sr-only");

    await user.type(addressInput, "invalid-url");
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.getByRole("alert")).toHaveTextContent("只接受完整的 https 地址");

    await user.clear(addressInput);
    await user.type(addressInput, "https://matrix.example.com");
    await user.click(screen.getByRole("button", { name: "继续" }));

    const userInput = await screen.findByLabelText("用户标识");
    const passwordInput = screen.getByLabelText("密码");
    expect(userInput).toHaveAttribute("name", "user-id");
    expect(passwordInput).toHaveAttribute("name", "password");
    expect(screen.getByRole("button", { name: "更改地址" })).toBeInTheDocument();

    await user.type(userInput, "alice");
    await user.type(passwordInput, "secret");
    await user.click(screen.getByRole("button", { name: "用密码登录" }));

    const agentInput = await screen.findByLabelText("Matrix 用户 ID");
    expect(agentInput).toHaveAttribute("name", "agent-user-id");
    expect(screen.getByRole("heading", { name: "登记 Bot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登记 Bot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃" })).toBeInTheDocument();
  });

  test("非法 localStorage 值安全回退跟随系统，支持键盘左右方向键切换外观，且组件源码不含硬编码 hex 色值", async () => {
    const user = userEvent.setup();
    localStorage.setItem("waypoint.appearance", "sepia");
    const homeserver = makeConnectedHomeserver();
    renderApp(homeserver);
    await loginToTopics(user);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await user.click(await screen.findByRole("button", { name: "设置" }));
    const group = within(screen.getByRole("region", { name: "这台设备" })).getByRole("radiogroup", { name: "外观" });
    const systemOption = within(group).getByRole("radio", { name: "跟随系统" });
    const lightOption = within(group).getByRole("radio", { name: "浅色" });
    const darkOption = within(group).getByRole("radio", { name: "深色" });
    expect(systemOption).toHaveAttribute("aria-checked", "true");

    systemOption.focus();
    await user.keyboard("{ArrowRight}");
    expect(lightOption).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowRight}");
    expect(darkOption).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveClass("dark");
    await user.keyboard("{ArrowLeft}");
    expect(lightOption).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).not.toHaveClass("dark");

    // @ts-expect-error Node.js built-in fs in Vitest test runner
    const { readFileSync } = await import("node:fs");
    // @ts-expect-error Node.js built-in path in Vitest test runner
    const { resolve } = await import("node:path");
    const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
    for (const relPath of ["src/waypoint/WaypointApp.tsx", "src/waypoint/workspace/SettingsView.tsx"]) {
      const source = readFileSync(resolve(cwd, relPath), "utf-8");
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    }
  });
});
