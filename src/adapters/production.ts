import type { Clock, HomeserverTransport, PlatformAdapter } from "./types";

export const systemClock: Clock = {
  setTimeout: (handler, timeoutMs) => window.setTimeout(handler, timeoutMs),
  clearTimeout: (id) => window.clearTimeout(id),
};

export function detectPlatform(): PlatformAdapter {
  if (/Android/i.test(navigator.userAgent)) {
    return { deviceDisplayName: "Waypoint Android" };
  }
  return { deviceDisplayName: "Waypoint macOS" };
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
