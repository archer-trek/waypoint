import { invoke, isTauri } from "@tauri-apps/api/core";
import { installViewportScrollLock } from "../lib/viewport-lock";
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
  const isAndroid = /Android/i.test(navigator.userAgent);
  const deviceDisplayName = isAndroid ? "Waypoint Android" : "Waypoint macOS";
  let navDepth = 0;
  let suppressedPopCount = 0;
  let backInFlight = false;
  let queuedBacks = 0;
  let queuedPushes = 0;
  let hasSystemBackListener = false;
  let customEventInset = 0;
  let customEventEpoch = 0;
  let sawViewportKeyboard = false;
  let viewportDismissed = false;
  let expiredEpoch = 0;
  let expiredCssInset = -1;
  let pendingClosedPublication = false;

  function readViewportKeyboardInset(): number {
    if (typeof window === "undefined") {
      return 0;
    }
    const vv = window.visualViewport;
    const vvInset = vv ? normalizeInset(window.innerHeight - vv.height) : 0;
    const vk = getVirtualKeyboard();
    const vkInset =
      vk?.boundingRect && typeof vk.boundingRect.height === "number"
        ? normalizeInset(vk.boundingRect.height)
        : 0;
    return Math.max(vvInset, vkInset);
  }

  // A restored visual viewport is the keyboard being gone. Native IME events and the
  // root --keyboard-inset written with them keep their last height until a newer
  // publication, and that leftover must not keep the composer raised. While the
  // viewport reports an open keyboard, its CSS-pixel overlap is the height — a
  // mismatched native unit cannot outrank it.
  function measureKeyboardInsetBottom(): number {
    const viewportInset = readViewportKeyboardInset();
    const cssInset = readRootCssKeyboardInset();
    if (viewportInset > 0) {
      sawViewportKeyboard = true;
      pendingClosedPublication = false;
      return viewportInset;
    }
    if (sawViewportKeyboard) {
      sawViewportKeyboard = false;
      viewportDismissed = true;
      if (pendingClosedPublication && customEventInset > 0) {
        expiredEpoch = customEventEpoch - 1;
        expiredCssInset = cssInset === customEventInset ? -1 : cssInset;
      } else {
        expiredEpoch = customEventEpoch;
        expiredCssInset = cssInset;
      }
      pendingClosedPublication = false;
    }
    if (!viewportDismissed) {
      return Math.max(customEventInset, cssInset);
    }
    const nativeLive = customEventEpoch > expiredEpoch ? customEventInset : 0;
    const cssLive = expiredCssInset >= 0 && cssInset === expiredCssInset ? 0 : cssInset;
    return Math.max(nativeLive, cssLive);
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
      if (parsed === undefined) {
        return;
      }
      customEventInset = parsed;
      customEventEpoch += 1;
      if (readViewportKeyboardInset() === 0) {
        pendingClosedPublication = true;
      }
      notify();
    };
    const vv = window.visualViewport;
    const vk = getVirtualKeyboard();
    if (vk && "overlaysContent" in vk) {
      try {
        (vk as { overlaysContent?: boolean }).overlaysContent = true;
      } catch {
        /* ignore */
      }
    }
    const removeViewportLock = installViewportScrollLock(
      window,
      typeof document !== "undefined" ? document : undefined,
    );
    vv?.addEventListener("resize", notify);
    vv?.addEventListener("scroll", notify);
    vk?.addEventListener?.("geometrychange", notify);
    window.addEventListener("resize", notify);
    window.addEventListener(KEYBOARD_INSET_EVENT, handleCustomInset);
    return () => {
      removeViewportLock();
      vv?.removeEventListener("resize", notify);
      vv?.removeEventListener("scroll", notify);
      vk?.removeEventListener?.("geometrychange", notify);
      window.removeEventListener("resize", notify);
      window.removeEventListener(KEYBOARD_INSET_EVENT, handleCustomInset);
    };
  }

  return {
    deviceDisplayName,
    suspendSyncInBackground: isAndroid,
    supportsFileDropAndPaste: !isAndroid,
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
        await invoke("plugin:opener|open_url", { url });
        return;
      }
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
    async openMediaFile({ data, mimeType, filename }) {
      const bytes = new Uint8Array(data);
      if (isTauri()) {
        await invoke("open_media_file", {
          bytes: Array.from(bytes),
          filename,
        });
        return;
      }
      if (typeof document === "undefined") {
        return;
      }
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
