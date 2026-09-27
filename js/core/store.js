// In-memory record store over shards. Same code runs in the browser (owner 'app')
// and in automation (owner 'server'). Persistence and sync live elsewhere.
import { COLLECTIONS, collectionDef, periodOf, shardPath, parseShardPath, SETTINGS_DEFAULTS, SCHEMA } from './schema.js';
import { makeRecord, patchRecord, mergeRecords, mergeRecordMaps, isLive, pruneTombstones, sameRecordMaps, sanitizeRecordMap } from './merge.js';
import { uid, clone } from './util.js';

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepDefaults(defaults, value) {
  if (!isPlainObject(defaults)) return value === undefined ? clone(defaults) : value;
  const out = {};
  const src = isPlainObject(value) ? value : {};
  for (const k of new Set([...Object.keys(defaults), ...Object.keys(src)])) {
    out[k] = k in defaults ? deepDefaults(defaults[k], src[k]) : src[k];
  }
  return out;
}

export function createStore({ owner = 'app', clock = () => Date.now() } = {}) {
  const shards = new Map();          // path -> { name, owner, period, records, dirty, rev }
  const locations = new Map();       // coll -> Map(id -> Set(path))
  const merged = new Map();          // coll -> Map(id -> record)
  const cache = new Map();           // coll -> { all, sorted }
  const listeners = new Set();
  let version = 0;
  let pending = null;

  const collMap = (m, c) => { if (!m.has(c)) m.set(c, new Map()); return m.get(c); };

  function emit(collections, source) {
    version++;
    if (!pending) {
      pending = { collections: new Set(), sources: new Set() };
      queueMicrotask(() => {
        const ev = { collections: pending.collections, source: [...pending.sources].join(','), version };
        pending = null;
        for (const fn of [...listeners]) { try { fn(ev); } catch (e) { console.error('[store] listener', e); } }
      });
    }
    for (const c of collections) pending.collections.add(c);
    pending.sources.add(source);
  }

  function recomputeIds(coll, ids) {
    const locs = collMap(locations, coll); const view = collMap(merged, coll);
    for (const id of ids) {
      const paths = locs.get(id);
      let m = null;
      if (paths) for (const p of paths) { const r = shards.get(p)?.records[id]; if (r) m = m ? mergeRecords(m, r) : r; }
      if (m) view.set(id, m); else view.delete(id);
    }
    cache.delete(coll);
  }

  function ensureShard(path) {
    let s = shards.get(path);
    if (!s) {
      const info = parseShardPath(path);
      if (!info) throw new Error('Not a shard path: ' + path);
      s = { ...info, records: {}, dirty: false, rev: 0 };
      shards.set(path, s);
    }
    return s;
  }

  function indexShard(path, ids) {
    const s = shards.get(path); const locs = collMap(locations, s.name);
    for (const id of ids) {
      if (s.records[id]) { if (!locs.has(id)) locs.set(id, new Set()); locs.get(id).add(path); }
      else locs.get(id)?.delete(path);
    }
    recomputeIds(s.name, ids);
  }

  // Load a decoded shard.
  // - Shards written by the other party are authoritative: they replace the local copy.
  // - Our own shards are merged (other devices of the same owner may have written them).
  // Returns true if our copy now holds changes the incoming shard does not have.
  function loadShard(path, plain, { source = 'remote', dirty } = {}) {
    const s = ensureShard(path);
    const incoming = sanitizeRecordMap(plain && plain.r); // decrypted data is still input: never trust its shape
    const before = s.records;
    const own = s.owner === owner;
    const next = own ? pruneTombstones(mergeRecordMaps(before, incoming), clock()) : incoming;
    s.records = next;
    const differs = own ? !sameRecordMaps(next, incoming) : false;
    if (own) {
      if (dirty === true || differs) { s.dirty = true; s.rev++; }
      else if (!differs) s.dirty = false;
    }
    const ids = new Set([...Object.keys(before), ...Object.keys(next)]);
    indexShard(path, ids);
    emit([s.name], source);
    return differs;
  }

  function getMerged(coll, id) { return merged.get(coll)?.get(id) || null; }

  function writeRecord(coll, rec) {
    const def = collectionDef(coll);
    if (!def.owners.includes(owner)) throw new Error(`${owner} cannot write ${coll}`);
    const path = shardPath(coll, owner, periodOf(coll, rec));
    const s = ensureShard(path);
    const touched = [path];
    // If the record moved period, drop it from our other shards of this collection.
    const locs = locations.get(coll)?.get(rec.id);
    if (locs) for (const p of [...locs]) {
      if (p === path) continue;
      const o = shards.get(p);
      if (o && o.owner === owner && o.records[rec.id]) {
        const copy = { ...o.records }; delete copy[rec.id]; o.records = copy; o.dirty = true; o.rev++; touched.push(p);
      }
    }
    s.records = { ...s.records, [rec.id]: rec }; s.dirty = true; s.rev++;
    for (const p of touched) indexShard(p, [rec.id]);
    emit([coll], 'local');
    return getMerged(coll, rec.id);
  }

  function update(coll, id, patch) {
    const now = clock();
    const cur = getMerged(coll, id);
    const next = cur ? patchRecord(cur, patch, now) : makeRecord(id, patch, now);
    return writeRecord(coll, next);
  }

  function create(coll, fields = {}) {
    const id = fields.id || uid();
    const { id: _ignored, ...rest } = fields;
    if (getMerged(coll, id)) return update(coll, id, { ...rest, _d: null });
    return writeRecord(coll, makeRecord(id, rest, clock()));
  }

  function all(coll, { includeDeleted = false } = {}) {
    collectionDef(coll);
    let c = cache.get(coll);
    if (!c) { c = {}; cache.set(coll, c); }
    const key = includeDeleted ? 'allDel' : 'all';
    if (!c[key]) {
      const vals = [...(merged.get(coll)?.values() || [])];
      c[key] = includeDeleted ? vals : vals.filter(isLive);
    }
    return c[key];
  }

  function sortedByDate(coll) {
    let c = cache.get(coll); if (!c) { c = {}; cache.set(coll, c); }
    if (!c.sorted) c.sorted = all(coll).filter((r) => typeof r.date === 'string').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || a.start || '') < (b.at || b.start || '') ? -1 : 1));
    return c.sorted;
  }
  function lowerBound(arr, date) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].date < date) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function range(coll, from, to) {
    const arr = sortedByDate(coll); const out = [];
    for (let i = lowerBound(arr, from); i < arr.length && arr[i].date <= to; i++) out.push(arr[i]);
    return out;
  }

  function setting(id) {
    const rec = getMerged('settings', id);
    const fields = {};
    if (rec && isLive(rec)) for (const k in rec) if (!k.startsWith('_') && k !== 'id') fields[k] = rec[k];
    return deepDefaults(SETTINGS_DEFAULTS[id] || {}, fields);
  }
  function updateSetting(id, patch) {
    const cur = setting(id); const p = {};
    for (const k of Object.keys(patch)) p[k] = isPlainObject(patch[k]) && isPlainObject(cur[k]) ? { ...cur[k], ...patch[k] } : patch[k];
    return update('settings', id, p);
  }

  function serializeShard(path) {
    const s = shards.get(path); if (!s) return null;
    return { schema: SCHEMA, c: s.name, o: s.owner, p: s.period || null, r: pruneTombstones(s.records, clock()) };
  }

  return {
    owner,
    get version() { return version; },
    collections: Object.keys(COLLECTIONS),
    loadShard,
    all,
    get: (coll, id) => { const r = getMerged(coll, id); return r && isLive(r) ? r : null; },
    getAny: (coll, id) => getMerged(coll, id),
    byDate: (coll, date) => range(coll, date, date),
    range,
    create,
    update,
    // upsert = "write these fields at this id": revives a deleted record (fixed ids: checks, days, reviews, savedQuotes…).
    // update keeps a deleted record deleted (e.g. an AI result arriving after the user deleted the meal).
    upsert: (coll, id, fields) => { const cur = getMerged(coll, id); return update(coll, id, cur && cur._d && !('_d' in fields) ? { ...fields, _d: null } : fields); },
    remove: (coll, id) => (getMerged(coll, id) ? update(coll, id, { _d: 1 }) : null),
    restore: (coll, id) => update(coll, id, { _d: null }),
    setting,
    updateSetting,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    shardPaths: () => [...shards.keys()],
    shardInfo: (path) => { const s = shards.get(path); return s ? { name: s.name, owner: s.owner, period: s.period, dirty: s.dirty, rev: s.rev, count: Object.keys(s.records).length } : null; },
    dirty: () => [...shards.entries()].filter(([, s]) => s.dirty && s.owner === owner).map(([path, s]) => ({ path, rev: s.rev })),
    markClean(path, rev) { const s = shards.get(path); if (s && (rev === undefined || s.rev === rev)) s.dirty = false; },
    markDirty(path) { const s = ensureShard(path); if (s.owner === owner) { s.dirty = true; s.rev++; } },
    serializeShard,
  };
}
