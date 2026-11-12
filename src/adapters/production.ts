import { invoke, isTauri } from "@tauri-apps/api/core";
import { normalizeInset } from "./inset";
import type { Clock, HomeserverTransport, PlatformAdapter, ViewportMode } from "./types";

const WIDE_VIEWPORT_MEDIA_QUERY = "(min-width: 48em)";
const KEYBOARD_INSET_EVENT = "waypoint:keyboard-inset";

type VirtualKeyboardLike = EventTarget & {
  boundingRect?: { height?: number };
};

export const systemClock: Clock = {
  setTimeout: (handler, timeoutMs) => window.setTimeout(handler, timeoutMs),
  clearTimeout: (id) => window.clearTimeout(id),
  currentTimeMs: () => Date.now(),
};

function currentAppVisible(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState !== "hidden";
}

function subscribeAppVisibility(onChange: (visible: boolean) => void): () => void {
  if (typeof document === "undefined" && typeof window === "undefined") {
    return () => undefined;
  }
  let lastVisible = currentAppVisible();
  const notify = (nextVisible: boolean) => {
    if (nextVisible !== lastVisible) {
      lastVisible = nextVisible;
      onChange(nextVisible);
    }
  };
  const handleVisibilityChange = () => {
    notify(currentAppVisible());
  };
  const handlePageHide = () => {
    notify(false);
  };
  const handlePageShow = () => {
    notify(currentAppVisible());
  };
  document?.addEventListener("visibilitychange", handleVisibilityChange);
  window?.addEventListener("pagehide", handlePageHide);
  window?.addEventListener("pageshow", handlePageShow);
  return () => {
    document?.removeEventListener("visibilitychange", handleVisibilityChange);
    window?.removeEventListener("pagehide", handlePageHide);
    window?.removeEventListener("pageshow", handlePageShow);
  };
}

function subscribeNetworkResume(onResume: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const handleOnline = () => {
    onResume();
  };
  window.addEventListener("online", handleOnline);
  return () => {
    window.removeEventListener("online", handleOnline);
  };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function currentViewportMode(): ViewportMode {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia(WIDE_VIEWPORT_MEDIA_QUERY).matches ? "wide" : "narrow";
  }
  return /Android/i.test(navigator.userAgent) ? "narrow" : "wide";
}

function subscribeViewportMode(onChange: (mode: ViewportMode) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const mediaQuery = window.matchMedia(WIDE_VIEWPORT_MEDIA_QUERY);
  const handleChange = () => {
    onChange(mediaQuery.matches ? "wide" : "narrow");
  };
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }
  mediaQuery.addListener(handleChange);
  return () => mediaQuery.removeListener(handleChange);
}

function getVirtualKeyboard(): VirtualKeyboardLike | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
}

function readRootCssKeyboardInset(): number {
  if (typeof document === "undefined" || !document.documentElement) {
    return 0;
  }
  const inlineValue = document.documentElement.style?.getPropertyValue("--keyboard-inset") ?? "";
  const raw =
    inlineValue.trim() !== ""
      ? inlineValue
      : typeof window !== "undefined" && typeof window.getComputedStyle === "function"
        ? window.getComputedStyle(document.documentElement).getPropertyValue("--keyboard-inset")
        : "";
  if (!raw.trim()) {
    return 0;
  }
  return normalizeInset(parseFloat(raw));
}

function parseKeyboardInsetEvent(event: Event): number | undefined {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail === "number") {
    return normalizeInset(detail);
  }
  if (typeof detail === "object" && detail !== null) {
    const record = detail as { bottom?: unknown; insetBottom?: unknown; height?: unknown };
    const raw = record.bottom ?? record.insetBottom ?? record.height;
    if (typeof raw === "number") {
      return normalizeInset(raw);
    }
  }
  return undefined;
}

export function detectPlatform(): PlatformAdapter {
  const deviceDisplayName = /Android/i.test(navigator.userAgent)
    ? "Waypoint Android"
    : "Waypoint macOS";
  let navDepth = 0;
  let suppressedPopCount = 0;
  let backInFlight = false;
  let queuedBacks = 0;
  let queuedPushes = 0;
  let hasSystemBackListener = false;
  let customEventInset = 0;

  function measureKeyboardInsetBottom(): number {
    if (typeof window === "undefined") {
      return 0;
    }
    const vv = window.visualViewport;
    const vvInset = vv
      ? normalizeInset(window.innerHeight - (vv.height + vv.offsetTop))
      : 0;
    const vk = getVirtualKeyboard();
    const vkInset =
      vk?.boundingRect && typeof vk.boundingRect.height === "number"
        ? normalizeInset(vk.boundingRect.height)
        : 0;
    const cssInset = readRootCssKeyboardInset();
    return Math.max(vvInset, vkInset, customEventInset, cssInset);
  }

  function subscribeKeyboardInsetBottom(onChange: (insetBottom: number) => void): () => void {
    if (typeof window === "undefined") {
      return () => undefined;
    }
    let lastInset = measureKeyboardInsetBottom();
    const notify = () => {
      const nextInset = measureKeyboardInsetBottom();
      if (nextInset !== lastInset) {
        lastInset = nextInset;
        onChange(nextInset);
      }
    };
    const handleCustomInset = (event: Event) => {
      const parsed = parseKeyboardInsetEvent(event);
      if (parsed !== undefined) {
        customEventInset = parsed;
        notify();
      }
    };
    const vv = window.visualViewport;
    const vk = getVirtualKeyboard();
    vv?.addEventListener("resize", notify);
    vv?.addEventListener("scroll", notify);
    vk?.addEventListener?.("geometrychange", notify);
    window.addEventListener("resize", notify);
    window.addEventListener(KEYBOARD_INSET_EVENT, handleCustomInset);
    return () => {
      vv?.removeEventListener("resize", notify);
      vv?.removeEventListener("scroll", notify);
      vk?.removeEventListener?.("geometrychange", notify);
      window.removeEventListener("resize", notify);
      window.removeEventListener(KEYBOARD_INSET_EVENT, handleCustomInset);
    };
  }

  return {
    deviceDisplayName,
    viewportMode: currentViewportMode,
    subscribeViewportMode,
    keyboardInsetBottom: measureKeyboardInsetBottom,
    subscribeKeyboardInsetBottom,
    pushNavigationEntry() {
      navDepth += 1;
      if (hasSystemBackListener && queuedBacks > 0) {
        queuedBacks -= 1;
        suppressedPopCount = Math.max(0, suppressedPopCount - 1);
        return;
      }
      if (hasSystemBackListener && backInFlight) {
        queuedPushes += 1;
        return;
      }
      if (typeof window !== "undefined" && window.history) {
        window.history.pushState({ waypointDepth: navDepth }, "");
      }
    },
    popNavigationEntry() {
      if (navDepth <= 0) {
        return;
      }
      navDepth -= 1;
      if (hasSystemBackListener && queuedPushes > 0) {
        queuedPushes -= 1;
        return;
      }
      if (typeof window !== "undefined" && window.history) {
        suppressedPopCount += 1;
        if (hasSystemBackListener && backInFlight) {
          queuedBacks += 1;
          return;
        }
        if (hasSystemBackListener) {
          backInFlight = true;
        }
        window.history.back();
      }
    },
    onSystemBack(handler) {
      if (typeof window === "undefined") {
        return () => undefined;
      }
      hasSystemBackListener = true;
      const handlePopState = () => {
        backInFlight = false;
        if (suppressedPopCount > 0) {
          suppressedPopCount -= 1;
          if (queuedBacks > 0) {
            queuedBacks -= 1;
            backInFlight = true;
            window.history.back();
            return;
          }
          if (queuedPushes > 0) {
            const toPush = queuedPushes;
            queuedPushes = 0;
            const baseDepth = navDepth - toPush;
            for (let i = 1; i <= toPush; i += 1) {
              window.history.pushState({ waypointDepth: baseDepth + i }, "");
            }
            return;
          }
          return;
        }
        if (navDepth > 0) {
          navDepth -= 1;
        }
        handler();
      };
      window.addEventListener("popstate", handlePopState);
      return () => {
        window.removeEventListener("popstate", handlePopState);
        hasSystemBackListener = false;
        backInFlight = false;
        queuedBacks = 0;
        queuedPushes = 0;
        suppressedPopCount = 0;
      };
    },
    focusMainWindow() {
      if (typeof window !== "undefined" && typeof window.focus === "function") {
        window.focus();
      }
    },
    isAppVisible: currentAppVisible,
    subscribeAppVisibility,
    subscribeNetworkResume,
    async openExternalUrl(url: string) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
        return;
      }
      if (isTauri()) {
        try {
          await invoke("plugin:opener|open_url", { url });
          return;
        } catch {
          // fallback to window.open
        }
      }
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
    openMediaFile({ data, mimeType, filename }) {
      if (typeof document === "undefined") {
        return;
      }
      const bytes = new Uint8Array(data);
      const safeMime = mimeType || "application/octet-stream";
      if (typeof URL.createObjectURL === "function") {
        const blob = new Blob([bytes], { type: safeMime });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.click();
        window.setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
        }, 60_000);
        return;
      }
      if (typeof window !== "undefined" && typeof window.open === "function") {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]!);
        }
        const dataUrl = `data:${safeMime};base64,${btoa(binary)}`;
        window.open(dataUrl, "_blank", "noopener,noreferrer");
      }
    },
  };
}

export function createFetchTransport(): HomeserverTransport {
  return {
    async request(input) {
      try {
        let requestBody: BodyInit | undefined;
        if (input.body !== undefined) {
          if (input.body instanceof Uint8Array) {
            requestBody = new Uint8Array(input.body);
          } else if (input.body instanceof ArrayBuffer) {
            requestBody = new Uint8Array(input.body);
          } else {
            requestBody = JSON.stringify(input.body);
          }
        }
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: requestBody,
          redirect: "manual",
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          return { type: "response", status: response.status || 302, body: null };
        }
        if (input.responseType === "bytes" && response.status >= 200 && response.status < 300) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { type: "response", status: response.status, body: bytes };
        }
        const text = await response.text();
        if (!text) {
          return { type: "response", status: response.status, body: null };
        }
        try {
          return { type: "response", status: response.status, body: JSON.parse(text) };
        } catch {
          return { type: "response", status: response.status, body: text };
        }
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) {
          return { type: "failure", failure: { type: "aborted" } };
        }
        return { type: "failure", failure: { type: "network" } };
      }
    },
  };
}
