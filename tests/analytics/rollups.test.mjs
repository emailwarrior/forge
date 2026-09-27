// finance.js, weekly.js and context.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { addDays, dateRange } from '../../js/core/util.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { equityFor, netWorth, netWorthSeries, financeSummary } from '../../js/analytics/finance.js';
import { weekStats } from '../../js/analytics/weekly.js';
import { contextPack } from '../../js/analytics/context.js';
import { loadDemo } from '../../js/dev/demo.js';

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
function demo() { const store = createStore({ owner: 'app' }); loadDemo(store, { today: TODAY }); return makeDataView(store, { today: TODAY }); }

test('finance: equity formula, net worth by category, series and summary', () => {
  const fin = { mult: 10, stake: 20, expense: 5000 };
  assert.equal(equityFor(20000, fin), (20000 - 5000) * 12 * 10 * 0.2);
  assert.equal(equityFor(4000, fin), 0, 'never negative');
  assert.equal(equityFor(null, fin), null);
  assert.equal(equityFor(20000, {}), 0, 'no stake configured → 0');
  const snap = { month: '2026-09', gross: 20000, items: [
    { name: 'Cash', type: 'asset', value: 12000, category: 'cash' }, { name: 'Brokerage', type: 'asset', value: 25000, category: 'investments' },
    { name: 'Savings', type: 'asset', value: 3000, category: 'cash' }, { name: 'Loan', type: 'liability', value: 9000, category: 'debt' },
  ] };
  const nw = netWorth(snap, fin);
  assert.deepEqual(nw, { total: 40000 - 9000 + 360000, equity: 360000, assets: 40000, liabilities: 9000, byCategory: { cash: 15000, investments: 25000, debt: -9000 } });
  assert.equal(netWorth(null, fin).total, null);
  const dv = fixture({ settings: [{ id: 'finance', ...fin }], snapshots: [{ id: '2026-08', ...snap, month: '2026-08', gross: 10000 }, { id: '2026-09', ...snap }] });
  const series = netWorthSeries(dv);
  assert.deepEqual(series.map((s) => s.month), ['2026-08', '2026-09']);
  const sum = financeSummary(dv);
  assert.equal(sum.latest.month, '2026-09'); assert.equal(sum.previous.month, '2026-08');
  assert.equal(sum.delta, 360000 - 120000);
});

test('weekly: stats for a Mon–Sun week with factual highlights', () => {
  const dv = demo();
  const w = weekStats(dv, '2026-09-16'); // any day normalizes to its Monday
  for (const k of ['week', 'from', 'to', 'daysLogged', 'averages', 'deltas', 'best', 'worst', 'perfectDays', 'training', 'weightChange', 'adherence', 'highlights', 'focusCandidates']) assert.ok(k in w, k);
  assert.equal(w.week, '2026-W38'); assert.equal(w.from, '2026-09-14'); assert.equal(w.to, '2026-09-20');
  assert.equal(w.daysLogged, 7); assert.equal(w.complete, true);
  assert.ok(w.training.sessions >= 4 && w.training.sets > 0 && Number.isInteger(w.training.prs));
  assert.ok(typeof w.averages.recovery === 'number' && typeof w.deltas.recovery === 'number');
  assert.ok(w.best.date >= w.from && w.best.date <= w.to);
  for (const k of ['protein', 'kcal', 'stack']) assert.ok(k in w.adherence, k);
  assert.ok(w.highlights.length >= 3 && w.highlights.every((h) => typeof h === 'string' && h.length < 120));
  const gaps = w.focusCandidates.map((c) => c.gap);
  assert.deepEqual(gaps, [...gaps].sort((a, b) => b - a));
  for (const c of w.focusCandidates) assert.ok(c.key && c.text && c.reason);
});

test('weekly: focus candidates rank the biggest gaps vs targets', () => {
  const from = '2026-09-14';
  const meals = [], sleep = [], plan = [];
  for (const d of dateRange(from, '2026-09-20')) {
    meals.push({ date: d, at: `${d}T12:00:00-04:00`, status: 'ready', totals: { kcal: 2950, protein: 110 } });
    sleep.push({ date: d, nap: false, bedtime: '00:30', wake: '06:30', asleepMin: 330, needMin: 480 });
    plan.push({ date: d, start: '09:00', end: '11:00', category: 'deep', title: 'x', status: 'done' });
  }
  const dv = fixture({ settings: [{ id: 'targets', mode: 'manual', kcal: 3000, proteinG: 180 }], meals, whoopSleep: sleep, plan });
  const w = weekStats(dv, from);
  const keys = w.focusCandidates.map((c) => c.key);
  assert.equal(keys[0], 'sleep', 'saturated gaps tie-break toward sleep');
  assert.equal(w.focusCandidates[0].gap, 1);
  assert.ok(keys.includes('protein'));
  assert.ok(!keys.includes('plan'), 'plan adherence was 100%');
  assert.ok(!keys.includes('intake'), 'calories within 5% of target');
  assert.match(w.focusCandidates.find((c) => c.key === 'protein').reason, /0 of 7 logged days \(avg 110 g vs 180 g target\)/);
});

test('context: compact markdown with CSV, neutral labels, no journal unless asked', () => {
  const dv = demo();
  const md = contextPack(dv, TODAY);
  assert.ok(md.startsWith(`# FORGE context — ${TODAY}`));
  const csv = md.split('```csv\n')[1].split('\n```')[0].split('\n');
  assert.equal(csv[0], 'date,rec,hrv,rhr,sleep_h,bed,strain,kcal,prot_g,meal_bed_h,train,wt_trend,exec,deep_h,meet_h,dose_d,alc,energy');
  assert.equal(csv.length, 31, 'header + 30 days');
  assert.ok(csv.every((l) => l.split(',').length === 18));
  assert.match(md, /## Protocol items/); assert.match(md, /- Protocol 1 mg/);
  assert.doesNotMatch(md, /Weekly peptide/, 'neutralLabel replaces the item name');
  assert.doesNotMatch(md, /example\.iam|clientId|apiKey|token/i);
  assert.doesNotMatch(md, /moving dinner earlier/, 'journal excluded by default');
  assert.match(contextPack(dv, TODAY, { includeJournal: true }), /moving dinner earlier/);
  assert.match(md, /## Labs/); assert.match(md, /LDL-C/);
  assert.ok(md.length < 24000, `context is ${md.length} chars`);
  const d7 = contextPack(dv, TODAY, { days: 7 });
  assert.equal(d7.split('```csv\n')[1].split('\n```')[0].split('\n').length, 8);
  const empty = contextPack(fixture({}), TODAY, { days: 3 });
  assert.match(empty, /date,rec,hrv/);
});
