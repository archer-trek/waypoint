import type { Clock, HomeserverTransport, PlatformAdapter, ViewportMode } from "./types";

const WIDE_VIEWPORT_MEDIA_QUERY = "(min-width: 48em)";
let productionInstanceActive = false;

export const systemClock: Clock = {
  setTimeout: (handler, timeoutMs) => window.setTimeout(handler, timeoutMs),
  clearTimeout: (id) => window.clearTimeout(id),
  currentTimeMs: () => Date.now(),
};

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

function measureKeyboardInsetBottom(): number {
  if (typeof window === "undefined" || !window.visualViewport) {
    return 0;
  }
  const vv = window.visualViewport;
  const inset = window.innerHeight - (vv.height + vv.offsetTop);
  return Number.isFinite(inset) && inset > 0 ? Math.round(inset) : 0;
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
  const vv = window.visualViewport;
  vv?.addEventListener("resize", notify);
  vv?.addEventListener("scroll", notify);
  window.addEventListener("resize", notify);
  return () => {
    vv?.removeEventListener("resize", notify);
    vv?.removeEventListener("scroll", notify);
    window.removeEventListener("resize", notify);
  };
}

export function detectPlatform(): PlatformAdapter {
  const deviceDisplayName = /Android/i.test(navigator.userAgent)
    ? "Waypoint Android"
    : "Waypoint macOS";
  let navDepth = 0;
  let suppressedDepth: number | null = null;

  return {
    deviceDisplayName,
    viewportMode: currentViewportMode,
    subscribeViewportMode,
    keyboardInsetBottom: measureKeyboardInsetBottom,
    subscribeKeyboardInsetBottom,
    pushNavigationEntry() {
      navDepth += 1;
      suppressedDepth = null;
      if (typeof window !== "undefined" && window.history) {
        window.history.pushState({ waypointDepth: navDepth }, "");
      }
    },
    popNavigationEntry() {
      if (navDepth > 0) {
        navDepth -= 1;
        suppressedDepth = navDepth;
        if (typeof window !== "undefined" && window.history) {
          window.history.back();
        }
      }
    },
    onSystemBack(handler) {
      if (typeof window === "undefined") {
        return () => undefined;
      }
      const handlePopState = (event: PopStateEvent) => {
        const stateDepth =
          event.state && typeof (event.state as { waypointDepth?: unknown }).waypointDepth === "number"
            ? (event.state as { waypointDepth: number }).waypointDepth
            : 0;
        if (suppressedDepth !== null && stateDepth === suppressedDepth) {
          suppressedDepth = null;
          return;
        }
        suppressedDepth = null;
        if (handler() && navDepth > 0) {
          navDepth -= 1;
        }
      };
      window.addEventListener("popstate", handlePopState);
      return () => window.removeEventListener("popstate", handlePopState);
    },
    acquireSingleInstanceGuard() {
      if (productionInstanceActive) {
        return false;
      }
      productionInstanceActive = true;
      return () => {
        productionInstanceActive = false;
      };
    },
    focusMainWindow() {
      if (typeof window !== "undefined" && typeof window.focus === "function") {
        window.focus();
      }
    },
  };
}

export function createFetchTransport(): HomeserverTransport {
  return {
    async request(input) {
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          redirect: "manual",
        });
        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          return { type: "response", status: response.status || 302, body: null };
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
      } catch {
        return { type: "failure", failure: { type: "network" } };
      }
    },
  };
}
