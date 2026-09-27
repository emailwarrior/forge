import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord, patchRecord, mergeRecords, mergeRecordMaps } from '../../js/core/merge.js';
import { createStore } from '../../js/core/store.js';
import { shardPath, parseShardPath, periodOf } from '../../js/core/schema.js';
import * as C from '../../js/core/crypto.js';
import { buildV2Migration, applyMigration } from '../../js/core/migrate.js';
import { addDays, dayOfWeek, isoWeek, localFromOffset, zonedToMs, localParts, tzOffsetMin, isoWithOffset, hmToMin, minToHm, weekStart } from '../../js/core/util.js';

let T = 1_000_000;
const clock = () => ++T;

test('util: calendar math is DST-proof and ISO weeks are right', () => {
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dayOfWeek('2026-09-28'), 0); // Monday
  assert.equal(weekStart('2026-09-27'), '2026-09-21');
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  assert.deepEqual(localFromOffset('2026-09-26T10:30:00.000Z', '-04:00'), { ymd: '2026-09-26', hm: '06:30', min: 390, dow: 5 });
  assert.equal(localFromOffset('2026-09-26T02:00:00.000Z', '-04:00').ymd, '2026-09-25');
  const ms = zonedToMs('2026-09-26', '06:30', 'America/New_York');
  assert.equal(new Date(ms).toISOString(), '2026-09-26T10:30:00.000Z');
  assert.equal(localParts(ms, 'America/New_York').hm, '06:30');
  assert.equal(tzOffsetMin(ms, 'America/New_York'), -240);
  assert.match(isoWithOffset(ms, 'America/New_York'), /^2026-09-26T06:30:00-04:00$/);
  assert.equal(hmToMin('06:30'), 390); assert.equal(minToHm(1470), '00:30');
});

test('merge: per-field LWW, commutative, associative, idempotent', () => {
  const base = makeRecord('r1', { a: 1, b: 1, c: 1 }, 100);
  const x = patchRecord(base, { a: 2 }, 200);
  const y = patchRecord(base, { b: 3 }, 210);
  const z = patchRecord(base, { a: 9, c: 4 }, 190);
  const m1 = mergeRecords(mergeRecords(x, y), z);
  const m2 = mergeRecords(x, mergeRecords(y, z));
  const m3 = mergeRecords(z, mergeRecords(y, x));
  assert.deepEqual(m1, m2); assert.deepEqual(m1, m3);
  assert.equal(m1.a, 2); assert.equal(m1.b, 3); assert.equal(m1.c, 4);
  assert.deepEqual(mergeRecords(m1, m1), m1);
  assert.equal(m1._u, 210);
});

test('merge: random operation histories converge regardless of order', () => {
  for (let trial = 0; trial < 200; trial++) {
    const base = makeRecord('r', { a: 0, b: 0 }, 1);
    const versions = [base];
    for (let i = 0; i < 6; i++) {
      const from = versions[Math.floor(Math.random() * versions.length)];
      const key = ['a', 'b', 'c', '_d'][Math.floor(Math.random() * 4)];
      versions.push(patchRecord(from, { [key]: Math.floor(Math.random() * 5) }, 1 + Math.floor(Math.random() * 20)));
    }
    const shuffled = [...versions].sort(() => Math.random() - 0.5);
    const a = versions.reduce((m, v) => mergeRecords(m, v));
    const b = shuffled.reduce((m, v) => mergeRecords(m, v));
    assert.deepEqual(a, b);
  }
});

test('merge: delete is a field; tie-break deterministic', () => {
  const r = makeRecord('x', { v: 1 }, 10);
  const del = patchRecord(r, { _d: 1 }, 20);
  const edit = patchRecord(r, { v: 2 }, 15);
  const m = mergeRecords(edit, del);
  assert.equal(m._d, 1); assert.equal(m.v, 2);
  const t1 = makeRecord('t', { v: 'a' }, 5), t2 = makeRecord('t', { v: 'b' }, 5);
  assert.deepEqual(mergeRecords(t1, t2), mergeRecords(t2, t1));
  const maps = mergeRecordMaps({ x: r }, { y: t1 });
  assert.deepEqual(Object.keys(maps).sort(), ['x', 'y']);
});

test('schema: shard paths round-trip', () => {
  assert.equal(shardPath('meals', 'app', '2026-09'), 'forge/app/meals/2026-09.enc');
  assert.deepEqual(parseShardPath('forge/server/whoopSleep/2026.enc'), { owner: 'server', name: 'whoopSleep', period: '2026' });
  assert.deepEqual(parseShardPath('forge/app/settings.enc'), { owner: 'app', name: 'settings', period: '' });
  assert.equal(parseShardPath('forge/app/unknown.enc'), null);
  assert.equal(periodOf('checks', { date: '2026-09-26' }), '2026');
  assert.equal(periodOf('meals', { date: '2026-09-26' }), '2026-09');
});

test('store: CRUD, date ranges, settings defaults, owner enforcement', async () => {
  const s = createStore({ owner: 'app', clock });
  const m = s.create('meals', { date: '2026-09-26', at: '2026-09-26T12:00:00-04:00', note: 'lunch' });
  s.create('meals', { date: '2026-09-25', note: 'dinner' });
  s.create('meals', { date: '2026-10-01', note: 'oct' });
  assert.equal(s.all('meals').length, 3);
  assert.equal(s.range('meals', '2026-09-25', '2026-09-30').length, 2);
  assert.equal(s.byDate('meals', '2026-09-26')[0].note, 'lunch');
  s.update('meals', m.id, { note: 'big lunch' });
  assert.equal(s.get('meals', m.id).note, 'big lunch');
  s.remove('meals', m.id);
  assert.equal(s.get('meals', m.id), null);
  assert.equal(s.all('meals').length, 2);
  s.restore('meals', m.id);
  assert.equal(s.all('meals').length, 3);
  // period move: record leaves the old shard
  s.update('meals', m.id, { date: '2026-10-02' });
  assert.equal(s.shardInfo('forge/app/meals/2026-09.enc').count, 1);
  assert.equal(s.shardInfo('forge/app/meals/2026-10.enc').count, 2);
  // settings
  assert.equal(s.setting('targets').wake, '06:30');
  s.updateSetting('integrations', { whoop: { clientId: 'abc' } });
  const integ = s.setting('integrations');
  assert.equal(integ.whoop.clientId, 'abc'); assert.equal(integ.ai.model, 'claude-sonnet-5');
  assert.throws(() => s.create('whoopSleep', { date: '2026-09-26' }), /cannot write/);
  await new Promise((r) => setTimeout(r, 0));
});

test('store: server shards are authoritative, own shards merge', () => {
  const s = createStore({ owner: 'app', clock });
  const p = 'forge/server/whoopSleep/2026.enc';
  s.loadShard(p, { r: { a: makeRecord('a', { date: '2026-09-26', asleepMin: 400 }, 5) } });
  s.loadShard(p, { r: { b: makeRecord('b', { date: '2026-09-27', asleepMin: 420 }, 6) } });
  assert.deepEqual(s.all('whoopSleep').map((r) => r.id), ['b']);
  const own = 'forge/app/meals/2026-09.enc';
  s.create('meals', { id: 'm1', date: '2026-09-26', note: 'local' });
  const differs = s.loadShard(own, { r: { m2: makeRecord('m2', { date: '2026-09-26', note: 'remote' }, 7) } });
  assert.equal(differs, true);
  assert.equal(s.all('meals').length, 2);
  assert.ok(s.dirty().some((d) => d.path === own));
});

test('store: app edit of a server record overrides in merged view', () => {
  const s = createStore({ owner: 'app', clock });
  s.loadShard('forge/server/meals/2026-09.enc', { r: { m: makeRecord('m', { date: '2026-09-26', totals: { kcal: 500 } }, 5) } });
  s.update('meals', 'm', { totals: { kcal: 650 } });
  assert.equal(s.get('meals', 'm').totals.kcal, 650);
  assert.equal(s.shardInfo('forge/app/meals/2026-09.enc').count, 1);
  // server later rewrites its shard: our newer field still wins
  s.loadShard('forge/server/meals/2026-09.enc', { r: { m: makeRecord('m', { date: '2026-09-26', totals: { kcal: 520 } }, 6) } });
  assert.equal(s.get('meals', 'm').totals.kcal, 650);
});

test('crypto: blob round trip, path binding, tamper detection', async () => {
  const raw = C.randomBytes(32); const key = await C.importDek(raw);
  const obj = { hello: 'world', n: [1, 2, 3], big: 'x'.repeat(5000) };
  const blob = await C.encodeJson(key, 'forge/app/meals/2026-09.enc', obj);
  assert.ok(C.isEncryptedBlob(blob));
  assert.ok(blob.length < 400, 'gzip should shrink repetitive payloads');
  assert.deepEqual(await C.decodeJson(key, 'forge/app/meals/2026-09.enc', blob), obj);
  await assert.rejects(C.decodeJson(key, 'forge/app/meals/2026-10.enc', blob), /Decryption failed/);
  const bad = blob.slice(); bad[bad.length - 1] ^= 1;
  await assert.rejects(C.decodeJson(key, 'forge/app/meals/2026-09.enc', bad), /Decryption failed/);
  const other = await C.importDek(C.randomBytes(32));
  await assert.rejects(C.decodeJson(other, 'forge/app/meals/2026-09.enc', blob), /Decryption failed/);
});

test('crypto: keyring passphrase + recovery + rewrap', async () => {
  const { keyring, dekRaw, recoveryKey } = await C.createKeyring('correct horse battery staple', { iterations: 100000 });
  assert.match(recoveryKey, /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
  assert.deepEqual(await C.unwrapWithPassphrase(keyring, 'correct horse battery staple'), dekRaw);
  await assert.rejects(C.unwrapWithPassphrase(keyring, 'wrong'), /Wrong passphrase/);
  assert.deepEqual(await C.unwrapWithRecovery(keyring, recoveryKey.toLowerCase()), dekRaw);
  assert.deepEqual(C.parseRecoveryKey(C.formatRecoveryKey(dekRaw)), dekRaw);
  const k2 = await C.rewrapPassphrase(keyring, dekRaw, 'new phrase here please', { iterations: 100000 });
  assert.deepEqual(await C.unwrapWithPassphrase(k2, 'new phrase here please'), dekRaw);
  await assert.rejects(C.unwrapWithPassphrase(k2, 'correct horse battery staple'), /Wrong passphrase/);
  assert.deepEqual(await C.unwrapWithRecovery(k2, recoveryKey), dekRaw);
  assert.ok(C.passphraseBits('correct horse battery staple') >= 44);
});

const V2 = {
  version: 2,
  settings: { mult: 8, stake: 40, expense: 2000 },
  tasks: [
    { id: 'a1', name: '7:15 AM Wake Up', cat: 'Discipline', w: 3, req: true, type: 'do', days: [0, 1, 2, 3, 4, 5, 6], active: true, effectiveFrom: '1970-01-01' },
    { id: 'a2', name: '80% Daily Productivity', cat: 'Discipline', w: 3, req: true, type: 'do', days: [0, 1, 2, 3, 4, 5, 6], active: true, effectiveFrom: '1970-01-01' },
    { id: 'a3', name: 'Gym', cat: 'Body', w: 3, req: true, type: 'do', days: [0, 1, 2, 3, 4, 5, 6], active: true, effectiveFrom: '1970-01-01' },
    { id: 'a4', name: '4 Meals', cat: 'Nutrition', w: 2, req: true, type: 'do', days: [0, 1, 2, 3, 4, 5, 6], active: true, effectiveFrom: '1970-01-01' },
    { id: 'a5', name: 'Stretch', cat: 'Body', w: 1, req: false, type: 'do', days: [0, 1, 2, 3, 4, 5, 6], active: false },
    { id: 'a6', name: 'Read 20 Minutes', cat: 'Mind', w: 2, req: true, type: 'do', days: [0, 1, 2, 3, 4, 5, 6], active: true, effectiveFrom: '2026-06-01' },
    { id: 'a7', name: 'No Caffeine After 2 PM', cat: 'Discipline', w: 1, req: false, type: 'avoid', days: [0, 1, 2, 3, 4, 5, 6], active: true },
  ],
  log: { '2026-09-24': { a1: true, a3: true, a5: true }, '2026-09-25': { a2: true, a6: true }, bad: { a1: true } },
  snapshots: [{ month: '2026-08', gross: 20000, items: [{ name: 'Cash', type: 'asset', value: 5000 }, { name: 'Car loan', type: 'liability', value: 3000 }] }],
  saved: [{ text: 'Price is what you pay.', who: 'Warren Buffett', ts: 1780000000000 }],
  notes: [{ id: 'n1', text: 'First note', ts: 1780000000000 }],
  updatedAt: 1780100000000,
};

test('migrate: v2 -> v3 conversions, idempotent', () => {
  const s = createStore({ owner: 'app', clock });
  const mig = buildV2Migration(V2, { tz: 'America/New_York' });
  const summary = applyMigration(s, mig);
  assert.equal(summary.standards, 7); assert.deepEqual(summary.skipped, []);
  assert.equal(s.get('standards', 'v2-a5').active, false, 'inactive habits migrate as inactive');
  assert.equal(summary.checks, 5);
  const wake = s.get('standards', 'v2-a1');
  assert.equal(wake.kind, 'time'); assert.equal(wake.target.value, '07:15'); assert.equal(wake.auto, 'whoop.wake');
  assert.equal(s.get('standards', 'v2-a2').target.value, 80);
  assert.equal(s.get('standards', 'v2-a4').auto, 'nutrition.meals');
  assert.equal(s.get('standards', 'v2-a6').kind, 'duration');
  assert.equal(s.get('standards', 'v2-a7').auto, 'day.caffeineCutoff');
  assert.equal(s.get('checks', '2026-09-24:v2-a1').value, true);
  assert.equal(s.get('snapshots', '2026-08').items[1].category, 'debt');
  assert.equal(s.setting('finance').stake, 40);
  assert.equal(s.all('journal')[0].text, 'First note');
  const before = structuredClone(s.all('checks'));
  applyMigration(s, buildV2Migration(V2));
  assert.deepEqual(structuredClone(s.all('checks')), before);
  // a later v3 edit beats migrated values on re-import
  s.update('standards', 'v2-a3', { name: 'Train' });
  applyMigration(s, buildV2Migration(V2));
  assert.equal(s.get('standards', 'v2-a3').name, 'Train');
});

test('upsert revives a deleted fixed-id record; update does not', async () => {
  const { createStore } = await import('../../js/core/store.js');
  let t = 1000; const s = createStore({ owner: 'app', clock: () => ++t });
  s.upsert('days', '2026-09-26', { date: '2026-09-26', energy: 3 });
  s.remove('days', '2026-09-26');
  assert.equal(s.get('days', '2026-09-26'), null);
  s.update('days', '2026-09-26', { energy: 4 });
  assert.equal(s.get('days', '2026-09-26'), null, 'update keeps it deleted');
  s.upsert('days', '2026-09-26', { energy: 5 });
  assert.equal(s.get('days', '2026-09-26').energy, 5, 'upsert revives');
  s.remove('days', '2026-09-26');
  s.upsert('days', '2026-09-26', { energy: 2, _d: 1 });
  assert.equal(s.get('days', '2026-09-26'), null, 'explicit _d wins');
});

test('v2 import retires seeded standards it duplicates (deactivated, not deleted)', async () => {
  const { seedStandards } = await import('../../js/core/schema.js');
  const { buildV2Migration, applyMigration } = await import('../../js/core/migrate.js');
  const s = createStore({ owner: 'app' });
  for (const x of seedStandards()) s.create('standards', x);
  const v2 = { tasks: [
    { id: 't1', name: 'Wake up at 6:00 AM' }, { id: 't2', name: 'Gym' }, { id: 't3', name: 'Read 30 min' },
    { id: 't4', name: 'Vitamins' }, { id: 't5', name: 'Journal' },
  ], log: {}, snapshots: [], updatedAt: 1 };
  const summary = applyMigration(s, buildV2Migration(v2, { tz: 'America/New_York' }));
  const byId = (id) => s.getAny('standards', id);
  assert.equal(byId('std-wake').active, false, 'same auto source (whoop.wake)');
  assert.equal(byId('std-train').active, false, 'same auto source (training.session)');
  assert.equal(byId('std-read').active, false, 'same leading word for manual standards');
  assert.equal(byId('std-deep').active, true, 'no duplicate → kept');
  assert.ok(summary.retiredSeeds.includes('Wake on time'));
  assert.equal(s.get('standards', 'v2-t1').active, true);
});

test('passphraseBits: repeats, sequences, repeated chunks and common words score low', () => {
  for (const weak of ['aaaaaaaaaaaaaaaaaaaaaa', 'Password1234567!', 'Forge!Forge!Forge!', 'qwertyuiop123456', 'Summer2026!Summer2026!', 'correct horse battery staple'])
    assert.ok(C.passphraseBits(weak) < 55, weak + ' → ' + C.passphraseBits(weak));
  for (const strong of ['k8#Tq2!vLm9@xR4z', '7KQ2M-XJ9PD-4TRWC-N8H3V', 'correct horse battery staple lamp'])
    assert.ok(C.passphraseBits(strong) >= 55, strong + ' → ' + C.passphraseBits(strong));
});

test('keyring: tampered KDF parameters are refused; recovery key can be replaced', async () => {
  const { keyring, dekRaw, recoveryKey } = await C.createKeyring('k8#Tq2!vLm9@xR4z', { iterations: 100000 });
  await assert.rejects(C.unwrapWithPassphrase({ ...keyring, kdf: { ...keyring.kdf, iterations: 1e12 } }, 'k8#Tq2!vLm9@xR4z'), /Unsupported/);
  await assert.rejects(C.unwrapWithPassphrase({ ...keyring, kdf: { ...keyring.kdf, iterations: 10 } }, 'k8#Tq2!vLm9@xR4z'), /Unsupported/);
  const { keyring: k2, recoveryKey: r2 } = await C.rewrapRecovery(keyring, dekRaw);
  assert.notEqual(r2, recoveryKey);
  await assert.rejects(C.unwrapWithRecovery(k2, recoveryKey), /Wrong recovery key/);
  assert.deepEqual([...await C.unwrapWithRecovery(k2, r2)], [...dekRaw]);
  assert.deepEqual([...await C.unwrapWithPassphrase(k2, 'k8#Tq2!vLm9@xR4z')], [...dekRaw], 'passphrase wrap untouched');
  await assert.rejects(C.unwrapWithRecovery({ ...k2, kid: 'deadbeefdeadbeef' }, r2), /Key check failed/);
});
