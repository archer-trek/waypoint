import { describe, expect, test, vi } from "vitest";
import type { Clock } from "../adapters/types";
import { DRAFT_DEBOUNCE_MS, DraftPersistenceManager } from "./draft-debounce";

class ManualClock implements Clock {
  private nextId = 1;
  private timers = new Map<number, { at: number; handler: () => void }>();
  now = 0;

  get timerCount(): number {
    return this.timers.size;
  }

  setTimeout(handler: () => void, timeoutMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + timeoutMs, handler });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) {
        return;
      }
      const [id, timer] = due[0]!;
      this.timers.delete(id);
      timer.handler();
    }
  }
}

describe("DraftPersistenceManager", () => {
  test("coalesces rapid keystrokes per room into one 400ms debounced write with at most one pending timer", async () => {
    const clock = new ManualClock();
    const writes: Array<{ roomId: string; text: string; commit?: boolean }> = [];
    const manager = new DraftPersistenceManager(clock, async (roomId, text, options) => {
      writes.push({ roomId, text, commit: options?.commit });
    });

    const seq1 = manager.scheduleText("!r1:example.com", "h");
    const seq2 = manager.scheduleText("!r1:example.com", "he");
    const seq3 = manager.scheduleText("!r1:example.com", "hello");

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seq3).toBe(3);
    expect(clock.timerCount).toBe(1);
    expect(manager.hasPending("!r1:example.com")).toBe(true);

    clock.advance(DRAFT_DEBOUNCE_MS - 1);
    expect(writes).toEqual([]);
    expect(clock.timerCount).toBe(1);

    clock.advance(1);
    await Promise.resolve();
    expect(writes).toEqual([{ roomId: "!r1:example.com", text: "hello", commit: undefined }]);
    expect(clock.timerCount).toBe(0);
    expect(manager.hasPending("!r1:example.com")).toBe(false);
  });

  test("isolates debounce timers and sequences independently per room", async () => {
    const clock = new ManualClock();
    const writes: Array<{ roomId: string; text: string }> = [];
    const manager = new DraftPersistenceManager(clock, async (roomId, text) => {
      writes.push({ roomId, text });
    });

    manager.scheduleText("!r1:example.com", "room1");
    clock.advance(200);
    manager.scheduleText("!r2:example.com", "room2");
    expect(clock.timerCount).toBe(2);

    clock.advance(200);
    await Promise.resolve();
    expect(writes).toEqual([{ roomId: "!r1:example.com", text: "room1" }]);
    expect(clock.timerCount).toBe(1);

    clock.advance(200);
    await Promise.resolve();
    expect(writes).toEqual([
      { roomId: "!r1:example.com", text: "room1" },
      { roomId: "!r2:example.com", text: "room2" },
    ]);
    expect(clock.timerCount).toBe(0);
  });

  test("flush(roomId) immediately persists pending draft, cancels timer, and is idempotent", async () => {
    const clock = new ManualClock();
    const writes: Array<{ roomId: string; text: string; commit?: boolean }> = [];
    const manager = new DraftPersistenceManager(clock, async (roomId, text, options) => {
      writes.push({ roomId, text, commit: options?.commit });
    });

    manager.scheduleText("!r1:example.com", "urgent");
    manager.scheduleText("!r2:example.com", "other");
    expect(clock.timerCount).toBe(2);

    await manager.flush("!r1:example.com");
    expect(writes).toEqual([{ roomId: "!r1:example.com", text: "urgent", commit: undefined }]);
    expect(clock.timerCount).toBe(1);
    expect(manager.hasPending("!r1:example.com")).toBe(false);
    expect(manager.hasPending("!r2:example.com")).toBe(true);

    // Second flush for same room is a no-op
    await manager.flush("!r1:example.com");
    expect(writes).toHaveLength(1);

    // Flush all remaining with commit: true
    await manager.flush(undefined, { commit: true });
    expect(writes).toEqual([
      { roomId: "!r1:example.com", text: "urgent", commit: undefined },
      { roomId: "!r2:example.com", text: "other", commit: true },
    ]);
    expect(clock.timerCount).toBe(0);
    expect(manager.hasPending()).toBe(false);
  });

  test("cancel(roomId) and cancel() stop timers, bump monotonic seq, and reject stale in-flight writes", async () => {
    const clock = new ManualClock();
    const persisted: Array<{ roomId: string; text: string }> = [];
    let capturedIsCurrent: (() => boolean) | undefined;

    const manager = new DraftPersistenceManager(clock, async (roomId, text, options) => {
      capturedIsCurrent = options?.isCurrent;
      if (!options?.isCurrent || options.isCurrent()) {
        persisted.push({ roomId, text });
      }
    });

    const seqBefore = manager.scheduleText("!r1:example.com", "ghost");
    const seqAfterCancel = manager.cancel("!r1:example.com");
    expect(seqAfterCancel).toBeGreaterThan(seqBefore);
    expect(clock.timerCount).toBe(0);
    expect(manager.hasPending("!r1:example.com")).toBe(false);

    clock.advance(1000);
    await Promise.resolve();
    expect(persisted).toEqual([]);

    // Even if a flush started right before cancel, isCurrent() becomes false once cancelled
    const persistMock = vi.fn(async (_roomId: string, text: string, options?: { isCurrent?: () => boolean }) => {
      capturedIsCurrent = options?.isCurrent;
      // Simulate delay where cancel() runs before write commits
      manager2.cancel("!r1:example.com");
      if (!options?.isCurrent || options.isCurrent()) {
        persisted.push({ roomId: "!r1:example.com", text });
      }
    });
    const manager2 = new DraftPersistenceManager(clock, persistMock);
    manager2.scheduleText("!r1:example.com", "stale");
    await manager2.flush("!r1:example.com");
    expect(capturedIsCurrent?.()).toBe(false);
    expect(persisted).toEqual([]);

    // Global cancel() clears all rooms
    manager2.scheduleText("!r1:example.com", "a");
    manager2.scheduleText("!r2:example.com", "b");
    expect(clock.timerCount).toBe(2);
    manager2.cancel();
    expect(clock.timerCount).toBe(0);
    expect(manager2.hasPending()).toBe(false);
    clock.advance(1000);
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  test("retains pending draft for silent retry on natural trigger when persist rejects without newer edits", async () => {
    const clock = new ManualClock();
    let shouldFail = true;
    const writes: string[] = [];
    const manager = new DraftPersistenceManager(clock, async (_roomId, text) => {
      if (shouldFail) {
        throw new Error("QuotaExceededError");
      }
      writes.push(text);
    });

    manager.scheduleText("!r1:example.com", "retry-me");
    clock.advance(DRAFT_DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(manager.hasPending("!r1:example.com")).toBe(true);

    shouldFail = false;
    await manager.flush("!r1:example.com");
    expect(writes).toEqual(["retry-me"]);
    expect(manager.hasPending("!r1:example.com")).toBe(false);
  });
});
