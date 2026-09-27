// Train area pure logic (js/ui/parts/train-logic.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normKind, nextKind, setLabels, parseNum, fmtW, fmtLb, bump, clampRpe, setText, setsLine, clockText, durationMin,
  sessionStats, weekSummary, priorBests, bestAtLeast, setRecords, recordFlags, sessionRecords, isPr,
  copySet, placeholderFor, completeSet, moveItem, repsTarget, entryFromPlan, entriesFromTemplate, entriesFromSession,
  templateFromSession, matchWorkout, rankExercises, filterExercises, lastCardioExercise, exerciseRecords, restView,
} from '../../js/ui/parts/train-logic.js';

const set = (w, reps, extra = {}) => ({ w, reps, rpe: null, kind: 'work', done: true, ...extra });
const BENCH = 'ex-bench-press', PULL = 'ex-pull-up', BIKE = 'ex-stationary-bike';
const sess = (id, date, entries, extra = {}) => ({ id, date, startAt: `${date}T17:00:00-04:00`, endAt: `${date}T18:05:00-04:00`, entries, cardio: [], ...extra });

test('train: set kinds cycle and label (working sets numbered, W/D/F letters)', () => {
  assert.equal(normKind(undefined), 'work'); assert.equal(normKind('working'), 'work'); assert.equal(normKind('drop'), 'drop');
  assert.deepEqual(['work', 'warmup', 'drop', 'failure', 'bogus'].map(nextKind), ['warmup', 'drop', 'failure', 'work', 'work']);
  assert.deepEqual(setLabels([{ kind: 'warmup' }, {}, { kind: 'work' }, { kind: 'drop' }, { kind: 'failure' }, { kind: 'work' }]), ['W', '1', '2', 'D', 'F', '3']);
});

test('train: number parsing and formatting', () => {
  assert.equal(parseNum('185'), 185); assert.equal(parseNum(' 187,5 '), 187.5); assert.equal(parseNum('185.'), 185);
  assert.equal(parseNum(''), null); assert.equal(parseNum('.'), null); assert.equal(parseNum('12a'), null); assert.equal(parseNum(null), null);
  assert.equal(fmtW(185), '185'); assert.equal(fmtW(187.5), '187.5'); assert.equal(fmtW(null), '');
  assert.equal(fmtLb(234.33), '234.3 lb'); assert.equal(fmtLb(12450), '12,450 lb'); assert.equal(fmtLb(null), '—'); assert.equal(fmtLb(185, false), '185');
  assert.equal(bump(185, 5), 190); assert.equal(bump(2.5, -5), 0); assert.equal(bump(null, 1), 1); assert.equal(bump(8, -1, 1), 7);
  assert.equal(clampRpe(8.3), 8.5); assert.equal(clampRpe(12), 10); assert.equal(clampRpe(null), null);
});

test('train: set text and previous-performance line', () => {
  assert.equal(setText(set(185, 8)), '185×8');
  assert.equal(setText(set(0, 12), true), 'BW×12'); assert.equal(setText(set(25, 8), true), '+25×8');
  assert.equal(setsLine([set(135, 10, { kind: 'warmup' }), set(185, 8), set(185, 8), set(185, 7)]), '185×8, 185×8, 185×7');
  assert.equal(setsLine([set(135, 10, { kind: 'warmup' })]), '135×10', 'falls back to all sets');
});

test('train: clock and duration', () => {
  assert.equal(clockText(7000), '0:07'); assert.equal(clockText((42 * 60 + 18) * 1000), '42:18'); assert.equal(clockText(3912000), '1:05:12'); assert.equal(clockText(-5), '0:00');
  assert.equal(durationMin(sess('a', '2026-09-22', [])), 65);
  assert.equal(durationMin({ startAt: '2026-09-22T17:00:00-04:00' }), null);
});

test('train: session stats and week summary count what analytics count', () => {
  const s = sess('a', '2026-09-22', [
    { id: 'e1', exerciseId: BENCH, sets: [set(135, 10, { kind: 'warmup' }), set(185, 8), set(185, 7, { kind: 'failure' }), set(135, 12, { kind: 'drop' }), set(185, 8, { done: false })] },
    { id: 'e2', exerciseId: PULL, sets: [set(0, 10)] },
  ], { cardio: [{ id: 'c', exerciseId: BIKE, durationMin: 25 }, { id: 'd', exerciseId: BIKE }] });
  const st = sessionStats(s);
  assert.equal(st.workingSets, 4, 'work + failure + drop + bodyweight; warm-up and undone excluded');
  assert.equal(st.volumeLb, 185 * 8 + 185 * 7 + 135 * 12);
  assert.equal(st.pendingSets, 1); assert.equal(st.doneSets, 5); assert.equal(st.totalSets, 6);
  assert.equal(st.exercises, 2); assert.equal(st.cardioMin, 25); assert.equal(st.cardioCount, 2); assert.equal(st.durationMin, 65);
  const wk = weekSummary([s, sess('b', '2026-09-24', [{ id: 'x', exerciseId: BENCH, sets: [set(100, 10)] }], { endAt: null })]);
  assert.deepEqual(wk, { sessions: 2, workingSets: 5, volumeLb: st.volumeLb + 1000, cardioMin: 25, trainingMin: 65 });
});

const HIST = [
  sess('s1', '2026-09-01', [{ id: 'a', exerciseId: BENCH, sets: [set(135, 8, { kind: 'warmup' }), set(185, 5), set(185, 5)] }, { id: 'b', exerciseId: PULL, sets: [set(0, 10)] }]),
  sess('s2', '2026-09-04', [{ id: 'a', exerciseId: BENCH, sets: [set(190, 5), set(175, 8), set(225, 1, { done: false })] }, { id: 'b', exerciseId: PULL, sets: [set(0, 12)] }]),
];

test('train: prior bests mirror analytics (working sets, sessions before the reference)', () => {
  const ref = sess('cur', '2026-09-08', []);
  const b = priorBests(HIST, BENCH, ref);
  assert.equal(b.sessions, 2); assert.equal(b.e1rm, 221.7); assert.equal(b.topW, 190); assert.equal(b.maxReps0, null);
  assert.deepEqual(b.repMax, { 5: 190, 8: 175 });
  assert.equal(bestAtLeast(b.repMax, 6), 175); assert.equal(bestAtLeast(b.repMax, 5), 190); assert.equal(bestAtLeast(b.repMax, 9), null);
  assert.equal(priorBests(HIST, PULL, ref).maxReps0, 12);
  assert.equal(priorBests(HIST, BENCH, HIST[1]).sessions, 1, 'the reference session and later ones are excluded');
  const sameDayEarlier = priorBests([...HIST, { ...HIST[1], id: 's2b', startAt: '2026-09-04T07:00:00-04:00' }], BENCH, HIST[1]);
  assert.equal(sameDayEarlier.sessions, 2, 'an earlier session on the same day counts');
});

test('train: set records — e1RM/weight PRs, rep bests, bodyweight reps, baseline', () => {
  const b = priorBests(HIST, BENCH, sess('cur', '2026-09-08', []));
  assert.deepEqual(setRecords(set(195, 5), b).map((r) => r.type), ['e1rm', 'weight']);
  assert.deepEqual(setRecords(set(180, 6), b), [{ type: 'repBest', value: 180, prev: 175, reps: 6 }], 'heavier than ever for 6+ reps, below the e1RM best');
  assert.deepEqual(setRecords(set(180, 8), b).map((r) => r.type), ['e1rm', 'repBest']);
  assert.deepEqual(setRecords(set(175, 8), b), [], 'ties are not records');
  assert.deepEqual(setRecords(set(100, 15), b), [], 'no history at 15+ reps');
  assert.deepEqual(setRecords(set(195, 5, { kind: 'warmup' }), b), [], 'warm-ups never count');
  assert.deepEqual(setRecords(set(195, 5, { done: false }), b), [], 'undone sets never count');
  const pull = priorBests(HIST, PULL, sess('cur', '2026-09-08', []));
  assert.deepEqual(setRecords(set(0, 13), pull), [{ type: 'reps', value: 13, prev: 12 }]);
  assert.deepEqual(setRecords(set(195, 5), priorBests([], BENCH, null)), [], 'first session is the baseline');
});

test('train: record flags run through the session (a repeat of the same set is not flagged twice)', () => {
  const b = priorBests(HIST, BENCH, sess('cur', '2026-09-08', []));
  const entries = [{ id: 'x', exerciseId: BENCH, sets: [set(195, 5), set(195, 5), set(200, 5), null, set(180, 6)] }];
  const flags = recordFlags(entries, BENCH, b).get('x');
  assert.deepEqual(flags.map((f) => f.map((r) => r.type)), [['e1rm', 'weight'], [], ['e1rm', 'weight'], [], ['repBest']]);
});

test('train: session records match analytics PR rules and add the best rep record', () => {
  const cur = sess('cur', '2026-09-08', [
    { id: 'x', exerciseId: BENCH, sets: [set(195, 5), set(200, 3), set(180, 8)] },
    { id: 'y', exerciseId: PULL, sets: [set(0, 14)] },
    { id: 'z', exerciseId: 'ex-new', sets: [set(50, 10)] },
  ]);
  const bests = new Map([BENCH, PULL, 'ex-new'].map((id) => [id, priorBests(HIST, id, cur)]));
  const recs = sessionRecords(cur, bests);
  assert.deepEqual(recs.filter(isPr).map((r) => [r.exerciseId, r.type, r.value, r.prev]), [
    [BENCH, 'e1rm', 228, 221.7], [BENCH, 'weight', 200, 190], [PULL, 'reps', 14, 12],
  ]);
  assert.deepEqual(recs.filter((r) => !isPr(r)), [{ exerciseId: BENCH, type: 'repBest', value: 180, reps: 8, prev: 175 }]);
});

test('train: add set copies the previous set; suggestions; completing a set', () => {
  assert.deepEqual(copySet(set(185, 8, { rpe: 8, kind: 'failure' })), { w: 185, reps: 8, rpe: null, kind: 'failure', done: false });
  assert.deepEqual(copySet(null, { w: 100, reps: 5 }), { w: 100, reps: 5, rpe: null, kind: 'work', done: false });
  assert.deepEqual(copySet(null), { w: null, reps: null, rpe: null, kind: 'work', done: false });
  const last = [set(135, 10, { kind: 'warmup' }), set(185, 8), set(185, 7)];
  assert.deepEqual(placeholderFor([], 0, last), { w: 185, reps: 8 });
  assert.deepEqual(placeholderFor([{ w: null, reps: null }, { w: null, reps: null }, {}], 2, last), { w: 185, reps: 7 }, 'clamped to the last working set');
  assert.deepEqual(placeholderFor([set(190, 6), {}], 1, last), { w: 190, reps: 6 }, 'previous set of this session first');
  assert.deepEqual(placeholderFor([], 0, null), { w: null, reps: null });
  assert.deepEqual(completeSet({ w: null, reps: null, kind: 'work', done: false }, { w: 185, reps: 8 }).set, { w: 185, reps: 8, kind: 'work', done: true });
  assert.deepEqual(completeSet({ w: 190, reps: null, done: false }, null), { error: 'reps' });
  assert.deepEqual(completeSet({ w: null, reps: 8, done: false }, null), { error: 'weight' });
  assert.equal(completeSet({ w: null, reps: 10, done: false }, null, true).set.w, 0, 'bodyweight: empty weight = 0');
  assert.deepEqual(moveItem([1, 2, 3], 0, 1), [2, 1, 3]); assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]); assert.deepEqual(moveItem([1, 2, 3], 2, -1), [1, 3, 2]);
});

test('train: template instantiation prefills weights from the last performance', () => {
  assert.equal(repsTarget(8), 8); assert.equal(repsTarget('8-10'), 8); assert.equal(repsTarget(''), null);
  const last = { date: '2026-09-22', sets: [set(135, 10, { kind: 'warmup' }), set(185, 8), set(190, 6)] };
  const e = entryFromPlan({ exerciseId: BENCH, sets: 3, reps: 8, rpe: 8 }, last, 'e1');
  assert.deepEqual(e, { id: 'e1', exerciseId: BENCH, target: { sets: 3, reps: 8, rpe: 8 }, sets: [
    { w: 185, reps: 8, rpe: null, kind: 'work', done: false }, { w: 190, reps: 8, rpe: null, kind: 'work', done: false }, { w: 190, reps: 8, rpe: null, kind: 'work', done: false }] });
  const fresh = entryFromPlan({ exerciseId: BENCH, sets: 2 }, null, 'e2');
  assert.deepEqual(fresh.sets, [{ w: null, reps: null, rpe: null, kind: 'work', done: false }, { w: null, reps: null, rpe: null, kind: 'work', done: false }]);
  assert.equal(fresh.target, undefined);
  let n = 0; const ids = () => 'id' + (++n);
  const tpl = { exercises: [{ exerciseId: BENCH, sets: 2, reps: 5 }, { exerciseId: '' }, { exerciseId: PULL, sets: 1, reps: 10 }] };
  const entries = entriesFromTemplate(tpl, (id) => (id === BENCH ? last : null), ids);
  assert.deepEqual(entries.map((x) => [x.id, x.exerciseId, x.sets.length, x.sets[0].w, x.sets[0].reps]), [['id1', BENCH, 2, 185, 5], ['id2', PULL, 1, null, 10]]);
});

test('train: repeat a session and derive a template from it', () => {
  let n = 0; const ids = () => 'r' + (++n);
  const src = sess('s', '2026-09-20', [{ id: 'a', exerciseId: BENCH, sets: [set(135, 10, { kind: 'warmup' }), set(185, 8, { rpe: 8 })] }, { id: 'b', exerciseId: PULL, sets: [set(0, 10)] }]);
  const out = entriesFromSession(src, (id) => (id === BENCH ? { sets: [set(190, 6)] } : null), ids);
  assert.deepEqual(out[0], { id: 'r1', exerciseId: BENCH, sets: [{ w: 190, reps: 6, rpe: null, kind: 'work', done: false }] });
  assert.deepEqual(out[1].sets, [{ w: 0, reps: 10, rpe: null, kind: 'work', done: false }]);
  assert.deepEqual(templateFromSession(sess('t', '2026-09-20', [{ id: 'a', exerciseId: BENCH, sets: [set(135, 10, { kind: 'warmup' }), set(185, 8), set(185, 8), set(185, 6)] }])),
    [{ exerciseId: BENCH, sets: 3, reps: 8, rpe: null }]);
});

test('train: WHOOP workout matching by overlap', () => {
  const w = (id, start, end) => ({ id, start, end, strain: 10 });
  const list = [w('a', '2026-09-22T16:00:00-04:00', '2026-09-22T16:40:00-04:00'), w('b', '2026-09-22T17:05:00-04:00', '2026-09-22T18:10:00-04:00'), w('c', '2026-09-22T21:10:00Z', '2026-09-22T21:50:00Z')];
  assert.equal(matchWorkout(list, '2026-09-22T17:00:00-04:00', '2026-09-22T18:05:00-04:00').id, 'b');
  assert.equal(matchWorkout(list, '2026-09-22T17:00:00-04:00', '2026-09-22T18:05:00-04:00', new Set(['b'])).id, 'c', 'UTC instants compare correctly');
  assert.equal(matchWorkout(list, '2026-09-22T19:00:00-04:00', '2026-09-22T20:00:00-04:00'), null);
  assert.equal(matchWorkout(list, '2026-09-22T16:38:00-04:00', '2026-09-22T17:02:00-04:00'), null, 'tiny overlaps are ignored');
  assert.equal(matchWorkout(list, '2026-09-22T17:00:00-04:00', null), null);
});

test('train: exercise ranking, filtering and last cardio exercise', () => {
  const ss = [
    sess('1', '2026-09-01', [{ exerciseId: BENCH, sets: [] }], { cardio: [{ exerciseId: BIKE }] }),
    sess('2', '2026-09-03', [{ exerciseId: PULL, sets: [] }, { exerciseId: BENCH, sets: [] }]),
    sess('3', '2026-09-05', [{ exerciseId: PULL, sets: [] }], { cardio: [{ exerciseId: 'ex-rower' }] }),
  ];
  assert.deepEqual(rankExercises(ss).map((x) => [x.id, x.count, x.last]), [[PULL, 2, '2026-09-05'], [BENCH, 2, '2026-09-03'], ['ex-rower', 1, '2026-09-05'], [BIKE, 1, '2026-09-01']]);
  assert.deepEqual(rankExercises(ss, '2026-09-04').map((x) => x.id), [PULL, 'ex-rower']);
  const lib = [{ id: 'a', name: 'Bench Press', muscle: 'chest', secondary: ['triceps'], equipment: 'barbell', type: 'strength' }, { id: 'b', name: 'Cable Curl', muscle: 'biceps', secondary: [], equipment: 'cable' }, { id: 'c', name: 'Rower', muscle: 'full', type: 'cardio', equipment: 'cardio' }];
  assert.deepEqual(filterExercises(lib, { query: 'press' }).map((x) => x.id), ['a']);
  assert.deepEqual(filterExercises(lib, { query: 'cable CURL' }).map((x) => x.id), ['b']);
  assert.deepEqual(filterExercises(lib, { muscle: 'triceps' }).map((x) => x.id), ['a'], 'secondary muscles match');
  assert.deepEqual(filterExercises(lib, { type: 'strength' }).map((x) => x.id), ['a', 'b'], 'missing type = strength');
  assert.equal(lastCardioExercise(ss), 'ex-rower'); assert.equal(lastCardioExercise([]), null);
});

test('train: exercise records (heaviest, best e1RM, most reps, rep-max table)', () => {
  const ss = [
    sess('1', '2026-09-01', [{ exerciseId: BENCH, sets: [set(185, 8), set(205, 3), set(225, 1, { kind: 'warmup' })] }]),
    sess('2', '2026-09-04', [{ exerciseId: BENCH, sets: [set(195, 6), set(135, 15), set(205, 3)] }]),
  ];
  const r = exerciseRecords(ss, BENCH);
  assert.deepEqual([r.heaviest.w, r.heaviest.reps, r.heaviest.date], [205, 3, '2026-09-01']);
  assert.deepEqual([r.bestE1rm.w, r.bestE1rm.reps, r.bestE1rm.e1rm], [185, 8, 234.3]);
  assert.deepEqual([r.mostReps.w, r.mostReps.reps], [135, 15]);
  assert.deepEqual(r.repMax.map((x) => [x.reps, x.w]), [[3, 205], [6, 195], [8, 185]]);
  assert.deepEqual(exerciseRecords([], BENCH), { heaviest: null, bestE1rm: null, mostReps: null, repMax: [] });
});

test('train: rest timer view', () => {
  assert.equal(restView(null, 0), null);
  assert.deepEqual(restView({ endsAt: 120000, durationMs: 120000 }, 30000), { remainingMs: 90000, done: false, fraction: 0.25 });
  assert.deepEqual(restView({ endsAt: 120000, durationMs: 120000 }, 130000), { remainingMs: 0, done: true, fraction: 1 });
});
