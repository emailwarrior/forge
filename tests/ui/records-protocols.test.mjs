import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleText, daysText, amountText, unitLabel, convertAmount, weekTotal, nextSite, lastSite, siteHistory, SITES,
  stackNames, stackTitle, todayGroups, defaultDoseTime, defaultNeutralLabel, emptyItem, draftFromItem, validateItem, itemPayload,
  lastTakenDose, normTimes,
} from '../../js/ui/parts/records-protocols.js';

test('records/protocols: schedule text covers every schedule type', () => {
  assert.equal(scheduleText({ type: 'daily', stack: 'AM' }), 'Daily · AM');
  assert.equal(scheduleText({ type: 'days', days: [3, 0], times: ['07:00'] }), 'Mon & Thu · 7:00 AM');
  assert.equal(scheduleText({ type: 'days', days: [0, 2, 4] }), 'Mon, Wed & Fri');
  assert.equal(scheduleText({ type: 'days', days: [] }), 'No days set');
  assert.equal(scheduleText({ type: 'weekly', days: [6] }), 'Weekly · Sun');
  assert.equal(scheduleText({ type: 'weekly' }), 'Once a week');
  assert.equal(scheduleText({ type: 'asneeded', stack: 'AM', times: ['08:00'] }), 'As needed');
  assert.equal(scheduleText(undefined), 'Daily');
  assert.equal(scheduleText({ type: 'daily', stack: 'PM', times: ['21:30', '09:00', 'bad'] }), 'Daily · PM · 9:00 AM, 9:30 PM');
  assert.equal(daysText([0, 1, 2, 3, 4]), 'Weekdays');
  assert.equal(daysText([5, 6]), 'Weekends');
  assert.equal(daysText([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(daysText([9, -1]), '');
  assert.deepEqual(normTimes(['7:00', '07:00', '25:00', '06:30', '06:30']), ['06:30', '07:00']);
});

test('records/protocols: amounts pluralize count units and format quantities', () => {
  assert.equal(amountText(5000, 'IU'), '5,000 IU');
  assert.equal(amountText(2, 'capsule'), '2 capsules');
  assert.equal(amountText(1, 'capsule'), '1 capsule');
  assert.equal(amountText(1, 'units'), '1 unit');
  assert.equal(amountText(0.25, 'mg'), '0.25 mg');
  assert.equal(amountText(null, 'mg'), '');
  assert.equal(unitLabel('Scoop', 3), 'scoops');
});

test('records/protocols: unit conversion only between mass units', () => {
  assert.equal(convertAmount(500, 'mcg', 'mg'), 0.5);
  assert.equal(convertAmount(0.5, 'mg', 'mcg'), 500);
  assert.equal(convertAmount(1.5, 'g', 'mg'), 1500);
  assert.equal(convertAmount(2, 'MG', 'mg'), 2);
  assert.equal(convertAmount(2, 'ml', 'mg'), null);
  assert.equal(convertAmount(null, 'mg', 'mg'), null);
  assert.equal(convertAmount(10, 'unit', 'units'), 10);
});

test('records/protocols: weekly total sums the Mon–Sun week, skips skipped/deleted/excluded, converts units', () => {
  const doses = [
    { id: 'a', itemId: 'p', date: '2026-09-21', amount: 1, unit: 'mg' }, // Mon
    { id: 'b', itemId: 'p', date: '2026-09-24', amount: 500, unit: 'mcg' }, // Thu
    { id: 'c', itemId: 'p', date: '2026-09-25', amount: 1, unit: 'mg', skipped: true },
    { id: 'd', itemId: 'p', date: '2026-09-20', amount: 1, unit: 'mg' }, // previous Sunday
    { id: 'e', itemId: 'q', date: '2026-09-22', amount: 1, unit: 'mg' },
    { id: 'f', itemId: 'p', date: '2026-09-26', amount: 2, unit: 'ml' }, // unconvertible
    { id: 'g', itemId: 'p', date: '2026-09-27', amount: null }, // uses the fallback amount/unit
    { id: 'h', itemId: 'p', date: '2026-09-23', amount: 1, unit: 'mg', _d: 1 },
  ];
  const w = weekTotal(doses, { itemId: 'p', date: '2026-09-26', unit: 'mg', fallbackUnit: 'mg', fallbackAmount: 0.5 });
  assert.deepEqual(w, { from: '2026-09-21', to: '2026-09-27', total: 2, count: 3, unconverted: 1 });
  const ex = weekTotal(doses, { itemId: 'p', date: '2026-09-26', unit: 'mg', fallbackUnit: 'mg', fallbackAmount: 0.5, excludeId: 'a' });
  assert.equal(ex.total, 1);
});

test('records/protocols: injection site rotation follows the last used site', () => {
  assert.equal(nextSite(null), 'Abdomen L');
  assert.equal(nextSite('Abdomen L'), 'Abdomen R');
  assert.equal(nextSite('arm r'), 'Abdomen L', 'wraps around, case-insensitive');
  assert.equal(nextSite('Left delt'), 'Abdomen L', 'unknown site restarts the rotation');
  const doses = [
    { itemId: 'p', date: '2026-09-14', at: '2026-09-14T07:00:00-04:00', site: 'Thigh L' },
    { itemId: 'p', date: '2026-09-21', at: '2026-09-21T07:00:00-04:00', site: 'Thigh R' },
    { itemId: 'p', date: '2026-09-24', at: '2026-09-24T07:00:00-04:00', site: 'Glute L', skipped: true },
    { itemId: 'p', date: '2026-09-17', at: '2026-09-17T07:00:00-04:00', site: 'Abdomen R' },
  ];
  assert.equal(lastSite(doses), 'Thigh R');
  assert.equal(nextSite(lastSite(doses)), 'Glute L');
  const hist = siteHistory([...doses, { date: '2026-09-25', site: 'Left delt' }], { since: '2026-09-15' });
  assert.equal(hist.length, SITES.length + 1);
  assert.deepEqual(hist.find((h) => h.site === 'Thigh R'), { site: 'Thigh R', count: 1, last: '2026-09-21' });
  assert.equal(hist.find((h) => h.site === 'Thigh L').count, 0, 'before `since`');
  assert.equal(hist[hist.length - 1].site, 'Left delt');
  assert.equal(lastTakenDose(doses).date, '2026-09-21');
});

test('records/protocols: stacks and today groups', () => {
  const items = [
    { id: 'a', name: 'B', schedule: { stack: 'PM' } }, { id: 'b', name: 'A', schedule: { stack: 'am' } },
    { id: 'c', name: 'C', schedule: { stack: 'Pre-workout' } }, { id: 'd', name: 'D', schedule: {} },
    { id: 'e', name: 'E', schedule: { stack: 'Zzz' }, active: false }, { id: 'f', name: 'F', schedule: { stack: 'AM', times: ['06:00'] } },
  ];
  assert.deepEqual(stackNames(items), ['am', 'PM', 'Pre-workout']);
  assert.equal(stackTitle('AM'), 'AM stack');
  assert.equal(stackTitle('Morning stack'), 'Morning stack');
  assert.equal(stackTitle(null), 'Other scheduled');
  const due = [
    { item: items[1], due: true, taken: true, doses: [] }, { item: items[5], due: true, taken: false, doses: [] },
    { item: items[0], due: true, taken: false, doses: [] }, { item: items[3], due: false, taken: true, doses: [] },
    { item: items[2], due: false, taken: false, doses: [] },
  ];
  const g = todayGroups(due);
  assert.deepEqual(g.map((x) => x.stack), ['am', 'PM', null]);
  assert.deepEqual(g[0].rows.map((r) => r.item.id), ['f', 'b'], 'earliest scheduled time first');
  assert.equal(g[0].total, 2); assert.equal(g[0].taken, 1);
  assert.equal(g[2].total, 0, 'as-needed taken today shows but is not "due"');
});

test('records/protocols: default dose time', () => {
  assert.equal(defaultDoseTime({ date: '2026-09-26', today: '2026-09-26', nowHm: '09:41' }), '09:41');
  assert.equal(defaultDoseTime({ date: '2026-09-25', today: '2026-09-26', nowHm: '09:41', items: [{ schedule: { times: ['21:30', '07:15'] } }] }), '07:15');
  assert.equal(defaultDoseTime({ date: '2026-09-25', today: '2026-09-26', nowHm: '09:41', stack: 'pm' }), '21:00');
});

test('records/protocols: editor draft, validation and payload', () => {
  assert.equal(defaultNeutralLabel('peptide'), 'Protocol');
  assert.equal(defaultNeutralLabel('medication'), 'Protocol');
  assert.equal(defaultNeutralLabel('supplement'), '');
  const d = emptyItem({ kind: 'peptide', today: '2026-09-26' });
  assert.equal(d.neutralLabel, 'Protocol'); assert.equal(d.form, 'injection'); assert.equal(d.startedAt, '2026-09-26');
  assert.deepEqual(Object.keys(validateItem(d)), ['name']);
  const bad = { ...d, name: 'X', amount: -1, schedule: { type: 'days', days: [] }, weeklyTarget: { amount: null, unit: 'mg' }, endedAt: '2026-09-01' };
  assert.deepEqual(Object.keys(validateItem(bad)).sort(), ['amount', 'days', 'endedAt', 'weeklyTarget']);
  const ok = { ...d, name: '  Peptide X ', amount: 1, unit: 'mg', schedule: { type: 'days', days: [3, 0, 3], times: ['07:00', 'x'], stack: ' AM ' }, weeklyTarget: { amount: 2, unit: '' } };
  const p = itemPayload(ok);
  assert.equal(p.name, 'Peptide X');
  assert.deepEqual(p.schedule, { type: 'days', days: [0, 3], times: ['07:00'], stack: 'AM' });
  assert.deepEqual(p.weeklyTarget, { amount: 2, unit: 'mg' });
  assert.equal(p.neutralLabel, 'Protocol'); assert.equal(p.note, null); assert.equal(p.active, true);
  const daily = itemPayload({ ...ok, schedule: { type: 'daily', days: [1], times: [], stack: '' }, weeklyTarget: null });
  assert.deepEqual(daily.schedule, { type: 'daily', days: [], times: [], stack: null });
  assert.equal(daily.weeklyTarget, null);
  const prn = itemPayload({ ...ok, schedule: { type: 'asneeded', days: [1], times: ['08:00'], stack: 'AM' } });
  assert.deepEqual(prn.schedule, { type: 'asneeded', days: [], times: [], stack: null });
  const stored = { id: 'x', name: 'Y', kind: 'supplement', amount: 5, unit: 'g', schedule: { type: 'daily', stack: 'AM' }, active: true };
  const back = draftFromItem(stored);
  assert.deepEqual(back.schedule, { type: 'daily', days: [], times: [], stack: 'AM' });
  back.schedule.days.push(1);
  assert.equal(stored.schedule.days, undefined, 'draft never mutates the record');
});
