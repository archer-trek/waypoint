export type RawMatrixEvent = Record<string, unknown>;

export type StoredTimelineGap = {
  limited: true;
  prevBatch?: string;
  gapBeforeEventId?: string;
  pendingGapAtEnd?: true;
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
};

export type StoredRoomEvents = StoredRoomMeta & {
  timelineEvents: RawMatrixEvent[];
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
export const DB_VERSION = 2;
export const LEGACY_STORE = "records";
export const META_STORE = "meta";
export const ROOMS_STORE = "rooms";
export const TIMELINES_STORE = "timelines";
export const DRAFTS_STORE = "drafts";
export const PENDING_EVENTS_STORE = "pending_events";
export const PENDING_READ_MARKERS_STORE = "pending_read_markers";
export const BLOBS_STORE = "blobs";

const SESSION_KEY = "session";

const ALL_DOMAIN_STORES = [
  ROOMS_STORE,
  TIMELINES_STORE,
  DRAFTS_STORE,
  PENDING_EVENTS_STORE,
  PENDING_READ_MARKERS_STORE,
  BLOBS_STORE,
] as const;

const ALL_V2_STORES = [META_STORE, ...ALL_DOMAIN_STORES] as const;

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

export async function loadV2Snapshot(): Promise<V2Snapshot> {
  return withDb(async (db) => {
    const tx = db.transaction(
      [
        META_STORE,
        ROOMS_STORE,
        TIMELINES_STORE,
        DRAFTS_STORE,
        PENDING_EVENTS_STORE,
        PENDING_READ_MARKERS_STORE,
      ],
      "readonly",
    );
    const metaReq = tx.objectStore(META_STORE).get(SESSION_KEY);
    const roomsPromise = readAllKeyedEntries<StoredRoomMeta>(tx.objectStore(ROOMS_STORE));
    const timelinesPromise = readAllKeyedEntries<{ timelineEvents?: RawMatrixEvent[] } | RawMatrixEvent[]>(
      tx.objectStore(TIMELINES_STORE),
    );
    const draftsPromise = readAllKeyedEntries<DraftRecord>(tx.objectStore(DRAFTS_STORE));
    const pendingReq = tx.objectStore(PENDING_EVENTS_STORE).getAll();
    const markersReq = tx.objectStore(PENDING_READ_MARKERS_STORE).getAll();

    const [rawMeta, rawRooms, rawTimelines, rawDrafts, rawPending, rawMarkers] = await Promise.all([
      requestToPromise(metaReq),
      roomsPromise,
      timelinesPromise,
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
    const timelines: Record<string, RawMatrixEvent[]> = {};
    for (const [roomId, value] of rawTimelines) {
      if (!roomId) {
        continue;
      }
      if (Array.isArray(value)) {
        timelines[roomId] = value.filter(isPlainObject);
      } else if (isPlainObject(value) && Array.isArray(value.timelineEvents)) {
        timelines[roomId] = value.timelineEvents.filter(isPlainObject);
      }
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
    tx.objectStore(ROOMS_STORE).put(roomMeta, roomId);
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
    tx.objectStore(ROOMS_STORE).put(roomMeta, roomId);
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
      tx.objectStore(ROOMS_STORE).put(input.roomMeta, input.roomId);
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
  timelineEvents: RawMatrixEvent[],
): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([ROOMS_STORE, TIMELINES_STORE], "readwrite");
    tx.objectStore(ROOMS_STORE).put(roomMeta, roomId);
    tx.objectStore(TIMELINES_STORE).put({ timelineEvents }, roomId);
    await transactionDone(tx);
  });
}

export async function saveDraftInStore(input: {
  roomId: string;
  draft?: DraftRecord;
  putBlob?: BlobRecord;
  deleteBlobIds?: string[];
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
    await transactionDone(tx);
  });
}

export async function saveEnqueuedEvent(input: {
  pendingEvent: PendingRoomEvent;
  roomId: string;
  roomMeta?: StoredRoomMeta;
  timelineEvents?: RawMatrixEvent[];
  clearDraft?: boolean;
  putBlob?: BlobRecord;
  deleteBlobIds?: string[];
}): Promise<void> {
  const stores: string[] = [PENDING_EVENTS_STORE];
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  if (input.timelineEvents) {
    stores.push(TIMELINES_STORE);
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
      tx.objectStore(ROOMS_STORE).put(input.roomMeta, input.roomId);
    }
    if (input.timelineEvents) {
      tx.objectStore(TIMELINES_STORE).put({ timelineEvents: input.timelineEvents }, input.roomId);
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
  roomId: string;
  timelineEvents?: RawMatrixEvent[];
}): Promise<void> {
  const stores: string[] = [];
  if (input.pendingEvent) {
    stores.push(PENDING_EVENTS_STORE);
  }
  if (input.timelineEvents) {
    stores.push(TIMELINES_STORE);
  }
  if (stores.length === 0) {
    return;
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    if (input.pendingEvent) {
      tx.objectStore(PENDING_EVENTS_STORE).put(cleanStoredPendingEvent(input.pendingEvent));
    }
    if (input.timelineEvents) {
      tx.objectStore(TIMELINES_STORE).put({ timelineEvents: input.timelineEvents }, input.roomId);
    }
    await transactionDone(tx);
  });
}

export async function saveConfirmedEvent(input: {
  roomId: string;
  txnId: string;
  timelineEvents: RawMatrixEvent[];
  roomMeta?: StoredRoomMeta;
  deleteBlobIds?: string[];
}): Promise<void> {
  const stores: string[] = [PENDING_EVENTS_STORE, TIMELINES_STORE];
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  if (input.deleteBlobIds && input.deleteBlobIds.length > 0) {
    stores.push(BLOBS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(PENDING_EVENTS_STORE).delete(input.txnId);
    tx.objectStore(TIMELINES_STORE).put({ timelineEvents: input.timelineEvents }, input.roomId);
    if (input.roomMeta) {
      tx.objectStore(ROOMS_STORE).put(input.roomMeta, input.roomId);
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
  timelineEvents: RawMatrixEvent[];
  roomMeta?: StoredRoomMeta;
}): Promise<void> {
  const stores: string[] = [PENDING_EVENTS_STORE, TIMELINES_STORE];
  if (input.roomMeta) {
    stores.push(ROOMS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(PENDING_EVENTS_STORE).delete(input.txnId);
    tx.objectStore(TIMELINES_STORE).put({ timelineEvents: input.timelineEvents }, input.roomId);
    if (input.roomMeta) {
      tx.objectStore(ROOMS_STORE).put(input.roomMeta, input.roomId);
    }
    await transactionDone(tx);
  });
}

export async function saveResendEvent(input: {
  roomId: string;
  pendingEvent: PendingRoomEvent;
  timelineEvents: RawMatrixEvent[];
}): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([PENDING_EVENTS_STORE, TIMELINES_STORE], "readwrite");
    tx.objectStore(PENDING_EVENTS_STORE).put(cleanStoredPendingEvent(input.pendingEvent));
    tx.objectStore(TIMELINES_STORE).put({ timelineEvents: input.timelineEvents }, input.roomId);
    await transactionDone(tx);
  });
}

export async function saveDiscardFailedEvent(input: {
  roomId: string;
  timelineEvents: RawMatrixEvent[];
  deleteBlobIds?: string[];
}): Promise<void> {
  const stores: string[] = [TIMELINES_STORE];
  if (input.deleteBlobIds && input.deleteBlobIds.length > 0) {
    stores.push(BLOBS_STORE);
  }
  await withDb(async (db) => {
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(TIMELINES_STORE).put({ timelineEvents: input.timelineEvents }, input.roomId);
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
    TIMELINES_STORE,
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
    tx.objectStore(TIMELINES_STORE).delete(input.roomId);
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
  putTimelines: Array<[string, RawMatrixEvent[]]>;
  deletePendingTxnIds: string[];
  deleteReadMarkerRoomIds: string[];
  deleteDraftRoomIds: string[];
  deleteBlobIds: string[];
}): Promise<void> {
  const stores: string[] = [];
  if (input.meta) {
    stores.push(META_STORE);
  }
  if (input.putRooms.length > 0 || input.deleteRoomIds.length > 0) {
    stores.push(ROOMS_STORE);
  }
  if (input.putTimelines.length > 0 || input.deleteRoomIds.length > 0) {
    stores.push(TIMELINES_STORE);
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
        rooms.put(roomMeta, roomId);
      }
      for (const roomId of input.deleteRoomIds) {
        rooms.delete(roomId);
      }
    }
    if (input.putTimelines.length > 0 || input.deleteRoomIds.length > 0) {
      const timelines = tx.objectStore(TIMELINES_STORE);
      for (const [roomId, timelineEvents] of input.putTimelines) {
        timelines.put({ timelineEvents }, roomId);
      }
      for (const roomId of input.deleteRoomIds) {
        timelines.delete(roomId);
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
    const tx = db.transaction([...ALL_V2_STORES], "readwrite");
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
    const tx = db.transaction([...ALL_V2_STORES], "readwrite");
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
    const tx = db.transaction([...ALL_V2_STORES], "readonly");
    const metaReq = tx.objectStore(META_STORE).get(SESSION_KEY);
    const roomsPromise = readAllKeyedEntries<StoredRoomMeta>(tx.objectStore(ROOMS_STORE));
    const timelinesPromise = readAllKeyedEntries<{ timelineEvents?: RawMatrixEvent[] } | RawMatrixEvent[]>(
      tx.objectStore(TIMELINES_STORE),
    );
    const draftsPromise = readAllKeyedEntries<DraftRecord>(tx.objectStore(DRAFTS_STORE));
    const pendingReq = tx.objectStore(PENDING_EVENTS_STORE).getAll();
    const markersReq = tx.objectStore(PENDING_READ_MARKERS_STORE).getAll();
    const blobsReq = tx.objectStore(BLOBS_STORE).getAll();

    const [rawMeta, rawRooms, rawTimelines, rawDrafts, rawPending, rawMarkers, rawBlobs] =
      await Promise.all([
        requestToPromise(metaReq),
        roomsPromise,
        timelinesPromise,
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

    const timelineMap = new Map<string, RawMatrixEvent[]>();
    for (const [roomId, value] of rawTimelines) {
      if (!roomId) {
        continue;
      }
      const events = Array.isArray(value)
        ? value.filter(isPlainObject)
        : isPlainObject(value) && Array.isArray(value.timelineEvents)
          ? value.timelineEvents.filter(isPlainObject)
          : [];
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
    const tx = db.transaction([...ALL_V2_STORES], "readwrite");
    for (const storeName of ALL_V2_STORES) {
      tx.objectStore(storeName).clear();
    }
    writeSessionIntoV2Transaction(tx, session);
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
  const db = await getDb(factory);
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

function openDbInternal(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        return;
      }

      const ensureV2Stores = () => {
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        if (!db.objectStoreNames.contains(ROOMS_STORE)) {
          db.createObjectStore(ROOMS_STORE);
        }
        if (!db.objectStoreNames.contains(TIMELINES_STORE)) {
          db.createObjectStore(TIMELINES_STORE);
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

      if (event.oldVersion < 1 || !db.objectStoreNames.contains(LEGACY_STORE)) {
        ensureV2Stores();
        return;
      }

      try {
        ensureV2Stores();
        const legacyStore = tx.objectStore(LEGACY_STORE);
        const getReq = legacyStore.get(SESSION_KEY);
        getReq.onsuccess = () => {
          try {
            const rawSession = getReq.result;
            if (isPlainObject(rawSession)) {
              writeSessionIntoV2Transaction(tx, rawSession as SessionRecord);
            }
            if (db.objectStoreNames.contains(LEGACY_STORE)) {
              db.deleteObjectStore(LEGACY_STORE);
            }
          } catch {
            try {
              tx.abort();
            } catch {
              // ignore abort error
            }
          }
        };
        getReq.onerror = () => {
          try {
            tx.abort();
          } catch {
            // ignore abort error
          }
        };
      } catch {
        try {
          tx.abort();
        } catch {
          // ignore abort error
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

function writeSessionIntoV2Transaction(tx: IDBTransaction, rawSession: SessionRecord): void {
  const metaStore = tx.objectStore(META_STORE);
  const roomsStore = tx.objectStore(ROOMS_STORE);
  const timelinesStore = tx.objectStore(TIMELINES_STORE);
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
      roomsStore.put(roomMeta, roomId);
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
      timelinesStore.put({ timelineEvents: nextTimeline }, roomId);
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
