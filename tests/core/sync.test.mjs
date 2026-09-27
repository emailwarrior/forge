import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { createSync } from '../../js/core/sync.js';
import { memoryCache } from '../../js/core/idb.js';
import * as C from '../../js/core/crypto.js';
import { makeRecord } from '../../js/core/merge.js';
import { createMockRepo } from '../helpers/mock-github.mjs';

async function device(repo, key, { cache = memoryCache(), owner = 'app', clock } = {}) {
  const store = createStore({ owner, clock });
  const sync = createSync({ store, gh: repo.gh, key, cache, owner, auto: false });
  await sync.loadFromCache();
  return { store, sync, cache };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('sync: two devices converge, per-field merge on concurrent edits', async () => {
  const repo = createMockRepo(); await repo.gh.putFile('README.md', new TextEncoder().encode('x'), 'init');
  const key = await C.importDek(C.randomBytes(32));
  const A = await device(repo, key); const B = await device(repo, key);

  const rec = A.store.create('days', { id: '2026-09-26', date: '2026-09-26', energy: 3, mood: 3 });
  await A.sync.sync();
  await B.sync.sync();
  assert.equal(B.store.get('days', rec.id).energy, 3);

  // concurrent edits of different fields on each device
  A.store.update('days', rec.id, { energy: 5 });
  B.store.update('days', rec.id, { mood: 1 });
  await A.sync.sync();
  await B.sync.sync(); // B's head is stale -> pull, merge, push
  await A.sync.sync();
  for (const d of [A, B]) {
    const r = d.store.get('days', rec.id);
    assert.equal(r.energy, 5); assert.equal(r.mood, 1);
    assert.equal(d.store.dirty().length, 0);
  }
  // files in the repo are encrypted
  for (const [path, sha] of repo.files()) if (path.startsWith('forge/')) assert.ok(C.isEncryptedBlob(repo.blob(sha)), path);
});

test('sync: race on the branch ref retries and loses nothing', async () => {
  const repo = createMockRepo(); await repo.gh.putFile('README.md', new TextEncoder().encode('x'), 'init');
  const key = await C.importDek(C.randomBytes(32));
  const A = await device(repo, key); const B = await device(repo, key);
  for (let i = 0; i < 5; i++) A.store.create('journal', { date: '2026-09-26', text: 'A' + i });
  for (let i = 0; i < 5; i++) B.store.create('journal', { date: '2026-09-26', text: 'B' + i });
  // interleave: both read head, A commits first; B's ref update must fail then retry
  await Promise.all([A.sync.sync(), B.sync.sync()]);
  await A.sync.sync(); await B.sync.sync();
  assert.equal(A.store.all('journal').length, 10);
  assert.equal(B.store.all('journal').length, 10);
});

test('sync: automation writes server shards; app push never clobbers them', async () => {
  const repo = createMockRepo(); await repo.gh.putFile('README.md', new TextEncoder().encode('x'), 'init');
  const key = await C.importDek(C.randomBytes(32));
  const A = await device(repo, key);
  A.store.create('meals', { date: '2026-09-26', note: 'lunch' });
  await A.sync.sync();
  // "automation" writes a server shard directly
  const path = 'forge/server/whoopRecovery/2026.enc';
  await repo.externalWrite(path, await C.encodeJson(key, path, { schema: 3, c: 'whoopRecovery', o: 'server', p: '2026', r: { c1: makeRecord('c1', { date: '2026-09-26', recovery: 71 }, 5) } }));
  A.store.create('meals', { date: '2026-09-26', note: 'dinner' });
  await A.sync.sync();
  assert.equal(A.store.get('whoopRecovery', 'c1').recovery, 71);
  assert.ok(repo.files().has(path));
  const serverBlob = repo.blob(repo.files().get(path));
  assert.equal((await C.decodeJson(key, path, serverBlob)).r.c1.recovery, 71);
});

test('sync: offline edits persist in the cache and push after reload', async () => {
  const repo = createMockRepo(); await repo.gh.putFile('README.md', new TextEncoder().encode('x'), 'init');
  const key = await C.importDek(C.randomBytes(32));
  const cache = memoryCache();
  const A = await device(repo, key, { cache });
  A.store.create('body', { date: '2026-09-26', weightLb: 161.4 });
  await A.sync.flush(); // persist + push
  A.store.create('body', { date: '2026-09-27', weightLb: 161.0 });
  // simulate: persisted locally but never pushed (app closed)
  await new Promise((r) => setTimeout(r, 300));
  A.sync.dispose();
  const A2 = await device(repo, key, { cache });
  assert.equal(A2.store.all('body').length, 2, 'reload restores both entries from cache');
  assert.ok(A2.store.dirty().length > 0, 'unpushed edits are still dirty');
  await A2.sync.sync();
  const fresh = await device(repo, key);
  await fresh.sync.sync();
  assert.equal(fresh.store.all('body').length, 2);
});

test('sync: imported shards (backup merge, v2 migration) are persisted and pushed without another edit', async () => {
  const { importBackup } = await import('../../js/app/backup.js');
  const { buildV2Migration, applyMigration } = await import('../../js/core/migrate.js');
  const repo = createMockRepo(); await repo.gh.putFile('README.md', new TextEncoder().encode('x'), 'init');
  const key = await C.importDek(C.randomBytes(32));
  const cache = memoryCache();
  const store = createStore({ owner: 'app' });
  const sync = createSync({ store, gh: repo.gh, key, cache, auto: true, pushDelayMs: 5, minPushIntervalMs: 0 });
  importBackup(store, { format: 'forge-backup', version: 1, schema: 3, collections: { journal: [makeRecord('j1', { date: '2026-09-26', text: 'from backup' }, 5)] } });
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return fn(); };
  assert.ok(await until(() => repo.files().has('forge/app/journal/2026.enc')), 'backup import pushed');
  assert.ok(cache._blobs.has('forge/app/journal/2026.enc'), 'backup import persisted locally');
  // A v2 import that retires no seed emits only the 'migration' source.
  applyMigration(store, buildV2Migration({ tasks: [{ id: 't1', name: 'Stretch' }], log: {}, updatedAt: 1758200000000 }, { tz: 'UTC' }));
  assert.ok(await until(() => repo.files().has('forge/app/standards.enc')), 'v2 migration pushed');
  await until(() => !sync.status.pending);
  assert.equal(store.dirty().length, 0);
  sync.dispose();
});

test('sync: GitHub unreachable reports offline (not an error), keeps edits queued, pushes once reachable', async () => {
  const repo = createMockRepo(); await repo.gh.putFile('README.md', new TextEncoder().encode('x'), 'init');
  const key = await C.importDek(C.randomBytes(32));
  let down = true;
  const gh = { ...repo.gh, async getHead() { if (down) throw Object.assign(new Error('Network error: Failed to fetch'), { status: 0, network: true }); return repo.gh.getHead(); } };
  const states = [];
  const store = createStore({ owner: 'app' });
  const sync = createSync({ store, gh, key, cache: memoryCache(), auto: false, onStatus: (s) => states.push(s) });
  store.create('body', { date: '2026-09-26', weightLb: 181.2 });
  await sync.sync();
  const last = states[states.length - 1];
  assert.equal(last.state, 'offline');
  assert.equal(last.error, null);
  assert.equal(last.pending, 1);
  assert.equal(repo.files().has('forge/app/body/2026.enc'), false);
  down = false;
  await sync.sync();
  assert.equal(states[states.length - 1].state, 'idle');
  assert.equal(states[states.length - 1].pending, 0);
  assert.ok(repo.files().has('forge/app/body/2026.enc'));
  // Other failures still surface as errors.
  const broken = createSync({ store, gh: { ...repo.gh, async getHead() { throw Object.assign(new Error('Bad credentials'), { status: 401 }); } }, key, auto: false, onStatus: (s) => states.push(s) });
  store.create('body', { date: '2026-09-27', weightLb: 181.0 });
  await broken.sync();
  assert.equal(states[states.length - 1].state, 'error');
  assert.equal(states[states.length - 1].error, 'Bad credentials');
  sync.dispose(); broken.dispose();
});

test('sync: queued media files ride along in the next commit', async () => {
  const repo = createMockRepo(); await repo.gh.putFile('README.md', new TextEncoder().encode('x'), 'init');
  const key = await C.importDek(C.randomBytes(32));
  const A = await device(repo, key);
  const bytes = await C.encryptBytes(key, new Uint8Array([1, 2, 3, 4]), 'media/meals/2026/09/m1.enc', { compress: false });
  A.sync.queueFile('media/meals/2026/09/m1.enc', bytes);
  A.store.create('meals', { id: 'm1', date: '2026-09-26', photo: { path: 'media/meals/2026/09/m1.enc' } });
  await A.sync.sync();
  const sha = repo.files().get('media/meals/2026/09/m1.enc');
  assert.ok(sha);
  const back = await C.decryptBytes(key, repo.blob(sha), 'media/meals/2026/09/m1.enc');
  assert.deepEqual([...back], [1, 2, 3, 4]);
  await tick();
});
