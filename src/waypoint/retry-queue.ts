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
  private paused = false;
  private timer: number | undefined;
  private backoffStep = 0;
  private disposed = false;
  private wakePending = false;
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
    return this.running || this.timer !== undefined;
  }

  pause(): void {
    this.paused = true;
    this.wakePending = false;
    this.clearTimer();
  }

  resume(): void {
    this.paused = false;
  }

  wake(): void {
    if (this.paused || this.disposed || !this.client.hasToken) {
      return;
    }
    this.backoffStep = 0;
    this.clearTimer();
    if (this.running) {
      this.wakePending = true;
      return;
    }
    void this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.wakePending = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
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
      void this.flush();
    }, delay);
  }

  async flush(): Promise<void> {
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
          this.paused = true;
          this.clearTimer();
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
        void this.flush();
      } else {
        this.wakePending = false;
      }
    }
  }
}
