import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryLabel, monthLabel, addMonths, monthOptions, previousSnapshot, guessCategory, copyItems, cleanItems,
  draftFromSnapshot, snapshotPayload, equityFormula, categoryRows, snapshotRows, emptySnapshot,
} from '../../js/ui/parts/records-finance.js';
import { netWorth } from '../../js/analytics/finance.js';

test('records/finance: months and labels', () => {
  assert.equal(monthLabel('2026-09'), 'Sep 2026');
  assert.equal(monthLabel('2026-09', { short: true }), 'Sep ’26');
  assert.equal(monthLabel('bad'), 'bad');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2025-12', 1), '2026-01');
  assert.equal(addMonths('2026-09', -21), '2024-12');
  assert.deepEqual(monthOptions('2026-02-14', 3), ['2026-02', '2026-01', '2025-12']);
  assert.equal(categoryLabel('real-estate'), 'Real estate');
  assert.equal(categoryLabel('side_hustle'), 'Side hustle');
});

test('records/finance: previous snapshot and copying items', () => {
  const snaps = [{ month: '2026-07', items: [] }, { month: '2026-05' }, { month: '2026-09' }, { month: 'x' }];
  assert.equal(previousSnapshot(snaps, '2026-09').month, '2026-07');
  assert.equal(previousSnapshot(snaps, '2026-08').month, '2026-07');
  assert.equal(previousSnapshot(snaps, '2026-05'), null);
  const src = [{ name: 'Brokerage', type: 'asset', value: 25000 }, { name: 'Car loan', type: 'liability', value: '9000', category: 'debt' }];
  const c = copyItems(src);
  assert.deepEqual(c, [{ name: 'Brokerage', type: 'asset', value: 25000, category: 'investments' }, { name: 'Car loan', type: 'liability', value: 9000, category: 'debt' }]);
  c[0].value = 1;
  assert.equal(src[0].value, 25000, 'copy is independent');
});

test('records/finance: category guesses', () => {
  assert.equal(guessCategory('Roth IRA', 'asset'), 'retirement');
  assert.equal(guessCategory('Chase checking', 'asset'), 'cash');
  assert.equal(guessCategory('Bitcoin', 'asset'), 'crypto');
  assert.equal(guessCategory('Mortgage', 'asset'), 'debt');
  assert.equal(guessCategory('Anything', 'liability'), 'debt');
  assert.equal(guessCategory('Rental condo', 'asset'), 'real-estate');
  assert.equal(guessCategory('Holland trip fund', 'asset'), 'other');
});

test('records/finance: clean items, drafts and payloads', () => {
  assert.deepEqual(cleanItems([{ name: '', value: null }, { name: ' Cash ', value: -50 }, { value: 10, type: 'liability' }]), [
    { name: 'Cash', type: 'asset', value: 50, category: 'cash' }, { name: 'Liability', type: 'liability', value: 10, category: 'debt' },
  ]);
  const d = draftFromSnapshot({ month: '2026-09', gross: 20000, items: [{ name: 'Cash', type: 'asset', value: 12000, category: 'cash' }], note: 'n' });
  assert.equal(d.gross, 20000);
  d.items.push({ name: '', value: null });
  assert.deepEqual(snapshotPayload(d), { month: '2026-09', gross: 20000, items: [{ name: 'Cash', type: 'asset', value: 12000, category: 'cash' }], note: 'n' });
  assert.deepEqual(snapshotPayload(emptySnapshot('2026-10')), { month: '2026-10', gross: null, items: [], note: null });
  assert.equal(draftFromSnapshot({ month: '2026-09', gross: null, items: [] }).gross, null);
});

test('records/finance: equity formula text matches analytics equityFor', () => {
  const f = equityFormula(27500, { mult: 10, stake: 20, expense: 5000 });
  assert.equal(f.text, '($27,500 − $5,000) × 12 × 10 × 20%');
  assert.equal(f.equity, 540000);
  assert.equal(f.result, '$540,000');
  const none = equityFormula(null, { mult: 10, stake: 0, expense: 0 });
  assert.equal(none.equity, null); assert.equal(none.result, null);
  assert.equal(none.text, '(gross − $0) × 12 × 10 × 0%');
  assert.equal(equityFormula(3000, { mult: 10, stake: 20, expense: 5000 }).equity, 0, 'never negative');
});

test('records/finance: category rows and snapshot table rows', () => {
  const nw = netWorth({ month: '2026-09', gross: 20000, items: [{ name: 'Cash', type: 'asset', value: 100, category: 'cash' }, { name: 'Loan', type: 'liability', value: 300, category: 'debt' }, { name: 'Z', type: 'asset', value: 0, category: 'other' }] }, { mult: 1, stake: 0, expense: 0 });
  assert.deepEqual(categoryRows(nw.byCategory), [{ id: 'debt', label: 'Debt', value: -300 }, { id: 'cash', label: 'Cash', value: 100 }]);
  const series = [{ month: '2026-07', total: 100 }, { month: '2026-08', total: 250.5 }, { month: '2026-09', total: null }];
  const rows = snapshotRows(series, [{ month: '2026-08', gross: 5000 }]);
  assert.deepEqual(rows.map((r) => [r.month, r.gross, r.delta]), [['2026-09', null, null], ['2026-08', 5000, 150.5], ['2026-07', null, null]]);
});
