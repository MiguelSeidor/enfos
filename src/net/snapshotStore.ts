/**
 * Local match snapshots. Owner: NET.
 *
 * While an online match is played, the client saves the whole simulation to
 * the browser every few seconds. If the page is reloaded or the browser closed,
 * rejoining loads the latest one and replays only the turns after it, instead
 * of every turn since the match began.
 *
 * IndexedDB rather than `localStorage`: a snapshot of a late wave is hundreds
 * of kilobytes, past what `localStorage` reliably holds, and IndexedDB stores
 * the object graph by structured clone — Maps, shared references and exact
 * floating-point values (including −0) survive as they are, with no encoding.
 *
 * Only this browser's own snapshots are used. A snapshot received from another
 * player could be forged; one this browser wrote itself cannot, and the
 * server's checksum comparison still catches anything that went wrong.
 */

import type { SimSnapshot } from '@/core/engine';

const DB_NAME = 'nucleo-eterno';
const STORE = 'snapshots';

export interface SnapshotRecord {
  version: number;
  seed: number;
  tick: number;
  /** Checksum of the state at `tick`, to verify a restore. */
  hash: number;
  savedAt: number;
  data: SimSnapshot;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/**
 * Stores a snapshot under `key`, replacing the previous one. The record is
 * cloned synchronously by `put`, so the caller's objects may keep changing.
 */
export function saveSnapshot(key: string, record: SnapshotRecord): Promise<void> {
  return run('readwrite', (store) => store.put(record, key)).then(() => undefined);
}

export function loadSnapshot(key: string): Promise<SnapshotRecord | null> {
  return run<SnapshotRecord | undefined>('readonly', (store) => store.get(key)).then((r) => r ?? null);
}

/** Forgets every stored match: none of them can be rejoined any more. */
export function clearSnapshots(): Promise<void> {
  return run('readwrite', (store) => store.clear()).then(() => undefined);
}
