import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyForName, newRow, autoFlag, rowFlag, rowsFromExtraction, rowsFromPanel, rowToMarker, reviewMarkers, groupMarkers,
  refText, valueText, changeVsPrevious, fileKind, protocolsForAi, isCatalogKey, statusTone, flagOf, flaggedMarkers,
} from '../../js/ui/parts/records-labs.js';
import { markerKey } from '../../js/analytics/labs.js';

test('records/labs: keys map to the catalog, unmapped names get a stable slug', () => {
  assert.equal(keyForName('LDL Cholesterol Calc'), 'ldl');
  assert.equal(keyForName('Vitamin D, 25-Hydroxy'), 'vitamin_d');
  assert.equal(keyForName('RDW'), 'rdw');
  assert.equal(isCatalogKey('rdw'), false);
  assert.equal(markerKey({ key: 'rdw', name: 'RDW' }), 'rdw', 'analytics keeps the slug for trends');
  assert.equal(keyForName(''), null);
});

test('records/labs: automatic flags follow the printed range; a hand-picked flag wins', () => {
  assert.equal(autoFlag(newRow({ value: '104', refLow: 0, refHigh: 100 })), 'high');
  assert.equal(autoFlag(newRow({ value: '1,234', refLow: 0, refHigh: 2000 })), '', 'thousands separator');
  assert.equal(autoFlag(newRow({ value: '<0.5', refLow: 1, refHigh: 5 })), 'low');
  assert.equal(autoFlag(newRow({ value: 'Negative' })), '');
  assert.equal(rowFlag(newRow({ value: 'Reactive', flag: 'abnormal', flagTouched: true })), 'abnormal');
  assert.equal(rowFlag(newRow({ value: '50', refLow: 60, flag: 'high', flagTouched: false })), 'low');
});

test('records/labs: extraction and stored panels become review rows and back', () => {
  const res = { markers: [
    { name: 'LDL-C', value: 104, unit: 'mg/dL', refLow: null, refHigh: 100, flag: 'high', note: null, valueText: '104' },
    { name: 'HIV Ab', value: null, unit: '', refLow: null, refHigh: null, flag: 'abnormal', valueText: 'Reactive' },
    { name: 'hs-CRP', value: 0.5, unit: 'mg/L', refLow: null, refHigh: 1, flag: null, valueText: '<0.5', note: 'Reported as "<0.5"; stored as 0.5 (actual value is lower).' },
  ] };
  const rows = rowsFromExtraction(res);
  assert.deepEqual(rows.map((r) => [r.value, r.flag, r.flagTouched]), [['104', 'high', false], ['Reactive', 'abnormal', true], ['0.5', '', false]]);
  const markers = rows.map(rowToMarker);
  assert.deepEqual(markers[0], { key: 'ldl', name: 'LDL-C', value: 104, unit: 'mg/dL', refLow: null, refHigh: 100, flag: 'high', note: null });
  assert.equal(markers[1].value, 'Reactive'); assert.equal(markers[1].flag, 'abnormal');
  assert.equal(markers[2].note.startsWith('Reported as'), true);
  const back = rowsFromPanel({ markers });
  assert.deepEqual(back.map((r) => r.value), ['104', 'Reactive', '0.5']);
  assert.equal(rowToMarker(newRow()), null, 'blank rows are dropped');
  const rv = reviewMarkers([...rows, newRow({ name: 'Glucose' }), newRow()]);
  assert.equal(rv.markers.length, 4); assert.equal(rv.missing.length, 1);
});

test('records/labs: grouping by catalog category, unmapped under Other', () => {
  const g = groupMarkers([{ name: 'TSH', value: 1.9 }, { name: 'LDL-C', value: 90 }, { name: 'RDW', key: 'rdw', value: 13 }, { name: 'ApoB', value: 80 }]);
  assert.deepEqual(g.map((x) => x.id), ['lipids', 'thyroid', 'other']);
  assert.deepEqual(g[0].markers.map((m) => m.key), ['ldl', 'apob'], 'report order inside a group');
});

test('records/labs: display helpers and change vs previous', () => {
  assert.equal(refText(30, 100), '30–100');
  assert.equal(refText(null, 150), '≤ 150');
  assert.equal(refText(40, null), '≥ 40');
  assert.equal(refText(null, null), '');
  assert.equal(valueText(1234.5678), '1,234.568');
  assert.equal(valueText('Negative'), 'Negative');
  assert.equal(valueText(null), '—');
  const series = [{ date: '2026-06-01', value: 100, panelId: 'a' }, { date: '2026-07-01', value: null, panelId: 'b' }, { date: '2026-09-01', value: 90, panelId: 'c' }];
  assert.deepEqual(changeVsPrevious(series, 'c'), { prev: 100, prevDate: '2026-06-01', delta: -10, pct: -10 });
  assert.equal(changeVsPrevious(series, 'a'), null);
  assert.equal(changeVsPrevious(series, 'zzz'), null);
});

test('records/labs: upload kinds, AI protocol payload, status tones', () => {
  assert.equal(fileKind({ type: 'application/pdf', name: 'x' }), 'pdf');
  assert.equal(fileKind({ type: '', name: 'Report.PDF' }), 'pdf');
  assert.equal(fileKind({ type: 'image/heic', name: 'IMG_1.HEIC' }), 'image');
  assert.equal(fileKind({ type: 'text/plain', name: 'a.txt' }), null);
  const p = protocolsForAi([{ name: 'Secret peptide', kind: 'peptide', neutralLabel: 'Protocol', amount: 1, unit: 'mg' }, { name: 'Creatine', kind: 'supplement', amount: 5, unit: 'g' }]);
  assert.equal(p[0].name, 'Protocol'); assert.equal('kind' in p[0], false);
  assert.equal(p[1].name, 'Creatine'); assert.equal(p[1].kind, 'supplement');
  assert.equal(statusTone('high'), 'bad'); assert.equal(statusTone('borderline'), 'warn'); assert.equal(statusTone('unknown'), null);
});

test('records/labs: displayed flags use the range first, then the report flag (incl. abnormal)', () => {
  assert.equal(flagOf({ value: 120, refLow: 0, refHigh: 100, flag: null }), 'high');
  assert.equal(flagOf({ value: 90, refLow: 0, refHigh: 100, flag: 'high' }), null, 'the printed range wins over a stale flag');
  assert.equal(flagOf({ value: 'Reactive', flag: 'abnormal' }), 'abnormal');
  assert.equal(flagOf({ value: 5, flag: 'L' }), 'low');
  assert.equal(flagOf(null), null);
  assert.deepEqual(flaggedMarkers({ markers: [{ name: 'LDL-C', value: 104, refHigh: 100 }, { name: 'HDL-C', value: 50, refLow: 40 }, { name: 'HIV Ab', value: 'Reactive', flag: 'abnormal' }] }),
    [{ key: 'ldl', name: 'LDL-C', flag: 'high' }, { key: null, name: 'HIV Ab', flag: 'abnormal' }], 'no stored key and no catalog match → null key');
});
