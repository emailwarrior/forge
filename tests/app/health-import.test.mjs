import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHealthExport, parseHealthDate, parseNumber, fieldFor, convertUnit, parseCsv, diffHealthDays, applyHealthImport, HEALTH_FIELDS,
} from '../../js/app/health-import.js';
import { createStore } from '../../js/core/store.js';

const TZ = 'America/New_York';
const parse = (x) => parseHealthExport(x, { tz: TZ });

test('health: field names, Apple Health types, HealthKit ids and unit suffixes', () => {
  assert.deepEqual(fieldFor('steps'), { key: 'steps', unit: null });
  assert.deepEqual(fieldFor('Active Energy'), { key: 'activeKcal', unit: null });
  assert.deepEqual(fieldFor('Resting Energy'), { key: 'restingKcal', unit: null });
  assert.deepEqual(fieldFor('Apple Exercise Time'), { key: 'exerciseMin', unit: null });
  assert.deepEqual(fieldFor('Exercise Minutes'), { key: 'exerciseMin', unit: null });
  assert.deepEqual(fieldFor('Stand Hours'), { key: 'standH', unit: null });
  assert.deepEqual(fieldFor('Resting Heart Rate'), { key: 'restingHr', unit: null });
  assert.deepEqual(fieldFor('Heart Rate Variability'), { key: 'hrvSdnn', unit: null });
  assert.deepEqual(fieldFor('VO2 Max'), { key: 'vo2max', unit: null });
  assert.deepEqual(fieldFor('Body Mass'), { key: 'weightLb', unit: null });
  assert.deepEqual(fieldFor('Weight'), { key: 'weightLb', unit: null });
  assert.deepEqual(fieldFor('Body Fat Percentage'), { key: 'bodyFatPct', unit: null });
  assert.deepEqual(fieldFor('HKQuantityTypeIdentifierStepCount'), { key: 'steps', unit: null });
  assert.deepEqual(fieldFor('HKQuantityTypeIdentifierHeartRateVariabilitySDNN'), { key: 'hrvSdnn', unit: null });
  assert.deepEqual(fieldFor('Weight (kg)'), { key: 'weightLb', unit: 'kg' });
  assert.deepEqual(fieldFor('weight_kg'), { key: 'weightLb', unit: 'kg' });
  assert.deepEqual(fieldFor('active_energy_kj'), { key: 'activeKcal', unit: 'kj' });
  assert.deepEqual(fieldFor('weightLb'), { key: 'weightLb', unit: null });
  assert.equal(fieldFor('Sleep Analysis'), null);
  assert.equal(fieldFor('Flights Climbed'), null);
  assert.equal(fieldFor(''), null);
});

test('health: numbers and unit conversion', () => {
  assert.deepEqual(parseNumber('8,123'), { value: 8123, unit: null });
  assert.deepEqual(parseNumber('80.2 kg'), { value: 80.2, unit: 'kg' });
  assert.deepEqual(parseNumber('72,5'), { value: 72.5, unit: null });
  assert.deepEqual(parseNumber(' 1,234,567.5 '), { value: 1234567.5, unit: null });
  assert.deepEqual(parseNumber('58 count/min'), { value: 58, unit: 'count/min' });
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber(NaN), null);
  assert.equal(Math.round(convertUnit('weightLb', 80, 'kg') * 10) / 10, 176.4);
  assert.equal(Math.round(convertUnit('weightLb', 80000, 'g') * 10) / 10, 176.4);
  assert.equal(convertUnit('weightLb', 12, 'st'), 168);
  assert.equal(convertUnit('weightLb', 180, 'lb'), 180);
  assert.equal(Math.round(convertUnit('activeKcal', 4184, 'kJ')), 1000);
  assert.equal(convertUnit('exerciseMin', 1.5, 'hr'), 90);
  assert.equal(convertUnit('exerciseMin', 1800, 's'), 30);
  assert.equal(convertUnit('hrvSdnn', 0.045, 's'), 45);
  assert.equal(convertUnit('bodyFatPct', 0.182, '%'), 18.2, 'HealthKit stores body fat as a fraction');
  assert.equal(convertUnit('bodyFatPct', 18.2, '%'), 18.2);
});

test('health: dates in every accepted form', () => {
  assert.deepEqual(parseHealthDate('2026-09-25', TZ), { ymd: '2026-09-25', min: null });
  assert.deepEqual(parseHealthDate('2026-09-25T07:31:00-07:00', TZ), { ymd: '2026-09-25', min: 451 }, 'numeric offset keeps the wall clock');
  assert.deepEqual(parseHealthDate('2026-09-25 23:10:00 -0400', TZ), { ymd: '2026-09-25', min: 1390 });
  assert.deepEqual(parseHealthDate('2026-09-26T02:30:00Z', TZ), { ymd: '2026-09-25', min: 1350 }, 'Z converts to the profile zone');
  assert.deepEqual(parseHealthDate('2026-09-26T02:30:00.000Z', TZ), { ymd: '2026-09-25', min: 1350 });
  assert.deepEqual(parseHealthDate('Sep 25, 2026 at 7:31 AM', TZ), { ymd: '2026-09-25', min: 451 });
  assert.deepEqual(parseHealthDate('Sep 25, 2026 at 7:31 PM', TZ), { ymd: '2026-09-25', min: 1171 }, 'iOS narrow no-break space');
  assert.deepEqual(parseHealthDate('September 5, 2026', TZ), { ymd: '2026-09-05', min: null });
  assert.deepEqual(parseHealthDate('Fri, Sep 25, 2026', TZ), { ymd: '2026-09-25', min: null });
  assert.deepEqual(parseHealthDate('25 Sep 2026 at 19:02', TZ), { ymd: '2026-09-25', min: 1142 });
  assert.deepEqual(parseHealthDate('9/25/2026', TZ), { ymd: '2026-09-25', min: null });
  assert.deepEqual(parseHealthDate('9/25/26, 12:05 AM', TZ), { ymd: '2026-09-25', min: 5 });
  assert.deepEqual(parseHealthDate('25/09/2026', TZ), { ymd: '2026-09-25', min: null }, 'day-first when unambiguous');
  assert.deepEqual(parseHealthDate('2026/09/25 7:05', TZ), { ymd: '2026-09-25', min: 425 });
  assert.deepEqual(parseHealthDate(Date.UTC(2026, 8, 25, 16, 0), TZ), { ymd: '2026-09-25', min: 720 }, 'epoch ms');
  assert.deepEqual(parseHealthDate(Date.UTC(2026, 8, 25, 16, 0) / 1000, TZ), { ymd: '2026-09-25', min: 720 }, 'epoch s');
  assert.equal(parseHealthDate('2026-02-30', TZ), null);
  assert.equal(parseHealthDate('13/13/2026', TZ), null);
  assert.equal(parseHealthDate('yesterday', TZ), null);
  assert.equal(parseHealthDate('', TZ), null);
  assert.equal(parseHealthDate(null, TZ), null);
});

test('health: {days:[…]} with aliases, units in keys, overrides, plausibility and unknown fields', () => {
  const r = parse(JSON.stringify({
    days: [
      { date: '2026-09-24', steps: 8123, activeKcal: 612.4, restingKcal: 1890, exerciseMin: 41, standH: 11, restingHr: 56, hrvSdnn: 61.26, vo2max: 47.3, weightLb: 176.44, bodyFatPct: 0.172 },
      { date: '2026-09-25', 'Step Count': '9,876', weight_kg: 80, 'Flights Climbed': 12, hrvSdnn: 400 },
      { date: '2026-09-24', steps: 8200 },
      { steps: 100 },
    ],
  }));
  assert.equal(r.format, 'days');
  assert.deepEqual(r.days, [
    { date: '2026-09-24', steps: 8200, activeKcal: 612, restingKcal: 1890, exerciseMin: 41, standH: 11, restingHr: 56, hrvSdnn: 61.3, vo2max: 47.3, weightLb: 176.4, bodyFatPct: 17.2 },
    { date: '2026-09-25', steps: 9876, weightLb: 176.4 },
  ]);
  const w = r.warnings.join(' | ');
  assert.match(w, /HRV \(SDNN\): dropped 1 implausible value \(outside 5–300 ms\) on 2026-09-25/);
  assert.match(w, /Ignored unknown field: Flights Climbed/);
  assert.match(w, /Skipped 1 entry without a readable date/);
});

test('health: bare array of days, a single day, and days keyed by date', () => {
  assert.deepEqual(parse([{ date: '2026-09-25', steps: 5000 }]).days, [{ date: '2026-09-25', steps: 5000 }]);
  assert.deepEqual(parse({ date: '2026-09-25', restingHr: 55 }).days, [{ date: '2026-09-25', restingHr: 55 }]);
  assert.deepEqual(parse({ days: { '2026-09-25': { steps: 1 }, '2026-09-24': { steps: 2 } } }).days, [{ date: '2026-09-24', steps: 2 }, { date: '2026-09-25', steps: 1 }]);
  assert.deepEqual(parse({ '2026-09-25': { steps: 7 } }).days, [{ date: '2026-09-25', steps: 7 }]);
});

test('health: samples aggregate per local date — sums, means, last values, unit conversion', () => {
  const samples = [
    { type: 'Steps', value: 3000, unit: 'count', start: '2026-09-25T08:00:00-04:00', end: '2026-09-25T09:00:00-04:00' },
    { type: 'Steps', value: '4,500', unit: 'count', start: '2026-09-25T18:00:00-04:00' },
    { type: 'Steps', value: 1200, unit: 'count', start: '2026-09-26T00:30:00-04:00' },
    { type: 'Active Energy', value: 2092, unit: 'kJ', start: '2026-09-25T12:00:00-04:00' },
    { type: 'Heart Rate Variability', value: 50, unit: 'ms', start: '2026-09-25T03:00:00-04:00' },
    { type: 'Heart Rate Variability', value: 70, unit: 'ms', start: '2026-09-25T04:00:00-04:00' },
    { type: 'Heart Rate Variability', value: 900, unit: 'ms', start: '2026-09-25T05:00:00-04:00' },
    { type: 'Resting Heart Rate', value: 57, unit: 'count/min', date: '2026-09-25' },
    { type: 'Body Mass', value: 80.5, unit: 'kg', start: '2026-09-25T21:00:00-04:00' },
    { type: 'Body Mass', value: 80.0, unit: 'kg', start: '2026-09-25T07:00:00-04:00' },
    { type: 'Body Fat Percentage', value: 0.18, unit: '%', start: '2026-09-25T07:00:00-04:00' },
    { type: 'Stand Hours', value: 1, unit: 'hr', start: '2026-09-25T09:00:00-04:00' },
    { type: 'Stand Hours', value: 1, unit: 'hr', start: '2026-09-25T10:00:00-04:00' },
    { type: 'Apple Exercise Time', value: 0.5, unit: 'hr', start: '2026-09-25T17:00:00-04:00' },
    { type: 'VO2 Max', value: '46.1 mL/(kg·min)', start: '2026-09-20T10:00:00-04:00' },
    { type: 'Sleep Analysis', value: 7, start: '2026-09-25T07:00:00-04:00' },
    { type: 'Steps', value: 100 },
  ];
  const r = parse({ samples });
  assert.equal(r.format, 'samples');
  assert.deepEqual(r.days, [
    { date: '2026-09-20', vo2max: 46.1 },
    { date: '2026-09-25', steps: 7500, activeKcal: 500, hrvSdnn: 60, restingHr: 57, weightLb: 177.5, bodyFatPct: 18, standH: 2, exerciseMin: 30 },
    { date: '2026-09-26', steps: 1200 },
  ]);
  const w = r.warnings.join(' | ');
  assert.match(w, /HRV \(SDNN\): dropped 1/);
  assert.match(w, /Ignored unknown field: Sleep Analysis/);
  assert.match(w, /Skipped 1 entry without a readable date/);
  // bare array of samples; HealthKit identifiers; Z times convert to the zone
  const r2 = parse([{ type: 'HKQuantityTypeIdentifierStepCount', value: 10, startDate: '2026-09-26T02:00:00Z' }]);
  assert.deepEqual(r2.days, [{ date: '2026-09-25', steps: 10 }]);
});

test('health: daily sums are range-checked after aggregation', () => {
  const r = parse({ samples: [{ type: 'Steps', value: 60000, date: '2026-09-25' }, { type: 'Steps', value: 60000, date: '2026-09-25' }, { type: 'Steps', value: -5, date: '2026-09-24' }] });
  assert.deepEqual(r.days, []);
  assert.match(r.warnings.join(' '), /Steps: dropped 2 implausible values/);
  assert.match(r.warnings[0], /No health data found/);
});

test('health: CSV with header, aliases, bracketed units, quotes and other delimiters', () => {
  const csv = 'Date,Steps,"Active Energy",Weight (kg),Resting HR,Notes\n2026-09-24,"8,123",600,80,55,x\n9/25/2026,9000,,81,,\n\n';
  const r = parse(csv);
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.days, [
    { date: '2026-09-24', steps: 8123, activeKcal: 600, weightLb: 176.4, restingHr: 55 },
    { date: '2026-09-25', steps: 9000, weightLb: 178.6 },
  ]);
  assert.match(r.warnings.join(' '), /Ignored unknown field: Notes/);
  const semi = parse('date;steps;hrv\n2026-09-25;5000;48,5\n');
  assert.deepEqual(semi.days, [{ date: '2026-09-25', steps: 5000, hrvSdnn: 48.5 }]);
  const tsv = parse('﻿date\tweightLb\n2026-09-25\t180.2\n');
  assert.deepEqual(tsv.days, [{ date: '2026-09-25', weightLb: 180.2 }]);
  const samplesCsv = parse('type,value,unit,start\nSteps,100,count,2026-09-25T08:00:00-04:00\nSteps,50,count,2026-09-25T09:00:00-04:00\n');
  assert.deepEqual(samplesCsv.days, [{ date: '2026-09-25', steps: 150 }]);
  assert.match(parse('steps,hrv\n1,2\n').warnings.join(' '), /no date column/);
  assert.deepEqual(parseCsv('a,"b ""q"", c",d\r\n1,2,3'), [['a', 'b "q", c', 'd'], ['1', '2', '3']]);
});

test('health: Shortcuts parallel lists (newline text or arrays), per-field date lists', () => {
  const r = parse({ dates: '2026-09-24\n2026-09-25\n2026-09-25', steps: '8000\n9000\n1000', 'Resting Heart Rate': '56\n58\n60', weight: ['176.2', '', '176.8'] });
  assert.equal(r.format, 'lists');
  assert.deepEqual(r.days, [
    { date: '2026-09-24', steps: 8000, restingHr: 56, weightLb: 176.2 },
    { date: '2026-09-25', steps: 10000, restingHr: 59, weightLb: 176.8 },
  ]);
  const r2 = parse({ dates: ['Sep 24, 2026 at 12:00 AM', 'Sep 25, 2026 at 12:00 AM'], steps: [7000, 7100, 7200] });
  assert.deepEqual(r2.days, [{ date: '2026-09-24', steps: 7000 }, { date: '2026-09-25', steps: 7100 }]);
  assert.match(r2.warnings.join(' '), /steps: 3 values for 2 dates/);
  const r3 = parse({ steps: { dates: '2026-09-24\n2026-09-25', values: '100\n200', unit: 'count' }, weight: { dates: ['2026-09-25'], values: ['80'], unit: 'kg' } });
  assert.deepEqual(r3.days, [{ date: '2026-09-24', steps: 100 }, { date: '2026-09-25', steps: 200, weightLb: 176.4 }]);
  assert.match(parse({ steps: '1\n2' }).warnings.join(' '), /no dates list/);
});

test('health: bad input yields warnings, never throws', () => {
  assert.deepEqual(parse('').days, []);
  assert.match(parse('{"days": [').warnings[0], /could not be read/);
  assert.match(parse('   ').warnings[0], /Nothing to import/);
  assert.deepEqual(parse(42).days, []);
  assert.deepEqual(parse(null).days, []);
  assert.deepEqual(parse({ foo: 1 }).days, []);
  assert.equal(HEALTH_FIELDS.length, 10);
});

test('health: diff against stored records and apply (health upserts + body weigh-ins, idempotent)', async () => {
  const store = createStore({ owner: 'app' });
  store.upsert('health', '2026-09-24', { date: '2026-09-24', steps: 8000, restingHr: 56 });
  store.create('body', { date: '2026-09-25', at: '2026-09-25T07:00:00-04:00', weightLb: 177, method: 'scale' });
  const days = [
    { date: '2026-09-23', steps: 5000, weightLb: 176.2, bodyFatPct: 17.5 },
    { date: '2026-09-24', steps: 8000, restingHr: 56 },
    { date: '2026-09-25', steps: 9000, weightLb: 176.9 },
    { date: '2026-09-26', restingHr: 55 },
  ];
  store.upsert('health', '2026-09-26', { date: '2026-09-26', restingHr: 57, steps: 100 });
  const diff = diffHealthDays(days, (d) => store.get('health', d));
  assert.deepEqual(diff.map((d) => [d.date, d.status, d.changed]), [
    ['2026-09-23', 'new', ['steps', 'weightLb', 'bodyFatPct']],
    ['2026-09-24', 'same', []],
    ['2026-09-25', 'new', ['steps', 'weightLb']],
    ['2026-09-26', 'changed', ['restingHr']],
  ]);
  const res = applyHealthImport(store, days);
  assert.deepEqual(res, { days: 4, created: 2, updated: 1, unchanged: 1, weighIns: 1 });
  assert.equal(store.get('health', '2026-09-26').restingHr, 55);
  assert.equal(store.get('health', '2026-09-26').steps, 100, 'fields absent from the import are kept');
  const b23 = store.byDate('body', '2026-09-23');
  assert.equal(b23.length, 1);
  assert.equal(b23[0].method, 'health'); assert.equal(b23[0].weightLb, 176.2); assert.equal(b23[0].bodyFatPct, 17.5);
  assert.equal(store.byDate('body', '2026-09-25').length, 1, 'an existing scale weigh-in wins');
  // Re-import: nothing new; a corrected weight updates the same body record.
  const again = applyHealthImport(store, days);
  assert.deepEqual(again, { days: 4, created: 0, updated: 0, unchanged: 4, weighIns: 0 });
  const fixed = applyHealthImport(store, [{ date: '2026-09-23', weightLb: 176.6 }]);
  assert.equal(fixed.weighIns, 1);
  assert.equal(store.byDate('body', '2026-09-23').length, 1);
  assert.equal(store.byDate('body', '2026-09-23')[0].weightLb, 176.6);
});

test('health: a Shortcuts text template with line breaks inside JSON strings is accepted', () => {
  const raw = '{"steps":{"dates":"Sep 25, 2026 at 12:00 AM\nSep 26, 2026 at 12:00 AM","values":"8123\n9876"},"weight":{"dates":"Sep 26, 2026 at 7:02 AM","values":"168.4","unit":"lb"}}';
  const r = parseHealthExport(raw, { tz: 'America/New_York' });
  assert.deepEqual(r.days, [{ date: '2026-09-25', steps: 8123 }, { date: '2026-09-26', steps: 9876, weightLb: 168.4 }]);
});
