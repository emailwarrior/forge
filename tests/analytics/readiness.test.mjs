import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { addDays, dateRange, hmToMin, dayOfWeek } from '../../js/core/util.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { buildDaily } from '../../js/analytics/daily.js';
import { readiness, baselines } from '../../js/analytics/readiness.js';
import { mean } from '../../js/analytics/stats.js';

function fixture(data, { today = '2026-09-26', tz = 'America/New_York' } = {}) {
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
const TODAY = '2026-09-26';
const iso = (date, hm) => `${date}T${hm}:00-04:00`;
// `days` of stable history before TODAY plus a configurable TODAY.
function history({ days = 40, today = {}, todaySleep = {}, extra = {}, withRecovery = true } = {}) {
  const rec = [], sleep = [];
  dateRange(addDays(TODAY, -days), addDays(TODAY, -1)).forEach((d, i) => {
    const w = [-1, 1, 0, 2, -2][i % 5];
    rec.push({ id: 'r' + d, date: d, scoreState: 'SCORED', recovery: withRecovery ? 60 + w * 3 : undefined, hrv: 60 + w * 3, rhr: 55 + w * 0.8, skinTempC: 33.5 + w * 0.05 });
    sleep.push({ id: 's' + d, date: d, nap: false, bedtime: '23:00', wake: '06:30', asleepMin: 450 + w * 10, needMin: 470, respRate: 14.5 + w * 0.1, performance: 92 });
  });
  rec.push({ id: 'rT', date: TODAY, scoreState: 'SCORED', recovery: withRecovery ? 60 : undefined, hrv: 60, rhr: 55, skinTempC: 33.5, ...today });
  sleep.push({ id: 'sT', date: TODAY, nap: false, bedtime: '23:00', wake: '06:30', asleepMin: 460, needMin: 470, respRate: 14.5, performance: 95, ...todaySleep });
  return fixture({ whoopRecovery: rec, whoopSleep: sleep, ...extra }, { today: TODAY });
}

test('readiness: baselines use only the window before the date', () => {
  const dv = history();
  const rows = buildDaily(dv, addDays(TODAY, -40), TODAY);
  const b = baselines(rows, TODAY, 30);
  const prior = rows.filter((r) => r.date >= addDays(TODAY, -30) && r.date < TODAY);
  assert.equal(b.hrv.n, 30);
  assert.ok(Math.abs(b.hrv.mean - mean(prior.map((r) => r.hrv))) < 1e-9);
  for (const k of ['hrv', 'rhr', 'sleepMin', 'recovery', 'respRate', 'skinTempC']) assert.ok('mean' in b[k] && 'sd' in b[k] && 'n' in b[k], k);
  const empty = baselines([], TODAY);
  assert.deepEqual(empty.hrv, { mean: null, sd: null, n: 0 });
});

test('readiness: WHOOP bands map to training modes', () => {
  const cases = [
    [{ recovery: 80 }, {}, 'green', 'push', [14, 18]],
    [{ recovery: 80 }, { asleepMin: 380 }, 'green', 'build', [11, 14]],
    [{ recovery: 55 }, {}, 'yellow', 'build', [11, 14]],
    [{ recovery: 40 }, {}, 'yellow', 'maintain', [8, 11]],
    [{ recovery: 20 }, {}, 'red', 'recover', [0, 8]],
  ];
  for (const [today, todaySleep, band, mode, strain] of cases) {
    const r = readiness(history({ today, todaySleep }), TODAY);
    assert.equal(r.status, 'ok'); assert.equal(r.band, band, JSON.stringify(today));
    assert.equal(r.training.mode, mode, JSON.stringify([today, todaySleep]));
    assert.deepEqual(r.training.strainTarget, strain);
    assert.equal(r.score, today.recovery); assert.equal(r.scoreSource, 'whoop');
  }
  const r = readiness(history({ today: { recovery: 80, hrv: 70 } }), TODAY);
  assert.ok(r.metrics.hrvZ > 1); assert.ok(Math.abs(r.metrics.hrvBase - 60) < 1);
  assert.match(r.summary, /^Recovery 80% \(green\).*\.$/);
  assert.doesNotMatch(r.summary, /!/);
});

test('readiness: calibrating with < 7 baseline days still shows WHOOP recovery', () => {
  const r = readiness(history({ days: 5, today: { recovery: 72 } }), TODAY);
  assert.equal(r.status, 'calibrating');
  assert.equal(r.band, 'green'); assert.equal(r.score, 72);
  assert.equal(r.metrics.hrvZ, null); assert.equal(r.metrics.rhrZ, null);
  assert.ok(r.flags.some((f) => f.level === 'info' && /calibrating/i.test(f.text)));
});

test('readiness: composite score without WHOOP recovery', () => {
  const good = readiness(history({ withRecovery: false, today: { hrv: 70, rhr: 53 } }), TODAY);
  assert.equal(good.scoreSource, 'composite'); assert.equal(good.band, 'green'); assert.ok(good.score >= 67);
  const bad = readiness(history({ withRecovery: false, today: { hrv: 50, rhr: 58 }, todaySleep: { asleepMin: 330 } }), TODAY);
  assert.equal(bad.band, 'red'); assert.equal(bad.training.mode, 'recover');
  const cal = readiness(history({ days: 3, withRecovery: false }), TODAY);
  assert.equal(cal.band, null); assert.equal(cal.score, null); assert.equal(cal.training.mode, 'build');
});

test('readiness: illness flag forces recover mode', () => {
  const r = readiness(history({ today: { recovery: 75, skinTempC: 34.3 }, todaySleep: { respRate: 16.2 } }), TODAY);
  assert.equal(r.band, 'green'); assert.equal(r.training.mode, 'recover');
  assert.ok(r.flags.some((f) => f.level === 'alert'));
  assert.ok(r.metrics.respDelta >= 1 && r.metrics.skinTempDelta >= 0.5);
  const hrvDrop = readiness(history({ today: { recovery: 50, hrv: 45 }, todaySleep: { respRate: 16 } }), TODAY);
  assert.equal(hrvDrop.training.mode, 'recover', 'resp rate + HRV z ≤ −1.5 also counts');
});

test('readiness: drivers include yesterday\'s behaviors, sorted by weight', () => {
  const y = addDays(TODAY, -1);
  const dv = history({
    today: { recovery: 45 },
    extra: {
      days: [{ id: y, date: y, alcohol: 3 }],
      meals: [{ date: y, at: iso(y, '22:15'), status: 'ready', totals: { kcal: 800, protein: 40 } }],
      whoopCycles: [{ id: 'cy', date: y, strain: 18.5 }],
    },
  });
  const r = readiness(dv, TODAY);
  const keys = r.drivers.map((d) => d.key);
  for (const k of ['alcohol', 'lateMeal', 'priorStrain']) assert.ok(keys.includes(k), k);
  const late = r.drivers.find((d) => d.key === 'lateMeal');
  assert.equal(late.impact, 'negative'); assert.equal(late.value, 45, 'bed 23:00 − meal 22:15');
  for (const d of r.drivers) assert.ok(['positive', 'negative', 'neutral'].includes(d.impact) && typeof d.text === 'string');
  const w = r.drivers.map((d) => d.weight);
  assert.deepEqual(w, [...w].sort((a, b) => b - a));
});

test('readiness: days-since-dose driver only when history shows an effect', () => {
  const mondays = dateRange(addDays(TODAY, -40), TODAY).filter((d) => dayOfWeek(d) === 0);
  const protocolItems = [{ id: 'pep', name: 'P', kind: 'peptide', schedule: { type: 'days', days: [0] }, active: true }];
  const doses = mondays.map((d) => ({ itemId: 'pep', date: d }));
  // TODAY (Sat) is 5 days after Monday's dose. Plant lower recovery 5 days after each dose.
  const withEffect = history({ extra: { protocolItems, doses } });
  for (const r of withEffect.store.all('whoopRecovery')) if (r.date < TODAY && dayOfWeek(r.date) === 5) r.recovery = 30 + (r.hrv - 60);
  withEffect.invalidate();
  const a = readiness(withEffect, TODAY);
  const drv = a.drivers.find((d) => d.key === 'daysSinceDose');
  assert.ok(drv, 'effect detected'); assert.equal(drv.impact, 'negative'); assert.match(drv.text, /Day 5 after a dose/);
  const b = readiness(history({ extra: { protocolItems, doses } }), TODAY);
  assert.equal(b.drivers.find((d) => d.key === 'daysSinceDose'), undefined, 'no effect → no driver');
});

test('readiness: focus window avoids calendar events; no data is reported plainly', () => {
  const plain = readiness(history(), TODAY);
  assert.equal(plain.focus.start, '07:30'); assert.equal(plain.focus.end, '10:00');
  const busy = readiness(history({ extra: { calendarEvents: [{ id: 'e', date: TODAY, start: iso(TODAY, '08:00'), end: iso(TODAY, '09:30'), status: 'confirmed', isForge: false }] } }), TODAY);
  const s = hmToMin(busy.focus.start), e = hmToMin(busy.focus.end);
  assert.ok(e - s >= 90 && e - s <= 150);
  assert.ok(s >= 570 || e <= 480, `focus ${busy.focus.start}–${busy.focus.end} overlaps the event`);
  const none = readiness(fixture({}, { today: TODAY }), TODAY);
  assert.equal(none.status, 'no-data'); assert.equal(none.band, null); assert.equal(none.score, null);
  assert.match(none.summary, /No recovery data/);
  assert.ok(none.focus.start, 'focus falls back to the target wake time');
  for (const k of ['date', 'status', 'band', 'score', 'metrics', 'drivers', 'training', 'focus', 'flags', 'summary']) assert.ok(k in none, k);
});
