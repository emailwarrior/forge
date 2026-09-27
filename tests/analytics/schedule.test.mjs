import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { addDays, hmToMin } from '../../js/core/util.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { planVsActual, timeAllocation, calendarLoad, timingTargets, suggestDay } from '../../js/analytics/schedule.js';

function fixture(data, { today = '2026-09-23', tz = 'America/New_York' } = {}) {
  const store = createStore({ owner: 'app' });
  const shards = new Map(); let n = 0;
  for (const [coll, recs] of Object.entries(data)) {
    const owner = COLLECTIONS[coll].owners.includes('app') ? 'app' : 'server';
    for (const f of recs) {
      const id = f.id ?? `${coll}-${++n}`;
      const { _t, ...fields } = f; // _t: record timestamp (ms) for "most recently edited" tests
      const r = makeRecord(id, fields, _t ?? 1000);
      const path = shardPath(coll, owner, periodOf(coll, r));
      if (!shards.has(path)) shards.set(path, { r: {} });
      shards.get(path).r[id] = r;
    }
  }
  for (const [path, sh] of shards) store.loadShard(path, sh, { dirty: false });
  return makeDataView(store, { today, tz });
}
const TODAY = '2026-09-23', D = '2026-09-22';
const iso = (date, hm) => `${date}T${hm}:00-04:00`;
const ev = (date, s, e, title = 'Meeting', extra = {}) => ({ date, start: iso(date, s), end: iso(date, e), title, status: 'confirmed', isForge: false, ...extra });
const noOverlap = (blocks, events) => blocks.every((b) => events.every(([s, e]) => hmToMin(b.end) <= s || hmToMin(b.start) >= e));

test('schedule: plan vs actual and time allocation', () => {
  const dv = fixture({ plan: [
    { date: D, start: '08:00', end: '10:00', title: 'Deep', category: 'deep', status: 'done' },
    { date: D, start: '10:00', end: '11:00', title: 'Admin', category: 'admin', status: 'partial' },
    { date: D, start: '14:00', end: '15:00', title: 'Deep 2', category: 'deep', status: 'skipped' },
    { date: TODAY, start: '08:00', end: '09:00', title: 'Deep', category: 'deep', status: 'done' },
    { date: '2026-09-24', start: '08:00', end: '09:00', title: 'Deep', category: 'deep', status: 'planned' },
  ] });
  const p = planVsActual(dv, D);
  assert.equal(p.plannedMin, 240); assert.equal(p.doneMin, 150); assert.equal(p.adherence, 62.5);
  assert.deepEqual(p.blocks.map((b) => [b.title, b.min, b.doneMin]), [['Deep', 120, 120], ['Admin', 60, 30], ['Deep 2', 60, 0]]);
  assert.deepEqual(p.byCategory, [{ category: 'deep', plannedMin: 180, doneMin: 120 }, { category: 'admin', plannedMin: 60, doneMin: 30 }]);
  assert.equal(planVsActual(dv, '2026-09-24').adherence, null);
  const alloc = timeAllocation(dv, D, '2026-09-24');
  assert.deepEqual(alloc, [{ category: 'deep', plannedMin: 300, doneMin: 180 }, { category: 'admin', plannedMin: 60, doneMin: 30 }]);
});

test('schedule: calendar load (merged time, after hours, back-to-back, free blocks)', () => {
  const dv = fixture({ calendarEvents: [
    ev(D, '09:00', '10:00'), ev(D, '10:00', '10:30'), ev(D, '10:33', '11:00'), ev(D, '17:30', '19:00'),
    ev(D, '12:00', '13:00', 'Cancelled', { status: 'cancelled' }), ev(D, '13:00', '14:00', 'Block', { isForge: true }),
    { date: D, start: D, end: TODAY, allDay: true, title: 'Holiday', status: 'confirmed', isForge: false },
  ] });
  const c = calendarLoad(dv, D);
  assert.equal(c.connected, true);
  assert.equal(c.count, 4); assert.equal(c.meetingMin, 207); assert.equal(c.afterHoursMin, 60);
  assert.equal(c.backToBack, 2); assert.equal(c.longestFreeBlockMin, 390);
  assert.equal(c.fragmentation, 0.01); assert.equal(c.firstStart, '09:00'); assert.equal(c.lastEnd, '19:00');
  assert.equal(calendarLoad(dv, TODAY).meetingMin, 0);
  const none = calendarLoad(fixture({}), D);
  assert.equal(none.connected, false); assert.equal(none.meetingMin, null); assert.equal(none.count, null);
});

test('schedule: timing targets vs settings (minutes, bedtime continuous)', () => {
  const dv = fixture({
    settings: [{ id: 'targets', wake: '06:30', bedtime: '23:00', caffeineCutoff: '12:00', lastMealBy: '20:00' }],
    whoopSleep: [
      { date: '2026-09-20', nap: false, bedtime: '22:45', wake: '06:15', asleepMin: 440 },
      { date: '2026-09-21', nap: false, bedtime: '00:15', wake: '07:15', asleepMin: 400 },
    ],
    days: [{ id: '2026-09-20', date: '2026-09-20', caffeineLastAt: '11:00' }, { id: '2026-09-21', date: '2026-09-21', caffeineLastAt: '15:00' }],
    meals: [{ date: '2026-09-20', at: iso('2026-09-20', '19:30'), status: 'ready', totals: { kcal: 500 } }],
  });
  const t = timingTargets(dv, '2026-09-20', '2026-09-21');
  const get = (k) => t.find((x) => x.key === k);
  assert.deepEqual(get('wake'), { key: 'wake', label: 'Wake', target: 390, targetHm: '06:30', avgActual: 405, avgHm: '06:45', hitRate: 50, n: 2 });
  assert.equal(get('bedtime').target, 1380); assert.equal(get('bedtime').avgActual, Math.round((1365 + 1455) / 2)); assert.equal(get('bedtime').hitRate, 50);
  assert.equal(get('caffeine').hitRate, 50); assert.equal(get('lastMeal').hitRate, 100); assert.equal(get('lastMeal').n, 1);
});

test('schedule: suggestDay from the latest day template, clear of events', () => {
  const dv = fixture({
    templates: [
      { id: 'old', kind: 'day', name: 'Old', blocks: [{ start: '06:00', end: '07:00', title: 'Old', category: 'admin' }] },
      { id: 'new', kind: 'day', name: 'Workday', blocks: [
        { start: '07:00', end: '09:00', title: 'Deep work', category: 'deep' }, { start: '09:00', end: '10:00', title: 'Admin', category: 'admin' },
        { start: '12:00', end: '12:30', title: 'Lunch', category: 'meal' }, { start: '17:00', end: '18:00', title: 'Lift', category: 'training' },
      ], _t: 5000 },
      { id: 'wo', kind: 'workout', name: 'Push', exercises: [] },
    ],
    calendarEvents: [ev(TODAY, '09:30', '10:30', 'Client call'), ev(TODAY, '12:00', '12:30', 'Lunch meeting')],
    whoopRecovery: [{ date: TODAY, scoreState: 'SCORED', recovery: 70, hrv: 60, rhr: 55 }],
    whoopSleep: [{ date: TODAY, nap: false, bedtime: '23:00', wake: '06:30', asleepMin: 450, needMin: 470 }],
  });
  const s = suggestDay(dv, TODAY);
  assert.equal(s.basis, 'template');
  const titles = s.blocks.map((b) => b.title);
  assert.ok(!titles.includes('Old'), 'most recent template wins');
  const admin = s.blocks.find((b) => b.title === 'Admin');
  assert.deepEqual([admin.start, admin.end], ['09:00', '09:30']); assert.match(admin.reason, /Shortened around Client call/);
  assert.ok(!titles.includes('Lunch')); assert.ok(s.notes.some((n) => /Dropped “Lunch”/.test(n)));
  assert.ok(noOverlap(s.blocks, [[570, 630], [720, 750]]));
  const deep = s.blocks.find((b) => b.title === 'Deep work');
  assert.match(deep.reason, /focus window/, 'existing deep block already covers the focus window');
  assert.equal(s.blocks.filter((b) => b.category === 'deep').length, 1);
  for (const b of s.blocks) for (const k of ['start', 'end', 'title', 'category', 'reason']) assert.ok(typeof b[k] === 'string' && b[k], k);
});

test('schedule: suggestDay swaps training for zone 2 / mobility on a red day', () => {
  const dv = fixture({
    templates: [{ id: 't', kind: 'day', name: 'Day', blocks: [{ start: '17:00', end: '18:15', title: 'Legs', category: 'training' }] }],
    whoopRecovery: [{ date: TODAY, scoreState: 'SCORED', recovery: 22, hrv: 40, rhr: 62 }],
    whoopSleep: [{ date: TODAY, nap: false, bedtime: '23:00', wake: '06:30', asleepMin: 360, needMin: 480 }],
  });
  const s = suggestDay(dv, TODAY);
  assert.equal(s.mode, 'recover');
  const z2 = s.blocks.find((b) => b.category === 'recovery');
  assert.equal(z2.title, 'Zone 2 / mobility'); assert.equal(z2.start, '17:00'); assert.equal(z2.end, '17:40');
  assert.ok(!s.blocks.some((b) => b.category === 'training'));
  assert.ok(s.blocks.some((b) => b.category === 'deep' && /focus window/i.test(b.reason)), 'focus block added when free');
});

test('schedule: suggestDay falls back to the usual same-weekday pattern', () => {
  const weds = [1, 2, 3, 4].map((k) => addDays(TODAY, -7 * k));
  const plan = [];
  for (const d of weds) {
    plan.push({ date: d, start: '08:00', end: '10:00', title: 'Write', category: 'deep', status: 'done' });
    plan.push({ date: d, start: '16:00', end: '17:00', title: 'Gym', category: 'training', status: 'done' });
  }
  plan.push({ date: weds[0], start: '11:00', end: '12:00', title: 'One-off', category: 'admin', status: 'done' });
  plan.push({ date: addDays(TODAY, -1), start: '06:00', end: '07:00', title: 'Tuesday thing', category: 'admin', status: 'done' });
  const dv = fixture({ plan, calendarEvents: [ev(TODAY, '16:30', '17:30', 'Review')] });
  const s = suggestDay(dv, TODAY);
  assert.equal(s.basis, 'history');
  const titles = s.blocks.map((b) => b.title);
  assert.ok(titles.includes('Write')); assert.ok(!titles.includes('One-off')); assert.ok(!titles.includes('Tuesday thing'));
  assert.match(s.blocks.find((b) => b.title === 'Write').reason, /Usual Wed block \(4 of the last 4 Weds\)/);
  const gym = s.blocks.find((b) => b.title === 'Gym');
  assert.deepEqual([gym.start, gym.end], ['16:00', '16:30']);
  assert.ok(noOverlap(s.blocks, [[990, 1050]]));
  const empty = suggestDay(fixture({}), TODAY);
  assert.equal(empty.basis, null); assert.ok(empty.notes.some((n) => /template/.test(n)));
});
