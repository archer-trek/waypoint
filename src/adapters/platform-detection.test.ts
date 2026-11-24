import { afterEach, describe, expect, test } from "vitest";
import { detectPlatform } from "./production";

type NavigatorOverrides = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
};

describe("detectPlatform deviceDisplayName detection", () => {
  const originalDescriptors = {
    userAgent: Object.getOwnPropertyDescriptor(navigator, "userAgent"),
    platform: Object.getOwnPropertyDescriptor(navigator, "platform"),
    maxTouchPoints: Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints"),
  };

  function setNavigatorProps(overrides: NavigatorOverrides) {
    for (const [key, value] of Object.entries(overrides)) {
      Object.defineProperty(navigator, key, {
        configurable: true,
        value,
      });
    }
  }

  afterEach(() => {
    for (const [key, descriptor] of Object.entries(originalDescriptors)) {
      if (descriptor) {
        Object.defineProperty(navigator, key, descriptor);
      } else {
        delete (navigator as unknown as Record<string, unknown>)[key];
      }
    }
  });

  test("identifies Android even when userAgent contains Linux", () => {
    setNavigatorProps({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    const platform = detectPlatform();
    expect(platform.deviceDisplayName).toBe("Waypoint Android");
    expect(platform.suspendSyncInBackground).toBe(true);
    expect(platform.supportsFileDropAndPaste).toBe(false);
  });

  test("identifies iOS for iPhone, iPad, and touch-enabled iPadOS MacIntel", () => {
    setNavigatorProps({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    expect(detectPlatform().deviceDisplayName).toBe("Waypoint iOS");

    setNavigatorProps({
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      platform: "iPad",
      maxTouchPoints: 5,
    });
    expect(detectPlatform().deviceDisplayName).toBe("Waypoint iOS");

    setNavigatorProps({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(detectPlatform().deviceDisplayName).toBe("Waypoint iOS");
  });

  test("identifies Windows via userAgent or Win32/Win64 platform", () => {
    setNavigatorProps({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/128.0.0.0",
      platform: "Win32",
      maxTouchPoints: 0,
    });
    const fromUa = detectPlatform();
    expect(fromUa.deviceDisplayName).toBe("Waypoint Windows");
    expect(fromUa.suspendSyncInBackground).toBe(false);
    expect(fromUa.supportsFileDropAndPaste).toBe(true);

    setNavigatorProps({
      userAgent: "Mozilla/5.0 (compatible; WebView2)",
      platform: "Win32",
      maxTouchPoints: 0,
    });
    expect(detectPlatform().deviceDisplayName).toBe("Waypoint Windows");
  });

  test("identifies macOS when non-touch MacIntel or Macintosh userAgent is present", () => {
    setNavigatorProps({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(detectPlatform().deviceDisplayName).toBe("Waypoint macOS");
  });

  test("identifies Linux and falls back to Waypoint when OS is unknown", () => {
    setNavigatorProps({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0",
      platform: "Linux x86_64",
      maxTouchPoints: 0,
    });
    expect(detectPlatform().deviceDisplayName).toBe("Waypoint Linux");

    setNavigatorProps({
      userAgent: "CustomClient/1.0",
      platform: "",
      maxTouchPoints: 0,
    });
    expect(detectPlatform().deviceDisplayName).toBe("Waypoint");
  });
});
