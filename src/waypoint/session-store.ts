export type SessionRecord = {
  baseUrl: string;
  userId: string;
  accessToken?: string;
  deviceId?: string;
  syncCursor?: string;
  accountData?: Record<string, unknown>;
};

const DB_NAME = "waypoint";
const STORE = "records";
const SESSION_KEY = "session";

export async function loadSession(): Promise<SessionRecord | undefined> {
  const db = await openDb();
  try {
    return await requestToPromise(store(db, "readonly").get(SESSION_KEY));
  } finally {
    db.close();
  }
}

export async function saveSession(session: SessionRecord): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(store(db, "readwrite").put(session, SESSION_KEY));
  } finally {
    db.close();
  }
}

export async function dropCredential(): Promise<void> {
  const current = await loadSession();
  if (!current) {
    return;
  }
  const next: SessionRecord = { baseUrl: current.baseUrl, userId: current.userId };
  if (current.syncCursor) {
    next.syncCursor = current.syncCursor;
  }
  if (current.accountData && Object.keys(current.accountData).length > 0) {
    next.accountData = current.accountData;
  }
  await saveSession(next);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
