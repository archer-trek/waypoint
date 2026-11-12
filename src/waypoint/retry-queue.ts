import type { Clock } from "../adapters/types";
import type { MatrixClient } from "./matrix-client";
import { isCredentialRejected, isRateLimited, isRecord } from "./matrix-errors";

export const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export type RetryQueueCallbacks = {
  onConfirmed?: () => void;
  onCredentialRejected?: () => void;
};

export class RetryQueue {
  private running = false;
  private readMarkersRunning = false;
  private paused = false;
  private timer: number | undefined;
  private readMarkerTimer: number | undefined;
  private backoffStep = 0;
  private readMarkerBackoffStep = 0;
  private disposed = false;
  private wakePending = false;
  private readMarkersWakePending = false;
  private callbacks: RetryQueueCallbacks = {};

  constructor(
    private readonly client: MatrixClient,
    private readonly clock: Clock,
  ) {}

  setCallbacks(callbacks: RetryQueueCallbacks): void {
    this.callbacks = callbacks;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  isActive(): boolean {
    return (
      this.running ||
      this.timer !== undefined ||
      this.readMarkersRunning ||
      this.readMarkerTimer !== undefined
    );
  }

  pause(): void {
    this.paused = true;
    this.wakePending = false;
    this.readMarkersWakePending = false;
    this.clearTimer();
    this.clearReadMarkerTimer();
  }

  resume(): void {
    this.paused = false;
  }

  wake(): void {
    if (this.paused || this.disposed || !this.client.hasToken) {
      return;
    }
    this.wakeEvents();
    this.wakeReadMarkers();
  }

  wakeEvents(): void {
    if (this.paused || this.disposed || !this.client.hasToken) {
      return;
    }
    this.backoffStep = 0;
    this.clearTimer();
    if (this.running) {
      this.wakePending = true;
      return;
    }
    void this.flushEvents();
  }

  wakeReadMarkers(): void {
    if (this.paused || this.disposed || !this.client.hasToken) {
      return;
    }
    this.readMarkerBackoffStep = 0;
    this.clearReadMarkerTimer();
    if (this.readMarkersRunning) {
      this.readMarkersWakePending = true;
      return;
    }
    void this.flushReadMarkers();
  }

  dispose(): void {
    this.disposed = true;
    this.wakePending = false;
    this.readMarkersWakePending = false;
    this.clearTimer();
    this.clearReadMarkerTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private clearReadMarkerTimer(): void {
    if (this.readMarkerTimer !== undefined) {
      this.clock.clearTimeout(this.readMarkerTimer);
      this.readMarkerTimer = undefined;
    }
  }

  private scheduleRetry(): void {
    this.clearTimer();
    if (this.disposed || this.paused) {
      return;
    }
    const delay = RETRY_BACKOFF_MS[Math.min(this.backoffStep, RETRY_BACKOFF_MS.length - 1)];
    this.backoffStep += 1;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.flushEvents();
    }, delay);
  }

  private scheduleReadMarkerRetry(): void {
    this.clearReadMarkerTimer();
    if (this.disposed || this.paused) {
      return;
    }
    const delay =
      RETRY_BACKOFF_MS[Math.min(this.readMarkerBackoffStep, RETRY_BACKOFF_MS.length - 1)];
    this.readMarkerBackoffStep += 1;
    this.readMarkerTimer = this.clock.setTimeout(() => {
      this.readMarkerTimer = undefined;
      void this.flushReadMarkers();
    }, delay);
  }

  async flush(): Promise<void> {
    await Promise.all([this.flushEvents(), this.flushReadMarkers()]);
  }

  private async flushEvents(): Promise<void> {
    if (this.running || this.disposed || this.paused || !this.client.hasToken) {
      return;
    }
    this.running = true;
    this.clearTimer();
    try {
      while (!this.disposed && !this.paused && this.client.hasToken) {
        const pending = this.client.pendingRoomEvents();
        if (pending.length === 0) {
          this.backoffStep = 0;
          break;
        }
        const head = pending[0];
        let result;
        try {
          result = await this.client.sendRoomEvent(head.roomId, head.type, head.txnId, head.content);
        } catch {
          if (!this.disposed && !this.paused) {
            this.scheduleRetry();
          }
          break;
        }
        if (this.disposed || this.paused) {
          break;
        }
        if (isCredentialRejected(result)) {
          this.pause();
          this.callbacks.onCredentialRejected?.();
          break;
        }
        if (
          result.type === "response" &&
          result.status === 200 &&
          isRecord(result.body) &&
          typeof result.body.event_id === "string" &&
          result.body.event_id !== ""
        ) {
          await this.client.confirmSentRoomEvent(head.roomId, head.txnId, result.body.event_id);
          this.backoffStep = 0;
          if (this.disposed) {
            break;
          }
          this.callbacks.onConfirmed?.();
          continue;
        }
        if (
          result.type === "failure" ||
          isRateLimited(result.status, result.body) ||
          result.status >= 500
        ) {
          this.scheduleRetry();
          break;
        }
        break;
      }
    } finally {
      this.running = false;
      if (this.wakePending && !this.disposed && !this.paused && this.client.hasToken) {
        this.wakePending = false;
        this.clearTimer();
        void this.flushEvents();
      } else {
        this.wakePending = false;
      }
    }
  }

  private async flushReadMarkers(): Promise<void> {
    if (this.readMarkersRunning || this.disposed || this.paused || !this.client.hasToken) {
      return;
    }
    this.readMarkersRunning = true;
    this.clearReadMarkerTimer();
    try {
      while (!this.disposed && !this.paused && this.client.hasToken) {
        const pending = this.client.pendingReadMarkers();
        if (pending.length === 0) {
          this.readMarkerBackoffStep = 0;
          break;
        }
        const head = pending[0];
        let result;
        try {
          result = await this.client.sendReadMarkers(head.roomId, head.eventId);
        } catch {
          if (!this.disposed && !this.paused) {
            this.scheduleReadMarkerRetry();
          }
          break;
        }
        if (this.disposed || this.paused) {
          break;
        }
        if (isCredentialRejected(result)) {
          this.pause();
          this.callbacks.onCredentialRejected?.();
          break;
        }
        if (result.type === "response" && result.status >= 200 && result.status < 300) {
          await this.client.confirmSentReadMarker(head.roomId, head.eventId);
          this.readMarkerBackoffStep = 0;
          if (this.disposed) {
            break;
          }
          this.callbacks.onConfirmed?.();
          continue;
        }
        if (
          result.type === "failure" ||
          isRateLimited(result.status, result.body) ||
          result.status >= 500
        ) {
          this.scheduleReadMarkerRetry();
          break;
        }
        break;
      }
    } finally {
      this.readMarkersRunning = false;
      if (this.readMarkersWakePending && !this.disposed && !this.paused && this.client.hasToken) {
        this.readMarkersWakePending = false;
        this.clearReadMarkerTimer();
        void this.flushReadMarkers();
      } else {
        this.readMarkersWakePending = false;
      }
    }
  }
}
