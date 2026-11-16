import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { TransportResult } from "../../adapters/types";
import { WaypointApp } from "../WaypointApp";
import {
  setupIntegrationTestEnv,
  FakeHomeserver,
  ManualClock,
  deferred,
  login,
  passwordLoginHandler,
  renderApp,
  validAgents,
} from "./harness";

setupIntegrationTestEnv();

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
      platform={{ deviceDisplayName: "Waypoint Android", viewportMode: () => "narrow" } as import("../../adapters/types").PlatformAdapter}
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
      } as import("../../adapters/types").PlatformAdapter}
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
  const { detectPlatform } = await import("../../adapters/production");
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

  const platform: import("../../adapters/types").PlatformAdapter = {
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
  } as import("../../adapters/types").PlatformAdapter;

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
  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).toBeVisible();
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
      } as import("../../adapters/types").PlatformAdapter}
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
  const { detectPlatform } = await import("../../adapters/production");
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
  const { detectPlatform } = await import("../../adapters/production");
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
    expect(await screen.findByRole("alert")).toHaveTextContent("服务器暂时无法创建 Topic，请稍后重试。");
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

  const { detectPlatform } = await import("../../adapters/production");
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
  expect(screen.getByRole("combobox", { name: "绑定 Bot" })).toHaveTextContent("二号");
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

  const { detectPlatform } = await import("../../adapters/production");
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
  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).toBeVisible();

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

  const userIdInput = screen.getByLabelText("Bot 用户名");
  expect(userIdInput).not.toHaveAttribute("placeholder");
  const nameInput = screen.getByLabelText("手写名字（可选）");
  const submitButton = screen.getByRole("button", { name: "登记 Bot" });

  // 1. 空或纯空白用户名时按钮不可点击
  expect(submitButton).toBeDisabled();
  await user.type(userIdInput, "   ");
  expect(submitButton).toBeDisabled();
  await user.clear(userIdInput);
  expect(putAttempt).toBe(0);

  // 2. 残缺用户 ID（带 @ 但缺 :server）
  await user.type(userIdInput, "@bot2");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("有效的 Bot 用户名或完整 Matrix 用户 ID");
  expect(putAttempt).toBe(0);

  // 3. 跨 server name
  await user.clear(userIdInput);
  await user.type(userIdInput, "@bot2:other.org");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("同一台 Homeserver");
  expect(putAttempt).toBe(0);

  // 4. Owner 自身
  await user.clear(userIdInput);
  await user.type(userIdInput, "@alice:example.com");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("不能将自己登记为 Bot");
  expect(putAttempt).toBe(0);

  // 5. 名册内重复
  await user.clear(userIdInput);
  await user.type(userIdInput, "  @bot1:example.com  ");
  await user.click(submitButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("已在名册中");
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
  expect(await screen.findByRole("alert")).toHaveTextContent("无法连接到服务器，请检查网络或地址。");
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

  expect(await screen.findByRole("alert")).toHaveTextContent("服务器暂时无法响应，请稍后重试。");
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
  expect(await screen.findByRole("alert")).toHaveTextContent("移除 Bot 超时，请稍后重试。");
  expect(screen.getByRole("alertdialog", { name: "确认移除 Bot" })).toBeInTheDocument();
  const agentsSection = screen.getByRole("region", { name: "Bot 名册", hidden: true });
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
  expect(screen.getByRole("button", { name: /二号的话题/, hidden: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /三号的话题/, hidden: true })).toBeInTheDocument();

  // 关闭设置弹窗后，名册只剩一个 Bot，顶栏不放解析名，也不显示完整用户 ID
  await user.click(screen.getByRole("button", { name: "关闭" }));
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

  // 空用户名时快捷登记按钮不可点击
  expect(screen.getByRole("button", { name: "登记 Bot" })).toBeDisabled();

  // 重复校验（使用 localpart 也能识别重复）
  await user.type(screen.getByLabelText("Bot 用户名"), "bot1");
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已在名册中");
  expect(putAttempt).toBe(0);

  // 填写新 Bot（用 localpart 自动补全），第一次 PUT 失败保留输入并报错
  await user.clear(screen.getByLabelText("Bot 用户名"));
  await user.type(screen.getByLabelText("Bot 用户名"), "bot2");
  await user.type(screen.getByLabelText("手写名字（可选）"), "协作二号");
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("服务器暂时无法响应，请稍后重试。");
  expect(screen.getByLabelText("Bot 用户名")).toHaveValue("@bot2:example.com");
  expect(screen.getByLabelText("手写名字（可选）")).toHaveValue("协作二号");
  expect(screen.queryByLabelText("绑定 Bot")).not.toBeInTheDocument();

  // 重试登记成功：显示绑定 Bot 下拉框并自动选中刚登记的 @bot2:example.com
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));
  const select = await screen.findByRole("combobox", { name: "绑定 Bot" });
  expect(select).toHaveTextContent("协作二号");
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
  await user.type(screen.getByLabelText("Bot 用户名"), "@bot3:example.com");
  await user.click(screen.getByRole("button", { name: "登记 Bot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法连接到服务器，请检查网络或地址。");
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

  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).toHaveTextContent("旧名字");
  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).not.toHaveTextContent("新名字");
  expect(screen.getByRole("banner", { hidden: true })).toHaveTextContent("旧名字");
  expect(screen.getByRole("banner", { hidden: true })).toHaveTextContent("旧上下文");

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

  // 1. 清空名字或只填空白时保存按钮不可点击，且保留 Description 输入不发请求
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.clear(screen.getByLabelText("Topic 名字"));
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  await user.type(screen.getByLabelText("Topic 名字"), "   ");
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  await user.clear(screen.getByLabelText(/Description/));
  await user.type(screen.getByLabelText(/Description/), "保留的草稿说明");
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
  expect(alert).toHaveTextContent("服务器暂时无法响应，请稍后重试。");
  expect(alert).not.toHaveTextContent("Server busy");
  expect(alert).not.toHaveTextContent("M_UNKNOWN");
  expect(alert).not.toHaveTextContent("500");
  expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeVisible();
  expect(screen.getByLabelText("Topic 名字")).toHaveValue("失败保留名");
  expect(screen.getByLabelText(/Description/)).toHaveValue("失败保留说明");
  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).toHaveTextContent("原话题");
  expect(screen.getByRole("banner", { hidden: true })).toHaveTextContent("原说明");

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
  expect(alertA).toHaveTextContent("服务器暂时无法响应，请稍后重试。");
  expect(alertA).not.toHaveTextContent("Topic write failed");
  expect(screen.getByRole("region", { name: "编辑 Topic" })).toBeVisible();
  expect(screen.queryByLabelText("Topic 名字")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Description/)).toHaveValue("未成新说明");
  // 成功项立即在列表与顶栏生效
  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).toHaveTextContent("已成新名");
  expect(screen.getByRole("banner", { hidden: true })).toHaveTextContent("已成新名");
  expect(screen.getByRole("banner", { hidden: true })).toHaveTextContent("最初说明");

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
  expect(screen.getByRole("banner", { hidden: true }).querySelector(".waypoint-topic-description")).toBeNull();
  expect(screen.getByRole("complementary", { name: "Topic 列表", hidden: true })).toHaveTextContent("已成新名");
  expect(screen.getByRole("banner", { hidden: true })).toHaveTextContent("已成新名");

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

  const { detectPlatform } = await import("../../adapters/production");
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
  await user.click(screen.getByRole("combobox", { name: "绑定 Bot" }));
  await user.click(await screen.findByRole("option", { name: "二号矩阵显示名" }));
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
  expect(await screen.findByRole("alert")).toHaveTextContent("无法连接到服务器，请检查网络或地址。");

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
                        body: "纯文本正文 <div onclick=\"window.__waypointXss=true\">字面标签</div> <script>window.__waypointXss=true</script>",
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
    "纯文本正文 <div onclick=\"window.__waypointXss=true\">字面标签</div> <script>window.__waypointXss=true</script>",
  );
  expect(bubble?.querySelector("[onclick]")).toBeNull();
  expect(bubble?.querySelector(".waypoint-md-p > div")).toBeNull();
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
