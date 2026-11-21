export type WaypointAndroidBridge = {
  setSystemBackEnabled?: (enabled: boolean) => void;
  setSystemAppearance?: (appearance: string) => void;
};

export type WaypointAndroidWindow = Window & {
  WaypointAndroid?: WaypointAndroidBridge;
  __waypointHandleSystemBack?: () => boolean;
};

/** Return the Android WebView native bridge object when running inside MainActivity. */
export function getAndroidBridge(): WaypointAndroidBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as WaypointAndroidWindow).WaypointAndroid;
}
