import type { Clock } from "../adapters/types";

export const DRAFT_DEBOUNCE_MS = 400;

export type DraftPersistOptions = {
  commit?: boolean;
  isCurrent?: () => boolean;
};

export type PersistDraftTextFn = (
  roomId: string,
  text: string,
  options?: DraftPersistOptions,
) => Promise<void>;

export class DraftPersistenceManager {
  private readonly seqByRoom = new Map<string, number>();
  private readonly timerByRoom = new Map<string, number>();
  private readonly pendingByRoom = new Map<string, { text: string; seq: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly persistText: PersistDraftTextFn,
    private readonly debounceMs: number = DRAFT_DEBOUNCE_MS,
  ) {}

  currentSeq(roomId: string): number {
    return this.seqByRoom.get(roomId) ?? 0;
  }

  bumpSeq(roomId: string): number {
    const next = (this.seqByRoom.get(roomId) ?? 0) + 1;
    this.seqByRoom.set(roomId, next);
    return next;
  }

  hasPending(roomId?: string): boolean {
    if (roomId !== undefined) {
      return this.pendingByRoom.has(roomId);
    }
    return this.pendingByRoom.size > 0;
  }

  restorePending(roomId: string, text: string, expectedSeq: number): void {
    if (this.currentSeq(roomId) !== expectedSeq || this.pendingByRoom.has(roomId)) {
      return;
    }
    this.pendingByRoom.set(roomId, { text, seq: expectedSeq });
  }

  scheduleText(roomId: string, text: string): number {
    const seq = this.bumpSeq(roomId);
    this.clearTimer(roomId);
    const entry = { text, seq };
    this.pendingByRoom.set(roomId, entry);
    const timerId = this.clock.setTimeout(() => {
      this.timerByRoom.delete(roomId);
      if (this.currentSeq(roomId) !== seq) {
        return;
      }
      const pending = this.pendingByRoom.get(roomId);
      if (!pending || pending.seq !== seq) {
        return;
      }
      this.pendingByRoom.delete(roomId);
      void this.persistText(roomId, pending.text, {
        isCurrent: () => this.currentSeq(roomId) === seq,
      }).catch(() => {
        if (this.currentSeq(roomId) === seq && !this.pendingByRoom.has(roomId)) {
          this.pendingByRoom.set(roomId, pending);
        }
      });
    }, this.debounceMs);
    this.timerByRoom.set(roomId, timerId);
    return seq;
  }

  flush(roomId?: string, options?: { commit?: boolean }): Promise<void> {
    if (roomId !== undefined) {
      return this.flushRoom(roomId, options);
    }
    const roomIds = new Set<string>([
      ...this.timerByRoom.keys(),
      ...this.pendingByRoom.keys(),
    ]);
    if (roomIds.size === 0) {
      return Promise.resolve();
    }
    const flushes: Promise<void>[] = [];
    for (const id of roomIds) {
      flushes.push(this.flushRoom(id, options));
    }
    return Promise.all(flushes).then(() => undefined);
  }

  cancel(roomId: string): number;
  cancel(): void;
  cancel(roomId?: string): number | void {
    if (roomId !== undefined) {
      this.clearTimer(roomId);
      this.pendingByRoom.delete(roomId);
      return this.bumpSeq(roomId);
    }
    const roomIds = new Set<string>([
      ...this.timerByRoom.keys(),
      ...this.pendingByRoom.keys(),
      ...this.seqByRoom.keys(),
    ]);
    for (const id of roomIds) {
      this.clearTimer(id);
      this.pendingByRoom.delete(id);
      this.bumpSeq(id);
    }
  }

  private clearTimer(roomId: string): void {
    const existingTimer = this.timerByRoom.get(roomId);
    if (existingTimer !== undefined) {
      this.clock.clearTimeout(existingTimer);
      this.timerByRoom.delete(roomId);
    }
  }

  private flushRoom(roomId: string, options?: { commit?: boolean }): Promise<void> {
    this.clearTimer(roomId);
    const pending = this.pendingByRoom.get(roomId);
    if (!pending) {
      return Promise.resolve();
    }
    if (this.currentSeq(roomId) !== pending.seq) {
      this.pendingByRoom.delete(roomId);
      return Promise.resolve();
    }
    this.pendingByRoom.delete(roomId);
    const capturedSeq = pending.seq;
    return this.persistText(roomId, pending.text, {
      ...(options?.commit ? { commit: true } : {}),
      isCurrent: () => this.currentSeq(roomId) === capturedSeq,
    }).catch(() => {
      if (this.currentSeq(roomId) === capturedSeq && !this.pendingByRoom.has(roomId)) {
        this.pendingByRoom.set(roomId, pending);
      }
    });
  }
}
