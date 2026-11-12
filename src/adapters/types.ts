export type TransportFailure =
  | { type: "untrusted-certificate" }
  | { type: "hostname-mismatch" }
  | { type: "https-unavailable" }
  | { type: "network" }
  | { type: "timeout" }
  | { type: "aborted" };

export type TransportResult =
  | { type: "response"; status: number; body: unknown }
  | { type: "failure"; failure: TransportFailure };

export type HomeserverRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: "json" | "bytes";
  signal?: AbortSignal;
};

export interface HomeserverTransport {
  request(input: HomeserverRequest): Promise<TransportResult>;
}

export type ViewportMode = "wide" | "narrow";

export interface PlatformAdapter {
  deviceDisplayName: string;
  viewportMode?: () => ViewportMode;
  subscribeViewportMode?: (onChange: (mode: ViewportMode) => void) => () => void;
  keyboardInsetBottom?: () => number;
  subscribeKeyboardInsetBottom?: (onChange: (insetBottom: number) => void) => () => void;
  onSystemBack?: (handler: () => boolean) => () => void;
  pushNavigationEntry?: () => void;
  popNavigationEntry?: () => void;
  focusMainWindow?: () => void;
  isAppVisible?: () => boolean;
  subscribeAppVisibility?: (onChange: (visible: boolean) => void) => () => void;
  subscribeNetworkResume?: (onResume: () => void) => () => void;
  openExternalUrl?: (url: string) => void | Promise<void>;
  openMediaFile?: (input: {
    data: Uint8Array;
    mimeType: string;
    filename: string;
  }) => void | Promise<void>;
}

export interface Clock {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(id: number): void;
  currentTimeMs?: () => number;
}
