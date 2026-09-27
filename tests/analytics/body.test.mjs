import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { addDays, dateRange } from '../../js/core/util.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { weightTrend, rateLbPerWeek, estimateTdee, calorieTargets, goalProjection, bodySummary, mifflinStJeor } from '../../js/analytics/body.js';

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
// 60 days of constant intake and a linear weight trend (optionally with deterministic noise).
function energyFixture({ kcal = 3000, lbPerWeek = 0.5, noise = 0, days = 60, settings = [], logEvery = 1 } = {}) {
  const start = addDays(TODAY, -days);
  const meals = [], body = [];
  dateRange(start, addDays(TODAY, -1)).forEach((d, i) => {
    if (i % logEvery === 0) meals.push({ date: d, at: `${d}T12:00:00-04:00`, status: 'ready', totals: { kcal, protein: 180 } });
    const wobble = noise ? noise * Math.sin(i * 2.3) : 0;
    body.push({ date: d, at: `${d}T07:00:00-04:00`, weightLb: 170 + (lbPerWeek / 7) * i + wobble });
  });
  return fixture({ meals, body, settings }, { today: TODAY });
}

test('body: weightTrend is an EWMA of the first daily weigh-in, carried over gaps', () => {
  const s = weightTrend([
    { date: '2026-09-01', at: '2026-09-01T20:00:00-04:00', weightLb: 190 },
    { date: '2026-09-01', at: '2026-09-01T07:00:00-04:00', weightLb: 180 },
    { date: '2026-09-03', weightLb: 182 },
    { date: '2026-09-04', weightLb: null },
  ]);
  assert.deepEqual(s, [
    { date: '2026-09-01', weightLb: 180, trendLb: 180 },
    { date: '2026-09-02', weightLb: null, trendLb: 180 },
    { date: '2026-09-03', weightLb: 182, trendLb: 180.2 },
  ]);
  assert.deepEqual(weightTrend([]), []);
  assert.equal(weightTrend([{ date: '2026-09-01', weightLb: 180 }, { date: '2026-09-02', weightLb: 190 }], { alpha: 0.5 })[1].trendLb, 185);
});

test('body: rateLbPerWeek needs ≥ 7 weigh-ins in the window', () => {
  const pts = dateRange('2026-09-01', '2026-09-28').map((d, i) => ({ date: d, weightLb: 180 + i / 7 }));
  const series = weightTrend(pts);
  const r = rateLbPerWeek(series, 28);
  assert.ok(r > 0.5 && r <= 1.0, `rate ${r}`); // trend lags the raw +1 lb/wk ramp early on
  assert.equal(rateLbPerWeek(weightTrend(pts.slice(0, 6)), 28), null);
  assert.equal(rateLbPerWeek([], 28), null);
});

test('body: TDEE by energy balance — 3000 kcal/day with +0.5 lb/wk ≈ 2750', () => {
  const dv = energyFixture();
  const t = estimateTdee(dv, TODAY);
  assert.equal(t.method, 'energy-balance');
  assert.equal(t.tdee, 2750);
  assert.equal(t.n, 28); assert.equal(t.intakeAvg, 3000); assert.equal(t.trendDeltaLb, 2);
  assert.equal(t.confidence, 'high');
  // With ±1 lb daily water noise the estimate stays close.
  const noisy = estimateTdee(energyFixture({ noise: 1 }), TODAY);
  assert.ok(Math.abs(noisy.tdee - 2750) <= 200, `noisy tdee ${noisy.tdee}`);
  // Losing 1 lb/wk on 2000 kcal → 2500.
  assert.equal(estimateTdee(energyFixture({ kcal: 2000, lbPerWeek: -1 }), TODAY).tdee, 2500);
});

test('body: TDEE is insufficient without enough logged days or weigh-ins', () => {
  const sparse = estimateTdee(energyFixture({ logEvery: 3 }), TODAY);
  assert.equal(sparse.method, 'insufficient'); assert.equal(sparse.tdee, null); assert.equal(sparse.confidence, null);
  assert.match(sparse.note, /more logged day/);
  const none = estimateTdee(fixture({}, { today: TODAY }), TODAY);
  assert.equal(none.tdee, null); assert.equal(none.n, 0); assert.equal(none.intakeAvg, null);
  assert.equal(estimateTdee(energyFixture({ days: 12 }), TODAY).method, 'insufficient');
  assert.equal(estimateTdee(energyFixture({ days: 20 }), TODAY).method, 'energy-balance');
});

test('body: calorieTargets — adaptive, manual and estimate modes', () => {
  const profile = { id: 'profile', heightIn: 70, birthYear: 1990, sex: 'male', goalWeightLow: 200, goalWeightHigh: 210, goalRateLbWk: 0.5 };
  const adaptive = calorieTargets(energyFixture({ settings: [profile] }), TODAY);
  assert.equal(adaptive.basis, 'adaptive'); assert.equal(adaptive.tdee, 2750); assert.equal(adaptive.surplus, 250);
  assert.equal(adaptive.kcal, 3000);
  assert.equal(adaptive.proteinG % 5, 0);
  assert.ok(Math.abs(adaptive.proteinG - 0.9 * adaptive.weightLb) <= 2.5);
  assert.equal(adaptive.fatG, Math.round((3000 * 0.27) / 9));
  assert.equal(adaptive.carbsG, Math.round((3000 - adaptive.proteinG * 4 - adaptive.fatG * 9) / 4));
  assert.equal(adaptive.fiberG, 35);
  assert.match(adaptive.rationale, /TDEE/);

  const manual = calorieTargets(energyFixture({ settings: [profile, { id: 'targets', mode: 'manual', kcal: 2500, proteinG: 170 }] }), TODAY);
  assert.equal(manual.basis, 'manual'); assert.equal(manual.kcal, 2500); assert.equal(manual.proteinG, 170); assert.equal(manual.surplus, null);

  // Estimate: Mifflin–St Jeor × 1.55 + rate-based surplus (0.3 lb/wk → 150).
  const est = calorieTargets(fixture({ settings: [{ ...profile, goalRateLbWk: 0.3 }], body: [{ date: '2026-09-25', weightLb: 170 }] }, { today: TODAY }), TODAY);
  const bmr = mifflinStJeor({ weightLb: 170, heightIn: 70, age: 36, sex: 'male' });
  assert.equal(est.basis, 'estimate');
  assert.equal(est.tdee, Math.round((bmr * 1.55) / 10) * 10);
  assert.equal(est.kcal, Math.round((est.tdee + 150) / 10) * 10);

  const nothing = calorieTargets(fixture({}, { today: TODAY }), TODAY);
  assert.equal(nothing.kcal, null); assert.equal(nothing.proteinG, null); assert.match(nothing.rationale, /height/);
});

test('body: surplus clamps to 100–700 and drops to maintenance inside the goal range', () => {
  const fast = calorieTargets(energyFixture({ settings: [{ id: 'profile', goalWeightLow: 250, goalRateLbWk: 2 }] }), TODAY);
  assert.equal(fast.surplus, 700);
  const slow = calorieTargets(energyFixture({ settings: [{ id: 'profile', goalWeightLow: 250, goalRateLbWk: 0.1 }] }), TODAY);
  assert.equal(slow.surplus, 100);
  const inRange = calorieTargets(energyFixture({ settings: [{ id: 'profile', goalWeightLow: 170, goalWeightHigh: 190, goalRateLbWk: 0.5 }] }), TODAY);
  assert.equal(inRange.surplus, 0); assert.equal(inRange.kcal, 2750);
  // goalRateLbWk 0 (a stored null falls back to the default) → settings.targets.surplusKcal
  const fromSettings = calorieTargets(energyFixture({ settings: [{ id: 'profile', goalRateLbWk: 0 }, { id: 'targets', surplusKcal: 300 }] }), TODAY);
  assert.equal(fromSettings.surplus, 300);
});

test('body: goalProjection and bodySummary', () => {
  const dv = energyFixture({ settings: [{ id: 'profile', goalWeightLow: 185, goalWeightHigh: 195, goalRateLbWk: 0.5 }] });
  const p = goalProjection(dv, TODAY);
  assert.ok(p.currentTrendLb > 170 && p.currentTrendLb < 185);
  assert.ok(p.ratePerWeek > 0.4 && p.ratePerWeek <= 0.5, `rate ${p.ratePerWeek}`);
  assert.equal(p.onTrack, true);
  assert.ok(p.weeksToGoal > 0 && p.etaDate > TODAY);
  const s = bodySummary(dv, TODAY);
  for (const k of ['weight', 'trend', 'change7', 'change28', 'rate28', 'tdee', 'targets', 'projection', 'series']) assert.ok(k in s, k);
  assert.ok(s.change7 > 0 && s.change28 > s.change7);
  const none = goalProjection(fixture({}, { today: TODAY }), TODAY);
  assert.equal(none.currentTrendLb, null); assert.equal(none.onTrack, null);
});
