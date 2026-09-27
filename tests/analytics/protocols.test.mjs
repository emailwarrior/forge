import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { dateRange, dayOfWeek } from '../../js/core/util.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { isDue, dueItems, stackStatus, adherence, nextDue, doseCycle, daysSinceDose } from '../../js/analytics/protocols.js';

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
const TODAY = '2026-09-23'; // Wednesday
const ITEMS = [
  { id: 'daily', name: 'Daily', kind: 'supplement', schedule: { type: 'daily', stack: 'AM' }, active: true, startedAt: '2026-09-10' },
  { id: 'monthu', name: 'MonThu', kind: 'supplement', schedule: { type: 'days', days: [0, 3], stack: 'AM' }, active: true },
  { id: 'sunday', name: 'Sunday', kind: 'medication', schedule: { type: 'weekly', days: [6] }, active: true },
  { id: 'weekly', name: 'Weekly', kind: 'peptide', unit: 'mg', amount: 2, schedule: { type: 'weekly' }, weeklyTarget: { amount: 2, unit: 'mg' }, active: true },
  { id: 'prn', name: 'PRN', kind: 'medication', schedule: { type: 'asneeded' }, active: true },
  { id: 'stopped', name: 'Stopped', kind: 'supplement', schedule: { type: 'daily' }, active: false, startedAt: '2026-09-01', endedAt: '2026-09-15' },
  { id: 'paused', name: 'Paused', kind: 'supplement', schedule: { type: 'daily' }, active: false },
];
const byId = (id) => ITEMS.find((i) => i.id === id);
function protoFixture(doses = []) { return fixture({ protocolItems: ITEMS, doses }); }

test('protocols: due logic for daily, days, weekly(days), weekly(once), asneeded and date windows', () => {
  const dv = protoFixture([{ itemId: 'weekly', date: '2026-09-16', amount: 2, unit: 'mg' }]);
  assert.equal(isDue(dv, byId('daily'), '2026-09-09'), false, 'before startedAt');
  assert.equal(isDue(dv, byId('daily'), '2026-09-10'), true);
  const monThu = dateRange('2026-09-14', '2026-09-20').filter((d) => isDue(dv, byId('monthu'), d));
  assert.deepEqual(monThu.map(dayOfWeek), [0, 3]);
  const sun = dateRange('2026-09-14', '2026-09-20').filter((d) => isDue(dv, byId('sunday'), d));
  assert.deepEqual(sun, ['2026-09-20']);
  // Once a week: due until taken (Wed 09-16), including the day it is taken.
  const weekly = dateRange('2026-09-14', '2026-09-20').map((d) => isDue(dv, byId('weekly'), d));
  assert.deepEqual(weekly, [true, true, true, false, false, false, false]);
  assert.equal(isDue(dv, byId('weekly'), '2026-09-21'), true, 'new week');
  assert.equal(isDue(dv, byId('prn'), TODAY), false);
  assert.equal(isDue(dv, byId('stopped'), '2026-09-12'), true, 'inactive items still count inside their window');
  assert.equal(isDue(dv, byId('stopped'), '2026-09-16'), false);
  assert.equal(isDue(dv, byId('paused'), TODAY), false, 'inactive without an end date');
  const due = dueItems(dv, TODAY);
  assert.ok(due.every((x) => 'item' in x && 'due' in x && Array.isArray(x.doses)));
  assert.ok(!due.some((x) => x.item.id === 'paused'));
});

test('protocols: stack status ignores skipped doses and is null when nothing is due', () => {
  const dv = protoFixture([
    { itemId: 'daily', date: '2026-09-21' }, { itemId: 'monthu', date: '2026-09-21' },
    { itemId: 'daily', date: '2026-09-22' }, { itemId: 'monthu', date: '2026-09-24', skipped: true }, { itemId: 'daily', date: '2026-09-24' },
  ]);
  const mon = stackStatus(dv, '2026-09-21', 'AM');
  assert.equal(mon.items.length, 2); assert.equal(mon.complete, true);
  const tue = stackStatus(dv, '2026-09-22', 'am');
  assert.equal(tue.items.length, 1, 'MonThu not due Tuesday; stack names are case-insensitive'); assert.equal(tue.complete, true);
  assert.equal(stackStatus(dv, '2026-09-24', 'AM').complete, false, 'skipped dose');
  assert.deepEqual(stackStatus(dv, '2026-09-21', 'PM'), { stack: 'PM', items: [], complete: null });
});

test('protocols: adherence per item (future excluded, today only once taken, weeks for once-weekly)', () => {
  const doses = [];
  for (const d of dateRange('2026-09-14', '2026-09-22')) if (d !== '2026-09-17') doses.push({ itemId: 'daily', date: d });
  doses.push({ itemId: 'daily', date: '2026-09-18', skipped: true });
  doses.push({ itemId: 'weekly', date: '2026-09-16' });
  doses.push({ itemId: 'prn', date: '2026-09-15' }, { itemId: 'prn', date: '2026-09-19' });
  const dv = protoFixture(doses);
  const a = adherence(dv, '2026-09-14', '2026-09-30');
  const get = (id) => a.find((x) => x.item.id === id);
  // daily: 09-14..09-22 due (9 days) + today not yet taken → excluded; 09-17 missing.
  assert.deepEqual([get('daily').scheduled, get('daily').taken, get('daily').rate], [9, 8, 88.9]);
  // Mon/Thu: 09-14, 09-17, 09-21 due before today → 0 taken
  assert.deepEqual([get('monthu').scheduled, get('monthu').taken], [3, 0]);
  // once weekly: week of 09-14 complete & taken; current week open and not yet taken → not counted
  assert.deepEqual([get('weekly').scheduled, get('weekly').taken, get('weekly').rate], [1, 1, 100]);
  assert.deepEqual([get('prn').scheduled, get('prn').taken, get('prn').rate], [0, 2, null]);
  assert.equal(get('stopped').scheduled, 2, 'only 09-14 and 09-15 fall inside its window');
});

test('protocols: nextDue', () => {
  const dv = protoFixture([{ itemId: 'daily', date: TODAY }, { itemId: 'weekly', date: '2026-09-21' }]);
  assert.equal(nextDue(dv, 'daily', TODAY), '2026-09-24', 'taken today → tomorrow');
  assert.equal(nextDue(dv, byId('monthu'), TODAY), '2026-09-24', 'next Thursday');
  assert.equal(nextDue(dv, 'weekly', TODAY), '2026-09-28', 'taken this week → next Monday');
  assert.equal(nextDue(dv, 'prn', TODAY), null);
  assert.equal(nextDue(dv, 'stopped', TODAY), null);
  const dv2 = protoFixture([]);
  assert.equal(nextDue(dv2, 'daily', TODAY), TODAY);
});

test('protocols: doseCycle groups same-day metrics by days since the item\'s last dose', () => {
  const doses = [], recovery = [], days = [];
  const mondays = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
  for (const m of mondays) doses.push({ itemId: 'weekly', date: m, amount: 2, unit: 'mg' });
  doses.push({ itemId: 'daily', date: '2026-09-02' }); // other items do not reset the cycle
  for (const d of dateRange('2026-08-31', '2026-09-22')) {
    const k = (dayOfWeek(d) + 7) % 7; // Monday dose → daysSince = weekday index
    recovery.push({ id: 'r' + d, date: d, scoreState: 'SCORED', recovery: 50 + 5 * k, hrv: 60 - k, rhr: 55 + k });
    days.push({ id: d, date: d, appetite: k === 1 ? 2 : 4 });
  }
  const dv = fixture({ protocolItems: ITEMS, doses, whoopRecovery: recovery, days });
  const c = doseCycle(dv, 'weekly', { from: '2026-08-31', to: '2026-09-22' });
  assert.equal(c.byDay.length, 7);
  c.byDay.forEach((g) => assert.equal(g.recovery, 50 + 5 * g.daysSince));
  assert.equal(c.byDay[1].appetite, 2); assert.equal(c.byDay[3].appetite, 4);
  assert.equal(c.byDay[0].n, 4); assert.equal(c.byDay[1].n, 4); assert.equal(c.byDay[6].n, 3);
  assert.equal(c.n, 23);
  assert.deepEqual(c.lastDose, { date: '2026-09-21', at: null, amount: 2, unit: 'mg' });
  assert.equal(c.nextDue, '2026-09-28');
  assert.deepEqual(c.weeklyTotals.map((w) => [w.week, w.amount, w.target]), [['2026-08-31', 2, 2], ['2026-09-07', 2, 2], ['2026-09-14', 2, 2], ['2026-09-21', 2, 2]]);
  assert.equal(daysSinceDose(dv, '2026-09-23'), 2);
  assert.equal(daysSinceDose(dv, '2026-08-30'), null);
});

test('protocols: doseCycle weekly totals convert mcg/mg doses into the item unit', async () => {
  const { createStore } = await import('../../js/core/store.js');
  const { makeDataView } = await import('../../js/analytics/dataview.js');
  const { doseCycle } = await import('../../js/analytics/protocols.js');
  const s = createStore({ owner: 'app' });
  s.create('protocolItems', { id: 'pep', name: 'Peptide', kind: 'peptide', amount: 1.25, unit: 'mg', schedule: { type: 'days', days: [0, 3] }, weeklyTarget: { amount: 2.5, unit: 'mg' }, active: true, startedAt: '2026-09-01' });
  s.create('doses', { itemId: 'pep', date: '2026-09-21', at: '2026-09-21T07:00:00-04:00', amount: 1.25, unit: 'mg' });
  s.create('doses', { itemId: 'pep', date: '2026-09-24', at: '2026-09-24T07:00:00-04:00', amount: 1250, unit: 'mcg' });
  const dv = makeDataView(s, { tz: 'America/New_York', today: '2026-09-26' });
  const wk = doseCycle(dv, 'pep', { from: '2026-09-21', to: '2026-09-26' }).weeklyTotals.find((w) => w.week === '2026-09-21');
  assert.equal(wk.amount, 2.5);
  assert.equal(wk.target, 2.5);
});
