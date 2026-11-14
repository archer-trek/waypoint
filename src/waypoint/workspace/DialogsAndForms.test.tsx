import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test } from "vitest";
import type {
  Clock,
  HomeserverRequest,
  HomeserverTransport,
  PlatformAdapter,
  TransportResult,
  ViewportMode,
} from "../../adapters/types";
import { WaypointApp } from "../WaypointApp";

class ManualClock implements Clock {
  private nextId = 1;
  private timers = new Map<number, { at: number; handler: () => void }>();
  now = 1_700_000_000_000;

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
    throw new Error("Unexpected Homeserver request");
  };

  request(input: HomeserverRequest): Promise<TransportResult> {
    this.requests.push({ ...input, headers: input.headers ?? {} });
    return this.handler(input);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeWorkspacePlatform(initialMode: ViewportMode = "wide") {
  let mode: ViewportMode = initialMode;
  const listeners = new Set<(next: ViewportMode) => void>();
  const platform: PlatformAdapter = {
    deviceDisplayName: initialMode === "narrow" ? "Waypoint Android" : "Waypoint macOS",
    viewportMode: () => mode,
    subscribeViewportMode: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    platform,
    setViewportMode(next: ViewportMode) {
      mode = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

function createConnectedHomeserver({
  agents = [
    { user_id: "@bot1:example.com", name: "一号助理" },
    { user_id: "@bot2:example.com", name: "二号助理" },
  ],
  onPutAgents,
  onPutRoomState,
  onCreateRoom,
  onLeaveRoom,
}: {
  agents?: Array<{ user_id: string; name?: string }>;
  onPutAgents?: (body: unknown) => Promise<TransportResult>;
  onPutRoomState?: (url: string, body: unknown) => Promise<TransportResult>;
  onCreateRoom?: (body: unknown) => Promise<TransportResult>;
  onLeaveRoom?: () => Promise<TransportResult>;
} = {}) {
  let storedAgents = agents;
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
      if (input.url.includes("since=")) {
        return { type: "response", status: 200, body: { next_batch: "batch-2" } };
      }
      return {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-1",
          account_data: {
            events: [{ type: "im.waypoint.agents", content: { agents: storedAgents } }],
          },
          rooms: {
            join: {
              "!t1:example.com": {
                state: {
                  events: [
                    { type: "m.room.create", state_key: "", origin_server_ts: 1000, content: {} },
                    {
                      type: "im.waypoint.topic",
                      state_key: "",
                      content: { v: 1, agent_user_id: "@bot1:example.com" },
                    },
                    { type: "m.room.name", state_key: "", content: { name: "已有话题" } },
                    { type: "m.room.topic", state_key: "", content: { topic: "已有说明" } },
                  ],
                },
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$msg-1",
                      sender: "@bot1:example.com",
                      origin_server_ts: 2000,
                      content: { msgtype: "m.text", body: "底层对话内容" },
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
      if (onPutAgents) {
        const res = await onPutAgents(input.body);
        if (res.type === "response" && res.status === 200) {
          const parsed = input.body as { agents?: Array<{ user_id: string; name?: string }> };
          if (parsed?.agents) {
            storedAgents = parsed.agents;
          }
        }
        return res;
      }
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "PUT" && input.url.includes("/state/m.room.")) {
      if (onPutRoomState) {
        return onPutRoomState(input.url, input.body);
      }
      return { type: "response", status: 200, body: { event_id: "$state-ok" } };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/createRoom")) {
      if (onCreateRoom) {
        return onCreateRoom(input.body);
      }
      return { type: "response", status: 200, body: { room_id: "!new-room:example.com" } };
    }
    if (input.method === "GET" && input.url.includes("/state/m.room.encryption")) {
      return { type: "response", status: 404, body: { errcode: "M_NOT_FOUND" } };
    }
    if (input.method === "PUT" && input.url.includes("/account_data/m.direct")) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.includes("/leave")) {
      if (onLeaveRoom) {
        return onLeaveRoom();
      }
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.includes("/forget")) {
      return { type: "response", status: 200, body: {} };
    }
    if (input.method === "POST" && input.url.endsWith("/_matrix/client/v3/logout")) {
      return { type: "response", status: 200, body: {} };
    }
    throw new Error(`Unexpected request: ${input.method} ${input.url}`);
  };
  return homeserver;
}

async function loginToWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Homeserver 地址"), "https://matrix.example.com");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText("用户标识"), "alice");
  await user.type(screen.getByLabelText("密码"), "secret");
  await user.click(screen.getByRole("button", { name: "用密码登录" }));
  await screen.findByRole("button", { name: /已有话题/ });
}

describe("Responsive Dialogs, Forms, and AlertDialogs (#87)", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  test("wide CreateTopic renders shadcn Dialog with Select and inline quick Bot registration", async () => {
    const user = userEvent.setup();
    const createDeferred = deferred<TransportResult>();
    let createdPayload: unknown;
    const homeserver = createConnectedHomeserver({
      onCreateRoom: async (body) => {
        createdPayload = body;
        return createDeferred.promise;
      },
    });
    const { platform } = makeWorkspacePlatform("wide");

    render(<WaypointApp homeserver={homeserver} platform={platform} clock={new ManualClock()} />);
    await loginToWorkspace(user);

    await user.click(screen.getByRole("button", { name: "新建 Topic" }));

    const dialog = screen.getByRole("region", { name: "新建 Topic" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    expect(document.querySelector(".waypoint-modal-backdrop")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();

    // Select bot using shadcn/ui Select combobox inside Dialog
    const botCombobox = within(dialog).getByRole("combobox", { name: "绑定 Bot" });
    expect(botCombobox).toHaveTextContent("一号助理");
    await user.click(botCombobox);
    const optionTwo = await screen.findByRole("option", { name: "二号助理" });
    await user.click(optionTwo);
    expect(botCombobox).toHaveTextContent("二号助理");

    // Open inline quick registration and press Escape to close only quick register
    await user.click(within(dialog).getByRole("button", { name: "登记新 Bot" }));
    expect(within(dialog).getByRole("region", { name: "登记新 Bot" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("region", { name: "登记新 Bot" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();

    // Submit and verify Escape/backdrop click are blocked while submitting
    await user.type(within(dialog).getByLabelText("Topic 名字"), "新模态话题");
    await user.click(within(dialog).getByRole("button", { name: "创建 Topic" }));
    expect(within(dialog).getByRole("button", { name: "正在创建…" })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector(".waypoint-modal-backdrop")!);
    expect(screen.getByRole("region", { name: "新建 Topic" })).toBeVisible();

    await act(async () => {
      createDeferred.resolve({ type: "response", status: 200, body: { room_id: "!created:example.com" } });
    });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "新建 Topic" })).not.toBeInTheDocument();
    });
    expect(createdPayload).toMatchObject({
      name: "新模态话题",
      invite: ["@bot2:example.com"],
    });
  });

  test("wide EditTopic upgrades to centered Dialog over mounted conversation, while narrow EditTopic uses pushed page", async () => {
    const user = userEvent.setup();
    const editDeferred = deferred<TransportResult>();
    const homeserver = createConnectedHomeserver({
      onPutRoomState: async () => editDeferred.promise,
    });
    const { platform, setViewportMode } = makeWorkspacePlatform("wide");

    render(<WaypointApp homeserver={homeserver} platform={platform} clock={new ManualClock()} />);
    await loginToWorkspace(user);

    await user.click(screen.getByRole("button", { name: /已有话题/ }));
    expect(screen.getByRole("log", { name: "对话时间线" })).toHaveTextContent("底层对话内容");

    // Wide viewport: EditTopic opens as modal Dialog with timeline still mounted underneath
    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));

    const editDialog = screen.getByRole("region", { name: "编辑 Topic" });
    expect(editDialog).toHaveAttribute("aria-modal", "true");
    expect(editDialog).toHaveAttribute("data-slot", "dialog-content");
    expect(document.querySelector(".waypoint-modal-backdrop")).not.toBeNull();
    expect(screen.getByRole("log", { name: "对话时间线", hidden: true })).toHaveTextContent("底层对话内容");

    // Backdrop click closes wide EditTopic when not submitting
    fireEvent.click(document.querySelector(".waypoint-modal-backdrop")!);
    expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();

    // Switch to narrow viewport: EditTopic renders as full-screen pushed page with single 返回 button
    act(() => {
      setViewportMode("narrow");
    });
    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));

    const narrowEdit = screen.getByRole("region", { name: "编辑 Topic" });
    expect(narrowEdit).not.toHaveAttribute("aria-modal", "true");
    expect(document.querySelector(".waypoint-modal-backdrop")).toBeNull();
    const backButtons = screen.getAllByRole("button", { name: "返回" });
    expect(backButtons).toHaveLength(1);

    // Submitting disables back button
    await user.clear(within(narrowEdit).getByLabelText("Topic 名字"));
    await user.type(within(narrowEdit).getByLabelText("Topic 名字"), "窄屏更新名");
    await user.click(within(narrowEdit).getByRole("button", { name: "保存" }));
    expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();

    await act(async () => {
      editDeferred.resolve({ type: "response", status: 200, body: { event_id: "$ok" } });
    });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "编辑 Topic" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("banner")).toHaveTextContent("窄屏更新名");
  });

  test("wide Settings preserves appearance control and guards parent Dialog when nested AlertDialogs open", async () => {
    const user = userEvent.setup();
    const homeserver = createConnectedHomeserver();
    const { platform } = makeWorkspacePlatform("wide");

    render(<WaypointApp homeserver={homeserver} platform={platform} clock={new ManualClock()} />);
    await loginToWorkspace(user);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const settingsDialog = screen.getByRole("region", { name: "设置" });
    expect(settingsDialog).toHaveAttribute("aria-modal", "true");
    expect(settingsDialog).toHaveAttribute("data-slot", "dialog-content");

    // Preserve #86 appearance segmented control inside "这台设备"
    const deviceSection = within(settingsDialog).getByRole("region", { name: "这台设备" });
    const appearanceGroup = within(deviceSection).getByRole("radiogroup", { name: "外观" });
    expect(within(appearanceGroup).getByRole("radio", { name: "跟随系统" })).toBeInTheDocument();
    expect(within(appearanceGroup).getByRole("radio", { name: "浅色" })).toBeInTheDocument();
    expect(within(appearanceGroup).getByRole("radio", { name: "深色" })).toBeInTheDocument();

    // Open nested "确认移除 Bot" AlertDialog
    const removeButtons = within(settingsDialog).getAllByRole("button", { name: "移除" });
    await user.click(removeButtons[1]!);

    const removeAlert = screen.getByRole("alertdialog", { name: "确认移除 Bot" });
    expect(removeAlert).toHaveAttribute("data-slot", "alert-dialog-content");
    const confirmRemoveBtn = within(removeAlert).getByRole("button", { name: "确认移除" });
    expect(confirmRemoveBtn).toHaveClass("bg-destructive");

    // Escape closes ONLY the AlertDialog and keeps Settings Dialog open
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "确认移除 Bot" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "设置" })).toBeVisible();

    // Open nested "确认退出这台设备" AlertDialog and cancel via button
    await user.click(within(settingsDialog).getByRole("button", { name: "退出这台设备" }));
    const exitAlert = screen.getByRole("alertdialog", { name: "确认退出这台设备" });
    expect(exitAlert).toHaveAttribute("data-slot", "alert-dialog-content");
    expect(within(exitAlert).getByRole("button", { name: "确认退出" })).toHaveClass("bg-destructive");

    await user.click(within(exitAlert).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog", { name: "确认退出这台设备" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "设置" })).toBeVisible();
  });

  test("narrow viewport renders DeleteTopic, RemoveBot, and ExitConfirm as centered modal AlertDialogs", async () => {
    const user = userEvent.setup();
    const homeserver = createConnectedHomeserver();
    const { platform } = makeWorkspacePlatform("narrow");

    render(<WaypointApp homeserver={homeserver} platform={platform} clock={new ManualClock()} />);
    await loginToWorkspace(user);

    // Narrow DeleteTopic uses centered AlertDialog overlay
    await user.click(screen.getByRole("button", { name: /已有话题/ }));
    await user.click(screen.getByRole("button", { name: "话题操作" }));
    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    const deleteAlert = screen.getByRole("alertdialog", { name: "确认删除 Topic" });
    expect(deleteAlert).toHaveAttribute("data-slot", "alert-dialog-content");
    expect(document.querySelector('[data-slot="alert-dialog-overlay"]')).not.toBeNull();
    expect(within(deleteAlert).getByRole("button", { name: "确认删除" })).toHaveClass("bg-destructive");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "确认删除 Topic" })).not.toBeInTheDocument();

    // Back to list -> Narrow Settings pushed page -> AlertDialog confirmations
    await user.click(screen.getByRole("button", { name: "返回" }));
    await user.click(await screen.findByRole("button", { name: "设置" }));

    const settingsPage = screen.getByRole("region", { name: "设置" });
    expect(settingsPage).not.toHaveAttribute("aria-modal", "true");
    expect(within(settingsPage).getByRole("button", { name: "返回" })).toBeVisible();

    await user.click(within(settingsPage).getAllByRole("button", { name: "移除" })[0]!);
    expect(screen.getByRole("alertdialog", { name: "确认移除 Bot" })).toHaveAttribute(
      "data-slot",
      "alert-dialog-content",
    );
    await user.click(screen.getByRole("button", { name: "取消" }));

    await user.click(within(settingsPage).getByRole("button", { name: "退出这台设备" }));
    expect(screen.getByRole("alertdialog", { name: "确认退出这台设备" })).toHaveAttribute(
      "data-slot",
      "alert-dialog-content",
    );
  });

  test("owned workspace dialog and form files contain zero raw hex color literals", async () => {
    // @ts-expect-error Node.js built-in fs in Vitest test runner
    const { readFileSync } = await import("node:fs");
    // @ts-expect-error Node.js built-in path in Vitest test runner
    const { resolve } = await import("node:path");
    const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
    const files = [
      "src/waypoint/workspace/CreateTopicView.tsx",
      "src/waypoint/workspace/EditTopicView.tsx",
      "src/waypoint/workspace/SettingsView.tsx",
      "src/waypoint/workspace/ReauthBanner.tsx",
      "src/waypoint/workspace/DeleteTopicDialog.tsx",
      "src/waypoint/workspace/ResponsiveFormShell.tsx",
    ];
    for (const relPath of files) {
      const source = readFileSync(resolve(cwd, relPath), "utf-8");
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    }
  });
});
