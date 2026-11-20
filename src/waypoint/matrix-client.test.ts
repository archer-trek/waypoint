import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HomeserverTransport } from "../adapters/types";
import { MatrixClient, localPlaceholderOf } from "./matrix-client";
import {
  BLOBS_STORE,
  DB_NAME,
  DB_VERSION,
  DRAFTS_STORE,
  META_STORE,
  PENDING_EVENTS_STORE,
  PENDING_READ_MARKERS_STORE,
  ROOMS_STORE,
  TIMELINES_STORE,
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
    let spy = rejectNextStoreWrite([META_STORE, ROOMS_STORE, TIMELINES_STORE]);
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
    spy = rejectNextStoreWrite([PENDING_EVENTS_STORE, TIMELINES_STORE, DRAFTS_STORE]);
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
});
