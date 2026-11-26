import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HomeserverTransport } from "../adapters/types";
import { MatrixClient, localPlaceholderOf } from "./matrix-client";
import { deriveTopics } from "./topics";
import {
  BLOBS_STORE,
  DB_NAME,
  DB_VERSION,
  DRAFTS_STORE,
  META_STORE,
  PENDING_EVENTS_STORE,
  PENDING_READ_MARKERS_STORE,
  ROOMS_STORE,
  TIMELINE_CHUNKS_STORE,
  TIMELINE_CHUNK_SIZE,
  loadBlob,
  loadV2Snapshot,
  saveSession,
} from "./session-store";

function noopTransport(): HomeserverTransport {
  return {
    request: async () => ({ type: "failure", failure: { type: "network" } }),
  };
}

function rejectNextStoreWrite(storeNames: string[], error = new DOMException("Quota exceeded", "QuotaExceededError")) {
  const origTx = IDBDatabase.prototype.transaction;
  let tripped = false;
  return vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    stores: string | Iterable<string>,
    mode?: IDBTransactionMode,
  ) {
    const tx = origTx.call(this, stores, mode);
    const list = typeof stores === "string" ? [stores] : Array.from(stores);
    if (!tripped && mode === "readwrite" && list.some((s) => storeNames.includes(s))) {
      tripped = true;
      queueMicrotask(() => {
        try {
          tx.abort();
        } catch {
          // ignore
        }
        tx.onerror?.(new Event("error") as Event);
      });
      Object.defineProperty(tx, "error", {
        configurable: true,
        get: () => error,
      });
    }
    return tx;
  });
}

describe("MatrixClient v2 persistence, blob decoupling, and commit-before-mutate", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("localPlaceholderOf never allocates or clones Uint8Array buffers and MatrixClient holds zero byte arrays", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const sliceSpy = vi.spyOn(Uint8Array.prototype, "slice");

    const legacyShaped = {
      type: "m.room.message",
      sender: "@alice:example.com",
      content: { msgtype: "m.image", body: "pic.png" },
      waypoint_local: {
        id: "loc-1",
        status: "unconfirmed",
        txnId: "txn-1",
        attachmentId: "att-1",
        attachment: {
          name: "pic.png",
          mimeType: "image/png",
          size: bytes.byteLength,
          data: bytes,
        },
      },
    };
    const meta = localPlaceholderOf(legacyShaped);
    expect(meta).toEqual({
      id: "loc-1",
      status: "unconfirmed",
      txnId: "txn-1",
      attachmentId: "att-1",
      attachmentMeta: {
        name: "pic.png",
        mimeType: "image/png",
        size: bytes.byteLength,
      },
    });
    expect("attachment" in (meta as Record<string, unknown>)).toBe(false);
    expect(sliceSpy).not.toHaveBeenCalled();

    // Verify MatrixClient in-memory state holds only attachmentId + metadata
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      drafts: {
        "!r1:example.com": {
          text: "draft",
          attachment: { name: "a.bin", mimeType: "application/octet-stream", size: 3, data: new Uint8Array([7, 8, 9]) },
        },
      },
      pendingEvents: [
        {
          txnId: "txn-1",
          roomId: "!r1:example.com",
          type: "m.room.message",
          sender: "@alice:example.com",
          content: { msgtype: "m.file", body: "b.bin" },
          attachment: { name: "b.bin", mimeType: "application/octet-stream", size: 2, data: new Uint8Array([4, 5]) },
        },
      ],
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();
    const restoredDraft = client.draft("!r1:example.com");
    expect(restoredDraft?.attachmentId).toBeTruthy();
    expect(restoredDraft?.attachmentMeta?.name).toBe("a.bin");
    expect(restoredDraft?.attachment).toBeUndefined();

    const restoredPending = client.pendingRoomEvents("!r1:example.com");
    expect(restoredPending[0]?.attachmentId).toBeTruthy();
    expect(restoredPending[0]?.attachmentMeta?.name).toBe("b.bin");
    expect(restoredPending[0]?.attachment).toBeUndefined();
  });

  test("single-copy blob lifecycle: draft -> enqueue -> fail -> resend -> confirm deletes blob cleanly", async () => {
    const client = new MatrixClient(noopTransport());
    await client.versions("https://matrix.example.com");
    await client.rememberLogin("@alice:example.com", "tok-1", "DEV1");

    const fileData = new Uint8Array([11, 22, 33, 44]);
    const assigned = await client.setDraftAttachment(
      "!r1:example.com",
      { name: "photo.png", mimeType: "image/png", size: 4 },
      fileData,
    );
    expect(assigned).toBeDefined();
    const attId = assigned!.attachmentId;
    expect((await loadBlob(attId))?.data).toEqual(fileData);

    // Send transfers attachmentId without duplicating blob
    const pending = await client.enqueueRoomEvent(
      "!r1:example.com",
      "m.room.message",
      { msgtype: "m.image", body: "photo.png", filename: "photo.png" },
      {
        clearDraft: true,
        attachmentId: attId,
        attachmentMeta: assigned!.attachmentMeta,
      },
    );
    expect(pending.attachmentId).toBe(attId);
    expect(client.draft("!r1:example.com")).toBeUndefined();

    // Check blobs store count is still 1
    const rawKeysAfterSend = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => {
        const db = req.result;
        const r = db.transaction(BLOBS_STORE, "readonly").objectStore(BLOBS_STORE).getAllKeys();
        r.onsuccess = () => {
          db.close();
          resolve(r.result);
        };
        r.onerror = () => {
          db.close();
          reject(r.error);
        };
      };
      req.onerror = () => reject(req.error);
    });
    expect(rawKeysAfterSend).toEqual([attId]);

    // Fail -> keep blob; resend -> reuse same attId; confirm -> delete blob
    await client.failPendingRoomEvent("!r1:example.com", pending.txnId);
    expect(await loadBlob(attId)).toBeDefined();

    const resent = await client.resendFailedRoomEvent("!r1:example.com", pending.txnId);
    expect(resent?.attachmentId).toBe(attId);
    expect(await loadBlob(attId)).toBeDefined();

    await client.confirmSentRoomEvent("!r1:example.com", resent!.txnId, "$ev-confirmed");
    expect(await loadBlob(attId)).toBeUndefined();
  });

  test("structural sharing preserves untouched room and timeline references on single-room updates", async () => {
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [{ type: "m.room.name", state_key: "", content: { name: "R1" } }],
          timelineEvents: [
            { type: "m.room.message", event_id: "$e1", sender: "@bot:example.com", content: { msgtype: "m.text", body: "1" } },
          ],
        },
        "!r2:example.com": {
          stateEvents: [{ type: "m.room.name", state_key: "", content: { name: "R2" } }],
          timelineEvents: [
            { type: "m.room.message", event_id: "$e2", sender: "@bot:example.com", content: { msgtype: "m.text", body: "2" } },
          ],
        },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();

    const beforeRooms = client.rooms();
    const r1TimelineBefore = beforeRooms["!r1:example.com"]!.timelineEvents;
    const r2RoomBefore = beforeRooms["!r2:example.com"]!;

    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");

    await client.advanceReadPosition("!r1:example.com", "$e1");
    expect(txSpy).toHaveBeenLastCalledWith([ROOMS_STORE, PENDING_READ_MARKERS_STORE], "readwrite");
    const afterReadRooms = client.rooms();
    expect(afterReadRooms["!r2:example.com"]).toBe(r2RoomBefore);
    expect(afterReadRooms["!r1:example.com"]!.timelineEvents).toBe(r1TimelineBefore);

    await client.retainRoomTag("!r1:example.com", "im.waypoint.pinned", { order: 0 });
    expect(txSpy).toHaveBeenLastCalledWith(ROOMS_STORE, "readwrite");
    const afterTagRooms = client.rooms();
    expect(afterTagRooms["!r2:example.com"]).toBe(r2RoomBefore);
    expect(afterTagRooms["!r1:example.com"]!.timelineEvents).toBe(r1TimelineBefore);
  });

  test("commit-before-mutate: QuotaExceededError leaves all MatrixClient mutators consistent with disk", async () => {
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: {
        "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] },
      },
      rooms: {
        "!r1:example.com": {
          stateEvents: [{ type: "m.room.name", state_key: "", content: { name: "Orig" } }],
          timelineEvents: [
            { type: "m.room.message", event_id: "$e1", sender: "@bot:example.com", content: { msgtype: "m.text", body: "hi" } },
          ],
        },
      },
      drafts: {
        "!r1:example.com": { text: "keep me" },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();

    // 1. retainSync fails -> cursor, rooms, accountData untouched
    let spy = rejectNextStoreWrite([META_STORE, ROOMS_STORE, TIMELINE_CHUNKS_STORE]);
    await expect(
      client.retainSync({
        result: {
          type: "response",
          status: 200,
          body: {
            next_batch: "batch-2",
            rooms: {
              join: {
                "!r2:example.com": {
                  state: { events: [] },
                  timeline: { events: [] },
                },
              },
            },
          },
        },
        incremental: true,
      }),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(client.hasSyncCursor).toBe(true);
    expect(Object.keys(client.rooms())).toEqual(["!r1:example.com"]);
    expect((await loadV2Snapshot()).meta?.syncCursor).toBe("batch-1");

    // 2. dropSyncCursor fails -> hasSyncCursor remains true
    spy = rejectNextStoreWrite([META_STORE]);
    await expect(client.dropSyncCursor()).rejects.toThrow();
    spy.mockRestore();
    expect(client.hasSyncCursor).toBe(true);

    // 3. retainAccountData fails -> accountData remains untouched
    spy = rejectNextStoreWrite([META_STORE]);
    await expect(
      client.retainAccountData("im.waypoint.agents", { agents: [] }),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(client.accountData("im.waypoint.agents")).toEqual({
      agents: [{ user_id: "@bot:example.com" }],
    });

    // 4. retainRoomTag fails -> tags remain untouched
    spy = rejectNextStoreWrite([ROOMS_STORE]);
    await expect(
      client.retainRoomTag("!r1:example.com", "im.waypoint.pinned", { order: 0 }),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(client.rooms()["!r1:example.com"]!.tags).toBeUndefined();

    // 5. rememberRoomStateEvents fails -> stateEvents remain untouched
    spy = rejectNextStoreWrite([ROOMS_STORE]);
    await expect(
      client.rememberRoomStateEvents("!r1:example.com", [
        { type: "m.room.name", state_key: "", content: { name: "Changed" } },
      ]),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(client.rooms()["!r1:example.com"]!.stateEvents[0]!.content).toEqual({ name: "Orig" });

    // 6. enqueueRoomEvent fails -> pending queue, timeline, and draft remain untouched
    spy = rejectNextStoreWrite([PENDING_EVENTS_STORE, TIMELINE_CHUNKS_STORE, DRAFTS_STORE]);
    await expect(
      client.enqueueRoomEvent(
        "!r1:example.com",
        "m.room.message",
        { msgtype: "m.text", body: "unsent" },
        { clearDraft: true },
      ),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(client.pendingRoomEvents()).toEqual([]);
    expect(client.rooms()["!r1:example.com"]!.timelineEvents).toHaveLength(1);
    expect(client.draft("!r1:example.com")?.text).toBe("keep me");

    // 7. advanceReadPosition fails -> readPositionEventId & pendingReadMarkers remain untouched
    spy = rejectNextStoreWrite([ROOMS_STORE, PENDING_READ_MARKERS_STORE]);
    await expect(client.advanceReadPosition("!r1:example.com", "$e1")).rejects.toThrow();
    spy.mockRestore();
    expect(client.rooms()["!r1:example.com"]!.readPositionEventId).toBeUndefined();
    expect(client.pendingReadMarkers()).toEqual([]);

    // 8. completeReauth fails -> token remains untouched
    spy = rejectNextStoreWrite([META_STORE]);
    await expect(client.completeReauth("tok-new", "DEV-NEW")).rejects.toThrow();
    spy.mockRestore();
    expect(client.currentDeviceId).toBe("DEV1");

    // 9. rememberLogin fails -> existing userId & rooms remain untouched
    spy = rejectNextStoreWrite([META_STORE, ROOMS_STORE]);
    await expect(client.rememberLogin("@bob:example.com", "tok-bob", "DEV-BOB")).rejects.toThrow();
    spy.mockRestore();
    expect(client.ownerId).toBe("@alice:example.com");
    expect(Object.keys(client.rooms())).toEqual(["!r1:example.com"]);
  });

  test("exitDevice clears all domain stores and resets meta in a single transaction", async () => {
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": { stateEvents: [], timelineEvents: [] },
      },
      drafts: {
        "!r1:example.com": {
          text: "draft",
          attachment: { name: "x.bin", mimeType: "application/octet-stream", size: 1, data: new Uint8Array([1]) },
        },
      },
    });
    const client = new MatrixClient(noopTransport());
    await client.restore();

    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");
    await client.exitDevice();

    const writeCalls = txSpy.mock.calls.filter((c) => c[1] === "readwrite");
    expect(writeCalls).toHaveLength(1);
    const snap = await loadV2Snapshot();
    expect(snap.meta).toEqual({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
    });
    expect(snap.rooms).toEqual({});
    expect(snap.timelines).toEqual({});
    expect(snap.drafts).toEqual({});
  });

  test("setDraftText honors isCurrent guard and commit option, and setDraftAttachment atomically merges pending text", async () => {
    const client = new MatrixClient(noopTransport());
    await client.versions("https://matrix.example.com");
    await client.rememberLogin("@alice:example.com", "tok-1", "DEV1");

    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");
    const commitSpy = vi.spyOn(IDBTransaction.prototype, "commit");

    // Stale isCurrent guard skips IndexedDB transaction completely
    await client.setDraftText("!r1:example.com", "ghost", { isCurrent: () => false });
    expect(txSpy).not.toHaveBeenCalled();
    expect(client.draft("!r1:example.com")).toBeUndefined();

    // commit: true forwards to saveDraftInStore
    await client.setDraftText("!r1:example.com", "saved", {
      commit: true,
      isCurrent: () => true,
    });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(client.draft("!r1:example.com")?.text).toBe("saved");

    // setDraftAttachment atomically merges newer unpersisted text in a single transaction
    txSpy.mockClear();
    const assigned = await client.setDraftAttachment(
      "!r1:example.com",
      { name: "pic.png", mimeType: "image/png", size: 3 },
      new Uint8Array([1, 2, 3]),
      { text: "merged text" },
    );
    expect(assigned?.attachmentMeta.name).toBe("pic.png");
    const writeTxs = txSpy.mock.calls.filter((c) => c[1] === "readwrite");
    expect(writeTxs).toHaveLength(1);
    expect(client.draft("!r1:example.com")).toEqual({
      text: "merged text",
      attachmentId: assigned!.attachmentId,
      attachmentMeta: assigned!.attachmentMeta,
    });

    // Removing attachment with text option preserves merged text in one transaction
    txSpy.mockClear();
    await client.setDraftAttachment("!r1:example.com", undefined, undefined, {
      text: "after remove",
    });
    const removeWriteTxs = txSpy.mock.calls.filter((c) => c[1] === "readwrite");
    expect(removeWriteTxs).toHaveLength(1);
    expect(client.draft("!r1:example.com")).toEqual({ text: "after remove" });
  });

  test("incremental sync and local placeholder lifecycle only write affected tail chunk(s) in IndexedDB", async () => {
    const events100 = Array.from({ length: 100 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$e${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `msg-${i}` },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 500, content: {} },
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
          ],
          timelineEvents: events100,
          readPositionEventId: "$e99",
        },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();

    const writtenChunkSeqs: number[] = [];
    const origPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      ...rest: unknown[]
    ) {
      if (this.name === TIMELINE_CHUNKS_STORE && value && typeof value === "object") {
        writtenChunkSeqs.push((value as { seq: number }).seq);
      }
      return origPut.apply(this, [value, ...rest] as Parameters<IDBObjectStore["put"]>);
    });

    // Sync appends 1 event -> tail chunk 1 has 50 events, so new chunk seq=2 is written; seq 0 & 1 are untouched
    await client.retainSync({
      result: {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-2",
          rooms: {
            join: {
              "!r1:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      event_id: "$e100",
                      sender: "@bot:example.com",
                      origin_server_ts: 3000,
                      content: { msgtype: "m.text", body: "sync-new" },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      incremental: true,
    });
    expect(writtenChunkSeqs).toEqual([2]);

    // Enqueue + confirm only updates chunk 2
    writtenChunkSeqs.length = 0;
    const pending = await client.enqueueRoomEvent("!r1:example.com", "m.room.message", {
      msgtype: "m.text",
      body: "local-msg",
    });
    expect(writtenChunkSeqs).toEqual([2]);

    writtenChunkSeqs.length = 0;
    await client.confirmSentRoomEvent("!r1:example.com", pending.txnId, "$e101");
    expect(writtenChunkSeqs).toEqual([2]);

    putSpy.mockRestore();
    const snap = await loadV2Snapshot();
    expect(snap.timelines["!r1:example.com"]).toHaveLength(102);
  });

  test("applyBackfillPage prepends new historical chunks without rewriting newer chunks", async () => {
    const events100 = Array.from({ length: 100 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$e${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 5000 + i * 10,
      content: { msgtype: "m.text", body: `msg-${i}` },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [],
          timelineEvents: events100,
          backwardToken: "prev-1",
        },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();
    // Load local cold chunk 0 first
    expect(await client.loadNextOlderLocalChunk("!r1:example.com")).toBe(TIMELINE_CHUNK_SIZE);
    expect(client.hasOlderLocalChunks("!r1:example.com")).toBe(false);

    const writtenChunkSeqs: number[] = [];
    const origPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      ...rest: unknown[]
    ) {
      if (this.name === TIMELINE_CHUNKS_STORE && value && typeof value === "object") {
        writtenChunkSeqs.push((value as { seq: number }).seq);
      }
      return origPut.apply(this, [value, ...rest] as Parameters<IDBObjectStore["put"]>);
    });

    const older50 = Array.from({ length: 50 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$old-${49 - i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1000 + (49 - i) * 10,
      content: { msgtype: "m.text", body: `old-${49 - i}` },
    }));

    const outcome = await client.applyBackfillPage("!r1:example.com", {
      fromToken: "prev-1",
      body: { chunk: older50, end: "prev-2" },
    });
    expect(outcome.prependedCount).toBe(50);
    expect(writtenChunkSeqs).toEqual([-1]);

    const snap = await loadV2Snapshot();
    expect(snap.timelines["!r1:example.com"]).toHaveLength(150);
    expect(snap.timelines["!r1:example.com"]![0]!.event_id).toBe("$old-0");
    expect(snap.timelines["!r1:example.com"]![149]!.event_id).toBe("$e99");
  });

  test("hot-window hydration, cold read-position unread resolution, cold chunk loading, and unloading", async () => {
    const r1Events = Array.from({ length: 120 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$r1-${i}`,
      sender: i === 11 ? "@bot:example.com" : "@alice:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `r1-${i}` },
    }));
    // Notice in r1: $r1-10 is readPositionEventId (chunk 0), $r1-11 is Agent message (chunk 0), hot chunk 2 ($r1-70..$r1-119) has only Owner messages!
    const r2Events = Array.from({ length: 60 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$r2-${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 5000 + i * 10,
      content: { msgtype: "m.text", body: `r2-${i}` },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: {
        "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] },
      },
      rooms: {
        "!r1:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 100, content: {} },
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
            { type: "m.room.name", state_key: "", content: { name: "冷块未读话题" } },
          ],
          timelineEvents: r1Events,
          readPositionEventId: "$r1-10",
        },
        "!r2:example.com": {
          stateEvents: [
            { type: "m.room.create", state_key: "", origin_server_ts: 200, content: {} },
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
            { type: "m.room.name", state_key: "", content: { name: "已读话题" } },
          ],
          timelineEvents: r2Events,
          readPositionEventId: "$r2-59",
        },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();

    const rooms = client.rooms();
    expect(rooms["!r1:example.com"]!.timelineEvents).toHaveLength(TIMELINE_CHUNK_SIZE);
    expect(rooms["!r1:example.com"]!.hasOlderLocalChunks).toBe(true);
    expect(rooms["!r2:example.com"]!.timelineEvents).toHaveLength(TIMELINE_CHUNK_SIZE);
    expect(rooms["!r2:example.com"]!.hasOlderLocalChunks).toBe(true);

    const topics = deriveTopics(
      rooms,
      [{ userId: "@bot:example.com" }],
      "@alice:example.com",
      client.pendingRoomEvents(),
    );
    expect(topics[0]!.roomId).toBe("!r2:example.com");
    expect(topics[0]!.unread).toBe(false);
    expect(topics[0]!.lastActivityTs).toBe(5000 + 59 * 10);

    expect(topics[1]!.roomId).toBe("!r1:example.com");
    expect(topics[1]!.unread).toBe(true);
    expect(topics[1]!.readPositionUnknown).toBe(false);
    expect(topics[1]!.needsReadGapBackfill).toBe(true);
    expect(topics[1]!.lastActivityTs).toBe(1000 + 119 * 10);

    // Load cold chunks for read position -> brings all 120 events into memory
    await client.loadLocalChunksForReadPosition("!r1:example.com");
    expect(client.rooms()["!r1:example.com"]!.timelineEvents).toHaveLength(120);
    expect(client.hasOlderLocalChunks("!r1:example.com")).toBe(false);

    // Unload cold chunks on topic switch -> trims back to hot window while keeping all 120 on disk
    const unloaded = await client.unloadColdChunks("!r1:example.com");
    expect(unloaded).toBe(true);
    expect(client.rooms()["!r1:example.com"]!.timelineEvents).toHaveLength(TIMELINE_CHUNK_SIZE);
    expect(client.rooms()["!r1:example.com"]!.hasOlderLocalChunks).toBe(true);

    const topicsAfterUnload = deriveTopics(
      client.rooms(),
      [{ userId: "@bot:example.com" }],
      "@alice:example.com",
      client.pendingRoomEvents(),
    );
    const r1Summary = topicsAfterUnload.find((t) => t.roomId === "!r1:example.com")!;
    expect(r1Summary.unread).toBe(true);
    expect(r1Summary.firstUnreadEventId).toBe("$r1-11");

    const diskSnap = await loadV2Snapshot();
    expect(diskSnap.timelines["!r1:example.com"]).toHaveLength(120);
  });

  test("cross-chunk m.room.redaction in retainSync updates unloaded cold chunks on disk", async () => {
    const events120 = Array.from({ length: 120 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$e${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `msg-${i}` },
    }));
    // Put a prompt selector reaction in cold chunk 0 targeting $e4
    events120.splice(6, 0, {
      type: "m.reaction",
      event_id: "$react-cold",
      sender: "@bot:example.com",
      origin_server_ts: 1055,
      content: {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$e4", key: "1️⃣" },
      },
    } as never);

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [],
          timelineEvents: events120,
          readPositionEventId: "$e119",
        },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();
    expect(client.rooms()["!r1:example.com"]!.timelineEvents).toHaveLength(TIMELINE_CHUNK_SIZE);

    await client.retainSync({
      result: {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-2",
          rooms: {
            join: {
              "!r1:example.com": {
                timeline: {
                  events: [
                    { type: "m.room.redaction", event_id: "$red-1", redacts: "$e5", sender: "@bot:example.com" },
                    { type: "m.room.redaction", event_id: "$red-2", redacts: "$react-cold", sender: "@bot:example.com" },
                  ],
                },
              },
            },
          },
        },
      },
      incremental: true,
    });

    const snap = await loadV2Snapshot();
    const diskEvents = snap.timelines["!r1:example.com"]!;
    expect(diskEvents.some((ev) => ev.event_id === "$e5")).toBe(false);
    const preservedReact = diskEvents.find((ev) => ev.event_id === "$react-cold");
    expect(preservedReact).toBeDefined();
    expect((preservedReact!.unsigned as Record<string, unknown>)?.redacted_because).toBeDefined();
  });

  test("restore() stops cold-chunk unread scanning early and skips cold chunks when hot window suffices", async () => {
    // 200 events -> 4 chunks (seq 0..3, 50 events each)
    const rHotRead = Array.from({ length: 200 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$hr-${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `hr-${i}` },
    }));
    const rColdUnreadStop = Array.from({ length: 200 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$cu-${i}`,
      // Put the only Agent message in chunk 2 (index 110); chunk 3 (150..199) is Owner only; readPos is $cu-10 in chunk 0
      sender: i === 110 ? "@bot:example.com" : "@alice:example.com",
      origin_server_ts: 2000 + i * 10,
      content: { msgtype: "m.text", body: `cu-${i}` },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      accountData: {
        "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] },
      },
      rooms: {
        "!r-hot:example.com": {
          stateEvents: [
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
          ],
          timelineEvents: rHotRead,
          readPositionEventId: "$hr-199",
        },
        "!r-stop:example.com": {
          stateEvents: [
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
          ],
          timelineEvents: rColdUnreadStop,
          readPositionEventId: "$cu-10",
        },
      },
    });

    const readChunkKeys: Array<[string, number]> = [];
    const origOpenCursor = IDBObjectStore.prototype.openCursor;
    const cursorSpy = vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["openCursor"]>
    ) {
      const req = origOpenCursor.apply(this, args);
      if (this.name === TIMELINE_CHUNKS_STORE) {
        const origSet = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")?.set;
        req.addEventListener("success", () => {
          const val = req.result?.value as { roomId?: string; seq?: number } | undefined;
          if (val?.roomId && typeof val.seq === "number") {
            readChunkKeys.push([val.roomId, val.seq]);
          }
        });
        void origSet;
      }
      return req;
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();
    cursorSpy.mockRestore();

    // !r-hot read ONLY chunk 3 (seq 3); !r-stop read chunk 3 (hot) and chunk 2 (cold) and stopped without reading seq 0 or 1
    expect(readChunkKeys.filter(([r]) => r === "!r-hot:example.com").map(([, s]) => s)).toEqual([3]);
    expect(readChunkKeys.filter(([r]) => r === "!r-stop:example.com").map(([, s]) => s)).toEqual([3, 2]);

    const topics = deriveTopics(client.rooms(), [{ userId: "@bot:example.com" }], "@alice:example.com");
    expect(topics.find((t) => t.roomId === "!r-hot:example.com")?.unread).toBe(false);
    expect(topics.find((t) => t.roomId === "!r-stop:example.com")?.unread).toBe(true);
  });

  test("applyBackfillPage splits mid-timeline limited gap without rewriting unrelated chunks", async () => {
    const events100 = Array.from({ length: 100 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$e${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `msg-${i}` },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [],
          timelineEvents: events100,
          reachedStart: true,
          timelineGaps: [
            { limited: true, prevBatch: "gap-mid", gapBeforeEventId: "$e55" },
          ],
        },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();
    await client.loadNextOlderLocalChunk("!r1:example.com");

    const writtenSeqs: number[] = [];
    const origPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      ...rest: unknown[]
    ) {
      if (this.name === TIMELINE_CHUNKS_STORE && value && typeof value === "object") {
        writtenSeqs.push((value as { seq: number }).seq);
      }
      return origPut.apply(this, [value, ...rest] as Parameters<IDBObjectStore["put"]>);
    });

    const gapFill = Array.from({ length: 30 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$gap-${29 - i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1545,
      content: { msgtype: "m.text", body: `gap-${29 - i}` },
    }));

    const outcome = await client.applyBackfillPage("!r1:example.com", {
      fromToken: "gap-mid",
      gapIndex: 0,
      body: { chunk: gapFill, end: "" },
    });
    expect(outcome.prependedCount).toBe(30);
    // Chunk 0 ($e0..$e49) must NOT be rewritten; only the split target chunk (seq >= 1) is written
    expect(writtenSeqs.every((s) => s >= 1)).toBe(true);

    const snap = await loadV2Snapshot();
    const ids = snap.timelines["!r1:example.com"]!.map((e) => e.event_id);
    expect(ids).toHaveLength(130);
    const idx54 = ids.indexOf("$e54");
    const idxGap0 = ids.indexOf("$gap-0");
    const idxGap29 = ids.indexOf("$gap-29");
    const idx55 = ids.indexOf("$e55");
    expect(idx54).toBe(54);
    expect(idxGap0).toBe(55);
    expect(idxGap29).toBe(84);
    expect(idx55).toBe(85);
  });

  test("confirmSentRoomEvent on cold placeholder and applyBackfillPage refresh coldLatestPreview", async () => {
    const olderMsg = {
      type: "m.room.message",
      event_id: "$cold-msg",
      sender: "@bot:example.com",
      origin_server_ts: 1000,
      content: { msgtype: "m.text", body: "冷块旧消息" },
    };
    const coldPlaceholder = {
      type: "m.room.message",
      sender: "@alice:example.com",
      content: { msgtype: "m.text", body: "冷占位消息" },
      waypoint_local: { id: "loc-cold", status: "unconfirmed", txnId: "txn-cold" },
    };
    const fillerReactions = Array.from({ length: 147 }, (_, i) => ({
      type: "m.reaction",
      event_id: `$r-${i}`,
      sender: "@alice:example.com",
      origin_server_ts: 2000 + i,
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$cold-msg", key: `k${i}` } },
    }));

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
          ],
          timelineEvents: [olderMsg, coldPlaceholder, ...fillerReactions],
          timelineGaps: [
            { limited: true, prevBatch: "gap-hot", gapBeforeEventId: "$r-146" },
          ],
        },
      },
    });

    const client = new MatrixClient(noopTransport());
    await client.restore();

    // Confirming the cold placeholder removes it from coldPlaceholders; hot chunk still has only reactions
    await client.confirmSentRoomEvent("!r1:example.com", "txn-cold", "$confirmed-cold");
    const afterConfirm = client.rooms()["!r1:example.com"]!;
    expect(afterConfirm.hasOlderLocalChunks).toBe(true);
    expect(afterConfirm.coldLatestPreview).toBe("冷占位消息");

    // Load chunk 1 (reactions only) so chunk 0 stays unloaded and chunk 2 split preserves seq > chunkMinSeq
    await client.loadNextOlderLocalChunk("!r1:example.com");
    expect(client.rooms()["!r1:example.com"]!.coldLatestPreview).toBe("冷占位消息");

    // Backfilling a message into the hot gap populates the loaded timeline and clears stale coldLatestPreview
    await client.applyBackfillPage("!r1:example.com", {
      fromToken: "gap-hot",
      gapIndex: 0,
      body: {
        chunk: [
          {
            type: "m.room.message",
            event_id: "$gap-msg",
            sender: "@bot:example.com",
            origin_server_ts: 1999,
            content: { msgtype: "m.text", body: "回填进热窗口的消息" },
          },
        ],
        end: "older-tok",
      },
    });
    const afterBackfill = client.rooms()["!r1:example.com"]!;
    expect(afterBackfill.hasOlderLocalChunks).toBe(true);
    expect(afterBackfill.coldLatestPreview).toBeUndefined();
  });
});

describe("MatrixClient message redaction and room favorites persistence", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("redactRoomEvent sends PUT redact request and applyConfirmedRedaction removes event, updates readPosition, prunes favorite, and persists", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const transport: HomeserverTransport = {
      request: async (req) => {
        requests.push({ method: req.method, url: req.url, body: req.body });
        return { type: "response", status: 200, body: { event_id: "$red-confirm" } };
      },
    };

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
          ],
          timelineEvents: [
            {
              type: "m.room.message",
              event_id: "$m1",
              sender: "@alice:example.com",
              origin_server_ts: 1000,
              content: { msgtype: "m.text", body: "第一条" },
            },
            {
              type: "m.room.message",
              event_id: "$m2",
              sender: "@bot:example.com",
              origin_server_ts: 2000,
              content: { msgtype: "m.text", body: "第二条" },
            },
          ],
          readPositionEventId: "$m2",
          favorites: [
            { eventId: "$m1", favoritedAt: 100, senderSide: "right", preview: "第一条", ts: 1000 },
            { eventId: "$m2", favoritedAt: 200, senderSide: "left", preview: "第二条", ts: 2000 },
          ],
        },
      },
    });

    const client = new MatrixClient(transport);
    await client.restore();

    const res = await client.redactRoomEvent("!r1:example.com", "$m2", "txn-red-1");
    expect(res).toEqual({ type: "response", status: 200, body: { event_id: "$red-confirm" } });
    expect(requests).toEqual([
      {
        method: "PUT",
        url: "https://matrix.example.com/_matrix/client/v3/rooms/!r1%3Aexample.com/redact/%24m2/txn-red-1",
        body: {},
      },
    ]);

    await client.applyConfirmedRedaction("!r1:example.com", "$m2", "$red-confirm");

    const room = client.rooms()["!r1:example.com"]!;
    expect(room.timelineEvents.map((ev) => ev.event_id)).toEqual(["$m1"]);
    expect(room.readPositionEventId).toBe("$m1");
    expect(room.favorites?.map((f) => f.eventId)).toEqual(["$m1"]);

    // Verify persisted to IndexedDB across restore
    const restored = new MatrixClient(noopTransport());
    await restored.restore();
    const restoredRoom = restored.rooms()["!r1:example.com"]!;
    expect(restoredRoom.timelineEvents.map((ev) => ev.event_id)).toEqual(["$m1"]);
    expect(restoredRoom.readPositionEventId).toBe("$m1");
    expect(restoredRoom.favorites?.map((f) => f.eventId)).toEqual(["$m1"]);
  });

  test("putRoomAccountData + retainRoomFavorites persist, sync im.waypoint.favorites respects favoriteGeneration lock, and incoming redactions prune favorites", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const transport: HomeserverTransport = {
      request: async (req) => {
        requests.push({ method: req.method, url: req.url, body: req.body });
        if (req.url.includes("/_matrix/client/v3/sync")) {
          return {
            type: "response",
            status: 200,
            body: {
              next_batch: "batch-2",
              rooms: {
                join: {
                  "!r1:example.com": {
                    account_data: {
                      events: [
                        {
                          type: "im.waypoint.favorites",
                          content: {
                            v: 1,
                            favorites: [
                              { eventId: "$m1", favoritedAt: 100, senderSide: "right", preview: "第一条", ts: 1000 },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        }
        return { type: "response", status: 200, body: {} };
      },
    };

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [
            { type: "im.waypoint.topic", state_key: "", content: { v: 1, agent_user_id: "@bot:example.com" } },
          ],
          timelineEvents: [
            {
              type: "m.room.message",
              event_id: "$m1",
              sender: "@alice:example.com",
              origin_server_ts: 1000,
              content: { msgtype: "m.text", body: "第一条" },
            },
            {
              type: "m.room.message",
              event_id: "$m2",
              sender: "@bot:example.com",
              origin_server_ts: 2000,
              content: { msgtype: "m.text", body: "第二条" },
            },
          ],
        },
      },
    });

    const client = new MatrixClient(transport);
    await client.restore();

    // Start sync before local favorite write completes
    const attempt = await client.sync();

    const favs = [{ eventId: "$m2", favoritedAt: 500, senderSide: "left" as const, preview: "第二条", ts: 2000 }];
    const putRes = await client.putRoomAccountData("!r1:example.com", "im.waypoint.favorites", {
      v: 1,
      favorites: favs,
    });
    expect(putRes.type).toBe("response");
    expect(requests.some((r) =>
      r.method === "PUT" &&
      r.url === "https://matrix.example.com/_matrix/client/v3/user/%40alice%3Aexample.com/rooms/!r1%3Aexample.com/account_data/im.waypoint.favorites",
    )).toBe(true);

    await client.retainRoomFavorites("!r1:example.com", favs);
    // In-flight sync must not clobber newer local favorite
    await client.retainSync(attempt);
    expect(client.rooms()["!r1:example.com"]!.favorites?.map((f) => f.eventId)).toEqual(["$m2"]);

    // Subsequent sync updates favorites and prunes any target redacted in the same sync
    await client.retainSync({
      result: {
        type: "response",
        status: 200,
        body: {
          next_batch: "batch-3",
          rooms: {
            join: {
              "!r1:example.com": {
                timeline: {
                  events: [{ type: "m.room.redaction", redacts: "$m2", event_id: "$red2", sender: "@alice:example.com" }],
                },
                account_data: {
                  events: [
                    {
                      type: "im.waypoint.favorites",
                      content: {
                        v: 1,
                        favorites: [
                          { eventId: "$m1", favoritedAt: 100 },
                          { eventId: "$m2", favoritedAt: 500 },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      incremental: true,
      leaveGeneration: client.currentLeaveGeneration,
      tagGeneration: client.currentTagGeneration,
      favoriteGeneration: client.currentFavoriteGeneration,
    });

    expect(client.rooms()["!r1:example.com"]!.favorites?.map((f) => f.eventId)).toEqual(["$m1"]);

    const restored = new MatrixClient(noopTransport());
    await restored.restore();
    expect(restored.rooms()["!r1:example.com"]!.favorites?.map((f) => f.eventId)).toEqual(["$m1"]);
  });
});
