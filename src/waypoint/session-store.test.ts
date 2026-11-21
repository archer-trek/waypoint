import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BLOBS_STORE,
  DB_NAME,
  DB_VERSION,
  DRAFTS_STORE,
  LEGACY_STORE,
  META_STORE,
  PENDING_EVENTS_STORE,
  PENDING_READ_MARKERS_STORE,
  ROOMS_STORE,
  LEGACY_TIMELINES_STORE,
  TIMELINE_CHUNKS_STORE,
  TIMELINE_CHUNK_SIZE,
  deleteLocalDatabase,
  dropCredential,
  dropPreListSession,
  loadBlob,
  loadSession,
  loadStartupSnapshot,
  loadTimelineChunksBefore,
  loadV2Snapshot,
  scanRoomChunksBackward,
  pruneOrphanBlobs,
  saveDraftInStore,
  saveMeta,
  saveRoomMeta,
  saveRoomMetaAndReadMarker,
  saveSession,
} from "./session-store";

async function createV1Database(sessionData: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE)) {
        db.createObjectStore(LEGACY_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(LEGACY_STORE, "readwrite");
      tx.objectStore(LEGACY_STORE).put(sessionData, "session");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

async function inspectRawDb(): Promise<{
  version: number;
  storeNames: string[];
  records: Record<string, unknown[]>;
  keys: Record<string, IDBValidKey[]>;
}> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = async () => {
      const db = req.result;
      const storeNames = Array.from(db.objectStoreNames).sort();
      const records: Record<string, unknown[]> = {};
      const keys: Record<string, IDBValidKey[]> = {};
      if (storeNames.length > 0) {
        const tx = db.transaction(storeNames, "readonly");
        for (const name of storeNames) {
          const store = tx.objectStore(name);
          const [vals, ks] = await Promise.all([
            new Promise<unknown[]>((res, rej) => {
              const r = store.getAll();
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            }),
            new Promise<IDBValidKey[]>((res, rej) => {
              const r = store.getAllKeys();
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            }),
          ]);
          records[name] = vals;
          keys[name] = ks;
        }
      }
      const version = db.version;
      db.close();
      resolve({ version, storeNames, records, keys });
    };
    req.onerror = () => reject(req.error);
  });
}


async function createV2Database(input: {
  meta: Record<string, unknown>;
  rooms: Record<string, Record<string, unknown>>;
  timelines: Record<string, unknown>;
  drafts?: Record<string, unknown>;
  pendingEvents?: Array<Record<string, unknown>>;
  pendingReadMarkers?: Array<Record<string, unknown>>;
  blobs?: Array<Record<string, unknown>>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(META_STORE);
      db.createObjectStore(ROOMS_STORE);
      db.createObjectStore(LEGACY_TIMELINES_STORE);
      db.createObjectStore(DRAFTS_STORE);
      const pending = db.createObjectStore(PENDING_EVENTS_STORE, { keyPath: "txnId" });
      pending.createIndex("roomId", "roomId", { unique: false });
      db.createObjectStore(PENDING_READ_MARKERS_STORE, { keyPath: "roomId" });
      db.createObjectStore(BLOBS_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(
        [
          META_STORE,
          ROOMS_STORE,
          LEGACY_TIMELINES_STORE,
          DRAFTS_STORE,
          PENDING_EVENTS_STORE,
          PENDING_READ_MARKERS_STORE,
          BLOBS_STORE,
        ],
        "readwrite",
      );
      tx.objectStore(META_STORE).put(input.meta, "session");
      for (const [roomId, roomMeta] of Object.entries(input.rooms)) {
        tx.objectStore(ROOMS_STORE).put(roomMeta, roomId);
      }
      for (const [roomId, timeline] of Object.entries(input.timelines)) {
        tx.objectStore(LEGACY_TIMELINES_STORE).put(timeline, roomId);
      }
      for (const [roomId, draft] of Object.entries(input.drafts ?? {})) {
        tx.objectStore(DRAFTS_STORE).put(draft, roomId);
      }
      for (const pending of input.pendingEvents ?? []) {
        tx.objectStore(PENDING_EVENTS_STORE).put(pending);
      }
      for (const marker of input.pendingReadMarkers ?? []) {
        tx.objectStore(PENDING_READ_MARKERS_STORE).put(marker);
      }
      for (const blob of input.blobs ?? []) {
        tx.objectStore(BLOBS_STORE).put(blob);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

describe("session-store v3", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("fresh database creates all 7 v3 object stores and indexes", async () => {
    await saveMeta({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
    });

    const raw = await inspectRawDb();
    expect(raw.version).toBe(DB_VERSION);
    expect(raw.storeNames).toEqual([
      BLOBS_STORE,
      DRAFTS_STORE,
      META_STORE,
      PENDING_EVENTS_STORE,
      PENDING_READ_MARKERS_STORE,
      ROOMS_STORE,
      TIMELINE_CHUNKS_STORE,
    ]);
  });

  test("losslessly migrates v1 records['session'] to v2 stores, deduplicates shared attachment bytes, and drops legacy records store", async () => {
    const sharedBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const draftBytes = new Uint8Array([99, 98, 97]);

    await createV1Database({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-v1",
      deviceId: "DEV-V1",
      syncCursor: "batch-v1",
      accountData: {
        "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] },
      },
      rooms: {
        "!r1:example.com": {
          stateEvents: [
            { type: "m.room.name", state_key: "", content: { name: "迁移话题" } },
          ],
          timelineEvents: [
            {
              type: "m.room.message",
              event_id: "$e1",
              sender: "@bot:example.com",
              content: { msgtype: "m.text", body: "hello" },
            },
            {
              type: "m.room.message",
              sender: "@alice:example.com",
              content: { msgtype: "m.image", body: "photo.png" },
              waypoint_local: {
                id: "local-1",
                status: "unconfirmed",
                txnId: "txn-1",
                attachment: {
                  name: "photo.png",
                  mimeType: "image/png",
                  size: sharedBytes.byteLength,
                  data: new Uint8Array(sharedBytes),
                },
              },
            },
          ],
          readPositionEventId: "$e1",
          fullyReadEventId: "$e1",
          privateReadEventId: "$e1",
          backwardToken: "prev-1",
          tags: { "im.waypoint.pinned": { order: 0 } },
        },
        "!r2:example.com": {
          stateEvents: [],
          timelineEvents: [],
          reachedStart: true,
          encryptedIrreversible: true,
          inviteFailed: true,
        },
      },
      pendingEvents: [
        {
          txnId: "txn-1",
          roomId: "!r1:example.com",
          type: "m.room.message",
          sender: "@alice:example.com",
          content: { msgtype: "m.image", body: "photo.png" },
          attachment: {
            name: "photo.png",
            mimeType: "image/png",
            size: sharedBytes.byteLength,
            data: new Uint8Array(sharedBytes),
          },
        },
      ],
      pendingReadMarkers: [{ roomId: "!r1:example.com", eventId: "$e1" }],
      drafts: {
        "!r2:example.com": {
          text: "草稿文本",
          attachment: {
            name: "note.txt",
            mimeType: "text/plain",
            size: draftBytes.byteLength,
            data: draftBytes,
          },
        },
      },
    });

    const snapshot = await loadV2Snapshot();
    expect(snapshot.meta).toEqual({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-v1",
      deviceId: "DEV-V1",
      syncCursor: "batch-v1",
      accountData: {
        "im.waypoint.agents": { agents: [{ user_id: "@bot:example.com" }] },
      },
    });
    expect(snapshot.rooms["!r1:example.com"]).toMatchObject({
      readPositionEventId: "$e1",
      backwardToken: "prev-1",
      tags: { "im.waypoint.pinned": { order: 0 } },
    });
    expect(snapshot.rooms["!r2:example.com"]).toMatchObject({
      reachedStart: true,
      encryptedIrreversible: true,
      inviteFailed: true,
    });

    // Pending event & timeline placeholder share the exact same attachmentId without Uint8Array bytes
    expect(snapshot.pendingEvents).toHaveLength(1);
    const pendingAttId = snapshot.pendingEvents[0]!.attachmentId!;
    expect(pendingAttId).toBeTruthy();
    expect(snapshot.pendingEvents[0]!.attachment).toBeUndefined();
    expect(snapshot.pendingEvents[0]!.attachmentMeta).toEqual({
      name: "photo.png",
      mimeType: "image/png",
      size: sharedBytes.byteLength,
    });

    const placeholderLocal = snapshot.timelines["!r1:example.com"]![1]!.waypoint_local as Record<
      string,
      unknown
    >;
    expect(placeholderLocal.attachmentId).toBe(pendingAttId);
    expect(placeholderLocal.attachment).toBeUndefined();

    // Draft also decoupled into attachmentId + attachmentMeta
    const draftAttId = snapshot.drafts["!r2:example.com"]!.attachmentId!;
    expect(draftAttId).toBeTruthy();
    expect(draftAttId).not.toBe(pendingAttId);
    expect(snapshot.drafts["!r2:example.com"]!.attachment).toBeUndefined();

    // Blobs store has exactly 2 deduplicated blobs, and legacy records store is gone
    const raw = await inspectRawDb();
    expect(raw.version).toBe(3);
    expect(raw.storeNames).not.toContain(LEGACY_STORE);
    expect(raw.storeNames).not.toContain(LEGACY_TIMELINES_STORE);
    expect(raw.records[BLOBS_STORE]).toHaveLength(2);

    const loadedShared = await loadBlob(pendingAttId);
    expect(Array.from(loadedShared!.data)).toEqual(Array.from(sharedBytes));
    const loadedDraft = await loadBlob(draftAttId);
    expect(Array.from(loadedDraft!.data)).toEqual(Array.from(draftBytes));

    // Compatibility facade loadSession() still returns hydrated SessionRecord
    const compat = await loadSession();
    expect(compat?.pendingEvents?.[0]?.attachment?.data).toEqual(sharedBytes);
    expect(compat?.drafts?.["!r2:example.com"]?.attachment?.data).toEqual(draftBytes);
  });

  test("v1 -> v2 migration aborts and rolls back cleanly to v1 on failure", async () => {
    await createV1Database({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-v1",
      deviceId: "DEV-V1",
    });

    const origPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === META_STORE) {
        throw new DOMException("Simulated quota error", "QuotaExceededError");
      }
      return origPut.apply(this, args);
    });

    await expect(loadV2Snapshot()).rejects.toThrow();

    vi.restoreAllMocks();
    const raw = await inspectRawDb();
    expect(raw.version).toBe(1);
    expect(raw.storeNames).toEqual([LEGACY_STORE]);
    expect(raw.records[LEGACY_STORE]).toHaveLength(1);
    expect((raw.records[LEGACY_STORE]![0] as Record<string, unknown>).accessToken).toBe("tok-v1");
  });

  test("caches IDBDatabase per IDBFactory in WeakMap, handles onversionchange, and reconnects on closed connection", async () => {
    const factoryA = globalThis.indexedDB;
    const openSpyA = vi.spyOn(factoryA, "open");

    await saveMeta({
      baseUrl: "https://a.example.com",
      userId: "@a:example.com",
      accessToken: "tok-a",
      deviceId: "DEVA",
    });
    await loadV2Snapshot();
    await loadV2Snapshot();
    expect(openSpyA).toHaveBeenCalledTimes(1);

    // Swapping globalThis.indexedDB isolates connections completely
    const factoryB = new IDBFactory();
    globalThis.indexedDB = factoryB;
    const openSpyB = vi.spyOn(factoryB, "open");
    await saveMeta({
      baseUrl: "https://b.example.com",
      userId: "@b:example.com",
      accessToken: "tok-b",
      deviceId: "DEVB",
    });
    expect(openSpyB).toHaveBeenCalledTimes(1);
    expect((await loadV2Snapshot()).meta?.baseUrl).toBe("https://b.example.com");

    // Switching back to factoryA still reuses factoryA's cached connection
    globalThis.indexedDB = factoryA;
    expect((await loadV2Snapshot()).meta?.baseUrl).toBe("https://a.example.com");
    expect(openSpyA).toHaveBeenCalledTimes(1);

    // Simulating versionchange / external close triggers clean reconnect on next operation
    const dbFromSpy = (openSpyA.mock.results[0]?.value as IDBOpenDBRequest).result;
    dbFromSpy.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);

    expect((await loadV2Snapshot()).meta?.baseUrl).toBe("https://a.example.com");
    expect(openSpyA).toHaveBeenCalledTimes(2);
  });

  test("read position, tag, dropCredential, and dropPreListSession only touch their target stores", async () => {
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      syncCursor: "batch-1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [],
          timelineEvents: [
            { type: "m.room.message", event_id: "$e1", sender: "@bot:example.com", content: { body: "hi" } },
          ],
        },
      },
      drafts: {
        "!r1:example.com": { text: "keep draft" },
      },
    });

    const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction");

    await saveRoomMetaAndReadMarker(
      "!r1:example.com",
      { stateEvents: [], readPositionEventId: "$e1" },
      { roomId: "!r1:example.com", eventId: "$e1" },
    );
    expect(txSpy).toHaveBeenLastCalledWith([ROOMS_STORE, PENDING_READ_MARKERS_STORE], "readwrite");

    await saveRoomMeta("!r1:example.com", {
      stateEvents: [],
      readPositionEventId: "$e1",
      tags: { "im.waypoint.pinned": { order: 0 } },
    });
    expect(txSpy).toHaveBeenLastCalledWith(ROOMS_STORE, "readwrite");

    await dropCredential();
    expect(txSpy).toHaveBeenLastCalledWith(META_STORE, "readwrite");
    const afterDropCred = await loadV2Snapshot();
    expect(afterDropCred.meta?.accessToken).toBeUndefined();
    expect(afterDropCred.drafts["!r1:example.com"]?.text).toBe("keep draft");
    expect(afterDropCred.timelines["!r1:example.com"]).toHaveLength(1);

    await dropPreListSession();
    const afterExit = await loadV2Snapshot();
    expect(afterExit.meta).toEqual({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
    });
    expect(afterExit.rooms).toEqual({});
    expect(afterExit.timelines).toEqual({});
    expect(afterExit.drafts).toEqual({});
  });

  test("pruneOrphanBlobs removes unreferenced blobs while preserving referenced ones", async () => {
    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      drafts: {
        "!r1:example.com": {
          attachment: {
            name: "keep.bin",
            mimeType: "application/octet-stream",
            size: 2,
            data: new Uint8Array([1, 2]),
          },
        },
      },
    });
    const snapshot = await loadV2Snapshot();
    const keepId = snapshot.drafts["!r1:example.com"]!.attachmentId!;

    // Inject an orphan blob directly into blobs store
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(BLOBS_STORE, "readwrite");
        tx.objectStore(BLOBS_STORE).put({
          id: "orphan-blob-1",
          name: "orphan.bin",
          mimeType: "application/octet-stream",
          size: 3,
          data: new Uint8Array([9, 9, 9]),
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
      req.onerror = () => reject(req.error);
    });

    await pruneOrphanBlobs(new Set([keepId]));
    expect(await loadBlob(keepId)).toBeDefined();
    expect(await loadBlob("orphan-blob-1")).toBeUndefined();
  });

  test("deleteLocalDatabase deletes the database and rejects after 5s timeout if blocked", async () => {
    await saveMeta({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
    });
    await deleteLocalDatabase();
    const snap = await loadV2Snapshot();
    expect(snap.meta).toBeUndefined();

    // Timeout test when deleteDatabase never completes
    vi.useFakeTimers();
    vi.spyOn(globalThis.indexedDB, "deleteDatabase").mockImplementation(
      () => ({} as IDBOpenDBRequest),
    );
    const pendingDelete = deleteLocalDatabase(5000);
    const assertion = expect(pendingDelete).rejects.toThrow("重置本地数据超时");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  test("saveDraftInStore calls tx.commit() when commit option is true", async () => {
    await saveMeta({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
    });

    const commitSpy = vi.spyOn(IDBTransaction.prototype, "commit");

    await saveDraftInStore({
      roomId: "!r1:example.com",
      draft: { text: "debounced" },
    });
    expect(commitSpy).not.toHaveBeenCalled();

    await saveDraftInStore({
      roomId: "!r1:example.com",
      draft: { text: "flushed" },
      commit: true,
    });
    expect(commitSpy).toHaveBeenCalledTimes(1);

    const snap = await loadV2Snapshot();
    expect(snap.drafts["!r1:example.com"]?.text).toBe("flushed");
  });

  test("losslessly migrates v2 timelines to v3 timeline_chunks (~50 events/chunk), populates summary metadata, and drops legacy timelines store", async () => {
    const events125 = Array.from({ length: 125 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$e${i}`,
      sender: i % 2 === 0 ? "@alice:example.com" : "@bot:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `msg-${i}` },
    }));
    const r2Events = [
      {
        type: "m.room.message",
        sender: "@alice:example.com",
        content: { msgtype: "m.file", body: "f.bin" },
        waypoint_local: {
          id: "loc-r2",
          status: "failed",
          txnId: "txn-r2",
          attachmentId: "att-r2",
          attachmentMeta: { name: "f.bin", mimeType: "application/octet-stream", size: 2 },
        },
      },
      {
        type: "m.room.message",
        event_id: "$r2-1",
        sender: "@bot:example.com",
        origin_server_ts: 5000,
        content: { msgtype: "m.text", body: "r2" },
      },
    ];

    await createV2Database({
      meta: {
        baseUrl: "https://matrix.example.com",
        userId: "@alice:example.com",
        accessToken: "tok-v2",
        deviceId: "DEV-V2",
        syncCursor: "batch-v2",
      },
      rooms: {
        "!r1:example.com": {
          stateEvents: [{ type: "m.room.name", state_key: "", content: { name: "长对话" } }],
          readPositionEventId: "$e10",
          backwardToken: "prev-r1",
        },
        "!r2:example.com": {
          stateEvents: [{ type: "m.room.name", state_key: "", content: { name: "带失败消息" } }],
        },
      },
      timelines: {
        "!r1:example.com": { timelineEvents: events125 },
        "!r2:example.com": { timelineEvents: r2Events },
      },
      drafts: {
        "!r1:example.com": { text: "草稿保留" },
      },
      blobs: [
        {
          id: "att-r2",
          name: "f.bin",
          mimeType: "application/octet-stream",
          size: 2,
          data: new Uint8Array([1, 2]),
        },
      ],
    });

    const v2Compat = await loadV2Snapshot();
    expect(v2Compat.timelines["!r1:example.com"]).toHaveLength(125);
    expect(v2Compat.timelines["!r1:example.com"]![0]!.event_id).toBe("$e0");
    expect(v2Compat.timelines["!r1:example.com"]![124]!.event_id).toBe("$e124");
    expect(v2Compat.timelines["!r2:example.com"]).toHaveLength(2);
    expect(v2Compat.drafts["!r1:example.com"]?.text).toBe("草稿保留");

    expect(v2Compat.rooms["!r1:example.com"]).toMatchObject({
      lastActivityTs: 1000 + 124 * 10,
      chunkMinSeq: 0,
      chunkMaxSeq: 2,
      readPositionInLocal: true,
    });
    expect(v2Compat.rooms["!r2:example.com"]).toMatchObject({
      lastActivityTs: 5000,
      chunkMinSeq: 0,
      chunkMaxSeq: 0,
      placeholderChunkSeqs: [0],
    });

    const raw = await inspectRawDb();
    expect(raw.version).toBe(3);
    expect(raw.storeNames).not.toContain(LEGACY_TIMELINES_STORE);
    expect(raw.storeNames).toContain(TIMELINE_CHUNKS_STORE);
    const r1Chunks = (raw.records[TIMELINE_CHUNKS_STORE] as Array<{ roomId: string; seq: number; events: unknown[] }>)
      .filter((c) => c.roomId === "!r1:example.com")
      .sort((a, b) => a.seq - b.seq);
    expect(r1Chunks.map((c) => c.events.length)).toEqual([25, TIMELINE_CHUNK_SIZE, TIMELINE_CHUNK_SIZE]);

    const fullSession = await loadSession();
    expect(fullSession?.rooms?.["!r1:example.com"]?.timelineEvents).toHaveLength(125);
    expect(await loadBlob("att-r2")).toBeDefined();
  });

  test("v2 -> v3 migration aborts and rolls back cleanly to v2 on failure", async () => {
    await createV2Database({
      meta: {
        baseUrl: "https://matrix.example.com",
        userId: "@alice:example.com",
        accessToken: "tok-v2",
        deviceId: "DEV-V2",
      },
      rooms: {
        "!r1:example.com": { stateEvents: [] },
      },
      timelines: {
        "!r1:example.com": {
          timelineEvents: [
            { type: "m.room.message", event_id: "$e1", sender: "@bot:example.com", origin_server_ts: 1000, content: { msgtype: "m.text", body: "keep" } },
          ],
        },
      },
    });

    const origPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === TIMELINE_CHUNKS_STORE) {
        throw new DOMException("Simulated quota error", "QuotaExceededError");
      }
      return origPut.apply(this, args);
    });

    await expect(loadStartupSnapshot()).rejects.toThrow();

    vi.restoreAllMocks();
    const raw = await inspectRawDb();
    expect(raw.version).toBe(2);
    expect(raw.storeNames).toContain(LEGACY_TIMELINES_STORE);
    expect(raw.storeNames).not.toContain(TIMELINE_CHUNKS_STORE);
    expect(raw.records[LEGACY_TIMELINES_STORE]).toHaveLength(1);
  });

  test("loadStartupSnapshot hydrates only hot chunk (~50 events) plus older placeholder chunks without scanning middle cold chunks", async () => {
    const events = Array.from({ length: 130 }, (_, i) => ({
      type: "m.room.message",
      event_id: `$e${i}`,
      sender: "@bot:example.com",
      origin_server_ts: 1000 + i * 10,
      content: { msgtype: "m.text", body: `msg-${i}` },
    }));
    // Insert a failed placeholder in the oldest chunk (index 5)
    events.splice(5, 0, {
      type: "m.room.message",
      event_id: "",
      sender: "@alice:example.com",
      origin_server_ts: 1055,
      content: { msgtype: "m.text", body: "failed-old" },
      waypoint_local: { id: "loc-old", status: "failed", txnId: "txn-old" },
    } as never);

    await saveSession({
      baseUrl: "https://matrix.example.com",
      userId: "@alice:example.com",
      accessToken: "tok-1",
      deviceId: "DEV1",
      rooms: {
        "!r1:example.com": {
          stateEvents: [{ type: "m.room.name", state_key: "", content: { name: "Hot" } }],
          timelineEvents: events,
          readPositionEventId: "$e120",
        },
      },
    });

    const startup = await loadStartupSnapshot();
    const r1 = startup.roomTimelines["!r1:example.com"]!;
    expect(r1.hotChunks).toHaveLength(1);
    expect(r1.hotChunks[0]!.events).toHaveLength(TIMELINE_CHUNK_SIZE);
    expect(r1.hotChunks[0]!.events[0]!.event_id).toBe("$e80");
    expect(r1.hotChunks[0]!.events[49]!.event_id).toBe("$e129");
    expect(r1.coldPlaceholders).toHaveLength(1);
    expect((r1.coldPlaceholders[0]!.event.waypoint_local as Record<string, unknown>).id).toBe("loc-old");
    expect(r1.hasOlderLocalChunks).toBe(true);

    // Load older cold chunks on demand via loadTimelineChunksBefore and scanRoomChunksBackward
    const minHotSeq = r1.hotChunks[0]!.seq;
    const prev1 = await loadTimelineChunksBefore("!r1:example.com", minHotSeq, 1);
    expect(prev1).toHaveLength(1);
    expect(prev1[0]!.events).toHaveLength(TIMELINE_CHUNK_SIZE);
    expect(prev1[0]!.events[0]!.event_id).toBe("$e30");

    const visitedSeqs: number[] = [];
    await scanRoomChunksBackward("!r1:example.com", minHotSeq, (chunk) => {
      visitedSeqs.push(chunk.seq);
      return visitedSeqs.length >= 1 ? "stop" : "continue";
    });
    expect(visitedSeqs).toEqual([prev1[0]!.seq]);
  });
});
