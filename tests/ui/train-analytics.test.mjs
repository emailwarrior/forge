// Train area: analytics contract the logger relies on (set kinds counted as working sets, PR session ids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, seedExercises } from '../../js/core/schema.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { isWorkingSet, exerciseHistory, prs, weeklyMuscleVolume } from '../../js/analytics/strength.js';
import { buildDaily } from '../../js/analytics/daily.js';
import { priorBests, sessionRecords, isPr } from '../../js/ui/parts/train-logic.js';

function dvWith(sessions) {
  const store = createStore({ owner: 'app' });
  const shards = new Map();
  const put = (coll, f) => {
    const r = makeRecord(f.id, f, 1000); const path = shardPath(coll, 'app', periodOf(coll, r));
    if (!shards.has(path)) shards.set(path, { r: {} }); shards.get(path).r[r.id] = r;
  };
  for (const e of seedExercises()) put('exercises', e);
  for (const s of sessions) put('sessions', s);
  for (const [path, sh] of shards) store.loadShard(path, sh, { dirty: false });
  return makeDataView(store, { today: '2026-09-26', tz: 'America/New_York' });
}
const set = (w, reps, kind = 'work', done = true) => ({ w, reps, rpe: null, kind, done });
const BENCH = 'ex-bench-press';

test('train/analytics: drop and failure sets are working sets; warm-ups and undone sets are not', () => {
  assert.equal(isWorkingSet(set(185, 8)), true);
  assert.equal(isWorkingSet({ w: 185, reps: 8 }), true, 'missing kind');
  assert.equal(isWorkingSet(set(185, 8, 'working')), true, "'working' alias");
  assert.equal(isWorkingSet(set(185, 8, 'failure')), true);
  assert.equal(isWorkingSet(set(135, 12, 'drop')), true);
  assert.equal(isWorkingSet(set(95, 10, 'warmup')), false);
  assert.equal(isWorkingSet(set(185, 8, 'work', false)), false);
  const dv = dvWith([{ id: 's1', date: '2026-09-22', startAt: '2026-09-22T17:00:00-04:00', endAt: '2026-09-22T18:00:00-04:00', entries: [
    { id: 'a', exerciseId: BENCH, sets: [set(95, 10, 'warmup'), set(185, 8), set(185, 7, 'failure'), set(135, 12, 'drop'), set(185, 8, 'work', false)] }] }]);
  const h = exerciseHistory(dv, BENCH)[0];
  assert.equal(h.sets, 3); assert.equal(h.volume, 185 * 8 + 185 * 7 + 135 * 12);
  const row = buildDaily(dv, '2026-09-22', '2026-09-22')[0];
  assert.equal(row.sessionSets, 3, 'daily rows count the same sets');
  const chest = weeklyMuscleVolume(dv, '2026-09-21', '2026-09-27').find((v) => v.muscle === 'chest');
  assert.equal(chest.hardSets, 3);
});

test('train/analytics: PRs carry their session id and agree with the logger summary', () => {
  const s = (id, date, sets, startAt = `${date}T17:00:00-04:00`) => ({ id, date, startAt, endAt: `${date}T18:00:00-04:00`, entries: [{ id: 'a', exerciseId: BENCH, sets }] });
  const sessions = [
    s('s1', '2026-09-01', [set(185, 5), set(185, 5)]),
    s('s2', '2026-09-04', [set(190, 5), set(175, 8)]),
    s('s3', '2026-09-08', [set(195, 5), set(180, 8), set(200, 2, 'failure')]),
  ];
  const dv = dvWith(sessions);
  const all = prs(dv);
  assert.deepEqual(all.map((p) => [p.sessionId, p.date, p.type, p.value]), [
    ['s2', '2026-09-04', 'e1rm', 221.7], ['s2', '2026-09-04', 'weight', 190],
    ['s3', '2026-09-08', 'e1rm', 228], ['s3', '2026-09-08', 'weight', 200],
  ]);
  const cur = dv.allSessions().find((x) => x.id === 's3');
  const recs = sessionRecords(cur, new Map([[BENCH, priorBests(dv.allSessions(), BENCH, cur)]]));
  assert.deepEqual(recs.filter(isPr).map((r) => [r.type, r.value, r.prev]), all.filter((p) => p.sessionId === 's3').map((p) => [p.type, p.value, p.prev]));
});
