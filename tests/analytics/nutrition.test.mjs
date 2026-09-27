import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS, NUTRIENT_KEYS } from '../../js/core/schema.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { sumNutrients, dayNutrition, adherence, microSummary, MICRO_REFERENCES } from '../../js/analytics/nutrition.js';

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
const meal = (id, date, hm, kcal, protein, extra = {}) => ({ id, date, at: iso(date, hm), status: 'ready', totals: { kcal, protein, carbs: 50, fat: 20, fiber: 8, sodium: 700, potassium: 900, calcium: 200, iron: 3, magnesium: 100, vitC: 20, vitD: 100 }, ...extra });
const SETTINGS = [{ id: 'targets', mode: 'manual', kcal: 3000, proteinG: 180, lastMealBy: '20:00' }];

test('nutrition: sumNutrients over items or meals; missing keys stay null', () => {
  const s = sumNutrients([{ kcal: 100, protein: 10 }, { kcal: 50.25, protein: 5, fiber: 2 }]);
  assert.equal(s.kcal, 150.3); assert.equal(s.protein, 15); assert.equal(s.fiber, 2); assert.equal(s.sodium, null);
  assert.deepEqual(Object.keys(s), NUTRIENT_KEYS);
  const m = sumNutrients([{ totals: { kcal: 500, protein: 40 } }, { items: [{ kcal: 200, protein: 10 }, { kcal: 100 }] }]);
  assert.equal(m.kcal, 800); assert.equal(m.protein, 50);
  assert.equal(sumNutrients([]).kcal, null);
});

test('nutrition: day view with targets, remaining, per-meal protein, timing and flags', () => {
  const D = '2026-09-22';
  const dv = fixture({
    settings: SETTINGS,
    meals: [meal('m1', D, '07:30', 800, 50), meal('m2', D, '12:15', 900, 60), meal('m3', D, '21:10', 700, 40, { ai: { confidence: 'low' } })],
    whoopSleep: [{ date: '2026-09-23', nap: false, bedtime: '23:10', wake: '07:00', asleepMin: 420 }],
  });
  const n = dayNutrition(dv, D);
  assert.equal(n.totals.kcal, 2400); assert.equal(n.mealCount, 3); assert.equal(n.complete, true);
  assert.equal(n.targets.kcal, 3000); assert.equal(n.targets.basis, 'manual');
  assert.deepEqual(n.remaining, { kcal: 600, proteinG: 30 });
  assert.deepEqual(n.pct, { kcal: 80, protein: 83 });
  assert.deepEqual(n.proteinPerMeal.map((p) => [p.mealId, p.at, p.protein]), [['m1', '07:30', 50], ['m2', '12:15', 60], ['m3', '21:10', 40]]);
  assert.equal(n.firstMealAt, '07:30'); assert.equal(n.lastMealAt, '21:10');
  assert.equal(n.lastMealToBedMin, 120, 'next night: 23:10 − 21:10');
  const texts = n.flags.map((f) => f.text).join(' | ');
  assert.match(texts, /after the 8:00 PM target/); assert.match(texts, /20% under/); assert.match(texts, /Protein 150 g of the 180 g target/); assert.match(texts, /low-confidence/);
});

test('nutrition: pending or failed meals make totals partial and are flagged', () => {
  const D = '2026-09-22';
  const dv = fixture({ settings: SETTINGS, meals: [meal('m1', D, '08:00', 800, 50), { id: 'm2', date: D, at: iso(D, '12:00'), status: 'analyzing' }, { id: 'm3', date: D, at: iso(D, '18:00'), status: 'error' }] });
  const n = dayNutrition(dv, D);
  assert.equal(n.complete, false); assert.equal(n.pending, 2); assert.equal(n.totals.kcal, 800);
  assert.ok(n.flags.some((f) => /failed analysis/.test(f.text)));
  assert.ok(n.flags.some((f) => /still analyzing/.test(f.text)));
  assert.ok(!n.flags.some((f) => /under the/.test(f.text)), 'no under-target verdict on partial days');
});

test('nutrition: adherence counts complete past days only', () => {
  const dv = fixture({ settings: SETTINGS, meals: [
    meal('a', '2026-09-19', '12:00', 3100, 190), // kcal hit, protein hit
    meal('b', '2026-09-20', '12:00', 2800, 150), // kcal hit (−6.7%), protein miss
    meal('c', '2026-09-21', '12:00', 2000, 120), // both miss
    meal('d', '2026-09-22', '12:00', 3000, 200), { id: 'e', date: '2026-09-22', at: iso('2026-09-22', '18:00'), status: 'pending' }, // incomplete → skipped
    meal('f', '2026-09-23', '12:00', 3000, 180), // today → skipped
  ] });
  const a = adherence(dv, '2026-09-19', '2026-09-23');
  assert.equal(a.days, 3);
  assert.equal(a.kcalHitRate, 67); assert.equal(a.proteinHitRate, 33);
  assert.equal(a.avgKcal, 2633); assert.equal(a.avgProtein, 153);
  assert.equal(a.avgVsTarget, Math.round((100 - 200 - 1000) / 3));
  const none = adherence(fixture({}), '2026-09-01', '2026-09-10');
  assert.deepEqual([none.days, none.kcalHitRate, none.avgKcal], [0, null, null]);
});

test('nutrition: micronutrient averages vs general references (sodium is a limit)', () => {
  const dv = fixture({ settings: SETTINGS, meals: [meal('a', '2026-09-20', '12:00', 2000, 100), meal('b', '2026-09-21', '12:00', 2000, 100), meal('c', '2026-09-21', '18:00', 2000, 100)] });
  const m = microSummary(dv, '2026-09-19', '2026-09-22');
  assert.deepEqual(m.map((x) => x.key), ['fiber', 'sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'vitC', 'vitD']);
  const sodium = m.find((x) => x.key === 'sodium');
  assert.equal(sodium.avg, 1050); assert.equal(sodium.reference, 2300); assert.equal(sodium.limit, true); assert.equal(sodium.unit, 'mg');
  const fiber = m.find((x) => x.key === 'fiber');
  assert.equal(fiber.reference, 38); assert.equal(fiber.pct, Math.round((12 / 38) * 100));
  assert.match(fiber.referenceNote, /General adult male reference/);
  assert.deepEqual(MICRO_REFERENCES.male, { fiber: 38, sodium: 2300, potassium: 3400, calcium: 1000, iron: 8, magnesium: 420, vitC: 90, vitD: 600 });
  const f = microSummary(fixture({ settings: [{ id: 'profile', sex: 'female' }] }), '2026-09-19', '2026-09-22');
  assert.equal(f.find((x) => x.key === 'iron').reference, 18); assert.equal(f[0].avg, null);
});
