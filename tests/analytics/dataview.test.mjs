import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { dayOfWeek, diffDays, fmtNum } from '../../js/core/util.js';
import { makeDataView, localClock, minutesAfter, mergeIntervals, freeGaps, formatNumber, dayNum, dowOf, daysBetween } from '../../js/analytics/dataview.js';

function fixture(data, opts = { today: '2026-09-23', tz: 'America/New_York' }) {
  const store = createStore({ owner: 'app' });
  const shards = new Map(); let n = 0;
  for (const [coll, recs] of Object.entries(data)) {
    const owner = COLLECTIONS[coll].owners.includes('app') ? 'app' : 'server';
    for (const f of recs) {
      const id = f.id ?? `${coll}-${++n}`;
      const r = makeRecord(id, f, 1000);
      const path = shardPath(coll, owner, periodOf(coll, r));
      if (!shards.has(path)) shards.set(path, { r: {} });
      shards.get(path).r[id] = r;
    }
  }
  for (const [path, sh] of shards) store.loadShard(path, sh, { dirty: false });
  return makeDataView(store, opts);
}

test('dataview: local clock of instants (recorded offset, record tz, UTC, floating)', () => {
  const NY = 'America/New_York';
  assert.deepEqual(localClock('2026-09-25T23:57:00-04:00', NY), { ymd: '2026-09-25', min: 1437 });
  assert.deepEqual(localClock('2026-09-26T03:57:00.000Z', NY), { ymd: '2026-09-25', min: 1437 }, 'UTC converted to the zone');
  assert.deepEqual(localClock('2026-09-26T03:57:00.000Z', NY, '-04:00'), { ymd: '2026-09-25', min: 1437 }, 'WHOOP tz offset');
  assert.deepEqual(localClock('2026-09-26T03:57:00.000Z', NY, 'Europe/London'), { ymd: '2026-09-26', min: 297 });
  assert.deepEqual(localClock('2026-09-26T12:34:05', NY), { ymd: '2026-09-26', min: 754 }, 'floating time is local');
  assert.equal(localClock('2026-09-26', NY), null); assert.equal(localClock(null, NY), null);
  assert.equal(minutesAfter('2026-09-26T00:30:00-04:00', '2026-09-25', NY), 1470);
  assert.equal(minutesAfter('2026-09-25T23:30:00-04:00', '2026-09-26', NY), -30);
});

test('dataview: interval, number and date helpers', () => {
  assert.deepEqual(mergeIntervals([[60, 120], [100, 180], [200, 210], [10, 5]]), [[60, 180], [200, 210]]);
  assert.deepEqual(freeGaps([[540, 600], [590, 660], [1000, 1200]], 480, 1080), [[480, 540], [660, 1000]]);
  assert.deepEqual(freeGaps([], 480, 1080), [[480, 1080]]);
  for (const [n, dp] of [[2750, 0], [3.25, 1], [-1234567.891, 2], [999.5, 0], [0, 0]]) assert.equal(formatNumber(n, dp), fmtNum(n, dp));
  assert.equal(formatNumber(null), '—');
  for (const d of ['2026-09-21', '2026-09-27', '2000-02-29', '1969-12-31', '2027-01-01']) assert.equal(dowOf(d), dayOfWeek(d), d);
  assert.equal(daysBetween('2026-01-01', '2026-09-26'), diffDays('2026-01-01', '2026-09-26'));
  assert.equal(dayNum('1970-01-02'), 1);
});

test('dataview: today option, memoized settings, invalidate', () => {
  const dv = fixture({ settings: [{ id: 'targets', wake: '06:00' }] }, { today: '2026-09-23', tz: 'UTC' });
  assert.equal(dv.today(), '2026-09-23'); assert.equal(dv.asOf(), '2026-09-23');
  assert.equal(dv.setting('targets').wake, '06:00'); assert.equal(dv.setting('targets').sleepTargetH, 8, 'defaults merged');
  assert.equal(dv.setting('targets'), dv.setting('targets'), 'memoized');
  let day = '2026-09-23';
  const dv2 = fixture({}, { today: () => day });
  assert.equal(dv2.asOf(), '2026-09-23'); day = '2026-09-24';
  assert.equal(dv2.asOf(), '2026-09-23', 'stable until the store changes');
  dv2.invalidate(); assert.equal(dv2.asOf(), '2026-09-24');
  const plain = makeDataView(createStore({ owner: 'app' }), { tz: 'UTC' });
  assert.match(plain.today(), /^\d{4}-\d{2}-\d{2}$/, 'default today() unchanged');
});

test('dataview: intake completeness, calendar connection, deep work fallback', () => {
  const D = '2026-09-22';
  const dv = fixture({
    meals: [
      { date: D, at: `${D}T08:00:00-04:00`, status: 'ready', items: [{ name: 'Eggs', kcal: 200, protein: 18 }, { name: 'Toast', kcal: 150, protein: 5 }] },
      { date: '2026-09-21', at: '2026-09-21T08:00:00-04:00', status: 'ready', totals: { kcal: 500, protein: 30 } },
      { date: '2026-09-21', at: '2026-09-21T13:00:00-04:00', status: 'error' },
    ],
    plan: [
      { date: D, start: '08:00', end: '10:00', category: 'deep', status: 'done', title: 'a' },
      { date: D, start: '13:00', end: '14:00', category: 'deep', status: 'partial', title: 'b' },
      { date: '2026-09-21', start: '08:00', end: '10:00', category: 'deep', status: 'planned', title: 'c' },
    ],
  });
  const it = dv.intake(D);
  assert.equal(it.complete, true); assert.equal(it.totals.kcal, 350, 'items summed when totals are missing'); assert.equal(it.firstMin, 480);
  const bad = dv.intake('2026-09-21');
  assert.equal(bad.complete, false); assert.equal(bad.failed, 1); assert.equal(bad.totals.kcal, 500);
  assert.equal(dv.hasCalendar(), false); assert.equal(dv.eventLoad(D), null, 'no calendar → unknown, not zero');
  assert.equal(dv.deepWorkH(D), 2.5, 'done 2 h + partial 1 h × 50%');
  assert.equal(dv.deepWorkH('2026-09-21'), null, 'untouched plan says nothing about deep work');
  const cal = fixture({ settings: [{ id: 'integrations', gcal: { saEmail: 'svc@example.com' } }] });
  assert.equal(cal.hasCalendar(), true); assert.equal(cal.eventLoad(D), null, 'configured but never synced → unknown');
  const synced = fixture({ settings: [{ id: 'integrations', gcal: { saEmail: 'svc@example.com' } }], status: [{ id: 'calendar', detail: { coverageFrom: '2026-09-01', window: { from: '2026-09-10', to: '2026-10-15' } } }] });
  assert.equal(synced.eventLoad(D).meetingMin, 0, 'synced, no events → 0 minutes');
  assert.equal(synced.eventLoad('2026-08-31'), null, 'before the first synced window → unknown');
  assert.equal(synced.eventLoad('2026-10-16'), null, 'beyond the synced window → unknown');
});
