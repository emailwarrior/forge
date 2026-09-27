import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLabs, interpretLabs, parseLabValue, parseRefRange, normalizeLabFlag, normalizeLabDate, markerOutOfRange,
} from '../../js/ai/labs.js';
import { LAB_EXTRACT_SCHEMA, LAB_INTERPRET_SCHEMA } from '../../js/ai/schemas.js';
import { aiConfig, mockFetch, message, text, bothModes } from './fixtures/mock-claude.mjs';

const PDF = { data: 'JVBERi0xLjcKJeLjz9MK', mediaType: 'application/pdf' };
const PHOTO = { data: '/9j/4AAQSkZJRg', mediaType: 'image/jpeg' };
const m = (name, valueText, unit, rangeText, flag = '', section = '') => ({ name, valueText, unit, rangeText, flag, section });

const EXTRACTED = {
  collectedAt: '09/12/2026',
  lab: 'Quest Diagnostics',
  markers: [
    m('hs-CRP', '<0.5', 'mg/L', '<1.0', '', 'Inflammation'),
    m('Vitamin D, 25-Hydroxy', '28', 'ng/mL', '30-100', 'L'),
    m('Triglycerides', '162', 'mg/dL', '<150', '', 'Lipid Panel'),
    m('HDL Cholesterol', '52', 'mg/dL', '> OR = 40', ''),
    m('TSH', '1.92', 'mIU/L', '0.45–4.50'),
    m('eGFR', '>90', 'mL/min/1.73m2', '> OR = 60'),
    m('HIV 1/2 Ag/Ab', 'Non-Reactive', '', 'Non-Reactive'),
    m('Platelets', '1,234', 'x10E3/uL', '150-400', 'H*'),
    m('Potassium', '6.9', 'mmol/L', '3.5-5.3', 'CRIT HIGH'),
    m('hs-CRP', '<0.5', 'mg/L', '<1.0', '', 'Inflammation'), // duplicate copy on page 2
    m('Glucose', '', 'mg/dL', '65-99'), // no result printed
    m('', '5', '', ''),
  ],
  notes: ['Page 3 partially cut off.', ''],
};

test('extractLabs: request shape (documents, images, JSON-schema output, thinking disabled, no tools)', async () => {
  const f = mockFetch([{ message: message([text(JSON.stringify(EXTRACTED))]) }]);
  await extractLabs(aiConfig({ fetchImpl: f }), { files: [PDF, PHOTO, { data: 'data:image/png;base64,iVBORw0K' }], note: 'fasted 12h' });
  f.done();
  const b = f.calls[0].body;
  assert.deepEqual(b.output_config.format, { type: 'json_schema', schema: LAB_EXTRACT_SCHEMA });
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.equal('tools' in b, false);
  assert.equal(b.max_tokens, 16000);
  const c = b.messages[0].content;
  assert.deepEqual(c[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.data } });
  assert.deepEqual(c[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PHOTO.data } });
  assert.deepEqual(c[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } });
  assert.match(c[3].text, /3 files/);
  assert.match(c[3].text, /fasted 12h/);
  assert.match(b.system, /exactly as printed/);
  assert.match(b.system, /not medical advice/i);
});

test('extractLabs: verbatim names/units, values and ranges parsed in code, flags, dedupe, date', async () => {
  await bothModes(async (stream) => {
    const f = mockFetch([{ message: message([text(JSON.stringify(EXTRACTED))], { usage: { input_tokens: 20000, output_tokens: 3000 } }) }]);
    const r = await extractLabs(aiConfig({ fetchImpl: f, stream }), { files: [PDF] });
    f.done();
    assert.equal(r.collectedAt, '2026-09-12');
    assert.equal(r.lab, 'Quest Diagnostics');
    assert.deepEqual(r.notes, ['Page 3 partially cut off.']);
    assert.equal(r.costUsd, 0.07);
    const by = Object.fromEntries(r.markers.map((x) => [x.name, x]));
    assert.deepEqual(r.markers.map((x) => x.name), ['hs-CRP', 'Vitamin D, 25-Hydroxy', 'Triglycerides', 'HDL Cholesterol', 'TSH', 'eGFR', 'HIV 1/2 Ag/Ab', 'Platelets', 'Potassium']);

    const crp = by['hs-CRP'];
    assert.equal(crp.value, 0.5);
    assert.equal(crp.unit, 'mg/L');
    assert.equal(crp.refLow, null);
    assert.equal(crp.refHigh, 1);
    assert.equal(crp.flag, null);
    assert.match(crp.note, /Reported as "<0.5"; stored as 0.5 \(actual value is lower\)/);
    assert.equal(crp.valueText, '<0.5');
    assert.equal(crp.rangeText, '<1.0');
    assert.equal(crp.section, 'Inflammation');

    assert.deepEqual([by['Vitamin D, 25-Hydroxy'].value, by['Vitamin D, 25-Hydroxy'].refLow, by['Vitamin D, 25-Hydroxy'].refHigh, by['Vitamin D, 25-Hydroxy'].flag], [28, 30, 100, 'low']);
    assert.deepEqual([by.Triglycerides.value, by.Triglycerides.refLow, by.Triglycerides.refHigh, by.Triglycerides.flag], [162, null, 150, 'high']);
    assert.deepEqual([by['HDL Cholesterol'].refLow, by['HDL Cholesterol'].refHigh, by['HDL Cholesterol'].flag], [40, null, null]);
    assert.deepEqual([by.TSH.value, by.TSH.refLow, by.TSH.refHigh, by.TSH.flag, by.TSH.note], [1.92, 0.45, 4.5, null, null]);
    assert.deepEqual([by.eGFR.value, by.eGFR.refLow, by.eGFR.flag], [90, 60, null]);
    assert.match(by.eGFR.note, /actual value is higher/);
    const hiv = by['HIV 1/2 Ag/Ab'];
    assert.deepEqual([hiv.value, hiv.flag, hiv.refLow, hiv.refHigh], [null, null, null, null]);
    assert.match(hiv.note, /Non-Reactive/);
    assert.deepEqual([by.Platelets.value, by.Platelets.flag], [1234, 'high']);
    assert.equal(by.Potassium.flag, 'high');
    assert.match(by.Potassium.note, /critical/i);
  });
});

test('extractLabs: rejects unsupported files and missing input; max_tokens → AIError parse', async () => {
  const g = mockFetch([]);
  await assert.rejects(extractLabs(aiConfig({ fetchImpl: g }), { files: [] }), (e) => e.code === 'bad-request');
  await assert.rejects(extractLabs(aiConfig({ fetchImpl: g }), { files: [{ data: 'AAAA', mediaType: 'text/plain' }] }), (e) => e.code === 'bad-request');
  assert.equal(g.calls.length, 0);
  const f = mockFetch([{ message: message([text('{"collectedAt":"2026-09-12","lab":"Q","markers":[{"name":"A"')], { stop_reason: 'max_tokens' }) }]);
  await assert.rejects(extractLabs(aiConfig({ fetchImpl: f }), { files: [PDF] }), (e) => e.code === 'parse');
  f.done();
});

test('parseLabValue', () => {
  const v = (s) => parseLabValue(s);
  assert.deepEqual(v('5.2'), { value: 5.2, comparator: null, note: null });
  assert.equal(v('<0.5').value, 0.5);
  assert.equal(v('<0.5').comparator, '<');
  assert.equal(v('< 0.5').value, 0.5);
  assert.equal(v('≤0.5').comparator, '<=');
  assert.equal(v('< OR = 0.5').comparator, '<=');
  assert.equal(v('LESS THAN 10').value, 10);
  assert.equal(v('>1000').comparator, '>');
  assert.equal(v('1,234').value, 1234);
  assert.equal(v('12,345.6').value, 12345.6);
  assert.equal(v('5,2').value, 5.2);
  assert.equal(v('5.2 H').value, 5.2);
  assert.equal(v('12.5*').value, 12.5);
  assert.equal(v('-2.1').value, -2.1);
  assert.equal(v('−2.1').value, -2.1);
  assert.equal(v('.8').value, 0.8);
  assert.equal(v('Negative').value, null);
  assert.equal(v('Negative').note, 'Reported as "Negative".');
  assert.equal(v('1:80').value, null);
  assert.match(v('1:80').note, /titer/);
  assert.deepEqual(v(''), { value: null, comparator: null, note: null });
  assert.deepEqual(v(null), { value: null, comparator: null, note: null });
});

test('parseRefRange', () => {
  const r = (s) => { const x = parseRefRange(s); return [x.low, x.high]; };
  assert.deepEqual(r('30-100'), [30, 100]);
  assert.deepEqual(r('30 - 100 ng/mL'), [30, 100]);
  assert.deepEqual(r('0.45–4.50'), [0.45, 4.5]);
  assert.deepEqual(r('3.5 to 5.0'), [3.5, 5]);
  assert.deepEqual(r('<150'), [null, 150]);
  assert.deepEqual(r('< OR = 99'), [null, 99]);
  assert.deepEqual(r('≤ 5.6'), [null, 5.6]);
  assert.deepEqual(r('>39'), [39, null]);
  assert.deepEqual(r('> OR = 40'), [40, null]);
  assert.deepEqual(r('150 or less'), [null, 150]);
  assert.deepEqual(r('60 or more'), [60, null]);
  assert.deepEqual(r('up to 35'), [null, 35]);
  assert.deepEqual(r('-2.0-2.0'), [-2, 2]);
  assert.deepEqual(r('1,000-5,000'), [1000, 5000]);
  assert.deepEqual(r('Optimal <100; Borderline 100-129; High >=130'), [null, 100]);
  assert.deepEqual(r('Negative'), [null, null]);
  assert.deepEqual(r('<1:40'), [null, null]);
  assert.deepEqual(r(''), [null, null]);
  assert.deepEqual(r(undefined), [null, null]);
});

test('normalizeLabFlag, normalizeLabDate, markerOutOfRange', () => {
  const fl = (s) => normalizeLabFlag(s).flag;
  assert.equal(fl('H'), 'high');
  assert.equal(fl('HIGH'), 'high');
  assert.equal(fl('(H)'), 'high');
  assert.equal(fl('L'), 'low');
  assert.equal(fl('Low'), 'low');
  assert.equal(fl('A'), 'abnormal');
  assert.equal(fl('*'), 'abnormal');
  assert.equal(fl(''), null);
  assert.equal(fl('N'), null);
  assert.equal(fl('normal'), null);
  assert.deepEqual(normalizeLabFlag('HH'), { flag: 'high', critical: true });
  assert.deepEqual(normalizeLabFlag('CRIT LOW'), { flag: 'low', critical: true });
  assert.deepEqual(normalizeLabFlag('L'), { flag: 'low', critical: false });

  assert.equal(normalizeLabDate('2026-09-12'), '2026-09-12');
  assert.equal(normalizeLabDate('2026-09-12T08:15:00'), '2026-09-12');
  assert.equal(normalizeLabDate('09/12/2026'), '2026-09-12');
  assert.equal(normalizeLabDate('9/2/26'), '2026-09-02');
  assert.equal(normalizeLabDate('Sep 12, 2026'), '2026-09-12');
  assert.equal(normalizeLabDate('September 12th, 2026'), '2026-09-12');
  assert.equal(normalizeLabDate('12 Sep 2026'), '2026-09-12');
  assert.equal(normalizeLabDate('02/30/2026'), null);
  assert.equal(normalizeLabDate(''), null);
  assert.equal(normalizeLabDate('unknown'), null);

  assert.equal(markerOutOfRange({ value: 104, refLow: null, refHigh: 90 }), 'high');
  assert.equal(markerOutOfRange({ value: 20, refLow: 30, refHigh: 100 }), 'low');
  assert.equal(markerOutOfRange({ value: 50, refLow: 30, refHigh: 100 }), null);
  assert.equal(markerOutOfRange({ value: null, refLow: 30, flag: null }), null);
  assert.equal(markerOutOfRange({ value: 50, refLow: 30, refHigh: 100, flag: 'H' }), 'high');
  assert.equal(markerOutOfRange({ value: null, flag: 'abnormal' }), 'abnormal');
  assert.equal(markerOutOfRange({ value: '120', refHigh: '99' }), 'high');
});

const PANEL = {
  id: 'lab-2', collectedAt: '2026-09-12', lab: 'Quest',
  markers: [
    { key: 'apob', name: 'ApoB', value: 104, unit: 'mg/dL', refLow: null, refHigh: 90, flag: null },
    { key: 'hdl', name: 'HDL-C', value: 52, unit: 'mg/dL', refLow: 40, refHigh: null, flag: null },
    { key: 'vitamin_d', name: 'Vitamin D, 25-OH', value: 28, unit: 'ng/mL', refLow: 30, refHigh: 100, flag: 'low' },
  ],
};
const HISTORY = [
  PANEL,
  { id: 'lab-1', collectedAt: '2026-06-01', markers: [{ key: 'apob', name: 'ApoB', value: 92, unit: 'mg/dL' }, { key: 'hdl', name: 'HDL-C', value: 49, unit: 'mg/dL' }] },
  { id: 'lab-0', collectedAt: '2026-03-01', markers: [{ key: 'apob', name: 'ApoB', value: 101, unit: 'mg/dL' }] },
];
const PROTOCOLS = [
  { id: 'p1', name: 'Vitamin D3', kind: 'supplement', amount: 5000, unit: 'IU', schedule: { type: 'daily' }, active: true, startedAt: '2026-07-01' },
  { id: 'p2', name: 'Fish oil', kind: 'supplement', amount: 2, unit: 'g', active: false, endedAt: '2026-08-01' },
];

test('interpretLabs: prompt carries ranges, flags, history and protocols; out-of-range values are always surfaced', async () => {
  await bothModes(async (stream) => {
    const reply = {
      summary: 'Lipids mostly fine; vitamin D is below range.',
      items: [
        { key: 'hdl', name: 'HDL-C', status: 'NORMAL', text: 'HDL is 52 mg/dL, above the 40 mg/dL floor.' },
        { key: '', name: 'Vitamin D, 25-OH', status: 'borderline', text: 'Vitamin D is 28 ng/mL, just under 30.' },
        { key: 'x', name: 'Bogus', status: 'weird', text: 'Unknown status.' },
        { key: 'y', name: '', status: 'high', text: 'no name' },
      ],
      askDoctor: ['Is the vitamin D level worth rechecking in 3 months?'],
    };
    const f = mockFetch([{ message: message([text(JSON.stringify(reply))]) }]);
    const r = await interpretLabs(aiConfig({ fetchImpl: f, stream }), { panel: PANEL, history: HISTORY, protocols: PROTOCOLS });
    f.done();
    const b = f.calls[0].body;
    assert.deepEqual(b.output_config.format, { type: 'json_schema', schema: LAB_INTERPRET_SCHEMA });
    const prompt = b.messages[0].content;
    assert.match(prompt, /ApoB \[apob\]: 104 mg\/dL \| ≤ 90 \| —/);
    assert.match(prompt, /Outside the printed reference range.*ApoB \(high\).*Vitamin D, 25-OH \(low\)/);
    assert.match(prompt, /- ApoB: 2026-06-01 92 mg\/dL; 2026-03-01 101 mg\/dL/);
    assert.match(prompt, /- HDL-C: 2026-06-01 49 mg\/dL/);
    assert.doesNotMatch(prompt, /2026-09-12 104/, 'current panel is not repeated as history');
    assert.match(prompt, /Vitamin D3 \(supplement\): 5000 IU, daily; active since 2026-07-01/);
    assert.match(prompt, /Fish oil \(supplement\): 2 g; stopped 2026-08-01/);
    assert.match(b.system, /Never recommend starting, stopping, or changing the dose/);
    assert.match(b.system, /physician/);

    assert.equal(r.summary, reply.summary);
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    assert.equal(r.items[0].name, 'ApoB', 'missing out-of-range marker is added first');
    assert.equal(byName.ApoB.status, 'high');
    assert.equal(byName.ApoB.key, 'apob');
    assert.match(byName.ApoB.text, /physician/);
    assert.equal(byName['HDL-C'].status, 'normal');
    assert.equal(byName['Vitamin D, 25-OH'].status, 'low', 'printed range beats the model label');
    assert.equal(byName['Vitamin D, 25-OH'].key, 'vitamin_d');
    assert.equal(byName.Bogus.status, 'unknown');
    assert.equal(r.items.length, 4);
    assert.equal(r.askDoctor[0], reply.askDoctor[0]);
    assert.match(r.askDoctor[1], /ApoB \(high\)/);
    assert.doesNotMatch(r.askDoctor[1], /Vitamin D/, 'already covered by the model');
  });
});

test('interpretLabs: empty panel is rejected', async () => {
  const g = mockFetch([]);
  await assert.rejects(interpretLabs(aiConfig({ fetchImpl: g }), { panel: { markers: [] } }), (e) => e.code === 'bad-request');
  assert.equal(g.calls.length, 0);
});
