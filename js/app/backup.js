// Decrypted backup export/import (Settings → Data, #/import/backup).
// Format: { format: 'forge-backup', version: 1, schema, exportedAt, collections: { <name>: [record, ...] } }
// Records keep their merge metadata (_c/_u/_f/_d), so an import is a normal CRDT merge: newer field times win.
// A backup file is untrusted input: records are sanitized, future field times are clamped, and wiring
// (push endpoints, integration and security settings) is never imported.
import { COLLECTIONS, SCHEMA, shardPath, periodOf } from '../core/schema.js';
import { sanitizeRecordMap } from '../core/merge.js';

const NEVER_EXPORT = new Set(['secrets']); // server tokens never leave the vault
// A planted push endpoint would receive every notification; device/integration settings (calendar IDs,
// lock mode) belong to this vault's setup, not to a restored copy of the data.
const NEVER_IMPORT = new Set(['secrets', 'pushSubs']);
const NEVER_IMPORT_SETTINGS = new Set(['integrations', 'security']);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function exportBackup(store, { includeServer = true, now = new Date() } = {}) {
  const collections = {};
  let records = 0;
  for (const name of Object.keys(COLLECTIONS)) {
    if (NEVER_EXPORT.has(name)) continue;
    if (!includeServer && !COLLECTIONS[name].owners.includes('app')) continue;
    const list = store.all(name, { includeDeleted: true });
    if (list.length) { collections[name] = list.map((r) => ({ ...r })); records += list.length; }
  }
  return { format: 'forge-backup', version: 1, schema: SCHEMA, exportedAt: now.toISOString(), records, collections };
}

export function isBackup(obj) {
  return !!obj && typeof obj === 'object' && obj.format === 'forge-backup' && !!obj.collections && typeof obj.collections === 'object' && !Array.isArray(obj.collections);
}

/** Summarize a backup without importing: [{ name, count, importable }] */
export function describeBackup(obj) {
  if (!isBackup(obj)) return [];
  return Object.keys(obj.collections).filter((name) => hasOwn(COLLECTIONS, name) && Array.isArray(obj.collections[name])).map((name) => ({
    name, count: obj.collections[name].length, importable: COLLECTIONS[name].owners.includes('app') && !NEVER_IMPORT.has(name),
  }));
}

/**
 * Merge a backup into the store's app shards. Server-only collections are skipped (automation re-syncs them).
 * Returns { collections, records, skipped: [name] }.
 */
export function importBackup(store, obj, { now = Date.now() } = {}) {
  if (!isBackup(obj)) throw new Error('That file is not a FORGE backup.');
  if (Number(obj.schema) > SCHEMA) throw new Error('This backup was made by a newer FORGE version.');
  const summary = { collections: 0, records: 0, skipped: [] };
  const maxTime = now + 86400000; // field times from the future would beat every later edit
  for (const name of Object.keys(obj.collections)) {
    const list = obj.collections[name];
    if (!hasOwn(COLLECTIONS, name) || !Array.isArray(list)) continue;
    const def = COLLECTIONS[name];
    if (!def.owners.includes('app') || NEVER_IMPORT.has(name)) { summary.skipped.push(name); continue; }
    // Key records by id (null-prototype map), then sanitize: drops '__proto__' ids/fields and bad shapes.
    const byId = Object.create(null);
    for (const rec of list) if (rec && typeof rec === 'object' && typeof rec.id === 'string' && rec.id !== '__proto__') byId[rec.id] = rec;
    const plain = {};
    for (const id of Object.keys(byId)) plain[id] = byId[id]; // '__proto__' excluded above
    const clean = sanitizeRecordMap(plain, { maxTime });
    const byPath = new Map();
    for (const id of Object.keys(clean)) {
      if (name === 'settings' && NEVER_IMPORT_SETTINGS.has(id)) { if (!summary.skipped.includes('settings.' + id)) summary.skipped.push('settings.' + id); continue; }
      const rec = clean[id];
      const path = shardPath(name, 'app', periodOf(name, rec));
      if (!byPath.has(path)) byPath.set(path, {});
      byPath.get(path)[id] = rec;
    }
    for (const [path, r] of byPath) {
      const period = periodOf(name, Object.values(r)[0]) || null;
      store.loadShard(path, { schema: SCHEMA, c: name, o: 'app', p: period, r }, { source: 'import', dirty: true });
      summary.records += Object.keys(r).length;
    }
    if (byPath.size) summary.collections++;
  }
  return summary;
}
