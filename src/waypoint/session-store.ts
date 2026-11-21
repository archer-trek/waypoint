export type RawMatrixEvent = Record<string, unknown>;

export type StoredTimelineGap = {
  limited: true;
  prevBatch?: string;
  gapBeforeEventId?: string;
  pendingGapAtEnd?: true;
};

export type ColdUnreadState = {
  unread: boolean;
  firstUnreadEventId?: string;
  readPositionUnknown: boolean;
};

export type StoredRoomMeta = {
  stateEvents: RawMatrixEvent[];
  timelineGap?: StoredTimelineGap;
  timelineGaps?: StoredTimelineGap[];
  backwardToken?: string;
  reachedStart?: boolean;
  readPositionEventId?: string;
  fullyReadEventId?: string;
  privateReadEventId?: string;
  tags?: Record<string, unknown>;
  encryptedIrreversible?: true;
  inviteFailed?: true;
  lastActivityTs?: number;
  chunkMinSeq?: number;
  chunkMaxSeq?: number;
  placeholderChunkSeqs?: number[];
  readPositionInLocal?: boolean;
};

export type StoredRoomEvents = StoredRoomMeta & {
  timelineEvents: RawMatrixEvent[];
  hasOlderLocalChunks?: boolean;
  coldUnreadState?: ColdUnreadState;
};

export type TimelineChunkRecord = {
  roomId: string;
  seq: number;
  events: RawMatrixEvent[];
};

export type ChunkWriteOp = {
  roomId: string;
  putChunks?: TimelineChunkRecord[];
  deleteChunkSeqs?: number[];
};

export type StartupRoomTimeline = {
  hotChunks: TimelineChunkRecord[];
  coldPlaceholders: Array<{ seq: number; event: RawMatrixEvent }>;
  hasOlderLocalChunks: boolean;
};

export type StartupSnapshot = {
  meta?: SessionMeta;
  rooms: Record<string, StoredRoomMeta>;
  roomTimelines: Record<string, StartupRoomTimeline>;
  drafts: Record<string, DraftRecord>;
  pendingEvents: PendingRoomEvent[];
  pendingReadMarkers: PendingReadMarker[];
};

export type AttachmentMeta = {
  name: string;
  mimeType: string;
  size: number;
};

export type BlobRecord = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
};

export type DraftAttachment = {
  name: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
};

export type PendingReadMarker = {
  roomId: string;
  eventId: string;
};

export type PendingRoomEvent = {
  txnId: string;
  roomId: string;
  type: string;
  sender: string;
  content: Record<string, unknown>;
  attachmentId?: string;
  attachmentMeta?: AttachmentMeta;
  attachment?: DraftAttachment;
  order?: number;
};

export type DraftRecord = {
  text?: string;
  attachmentId?: string;
  attachmentMeta?: AttachmentMeta;
  attachment?: DraftAttachment;
};

export type SessionMeta = {
  baseUrl: string;
  userId: string;
  accessToken?: string;
  deviceId?: string;
  syncCursor?: string;
  accountData?: Record<string, unknown>;
};

export type SessionRecord = SessionMeta & {
  rooms?: Record<string, StoredRoomEvents>;
  pendingEvents?: PendingRoomEvent[];
  pendingReadMarkers?: PendingReadMarker[];
  drafts?: Record<string, DraftRecord>;
};

export type V2Snapshot = {
  meta?: SessionMeta;
  rooms: Record<string, StoredRoomMeta>;
  timelines: Record<string, RawMatrixEvent[]>;
  drafts: Record<string, DraftRecord>;
  pendingEvents: PendingRoomEvent[];
  pendingReadMarkers: PendingReadMarker[];
};

export const DB_NAME = "waypoint";
export const DB_VERSION = 3;
export const LEGACY_STORE = "records";
export const LEGACY_TIMELINES_STORE = "timelines";
export const META_STORE = "meta";
export const ROOMS_STORE = "rooms";
export const TIMELINE_CHUNKS_STORE = "timeline_chunks";
export const TIMELINE_CHUNK_SIZE = 50;
export const DRAFTS_STORE = "drafts";
export const PENDING_EVENTS_STORE = "pending_events";
export const PENDING_READ_MARKERS_STORE = "pending_read_markers";
export const BLOBS_STORE = "blobs";

const SESSION_KEY = "session";

const ALL_DOMAIN_STORES = [
  ROOMS_STORE,
  TIMELINE_CHUNKS_STORE,
  DRAFTS_STORE,
  PENDING_EVENTS_STORE,
  PENDING_READ_MARKERS_STORE,
  BLOBS_STORE,
] as const;

const ALL_V3_STORES = [META_STORE, ...ALL_DOMAIN_STORES] as const;

const dbPromiseByFactory = new WeakMap<IDBFactory, Promise<IDBDatabase>>();
const openDbByFactory = new WeakMap<IDBFactory, IDBDatabase>();

let attachmentSeq = 0;

export function generateAttachmentId(): string {
  attachmentSeq += 1;
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `att-${attachmentSeq}-${suffix}`;
}

export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { name?: unknown; code?: unknown; message?: unknown };
  if (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }
  if (err.code === 22 || err.code === 1014) {
    return true;
  }
  if (typeof err.message === "string" && /quota/i.test(err.message)) {
    return true;
  }
  return false;
}

export function splitTimelineEventsIntoChunks(
  roomId: string,
  events: RawMatrixEvent[],
  chunkSize = TIMELINE_CHUNK_SIZE,
): TimelineChunkRecord[] {
  if (events.length === 0) {
    return [];
  }
  const slices: RawMatrixEvent[][] = [];
  for (let end = events.length; end > 0; end -= chunkSize) {
    const start = Math.max(0, end - chunkSize);
    slices.push(events.slice(start, end));
  }
  slices.reverse();
  return slices.map((chunkEvents, seq) => ({
    roomId,
    seq,
    events: chunkEvents,
  }));
}

export function computeLastActivityTs(events: RawMatrixEvent[]): number | undefined {
  const redactedIds = new Set<string>();
  for (const event of events) {
    if (event.type === "m.room.redaction") {
      const target =
        typeof event.redacts === "string" && event.redacts !== ""
          ? event.redacts
          : isPlainObject(event.content) &&
              typeof event.content.redacts === "string" &&
              event.content.redacts !== ""
            ? event.content.redacts
            : undefined;
      if (target) {
        redactedIds.add(target);
      }
    }
    if (isPlainObject(event.unsigned) && isPlainObject(event.unsigned.redacted_because)) {
      if (typeof event.event_id === "string" && event.event_id !== "") {
        redactedIds.add(event.event_id);
      }
    }
  }
  let maxTs: number | undefined;
  for (const event of events) {
    if (typeof event.state_key === "string" || isPlainObject(event.waypoint_local)) {
      continue;
    }
    if (
      (typeof event.event_id === "string" && redactedIds.has(event.event_id)) ||
      (isPlainObject(event.unsigned) && isPlainObject(event.unsigned.redacted_because))
    ) {
      continue;
    }
    if (event.type !== "m.room.message") {
      continue;
    }
    if (isPlainObject(event.content)) {
      const rel = event.content["m.relates_to"];
      if (isPlainObject(rel) && rel.rel_type === "m.replace") {
        continue;
      }
    }
    const ts = event.origin_server_ts;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      maxTs = maxTs !== undefined ? Math.max(maxTs, ts) : ts;
    }
  }
  return maxTs;
}

export async function loadStartupSnapshot(): Promise<StartupSnapshot> {
  return withDb(async (db) => {
    const tx = db.transaction(
      [
        META_STORE,
        ROOMS_STORE,
        TIMELINE_CHUNKS_STORE,
        DRAFTS_STORE,
        PENDING_EVENTS_STORE,
        PENDING_READ_MARKERS_STORE,
      ],
      "readonly",
    );
    const metaReq = tx.objectStore(META_STORE).get(SESSION_KEY);
    const roomsPromise = readAllKeyedEntries<StoredRoomMeta>(tx.objectStore(ROOMS_STORE));
    const draftsPromise = readAllKeyedEntries<DraftRecord>(tx.objectStore(DRAFTS_STORE));
    const pendingReq = tx.objectStore(PENDING_EVENTS_STORE).getAll();
    const markersReq = tx.objectStore(PENDING_READ_MARKERS_STORE).getAll();

    const [rawMeta, rawRooms, rawDrafts, rawPending, rawMarkers] = await Promise.all([
      requestToPromise(metaReq),
      roomsPromise,
      draftsPromise,
      requestToPromise(pendingReq),
      requestToPromise(markersReq),
    ]);

    const meta = normalizeSessionMeta(rawMeta);
    const rooms: Record<string, StoredRoomMeta> = {};
    for (const [roomId, value] of rawRooms) {
      if (roomId && isPlainObject(value)) {
        rooms[roomId] = normalizeStoredRoomMeta(value);
      }
    }

    const chunksStore = tx.objectStore(TIMELINE_CHUNKS_STORE);
    const roomTimelines: Record<string, StartupRoomTimeline> = {};

    await Promise.all(
      Object.entries(rooms).map(async ([roomId, roomMeta]) => {
        if (roomMeta.chunkMaxSeq === undefined && roomMeta.chunkMinSeq === undefined) {
          // Check if any chunks exist even if chunk bounds weren't persisted
          const hot = await readHotChunksForRoom(chunksStore, roomId, roomMeta);
          if (hot.hotChunks.length > 0 || hot.coldPlaceholders.length > 0) {
            roomTimelines[roomId] = hot;
          } else {
            roomTimelines[roomId] = {
              hotChunks: [],
              coldPlaceholders: [],
              hasOlderLocalChunks: false,
            };
          }
          return;
        }
        roomTimelines[roomId] = await readHotChunksForRoom(chunksStore, roomId, roomMeta);
      }),
    );

    const drafts: Record<string, DraftRecord> = {};
    for (const [roomId, value] of rawDrafts) {
      if (!roomId || !isPlainObject(value)) {
        continue;
      }
      const normalized = normalizeStoredDraft(value);
      if (normalized) {
        drafts[roomId] = normalized;
      }
    }
    const pendingEvents = sortPendingEvents(
      Array.isArray(rawPending)
        ? rawPending
            .map((item) => normalizeStoredPendingEvent(item))
            .filter((item): item is PendingRoomEvent => item !== undefined)
        : [],
    );
    const pendingReadMarkers = Array.isArray(rawMarkers)
      ? rawMarkers
          .filter(
            (item): item is PendingReadMarker =>
              isPlainObject(item) &&
              typeof item.roomId === "string" &&
              item.roomId !== "" &&
              typeof item.eventId === "string" &&
              item.eventId !== "",
          )
          .map((item) => ({ roomId: item.roomId, eventId: item.eventId }))
      : [];

    return {
      ...(meta ? { meta } : {}),
      rooms,
      roomTimelines,
      drafts,
      pendingEvents,
      pendingReadMarkers,
    };
  });
}

export async function loadTimelineChunk(
  roomId: string,
  seq: number,
): Promise<TimelineChunkRecord | undefined> {
  return withDb(async (db) => {
    const tx = db.transaction(TIMELINE_CHUNKS_STORE, "readonly");
    const raw = await requestToPromise(tx.objectStore(TIMELINE_CHUNKS_STORE).get([roomId, seq]));
    return normalizeTimelineChunkRecord(raw);
  });
}

export async function loadTimelineChunksBefore(
  roomId: string,
  beforeSeq: number,
  limitChunks = 1,
): Promise<TimelineChunkRecord[]> {
  if (limitChunks <= 0) {
    return [];
  }
  return withDb(async (db) => {
    const tx = db.transaction(TIMELINE_CHUNKS_STORE, "readonly");
    const store = tx.objectStore(TIMELINE_CHUNKS_STORE);
    const range = globalThis.IDBKeyRange.bound(
      [roomId, -Infinity],
      [roomId, beforeSeq],
      false,
      true,
    );
    return new Promise<TimelineChunkRecord[]>((resolve, reject) => {
      const collected: TimelineChunkRecord[] = [];
      const req = store.openCursor(range, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(collected.reverse());
          return;
        }
        const parsed = normalizeTimelineChunkRecord(cursor.value);
        if (parsed) {
          collected.push(parsed);
        }
        if (collected.length >= limitChunks) {
          resolve(collected.reverse());
          return;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB chunk cursor failed"));
    });
  });
}

export async function loadAllRoomTimelineChunks(roomId: string): Promise<TimelineChunkRecord[]> {
  return withDb(async (db) => {
    const tx = db.transaction(TIMELINE_CHUNKS_STORE, "readonly");
    const store = tx.objectStore(TIMELINE_CHUNKS_STORE);
    const range = globalThis.IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
    const raw = await requestToPromise(store.getAll(range));
    const chunks: TimelineChunkRecord[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const parsed = normalizeTimelineChunkRecord(item);
        if (parsed) {
          chunks.push(parsed);
        }
      }
    }
    chunks.sort((a, b) => a.seq - b.seq);
    return chunks;
  });
}

export async function scanRoomChunksBackward(
  roomId: string,
  beforeSeq: number | undefined,
  visitor: (chunk: TimelineChunkRecord) => "continue" | "stop",
): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(TIMELINE_CHUNKS_STORE, "readonly");
    const store = tx.objectStore(TIMELINE_CHUNKS_STORE);
    const range =
      beforeSeq !== undefined
        ? globalThis.IDBKeyRange.bound([roomId, -Infinity], [roomId, beforeSeq], false, true)
        : globalThis.IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor(range, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const parsed = normalizeTimelineChunkRecord(cursor.value);
        if (parsed) {
          const decision = visitor(parsed);
          if (decision === "stop") {
            resolve();
            return;
          }
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB scan cursor failed"));
    });
  });
}

export async function loadV2Snapshot(): Promise<V2Snapshot> {
  return withDb(async (db) => {
    const tx = db.transaction(
      [
        META_STORE,
        ROOMS_STORE,
        TIMELINE_CHUNKS_STORE,
        DRAFTS_STORE,
        PENDING_EVENTS_STORE,
        PENDING_READ_MARKERS_STORE,
      ],
      "readonly",
    );
    const metaReq = tx.objectStore(META_STORE).get(SESSION_KEY);
    const roomsPromise = readAllKeyedEntries<StoredRoomMeta>(tx.objectStore(ROOMS_STORE));
    const chunksReq = tx.objectStore(TIMELINE_CHUNKS_STORE).getAll();
    const draftsPromise = readAllKeyedEntries<DraftRecord>(tx.objectStore(DRAFTS_STORE));
    const pendingReq = tx.objectStore(PENDING_EVENTS_STORE).getAll();
    const markersReq = tx.objectStore(PENDING_READ_MARKERS_STORE).getAll();

    const [rawMeta, rawRooms, rawChunks, rawDrafts, rawPending, rawMarkers] = await Promise.all([
      requestToPromise(metaReq),
      roomsPromise,
      requestToPromise(chunksReq),
      draftsPromise,
      requestToPromise(pendingReq),
      requestToPromise(markersReq),
    ]);

    const meta = normalizeSessionMeta(rawMeta);
    const rooms: Record<string, StoredRoomMeta> = {};
    for (const [roomId, value] of rawRooms) {
      if (roomId && isPlainObject(value)) {
        rooms[roomId] = normalizeStoredRoomMeta(value);
      }
    }
    const chunksByRoom = new Map<string, TimelineChunkRecord[]>();
    if (Array.isArray(rawChunks)) {
      for (const rawChunk of rawChunks) {
        const chunk = normalizeTimelineChunkRecord(rawChunk);
        if (chunk) {
          const list = chunksByRoom.get(chunk.roomId) ?? [];
          list.push(chunk);
          chunksByRoom.set(chunk.roomId, list);
        }
      }
    }
    const timelines: Record<string, RawMatrixEvent[]> = {};
    for (const [roomId, chunks] of chunksByRoom.entries()) {
      chunks.sort((a, b) => a.seq - b.seq);
      timelines[roomId] = chunks.flatMap((c) => c.events);
    }
    const drafts: Record<string, DraftRecord> = {};
    for (const [roomId, value] of rawDrafts) {
      if (!roomId || !isPlainObject(value)) {
        continue;
      }
      const normalized = normalizeStoredDraft(value);
      if (normalized) {
        drafts[roomId] = normalized;
      }
    }
    const pendingEvents = sortPendingEvents(
      Array.isArray(rawPending)
        ? rawPending
            .map((item) => normalizeStoredPendingEvent(item))
            .filter((item): item is PendingRoomEvent => item !== undefined)
        : [],
    );
    const pendingReadMarkers = Array.isArray(rawMarkers)
      ? rawMarkers
          .filter(
            (item): item is PendingReadMarker =>
              isPlainObject(item) &&
              typeof item.roomId === "string" &&
              item.roomId !== "" &&
              typeof item.eventId === "string" &&
              item.eventId !== "",
          )
          .map((item) => ({ roomId: item.roomId, eventId: item.eventId }))
      : [];

    return {
      ...(meta ? { meta } : {}),
      rooms,
      timelines,
      drafts,
      pendingEvents,
      pendingReadMarkers,
    };
  });
}

export async function loadBlob(attachmentId: string): Promise<BlobRecord | undefined> {
  if (!attachmentId) {
    return undefined;
  }
  return withDb(async (db) => {
    const tx = db.transaction(BLOBS_STORE, "readonly");
    const raw = await requestToPromise(tx.objectStore(BLOBS_STORE).get(attachmentId));
    return normalizeBlobRecord(raw);
  });
}

export async function pruneOrphanBlobs(referencedIds: Set<string>): Promise<void> {
  await withDb(async (db) => {
    const readTx = db.transaction(BLOBS_STORE, "readonly");
    const keys = await requestToPromise(readTx.objectStore(BLOBS_STORE).getAllKeys());
    const orphanKeys = keys.filter(
      (key): key is string => typeof key === "string" && !referencedIds.has(key),
    );
    if (orphanKeys.length === 0) {
      return;
    }
    const writeTx = db.transaction(BLOBS_STORE, "readwrite");
    const blobs = writeTx.objectStore(BLOBS_STORE);
    for (const key of orphanKeys) {
      blobs.delete(key);
    }
    await transactionDone(writeTx);
  });
}

export async function saveMeta(meta: SessionMeta): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(cleanSessionMeta(meta), SESSION_KEY);
    await transactionDone(tx);
  });
}

export async function saveRoomMeta(roomId: string, roomMeta: StoredRoomMeta): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(ROOMS_STORE, "readwrite");
    tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(roomMeta), roomId);
    await transactionDone(tx);
  });
}

export async function saveRoomMetaAndReadMarker(
  roomId: string,
  roomMeta: StoredRoomMeta,
  readMarker: PendingReadMarker,
): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([ROOMS_STORE, PENDING_READ_MARKERS_STORE], "readwrite");
    tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(roomMeta), roomId);
    tx.objectStore(PENDING_READ_MARKERS_STORE).put({
      roomId: readMarker.roomId,
      eventId: readMarker.eventId,
    });
    await transactionDone(tx);
  });
}

export async function saveReadMarkerConfirmation(input: {
  roomId: string;
  roomMeta?: StoredRoomMeta;
  deletePendingMarker?: boolean;
}): Promise<void> {
  const stores: string[] = [];
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  if (input.deletePendingMarker) {
    stores.push(PENDING_READ_MARKERS_STORE);
  }
  if (stores.length === 0) {
    return;
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    if (input.roomMeta) {
      tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(input.roomMeta), input.roomId);
    }
    if (input.deletePendingMarker) {
      tx.objectStore(PENDING_READ_MARKERS_STORE).delete(input.roomId);
    }
    await transactionDone(tx);
  });
}

export async function saveRoomAndTimeline(
  roomId: string,
  roomMeta: StoredRoomMeta,
  chunkWrite: ChunkWriteOp,
): Promise<void> {
  const hasChunks = hasChunkWriteOps(chunkWrite);
  const stores = hasChunks ? [ROOMS_STORE, TIMELINE_CHUNKS_STORE] : [ROOMS_STORE];
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(roomMeta), roomId);
    if (hasChunks) {
      applyChunkWritesInTx(tx.objectStore(TIMELINE_CHUNKS_STORE), [chunkWrite]);
    }
    await transactionDone(tx);
  });
}

export async function saveDraftInStore(input: {
  roomId: string;
  draft?: DraftRecord;
  putBlob?: BlobRecord;
  deleteBlobIds?: string[];
  commit?: boolean;
}): Promise<void> {
  const stores: string[] = [DRAFTS_STORE];
  if (input.putBlob || (input.deleteBlobIds && input.deleteBlobIds.length > 0)) {
    stores.push(BLOBS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    if (stores.includes(BLOBS_STORE)) {
      const blobs = tx.objectStore(BLOBS_STORE);
      if (input.putBlob) {
        blobs.put(input.putBlob);
      }
      for (const blobId of input.deleteBlobIds ?? []) {
        blobs.delete(blobId);
      }
    }
    const drafts = tx.objectStore(DRAFTS_STORE);
    if (input.draft) {
      drafts.put(cleanStoredDraft(input.draft), input.roomId);
    } else {
      drafts.delete(input.roomId);
    }
    if (input.commit && typeof tx.commit === "function") {
      try {
        tx.commit();
      } catch {
        // ignore if transaction already finished or commit unsupported
      }
    }
    await transactionDone(tx);
  });
}

export async function saveEnqueuedEvent(input: {
  pendingEvent: PendingRoomEvent;
  roomId: string;
  roomMeta?: StoredRoomMeta;
  chunkWrite?: ChunkWriteOp;
  clearDraft?: boolean;
  putBlob?: BlobRecord;
  deleteBlobIds?: string[];
}): Promise<void> {
  const stores: string[] = [PENDING_EVENTS_STORE];
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  const hasChunks = input.chunkWrite ? hasChunkWriteOps(input.chunkWrite) : false;
  if (hasChunks) {
    stores.push(TIMELINE_CHUNKS_STORE);
  }
  if (input.clearDraft) {
    stores.push(DRAFTS_STORE);
  }
  if (input.putBlob || (input.deleteBlobIds && input.deleteBlobIds.length > 0)) {
    stores.push(BLOBS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    if (input.putBlob || (input.deleteBlobIds && input.deleteBlobIds.length > 0)) {
      const blobs = tx.objectStore(BLOBS_STORE);
      if (input.putBlob) {
        blobs.put(input.putBlob);
      }
      for (const blobId of input.deleteBlobIds ?? []) {
        blobs.delete(blobId);
      }
    }
    tx.objectStore(PENDING_EVENTS_STORE).put(cleanStoredPendingEvent(input.pendingEvent));
    if (input.roomMeta) {
      tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(input.roomMeta), input.roomId);
    }
    if (hasChunks && input.chunkWrite) {
      applyChunkWritesInTx(tx.objectStore(TIMELINE_CHUNKS_STORE), [input.chunkWrite]);
    }
    if (input.clearDraft) {
      tx.objectStore(DRAFTS_STORE).delete(input.roomId);
    }
    await transactionDone(tx);
  });
}

export async function replacePendingEvent(
  oldTxnId: string | undefined,
  newPendingEvent: PendingRoomEvent,
): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(PENDING_EVENTS_STORE, "readwrite");
    const store = tx.objectStore(PENDING_EVENTS_STORE);
    if (oldTxnId) {
      store.delete(oldTxnId);
    }
    store.put(cleanStoredPendingEvent(newPendingEvent));
    await transactionDone(tx);
  });
}

export async function saveUploadedMediaUrl(input: {
  pendingEvent?: PendingRoomEvent;
  chunkWrite?: ChunkWriteOp;
}): Promise<void> {
  const stores: string[] = [];
  if (input.pendingEvent) {
    stores.push(PENDING_EVENTS_STORE);
  }
  const hasChunks = input.chunkWrite ? hasChunkWriteOps(input.chunkWrite) : false;
  if (hasChunks) {
    stores.push(TIMELINE_CHUNKS_STORE);
  }
  if (stores.length === 0) {
    return;
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    if (input.pendingEvent) {
      tx.objectStore(PENDING_EVENTS_STORE).put(cleanStoredPendingEvent(input.pendingEvent));
    }
    if (hasChunks && input.chunkWrite) {
      applyChunkWritesInTx(tx.objectStore(TIMELINE_CHUNKS_STORE), [input.chunkWrite]);
    }
    await transactionDone(tx);
  });
}

export async function saveConfirmedEvent(input: {
  roomId: string;
  txnId: string;
  chunkWrite?: ChunkWriteOp;
  roomMeta?: StoredRoomMeta;
  deleteBlobIds?: string[];
}): Promise<void> {
  const stores: string[] = [PENDING_EVENTS_STORE];
  const hasChunks = input.chunkWrite ? hasChunkWriteOps(input.chunkWrite) : false;
  if (hasChunks) {
    stores.push(TIMELINE_CHUNKS_STORE);
  }
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  if (input.deleteBlobIds && input.deleteBlobIds.length > 0) {
    stores.push(BLOBS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(PENDING_EVENTS_STORE).delete(input.txnId);
    if (hasChunks && input.chunkWrite) {
      applyChunkWritesInTx(tx.objectStore(TIMELINE_CHUNKS_STORE), [input.chunkWrite]);
    }
    if (input.roomMeta) {
      tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(input.roomMeta), input.roomId);
    }
    if (input.deleteBlobIds && input.deleteBlobIds.length > 0) {
      const blobs = tx.objectStore(BLOBS_STORE);
      for (const blobId of input.deleteBlobIds) {
        blobs.delete(blobId);
      }
    }
    await transactionDone(tx);
  });
}

export async function saveFailedEvent(input: {
  roomId: string;
  txnId: string;
  chunkWrite?: ChunkWriteOp;
  roomMeta?: StoredRoomMeta;
}): Promise<void> {
  const stores: string[] = [PENDING_EVENTS_STORE];
  const hasChunks = input.chunkWrite ? hasChunkWriteOps(input.chunkWrite) : false;
  if (hasChunks) {
    stores.push(TIMELINE_CHUNKS_STORE);
  }
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(PENDING_EVENTS_STORE).delete(input.txnId);
    if (hasChunks && input.chunkWrite) {
      applyChunkWritesInTx(tx.objectStore(TIMELINE_CHUNKS_STORE), [input.chunkWrite]);
    }
    if (input.roomMeta) {
      tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(input.roomMeta), input.roomId);
    }
    await transactionDone(tx);
  });
}

export async function saveResendEvent(input: {
  pendingEvent: PendingRoomEvent;
  chunkWrite?: ChunkWriteOp;
}): Promise<void> {
  const hasChunks = input.chunkWrite ? hasChunkWriteOps(input.chunkWrite) : false;
  const stores = hasChunks ? [PENDING_EVENTS_STORE, TIMELINE_CHUNKS_STORE] : [PENDING_EVENTS_STORE];
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(PENDING_EVENTS_STORE).put(cleanStoredPendingEvent(input.pendingEvent));
    if (hasChunks && input.chunkWrite) {
      applyChunkWritesInTx(tx.objectStore(TIMELINE_CHUNKS_STORE), [input.chunkWrite]);
    }
    await transactionDone(tx);
  });
}

export async function saveDiscardFailedEvent(input: {
  roomId: string;
  chunkWrite?: ChunkWriteOp;
  roomMeta?: StoredRoomMeta;
  deleteBlobIds?: string[];
}): Promise<void> {
  const stores: string[] = [];
  const hasChunks = input.chunkWrite ? hasChunkWriteOps(input.chunkWrite) : false;
  if (hasChunks) {
    stores.push(TIMELINE_CHUNKS_STORE);
  }
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  if (input.deleteBlobIds && input.deleteBlobIds.length > 0) {
    stores.push(BLOBS_STORE);
  }
  if (stores.length === 0) {
    return;
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    if (hasChunks && input.chunkWrite) {
      applyChunkWritesInTx(tx.objectStore(TIMELINE_CHUNKS_STORE), [input.chunkWrite]);
    }
    if (input.roomMeta) {
      tx.objectStore(ROOMS_STORE).put(cleanStoredRoomMeta(input.roomMeta), input.roomId);
    }
    if (input.deleteBlobIds && input.deleteBlobIds.length > 0) {
      const blobs = tx.objectStore(BLOBS_STORE);
      for (const blobId of input.deleteBlobIds) {
        blobs.delete(blobId);
      }
    }
    await transactionDone(tx);
  });
}

export async function saveLeftRoomRemoval(input: {
  roomId: string;
  pendingTxnIds: string[];
  deleteBlobIds: string[];
}): Promise<void> {
  const stores: string[] = [
    ROOMS_STORE,
    TIMELINE_CHUNKS_STORE,
    DRAFTS_STORE,
    PENDING_EVENTS_STORE,
    PENDING_READ_MARKERS_STORE,
  ];
  if (input.deleteBlobIds.length > 0) {
    stores.push(BLOBS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(ROOMS_STORE).delete(input.roomId);
    tx.objectStore(TIMELINE_CHUNKS_STORE).delete(
      globalThis.IDBKeyRange.bound([input.roomId, -Infinity], [input.roomId, Infinity]),
    );
    tx.objectStore(DRAFTS_STORE).delete(input.roomId);
    tx.objectStore(PENDING_READ_MARKERS_STORE).delete(input.roomId);
    const pendingStore = tx.objectStore(PENDING_EVENTS_STORE);
    for (const txnId of input.pendingTxnIds) {
      pendingStore.delete(txnId);
    }
    if (input.deleteBlobIds.length > 0) {
      const blobs = tx.objectStore(BLOBS_STORE);
      for (const blobId of input.deleteBlobIds) {
        blobs.delete(blobId);
      }
    }
    await transactionDone(tx);
  });
}

export async function saveSyncBatch(input: {
  meta?: SessionMeta;
  putRooms: Array<[string, StoredRoomMeta]>;
  deleteRoomIds: string[];
  chunkWrites: ChunkWriteOp[];
  deletePendingTxnIds: string[];
  deleteReadMarkerRoomIds: string[];
  deleteDraftRoomIds: string[];
  deleteBlobIds: string[];
}): Promise<void> {
  const hasChunks =
    input.chunkWrites.some(hasChunkWriteOps) || input.deleteRoomIds.length > 0;
  const stores: string[] = [];
  if (input.meta) {
    stores.push(META_STORE);
  }
  if (input.putRooms.length > 0 || input.deleteRoomIds.length > 0) {
    stores.push(ROOMS_STORE);
  }
  if (hasChunks) {
    stores.push(TIMELINE_CHUNKS_STORE);
  }
  if (input.deletePendingTxnIds.length > 0) {
    stores.push(PENDING_EVENTS_STORE);
  }
  if (input.deleteReadMarkerRoomIds.length > 0) {
    stores.push(PENDING_READ_MARKERS_STORE);
  }
  if (input.deleteDraftRoomIds.length > 0) {
    stores.push(DRAFTS_STORE);
  }
  if (input.deleteBlobIds.length > 0) {
    stores.push(BLOBS_STORE);
  }
  if (stores.length === 0) {
    return;
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    if (input.meta) {
      tx.objectStore(META_STORE).put(cleanSessionMeta(input.meta), SESSION_KEY);
    }
    if (input.putRooms.length > 0 || input.deleteRoomIds.length > 0) {
      const rooms = tx.objectStore(ROOMS_STORE);
      for (const [roomId, roomMeta] of input.putRooms) {
        rooms.put(cleanStoredRoomMeta(roomMeta), roomId);
      }
      for (const roomId of input.deleteRoomIds) {
        rooms.delete(roomId);
      }
    }
    if (hasChunks) {
      const chunksStore = tx.objectStore(TIMELINE_CHUNKS_STORE);
      applyChunkWritesInTx(chunksStore, input.chunkWrites);
      for (const roomId of input.deleteRoomIds) {
        chunksStore.delete(globalThis.IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]));
      }
    }
    if (input.deletePendingTxnIds.length > 0) {
      const pending = tx.objectStore(PENDING_EVENTS_STORE);
      for (const txnId of input.deletePendingTxnIds) {
        pending.delete(txnId);
      }
    }
    if (input.deleteReadMarkerRoomIds.length > 0) {
      const markers = tx.objectStore(PENDING_READ_MARKERS_STORE);
      for (const roomId of input.deleteReadMarkerRoomIds) {
        markers.delete(roomId);
      }
    }
    if (input.deleteDraftRoomIds.length > 0) {
      const drafts = tx.objectStore(DRAFTS_STORE);
      for (const roomId of input.deleteDraftRoomIds) {
        drafts.delete(roomId);
      }
    }
    if (input.deleteBlobIds.length > 0) {
      const blobs = tx.objectStore(BLOBS_STORE);
      for (const blobId of input.deleteBlobIds) {
        blobs.delete(blobId);
      }
    }
    await transactionDone(tx);
  });
}

export async function resetSessionStores(meta: SessionMeta): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([...ALL_V3_STORES], "readwrite");
    for (const storeName of ALL_DOMAIN_STORES) {
      tx.objectStore(storeName).clear();
    }
    tx.objectStore(META_STORE).put(cleanSessionMeta(meta), SESSION_KEY);
    await transactionDone(tx);
  });
}

export async function dropCredential(): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(META_STORE, "readwrite");
    const metaStore = tx.objectStore(META_STORE);
    const current = normalizeSessionMeta(await requestToPromise(metaStore.get(SESSION_KEY)));
    if (current) {
      const next: SessionMeta = {
        baseUrl: current.baseUrl,
        userId: current.userId,
        ...(current.syncCursor ? { syncCursor: current.syncCursor } : {}),
        ...(current.accountData && Object.keys(current.accountData).length > 0
          ? { accountData: current.accountData }
          : {}),
      };
      metaStore.put(next, SESSION_KEY);
    }
    await transactionDone(tx);
  });
}

export async function dropPreListSession(): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([...ALL_V3_STORES], "readwrite");
    const metaStore = tx.objectStore(META_STORE);
    const current = normalizeSessionMeta(await requestToPromise(metaStore.get(SESSION_KEY)));
    for (const storeName of ALL_DOMAIN_STORES) {
      tx.objectStore(storeName).clear();
    }
    if (current) {
      metaStore.put({ baseUrl: current.baseUrl, userId: current.userId }, SESSION_KEY);
    } else {
      metaStore.clear();
    }
    await transactionDone(tx);
  });
}

export async function deleteLocalDatabase(timeoutMs = 5000): Promise<void> {
  const factory = globalThis.indexedDB;
  await closeCachedDatabase(factory);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("重置本地数据超时"));
      }
    }, timeoutMs);
    const finish = (cb: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      cb();
    };
    const request = factory.deleteDatabase(DB_NAME);
    request.onsuccess = () => finish(() => resolve());
    request.onerror = () =>
      finish(() => reject(request.error ?? new Error("删除本地数据库失败")));
  });
}

export async function loadSession(): Promise<SessionRecord | undefined> {
  return withDb(async (db) => {
    const tx = db.transaction([...ALL_V3_STORES], "readonly");
    const metaReq = tx.objectStore(META_STORE).get(SESSION_KEY);
    const roomsPromise = readAllKeyedEntries<StoredRoomMeta>(tx.objectStore(ROOMS_STORE));
    const chunksReq = tx.objectStore(TIMELINE_CHUNKS_STORE).getAll();
    const draftsPromise = readAllKeyedEntries<DraftRecord>(tx.objectStore(DRAFTS_STORE));
    const pendingReq = tx.objectStore(PENDING_EVENTS_STORE).getAll();
    const markersReq = tx.objectStore(PENDING_READ_MARKERS_STORE).getAll();
    const blobsReq = tx.objectStore(BLOBS_STORE).getAll();

    const [rawMeta, rawRooms, rawChunks, rawDrafts, rawPending, rawMarkers, rawBlobs] =
      await Promise.all([
        requestToPromise(metaReq),
        roomsPromise,
        requestToPromise(chunksReq),
        draftsPromise,
        requestToPromise(pendingReq),
        requestToPromise(markersReq),
        requestToPromise(blobsReq),
      ]);

    const meta = normalizeSessionMeta(rawMeta);
    if (!meta) {
      return undefined;
    }

    const blobById = new Map<string, BlobRecord>();
    if (Array.isArray(rawBlobs)) {
      for (const rawBlob of rawBlobs) {
        const blob = normalizeBlobRecord(rawBlob);
        if (blob) {
          blobById.set(blob.id, blob);
        }
      }
    }

    const chunksByRoom = new Map<string, TimelineChunkRecord[]>();
    if (Array.isArray(rawChunks)) {
      for (const rawChunk of rawChunks) {
        const chunk = normalizeTimelineChunkRecord(rawChunk);
        if (chunk) {
          const list = chunksByRoom.get(chunk.roomId) ?? [];
          list.push(chunk);
          chunksByRoom.set(chunk.roomId, list);
        }
      }
    }

    const timelineMap = new Map<string, RawMatrixEvent[]>();
    for (const [roomId, chunks] of chunksByRoom.entries()) {
      chunks.sort((a, b) => a.seq - b.seq);
      const events = chunks.flatMap((c) => c.events);
      timelineMap.set(roomId, events.map((ev) => hydrateTimelinePlaceholder(ev, blobById)));
    }

    const rooms: Record<string, StoredRoomEvents> = {};
    for (const [roomId, value] of rawRooms) {
      if (!roomId || !isPlainObject(value)) {
        continue;
      }
      const roomMeta = normalizeStoredRoomMeta(value);
      rooms[roomId] = {
        ...roomMeta,
        timelineEvents: timelineMap.get(roomId) ?? [],
      };
    }
    for (const [roomId, timelineEvents] of timelineMap.entries()) {
      if (!(roomId in rooms)) {
        rooms[roomId] = { stateEvents: [], timelineEvents };
      }
    }

    const drafts: Record<string, DraftRecord> = {};
    for (const [roomId, value] of rawDrafts) {
      if (!roomId || !isPlainObject(value)) {
        continue;
      }
      const draft = normalizeStoredDraft(value);
      if (!draft) {
        continue;
      }
      const hydrated: DraftRecord = { ...draft };
      if (draft.attachmentId) {
        const blob = blobById.get(draft.attachmentId);
        if (blob) {
          hydrated.attachment = {
            name: blob.name,
            mimeType: blob.mimeType,
            size: blob.size,
            data: new Uint8Array(blob.data),
          };
        }
      }
      drafts[roomId] = hydrated;
    }

    const pendingEvents = sortPendingEvents(
      Array.isArray(rawPending)
        ? rawPending
            .map((item) => normalizeStoredPendingEvent(item))
            .filter((item): item is PendingRoomEvent => item !== undefined)
        : [],
    ).map((item) => {
      if (!item.attachmentId) {
        return item;
      }
      const blob = blobById.get(item.attachmentId);
      if (!blob) {
        return item;
      }
      return {
        ...item,
        attachment: {
          name: blob.name,
          mimeType: blob.mimeType,
          size: blob.size,
          data: new Uint8Array(blob.data),
        },
      };
    });

    const pendingReadMarkers = Array.isArray(rawMarkers)
      ? rawMarkers
          .filter(
            (item): item is PendingReadMarker =>
              isPlainObject(item) &&
              typeof item.roomId === "string" &&
              item.roomId !== "" &&
              typeof item.eventId === "string" &&
              item.eventId !== "",
          )
          .map((item) => ({ roomId: item.roomId, eventId: item.eventId }))
      : [];

    const session: SessionRecord = {
      ...meta,
    };
    if (Object.keys(rooms).length > 0) {
      session.rooms = rooms;
    }
    if (pendingEvents.length > 0) {
      session.pendingEvents = pendingEvents;
    }
    if (pendingReadMarkers.length > 0) {
      session.pendingReadMarkers = pendingReadMarkers;
    }
    if (Object.keys(drafts).length > 0) {
      session.drafts = drafts;
    }
    return session;
  });
}

export async function saveSession(session: SessionRecord): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([...ALL_V3_STORES], "readwrite");
    for (const storeName of ALL_V3_STORES) {
      tx.objectStore(storeName).clear();
    }
    writeSessionIntoV3Transaction(tx, session);
    await transactionDone(tx);
  });
}

async function closeCachedDatabase(factory: IDBFactory): Promise<void> {
  const existingDb = openDbByFactory.get(factory);
  const existingPromise = dbPromiseByFactory.get(factory);
  dbPromiseByFactory.delete(factory);
  openDbByFactory.delete(factory);
  if (existingDb) {
    try {
      existingDb.close();
    } catch {
      // ignore close errors
    }
    return;
  }
  if (existingPromise) {
    try {
      const db = await existingPromise;
      db.close();
    } catch {
      // ignore open failure
    }
  }
}

function evictDbCache(factory: IDBFactory, db?: IDBDatabase): void {
  if (!db || openDbByFactory.get(factory) === db) {
    dbPromiseByFactory.delete(factory);
    openDbByFactory.delete(factory);
  }
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const factory = globalThis.indexedDB;
  const db = openDbByFactory.get(factory) ?? (await getDb(factory));
  try {
    return await fn(db);
  } catch (error) {
    if (isConnectionClosedError(error)) {
      evictDbCache(factory, db);
      const reconnected = await getDb(factory);
      return await fn(reconnected);
    }
    throw error;
  }
}

function getDb(factory: IDBFactory): Promise<IDBDatabase> {
  const cached = dbPromiseByFactory.get(factory);
  if (cached) {
    return cached;
  }
  const promise = openDbInternal(factory).then(
    (db) => {
      if (dbPromiseByFactory.get(factory) === promise) {
        openDbByFactory.set(factory, db);
      }
      db.onversionchange = () => {
        if (dbPromiseByFactory.get(factory) === promise) {
          dbPromiseByFactory.delete(factory);
        }
        if (openDbByFactory.get(factory) === db) {
          openDbByFactory.delete(factory);
        }
        db.close();
      };
      db.onclose = () => {
        if (dbPromiseByFactory.get(factory) === promise) {
          dbPromiseByFactory.delete(factory);
        }
        if (openDbByFactory.get(factory) === db) {
          openDbByFactory.delete(factory);
        }
      };
      return db;
    },
    (error) => {
      if (dbPromiseByFactory.get(factory) === promise) {
        dbPromiseByFactory.delete(factory);
      }
      throw error;
    },
  );
  dbPromiseByFactory.set(factory, promise);
  return promise;
}

function abortTxQuietly(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // ignore abort error
  }
}

function openDbInternal(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        return;
      }

      const ensureV3Stores = () => {
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        if (!db.objectStoreNames.contains(ROOMS_STORE)) {
          db.createObjectStore(ROOMS_STORE);
        }
        if (!db.objectStoreNames.contains(TIMELINE_CHUNKS_STORE)) {
          const chunksStore = db.createObjectStore(TIMELINE_CHUNKS_STORE, {
            keyPath: ["roomId", "seq"],
          });
          chunksStore.createIndex("roomId", "roomId", { unique: false });
        }
        if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
          db.createObjectStore(DRAFTS_STORE);
        }
        if (!db.objectStoreNames.contains(PENDING_EVENTS_STORE)) {
          const pendingStore = db.createObjectStore(PENDING_EVENTS_STORE, {
            keyPath: "txnId",
          });
          pendingStore.createIndex("roomId", "roomId", { unique: false });
        }
        if (!db.objectStoreNames.contains(PENDING_READ_MARKERS_STORE)) {
          db.createObjectStore(PENDING_READ_MARKERS_STORE, {
            keyPath: "roomId",
          });
        }
        if (!db.objectStoreNames.contains(BLOBS_STORE)) {
          db.createObjectStore(BLOBS_STORE, { keyPath: "id" });
        }
      };

      if (event.oldVersion < 1) {
        ensureV3Stores();
        return;
      }

      if (event.oldVersion === 1 && db.objectStoreNames.contains(LEGACY_STORE)) {
        try {
          ensureV3Stores();
          const legacyStore = tx.objectStore(LEGACY_STORE);
          const getReq = legacyStore.get(SESSION_KEY);
          getReq.onsuccess = () => {
            try {
              const rawSession = getReq.result;
              if (isPlainObject(rawSession)) {
                writeSessionIntoV3Transaction(tx, rawSession as SessionRecord);
              }
              if (db.objectStoreNames.contains(LEGACY_STORE)) {
                db.deleteObjectStore(LEGACY_STORE);
              }
              if (db.objectStoreNames.contains(LEGACY_TIMELINES_STORE)) {
                db.deleteObjectStore(LEGACY_TIMELINES_STORE);
              }
            } catch {
              abortTxQuietly(tx);
            }
          };
          getReq.onerror = () => abortTxQuietly(tx);
        } catch {
          abortTxQuietly(tx);
        }
        return;
      }

      if (event.oldVersion < 3) {
        try {
          ensureV3Stores();
          if (!db.objectStoreNames.contains(LEGACY_TIMELINES_STORE)) {
            return;
          }
          const roomsStore = tx.objectStore(ROOMS_STORE);
          const legacyTimelinesStore = tx.objectStore(LEGACY_TIMELINES_STORE);
          const chunksStore = tx.objectStore(TIMELINE_CHUNKS_STORE);

          const roomsById = new Map<string, Record<string, unknown>>();
          const timelinesById = new Map<string, RawMatrixEvent[]>();
          let remaining = 2;

          const finishV2ToV3 = () => {
            remaining -= 1;
            if (remaining > 0) {
              return;
            }
            try {
              const allRoomIds = new Set<string>([
                ...roomsById.keys(),
                ...timelinesById.keys(),
              ]);
              for (const roomId of allRoomIds) {
                const rawRoom = roomsById.get(roomId) ?? {};
                const events = timelinesById.get(roomId) ?? [];
                const chunks = splitTimelineEventsIntoChunks(roomId, events);
                for (const chunk of chunks) {
                  chunksStore.put(chunk);
                }
                const normalizedMeta = normalizeStoredRoomMeta(rawRoom);
                const enrichedMeta = enrichRoomMetaFromEvents(normalizedMeta, chunks, events);
                roomsStore.put(cleanStoredRoomMeta(enrichedMeta), roomId);
              }
              if (db.objectStoreNames.contains(LEGACY_TIMELINES_STORE)) {
                db.deleteObjectStore(LEGACY_TIMELINES_STORE);
              }
            } catch {
              abortTxQuietly(tx);
            }
          };

          const roomsCursor = roomsStore.openCursor();
          roomsCursor.onsuccess = () => {
            const cursor = roomsCursor.result;
            if (!cursor) {
              finishV2ToV3();
              return;
            }
            if (typeof cursor.key === "string" && isPlainObject(cursor.value)) {
              roomsById.set(cursor.key, cursor.value);
            }
            cursor.continue();
          };
          roomsCursor.onerror = () => abortTxQuietly(tx);

          const timelinesCursor = legacyTimelinesStore.openCursor();
          timelinesCursor.onsuccess = () => {
            const cursor = timelinesCursor.result;
            if (!cursor) {
              finishV2ToV3();
              return;
            }
            if (typeof cursor.key === "string") {
              const val = cursor.value;
              const evs = Array.isArray(val)
                ? val.filter(isPlainObject)
                : isPlainObject(val) && Array.isArray(val.timelineEvents)
                  ? val.timelineEvents.filter(isPlainObject)
                  : [];
              timelinesById.set(cursor.key, evs);
            }
            cursor.continue();
          };
          timelinesCursor.onerror = () => abortTxQuietly(tx);
        } catch {
          abortTxQuietly(tx);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

function enrichRoomMetaFromEvents(
  roomMeta: StoredRoomMeta,
  chunks: TimelineChunkRecord[],
  allEvents: RawMatrixEvent[],
): StoredRoomMeta {
  const lastActivityTs = computeLastActivityTs(allEvents) ?? roomMeta.lastActivityTs;
  const placeholderChunkSeqs = chunks
    .filter((c) => c.events.some((ev) => isPlainObject(ev.waypoint_local)))
    .map((c) => c.seq);
  const chunkMinSeq = chunks.length > 0 ? chunks[0]!.seq : undefined;
  const chunkMaxSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : undefined;
  const readPositionInLocal: boolean | undefined =
    roomMeta.readPositionEventId !== undefined
      ? allEvents.some(
          (ev) => !isPlainObject(ev.waypoint_local) && ev.event_id === roomMeta.readPositionEventId,
        )
      : undefined;
  const { readPositionInLocal: _ignoredReadLocal, ...baseMeta } = roomMeta;
  void _ignoredReadLocal;
  return {
    ...baseMeta,
    ...(lastActivityTs !== undefined ? { lastActivityTs } : {}),
    ...(chunkMinSeq !== undefined ? { chunkMinSeq } : {}),
    ...(chunkMaxSeq !== undefined ? { chunkMaxSeq } : {}),
    ...(placeholderChunkSeqs.length > 0 ? { placeholderChunkSeqs } : {}),
    ...(readPositionInLocal !== undefined ? { readPositionInLocal } : {}),
  };
}

function writeSessionIntoV3Transaction(tx: IDBTransaction, rawSession: SessionRecord): void {
  const metaStore = tx.objectStore(META_STORE);
  const roomsStore = tx.objectStore(ROOMS_STORE);
  const chunksStore = tx.objectStore(TIMELINE_CHUNKS_STORE);
  const draftsStore = tx.objectStore(DRAFTS_STORE);
  const pendingStore = tx.objectStore(PENDING_EVENTS_STORE);
  const markersStore = tx.objectStore(PENDING_READ_MARKERS_STORE);
  const blobsStore = tx.objectStore(BLOBS_STORE);

  const meta = normalizeSessionMeta(rawSession);
  if (meta) {
    metaStore.put(cleanSessionMeta(meta), SESSION_KEY);
  }

  const dedupBuckets = new Map<
    string,
    Array<{ id: string; meta: AttachmentMeta; data: Uint8Array }>
  >();

  const registerAttachment = (
    rawAttachment: unknown,
    existingId?: string,
    existingMeta?: AttachmentMeta,
  ): { attachmentId: string; attachmentMeta: AttachmentMeta } | undefined => {
    const legacy = normalizeLegacyAttachment(rawAttachment);
    if (legacy) {
      const bucketKey = `${legacy.name}\0${legacy.mimeType}\0${legacy.data.byteLength}`;
      const bucket = dedupBuckets.get(bucketKey) ?? [];
      for (const entry of bucket) {
        if (bytesEqual(entry.data, legacy.data)) {
          return { attachmentId: entry.id, attachmentMeta: entry.meta };
        }
      }
      const id =
        typeof existingId === "string" && existingId !== "" ? existingId : generateAttachmentId();
      const attMeta: AttachmentMeta = {
        name: legacy.name,
        mimeType: legacy.mimeType,
        size: legacy.size,
      };
      blobsStore.put({
        id,
        name: attMeta.name,
        mimeType: attMeta.mimeType,
        size: attMeta.size,
        data: legacy.data,
      });
      bucket.push({ id, meta: attMeta, data: legacy.data });
      dedupBuckets.set(bucketKey, bucket);
      return { attachmentId: id, attachmentMeta: attMeta };
    }
    if (typeof existingId === "string" && existingId !== "" && existingMeta) {
      return { attachmentId: existingId, attachmentMeta: existingMeta };
    }
    return undefined;
  };

  if (isPlainObject(rawSession.rooms)) {
    for (const [roomId, roomValue] of Object.entries(rawSession.rooms)) {
      if (!roomId || !isPlainObject(roomValue)) {
        continue;
      }
      const roomMeta = normalizeStoredRoomMeta(roomValue);
      const rawTimeline = Array.isArray(roomValue.timelineEvents)
        ? roomValue.timelineEvents.filter(isPlainObject)
        : [];
      const nextTimeline = rawTimeline.map((event) => {
        if (!isPlainObject(event.waypoint_local)) {
          return event;
        }
        const local = event.waypoint_local;
        const localMeta = normalizeAttachmentMeta(local.attachmentMeta);
        const registered = registerAttachment(
          local.attachment,
          typeof local.attachmentId === "string" ? local.attachmentId : undefined,
          localMeta,
        );
        const nextLocal: Record<string, unknown> = {
          id: local.id,
          status: local.status,
          txnId: local.txnId,
        };
        if (registered) {
          nextLocal.attachmentId = registered.attachmentId;
          nextLocal.attachmentMeta = registered.attachmentMeta;
        }
        return {
          ...event,
          waypoint_local: nextLocal,
        };
      });
      const chunks = splitTimelineEventsIntoChunks(roomId, nextTimeline);
      for (const chunk of chunks) {
        chunksStore.put(chunk);
      }
      const enrichedMeta = enrichRoomMetaFromEvents(roomMeta, chunks, nextTimeline);
      roomsStore.put(cleanStoredRoomMeta(enrichedMeta), roomId);
    }
  }

  if (isPlainObject(rawSession.drafts)) {
    for (const [roomId, draftValue] of Object.entries(rawSession.drafts)) {
      if (!roomId || !isPlainObject(draftValue)) {
        continue;
      }
      const text =
        typeof draftValue.text === "string" && draftValue.text.trim() !== ""
          ? draftValue.text
          : undefined;
      const existingMeta = normalizeAttachmentMeta(draftValue.attachmentMeta);
      const registered = registerAttachment(
        draftValue.attachment,
        typeof draftValue.attachmentId === "string" ? draftValue.attachmentId : undefined,
        existingMeta,
      );
      if (text === undefined && !registered) {
        continue;
      }
      draftsStore.put(
        {
          ...(text !== undefined ? { text } : {}),
          ...(registered
            ? {
                attachmentId: registered.attachmentId,
                attachmentMeta: registered.attachmentMeta,
              }
            : {}),
        },
        roomId,
      );
    }
  }

  if (Array.isArray(rawSession.pendingEvents)) {
    rawSession.pendingEvents.forEach((rawItem, index) => {
      if (
        !isPlainObject(rawItem) ||
        typeof rawItem.txnId !== "string" ||
        rawItem.txnId === "" ||
        typeof rawItem.roomId !== "string" ||
        rawItem.roomId === "" ||
        typeof rawItem.type !== "string" ||
        rawItem.type === "" ||
        typeof rawItem.sender !== "string" ||
        rawItem.sender === "" ||
        !isPlainObject(rawItem.content)
      ) {
        return;
      }
      const existingMeta = normalizeAttachmentMeta(rawItem.attachmentMeta);
      const registered = registerAttachment(
        rawItem.attachment,
        typeof rawItem.attachmentId === "string" ? rawItem.attachmentId : undefined,
        existingMeta,
      );
      pendingStore.put({
        txnId: rawItem.txnId,
        roomId: rawItem.roomId,
        type: rawItem.type,
        sender: rawItem.sender,
        content: rawItem.content,
        order: typeof rawItem.order === "number" && Number.isFinite(rawItem.order) ? rawItem.order : index,
        ...(registered
          ? {
              attachmentId: registered.attachmentId,
              attachmentMeta: registered.attachmentMeta,
            }
          : {}),
      });
    });
  }

  if (Array.isArray(rawSession.pendingReadMarkers)) {
    const byRoom = new Map<string, string>();
    for (const marker of rawSession.pendingReadMarkers) {
      if (
        isPlainObject(marker) &&
        typeof marker.roomId === "string" &&
        marker.roomId !== "" &&
        typeof marker.eventId === "string" &&
        marker.eventId !== ""
      ) {
        byRoom.set(marker.roomId, marker.eventId);
      }
    }
    for (const [roomId, eventId] of byRoom.entries()) {
      markersStore.put({ roomId, eventId });
    }
  }
}

async function readHotChunksForRoom(
  chunksStore: IDBObjectStore,
  roomId: string,
  roomMeta: StoredRoomMeta,
): Promise<StartupRoomTimeline> {
  const range = globalThis.IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
  const { hotChunksDesc, hasMoreInCursor } = await new Promise<{
    hotChunksDesc: TimelineChunkRecord[];
    hasMoreInCursor: boolean;
  }>((resolve, reject) => {
    const chunks: TimelineChunkRecord[] = [];
    let confirmedCount = 0;
    let peekingMore = false;
    const req = chunksStore.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve({ hotChunksDesc: chunks, hasMoreInCursor: false });
        return;
      }
      if (peekingMore) {
        resolve({ hotChunksDesc: chunks, hasMoreInCursor: true });
        return;
      }
      const parsed = normalizeTimelineChunkRecord(cursor.value);
      if (parsed) {
        chunks.push(parsed);
        for (const ev of parsed.events) {
          if (!isPlainObject(ev.waypoint_local)) {
            confirmedCount += 1;
          }
        }
      }
      if (confirmedCount >= TIMELINE_CHUNK_SIZE) {
        if (roomMeta.chunkMinSeq !== undefined && parsed) {
          resolve({
            hotChunksDesc: chunks,
            hasMoreInCursor: parsed.seq > roomMeta.chunkMinSeq,
          });
          return;
        }
        peekingMore = true;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB hot cursor failed"));
  });

  const hotChunks = [...hotChunksDesc].reverse();
  const minHotSeq = hotChunks.length > 0 ? hotChunks[0]!.seq : undefined;

  const coldPlaceholders: Array<{ seq: number; event: RawMatrixEvent }> = [];
  if (minHotSeq !== undefined && roomMeta.placeholderChunkSeqs && roomMeta.placeholderChunkSeqs.length > 0) {
    const coldSeqs = roomMeta.placeholderChunkSeqs.filter((seq) => seq < minHotSeq);
    if (coldSeqs.length > 0) {
      const fetched = await Promise.all(
        coldSeqs.map(async (seq) => {
          const raw = await requestToPromise(chunksStore.get([roomId, seq]));
          return normalizeTimelineChunkRecord(raw);
        }),
      );
      for (const chunk of fetched) {
        if (!chunk) {
          continue;
        }
        for (const ev of chunk.events) {
          if (isPlainObject(ev.waypoint_local)) {
            coldPlaceholders.push({ seq: chunk.seq, event: ev });
          }
        }
      }
      coldPlaceholders.sort((a, b) => a.seq - b.seq);
    }
  }

  return {
    hotChunks,
    coldPlaceholders,
    hasOlderLocalChunks: hasMoreInCursor,
  };
}

function hasChunkWriteOps(op: ChunkWriteOp): boolean {
  return Boolean(
    (op.putChunks && op.putChunks.length > 0) ||
      (op.deleteChunkSeqs && op.deleteChunkSeqs.length > 0),
  );
}

function applyChunkWritesInTx(chunksStore: IDBObjectStore, ops: ChunkWriteOp[]): void {
  for (const op of ops) {
    for (const seq of op.deleteChunkSeqs ?? []) {
      chunksStore.delete([op.roomId, seq]);
    }
    for (const chunk of op.putChunks ?? []) {
      chunksStore.put({
        roomId: op.roomId,
        seq: chunk.seq,
        events: chunk.events,
      });
    }
  }
}

function normalizeTimelineChunkRecord(raw: unknown): TimelineChunkRecord | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw.roomId !== "string" ||
    raw.roomId === "" ||
    typeof raw.seq !== "number" ||
    !Number.isFinite(raw.seq) ||
    !Array.isArray(raw.events)
  ) {
    return undefined;
  }
  return {
    roomId: raw.roomId,
    seq: raw.seq,
    events: raw.events.filter(isPlainObject),
  };
}

function hydrateTimelinePlaceholder(
  event: RawMatrixEvent,
  blobById: Map<string, BlobRecord>,
): RawMatrixEvent {
  if (!isPlainObject(event.waypoint_local)) {
    return event;
  }
  const local = event.waypoint_local;
  const attachmentId = typeof local.attachmentId === "string" ? local.attachmentId : undefined;
  if (!attachmentId) {
    return event;
  }
  const blob = blobById.get(attachmentId);
  if (!blob) {
    return event;
  }
  return {
    ...event,
    waypoint_local: {
      ...local,
      attachment: {
        name: blob.name,
        mimeType: blob.mimeType,
        size: blob.size,
        data: new Uint8Array(blob.data),
      },
    },
  };
}

function readAllKeyedEntries<T>(store: IDBObjectStore): Promise<Array<[string, T]>> {
  return new Promise((resolve, reject) => {
    const entries: Array<[string, T]> = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      if (typeof cursor.key === "string") {
        entries.push([cursor.key, cursor.value as T]);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function isConnectionClosedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { name?: unknown; message?: unknown };
  if (err.name === "InvalidStateError") {
    return true;
  }
  return typeof err.message === "string" && /closing|closed/i.test(err.message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return undefined;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function normalizeSessionMeta(raw: unknown): SessionMeta | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : "";
  const userId = typeof raw.userId === "string" ? raw.userId : "";
  if (!baseUrl && !userId) {
    return undefined;
  }
  return {
    baseUrl,
    userId,
    ...(typeof raw.accessToken === "string" && raw.accessToken !== ""
      ? { accessToken: raw.accessToken }
      : {}),
    ...(typeof raw.deviceId === "string" && raw.deviceId !== ""
      ? { deviceId: raw.deviceId }
      : {}),
    ...(typeof raw.syncCursor === "string" && raw.syncCursor !== ""
      ? { syncCursor: raw.syncCursor }
      : {}),
    ...(isPlainObject(raw.accountData) && Object.keys(raw.accountData).length > 0
      ? { accountData: raw.accountData }
      : {}),
  };
}

function cleanSessionMeta(meta: SessionMeta): SessionMeta {
  return {
    baseUrl: meta.baseUrl,
    userId: meta.userId,
    ...(meta.accessToken ? { accessToken: meta.accessToken } : {}),
    ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
    ...(meta.syncCursor ? { syncCursor: meta.syncCursor } : {}),
    ...(meta.accountData && Object.keys(meta.accountData).length > 0
      ? { accountData: meta.accountData }
      : {}),
  };
}

function cleanStoredRoomMeta(meta: StoredRoomMeta): StoredRoomMeta {
  const {
    timelineEvents: _ignoredEvents,
    hasOlderLocalChunks: _ignoredHasOlder,
    coldUnreadState: _ignoredColdUnread,
    ...rest
  } = meta as StoredRoomEvents;
  void _ignoredEvents;
  void _ignoredHasOlder;
  void _ignoredColdUnread;
  return rest;
}

function normalizeStoredRoomMeta(raw: Record<string, unknown>): StoredRoomMeta {
  const stateEvents = Array.isArray(raw.stateEvents)
    ? raw.stateEvents.filter(isPlainObject)
    : [];
  const timelineGaps: StoredTimelineGap[] = [];
  if (Array.isArray(raw.timelineGaps)) {
    for (const item of raw.timelineGaps) {
      if (isPlainObject(item) && item.limited === true) {
        timelineGaps.push({
          limited: true,
          ...(typeof item.prevBatch === "string" && item.prevBatch !== ""
            ? { prevBatch: item.prevBatch }
            : {}),
          ...(typeof item.gapBeforeEventId === "string" && item.gapBeforeEventId !== ""
            ? { gapBeforeEventId: item.gapBeforeEventId }
            : {}),
          ...(item.pendingGapAtEnd === true ? { pendingGapAtEnd: true as const } : {}),
        });
      }
    }
  } else if (isPlainObject(raw.timelineGap) && raw.timelineGap.limited === true) {
    timelineGaps.push({
      limited: true,
      ...(typeof raw.timelineGap.prevBatch === "string" && raw.timelineGap.prevBatch !== ""
        ? { prevBatch: raw.timelineGap.prevBatch }
        : {}),
      ...(typeof raw.timelineGap.gapBeforeEventId === "string" &&
      raw.timelineGap.gapBeforeEventId !== ""
        ? { gapBeforeEventId: raw.timelineGap.gapBeforeEventId }
        : {}),
      ...(raw.timelineGap.pendingGapAtEnd === true ? { pendingGapAtEnd: true as const } : {}),
    });
  }
  const reachedStart = raw.reachedStart === true;
  const backwardToken =
    typeof raw.backwardToken === "string" && raw.backwardToken !== "" ? raw.backwardToken : undefined;
  const lastActivityTs =
    typeof raw.lastActivityTs === "number" && Number.isFinite(raw.lastActivityTs)
      ? raw.lastActivityTs
      : undefined;
  const chunkMinSeq =
    typeof raw.chunkMinSeq === "number" && Number.isFinite(raw.chunkMinSeq)
      ? raw.chunkMinSeq
      : undefined;
  const chunkMaxSeq =
    typeof raw.chunkMaxSeq === "number" && Number.isFinite(raw.chunkMaxSeq)
      ? raw.chunkMaxSeq
      : undefined;
  const placeholderChunkSeqs = Array.isArray(raw.placeholderChunkSeqs)
    ? raw.placeholderChunkSeqs.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : undefined;
  const readPositionInLocal =
    typeof raw.readPositionInLocal === "boolean" ? raw.readPositionInLocal : undefined;
  return {
    stateEvents,
    ...(timelineGaps.length > 0
      ? { timelineGap: { ...timelineGaps[0] }, timelineGaps }
      : {}),
    ...(backwardToken && !reachedStart ? { backwardToken } : {}),
    ...(reachedStart ? { reachedStart: true } : {}),
    ...(typeof raw.readPositionEventId === "string" && raw.readPositionEventId !== ""
      ? { readPositionEventId: raw.readPositionEventId }
      : {}),
    ...(typeof raw.fullyReadEventId === "string" && raw.fullyReadEventId !== ""
      ? { fullyReadEventId: raw.fullyReadEventId }
      : {}),
    ...(typeof raw.privateReadEventId === "string" && raw.privateReadEventId !== ""
      ? { privateReadEventId: raw.privateReadEventId }
      : {}),
    ...(isPlainObject(raw.tags) && Object.keys(raw.tags).length > 0
      ? { tags: raw.tags }
      : {}),
    ...(raw.encryptedIrreversible === true ? { encryptedIrreversible: true as const } : {}),
    ...(raw.inviteFailed === true ? { inviteFailed: true as const } : {}),
    ...(lastActivityTs !== undefined ? { lastActivityTs } : {}),
    ...(chunkMinSeq !== undefined ? { chunkMinSeq } : {}),
    ...(chunkMaxSeq !== undefined ? { chunkMaxSeq } : {}),
    ...(placeholderChunkSeqs && placeholderChunkSeqs.length > 0 ? { placeholderChunkSeqs } : {}),
    ...(readPositionInLocal !== undefined ? { readPositionInLocal } : {}),
  };
}

function normalizeAttachmentMeta(raw: unknown): AttachmentMeta | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  if (
    typeof raw.name !== "string" ||
    raw.name === "" ||
    typeof raw.mimeType !== "string" ||
    typeof raw.size !== "number" ||
    !Number.isFinite(raw.size) ||
    raw.size < 0
  ) {
    return undefined;
  }
  return {
    name: raw.name,
    mimeType: raw.mimeType,
    size: raw.size,
  };
}

function normalizeLegacyAttachment(raw: unknown): DraftAttachment | undefined {
  const meta = normalizeAttachmentMeta(raw);
  if (!meta || !isPlainObject(raw)) {
    return undefined;
  }
  const data = toUint8Array(raw.data);
  if (!data) {
    return undefined;
  }
  return {
    ...meta,
    data,
  };
}

function normalizeBlobRecord(raw: unknown): BlobRecord | undefined {
  if (!isPlainObject(raw) || typeof raw.id !== "string" || raw.id === "") {
    return undefined;
  }
  const att = normalizeLegacyAttachment(raw);
  if (!att) {
    return undefined;
  }
  return {
    id: raw.id,
    ...att,
  };
}

function normalizeStoredDraft(raw: Record<string, unknown>): DraftRecord | undefined {
  const text = typeof raw.text === "string" && raw.text.trim() !== "" ? raw.text : undefined;
  const attachmentId =
    typeof raw.attachmentId === "string" && raw.attachmentId !== "" ? raw.attachmentId : undefined;
  const attachmentMeta = normalizeAttachmentMeta(raw.attachmentMeta);
  if (text === undefined && (!attachmentId || !attachmentMeta)) {
    return undefined;
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
  };
}

function cleanStoredDraft(draft: DraftRecord): DraftRecord {
  return {
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.attachmentId && draft.attachmentMeta
      ? {
          attachmentId: draft.attachmentId,
          attachmentMeta: { ...draft.attachmentMeta },
        }
      : {}),
  };
}

function normalizeStoredPendingEvent(raw: unknown): PendingRoomEvent | undefined {
  if (
    !isPlainObject(raw) ||
    typeof raw.txnId !== "string" ||
    raw.txnId === "" ||
    typeof raw.roomId !== "string" ||
    raw.roomId === "" ||
    typeof raw.type !== "string" ||
    raw.type === "" ||
    typeof raw.sender !== "string" ||
    raw.sender === "" ||
    !isPlainObject(raw.content)
  ) {
    return undefined;
  }
  const attachmentId =
    typeof raw.attachmentId === "string" && raw.attachmentId !== "" ? raw.attachmentId : undefined;
  const attachmentMeta = normalizeAttachmentMeta(raw.attachmentMeta);
  return {
    txnId: raw.txnId,
    roomId: raw.roomId,
    type: raw.type,
    sender: raw.sender,
    content: raw.content,
    ...(typeof raw.order === "number" && Number.isFinite(raw.order) ? { order: raw.order } : {}),
    ...(attachmentId && attachmentMeta ? { attachmentId, attachmentMeta } : {}),
  };
}

function cleanStoredPendingEvent(item: PendingRoomEvent): PendingRoomEvent {
  return {
    txnId: item.txnId,
    roomId: item.roomId,
    type: item.type,
    sender: item.sender,
    content: item.content,
    ...(item.order !== undefined ? { order: item.order } : {}),
    ...(item.attachmentId && item.attachmentMeta
      ? {
          attachmentId: item.attachmentId,
          attachmentMeta: { ...item.attachmentMeta },
        }
      : {}),
  };
}

function sortPendingEvents(events: PendingRoomEvent[]): PendingRoomEvent[] {
  return [...events].sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) {
      return ao - bo;
    }
    return a.txnId.localeCompare(b.txnId);
  });
}
