import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_SOURCES, parseAutoSource, buildAutoSource, kindsFor, supportsSentinel, sourceLabel, daysLabel, newStandard, draftFrom, applyChange,
  withTargetValue, validateStandard, toRecord, changedFields, sortStandards, reorder, nextOrder, stacksOf, targetText,
} from '../../js/ui/parts/settings-standards.js';
import { seedStandards, shardPath, periodOf } from '../../js/core/schema.js';
import { makeRecord } from '../../js/core/merge.js';
import { createStore } from '../../js/core/store.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { evaluateStandard } from '../../js/analytics/execution.js';

test('settings-standards: catalog covers every ARCHITECTURE §8 source', () => {
  const ids = AUTO_SOURCES.map((s) => s.id);
  for (const id of ['', 'whoop.wake', 'whoop.sleep', 'plan.adherence', 'training.session', 'nutrition.meals', 'nutrition.protein', 'nutrition.kcal',
    'nutrition.item', 'protocol.stack', 'protocol.item', 'day.caffeineCutoff', 'day.deepWork']) assert.ok(ids.includes(id), id);
  for (const s of AUTO_SOURCES) assert.ok(s.kinds.length && s.label && s.group, s.id);
});

test('settings-standards: parse/build auto source round-trips, args may contain colons', () => {
  assert.deepEqual(parseAutoSource('nutrition.item:chicken breast').arg, 'chicken breast');
  assert.equal(parseAutoSource('protocol.stack:AM').id, 'protocol.stack');
  assert.equal(parseAutoSource('nutrition.item:a:b').arg, 'a:b');
  assert.equal(parseAutoSource('').id, '');
  assert.equal(parseAutoSource(null).id, '');
  assert.equal(parseAutoSource('bogus.src').def, null);
  assert.equal(buildAutoSource('nutrition.item', '  salmon '), 'nutrition.item:salmon');
  assert.equal(buildAutoSource('whoop.wake', 'ignored'), 'whoop.wake');
  assert.equal(buildAutoSource('', 'x'), '');
  assert.deepEqual(kindsFor('whoop.wake'), ['time']);
  assert.ok(supportsSentinel('nutrition.protein') && !supportsSentinel('plan.adherence') && !supportsSentinel(''));
});

test('settings-standards: labels for rows', () => {
  assert.equal(sourceLabel(''), 'Manual');
  assert.equal(sourceLabel('nutrition.item:salmon'), 'Food eaten: salmon');
  assert.equal(sourceLabel('protocol.item:p1', { items: [{ id: 'p1', name: 'Creatine' }] }), 'Item logged: Creatine');
  assert.equal(sourceLabel('protocol.item:gone', { items: [] }), 'Item logged: removed item');
  assert.equal(sourceLabel('plan.adherence', { short: true }), 'Plan adherence');
  assert.equal(sourceLabel('x.unknown'), 'x.unknown');
  assert.equal(daysLabel([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(daysLabel([0, 1, 2, 3, 4]), 'Weekdays');
  assert.equal(daysLabel([5, 6]), 'Weekends');
  assert.equal(daysLabel([0, 1, 2, 3, 4, 5]), 'Mon–Sat');
  assert.equal(daysLabel([0, 2, 4]), 'Mon, Wed, Fri');
  assert.equal(daysLabel([]), 'Never');
  assert.equal(daysLabel(undefined), 'Every day');
  assert.equal(targetText({ kind: 'time', auto: 'whoop.wake', target: { op: '<=', value: 'target' } }), 'by wake target');
  assert.equal(targetText({ kind: 'number', auto: 'plan.adherence', target: { op: '>=', value: 90, unit: '%' } }), '≥ 90%');
  assert.equal(targetText({ kind: 'duration', auto: 'whoop.sleep', target: { op: '>=', value: 420, unit: 'min' } }), '≥ 420 min');
  assert.equal(targetText({ kind: 'check', auto: '' }), '');
});

test('settings-standards: new standard starts today and validates only once named', () => {
  const d = { ...newStandard({ today: '2026-09-26', order: 10 }), id: 'x' };
  assert.equal(d.effectiveFrom, '2026-09-26');
  assert.equal(d.order, 10);
  const v = validateStandard(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.name);
  assert.ok(validateStandard({ ...d, name: 'Stretch' }).ok);
});

test('settings-standards: every seeded standard is valid and survives draft → record unchanged', () => {
  for (const s of seedStandards()) {
    const d = draftFrom(s);
    const v = validateStandard(d);
    assert.ok(v.ok, `${s.id}: ${JSON.stringify(v.errors)}`);
    const rec = toRecord(d);
    assert.deepEqual(changedFields(s, rec), {}, s.id);
  }
});

test('settings-standards: switching source picks a compatible kind, target and unit', () => {
  let d = draftFrom({ id: 'a', name: 'X', kind: 'check', days: [0], weight: 2, effectiveFrom: '2026-01-01' });
  d = applyChange(d, { auto: 'whoop.wake' });
  assert.equal(d.kind, 'time');
  assert.deepEqual(d.target, { op: '<=', value: 'target', unit: null });
  d = applyChange(d, { auto: 'nutrition.protein' });
  assert.equal(d.kind, 'number');
  assert.equal(d.target.value, 'target');
  assert.equal(d.target.unit, 'g');
  d = applyChange(d, { auto: 'plan.adherence' });
  assert.equal(d.target.value, null, 'plan adherence has no settings target');
  assert.equal(d.target.unit, '%');
  d = withTargetValue(d, 85);
  assert.ok(validateStandard(d).ok);
  assert.deepEqual(toRecord(d).target, { op: '>=', value: 85, unit: '%' });
  d = applyChange(d, { auto: 'training.session' });
  assert.equal(d.kind, 'check');
  assert.equal(d.target, null);
  d = applyChange(d, { kind: 'avoid' });
  assert.equal(d.kind, 'avoid');
  assert.ok(validateStandard(d).ok);
});

test('settings-standards: duration keeps minutes or hours; the settings target forces the source unit', () => {
  let d = draftFrom({ id: 'b', name: 'Sleep', kind: 'duration', auto: 'whoop.sleep', target: { op: '>=', value: 420, unit: 'min' }, days: [0, 1], weight: 2, effectiveFrom: '2026-01-01' });
  assert.ok(validateStandard(d).ok);
  assert.equal(toRecord(d).target.unit, 'min');
  d = withTargetValue(d, 'target');
  assert.equal(d.target.unit, 'h');
  assert.deepEqual(toRecord(d).target, { op: '>=', value: 'target', unit: 'h' });
  d = withTargetValue(d, 7.5);
  assert.ok(['h', 'min'].includes(d.target.unit));
});

test('settings-standards: validation errors', () => {
  const base = { id: 'c', name: 'N', category: 'Body', kind: 'number', days: [0], weight: 2, effectiveFrom: '2026-01-01', auto: '', target: { op: '>=', value: 3 } };
  assert.ok(validateStandard(base).ok);
  assert.ok(validateStandard({ ...base, target: { op: '>=', value: null } }).errors.target);
  assert.ok(validateStandard({ ...base, target: { op: '>=', value: -1 } }).errors.target);
  assert.ok(validateStandard({ ...base, target: { op: '>=', value: 'target' } }).errors.target, 'manual source has no settings target');
  assert.ok(validateStandard({ ...base, kind: 'time', target: { op: '<=', value: '25:00' } }).errors.target);
  assert.ok(validateStandard({ ...base, kind: 'time', target: { op: '<=', value: '06:30' } }).ok);
  assert.ok(validateStandard({ ...base, kind: 'duration', target: { op: '>=', value: 30, unit: 'pages' } }).errors.target);
  assert.ok(validateStandard({ ...base, weight: 4 }).errors.weight);
  assert.ok(validateStandard({ ...base, days: [7] }).errors.days);
  assert.equal(validateStandard({ ...base, days: [] }).ok, true);
  assert.ok(validateStandard({ ...base, days: [] }).warnings.length);
  assert.ok(validateStandard({ ...base, auto: 'nutrition.item:', kind: 'check', target: null }).errors.auto);
  assert.ok(validateStandard({ ...base, auto: 'protocol.item:zz', kind: 'check', target: null }, { protocolItems: [{ id: 'p1' }] }).errors.auto);
  assert.ok(validateStandard({ ...base, auto: 'protocol.item:p1', kind: 'check', target: null }, { protocolItems: [{ id: 'p1' }] }).ok);
  assert.ok(validateStandard({ ...base, auto: 'whoop.wake' }).errors.kind, 'number kind is not valid for wake time');
  assert.ok(validateStandard({ ...base, auto: 'made.up' }).errors.auto);
  assert.ok(validateStandard({ ...base, category: 'Legacy' }).warnings.some((w) => /Legacy/.test(w)));
  assert.ok(validateStandard({ ...base, effectiveFrom: '' }).errors.effectiveFrom);
});

test('settings-standards: ordering', () => {
  const list = sortStandards([{ id: 'c', order: 3 }, { id: 'a', order: 1 }, { id: 'x' }, { id: 'b', order: 2 }]);
  assert.deepEqual(list.map((s) => s.id), ['a', 'b', 'c', 'x']);
  assert.deepEqual(reorder(list, 'b', -1), [{ id: 'b', order: 1 }, { id: 'a', order: 2 }, { id: 'x', order: 4 }], 'renumbers records without an order');
  assert.deepEqual(reorder(list, 'a', -1), []);
  assert.deepEqual(reorder(list, 'x', 1), []);
  assert.deepEqual(reorder(list, 'c', 1), [{ id: 'x', order: 3 }, { id: 'c', order: 4 }]);
  assert.equal(nextOrder(list), 4);
  assert.equal(nextOrder([]), 1);
  assert.deepEqual(stacksOf([{ schedule: { stack: 'PM' } }, { schedule: { stack: 'AM' } }, { schedule: { stack: 'am' } }, { schedule: {} }]), ['AM', 'PM']);
});

test('settings-standards: a saved draft evaluates like the stored standard (live preview)', () => {
  const store = createStore({ owner: 'app' });
  store.create('settings', { id: 'targets', wake: '06:30' });
  const sleep = makeRecord('s1', { date: '2026-09-26', nap: false, wake: '06:10', asleepMin: 450 }, 1000);
  store.loadShard(shardPath('whoopSleep', 'server', periodOf('whoopSleep', sleep)), { r: { s1: sleep } });
  const dv = makeDataView(store, { today: '2026-09-26', tz: 'America/New_York' });
  const d = applyChange(draftFrom({ id: 'w', name: 'Wake', kind: 'check', days: [0, 1, 2, 3, 4, 5, 6], weight: 2, effectiveFrom: '1970-01-01' }), { auto: 'whoop.wake' });
  const ev = evaluateStandard(dv, { id: d.id, ...toRecord(d) }, '2026-09-26');
  assert.equal(ev.applicable, true);
  assert.deepEqual(ev.target, { op: '<=', value: '06:30', unit: null });
  assert.equal(ev.display, '06:10');
  assert.equal(ev.done, true);
  const late = evaluateStandard(dv, { id: d.id, ...toRecord(withTargetValue(d, '06:00')) }, '2026-09-26');
  assert.equal(late.done, false);
});
