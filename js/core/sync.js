// Sync engine: encrypted shards <-> GitHub vault via the Git Data API.
// One commit per push, optimistic concurrency on the branch ref, merge-and-retry on conflict.
import { parseShardPath } from './schema.js';
import { encodeJson, decodeJson } from './crypto.js';
import { sleep } from './util.js';

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers); return out;
}

export function createSync({
  store, gh, key, cache, owner = 'app', onStatus = () => {}, commitMessage = 'forge: sync',
  pushDelayMs = 4000, minPushIntervalMs = 12000, pullIntervalMs = 60000, auto = true,
} = {}) {
  const state = { headSha: null, forgeTreeSha: null, remote: new Map(), pendingFiles: new Map(), lastPushAt: 0, lastSyncAt: 0 };
  let status = { state: 'idle', error: null, lastSyncAt: 0, pending: 0 };
  let running = null; let pushTimer = null; let persistTimer = null; let pullTimer = null; let wantPush = false; let disposed = false;

  function setStatus(patch) { status = { ...status, ...patch, pending: store.dirty().length + state.pendingFiles.size }; onStatus(status); }

  async function loadFromCache() {
    if (!cache) return 0;
    const meta = (await cache.getMeta('sync')) || {};
    state.headSha = meta.headSha || null; state.forgeTreeSha = meta.forgeTreeSha || null;
    const blobs = await cache.getAllBlobs();
    let n = 0;
    for (const b of blobs) {
      if (b.kind === 'file') { if (b.pending) state.pendingFiles.set(b.path, b.bytes); continue; }
      const info = parseShardPath(b.path);
      if (!info || (info.name === 'secrets' && store.owner === 'app')) continue;
      try {
        const plain = await decodeJson(key, b.path, b.bytes);
        store.loadShard(b.path, plain, { source: 'cache', dirty: !!b.dirty });
        if (b.sha) state.remote.set(b.path, b.sha);
        n++;
      } catch (e) { console.warn('[sync] cache entry unreadable', b.path, e.message); }
    }
    setStatus({});
    return n;
  }

  async function saveMeta() { if (cache) await cache.setMeta('sync', { headSha: state.headSha, forgeTreeSha: state.forgeTreeSha }); }

  // Persist our dirty shards (encrypted) to the local cache so offline edits survive reloads.
  async function persist() {
    if (!cache) return;
    for (const { path } of store.dirty()) {
      const bytes = await encodeJson(key, path, store.serializeShard(path));
      await cache.putBlob(path, { sha: state.remote.get(path) || null, bytes, dirty: true });
    }
  }

  async function pull() {
    const head = await gh.getHead();
    if (!head || head === state.headSha) return { changed: 0 };
    const commit = await gh.getCommit(head);
    const root = await gh.getTree(commit.tree.sha);
    const forge = root.tree.find((e) => e.path === 'forge' && e.type === 'tree');
    let changed = 0;
    if (forge && forge.sha !== state.forgeTreeSha) {
      const t = await gh.getTree(forge.sha, true);
      if (t.truncated) throw new Error('Vault tree listing truncated');
      const todo = [];
      for (const e of t.tree) {
        if (e.type !== 'blob') continue;
        const path = 'forge/' + e.path;
        const info = parseShardPath(path);
        if (!info || (info.name === 'secrets' && store.owner === 'app')) continue; // server tokens stay server-side
        if (state.remote.get(path) !== e.sha) todo.push({ path, sha: e.sha });
      }
      await mapLimit(todo, 4, async ({ path, sha }) => {
        const bytes = await gh.getBlob(sha);
        const plain = await decodeJson(key, path, bytes);
        const stillDirty = store.loadShard(path, plain, { source: 'remote' });
        state.remote.set(path, sha);
        if (cache) {
          if (stillDirty && store.shardInfo(path)?.owner === owner) {
            await cache.putBlob(path, { sha, bytes: await encodeJson(key, path, store.serializeShard(path)), dirty: true });
          } else {
            await cache.putBlob(path, { sha, bytes, dirty: false });
          }
        }
        changed++;
      });
      state.forgeTreeSha = forge.sha;
    }
    state.headSha = head;
    await saveMeta();
    return { changed };
  }

  async function push() {
    let dirty = store.dirty();
    if (!dirty.length && !state.pendingFiles.size) return { pushed: 0 };
    for (let attempt = 0; attempt < 6; attempt++) {
      const head = await gh.getHead();
      if (!head) throw new Error('Vault branch not found — run setup');
      if (head !== state.headSha) { await pull(); dirty = store.dirty(); if (!dirty.length && !state.pendingFiles.size) return { pushed: 0 }; }
      const items = await Promise.all(dirty.map(async (d) => ({
        path: d.path, rev: d.rev, bytes: await encodeJson(key, d.path, store.serializeShard(d.path)),
      })));
      const files = [...state.pendingFiles.entries()].map(([path, bytes]) => ({ path, bytes, file: true }));
      const all = [...items, ...files];
      const shas = await mapLimit(all, 3, (it) => gh.createBlob(it.bytes));
      const commit = await gh.getCommit(head);
      const tree = await gh.createTree(commit.tree.sha, all.map((it, i) => ({ path: it.path, mode: '100644', type: 'blob', sha: shas[i] })));
      const c = await gh.createCommit(commitMessage, tree, [head]);
      try {
        await gh.updateHead(c);
      } catch (e) {
        if (e.status === 422 || e.status === 409) { await sleep(300 + Math.random() * 700); continue; }
        throw e;
      }
      state.headSha = c; state.forgeTreeSha = null; state.lastPushAt = Date.now();
      for (let i = 0; i < all.length; i++) {
        const it = all[i];
        if (it.file) {
          state.pendingFiles.delete(it.path);
          if (cache) await cache.putBlob(it.path, { kind: 'file', sha: shas[i], bytes: it.bytes, pending: false });
          continue;
        }
        state.remote.set(it.path, shas[i]);
        store.markClean(it.path, it.rev);
        const stillDirty = store.shardInfo(it.path)?.dirty;
        if (cache) {
          await cache.putBlob(it.path, stillDirty
            ? { sha: shas[i], bytes: await encodeJson(key, it.path, store.serializeShard(it.path)), dirty: true }
            : { sha: shas[i], bytes: it.bytes, dirty: false });
        }
      }
      await saveMeta();
      return { pushed: all.length };
    }
    throw new Error('Could not commit after several retries (branch kept moving)');
  }

  // Serialize all network work.
  function run(kind) {
    const job = (running || Promise.resolve()).then(async () => {
      if (disposed) return;
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (!online) { setStatus({ state: 'offline' }); return; }
      try {
        setStatus({ state: kind === 'push' ? 'pushing' : 'pulling', error: null });
        if (kind === 'pull' || kind === 'sync') await pull();
        if (kind === 'push' || kind === 'sync') { wantPush = false; await push(); }
        state.lastSyncAt = Date.now();
        setStatus({ state: 'idle', lastSyncAt: state.lastSyncAt, error: null });
      } catch (e) {
        console.warn('[sync]', kind, e);
        // GitHub unreachable (fetch failed after retries): edits stay queued, same as offline.
        if (e && e.network) setStatus({ state: 'offline', error: null });
        else setStatus({ state: 'error', error: e.message || String(e) });
      }
    });
    running = job.finally(() => { if (running === job) running = null; });
    return job;
  }

  function schedulePush() {
    wantPush = true;
    clearTimeout(pushTimer);
    const since = Date.now() - state.lastPushAt;
    const delay = Math.max(pushDelayMs, minPushIntervalMs - since);
    pushTimer = setTimeout(() => { if (wantPush) run('sync'); }, delay);
  }
  function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(() => { persist().catch((e) => console.warn('[sync] persist', e)); }, 250); }

  // Our own writes: edits ('local') and shards merged in by an import ('import': backup, 'migration': v2).
  const OWN_SOURCES = ['local', 'import', 'migration'];
  const unsub = store.subscribe((ev) => {
    if (String(ev.source).split(',').some((s) => OWN_SOURCES.includes(s))) { schedulePersist(); if (auto) schedulePush(); setStatus({}); }
  });

  function onVisible() { if (typeof document !== 'undefined' && document.visibilityState === 'visible') run('sync'); else { persist(); } }
  function onOnline() { run('sync'); }
  if (auto && typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    pullTimer = setInterval(() => { if (document.visibilityState === 'visible') run('sync'); }, pullIntervalMs);
  }

  return {
    loadFromCache,
    pull: () => run('pull'),
    push: () => run('push'),
    sync: () => run('sync'),
    async flush() { clearTimeout(pushTimer); await persist(); return run('sync'); },
    queueFile(path, bytes) {
      state.pendingFiles.set(path, bytes);
      if (cache) cache.putBlob(path, { kind: 'file', sha: null, bytes, pending: true });
      if (auto) schedulePush(); setStatus({});
    },
    pendingFile: (path) => state.pendingFiles.get(path) || null,
    get status() { return status; },
    get headSha() { return state.headSha; },
    remoteSha: (path) => state.remote.get(path) || null,
    dispose() {
      disposed = true; unsub(); clearTimeout(pushTimer); clearTimeout(persistTimer); clearInterval(pullTimer);
      if (typeof window !== 'undefined') { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onOnline); }
    },
    _state: state,
  };
}
