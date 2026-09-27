import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS, seedExercises } from '../../js/core/schema.js';
import { addDays } from '../../js/core/util.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { e1rm, exerciseHistory, lastPerformance, prs, weeklyMuscleVolume, progression, strengthSummary, cardioHistory } from '../../js/analytics/strength.js';

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
const work = (w, reps, extra = {}) => ({ w, reps, kind: 'work', done: true, ...extra });
const BENCH = 'ex-bench-press', PULL = 'ex-pull-up';
function liftFixture() {
  return fixture({
    exercises: seedExercises(),
    sessions: [
      { id: 's1', date: '2026-09-01', entries: [
        { id: 'a', exerciseId: BENCH, sets: [work(135, 8, { kind: 'warmup' }), work(185, 5), work(185, 5), work(185, 4), work(225, 1, { done: false })] },
        { id: 'b', exerciseId: PULL, sets: [work(0, 10), work(0, 8)] },
      ], cardio: [{ id: 'c', exerciseId: 'ex-stationary-bike', durationMin: 30, avgWatts: 180, avgHr: 140, distanceMi: 8, kcal: 300 }] },
      { id: 's2', date: '2026-09-04', entries: [{ id: 'a', exerciseId: BENCH, sets: [work(190, 5), work(190, 5), work(190, 5)] }, { id: 'b', exerciseId: PULL, sets: [work(0, 12)] }] },
      { id: 's3', date: '2026-09-08', entries: [{ id: 'a', exerciseId: BENCH, sets: [work(190, 6), { w: 195, reps: 3 }] }, { id: 'b', exerciseId: PULL, sets: [work(0, 11)] }] },
      { id: 's4', date: '2026-09-11', entries: [{ id: 'a', exerciseId: BENCH, sets: [work(200, 3)] }, { id: 'b', exerciseId: PULL, sets: [work(10, 8)] }] },
    ],
  });
}

test('strength: Epley e1RM for 1–12 reps only', () => {
  assert.equal(e1rm(100, 10), 133.3);
  assert.equal(e1rm(185, 5), 215.8);
  assert.equal(e1rm(100, 1), 100);
  assert.equal(e1rm(100, 12), 140);
  assert.equal(e1rm(100, 13), null);
  assert.equal(e1rm(0, 5), null);
  assert.equal(e1rm(100, 0), null);
  assert.equal(e1rm(null, 5), null);
});

test('strength: exercise history uses working sets (warmups and undone sets excluded)', () => {
  const dv = liftFixture();
  const h = exerciseHistory(dv, BENCH);
  assert.deepEqual(h.map((x) => x.date), ['2026-09-01', '2026-09-04', '2026-09-08', '2026-09-11']);
  assert.deepEqual(h[0].bestSet, { w: 185, reps: 5 });
  assert.equal(h[0].e1rm, 215.8); assert.equal(h[0].sets, 3); assert.equal(h[0].volume, 185 * 14); assert.equal(h[0].topW, 185);
  assert.equal(h[2].e1rm, 228); assert.equal(h[2].topW, 195, 'missing kind counts as work');
  const pull = exerciseHistory(dv, PULL);
  assert.equal(pull[0].e1rm, null, 'bodyweight at 0 lb has no e1RM');
  assert.deepEqual(pull[0].bestSet, { w: 0, reps: 10 });
});

test('strength: PRs are detected chronologically (e1rm, weight, reps for bodyweight)', () => {
  const dv = liftFixture();
  const all = prs(dv);
  const bench = all.filter((p) => p.exerciseId === BENCH).map((p) => [p.date, p.type, p.value, p.prev]);
  assert.deepEqual(bench, [
    ['2026-09-04', 'e1rm', 221.7, 215.8], ['2026-09-04', 'weight', 190, 185],
    ['2026-09-08', 'e1rm', 228, 221.7], ['2026-09-08', 'weight', 195, 190],
    ['2026-09-11', 'weight', 200, 195],
  ]);
  const pull = all.filter((p) => p.exerciseId === PULL).map((p) => [p.date, p.type, p.value, p.prev]);
  assert.deepEqual(pull, [['2026-09-04', 'reps', 12, 10]], 'first loaded session only sets a baseline');
  assert.deepEqual(prs(dv, { since: '2026-09-08' }).map((p) => p.date), ['2026-09-08', '2026-09-08', '2026-09-11']);
});

test('strength: last performance and weekly muscle volume (Mon weeks, secondary = 0.5)', () => {
  const dv = liftFixture();
  const last = lastPerformance(dv, BENCH, '2026-09-08');
  assert.equal(last.date, '2026-09-04'); assert.equal(last.sets.length, 3);
  assert.equal(lastPerformance(dv, BENCH, '2026-09-01'), null);
  const vol = weeklyMuscleVolume(dv, '2026-09-01', '2026-09-07');
  const get = (m) => vol.find((v) => v.muscle === m);
  assert.ok(vol.every((v) => v.week === '2026-08-31'));
  assert.equal(get('chest').hardSets, 6); assert.equal(get('chest').volumeLb, 185 * 14 + 190 * 15);
  assert.equal(get('triceps').hardSets, 3); assert.equal(get('shoulders').hardSets, 3);
  assert.equal(get('back').hardSets, 3); assert.equal(get('biceps').hardSets, 1.5);
});

test('strength: progression status from the e1RM slope', () => {
  const mk = (pctPerWeek) => Array.from({ length: 12 }, (_, i) => ({ date: addDays('2026-07-01', i * 5), e1rm: 200 * (1 + (pctPerWeek / 100) * (i * 5) / 7) }));
  assert.equal(progression(mk(1.5)).status, 'progressing');
  assert.equal(progression(mk(0)).status, 'plateau');
  assert.equal(progression(mk(-1.5)).status, 'regressing');
  const p = progression(mk(1.5));
  assert.ok(Math.abs(p.slopePctPerWeek - 1.5) < 0.2, String(p.slopePctPerWeek));
  assert.equal(progression(mk(1).slice(0, 2)).status, 'insufficient');
  assert.equal(progression([]).status, 'insufficient');
});

test('strength: cardio efficiency and summary shape', () => {
  const dv = liftFixture();
  const c = cardioHistory(dv);
  assert.equal(c.length, 1); assert.equal(c[0].efficiency, Math.round((180 / 140) * 1000) / 1000);
  assert.deepEqual(cardioHistory(dv, 'ex-rower'), []);
  const s = strengthSummary(dv, '2026-09-12');
  assert.ok(Array.isArray(s.topLifts) && s.topLifts.length === 2);
  const bench = s.topLifts.find((l) => l.exerciseId === BENCH);
  assert.equal(bench.name, 'Bench Press'); assert.equal(bench.e1rm, 228); assert.equal(bench.metric, 'e1rm');
  const pull = s.topLifts.find((l) => l.exerciseId === PULL);
  assert.ok(pull.metric === 'e1rm' || pull.metric === 'reps');
  assert.equal(s.sessions28, 4);
  assert.ok(Array.isArray(s.recentPrs) && Array.isArray(s.weeklySets));
  assert.ok(s.recentPrs[0].date >= s.recentPrs[s.recentPrs.length - 1].date, 'most recent first');
});

test('strength: high-rep sessions get a trend estimate; same-day last performance', async () => {
  const { createStore } = await import('../../js/core/store.js');
  const { makeDataView } = await import('../../js/analytics/dataview.js');
  const { exerciseHistory, lastPerformance, progression, prs } = await import('../../js/analytics/strength.js');
  const s = createStore({ owner: 'app' });
  s.create('exercises', { id: 'lat', name: 'Lateral Raise', muscle: 'shoulders', type: 'strength' });
  const days = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
  days.forEach((d, i) => s.create('sessions', { id: 'l' + i, date: d, startAt: d + 'T17:00:00-04:00', entries: [{ id: 'e', exerciseId: 'lat', sets: [{ w: 20 + i * 2.5, reps: 15, kind: 'work', done: true }] }] }));
  const dv = makeDataView(s, { tz: 'America/New_York', today: '2026-09-01' });
  const h = exerciseHistory(dv, 'lat');
  assert.equal(h.length, 5); assert.ok(h.every((x) => x.e1rmBasis === 'high-rep' && x.e1rm > 0));
  assert.equal(progression(h).status, 'progressing');
  assert.equal(prs(dv).filter((p) => p.type === 'e1rm').length, 0, 'PRs keep the 1–12 rep definition');
  // Two sessions on the same day: the second sees the first.
  s.create('sessions', { id: 'am', date: '2026-09-01', startAt: '2026-09-01T07:00:00-04:00', entries: [{ id: 'e', exerciseId: 'lat', sets: [{ w: 30, reps: 12, done: true }] }] });
  s.create('sessions', { id: 'pm', date: '2026-09-01', startAt: '2026-09-01T18:00:00-04:00', entries: [] });
  const dv2 = makeDataView(s, { tz: 'America/New_York', today: '2026-09-01' });
  assert.equal(lastPerformance(dv2, 'lat', '2026-09-01').date, '2026-08-31', 'without beforeAt: strictly earlier days');
  assert.equal(lastPerformance(dv2, 'lat', '2026-09-01', { beforeAt: '2026-09-01T18:00:00-04:00', excludeSessionId: 'pm' }).sessionId, 'am');
});
