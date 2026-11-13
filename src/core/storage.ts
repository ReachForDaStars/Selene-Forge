import type { ProjectSnapshot } from './types';

const DB_NAME = 'selene-forge';
const DB_VERSION = 1;
const STORE = 'workspace';
const KEY = 'snapshot';
const LOCAL_KEY = 'selene-forge:snapshot';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(STORE, mode);
        } catch {
          resolve(null);
          return;
        }
        const store = transaction.objectStore(STORE);
        const request = work(store);
        if (!request) {
          resolve(null);
          return;
        }
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
      }),
  );
}

export async function loadSnapshot(): Promise<ProjectSnapshot | null> {
  const fromDb = await withStore<ProjectSnapshot>('readonly', (store) => store.get(KEY));
  if (fromDb && Array.isArray(fromDb.files)) return migrate(fromDb);
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectSnapshot;
      if (parsed && Array.isArray(parsed.files)) return migrate(parsed);
    }
  } catch {
    /* ignore corrupt local storage */
  }
  return null;
}

export async function saveSnapshot(snapshot: ProjectSnapshot): Promise<boolean> {
  const saved = await withStore<IDBValidKey>('readwrite', (store) => store.put(snapshot, KEY));
  if (saved !== null) return true;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

export async function clearSnapshot(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(KEY));
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignore */
  }
}

function migrate(snapshot: ProjectSnapshot): ProjectSnapshot {
  return {
    ...snapshot,
    version: 1,
    installed: Array.isArray(snapshot.installed) ? snapshot.installed : [],
    folders: Array.isArray(snapshot.folders) ? snapshot.folders : [],
    openTabs: Array.isArray(snapshot.openTabs) ? snapshot.openTabs : [],
  };
}
