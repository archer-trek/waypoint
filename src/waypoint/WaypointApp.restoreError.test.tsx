import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Clock, HomeserverTransport, PlatformAdapter } from "../adapters/types";
import { MatrixClient } from "./matrix-client";
import { saveSession } from "./session-store";
import { WaypointApp } from "./WaypointApp";

class ManualClock implements Clock {
  private nextId = 1;
  private timers = new Map<number, { fn: () => void; at: number }>();
  nowMs = 1_700_000_000_000;

  currentTimeMs(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.nowMs + Math.max(0, ms) });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }
}

function makePlatform(): PlatformAdapter {
  return {
    deviceDisplayName: "Waypoint Desktop",
    viewportMode: () => "wide",
    subscribeViewportMode: () => () => undefined,
  };
}

function makeTransport(): HomeserverTransport {
  return {
    request: async () => ({ type: "failure", failure: { type: "network" } }),
  };
}

describe("WaypointApp startup restore() error recovery UI", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("renders restore error screen and recovers when clicking 重试", async () => {
    const user = userEvent.setup();
    let failFirst = true;
    const restoreSpy = vi.spyOn(MatrixClient.prototype, "restore").mockImplementation(async function (
      this: MatrixClient,
    ) {
      if (failFirst) {
        failFirst = false;
        throw new DOMException("Storage read error", "UnknownError");
      }
      return "address";
    });

    const view = render(
      <WaypointApp homeserver={makeTransport()} platform={makePlatform()} clock={new ManualClock()} />,
    );

    expect(await screen.findByRole("heading", { name: "本地数据读取异常" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重置本地数据并重新连接" })).toBeInTheDocument();
    expect(restoreSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByLabelText("Homeserver 地址")).toBeInTheDocument();
    expect(restoreSpy).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test("reset confirmation dialog deletes database and returns to initial address flow", async () => {
    const user = userEvent.setup();
    await saveSession({
      baseUrl: "https://cached.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
    });

    vi.spyOn(MatrixClient.prototype, "restore").mockRejectedValue(
      new DOMException("Corrupt store", "DataError"),
    );
    const deleteSpy = vi.spyOn(globalThis.indexedDB, "deleteDatabase");

    const view = render(
      <WaypointApp homeserver={makeTransport()} platform={makePlatform()} clock={new ManualClock()} />,
    );

    expect(await screen.findByRole("heading", { name: "本地数据读取异常" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重置本地数据并重新连接" }));

    const dialog = await screen.findByRole("alertdialog", { name: "重置本地数据并重新连接" });
    expect(dialog).toHaveTextContent("重置将彻底清空这台设备上的本地时间线、草稿与重试队列");

    // Cancel keeps user on error screen
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "本地数据读取异常" })).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();

    // Confirm executes deleteDatabase("waypoint") and returns to initial address flow
    await user.click(screen.getByRole("button", { name: "重置本地数据并重新连接" }));
    const confirmDialog = await screen.findByRole("alertdialog", { name: "重置本地数据并重新连接" });
    await user.click(within(confirmDialog).getByRole("button", { name: "确认重置" }));

    expect(await screen.findByLabelText("Homeserver 地址")).toBeInTheDocument();
    expect(deleteSpy).toHaveBeenCalledWith("waypoint");
    view.unmount();
  });

  test("shows error in reset dialog if deleteDatabase times out after 5s", async () => {
    const user = userEvent.setup();
    vi.spyOn(MatrixClient.prototype, "restore").mockRejectedValue(
      new DOMException("Corrupt store", "DataError"),
    );
    vi.spyOn(globalThis.indexedDB, "deleteDatabase").mockImplementation(
      () => ({} as IDBOpenDBRequest),
    );

    const view = render(
      <WaypointApp homeserver={makeTransport()} platform={makePlatform()} clock={new ManualClock()} />,
    );

    expect(await screen.findByRole("heading", { name: "本地数据读取异常" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重置本地数据并重新连接" }));
    const dialog = await screen.findByRole("alertdialog", { name: "重置本地数据并重新连接" });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      within(dialog).getByRole("button", { name: "确认重置" }).click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(within(dialog).getByText("重置本地数据失败，请关闭其他占用窗口后重试。")).toBeInTheDocument();
    });
    view.unmount();
  });

  test("system back dismisses reset confirmation dialog on restore-error and yields to OS when closed (#139)", async () => {
    const user = userEvent.setup();
    vi.spyOn(MatrixClient.prototype, "restore").mockRejectedValue(
      new DOMException("Corrupt store", "DataError"),
    );

    let backHandler: (() => boolean) | undefined;
    const setSystemBackEnabled = vi.fn();
    const view = render(
      <WaypointApp
        homeserver={makeTransport()}
        platform={{
          ...makePlatform(),
          viewportMode: () => "narrow",
          onSystemBack: (handler) => {
            backHandler = handler;
            return () => {
              backHandler = undefined;
            };
          },
          setSystemBackEnabled,
        }}
        clock={new ManualClock()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "本地数据读取异常" })).toBeInTheDocument();
    expect(setSystemBackEnabled).toHaveBeenLastCalledWith(false);
    expect(backHandler?.()).toBe(false);

    await user.click(screen.getByRole("button", { name: "重置本地数据并重新连接" }));
    expect(await screen.findByRole("alertdialog", { name: "重置本地数据并重新连接" })).toBeInTheDocument();
    expect(setSystemBackEnabled).toHaveBeenLastCalledWith(true);

    act(() => {
      expect(backHandler?.()).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "重置本地数据并重新连接" })).not.toBeInTheDocument();
    });
    expect(setSystemBackEnabled).toHaveBeenLastCalledWith(false);
    expect(backHandler?.()).toBe(false);
    view.unmount();
  });
});
