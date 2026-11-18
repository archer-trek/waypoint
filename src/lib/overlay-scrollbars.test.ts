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

describe("App.css table and scrollbar corner guards", () => {
  test("prevents table vertical scrollbar gutter, keeps idle table/code scrollbars zero-sized, and styles transparent scrollbar corners", async () => {
    // @ts-expect-error Node.js built-in fs in Vitest test runner
    const { readFileSync } = await import("node:fs");
    // @ts-expect-error Node.js built-in path in Vitest test runner
    const { resolve } = await import("node:path");
    const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
    const css = readFileSync(resolve(cwd, "src/App.css"), "utf-8") as string;

    expect(css).toContain("::-webkit-scrollbar-corner");
    expect(css).toMatch(/::-webkit-scrollbar-corner\s*\{\s*background:\s*transparent;/);

    const tableOverflowRule =
      css.match(/\.waypoint-markdown \[data-streamdown="table-wrapper"\] > div:last-child \{[^}]+\}/)?.[0] ?? "";
    expect(tableOverflowRule).toContain("overflow-x: auto;");
    expect(tableOverflowRule).toContain("overflow-y: hidden;");

    const tableIdleScrollbar =
      css.match(/\.waypoint-markdown \[data-streamdown="table-wrapper"\] > div:last-child::-webkit-scrollbar \{[^}]+\}/)?.[0] ?? "";
    expect(tableIdleScrollbar).toContain("height: 0;");
    expect(tableIdleScrollbar).toContain("width: 0;");
  });
});
