import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { exportBackup, importBackup, describeBackup, isBackup } from '../../js/app/backup.js';
import { loadDemo } from '../../js/dev/demo.js';

test('backup round-trips app data and skips server-only collections', () => {
  const src = createStore({ owner: 'app' });
  loadDemo(src, { today: '2026-09-26', tz: 'America/New_York', days: 30 });
  src.update('journal', 'j-x', { date: '2026-09-20', at: '2026-09-20T21:00:00-04:00', text: 'hello', tags: [] });
  src.remove('journal', 'j-x');
  const b = JSON.parse(JSON.stringify(exportBackup(src)));
  assert.ok(isBackup(b));
  assert.ok(!('secrets' in b.collections));
  const desc = describeBackup(b);
  assert.equal(desc.find((d) => d.name === 'whoopSleep').importable, false);
  assert.equal(desc.find((d) => d.name === 'meals').importable, true);

  const dst = createStore({ owner: 'app' });
  const res = importBackup(dst, b);
  assert.ok(res.skipped.includes('whoopSleep'));
  for (const name of ['meals', 'sessions', 'plan', 'body', 'doses', 'checks', 'days', 'labs', 'standards']) {
    assert.equal(dst.all(name).length, src.all(name).length, name);
  }
  const wiring = (r) => r.id === 'integrations' || r.id === 'security';
  assert.equal(dst.all('settings').length, src.all('settings').filter((r) => !wiring(r)).length, 'settings minus device/integration wiring');
  assert.equal(dst.get('journal', 'j-x'), null, 'tombstone preserved');
  assert.ok(dst.getAny('journal', 'j-x'));
  assert.ok(dst.dirty().length > 0, 'imported shards are dirty so they sync');
  // Idempotent: importing again changes nothing.
  const before = JSON.stringify(dst.all('meals'));
  importBackup(dst, b);
  assert.equal(JSON.stringify(dst.all('meals')), before);
  // Newer local edit wins over an older backup copy.
  const m = dst.all('meals')[0];
  dst.update('meals', m.id, { note: 'edited after backup' });
  importBackup(dst, b);
  assert.equal(dst.get('meals', m.id).note, 'edited after backup');
});

test('importBackup rejects other files', () => {
  assert.throws(() => importBackup(createStore(), { tasks: [] }), /not a FORGE backup/);
});

test('importBackup treats the file as hostile input', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const hostile = JSON.parse(`{"format":"forge-backup","version":1,"schema":3,"collections":{
    "journal":[
      {"id":"__proto__","_c":1,"text":"evil","tags":1},
      null, 5, "x",
      {"id":"ok1","_c":${now - 1000},"date":"2026-09-26","text":"fine","tags":[],"__proto__":{"polluted":true}},
      {"id":"future","_c":1e308,"_f":{"text":1e308},"date":"2026-09-26","text":"from the future","tags":[]},
      {"id":"mismatch-shape","_c":"yesterday","date":"2026-09-26","text":"bad _c"}
    ],
    "pushSubs":[{"id":"p1","_c":1,"endpoint":"https://attacker.example/steal","keys":{"p256dh":"x","auth":"y"},"active":true}],
    "settings":[
      {"id":"integrations","_c":1,"push":{"vapidPublicKey":"attacker"}},
      {"id":"profile","_c":${now - 1000},"heightIn":70}
    ]
  }}`);
  const s = createStore({ owner: 'app', clock: () => now });
  const res = importBackup(s, hostile, { now });
  assert.deepEqual(s.all('journal').map((r) => r.id).sort(), ['future', 'ok1']);
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  assert.equal(Object.getPrototypeOf(s.get('journal', 'ok1')), Object.prototype);
  assert.ok(!Object.prototype.hasOwnProperty.call(s.get('journal', 'ok1'), '__proto__'), 'unsafe field dropped');
  assert.ok(s.get('journal', 'future')._c <= now + 86400000, 'future times clamped');
  s.update('journal', 'future', { text: 'edited later' });
  assert.equal(s.get('journal', 'future').text, 'edited later', 'a later edit still wins');
  assert.equal(s.all('pushSubs').length, 0, 'push endpoints never imported');
  assert.equal(s.setting('integrations').push.vapidPublicKey, '', 'integration settings never imported');
  assert.equal(s.setting('profile').heightIn, 70);
  assert.ok(res.skipped.includes('pushSubs') && res.skipped.includes('settings.integrations'));
});

test('a hostile decrypted shard cannot pollute prototypes or crash the store', () => {
  const s = createStore({ owner: 'app' });
  const shard = JSON.parse('{"schema":3,"c":"journal","o":"app","p":"2026","r":{"__proto__":{"id":"__proto__","_c":1,"text":"x"},"a":null,"b":{"id":"b","_c":5,"date":"2026-01-02","text":"ok","tags":[]},"c":{"id":"zzz","_c":5,"text":"id mismatch"}}}');
  s.loadShard('forge/app/journal/2026.enc', shard);
  assert.deepEqual(s.all('journal').map((r) => r.id), ['b']);
  assert.equal({}.text, undefined);
});
