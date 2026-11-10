export type TransportFailure =
  | { type: "untrusted-certificate" }
  | { type: "hostname-mismatch" }
  | { type: "https-unavailable" }
  | { type: "network" }
  | { type: "timeout" };

export type TransportResult =
  | { type: "response"; status: number; body: unknown }
  | { type: "failure"; failure: TransportFailure };

export type HomeserverRequest = {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export interface HomeserverTransport {
  request(input: HomeserverRequest): Promise<TransportResult>;
}

export interface PlatformAdapter {
  deviceDisplayName: string;
}

export interface Clock {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(id: number): void;
}
