import { afterEach, describe, expect, test } from "vitest";
import { detectPlatform } from "./production";

type FakeViewport = {
  height: number;
  offsetTop: number;
  offsetLeft: number;
  emit(type: string): void;
};

function installFakeViewport(innerHeight: number): FakeViewport {
  const listeners = new Map<string, Set<EventListener>>();
  const vv: FakeViewport = {
    height: innerHeight,
    offsetTop: 0,
    offsetLeft: 0,
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    },
  };
  Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      get height() {
        return vv.height;
      },
      get offsetTop() {
        return vv.offsetTop;
      },
      get offsetLeft() {
        return vv.offsetLeft;
      },
      addEventListener(type: string, listener: EventListener) {
        if (!listeners.has(type)) {
          listeners.set(type, new Set());
        }
        listeners.get(type)?.add(listener);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
    },
  });
  return vv;
}

describe("keyboard inset after dismiss", () => {
  const originalInnerHeight = window.innerHeight;
  const originalVisualViewport = window.visualViewport;
  const originalDevicePixelRatio = window.devicePixelRatio;

  afterEach(() => {
    document.documentElement.style.removeProperty("--keyboard-inset");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: originalDevicePixelRatio,
    });
  });

  test("已恢复的 visual viewport 压过过期的原生 inset 与根节点 --keyboard-inset，快照和下一次通知都是 0", () => {
    const viewport = installFakeViewport(800);
    const platform = detectPlatform();
    const seen: number[] = [];
    const unsubscribe = platform.subscribeKeyboardInsetBottom?.((inset) => {
      seen.push(inset);
    });

    viewport.height = 488;
    viewport.emit("resize");
    expect(platform.keyboardInsetBottom?.()).toBe(312);

    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 312 } }));
    document.documentElement.style.setProperty("--keyboard-inset", "312px");
    expect(platform.keyboardInsetBottom?.()).toBe(312);

    viewport.height = 800;
    viewport.emit("resize");

    expect(platform.keyboardInsetBottom?.()).toBe(0);
    expect(seen.at(-1)).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("312px");

    unsubscribe?.();
  });

  test("重新读取或重新订阅时，过期键盘高度仍然是 0", () => {
    const viewport = installFakeViewport(800);
    const platform = detectPlatform();
    const stop = platform.subscribeKeyboardInsetBottom?.(() => undefined);

    viewport.height = 500;
    viewport.emit("resize");
    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 300 } }));
    document.documentElement.style.setProperty("--keyboard-inset", "300px");
    viewport.height = 800;
    viewport.emit("resize");
    stop?.();

    expect(platform.keyboardInsetBottom?.()).toBe(0);
    const seen: number[] = [];
    const stopAgain = platform.subscribeKeyboardInsetBottom?.((inset) => {
      seen.push(inset);
    });
    expect(platform.keyboardInsetBottom?.()).toBe(0);
    expect(seen).toEqual([]);
    stopAgain?.();
  });

  test("过期高度被清掉后，下一次真正打开仍贴住键盘，再收起又回到 0", () => {
    const viewport = installFakeViewport(800);
    const platform = detectPlatform();
    const stop = platform.subscribeKeyboardInsetBottom?.(() => undefined);

    viewport.height = 488;
    viewport.emit("resize");
    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 312 } }));
    document.documentElement.style.setProperty("--keyboard-inset", "312px");
    viewport.height = 800;
    viewport.emit("resize");
    expect(platform.keyboardInsetBottom?.()).toBe(0);

    viewport.height = 520;
    viewport.emit("resize");
    expect(platform.keyboardInsetBottom?.()).toBe(280);

    viewport.height = 800;
    viewport.emit("resize");
    expect(platform.keyboardInsetBottom?.()).toBe(0);

    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 264 } }));
    document.documentElement.style.setProperty("--keyboard-inset", "264px");
    expect(platform.keyboardInsetBottom?.()).toBe(264);

    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 0 } }));
    document.documentElement.style.removeProperty("--keyboard-inset");
    expect(platform.keyboardInsetBottom?.()).toBe(0);
    stop?.();
  });

  test("原生高度与 CSS 像素不一致时，打开期间贴住 visual viewport，收起后不残留", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
    const viewport = installFakeViewport(800);
    const platform = detectPlatform();
    const stop = platform.subscribeKeyboardInsetBottom?.(() => undefined);

    viewport.height = 500;
    viewport.emit("resize");
    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 900 } }));
    document.documentElement.style.setProperty("--keyboard-inset", "900px");

    expect(platform.keyboardInsetBottom?.()).toBe(300);

    viewport.height = 800;
    viewport.emit("resize");
    expect(platform.keyboardInsetBottom?.()).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("900px");
    stop?.();
  });

  test("visual viewport 从未报过键盘时，仍相信原生事件和根节点 CSS 回退", () => {
    installFakeViewport(800);
    const platform = detectPlatform();
    const stop = platform.subscribeKeyboardInsetBottom?.(() => undefined);

    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 324 } }));
    expect(platform.keyboardInsetBottom?.()).toBe(324);
    window.dispatchEvent(new CustomEvent("waypoint:keyboard-inset", { detail: { bottom: 0 } }));
    expect(platform.keyboardInsetBottom?.()).toBe(0);

    document.documentElement.style.setProperty("--keyboard-inset", "260px");
    window.dispatchEvent(new Event("resize"));
    expect(platform.keyboardInsetBottom?.()).toBe(260);
    document.documentElement.style.removeProperty("--keyboard-inset");
    window.dispatchEvent(new Event("resize"));
    expect(platform.keyboardInsetBottom?.()).toBe(0);
    stop?.();
  });
});
