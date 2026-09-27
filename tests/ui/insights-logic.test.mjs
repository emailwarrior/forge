// Insights (UI-D): pure presentation helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dateRange } from '../../js/core/util.js';
import * as L from '../../js/ui/parts/insights-logic.js';
import { BEHAVIORS, OUTCOMES } from '../../js/analytics/correlations.js';
import { createStore } from '../../js/core/store.js';
import { loadDemo } from '../../js/dev/demo.js';
import * as A from '../../js/analytics/index.js';

const TODAY = '2026-09-26'; // Saturday
const rowsFor = (from, to, fn) => dateRange(from, to).map((date, i) => ({ date, ...fn(i, date) }));

test('logic: ranges parse to the allowed set', () => {
  assert.deepEqual(L.RANGES, [14, 30, 90, 180, 365]);
  assert.equal(L.parseRange('90', 30), 90);
  assert.equal(L.parseRange(180, 30), 180);
  assert.equal(L.parseRange('45', 30), 30);
  assert.equal(L.parseRange(undefined, 14), 14);
  assert.equal(L.rangeLabel(365), '1y');
  assert.equal(L.rangeLabel(14), '14d');
});

test('logic: periodFor clamps to the first data date and sizes the previous window', () => {
  const p = L.periodFor(TODAY, 30, '2026-01-01');
  assert.deepEqual(p, { from: '2026-08-28', to: TODAY, days: 30, nominal: 30, clamped: false, prevFrom: '2026-07-29', prevTo: '2026-08-27', prevDays: 30 });
  const c = L.periodFor(TODAY, 365, '2026-06-01');
  assert.equal(c.from, '2026-06-01'); assert.equal(c.clamped, true); assert.equal(c.days, 118);
  assert.equal(c.prevFrom, null); assert.equal(c.prevTo, null); assert.equal(c.prevDays, 0);
  const partial = L.periodFor(TODAY, 90, '2026-06-01');
  assert.equal(partial.from, '2026-06-29'); assert.equal(partial.prevFrom, '2026-06-01'); assert.equal(partial.prevTo, '2026-06-28'); assert.equal(partial.prevDays, 28);
  const empty = L.periodFor(TODAY, 30, null);
  assert.equal(empty.from, '2026-08-28'); assert.equal(empty.prevFrom, null); assert.equal(empty.clamped, false);
  const future = L.periodFor(TODAY, 30, '2026-10-02');
  assert.equal(future.from, TODAY); assert.equal(future.days, 1);
});

test('logic: dataStartOf finds the earliest dated record', () => {
  const store = createStore({ owner: 'app' });
  assert.equal(L.dataStartOf(store), null);
  store.create('meals', { date: '2026-09-20', at: '2026-09-20T08:00:00-04:00' });
  store.create('health', { id: '2026-03-02', date: '2026-03-02', steps: 9000 });
  store.create('labs', { date: '2025-01-01', collectedAt: '2025-01-01' }); // labs do not start the daily history
  assert.equal(L.dataStartOf(store), '2026-03-02');
});

test('logic: values, averages, series and complete-day filters', () => {
  const rows = rowsFor('2026-09-20', '2026-09-24', (i) => ({ v: i === 2 ? null : i * 10 }));
  assert.deepEqual(L.valuesOf(rows, 'v'), [0, 10, 30, 40]);
  assert.equal(L.nOf(rows, 'v'), 4);
  assert.equal(L.avgOf(rows, 'v'), 20);
  assert.equal(L.avgOf(rows, (r) => (r.v == null ? null : r.v * 2)), 40);
  assert.deepEqual(L.seriesOf(rows, 'v').map((p) => p.y), [0, 10, null, 30, 40]);
  assert.deepEqual(L.seriesOf(rows, 'v', (v) => v / 10).map((p) => p.y), [0, 1, null, 3, 4]);
  assert.equal(L.before(rows, '2026-09-23').length, 3);
});

test('logic: bucketRows by day and by Monday week', () => {
  assert.equal(L.bucketMode(30), 'day'); assert.equal(L.bucketMode(45), 'day'); assert.equal(L.bucketMode(90), 'week');
  const rows = rowsFor('2026-09-10', '2026-09-23', (i) => ({ v: i % 3 === 0 ? null : i })); // Thu → Wed
  const day = L.bucketRows(rows, 'v');
  assert.equal(day.length, 14); assert.equal(day[0].y, null); assert.equal(day[1].y, 1); assert.equal(day[1].n, 1);
  assert.match(day[0].label, /no data/);
  const wk = L.bucketRows(rows, 'v', { mode: 'week' });
  assert.deepEqual(wk.map((b) => b.x), ['2026-09-07', '2026-09-14', '2026-09-21']);
  // Week of Sep 7: Thu..Sun = i 0..3 → values 1, 2 (0 and 3 are null) → mean 1.5
  assert.equal(wk[0].y, 1.5); assert.equal(wk[0].n, 2); assert.equal(wk[0].days, 4);
  assert.match(wk[0].label, /Week of Sep 7 · 1\.5 avg \(4 days\)/);
  const sum = L.bucketRows(rows, 'v', { mode: 'week', agg: 'sum' });
  assert.equal(sum[0].y, 3);
  const parts = L.bucketParts(rowsFor('2026-09-14', '2026-09-20', (i) => ({ a: i, b: 1 })), ['a', 'b'], { mode: 'week' });
  assert.deepEqual(parts, [{ x: '2026-09-14', parts: { a: 3, b: 1 } }]);
});

test('logic: trailingBand excludes the day itself and needs minN values', () => {
  const rows = rowsFor('2026-09-01', '2026-09-12', (i) => ({ v: i < 10 ? 50 + (i % 2 ? 2 : -2) : 90 }));
  const band = L.trailingBand(rows, 'v', { window: 30, minN: 7 });
  assert.equal(band[6].mean, null); // only 6 prior values
  assert.equal(band[7].n, 7);
  assert.ok(Math.abs(band[7].mean - 50 + 2 / 7) < 1e-9);
  // Day 10 has value 90 but its band only uses days 0..9.
  const m10 = rows.slice(0, 10).reduce((s, r) => s + r.v, 0) / 10;
  assert.ok(Math.abs(band[10].mean - m10) < 1e-9);
  assert.ok(band[10].hi > band[10].mean && band[10].lo < band[10].mean);
  // The window drops days older than `window`.
  const short = L.trailingBand(rows, 'v', { window: 3, minN: 3 });
  assert.equal(short[11].n, 3);
  const dev = L.deviationSeries(rows, 'v', { window: 30, minN: 7 });
  assert.equal(dev[5].y, null);
  assert.ok(dev[10].y > 35);
});

test('logic: deltaInfo text and tone', () => {
  assert.deepEqual(L.deltaInfo(58, 55), { value: 3, text: '+3', tone: 'good' });
  assert.deepEqual(L.deltaInfo(56.2, 57, { dp: 1, suffix: ' bpm', lowerIsBetter: true }), { value: -0.8, text: '-0.8 bpm', tone: 'good' });
  assert.equal(L.deltaInfo(50, 50).tone, null);
  assert.equal(L.deltaInfo(60, 50, { neutral: true }).tone, null);
  assert.equal(L.deltaInfo(110, 100, { pct: true }).text, '+10%');
  assert.equal(L.deltaInfo(5, null), null);
  assert.equal(L.deltaInfo(5, 0, { pct: true }), null);
  assert.equal(L.deltaInfo(3, 1, { label: 'vs prior 30d' }).text, '+2 vs prior 30d');
  assert.equal(L.pctChange(110, 100), 10);
  assert.equal(L.pctChange(1, 0), null);
});

test('logic: splitCompare, pairSummary and histogram', () => {
  const pts = [1, 2, 3, 4, 5, 6].map((x) => ({ x, y: x * 10 }));
  assert.deepEqual(L.splitCompare(pts, 4), { hi: { n: 3, mean: 50 }, lo: { n: 3, mean: 20 } });
  assert.deepEqual(L.splitCompare(pts, 4, '>'), { hi: { n: 2, mean: 55 }, lo: { n: 4, mean: 25 } });
  const s = L.pairSummary(pts);
  assert.equal(s.n, 6); assert.equal(s.rho, 1); assert.equal(s.threshold, 3.5);
  assert.equal(L.pairSummary([{ x: 1, y: 1 }]).rho, null);
  const clock = [652, 640, 700, 725, 590, 610].map((x, i) => ({ x, y: i }));
  assert.equal(L.pairSummary(clock).threshold, 646);
  assert.equal(L.pairSummary(clock, { step: 30 }).threshold, 660);
  assert.equal(L.pairSummary([{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 9, y: 3 }], { step: 10 }).threshold, 1); // rounding would empty a group
  const h = L.histogram([5, 20, 25, 31, 44, 60, null], [0, 20, 30, 40, 50, Infinity], { unit: ' g' });
  assert.deepEqual(h.map((b) => [b.label, b.n]), [['<20 g', 1], ['20–29 g', 2], ['30–39 g', 1], ['40–49 g', 1], ['50 g+', 1]]);
});

test('logic: strength index, best-in-window and median change', () => {
  const bench = [{ date: '2026-09-01', e1rm: 200 }, { date: '2026-09-03', e1rm: 204 }, { date: '2026-09-09', e1rm: 210 }];
  const squat = [{ date: '2026-09-02', e1rm: 300 }, { date: '2026-09-10', e1rm: 330 }];
  const idx = L.strengthIndex([bench, squat], '2026-09-01', '2026-09-13');
  assert.deepEqual(idx.map((p) => p.x), ['2026-08-31', '2026-09-07']);
  assert.equal(idx[0].y, 101); // bench 204/200 = 102, squat 100 → 101
  assert.equal(idx[1].y, 107.5); // bench 105, squat 110
  assert.equal(L.bestIn(bench, '2026-09-02', '2026-09-08'), 204);
  assert.equal(L.bestIn(bench, '2026-10-01', '2026-10-08'), null);
  assert.deepEqual(L.medianChange([{ cur: 110, prev: 100 }, { cur: 99, prev: 100 }, { cur: 105, prev: 100 }, { cur: 5, prev: null }]), { median: 5, n: 3 });
});

test('logic: driverPairs aligns night behaviors with the following row', () => {
  const rows = [
    { date: '2026-09-01', bedtimeMin: 1380, nextRecovery: 60, executionScore: 70, alcohol: 1 },
    { date: '2026-09-02', bedtimeMin: 1440, nextRecovery: 40, executionScore: 50, alcohol: 0 },
    { date: '2026-09-03', bedtimeMin: 1350, nextRecovery: null, executionScore: 80, alcohol: null },
  ];
  const opts = { behaviors: BEHAVIORS, outcomes: OUTCOMES };
  // bedtime (night) → nextRecovery: the bedtime of the night after row D is on row D+1.
  assert.deepEqual(L.driverPairs({ behavior: 'bedtimeMin', outcome: 'nextRecovery' }, rows, opts), [
    { x: 1440, y: 60, date: '2026-09-01' }, { x: 1350, y: 40, date: '2026-09-02' },
  ]);
  // bedtime → same-day execution uses the row itself.
  assert.deepEqual(L.driverPairs({ behavior: 'bedtimeMin', outcome: 'executionScore' }, rows, opts).map((p) => p.x), [1380, 1440, 1350]);
  // binary behaviors give booleans; unknown behavior → [].
  assert.deepEqual(L.driverPairs({ behavior: 'alcohol', outcome: 'nextRecovery' }, rows, opts).map((p) => p.x), [true, false]);
  assert.deepEqual(L.driverPairs({ behavior: 'nope', outcome: 'nextRecovery' }, rows, opts), []);
});

test('logic: fmtQ matches the analytics sentence format', () => {
  assert.equal(L.fmtQ(0.0004), 'q<0.001');
  assert.equal(L.fmtQ(0.0042), 'q=0.004');
  assert.equal(L.fmtQ(0.071), 'q=0.07');
  assert.equal(L.fmtQ(null), 'q=—');
});

test('logic: driverSentence drops the (n, q) parenthetical only', () => {
  assert.equal(L.driverSentence({ sentence: 'Days with alcohol are associated with −27 pts recovery next morning (n=89, q<0.001).' }), 'Days with alcohol are associated with −27 pts recovery next morning.');
  assert.equal(L.driverSentence({ sentence: 'Nights with ≥7.5h of sleep are associated with +0.6 energy (1–5) the next day (n=89, q=0.004).' }), 'Nights with ≥7.5h of sleep are associated with +0.6 energy (1–5) the next day.');
  assert.equal(L.driverSentence({ sentence: 'No stats here.' }), 'No stats here.');
  assert.equal(L.driverSentence(null), '');
});

test('logic: driverPairs reproduces the n of findDrivers on demo data', () => {
  const store = createStore({ owner: 'app' });
  loadDemo(store, { today: TODAY });
  const dv = A.makeDataView(store, { today: TODAY });
  const rows = A.buildDaily(dv, addDays(TODAY, -89), TODAY);
  const drivers = A.findDrivers(rows);
  assert.ok(drivers.length > 0);
  for (const d of drivers) {
    const pts = L.driverPairs(d, rows, { behaviors: BEHAVIORS, outcomes: OUTCOMES });
    assert.equal(pts.length >= d.n, true, `${d.behavior}→${d.outcome}: ${pts.length} pairs vs n=${d.n}`);
    if (d.method === 'welch') assert.equal(pts.length, d.n);
  }
});

test('logic: clock ticks, week helpers, shares', () => {
  assert.deepEqual(L.clockTicks(1330, 1420), [1320, 1350, 1380, 1410, 1440]);
  assert.deepEqual(L.clockTicks(360, 420), [360, 375, 390, 405, 420]);
  const wide = L.clockTicks(420, 1260);
  assert.ok(wide.length <= 6 && wide[0] <= 420 && wide[wide.length - 1] >= 1260);
  assert.equal(L.fmtClock(1410), '11:30 PM');
  assert.equal(L.fmtClock(1470), '12:30 AM');
  assert.equal(L.fmtClockAxis(480), '8 AM');
  assert.equal(L.fmtClockAxis(1410), '11:30 PM');
  assert.equal(L.fmtClockAxis(null), '—');
  assert.equal(L.lastCompleteWeek(TODAY), '2026-09-14');
  assert.equal(L.lastCompleteWeek('2026-09-27'), '2026-09-14'); // Sunday: this week is not over yet
  assert.equal(L.lastCompleteWeek('2026-09-28'), '2026-09-21');
  assert.equal(L.weekLabel('2026-09-14', TODAY), 'Sep 14 – 20');
  assert.equal(L.weekLabel('2026-08-31', TODAY), 'Aug 31 – Sep 6');
  assert.equal(L.weekLabel('2025-12-29', TODAY), 'Dec 29 – Jan 4, 2025');
  assert.equal(L.shareOf([1, 2, 3, 4, null], (v) => v >= 3), 50);
  assert.equal(L.shareOf([], () => true), null);
  assert.equal(L.plural(1, 'day'), '1 day');
  assert.equal(L.plural(12, 'day'), '12 days');
});
