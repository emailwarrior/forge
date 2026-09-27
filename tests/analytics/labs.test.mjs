import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeRecord } from '../../js/core/merge.js';
import { shardPath, periodOf, COLLECTIONS } from '../../js/core/schema.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { MARKERS, normalizeMarkerName, markerSeries, panelFlags, labSummary, protocolBeforeAfter, parseValue, markerFlag } from '../../js/analytics/labs.js';

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

test('labs: marker names from real reports normalize to catalog keys', () => {
  const cases = {
    'Vitamin D, 25-Hydroxy': 'vitamin_d', '25-OH Vitamin D': 'vitamin_d', 'VITAMIN D,25-OH,TOTAL,IA': 'vitamin_d', '25-Hydroxyvitamin D3': 'vitamin_d',
    'Vitamin D, 1,25-Dihydroxy': 'vitamin_d_125',
    'Testosterone, Total, LC/MS': 'testosterone_total', 'Testosterone': 'testosterone_total', 'Testosterone, Serum': 'testosterone_total',
    'Testosterone, Free': 'free_testosterone', 'Free Testosterone (Direct)': 'free_testosterone', 'Testosterone, Bioavailable': 'bioavailable_testosterone',
    hsCRP: 'hscrp', 'hs-CRP': 'hscrp', 'C-Reactive Protein, Cardiac': 'hscrp', 'CRP, High Sensitivity': 'hscrp', 'C-Reactive Protein': 'crp',
    'Hemoglobin A1c': 'hba1c', HbA1c: 'hba1c', 'A1C': 'hba1c', 'Hemoglobin A1c (Glycated)': 'hba1c', Hemoglobin: 'hemoglobin',
    'LDL Cholesterol Calc': 'ldl', 'LDL-C': 'ldl', 'LDL Chol Calc (NIH)': 'ldl', 'LDL-P': 'ldl_p', 'HDL Cholesterol': 'hdl', 'Non-HDL Cholesterol': 'non_hdl',
    'Cholesterol, Total': 'total_cholesterol', 'Triglycerides': 'triglycerides', 'Chol/HDLC Ratio': 'chol_hdl_ratio', 'LDL/HDL Ratio': null,
    'ApoB': 'apob', 'Apolipoprotein B': 'apob', 'Lipoprotein (a)': 'lpa',
    'eGFR non-afr. american': 'egfr', 'eGFR If NonAfricn Am': 'egfr', 'eGFR African American': 'egfr_aa', 'eGFR': 'egfr',
    'Creatinine': 'creatinine', 'Creatinine, Serum': 'creatinine', 'BUN/Creatinine Ratio': 'bun_creatinine_ratio', 'Urea Nitrogen (BUN)': 'bun',
    'ALT (SGPT)': 'alt', 'AST (SGOT)': 'ast', 'Glucose, Serum': 'glucose', 'Fasting Glucose': 'glucose',
    'Estradiol, Sensitive': 'estradiol', 'Estradiol (E2)': 'estradiol', 'Sex Hormone Binding Globulin': 'shbg', SHBG: 'shbg', 'Globulin, Total': 'globulin',
    TSH: 'tsh', 'Free T3': 'free_t3', 'T3, Free': 'free_t3', 'Triiodothyronine (T3), Free': 'free_t3', 'T4, Free (Direct)': 'free_t4', 'T3 Uptake': null,
    'Ferritin, Serum': 'ferritin', 'Iron, Total': 'iron', 'Iron Binding Capacity': 'tibc', '% Saturation': 'transferrin_sat',
    Cortisol: 'cortisol', 'Cortisol, A.M.': 'cortisol', 'DHEA-Sulfate': 'dhea_s', 'DHEA-S': 'dhea_s', Progesterone: 'progesterone',
    Magnesium: 'magnesium', 'Magnesium, RBC': 'magnesium_rbc', 'Vitamin B12': 'b12', 'IGF-1, LC/MS': 'igf1', 'Prostate Specific Antigen, Total': 'psa',
    'Creatinine Clearance': null, 'Albumin/Globulin Ratio': null, 'Something Unknown': null,
  };
  for (const [name, key] of Object.entries(cases)) assert.equal(normalizeMarkerName(name), key, name);
  assert.equal(normalizeMarkerName(null), null);
  // Every catalog alias round-trips to its own key.
  for (const [key, def] of Object.entries(MARKERS)) for (const a of def.aliases) assert.equal(normalizeMarkerName(a), key, `${key}: ${a}`);
  for (const def of Object.values(MARKERS)) assert.ok(def.name && def.category && 'lowerIsBetter' in def);
});

test('labs: values and flags come from the report range (no invented ranges)', () => {
  assert.deepEqual(parseValue('<0.5'), { value: 0.5, qualifier: '<' });
  assert.deepEqual(parseValue(12.3), { value: 12.3, qualifier: null });
  assert.deepEqual(parseValue('n/a'), { value: null, qualifier: null });
  assert.equal(markerFlag({ value: 110, refLow: 0, refHigh: 99 }), 'high');
  assert.equal(markerFlag({ value: 25, refLow: 30, refHigh: 100 }), 'low');
  assert.equal(markerFlag({ value: 50, refLow: 30, refHigh: 100, flag: 'H' }), null, 'range wins over a stray flag');
  assert.equal(markerFlag({ value: 50, flag: 'H' }), 'high', "report flag when there is no range");
  assert.equal(markerFlag({ value: 50 }), null);
  assert.equal(markerFlag({ value: 'Positive', flag: 'A' }), 'abnormal', 'qualitative result flagged by the report');
  assert.equal(markerFlag({ value: 'Negative', flag: '' }), null);
});

function labFixture() {
  return fixture({
    protocolItems: [{ id: 'd3', name: 'D3', kind: 'supplement', schedule: { type: 'daily' }, active: true, startedAt: '2026-08-01' }],
    labs: [
      { id: 'L1', collectedAt: '2026-06-01', date: '2026-06-01', markers: [
        { name: 'Vitamin D, 25-Hydroxy', value: 24, unit: 'ng/mL', refLow: 30, refHigh: 100 },
        { name: 'LDL Cholesterol Calc', value: 95, unit: 'mg/dL', refLow: 0, refHigh: 99 },
      ] },
      { id: 'L2', collectedAt: '2026-09-01', date: '2026-09-01', markers: [
        { key: 'vitamin_d', name: '25-OH Vitamin D', value: 48, unit: 'ng/mL', refLow: 30, refHigh: 100 },
        { name: 'LDL-C', value: '110', unit: 'mg/dL', refLow: 0, refHigh: 99 },
        { name: 'hsCRP', value: '<0.3', unit: 'mg/L', refLow: 0, refHigh: 1 },
      ] },
    ],
  });
}

test('labs: series, panel flags and summary', () => {
  const dv = labFixture();
  const vd = markerSeries(dv, 'vitamin_d');
  assert.deepEqual(vd.map((p) => [p.date, p.value, p.flag]), [['2026-06-01', 24, 'low'], ['2026-09-01', 48, null]]);
  assert.deepEqual(markerSeries(dv, 'ldl').map((p) => p.value), [95, 110]);
  const flags = panelFlags(dv.labs()[1]);
  assert.deepEqual(flags.map((f) => [f.key, f.flag]), [['ldl', 'high']]);
  const s = labSummary(dv);
  assert.equal(s.latest.date, '2026-09-01'); assert.equal(s.latest.flaggedCount, 1);
  assert.deepEqual(s.flagged.map((f) => f.key), ['ldl']);
  assert.deepEqual(s.changes.map((c) => [c.key, c.from, c.to, c.pct]), [['vitamin_d', 24, 48, 100], ['ldl', 95, 110, 15.8]]);
  const vdm = s.markers.find((m) => m.key === 'vitamin_d');
  assert.equal(vdm.category, 'vitamins'); assert.equal(vdm.latest.value, 48); assert.equal(vdm.series.length, 2);
  assert.deepEqual(labSummary(fixture({})), { latest: null, flagged: [], changes: [], markers: [] });
});

test('labs: marker before vs after a protocol started', () => {
  const dv = labFixture();
  const r = protocolBeforeAfter(dv, 'vitamin_d', 'd3');
  assert.equal(r.start, '2026-08-01');
  assert.deepEqual(r.before, { mean: 24, n: 1 }); assert.deepEqual(r.after, { mean: 48, n: 1 });
  assert.equal(r.delta, 24);
  const none = protocolBeforeAfter(dv, 'vitamin_d', 'missing');
  assert.equal(none.delta, null);
});
