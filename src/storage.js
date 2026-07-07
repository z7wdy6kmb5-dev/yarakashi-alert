// ============================================================
// storage.js — IndexedDBラッパー
// Claudeアーティファクトの window.storage と同じAPI形状にしてあるので
// App.jsx側の呼び出しコードはほぼ無変更で動く
// ============================================================

const DB_NAME = "yarakashi-alert";
const STORE = "kv";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export const storage = {
  async get(key) {
    const value = await tx("readonly", (s) => s.get(key));
    return value === undefined ? null : { key, value };
  },
  async set(key, value) {
    await tx("readwrite", (s) => s.put(value, key));
    return { key, value };
  },
  async delete(key) {
    await tx("readwrite", (s) => s.delete(key));
    return { key, deleted: true };
  },
};
