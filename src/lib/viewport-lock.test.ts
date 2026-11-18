import { describe, expect, test, vi } from "vitest";
import {
  canScrollVerticallyInDirection,
  installTouchScrollBoundaryLock,
  installViewportScrollLock,
  isViewportKeyboardConstrained,
  resetRootViewportOffset,
} from "./viewport-lock";

function makeTouchEvent(
  type: string,
  touches: Array<{ clientX: number; clientY: number }>,
  cancelable = true,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable }) as TouchEvent;
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: touches,
  });
  return event;
}

describe("viewport-lock", () => {
  test("resetRootViewportOffset resets window/document scroll and aligns documentElement when visualViewport is panned", () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    const docEl = {
      scrollTop: 24,
      scrollLeft: 0,
      scrollIntoView,
    };
    const body = {
      scrollTop: 12,
      scrollLeft: 0,
    };
    const vv = {
      offsetTop: 220,
      offsetLeft: 0,
      height: 500,
    };
    const fakeWin = {
      scrollX: 0,
      scrollY: 24,
      scrollTo,
      visualViewport: vv,
    } as unknown as Window;
    const fakeDoc = {
      documentElement: docEl,
      body,
    } as unknown as Document;

    const changed = resetRootViewportOffset(fakeWin, fakeDoc);
    expect(changed).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(docEl.scrollTop).toBe(0);
    expect(body.scrollTop).toBe(0);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "start" });

    // Even when window.scrollY is already 0, visualViewport.offsetTop > 0 triggers scrollIntoView
    scrollTo.mockClear();
    scrollIntoView.mockClear();
    (fakeWin as { scrollY: number }).scrollY = 0;
    vv.offsetTop = 180;
    expect(resetRootViewportOffset(fakeWin, fakeDoc)).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "start" });

    // When all offsets are 0, resetRootViewportOffset is a no-op
    scrollIntoView.mockClear();
    vv.offsetTop = 0;
    expect(resetRootViewportOffset(fakeWin, fakeDoc)).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  test("installViewportScrollLock snaps visualViewport and window scroll offsets back to 0 and cleans up", () => {
    const vvListeners = new Map<string, Set<EventListener>>();
    const winListeners = new Map<string, Set<EventListener>>();
    const scrollIntoView = vi.fn();
    const vv = {
      offsetTop: 0,
      offsetLeft: 0,
      height: 500,
      addEventListener: (type: string, fn: EventListener) => {
        if (!vvListeners.has(type)) vvListeners.set(type, new Set());
        vvListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        vvListeners.get(type)?.delete(fn);
      },
    };
    const rafQueue: FrameRequestCallback[] = [];
    const fakeWin = {
      scrollX: 0,
      scrollY: 0,
      scrollTo: vi.fn(),
      visualViewport: vv,
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      },
      cancelAnimationFrame: vi.fn(),
      addEventListener: (type: string, fn: EventListener) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        winListeners.get(type)?.delete(fn);
      },
    } as unknown as Window;
    const fakeDoc = {
      documentElement: {
        scrollTop: 0,
        scrollLeft: 0,
        scrollIntoView: () => {
          vv.offsetTop = 0;
          scrollIntoView();
        },
      },
      body: { scrollTop: 0, scrollLeft: 0 },
    } as unknown as Document;

    const uninstall = installViewportScrollLock(fakeWin, fakeDoc);
    expect(scrollIntoView).not.toHaveBeenCalled();

    vv.offsetTop = 260;
    for (const fn of vvListeners.get("scroll") ?? []) {
      fn(new Event("scroll"));
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(vv.offsetTop).toBe(0);

    // Follow-up RAF also guards against deferred scroll
    vv.offsetTop = 40;
    while (rafQueue.length > 0) {
      rafQueue.shift()!(16);
    }
    expect(vv.offsetTop).toBe(0);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    uninstall();
    expect(vvListeners.get("scroll")?.size ?? 0).toBe(0);
    expect(winListeners.get("scroll")?.size ?? 0).toBe(0);
  });

  test("isViewportKeyboardConstrained checks both safeInset and visualViewport shrink", () => {
    const fakeWin = {
      innerHeight: 800,
      visualViewport: { height: 800 },
    } as unknown as Window;
    expect(isViewportKeyboardConstrained(0, fakeWin)).toBe(false);
    expect(isViewportKeyboardConstrained(300, fakeWin)).toBe(true);

    (fakeWin.visualViewport as { height: number }).height = 500;
    expect(isViewportKeyboardConstrained(0, fakeWin)).toBe(true);
  });

  test("canScrollVerticallyInDirection checks scrollable bounds and skips non-overflowing nodes", () => {
    const scroller = document.createElement("div");
    scroller.className = "overflow-y-auto";
    const child = document.createElement("p");
    scroller.appendChild(child);

    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    scroller.scrollTop = 0;

    // At top: cannot scroll up (finger drags down dy > 0), can scroll down (finger drags up dy < 0)
    expect(canScrollVerticallyInDirection(child, scroller, 20)).toBe(false);
    expect(canScrollVerticallyInDirection(child, scroller, -20)).toBe(true);

    // Middle: can scroll both ways
    scroller.scrollTop = 100;
    expect(canScrollVerticallyInDirection(child, scroller, 20)).toBe(true);
    expect(canScrollVerticallyInDirection(child, scroller, -20)).toBe(true);

    // Bottom: can scroll up (dy > 0), cannot scroll down (dy < 0)
    scroller.scrollTop = 500;
    expect(canScrollVerticallyInDirection(child, scroller, 20)).toBe(true);
    expect(canScrollVerticallyInDirection(child, scroller, -20)).toBe(false);

    // Non-overflowing container cannot scroll in either direction
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 200 });
    scroller.scrollTop = 0;
    expect(canScrollVerticallyInDirection(child, scroller, 20)).toBe(false);
    expect(canScrollVerticallyInDirection(child, scroller, -20)).toBe(false);
  });

  test("installTouchScrollBoundaryLock blocks boundary/non-scrollable vertical drag while allowing scrollable inner drag and horizontal code-block scroll", () => {
    const container = document.createElement("div");
    const textarea = document.createElement("textarea");
    container.appendChild(textarea);
    document.body.appendChild(container);

    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    container.scrollTop = 600; // at bottom

    let locked = true;
    const uninstall = installTouchScrollBoundaryLock(container, {
      isLocked: () => locked,
      onlyVertical: true,
      shouldIgnoreHorizontalEdge: (startX, dx, dy) =>
        startX <= 24 && Math.abs(dx) > Math.abs(dy),
      allowVerticalScroll: (target, dy) =>
        canScrollVerticallyInDirection(target, container, dy),
    });

    // 1. At bottom, dragging finger UP (dy < 0, trying to scroll past bottom) -> prevented
    container.dispatchEvent(makeTouchEvent("touchstart", [{ clientX: 150, clientY: 300 }]));
    const pastBottomMove = makeTouchEvent("touchmove", [{ clientX: 150, clientY: 280 }]);
    container.dispatchEvent(pastBottomMove);
    expect(pastBottomMove.defaultPrevented).toBe(true);
    container.dispatchEvent(makeTouchEvent("touchend", []));

    // 2. At bottom, dragging finger DOWN (dy > 0, scrolling up into history) -> allowed
    container.dispatchEvent(makeTouchEvent("touchstart", [{ clientX: 150, clientY: 300 }]));
    const scrollUpMove = makeTouchEvent("touchmove", [{ clientX: 150, clientY: 320 }]);
    container.dispatchEvent(scrollUpMove);
    expect(scrollUpMove.defaultPrevented).toBe(false);
    container.dispatchEvent(makeTouchEvent("touchend", []));

    // 3. Horizontal swipe (e.g. code block) -> allowed when onlyVertical=true
    container.dispatchEvent(makeTouchEvent("touchstart", [{ clientX: 150, clientY: 300 }]));
    const horizMove = makeTouchEvent("touchmove", [{ clientX: 110, clientY: 302 }]);
    container.dispatchEvent(horizMove);
    expect(horizMove.defaultPrevented).toBe(false);
    container.dispatchEvent(makeTouchEvent("touchend", []));

    // 4. Tiny movement within touch slop (<= 4px) -> never prevented (preserves tap/long-press)
    container.dispatchEvent(makeTouchEvent("touchstart", [{ clientX: 150, clientY: 300 }]));
    const microMove = makeTouchEvent("touchmove", [{ clientX: 150, clientY: 298 }]);
    container.dispatchEvent(microMove);
    expect(microMove.defaultPrevented).toBe(false);
    container.dispatchEvent(makeTouchEvent("touchend", []));

    // 5. When unlocked, boundary drag is not prevented
    locked = false;
    container.dispatchEvent(makeTouchEvent("touchstart", [{ clientX: 150, clientY: 300 }]));
    const unlockedMove = makeTouchEvent("touchmove", [{ clientX: 150, clientY: 280 }]);
    container.dispatchEvent(unlockedMove);
    expect(unlockedMove.defaultPrevented).toBe(false);
    container.dispatchEvent(makeTouchEvent("touchend", []));

    uninstall();
    container.remove();
  });
});
