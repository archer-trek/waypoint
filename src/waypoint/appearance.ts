import { useSyncExternalStore } from "react";

export type AppearanceMode = "system" | "light" | "dark";
export type ResolvedAppearance = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "waypoint.appearance";

export const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: AppearanceMode;
  label: string;
}> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const THEME_COLORS: Record<ResolvedAppearance, string> = {
  light: "#ffffff",
  dark: "#09090b",
};

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "system" || value === "light" || value === "dark";
}

function getStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  } catch {
    return null;
  }
}

function getSystemDarkMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  try {
    return window.matchMedia(DARK_MEDIA_QUERY);
  } catch {
    return null;
  }
}

/** Read the persisted device-local appearance mode, falling back to "system". */
export function readStoredAppearanceMode(): AppearanceMode {
  const storage = getStorage();
  if (!storage) {
    return "system";
  }
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearanceMode(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function writeStoredAppearanceMode(mode: AppearanceMode | null): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    if (mode === null) {
      storage.removeItem(APPEARANCE_STORAGE_KEY);
    } else {
      storage.setItem(APPEARANCE_STORAGE_KEY, mode);
    }
  } catch {
    // Ignore storage quota or security errors on restricted environments.
  }
}

/** Resolve an appearance mode to "light" or "dark" using the current OS scheme. */
export function resolveAppearance(mode: AppearanceMode): ResolvedAppearance {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  return getSystemDarkMediaQuery()?.matches ? "dark" : "light";
}

function syncThemeColorMeta(resolved: ResolvedAppearance): void {
  if (typeof document === "undefined" || !document.head) {
    return;
  }
  const color = THEME_COLORS[resolved];
  const metas = Array.from(
    document.head.querySelectorAll('meta[name="theme-color"]'),
  );
  if (metas.length === 0) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", color);
    document.head.appendChild(meta);
    return;
  }
  const primary = metas[0];
  primary.setAttribute("content", color);
  primary.removeAttribute("media");
  for (let index = 1; index < metas.length; index += 1) {
    metas[index].remove();
  }
}

/** Apply the resolved theme class, data-theme attribute, and theme-color meta tag. */
export function applyAppearanceToDocument(mode: AppearanceMode): ResolvedAppearance {
  const resolved = resolveAppearance(mode);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.dataset.theme = resolved;
    syncThemeColorMeta(resolved);
  }
  return resolved;
}

let currentMode: AppearanceMode = readStoredAppearanceMode();
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const listener of subscribers) {
    listener();
  }
}

function subscribeAppearance(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

function getAppearanceSnapshot(): AppearanceMode {
  return currentMode;
}

/** Update the device-local appearance mode and apply it immediately. */
export function setAppearanceMode(mode: AppearanceMode): void {
  currentMode = mode;
  writeStoredAppearanceMode(mode);
  applyAppearanceToDocument(mode);
  notifySubscribers();
}

/** Clear stored local appearance preference and reset back to "system". */
export function resetAppearancePreference(): void {
  currentMode = "system";
  writeStoredAppearanceMode(null);
  applyAppearanceToDocument("system");
  notifySubscribers();
}

/**
 * Synchronize appearance state from localStorage, apply it to the document,
 * and subscribe to live OS color scheme changes while in "system" mode.
 */
export function syncAppearanceLifecycle(): () => void {
  const stored = readStoredAppearanceMode();
  const changed = stored !== currentMode;
  currentMode = stored;
  applyAppearanceToDocument(currentMode);
  if (changed) {
    notifySubscribers();
  }

  const mediaQuery = getSystemDarkMediaQuery();
  if (!mediaQuery) {
    return () => {};
  }

  const handleChange = () => {
    if (currentMode === "system") {
      applyAppearanceToDocument("system");
    }
  };

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }
  if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }
  return () => {};
}

/** React hook subscribing to the device-local appearance preference. */
export function useAppearancePreference(): readonly [
  AppearanceMode,
  (mode: AppearanceMode) => void,
] {
  const mode = useSyncExternalStore(
    subscribeAppearance,
    getAppearanceSnapshot,
    () => "system" as AppearanceMode,
  );
  return [mode, setAppearanceMode] as const;
}
