import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { addDays } from '../../js/core/util.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { buildDaily, dailyRow, DAILY_FIELDS } from '../../js/analytics/daily.js';
import { loadDemo } from '../../js/dev/demo.js';

// Build a DataView over hand-written records: { collection: [fields…] }.
function fixture(data, { today = '2026-09-23', tz = 'America/New_York' } = {}) {
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
  return makeDataView(store, { today, tz });
}
const iso = (date, hm) => `${date}T${hm}:00-04:00`;
const D0 = '2026-09-21', D1 = '2026-09-22', D2 = '2026-09-23'; // Mon, Tue, Wed (today)
const meal = (date, hm, kcal, protein, extra = {}) => ({ date, at: iso(date, hm), status: 'ready', items: [], totals: { kcal, protein, carbs: 100, fat: 30, fiber: 10, sodium: 900 }, ...extra });

function dailyFixture() {
  return fixture({
    settings: [{ id: 'integrations', gcal: { saEmail: 'x@example.com', readCalendars: ['primary'] } }],
    whoopSleep: [
      { id: 's0', date: D0, start: iso('2026-09-20', '23:30'), end: iso(D0, '06:45'), tz: '-04:00', nap: false, bedtime: '23:30', wake: '06:45', asleepMin: 420, needMin: 470, performance: 89, efficiency: 92, consistency: 80, deepMin: 90, remMin: 100, lightMin: 230, awakeMin: 20, disturbances: 7, respRate: 14.8 },
      // After-midnight bedtime: start is on D1 itself.
      { id: 's1', date: D1, start: iso(D1, '00:30'), end: iso(D1, '07:15'), tz: '-04:00', nap: false, bedtime: '00:30', wake: '07:15', asleepMin: 380, needMin: 480, performance: 79 },
      { id: 's1nap', date: D1, start: iso(D1, '14:00'), end: iso(D1, '14:30'), tz: '-04:00', nap: true, asleepMin: 25 },
    ],
    whoopRecovery: [
      { id: 'r0', date: D0, scoreState: 'SCORED', recovery: 70, hrv: 65, rhr: 52, spo2: 97, skinTempC: 33.5, calibrating: false },
      { id: 'r1', date: D1, scoreState: 'SCORED', recovery: 40, hrv: 50, rhr: 58 },
    ],
    whoopCycles: [{ id: 'c0', date: D0, strain: 14.2, kcal: 2900, avgHr: 70, steps: 9000 }],
    whoopWorkouts: [{ id: 'w0', date: D0, start: iso(D0, '17:00'), end: iso(D0, '18:10'), tz: '-04:00', sport: 'Weightlifting', strain: 12.1 }],
    sessions: [{ id: 'se0', date: D0, startAt: iso(D0, '17:00'), endAt: iso(D0, '18:10'), whoopWorkoutId: 'w0', entries: [
      { id: 'e0', exerciseId: 'ex-bench-press', sets: [{ w: 95, reps: 10, kind: 'warmup', done: true }, { w: 185, reps: 5, kind: 'work', done: true }, { w: 185, reps: 5, done: true }, { w: 185, reps: 4, kind: 'work' }, { w: 185, reps: 3, kind: 'work', done: false }] },
    ] }],
    meals: [
      meal(D0, '08:00', 600, 40), meal(D0, '20:00', 900, 60),
      meal(D1, '12:00', 700, 50), { date: D1, at: iso(D1, '19:00'), status: 'analyzing' },
    ],
    days: [
      { id: D0, date: D0, alcohol: 2, caffeineLastAt: '14:30', energy: 4, mood: 4, stress: 2, appetite: 3, soreness: 2, dayRating: 7, deepWorkH: 3 },
      { id: D1, date: D1, alcohol: 0, caffeineLastAt: '01:00', energy: 2 },
    ],
    calendarEvents: [
      { id: 'a', date: D0, start: iso(D0, '10:00'), end: iso(D0, '11:00'), status: 'confirmed', isForge: false },
      { id: 'b', date: D0, start: iso(D0, '10:30'), end: iso(D0, '11:30'), status: 'confirmed', isForge: false },
      { id: 'c', date: D0, start: iso(D0, '18:30'), end: iso(D0, '19:00'), status: 'confirmed', isForge: false },
      { id: 'd', date: D0, start: D0, end: D1, allDay: true, status: 'confirmed', isForge: false },
      { id: 'e', date: D0, start: iso(D0, '13:00'), end: iso(D0, '14:00'), status: 'cancelled', isForge: false },
      { id: 'f', date: D0, start: iso(D0, '15:00'), end: iso(D0, '16:00'), status: 'confirmed', isForge: true },
    ],
    plan: [
      { date: D0, start: '07:00', end: '08:00', title: 'A', category: 'deep', status: 'done' },
      { date: D0, start: '09:00', end: '10:00', title: 'B', category: 'admin', status: 'partial' },
      { date: D0, start: '13:00', end: '14:00', title: 'C', category: 'deep', status: 'skipped' },
      { date: D2, start: '09:00', end: '10:00', title: 'Today', category: 'deep', status: 'planned' },
      { date: '2026-09-24', start: '09:00', end: '10:00', title: 'Tomorrow', category: 'deep', status: 'planned' },
    ],
    protocolItems: [
      { id: 'pep', name: 'Peptide', kind: 'peptide', amount: 2.5, unit: 'mg', schedule: { type: 'days', days: [0] }, active: true, startedAt: '2026-09-01' },
      { id: 's1', name: 'Supp AM', kind: 'supplement', amount: 1, unit: 'g', schedule: { type: 'daily', stack: 'AM' }, active: true },
      { id: 's2', name: 'Supp PM', kind: 'supplement', amount: 1, unit: 'g', schedule: { type: 'daily', stack: 'PM' }, active: true },
    ],
    doses: [
      { itemId: 'pep', date: D0, at: iso(D0, '07:00'), amount: 2500, unit: 'mcg' },
      { itemId: 's1', date: D0, at: iso(D0, '07:00'), amount: 1, unit: 'g' },
      { itemId: 's2', date: D0, at: iso(D0, '21:00'), amount: 1, unit: 'g', skipped: true },
      { itemId: 's1', date: D1, at: iso(D1, '07:00'), amount: 1, unit: 'g' },
    ],
    body: [
      { date: D0, at: iso(D0, '20:00'), weightLb: 181.4 },
      { date: D0, at: iso(D0, '07:00'), weightLb: 180.0 },
    ],
  });
}

test('daily: one row per date with every documented field, in order', () => {
  const dv = dailyFixture();
  const rows = buildDaily(dv, D0, D2);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.date), [D0, D1, D2]);
  for (const r of rows) assert.deepEqual(Object.keys(r), DAILY_FIELDS);
  // The field list must match docs/ANALYTICS_API.md exactly (UI code is written against it).
  const doc = readFileSync(new URL('../../docs/ANALYTICS_API.md', import.meta.url), 'utf8');
  const listed = /DailyRow fields \(null when unknown\): `([^`]+)`/.exec(doc)[1].split(',').map((s) => s.trim());
  assert.deepEqual(DAILY_FIELDS, listed);
  assert.deepEqual(buildDaily(dv, D2, D0), []);
});

test('daily: sleep/recovery belong to the night that ended that morning; bedtime is continuous', () => {
  const dv = dailyFixture();
  const [r0, r1] = buildDaily(dv, D0, D1);
  assert.equal(r0.dow, 0); assert.equal(r0.isWeekend, false);
  assert.equal(r0.recovery, 70); assert.equal(r0.hrv, 65); assert.equal(r0.rhr, 52); assert.equal(r0.calibrating, false);
  assert.equal(r0.sleepMin, 420); assert.equal(r0.sleepNeedMin, 470); assert.equal(r0.respRate, 14.8);
  assert.equal(r0.bedtimeMin, 1410); // 23:30 the evening before
  assert.equal(r0.wakeMin, 405);
  assert.equal(r1.bedtimeMin, 1470); // 00:30 after midnight
  assert.equal(r1.sleepMin, 380, 'naps are not the main sleep');
  // next* comes from D+1
  assert.equal(r0.nextRecovery, 40); assert.equal(r0.nextHrv, 50); assert.equal(r0.nextRhr, 58);
  assert.equal(r0.nextSleepMin, 380); assert.equal(r0.nextSleepPerf, 79); assert.equal(r0.nextEnergy, 2);
});

test('daily: nutrition timing and lastMealToBedMin uses the following night', () => {
  const dv = dailyFixture();
  const [r0, r1] = buildDaily(dv, D0, D1);
  assert.equal(r0.kcalIn, 1500); assert.equal(r0.proteinG, 100); assert.equal(r0.carbsG, 200); assert.equal(r0.sodiumMg, 1800);
  assert.equal(r0.mealsCount, 2); assert.equal(r0.firstMealMin, 480); assert.equal(r0.lastMealMin, 1200);
  assert.equal(r0.lastMealToBedMin, 1470 - 1200);
  // D1 has a meal still analyzing: intake unknown (null), count and timing still known.
  assert.equal(r1.kcalIn, null); assert.equal(r1.proteinG, null);
  assert.equal(r1.mealsCount, 2); assert.equal(r1.lastMealMin, 1140);
  assert.equal(r0.caffeineLastMin, 870); assert.equal(r1.caffeineLastMin, 1500, '01:00 counts as late evening');
  assert.equal(r0.alcohol, 2); assert.equal(r1.alcohol, 0);
});

test('daily: training, meetings and plan adherence', () => {
  const dv = dailyFixture();
  const [r0, r1, r2] = buildDaily(dv, D0, D2);
  assert.equal(r0.dayStrain, 14.2); assert.equal(r0.kcalBurned, 2900); assert.equal(r0.steps, 9000);
  assert.equal(r0.workoutCount, 1, 'linked session is not double counted');
  assert.equal(r0.workoutStrain, 12.1); assert.equal(r0.workoutMin, 70); assert.equal(r0.lastWorkoutEndMin, 1090);
  assert.equal(r0.trainedStrength, true); assert.equal(r0.trainedCardio, false);
  assert.equal(r0.sessionSets, 3, 'warmup and done:false sets are excluded');
  assert.equal(r0.sessionVolumeLb, 185 * 14); assert.equal(r0.sessionMin, 70);
  // Calendar: overlapping events merged, all-day / cancelled / FORGE events skipped.
  assert.equal(r0.meetingCount, 3); assert.equal(r0.meetingMin, 120);
  assert.equal(r0.afterHoursMeetingMin, 30); assert.equal(r0.longestFreeBlockMin, 390);
  assert.equal(r1.meetingMin, 0, 'calendar connected: no events = 0 minutes');
  // Plan: done 100%, partial 50%, skipped 0.
  assert.equal(r0.planMin, 180); assert.equal(r0.planDoneMin, 90); assert.equal(r0.planAdherence, 50);
  assert.equal(r1.planMin, null); assert.equal(r1.planAdherence, null);
  assert.equal(r2.planAdherence, 0, 'today counts once the day has blocks');
  assert.equal(dailyRow(dv, '2026-09-24').planAdherence, null, 'future dates have no adherence');
  assert.equal(dailyRow(dv, '2026-09-24').planMin, 60);
  // deepWorkH from the day log
  assert.equal(r0.deepWorkH, 3);
});

test('daily: weight, peptide dosing and supplement adherence', () => {
  const dv = dailyFixture();
  const [r0, r1, r2] = buildDaily(dv, D0, D2);
  assert.equal(r0.weightLb, 180, 'first weigh-in of the day');
  assert.equal(r0.weightTrendLb, 180);
  assert.equal(r1.weightLb, null); assert.equal(r1.weightTrendLb, 180, 'trend carries forward');
  assert.equal(r0.peptideDoseMg, 2.5, 'mcg converted to mg'); assert.equal(r0.daysSinceDose, 0);
  assert.equal(r1.peptideDoseMg, 0); assert.equal(r1.daysSinceDose, 1); assert.equal(r2.daysSinceDose, 2);
  assert.equal(r0.supplementAdherence, 50, 'skipped doses do not count');
  assert.equal(r1.supplementAdherence, 50);
});

test('daily: unknown stays null (no data at all)', () => {
  const dv = fixture({}, { today: '2026-09-23' });
  const r = dailyRow(dv, '2026-09-10');
  for (const k of ['recovery', 'sleepMin', 'bedtimeMin', 'kcalIn', 'mealsCount', 'meetingMin', 'planAdherence', 'weightLb', 'daysSinceDose', 'workoutCount', 'trainedStrength', 'sessionSets', 'nextRecovery', 'executionScore']) {
    assert.equal(r[k], null, k);
  }
});

test('daily: buildDaily for 365 days of demo data runs well under 300 ms', () => {
  const today = '2026-09-26';
  const store = createStore({ owner: 'app' });
  loadDemo(store, { today, days: 365 });
  const dv = makeDataView(store, { today });
  const t0 = performance.now();
  const rows = buildDaily(dv, addDays(today, -364), today);
  const ms = performance.now() - t0;
  assert.equal(rows.length, 365);
  assert.ok(ms < 300, `buildDaily took ${ms.toFixed(1)} ms`);
  console.log(`# buildDaily(365 days, cold) = ${ms.toFixed(1)} ms`);
  const t1 = performance.now(); buildDaily(dv, addDays(today, -364), today);
  assert.ok(performance.now() - t1 < 5, 'memoized second call');
});
