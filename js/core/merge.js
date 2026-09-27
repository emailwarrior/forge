// Per-field last-writer-wins records (state-based CRDT). See docs/ARCHITECTURE.md §4.
import { stableStringify } from './util.js';

export const META_KEYS = new Set(['id', '_c', '_u', '_f']);
const UNSAFE_KEY = '__proto__'; // JSON.parse makes it an own key; assigning it to a plain object would swap the prototype
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const TOMBSTONE_TTL_MS = 180 * 86400000;

export function fieldTime(rec, k) {
  const f = rec._f && rec._f[k];
  return typeof f === 'number' ? f : (rec._c || 0);
}
export function isLive(rec) { return !!rec && !rec._d; }

function recomputeU(rec) {
  let u = rec._c || 0;
  if (rec._f) for (const k in rec._f) if (rec._f[k] > u) u = rec._f[k];
  rec._u = u; return rec;
}

// Normalize: drop _f entries equal to _c, drop empty _f, ensure _u.
export function normalize(rec) {
  if (rec._f) {
    for (const k of Object.keys(rec._f)) {
      if (!(k in rec) || rec._f[k] === rec._c) delete rec._f[k];
    }
    if (!Object.keys(rec._f).length) delete rec._f;
  }
  return recomputeU(rec);
}

// Create a new record. Every field gets time `now` via _c.
export function makeRecord(id, fields, now) {
  const rec = { id, _c: now };
  for (const k of Object.keys(fields || {})) {
    if (META_KEYS.has(k) || fields[k] === undefined) continue;
    rec[k] = fields[k];
  }
  rec._u = now; return rec;
}

// Apply a patch to an existing record (returns a new object).
export function patchRecord(rec, patch, now) {
  const out = { ...rec, _f: { ...(rec._f || {}) } };
  // Clock skew guard: a patch must never be older than the fields it overwrites.
  for (const k of Object.keys(patch || {})) {
    if (META_KEYS.has(k)) continue;
    const t = Math.max(now, fieldTime(rec, k) + 1);
    out[k] = patch[k] === undefined ? null : patch[k];
    out._f[k] = t;
  }
  return normalize(out);
}

function cmpValues(a, b) {
  const sa = stableStringify(a), sb = stableStringify(b);
  return sa === sb ? 0 : (sa > sb ? 1 : -1);
}

// Merge two versions of the same record id.
export function mergeRecords(a, b) {
  if (!a) return b; if (!b) return a;
  if (a === b) return a;
  const out = { id: a.id, _c: Math.min(a._c || 0, b._c || 0) };
  const f = {};
  const keys = new Set();
  for (const k of Object.keys(a)) if (!META_KEYS.has(k) && k !== UNSAFE_KEY) keys.add(k);
  for (const k of Object.keys(b)) if (!META_KEYS.has(k) && k !== UNSAFE_KEY) keys.add(k);
  for (const k of keys) {
    const inA = k in a, inB = k in b;
    let val, t;
    if (inA && !inB) { val = a[k]; t = fieldTime(a, k); }
    else if (!inA && inB) { val = b[k]; t = fieldTime(b, k); }
    else {
      const ta = fieldTime(a, k), tb = fieldTime(b, k);
      if (ta > tb) { val = a[k]; t = ta; }
      else if (tb > ta) { val = b[k]; t = tb; }
      else { val = cmpValues(a[k], b[k]) >= 0 ? a[k] : b[k]; t = ta; }
    }
    out[k] = val;
    if (t !== out._c) f[k] = t;
  }
  if (Object.keys(f).length) out._f = f;
  return recomputeU(out);
}

// Merge record maps { id: record } (shards). Returns a new map; inputs untouched.
export function mergeRecordMaps(a, b) {
  const out = { ...(a || {}) };
  for (const id of Object.keys(b || {})) {
    if (id === UNSAFE_KEY || !isObj(b[id])) continue;
    out[id] = out[id] ? mergeRecords(out[id], b[id]) : b[id];
  }
  return out;
}

/**
 * Clean an untrusted record map (a decrypted shard or a backup file): keeps plain-object records whose
 * id matches their key and that have a numeric _c; drops '__proto__' ids/fields and malformed _f.
 * maxTime clamps field times (a backup must not carry times from the future that later edits cannot beat).
 */
export function sanitizeRecordMap(map, { maxTime = Infinity } = {}) {
  const out = {};
  if (!isObj(map)) return out;
  for (const id of Object.keys(map)) {
    if (id === UNSAFE_KEY || !id || id.length > 512) continue;
    const r = map[id];
    if (!isObj(r) || r.id !== id || !Number.isFinite(r._c)) continue;
    const rec = {};
    for (const k of Object.keys(r)) if (k !== UNSAFE_KEY && r[k] !== undefined) rec[k] = r[k];
    rec._c = Math.min(rec._c, maxTime);
    if ('_f' in rec) {
      const f = {};
      if (isObj(rec._f)) for (const k of Object.keys(rec._f)) if (k !== UNSAFE_KEY && Number.isFinite(rec._f[k])) f[k] = Math.min(rec._f[k], maxTime);
      rec._f = f;
    }
    out[id] = normalize(rec);
  }
  return out;
}

// Structural equality of two shard record maps (used to detect no-op writes).
export function sameRecordMaps(a, b) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  for (const id of ka) {
    if (!b[id]) return false;
    if (stableStringify(a[id]) !== stableStringify(b[id])) return false;
  }
  return true;
}

// Drop tombstones whose deletion is older than the TTL.
export function pruneTombstones(map, now) {
  const out = {};
  for (const id of Object.keys(map || {})) {
    const r = map[id];
    if (id === UNSAFE_KEY || !isObj(r)) continue;
    if (r._d && now - fieldTime(r, '_d') > TOMBSTONE_TTL_MS) continue;
    out[id] = r;
  }
  return out;
}
