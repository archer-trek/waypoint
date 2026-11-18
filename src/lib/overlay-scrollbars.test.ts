import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installOverlayScrollbars } from "./overlay-scrollbars";

describe("installOverlayScrollbars", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  test("ignores programmatic scroll without prior interaction (e.g. tap-to-open Topic)", () => {
    const cleanup = installOverlayScrollbars(window, document);
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);

      // Tap (touchstart + touchend without touchmove) must not mark interaction
      window.dispatchEvent(new Event("touchstart"));
      window.dispatchEvent(new Event("touchend"));
      container.dispatchEvent(new Event("scroll"));

      expect(container.getAttribute("data-scrolling")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("keeps scrollbar active throughout mobile momentum scroll past 250ms after last touchmove, then fades cleanly", () => {
    const cleanup = installOverlayScrollbars(window, document);
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);

      // User drags and releases into momentum scroll
      window.dispatchEvent(new Event("touchmove"));
      container.dispatchEvent(new Event("scroll"));
      expect(container.getAttribute("data-scrolling")).toBe("active");

      // Advance 400ms (past old 250ms cutoff) while momentum scroll events keep firing
      vi.advanceTimersByTime(400);
      container.dispatchEvent(new Event("scroll"));
      expect(container.getAttribute("data-scrolling")).toBe("active");

      // Another 400ms of momentum scrolling
      vi.advanceTimersByTime(400);
      container.dispatchEvent(new Event("scroll"));
      expect(container.getAttribute("data-scrolling")).toBe("active");

      // Momentum stops: after 500ms transitions to fade, then clears after 450ms
      vi.advanceTimersByTime(500);
      expect(container.getAttribute("data-scrolling")).toBe("fade");

      vi.advanceTimersByTime(450);
      expect(container.getAttribute("data-scrolling")).toBeNull();
    } finally {
      cleanup();
    }
  });
});
