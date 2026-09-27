import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import {
  blockSpan, blocksOverlap, blockMinutes, blockTimeError, addMinutes, nextSlot, slotAt, planFields, templateBlocks,
  mergeDraft, weekCopyPlan, layoutColumns, scheduleRange, buildTimeline, nowIndex, weekRows, dayTiming, changedFields,
  fmtSpan, targetText, fmtDelta, fmtAgo, fmtMinutes, fmtSigned, fmtAmount, mealTitle, sessionSummary,
} from '../../js/ui/parts/day-model.js';

const TZ = 'America/New_York';
const iso = (date, hm) => `${date}T${hm}:00-04:00`;

function fixture(data, { today = '2026-09-23', tz = TZ } = {}) {
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

test('day-model: block spans, overlap, validation and slots', () => {
  assert.deepEqual(blockSpan({ start: '09:00', end: '10:30' }), { start: 540, end: 630 });
  assert.deepEqual(blockSpan({ start: '23:00', end: '00:00' }), { start: 1380, end: 1440 });
  assert.equal(blockSpan({ start: '9', end: '10:00' }), null);
  assert.equal(blockMinutes({ start: '22:30', end: '01:00' }), 150);
  assert.equal(blocksOverlap({ start: '09:00', end: '10:00' }, { start: '10:00', end: '11:00' }), false);
  assert.equal(blocksOverlap({ start: '09:00', end: '10:01' }, { start: '10:00', end: '11:00' }), true);
  assert.equal(blockTimeError('09:00', '10:00'), null);
  assert.equal(blockTimeError('09:00', '09:00'), 'End must be after start.');
  assert.equal(blockTimeError('09:00', '08:00'), 'End must be after start.');
  assert.equal(blockTimeError('23:00', '00:00'), null, 'midnight end is allowed');
  assert.equal(blockTimeError('', '10:00'), 'Set a start time.');
  assert.equal(blockTimeError('09:00', null), 'Set an end time.');
  assert.equal(addMinutes('23:30', 30), '00:00');
  assert.equal(addMinutes('09:15', 45), '10:00');
  assert.deepEqual(nextSlot(14 * 60 + 5), { start: '14:30', end: '15:30' });
  assert.deepEqual(nextSlot(14 * 60), { start: '14:30', end: '15:30' }, 'an exact boundary moves to the next slot');
  assert.deepEqual(nextSlot(23 * 60 + 50), { start: '23:30', end: '00:00' });
  assert.deepEqual(slotAt(9 * 60 + 47), { start: '09:30', end: '10:30' });
  assert.deepEqual(slotAt(1435, { from: 300, to: 1440 }), { start: '23:30', end: '00:00' });
  assert.deepEqual(slotAt(100, { from: 300, to: 1440 }), { start: '05:00', end: '06:00' });
});

test('day-model: drafts skip overlaps with existing and earlier accepted blocks', () => {
  const existing = [{ start: '09:00', end: '10:00' }, { start: '13:00', end: '14:00' }];
  const draft = [
    { start: '07:30', end: '09:00', title: 'A' }, // touches, fits
    { start: '09:30', end: '11:00', title: 'B' }, // overlaps existing
    { start: '11:00', end: '12:00', title: 'C' }, // fits
    { start: '11:30', end: '12:30', title: 'D' }, // overlaps C (accepted earlier)
    { start: 'x', end: '12:30', title: 'E' },     // invalid
  ];
  const { add, skipped } = mergeDraft(existing, draft);
  assert.deepEqual(add.map((b) => b.title), ['A', 'C']);
  assert.deepEqual(skipped.map((b) => b.title), ['B', 'D', 'E']);
  assert.deepEqual(mergeDraft([], []), { add: [], skipped: [] });
});

test('day-model: plan fields, templates and week copy', () => {
  assert.deepEqual(planFields('2026-09-28', { start: '07:30', end: '09:00', title: ' Deep ', category: 'deep', reminder: 1, status: 'done', actualMin: 80 }),
    { date: '2026-09-28', start: '07:30', end: '09:00', title: 'Deep', category: 'deep', status: 'planned', calendar: true, reminder: true });
  assert.equal(planFields('2026-09-28', { start: '07:30', end: '09:00', calendar: false }).calendar, false);
  assert.equal(planFields('2026-09-28', { start: '07:30', end: '09:00' }, { templateId: 't1' }).templateId, 't1');
  assert.deepEqual(templateBlocks([
    { start: '13:00', end: '14:00', title: 'Lunch', category: 'meal', status: 'done', note: 'x' },
    { start: '07:00', end: '08:00', title: 'Gym', category: 'training', reminder: true },
    { start: 'bad', end: '08:00' },
  ]), [
    { start: '07:00', end: '08:00', title: 'Gym', category: 'training', reminder: true },
    { start: '13:00', end: '14:00', title: 'Lunch', category: 'meal', reminder: false },
  ]);
  const plan = {
    '2026-09-14': [{ start: '08:00', end: '09:00', title: 'Deep', category: 'deep', status: 'done' }],
    '2026-09-15': [{ start: '08:00', end: '09:00', title: 'Deep', category: 'deep' }, { start: '17:00', end: '18:00', title: 'Gym', category: 'training' }],
    '2026-09-16': [{ start: '08:00', end: '09:00', title: 'Deep', category: 'deep' }],
    '2026-09-22': [{ start: '10:00', end: '11:00', title: 'Already', category: 'admin' }],
  };
  const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
  const r = weekCopyPlan(week, (d) => plan[d] || []);
  assert.deepEqual(r.copiedDays, ['2026-09-21', '2026-09-23']);
  assert.deepEqual(r.skippedDays, ['2026-09-22']);
  assert.equal(r.emptySource.length, 4);
  assert.equal(r.add.length, 2);
  assert.deepEqual(r.add[0], { date: '2026-09-21', start: '08:00', end: '09:00', title: 'Deep', category: 'deep', status: 'planned', calendar: true, reminder: false });
  assert.deepEqual(r.pastDays, []);
  const mid = weekCopyPlan(week, (d) => plan[d] || [], { from: '2026-09-23' });
  assert.deepEqual(mid.pastDays, ['2026-09-21', '2026-09-22']);
  assert.deepEqual(mid.copiedDays, ['2026-09-23']);
  assert.equal(mid.add.length, 1);
});

test('day-model: schedule columns for overlapping items', () => {
  const cols = (items) => layoutColumns(items).map((x) => [x.id, x.col, x.cols]);
  assert.deepEqual(cols([{ id: 'a', start: 60, end: 120 }, { id: 'b', start: 120, end: 180 }]), [['a', 0, 1], ['b', 0, 1]]);
  assert.deepEqual(cols([{ id: 'a', start: 60, end: 180 }, { id: 'b', start: 90, end: 120 }]), [['a', 0, 2], ['b', 1, 2]]);
  // chain: a–b overlap, b–c overlap, a and c do not → one cluster, c reuses column 0
  assert.deepEqual(cols([{ id: 'c', start: 150, end: 200 }, { id: 'a', start: 60, end: 120 }, { id: 'b', start: 100, end: 160 }]),
    [['a', 0, 2], ['b', 1, 2], ['c', 0, 2]]);
  // three-way overlap then a separate item
  assert.deepEqual(cols([{ id: 'a', start: 0, end: 100 }, { id: 'b', start: 10, end: 50 }, { id: 'c', start: 20, end: 60 }, { id: 'd', start: 200, end: 260 }]),
    [['a', 0, 3], ['b', 1, 3], ['c', 2, 3], ['d', 0, 1]]);
  assert.deepEqual(layoutColumns([{ id: 'z', start: 10, end: 10 }, { id: 'n', start: null, end: 5 }]), []);
  assert.deepEqual(scheduleRange([{ start: 270, end: 330 }]), { from: 240, to: 1440 });
  assert.deepEqual(scheduleRange([{ start: 600, end: 1500 }]), { from: 300, to: 1500 });
  assert.deepEqual(scheduleRange([]), { from: 300, to: 1440 });
});

test('day-model: timeline merges and orders a day', () => {
  const D = '2026-09-23';
  const entries = buildTimeline({
    date: D, tz: TZ,
    sleep: { id: 's1', start: iso('2026-09-22', '23:38'), end: iso(D, '07:02'), tz: '-04:00', bedtime: '23:38', wake: '07:02', asleepMin: 410 },
    nextSleep: { id: 's2', start: iso('2026-09-24', '00:20'), end: iso('2026-09-24', '07:00'), tz: '-04:00', bedtime: '00:20', wake: '07:00' },
    naps: [{ id: 'n1', start: iso(D, '14:00'), end: iso(D, '14:25'), tz: '-04:00', nap: true }],
    plan: [{ id: 'p2', start: '13:00', end: '15:00', title: 'Deep 2' }, { id: 'p1', start: '07:30', end: '09:30', title: 'Deep' }],
    events: [
      { id: 'e1', start: iso(D, '10:00'), end: iso(D, '10:30'), title: 'Sync', status: 'confirmed' },
      { id: 'e2', start: D, end: '2026-09-24', allDay: true, title: 'Holiday' },
      { id: 'e3', start: iso(D, '16:00'), end: iso(D, '16:30'), title: 'Declined', status: 'declined' },
    ],
    meals: [{ id: 'm2', at: iso(D, '12:30') }, { id: 'm1', at: iso(D, '07:45') }, { id: 'm3' }],
    sessions: [{ id: 'x1', startAt: iso(D, '17:10'), endAt: iso(D, '18:19'), whoopWorkoutId: 'w1' }],
    workouts: [{ id: 'w1', start: iso(D, '17:10'), end: iso(D, '18:19'), tz: '-04:00' }, { id: 'w2', start: iso(D, '06:00'), end: iso(D, '06:40'), tz: '-04:00', sport: 'Running' }],
    doses: [{ id: 'd1', at: iso(D, '07:15'), itemId: 'a' }, { id: 'd2', at: iso(D, '07:15'), itemId: 'b' }, { id: 'd3', at: iso(D, '21:45'), itemId: 'c' }],
    body: [{ id: 'b1', at: iso(D, '07:20'), weightLb: 176 }],
    journal: [{ id: 'j1', at: iso(D, '22:05'), text: 'x' }],
  });
  assert.deepEqual(entries.map((e) => e.key), [
    'event:e2', 'workout:w2', 'sleep:s1', 'doses:435', 'weigh:b1', 'block:p1', 'meal:m1', 'event:e1', 'meal:m2', 'block:p2',
    'nap:n1', 'event:e3', 'session:x1', 'doses:1305', 'journal:j1', 'bed:s2', 'meal:m3',
  ]);
  const sleep = entries.find((e) => e.kind === 'sleep');
  assert.equal(sleep.min, 422); assert.equal(sleep.startMin, -22);
  assert.equal(entries.find((e) => e.kind === 'bed').min, 1460);
  const sess = entries.find((e) => e.kind === 'session');
  assert.equal(sess.workout.id, 'w1'); assert.equal(sess.endMin, 1099);
  assert.equal(entries.filter((e) => e.kind === 'workout').length, 1, 'a linked WHOOP workout is folded into its session');
  assert.deepEqual(entries.find((e) => e.key === 'doses:435').doses.map((d) => d.id), ['d1', 'd2']);
  assert.equal(entries.find((e) => e.key === 'event:e3').declined, true);
  assert.equal(entries.find((e) => e.key === 'event:e2').allDay, true);
  assert.equal(nowIndex(entries, 600), 8, 'marker goes before the 12:30 meal');
  assert.equal(nowIndex(entries, 2000), entries.length - 1, 'untimed entries stay after the marker');
  assert.equal(nowIndex([], 10), 0);
  // sleep without local strings falls back to the instants
  const t2 = buildTimeline({ date: D, tz: TZ, sleep: { id: 's', start: iso('2026-09-22', '22:50'), end: iso(D, '06:10'), tz: '-04:00' } });
  assert.equal(t2[0].min, 370); assert.equal(t2[0].startMin, -70);
});

test('day-model: meal titles and session summary', () => {
  assert.equal(mealTitle({ title: ' Steak bowl ' }), 'Steak bowl');
  assert.equal(mealTitle({ items: [{ name: 'Eggs' }, { name: 'Toast' }, { name: 'Coffee' }] }), 'Eggs, Toast +1');
  assert.equal(mealTitle({ slot: 'dinner', items: [] }), 'Dinner');
  assert.equal(mealTitle({}), 'Meal');
  const s = sessionSummary({
    startAt: iso('2026-09-23', '17:00'), endAt: iso('2026-09-23', '18:05'),
    entries: [
      { exerciseId: 'bench', sets: [{ w: 185, reps: 5, kind: 'work' }, { w: 135, reps: 8, kind: 'warmup' }, { w: 185, reps: 5 }, { w: 185, reps: 4, done: false }] },
      { exerciseId: 'pullup', sets: [{ w: 0, reps: 10 }] },
      { exerciseId: 'empty', sets: [] },
    ],
    cardio: [{ durationMin: 20 }, { durationMin: 5 }],
  }, '2026-09-23', TZ);
  assert.deepEqual(s, { sets: 3, volume: 1850, exercises: 2, open: false, startMin: 1020, endMin: 1085, durationMin: 65, cardio: 2, cardioMin: 25 });
  assert.equal(sessionSummary({ startAt: iso('2026-09-23', '17:00'), entries: [] }, '2026-09-23', TZ).open, true);
});

test('day-model: week rows aggregate plan and meetings', () => {
  const dv = fixture({
    plan: [
      { date: '2026-09-21', start: '08:00', end: '10:00', title: 'Deep', category: 'deep', status: 'done' },
      { date: '2026-09-21', start: '10:00', end: '11:00', title: 'Admin', category: 'admin', status: 'partial' },
      { date: '2026-09-23', start: '08:00', end: '09:00', title: 'Deep', category: 'deep', status: 'skipped' },
      { date: '2026-09-25', start: '08:00', end: '09:00', title: 'Deep', category: 'deep', status: 'planned' },
    ],
    calendarEvents: [
      { date: '2026-09-21', start: iso('2026-09-21', '12:00'), end: iso('2026-09-21', '13:00'), title: 'Call', status: 'confirmed', isForge: false },
      { date: '2026-09-22', start: iso('2026-09-22', '12:00'), end: iso('2026-09-22', '12:30'), title: 'Call', status: 'confirmed', isForge: false },
    ],
  });
  const w = weekRows(dv, '2026-09-21');
  assert.equal(w.to, '2026-09-27');
  assert.equal(w.rows.length, 7);
  assert.deepEqual(w.rows.map((r) => r.plannedMin), [180, null, 60, null, 60, null, null]);
  assert.deepEqual(w.rows.map((r) => r.doneMin), [150, null, 0, null, null, null, null]);
  assert.deepEqual(w.rows.map((r) => r.meetingMin), [60, 30, 0, 0, 0, 0, 0]);
  assert.equal(w.rows[4].past, false);
  assert.deepEqual(w.totals, { plannedMin: 300, doneMin: 150, adherence: 62.5, meetingMin: 90, meetingCount: 2, days: 3, judgedDays: 2 });
  const empty = weekRows(fixture({}), '2026-09-21');
  assert.deepEqual(empty.totals, { plannedMin: 0, doneMin: null, adherence: null, meetingMin: null, meetingCount: null, days: 0, judgedDays: 0 });
});

test('day-model: day timing vs targets', () => {
  const t = { wake: '06:30', caffeineCutoff: '12:00', lastMealBy: '20:00', bedtime: '22:30' };
  const rows = dayTiming({ wakeMin: 469, caffeineMin: 708, lastMealMin: 1281, bedMin: 1470 }, t);
  assert.deepEqual(rows.map((r) => [r.key, r.actual, r.target, r.delta, r.hit]), [
    ['wake', 469, 390, 79, false], ['caffeine', 708, 720, -12, true], ['lastMeal', 1281, 1200, 81, false], ['bedtime', 1470, 1350, 120, false],
  ]);
  const late = dayTiming({ caffeineMin: 30 }, { caffeineCutoff: '12:00', bedtime: '00:30' });
  assert.equal(late[1].actual, 1470); assert.equal(late[1].hit, false);
  assert.equal(late[3].target, 1470);
  assert.deepEqual(dayTiming({}, {}).map((r) => r.hit), [null, null, null, null]);
});

test('day-model: changed fields only', () => {
  const orig = { energy: 3, mood: 4, wins: 'Shipped', note: null, caffeineLastAt: '11:00' };
  const draft = { energy: 3, mood: 5, wins: ' Shipped ', note: '', caffeineLastAt: '', alcohol: 0 };
  assert.deepEqual(changedFields(orig, draft, ['energy', 'mood', 'wins', 'note', 'caffeineLastAt', 'alcohol', 'stress']),
    { mood: 5, caffeineLastAt: null, alcohol: 0 });
  assert.deepEqual(changedFields(null, { energy: 2, note: '  ' }, ['energy', 'note']), { energy: 2 });
  assert.deepEqual(changedFields({ tags: ['a'] }, { tags: ['a'] }, ['tags']), {});
});

test('day: a manual check cleared and set again is live and overrides auto (writes pass _d: null)', async () => {
  const { dayExecution } = await import('../../js/analytics/execution.js');
  const { seedStandards } = await import('../../js/core/schema.js');
  const store = createStore({ owner: 'app' });
  for (const s of seedStandards()) store.create('standards', s);
  const dv = makeDataView(store, { today: '2026-09-23', tz: TZ });
  const id = '2026-09-23:std-read';
  const write = (value) => store.upsert('checks', id, { date: '2026-09-23', standardId: 'std-read', value, source: 'manual', _d: null });
  const read = () => dayExecution(dv, '2026-09-23').items.find((i) => i.standard.id === 'std-read');
  write(40);
  assert.equal(read().value, 40);
  store.remove('checks', id);                 // "clear" (back to unlogged)
  assert.equal(read().status, 'pending');
  write(55);                                  // set again after the clear
  assert.equal(read().value, 55); assert.equal(read().source, 'manual'); assert.equal(read().done, true);
  store.remove('checks', id); store.restore('checks', id); // Undo of a clear
  assert.equal(read().value, 55);
});

test('day-model: formatters', () => {
  assert.equal(fmtSpan(570, 600), '9:30–10:00 AM');
  assert.equal(fmtSpan(690, 780), '11:30 AM–1:00 PM');
  assert.equal(fmtSpan(1380, 1440), '11:00 PM–12:00 AM');
  assert.equal(fmtSpan(null, 10), '—');
  assert.equal(fmtSpan(420, null), '7:00 AM');
  assert.equal(targetText({ op: '>=', value: 30, unit: 'min' }, 'duration'), '≥ 30 min');
  assert.equal(targetText({ op: '<=', value: '06:30' }, 'time'), '≤ 6:30 AM');
  assert.equal(targetText({ op: '>=', value: 90, unit: '%' }, 'number'), '≥ 90%');
  assert.equal(targetText({ op: '>=', value: 3, unit: null }, 'number'), '≥ 3');
  assert.equal(targetText({ op: '>=', value: 3.5, unit: 'h' }, 'number'), '≥ 3.5 h');
  assert.equal(targetText({ op: '>=', value: 3330, unit: 'kcal' }, 'number'), '≥ 3,330 kcal');
  assert.equal(targetText({ op: '>=', value: null, unit: 'g' }, 'number'), 'target not set');
  assert.equal(targetText(null, 'check'), '');
  assert.equal(fmtAmount(5000), '5,000'); assert.equal(fmtAmount(0.25), '0.25'); assert.equal(fmtAmount(2.5), '2.5'); assert.equal(fmtAmount(0.12345), '0.123'); assert.equal(fmtAmount(null), '');
  assert.equal(fmtSigned(1.04, 1), '+1.0'); assert.equal(fmtSigned(-2.2, 1), '−2.2'); assert.equal(fmtSigned(-0.04, 1), '0.0'); assert.equal(fmtSigned(1234), '+1,234'); assert.equal(fmtSigned(null), '—');
  assert.equal(fmtDelta(79), '+1h 19m'); assert.equal(fmtDelta(-12), '−12m'); assert.equal(fmtDelta(0), 'on time'); assert.equal(fmtDelta(null), '—');
  const now = Date.parse('2026-09-26T12:00:00Z');
  assert.equal(fmtAgo('2026-09-26T11:48:00Z', now), '12 min ago');
  assert.equal(fmtAgo('2026-09-26T09:00:00Z', now), '3 h ago');
  assert.equal(fmtAgo('2026-09-23T12:00:00Z', now), '3 d ago');
  assert.equal(fmtAgo('2026-09-26T11:59:40Z', now), 'just now');
  assert.equal(fmtAgo('nope', now), '—');
  assert.equal(fmtMinutes(405), '6h 45m'); assert.equal(fmtMinutes(60), '1h 00m'); assert.equal(fmtMinutes(30), '30m'); assert.equal(fmtMinutes(null), '—');
});
