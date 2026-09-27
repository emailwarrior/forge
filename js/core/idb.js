// Local cache. Browser: IndexedDB (encrypted blobs only + non-extractable keys).
// Tests / Node: in-memory implementation with the same interface.

export function memoryCache() {
  const blobs = new Map(); const meta = new Map();
  return {
    async getMeta(k) { return meta.has(k) ? structuredClone(meta.get(k)) : null; },
    async setMeta(k, v) { meta.set(k, v); },
    async delMeta(k) { meta.delete(k); },
    async getAllBlobs() { return [...blobs.values()].map((b) => ({ ...b })); },
    async getBlob(path) { return blobs.get(path) || null; },
    async putBlob(path, rec) { blobs.set(path, { path, ...rec }); },
    async deleteBlob(path) { blobs.delete(path); },
    async clear() { blobs.clear(); meta.clear(); },
    _blobs: blobs, _meta: meta,
  };
}

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export async function openCache(name = 'forge-v3') {
  if (typeof indexedDB === 'undefined') return memoryCache();
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'path' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Local database is blocked by another open tab'));
  });
  const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
  return {
    getMeta: (k) => req(tx('meta').get(k)).then((v) => (v === undefined ? null : v)),
    setMeta: (k, v) => req(tx('meta', 'readwrite').put(v, k)),
    delMeta: (k) => req(tx('meta', 'readwrite').delete(k)),
    getAllBlobs: () => req(tx('blobs').getAll()),
    getBlob: (path) => req(tx('blobs').get(path)).then((v) => v || null),
    putBlob: (path, rec) => req(tx('blobs', 'readwrite').put({ path, ...rec })),
    deleteBlob: (path) => req(tx('blobs', 'readwrite').delete(path)),
    async clear() { await req(tx('blobs', 'readwrite').clear()); await req(tx('meta', 'readwrite').clear()); },
    close: () => db.close(),
  };
}

export async function deleteCache(name = 'forge-v3') {
  if (typeof indexedDB === 'undefined') return;
  await new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}
