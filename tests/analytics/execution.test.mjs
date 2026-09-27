import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { evaluateStandard, dayExecution, streaks, adherenceByStandard, isApplicable } from '../../js/analytics/execution.js';

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
const MON = '2026-09-21', TUE = '2026-09-22', TODAY = '2026-09-23', FUTURE = '2026-09-25', SAT = '2026-09-19';
const std = (id, kind, extra = {}) => ({ id, name: id, category: 'Test', kind, weight: 2, required: true, active: true, effectiveFrom: '1970-01-01', ...extra });
const item = (name, grams = 100, kcal = 300, protein = 30) => ({ name, grams, kcal, protein });
const meal = (date, hm, items) => ({ date, at: iso(date, hm), status: 'ready', items, totals: { kcal: items.reduce((s, i) => s + i.kcal, 0), protein: items.reduce((s, i) => s + i.protein, 0) } });

const STANDARDS = [
  std('wake', 'time', { auto: 'whoop.wake', target: { op: '<=', value: 'target' } }),
  std('sleep', 'number', { auto: 'whoop.sleep', target: { op: '>=', value: 7, unit: 'h' } }),
  std('sleepMin', 'duration', { auto: 'whoop.sleep', target: { op: '>=', value: 420, unit: 'min' }, required: false }),
  std('plan', 'number', { auto: 'plan.adherence', target: { op: '>=', value: 90, unit: '%' } }),
  std('train', 'check', { auto: 'training.session' }),
  std('meals', 'number', { auto: 'nutrition.meals', target: { op: '>=', value: 3 } }),
  std('protein', 'number', { auto: 'nutrition.protein', target: { op: '>=', value: 'target', unit: 'g' } }),
  std('kcal', 'number', { auto: 'nutrition.kcal', target: { op: '>=', value: 'target' } }),
  std('chicken', 'check', { auto: 'nutrition.item:CHICKEN' }),
  std('noFried', 'avoid', { auto: 'nutrition.item:fried' }),
  std('stack', 'check', { auto: 'protocol.stack:AM' }),
  std('pep', 'check', { auto: 'protocol.item:pep' }),
  std('caffeine', 'avoid', { auto: 'day.caffeineCutoff', required: false, weight: 1 }),
  std('deep', 'number', { auto: 'day.deepWork', target: { op: '>=', value: 'target', unit: 'h' } }),
  std('read', 'duration', { target: { op: '>=', value: 30, unit: 'min' } }),
  std('bed', 'time', { target: { op: '<=', value: '23:00' }, required: false }),
  std('weekend', 'check', { days: [5, 6] }),
  std('newish', 'check', { effectiveFrom: TUE }),
  std('off', 'check', { active: false }),
];

function execFixture(extra = {}) {
  return fixture({
    settings: [{ id: 'targets', mode: 'manual', kcal: 2800, proteinG: 150, wake: '06:30', caffeineCutoff: '12:00', deepWorkTargetH: 4 }],
    standards: STANDARDS,
    whoopSleep: [
      { id: 's-mon', date: MON, nap: false, bedtime: '23:00', wake: '06:45', asleepMin: 400 },
      { id: 's-tue', date: TUE, nap: false, bedtime: '22:40', wake: '06:20', asleepMin: 450 },
      { id: 's-today', date: TODAY, nap: false, bedtime: '22:50', wake: '06:25', asleepMin: 430 },
    ],
    whoopWorkouts: [{ id: 'w-tue', date: TUE, start: iso(TUE, '17:00'), end: iso(TUE, '18:00'), sport: 'Running' }],
    plan: [
      { date: TUE, start: '09:00', end: '11:00', category: 'deep', status: 'done', title: 'x' },
      { date: TUE, start: '13:00', end: '14:00', category: 'admin', status: 'done', title: 'y' },
      { date: MON, start: '09:00', end: '11:00', category: 'deep', status: 'partial', title: 'x' },
    ],
    meals: [
      meal(TUE, '08:00', [item('Eggs', 150, 300, 25)]), meal(TUE, '12:30', [item('Grilled Chicken Breast', 200, 1000, 90)]), meal(TUE, '19:00', [item('Rice', 250, 1200, 45)]),
      meal(MON, '19:00', [item('Fried rice', 300, 900, 20)]),
      meal(TODAY, '08:00', [item('Oats', 80, 400, 20)]),
    ],
    protocolItems: [
      { id: 'a1', name: 'A1', kind: 'supplement', schedule: { type: 'daily', stack: 'AM' }, active: true },
      { id: 'a2', name: 'A2', kind: 'supplement', schedule: { type: 'daily', stack: 'am' }, active: true },
      { id: 'pep', name: 'P', kind: 'peptide', schedule: { type: 'days', days: [0] }, active: true },
    ],
    doses: [
      { itemId: 'a1', date: MON }, { itemId: 'a2', date: MON }, { itemId: 'pep', date: MON },
      { itemId: 'a1', date: TUE }, { itemId: 'a2', date: TUE, skipped: true },
    ],
    days: [
      { id: MON, date: MON, caffeineLastAt: '15:00', deepWorkH: 2 },
      { id: TUE, date: TUE, caffeineLastAt: '11:30', deepWorkH: 4.5 },
      { id: SAT, date: SAT },
    ],
    checks: [
      { id: `${TUE}:read`, date: TUE, standardId: 'read', value: 45, source: 'manual' },
      { id: `${TUE}:bed`, date: TUE, standardId: 'bed', value: '00:30', source: 'manual' },
      { id: `${MON}:bed`, date: MON, standardId: 'bed', value: '22:45', source: 'manual' },
      { id: `${SAT}:caffeine`, date: SAT, standardId: 'caffeine', value: true, source: 'manual' },
      { id: `${SAT}:train`, date: SAT, standardId: 'train', value: true, source: 'manual' },
      { id: `${MON}:meals`, date: MON, standardId: 'meals', value: true, source: 'manual' },
    ],
    ...extra,
  });
}
const ev = (dv, id, date) => evaluateStandard(dv, STANDARDS.find((s) => s.id === id), date);

test('execution: whoop.wake / whoop.sleep / plan.adherence / day.deepWork', () => {
  const dv = execFixture();
  let r = ev(dv, 'wake', TUE);
  assert.equal(r.value, '06:20'); assert.equal(r.done, true); assert.equal(r.source, 'auto'); assert.deepEqual(r.target, { op: '<=', value: '06:30', unit: null });
  assert.equal(ev(dv, 'wake', MON).done, false);
  r = ev(dv, 'sleep', TUE); assert.equal(r.value, 7.5); assert.equal(r.done, true); assert.equal(r.display, '7.5 h');
  assert.equal(ev(dv, 'sleep', MON).done, false);
  assert.equal(ev(dv, 'sleepMin', TUE).done, true, 'hours converted to the target unit (min)');
  r = ev(dv, 'plan', TUE); assert.equal(r.value, 100); assert.equal(r.done, true);
  r = ev(dv, 'plan', MON); assert.equal(r.value, 50); assert.equal(r.done, false);
  r = ev(dv, 'deep', TUE); assert.equal(r.value, 4.5); assert.equal(r.done, true); assert.equal(r.target.value, 4);
  assert.equal(ev(dv, 'deep', MON).done, false);
  assert.equal(ev(dv, 'wake', '2026-09-10').done, null, 'no sleep data → unknown');
});

test('execution: training.session counts a session or any WHOOP workout', () => {
  const dv = execFixture({ sessions: [{ id: 'se', date: MON, entries: [] }] });
  assert.equal(ev(dv, 'train', TUE).done, true, 'WHOOP workout only');
  assert.equal(ev(dv, 'train', MON).done, true, 'app session only');
  assert.equal(ev(dv, 'train', '2026-09-20').done, null, 'before any training was tracked → unknown, not missed');
  const today = ev(dv, 'train', TODAY);
  assert.equal(today.done, null); assert.equal(today.status, 'pending');
  const dv2 = execFixture({ sessions: [{ id: 'se0', date: SAT, entries: [] }] });
  assert.equal(ev(dv2, 'train', '2026-09-20').done, false, 'past day without training after tracking began');
});

test('execution: nutrition.meals is unknown before the first logged meal', () => {
  const dv = execFixture();
  assert.equal(ev(dv, 'meals', '2026-09-01').value, null);
  assert.equal(ev(dv, 'meals', '2026-09-01').done, null);
});

test('execution: nutrition sources (meals, protein, kcal, item text)', () => {
  const dv = execFixture();
  let r = ev(dv, 'meals', TUE); assert.equal(r.value, 3); assert.equal(r.done, true); assert.equal(r.display, '3 meals');
  r = ev(dv, 'protein', TUE); assert.equal(r.value, 160); assert.equal(r.target.value, 150); assert.equal(r.done, true);
  r = ev(dv, 'kcal', TUE); assert.equal(r.value, 2500); assert.equal(r.target.value, 2800); assert.equal(r.done, false);
  assert.equal(ev(dv, 'chicken', TUE).done, true, 'case-insensitive item match');
  assert.equal(ev(dv, 'chicken', MON).done, false);
  assert.equal(ev(dv, 'chicken', '2026-09-20').done, null, 'no meals logged → unknown');
  r = ev(dv, 'noFried', TUE); assert.equal(r.done, true); assert.equal(r.display, 'Avoided');
  r = ev(dv, 'noFried', MON); assert.equal(r.done, false); assert.equal(r.display, 'Slipped');
  assert.equal(ev(dv, 'protein', '2026-09-20').done, null, 'no meals → protein unknown');
  // today: partial intake is pending rather than missed
  r = ev(dv, 'protein', TODAY); assert.equal(r.value, 20); assert.equal(r.done, null); assert.equal(r.status, 'pending');
});

test('execution: protocol.stack and protocol.item (skipped doses do not count)', () => {
  const dv = execFixture();
  assert.equal(ev(dv, 'stack', MON).done, true);
  assert.equal(ev(dv, 'stack', TUE).done, false, 'second AM item was skipped');
  assert.equal(ev(dv, 'pep', MON).done, true);
  const r = ev(dv, 'pep', TUE);
  assert.equal(r.done, null); assert.equal(r.status, 'na', 'not due that day');
});

test('execution: day.caffeineCutoff — unknown without a log unless a manual check exists', () => {
  const dv = execFixture();
  assert.equal(ev(dv, 'caffeine', TUE).done, true);
  assert.equal(ev(dv, 'caffeine', MON).done, false);
  const sat = ev(dv, 'caffeine', SAT);
  assert.equal(sat.done, true); assert.equal(sat.source, 'manual');
  const noLog = ev(dv, 'caffeine', '2026-09-20');
  assert.equal(noLog.done, null); assert.equal(noLog.source, 'none');
});

test('execution: manual checks override auto; legacy true; time kind with evening targets', () => {
  const dv = execFixture();
  const sat = ev(dv, 'train', SAT); assert.equal(sat.done, true); assert.equal(sat.source, 'manual');
  const legacy = ev(dv, 'meals', MON); assert.equal(legacy.value, true); assert.equal(legacy.done, true, 'legacy boolean true = done for any kind');
  const read = ev(dv, 'read', TUE); assert.equal(read.done, true); assert.equal(read.value, 45); assert.equal(read.display, '45 min');
  assert.equal(ev(dv, 'bed', TUE).done, false, '00:30 is later than a 23:00 target');
  assert.equal(ev(dv, 'bed', MON).done, true);
  // Manual-only standard without a check: missed once the day was opened, unknown otherwise.
  const monRead = ev(dv, 'read', MON); assert.equal(monRead.done, false); assert.equal(monRead.status, 'missed');
  assert.equal(ev(dv, 'read', '2026-09-20').done, null);
  // A manual false beats a positive auto source.
  const dv2 = execFixture({ checks: [{ id: `${TUE}:train`, date: TUE, standardId: 'train', value: false, source: 'manual' }] });
  const t = ev(dv2, 'train', TUE); assert.equal(t.done, false); assert.equal(t.source, 'manual');
});

test('execution: applicability (days Mon=0, effectiveFrom, active) and future dates', () => {
  const dv = execFixture();
  const weekend = STANDARDS.find((s) => s.id === 'weekend');
  assert.equal(isApplicable(weekend, TUE), false); assert.equal(isApplicable(weekend, SAT), true);
  assert.equal(ev(dv, 'weekend', TUE).applicable, false);
  assert.equal(ev(dv, 'newish', MON).applicable, false); assert.equal(ev(dv, 'newish', TUE).applicable, true);
  assert.equal(ev(dv, 'off', TUE).applicable, false);
  const fut = ev(dv, 'train', FUTURE); assert.equal(fut.applicable, true); assert.equal(fut.done, null); assert.equal(fut.status, 'future');
  const ids = dayExecution(dv, TUE).items.map((i) => i.standard.id);
  assert.ok(!ids.includes('weekend') && !ids.includes('off') && ids.includes('newish'));
});

test('execution: dayExecution score = Σweight(done)/Σweight(known), required counts, perfect', () => {
  const dv = execFixture();
  const d = dayExecution(dv, TUE);
  let wDone = 0, wKnown = 0;
  for (const it of d.items) if (it.done != null) { wKnown += it.standard.weight; if (it.done) wDone += it.standard.weight; }
  assert.equal(d.score, Math.round((wDone / wKnown) * 1000) / 10);
  const req = d.items.filter((i) => i.standard.required);
  assert.equal(d.required.total, req.length);
  assert.equal(d.required.done, req.filter((i) => i.done === true).length);
  assert.equal(d.perfect, false);
  assert.equal(dayExecution(dv, FUTURE).score, null);
  assert.equal(dayExecution(dv, FUTURE).perfect, null);
  assert.ok(dayExecution(dv, TODAY).pending > 0);
});

test('execution: perfect-day streaks and adherence by standard', () => {
  const days = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
  const vals = [true, true, true, false, true, true, true];
  const dv = fixture({
    standards: [std('only', 'check'), std('opt', 'check', { required: false })],
    checks: days.map((d, i) => ({ id: `${d}:only`, date: d, standardId: 'only', value: vals[i], source: 'manual' })),
  }, { today: '2026-09-20' });
  assert.deepEqual(streaks(dv, '2026-09-20'), { current: 3, longest: 3, lastPerfect: '2026-09-20' });
  assert.deepEqual(streaks(dv, '2026-09-17'), { current: 0, longest: 3, lastPerfect: '2026-09-16' });
  const a = adherenceByStandard(dv, '2026-09-14', '2026-09-20');
  const only = a.find((x) => x.standard.id === 'only');
  assert.deepEqual({ applicableDays: only.applicableDays, knownDays: only.knownDays, doneDays: only.doneDays, rate: only.rate }, { applicableDays: 7, knownDays: 7, doneDays: 6, rate: 85.7 });
  const opt = a.find((x) => x.standard.id === 'opt');
  assert.equal(opt.doneDays, 0);
  assert.equal(opt.knownDays, 6, 'unchecked manual items count as missed on past opened days; today is still pending');
});

test('execution: today stays pending until data arrives; stored checks use done semantics', () => {
  const dv = fixture({
    standards: [std('wake', 'time', { auto: 'whoop.wake', target: { op: '<=', value: '07:00' } }), std('noFried', 'avoid', { auto: 'nutrition.item:fried' })],
    checks: [{ id: `${MON}:noFried`, date: MON, standardId: 'noFried', value: true, source: 'auto' }],
    meals: [{ date: TUE, at: iso(TUE, '12:00'), status: 'analyzing' }],
  });
  const wake = evaluateStandard(dv, STANDARDS[0], TODAY);
  assert.equal(wake.done, null); assert.equal(wake.status, 'pending', 'WHOOP not synced yet today');
  assert.equal(dayExecution(dv, TODAY).perfect, null, 'an open day is not judged');
  const noFried = { ...std('noFried', 'avoid', { auto: 'nutrition.item:fried' }) };
  const stored = evaluateStandard(dv, noFried, MON);
  assert.equal(stored.source, 'auto'); assert.equal(stored.done, true, 'a stored true is a done-value (legacy)');
  assert.equal(evaluateStandard(dv, noFried, TUE).done, null, 'meals still analyzing: cannot claim it was avoided');
});
