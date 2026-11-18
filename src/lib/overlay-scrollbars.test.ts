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

  test("renders zero-layout-shift floating overlay thumb for markdown code-block-body on horizontal and vertical scroll", () => {
    const cleanup = installOverlayScrollbars(window, document);
    try {
      const md = document.createElement("div");
      md.className = "waypoint-markdown";
      const codeBody = document.createElement("div");
      codeBody.setAttribute("data-streamdown", "code-block-body");
      Object.defineProperty(codeBody, "clientWidth", { configurable: true, value: 200 });
      Object.defineProperty(codeBody, "scrollWidth", { configurable: true, value: 500 });
      Object.defineProperty(codeBody, "clientHeight", { configurable: true, value: 200 });
      Object.defineProperty(codeBody, "scrollHeight", { configurable: true, value: 600 });
      codeBody.getBoundingClientRect = () => ({
        left: 16,
        top: 100,
        right: 216,
        bottom: 300,
        width: 200,
        height: 200,
        x: 16,
        y: 100,
        toJSON: () => ({}),
      });
      md.appendChild(codeBody);
      document.body.appendChild(md);

      // Horizontal scroll
      codeBody.scrollLeft = 80;
      window.dispatchEvent(new Event("wheel"));
      codeBody.dispatchEvent(new Event("scroll"));

      const thumbX = document.querySelector('[data-overlay-scrollbar="x"]') as HTMLElement | null;
      expect(thumbX).not.toBeNull();
      expect(thumbX?.getAttribute("data-state")).toBe("active");

      // Vertical scroll
      codeBody.scrollTop = 120;
      codeBody.dispatchEvent(new Event("scroll"));
      const thumbY = document.querySelector('[data-overlay-scrollbar="y"]') as HTMLElement | null;
      expect(thumbY).not.toBeNull();
      expect(thumbY?.getAttribute("data-state")).toBe("active");

      vi.advanceTimersByTime(500);
      expect(thumbX?.getAttribute("data-state")).toBe("fade");
      expect(thumbY?.getAttribute("data-state")).toBe("fade");

      vi.advanceTimersByTime(450);
      expect(document.querySelector('[data-overlay-scrollbar="x"]')).toBeNull();
      expect(document.querySelector('[data-overlay-scrollbar="y"]')).toBeNull();
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

    expect(css).not.toContain('[data-streamdown="code-block-body"][data-scrolling="active"]::-webkit-scrollbar');
    expect(css).not.toContain('[data-streamdown="table-wrapper"] > div:last-child[data-scrolling="active"]::-webkit-scrollbar');

    const codeBodyOverflowRule =
      css.match(/\.waypoint-markdown \[data-streamdown="code-block-body"\] \{[^}]+\}/)?.[0] ?? "";
    expect(codeBodyOverflowRule).toContain("scrollbar-width: none;");

    const tableIdleScrollbar =
      css.match(/\.waypoint-markdown \[data-streamdown="table-wrapper"\] > div:last-child::-webkit-scrollbar \{[^}]+\}/)?.[0] ?? "";
    expect(tableIdleScrollbar).toContain("height: 0;");
    expect(tableIdleScrollbar).toContain("width: 0;");
  });
});
