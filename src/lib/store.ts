// Tiny IndexedDB key/value store so a session (clip, faces, shots, frames, settings)
// survives a reload. Blobs are stored as is.

const DB = "getmotion";
const STORE = "session";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode);
    const r = run(t.objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    t.oncomplete = () => db.close();
  });
}

export const kv = {
  get: <T>(key: string) => tx<T | undefined>("readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
  set: (key: string, value: unknown) => tx("readwrite", (s) => s.put(value, key)),
  del: (key: string) => tx("readwrite", (s) => s.delete(key)),
  clear: () => tx("readwrite", (s) => s.clear()),
};

export type SavedSession = {
  video?: { blob: Blob; name: string; type: string };
  cast: { blob: Blob; name: string; type: string; who: string }[];
  shots: { blob: Blob; name: string }[];
  frames: { blob: Blob; frame: number; time: number }[];
  modelId: string;
  prompt: string;
  maxLen: number;
  savedAt: number;
};
