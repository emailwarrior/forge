// Vault on disk (the Actions checkout): key check, shard loading, server-shard writing.
//
// - The DEK comes from FORGE_DATA_KEY and must match forge/keyring.json `kid`.
// - Every forge/**/*.enc shard is decrypted into one store (owner 'server').
// - Only forge/server/** is ever written. A shard is rewritten only when its records
//   actually changed, so re-syncing identical data leaves the working tree clean
//   (AES-GCM uses a fresh IV, so re-encrypting identical content would still differ).
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseShardPath, KEYRING_PATH, DATA_ROOT, COLLECTIONS } from '../js/core/schema.js';
import { importDek, keyId, encodeJson, decodeJson } from '../js/core/crypto.js';
import { b64ToBytes, stableStringify, deepEqual } from '../js/core/util.js';
import { shortError } from './log.mjs';

export class FatalError extends Error {
  constructor(message) { super(message); this.name = 'FatalError'; this.fatal = true; }
}

export const SERVER_PREFIX = `${DATA_ROOT}/server/`;

/* --------------------------------------------------------------- key */
export function parseDek(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new FatalError('FORGE_DATA_KEY is not set — add the data key as an Actions secret (the app does this during setup)');
  let raw;
  try { raw = b64ToBytes(text); } catch { raw = null; }
  if (!raw || raw.length !== 32) throw new FatalError('FORGE_DATA_KEY is malformed — expected base64 of a 32-byte key');
  return raw;
}

// Verify the DEK against forge/keyring.json and import it. Throws FatalError on mismatch.
export async function openVault({ root, dekB64 }) {
  const raw = parseDek(dekB64);
  let keyring;
  try {
    keyring = JSON.parse(await readFile(join(root, KEYRING_PATH), 'utf8'));
  } catch (e) {
    throw new FatalError(e && e.code === 'ENOENT'
      ? `${KEYRING_PATH} not found — run from the vault checkout root`
      : `${KEYRING_PATH} is unreadable`);
  }
  const kid = await keyId(raw);
  if (!keyring || typeof keyring.kid !== 'string' || keyring.kid !== kid) {
    throw new FatalError('FORGE_DATA_KEY does not match this vault (key id mismatch) — re-save the data key from the app');
  }
  const key = await importDek(raw);
  raw.fill(0);
  return { key, kid };
}

/* ------------------------------------------------------------ shards */
async function walk(dir, rel, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(join(dir, e.name), r, out);
    else if (e.isFile() && e.name.endsWith('.enc')) out.push(r);
  }
  return out;
}

export async function listShardPaths(root) {
  const files = await walk(join(root, DATA_ROOT), DATA_ROOT, []);
  return files.filter((p) => parseShardPath(p)).sort();
}

const fingerprint = (records) => createHash('sha256').update(stableStringify(records || {})).digest('hex');

// Decrypt every shard into the store. Returns bookkeeping the writer needs.
export async function loadVault({ root, key, store }) {
  const baseline = new Map();   // server shard path -> fingerprint of records on disk
  const unreadable = new Set();
  let loaded = 0; let app = 0; let server = 0;
  for (const path of await listShardPaths(root)) {
    try {
      const plain = await decodeJson(key, path, new Uint8Array(await readFile(join(root, path))));
      store.loadShard(path, plain, { source: 'vault', dirty: false });
      if (path.startsWith(SERVER_PREFIX)) { baseline.set(path, fingerprint(plain && plain.r)); server++; } else app++;
      loaded++;
    } catch (e) {
      unreadable.add(path);
    }
  }
  return { loaded, app, server, unreadable, baseline };
}

// Server-only collections have no other writer, so deleted records are dropped from the
// file outright instead of lingering as tombstones (the app treats server shards as
// authoritative and replaces its copy on load).
function physicalDelete(collection) {
  const d = COLLECTIONS[collection];
  return !!d && d.owners.length === 1 && d.owners[0] === 'server';
}

export function createWriter({ root, key, store, baseline, unreadable = new Set(), log }) {
  return {
    // Encrypt and write every changed server shard; returns the paths written.
    async flush() {
      const written = [];
      for (const { path, rev } of store.dirty()) {
        if (!path.startsWith(SERVER_PREFIX)) { log && log.warn(`refusing to write non-server shard`); continue; }
        if (unreadable.has(path)) { log && log.warn(`not overwriting an unreadable shard`); continue; }
        const shard = store.serializeShard(path);
        if (!shard) continue;
        if (physicalDelete(shard.c)) {
          const r = {};
          for (const id of Object.keys(shard.r)) if (!shard.r[id]._d) r[id] = shard.r[id];
          shard.r = r;
        }
        const fp = fingerprint(shard.r);
        const known = baseline.has(path);
        if ((known && baseline.get(path) === fp) || (!known && !Object.keys(shard.r).length)) {
          store.markClean(path, rev);
          continue;
        }
        const bytes = await encodeJson(key, path, shard);
        const abs = join(root, path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
        baseline.set(path, fp);
        store.markClean(path, rev);
        written.push(path);
      }
      return written;
    },
  };
}

/* ----------------------------------------------------------- records */
// Upsert a server record only when its values changed. `t` (ms) becomes the field time
// (e.g. Date.parse(updated_at) from the source) so newer source data wins merges and
// identical re-syncs are no-ops. Returns true when something was written.
export function putRecord(ctx, coll, id, fields, t = null) {
  const cur = ctx.store.getAny(coll, id);
  let patch = fields;
  if (cur) {
    patch = {};
    for (const k of Object.keys(fields)) if (!deepEqual(cur[k], fields[k])) patch[k] = fields[k];
    if (cur._d) patch._d = null;
    if (!Object.keys(patch).length) return false;
  }
  ctx.withTime(Number.isFinite(t) ? t : null, () => ctx.store.update(coll, id, patch));
  return true;
}

export function removeRecord(ctx, coll, id) {
  const cur = ctx.store.getAny(coll, id);
  if (!cur || cur._d) return false;
  ctx.store.remove(coll, id);
  return true;
}

// status/<id> = { lastRunAt, lastOkAt, lastError, detail }. A skipped run clears the
// error but does not count as a success.
export function writeStatus(ctx, id, { ok, skipped = false, error = null, detail, extra = {} }) {
  const nowIso = new Date(ctx.now()).toISOString();
  const cur = ctx.store.get('status', id);
  const fields = {
    lastRunAt: nowIso,
    lastError: ok || skipped ? null : shortError(error || 'failed'),
    detail: detail ?? (cur && cur.detail) ?? {},
    ...extra,
  };
  if (ok && !skipped) fields.lastOkAt = nowIso;
  else if (!cur || cur.lastOkAt === undefined) fields.lastOkAt = null;
  putRecord(ctx, 'status', id, fields);
}
