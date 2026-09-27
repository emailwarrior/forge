// Apple Health import (#/import/health): turns what an iOS Shortcut exports into daily `health` records.
// Pure parsing (Node-testable) + a small store writer. Tests: tests/app/health-import.test.mjs
//
// CONTRACT — parseHealthExport(input, { tz }) → { days: [{ date, ...fields }], warnings: [string], format }
//   input: text (JSON or CSV) or an already-parsed value. Fields (ARCHITECTURE §5 `health`):
//     steps, activeKcal, restingKcal, exerciseMin, standH, restingHr (bpm), hrvSdnn (ms), vo2max (ml/kg/min), weightLb, bodyFatPct.
//   Accepted shapes (format = 'days' | 'samples' | 'csv' | 'lists'):
//   1. { days: [{ date, steps, activeKcal, … }] } — also a bare array of day objects, a single day object, or
//      { days: { 'YYYY-MM-DD': { … } } }. One value per field and day; a repeated date overrides earlier fields.
//   2. { samples: [{ type, value, unit, start | date, end }] } — also a bare array. `type` is an Apple Health name
//      ("Steps", "Active Energy", "Resting Energy", "Exercise Minutes" / "Apple Exercise Time", "Stand Hours",
//      "Resting Heart Rate", "Heart Rate Variability", "VO2 Max", "Weight" / "Body Mass", "Body Fat Percentage"),
//      a HealthKit identifier (HKQuantityTypeIdentifierStepCount) or a field name. Grouped by the local date of `start`
//      (else `date`): sum for steps, active/resting energy, exercise minutes and stand hours; mean for resting heart
//      rate and HRV; the day's last value for VO2 max, weight and body fat.
//   3. CSV text with a header row: a `date` column plus field names or aliases; a unit in brackets is honored
//      ("Weight (kg)"). A CSV with `type` and `value` columns is read as samples.
//   4. Shortcuts parallel lists: { dates: "2026-09-25\n2026-09-26", steps: "8123\n9876", … } — newline-separated text
//      or arrays aligned by position with `dates`; repeated dates aggregate like samples. A field may carry its own
//      dates: { steps: { dates, values, unit } }.
//   Dates: YYYY-MM-DD, ISO date-times (a numeric offset keeps the recorded wall-clock date, Z converts to `tz`),
//     "Sep 25, 2026 at 7:31 AM", "25 Sep 2026", M/D/YYYY, or epoch milliseconds/seconds.
//   Units (by the sample's unit, a key suffix like weight_kg, or text in the value like "80.2 kg"): kg/g/st → lb, kJ → kcal,
//     s/h → min for exercise, s → ms for HRV, and a body-fat fraction (≤ 1, how HealthKit stores it) → percent.
//   Unknown fields are ignored (named once in warnings). Implausible values are dropped with a warning — see HEALTH_FIELDS.
import { localParts, isNum, isYmd, LB_PER_KG } from '../core/util.js';

/** Escape raw newlines/tabs/carriage returns that appear inside JSON string literals. */
export function escapeControlCharsInStrings(text) {
  let out = ''; let inStr = false; let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out;
}

export const HEALTH_FIELDS = [
  { key: 'steps', label: 'Steps', unit: '', agg: 'sum', dp: 0, min: 0, max: 100000 },
  { key: 'activeKcal', label: 'Active energy', unit: 'kcal', agg: 'sum', dp: 0, min: 0, max: 10000 },
  { key: 'restingKcal', label: 'Resting energy', unit: 'kcal', agg: 'sum', dp: 0, min: 0, max: 6000 },
  { key: 'exerciseMin', label: 'Exercise', unit: 'min', agg: 'sum', dp: 0, min: 0, max: 1440 },
  { key: 'standH', label: 'Stand', unit: 'h', agg: 'sum', dp: 0, min: 0, max: 24 },
  { key: 'restingHr', label: 'Resting HR', unit: 'bpm', agg: 'mean', dp: 1, min: 25, max: 150 },
  { key: 'hrvSdnn', label: 'HRV (SDNN)', unit: 'ms', agg: 'mean', dp: 1, min: 5, max: 300 },
  { key: 'vo2max', label: 'VO₂ max', unit: 'ml/kg/min', agg: 'last', dp: 1, min: 10, max: 100 },
  { key: 'weightLb', label: 'Weight', unit: 'lb', agg: 'last', dp: 1, min: 50, max: 700 },
  { key: 'bodyFatPct', label: 'Body fat', unit: '%', agg: 'last', dp: 1, min: 2, max: 70 },
];
export const HEALTH_KEYS = HEALTH_FIELDS.map((f) => f.key);
const DEF = Object.fromEntries(HEALTH_FIELDS.map((f) => [f.key, f]));

/* ------------------------------------------------------------ field names */
const ALIASES = {
  steps: ['steps', 'step', 'stepcount', 'stepscount', 'dailysteps'],
  activeKcal: ['activekcal', 'activeenergy', 'activeenergyburned', 'activecalories', 'activecal', 'activeenergykcal', 'moveenergy'],
  restingKcal: ['restingkcal', 'restingenergy', 'basalenergy', 'basalenergyburned', 'restingcalories', 'restingcal', 'basalcalories', 'restingenergykcal'],
  exerciseMin: ['exercisemin', 'exercisemins', 'exerciseminutes', 'exercise', 'exercisetime', 'appleexercisetime'],
  standH: ['standh', 'standhours', 'standhour', 'applestandhour', 'applestandhours', 'standhrs'],
  restingHr: ['restinghr', 'restingheartrate', 'rhr', 'restingbpm', 'restingpulse'],
  hrvSdnn: ['hrvsdnn', 'hrv', 'heartratevariability', 'heartratevariabilitysdnn', 'sdnn'],
  vo2max: ['vo2max', 'vo2', 'cardiofitness', 'vo2maximum'],
  weightLb: ['weightlb', 'weightlbs', 'weight', 'bodymass', 'bodyweight', 'mass'],
  bodyFatPct: ['bodyfatpct', 'bodyfatpercentage', 'bodyfat', 'bodyfatpercent', 'fatpercentage', 'bodyfatpc'],
};
const ALIAS = new Map();
for (const [key, list] of Object.entries(ALIASES)) for (const a of list) ALIAS.set(a, key);
const DATE_KEYS = new Set(['date', 'dates', 'day', 'days', 'start', 'starts', 'startdate', 'startdates', 'from', 'timestamp', 'time', 'datetime']);
const UNIT_SUFFIXES = [['kcal', 'kcal'], ['kj', 'kj'], ['kg', 'kg'], ['lbs', 'lb'], ['lb', 'lb'], ['pct', '%'], ['percent', '%'], ['ms', 'ms'], ['bpm', 'bpm'], ['mins', 'min'], ['min', 'min'], ['hours', 'h'], ['hrs', 'h']];

const normName = (s) => String(s == null ? '' : s).toLowerCase().replace(/^hk(?:quantity|category)typeidentifier/, '').replace(/[^a-z0-9]/g, '');

/** Field for a column/type name → { key, unit } | null. Units in brackets or as a suffix ("weight_kg") are returned. */
export function fieldFor(name) {
  let raw = String(name == null ? '' : name).trim();
  let unit = null;
  const br = /[([]\s*([^)\]]+?)\s*[)\]]\s*$/.exec(raw);
  if (br) { unit = br[1]; raw = raw.slice(0, br.index); }
  const n = normName(raw.replace(/^hk(?:quantity|category)typeidentifier/i, ''));
  if (!n) return null;
  if (ALIAS.has(n)) return { key: ALIAS.get(n), unit };
  for (const [suf, u] of UNIT_SUFFIXES) {
    if (n.length > suf.length && n.endsWith(suf) && ALIAS.has(n.slice(0, -suf.length))) return { key: ALIAS.get(n.slice(0, -suf.length)), unit: unit || u };
  }
  return null;
}
const isDateKey = (k) => DATE_KEYS.has(normName(k));

/* ----------------------------------------------------------------- values */
/** Number from a number or text ("8,123", "80.2 kg", "72,5"); { value, unit } with any trailing unit text. */
export function parseNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? { value: v, unit: null } : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[   ]/g, ' ').trim();
  const m = /^([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:[.,]\d+)?)\s*([^\d\s].*)?$/.exec(s);
  if (!m) return null;
  let t = m[1];
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^[-+]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  const n = Number(t);
  return isFinite(n) ? { value: n, unit: m[2] ? m[2].trim() : null } : null;
}

function normUnit(u) {
  const s = String(u == null ? '' : u).trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return '';
  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(s)) return 'kg';
  if (['lb', 'lbs', 'pound', 'pounds', '#'].includes(s)) return 'lb';
  if (['g', 'gram', 'grams'].includes(s)) return 'g';
  if (['st', 'stone', 'stones'].includes(s)) return 'st';
  if (['kj', 'kilojoule', 'kilojoules'].includes(s)) return 'kj';
  if (['kcal', 'cal', 'cals', 'calorie', 'calories', 'kilocalorie', 'kilocalories'].includes(s)) return 'kcal';
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(s)) return 's';
  if (['min', 'mins', 'minute', 'minutes'].includes(s)) return 'min';
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(s)) return 'h';
  if (['ms', 'millisecond', 'milliseconds'].includes(s)) return 'ms';
  if (['%', 'pct', 'percent'].includes(s)) return '%';
  return s;
}

/** Convert a value in `unit` to the field's canonical unit. */
export function convertUnit(key, value, unit) {
  const u = normUnit(unit);
  switch (key) {
    case 'weightLb': return u === 'kg' ? value * LB_PER_KG : u === 'g' ? (value / 1000) * LB_PER_KG : u === 'st' ? value * 14 : value;
    case 'activeKcal': case 'restingKcal': return u === 'kj' ? value / 4.184 : value;
    case 'exerciseMin': return u === 's' ? value / 60 : u === 'h' ? value * 60 : value;
    case 'standH': return u === 'min' ? value / 60 : value;
    case 'hrvSdnn': return u === 's' ? value * 1000 : value;
    case 'bodyFatPct': return value > 0 && value <= 1 ? value * 100 : value;
    default: return value;
  }
}

/* ------------------------------------------------------------------ dates */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function mk(y, mo, d, h, mi, ap) {
  if (y < 100) y += 2000;
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= dim(y, mo)) || y < 1990 || y > 2100) return null;
  let hour = h == null ? null : Number(h);
  if (hour != null && ap) { const pm = /^p/i.test(ap); if (hour >= 1 && hour <= 12) hour = (hour % 12) + (pm ? 12 : 0); }
  if (hour != null && (hour > 23 || Number(mi) > 59)) return null;
  return { ymd: `${y}-${pad(mo)}-${pad(d)}`, min: hour == null ? null : hour * 60 + Number(mi) };
}
const monthIdx = (s) => { const i = MONTHS.indexOf(String(s).slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; };
const TIME = '(?:,?\\s+(?:at\\s+)?(\\d{1,2})[:.](\\d{2})(?:[:.]\\d{2}(?:\\.\\d+)?)?\\s*([ap]\\.?m\\.?)?)?';
const RE_ISO = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?$/i;
const RE_US = new RegExp('^(\\d{1,2})/(\\d{1,2})/(\\d{2}|\\d{4})' + TIME + '\\s*$', 'i');
const RE_MDY = new RegExp('^(?:[a-z]+\\.?,?\\s+)??([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})' + TIME + '\\s*$', 'i');
const RE_DMY = new RegExp('^(?:[a-z]+\\.?,?\\s+)?(\\d{1,2})\\.?\\s+([a-z]{3,9})\\.?,?\\s+(\\d{4})' + TIME + '\\s*$', 'i');

/** Local { ymd, min|null } of a date value (see the contract above); null when unreadable. */
export function parseHealthDate(v, tz) {
  if (typeof v === 'number' && isFinite(v)) {
    const ms = v > 1e11 ? v : v > 1e8 ? v * 1000 : null;
    if (ms == null) return null;
    const p = localParts(ms, tz);
    return { ymd: p.ymd, min: p.min };
  }
  if (typeof v !== 'string') return null;
  const s = v.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) return parseHealthDate(Number(s), tz);
  let m = RE_ISO.exec(s);
  if (m) {
    const off = m[7] ? m[7].toUpperCase() : '';
    if (m[4] != null && (off === 'Z' || off === 'UTC' || off === 'GMT')) {
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      if (!isFinite(ms)) return null;
      const p = localParts(ms, tz);
      return mk(+m[1], +m[2], +m[3]) ? { ymd: p.ymd, min: p.min } : null;
    }
    return mk(+m[1], +m[2], +m[3], m[4], m[5]);
  }
  if ((m = RE_US.exec(s))) return mk(+m[3], +m[1], +m[2], m[4], m[5], m[6]) || (+m[1] > 12 ? mk(+m[3], +m[2], +m[1], m[4], m[5], m[6]) : null);
  if ((m = RE_MDY.exec(s)) && monthIdx(m[1])) return mk(+m[3], monthIdx(m[1]), +m[2], m[4], m[5], m[6]);
  if ((m = RE_DMY.exec(s)) && monthIdx(m[2])) return mk(+m[3], monthIdx(m[2]), +m[1], m[4], m[5], m[6]);
  return null;
}

/* ------------------------------------------------------------------ parse */
function warnBag() {
  const unknown = new Set(); const dropped = new Map(); const other = [];
  let badDates = 0;
  return {
    unknown(name) { if (name != null && String(name).trim()) unknown.add(String(name).trim()); },
    drop(key, value, ymd) {
      if (!dropped.has(key)) dropped.set(key, { n: 0, dates: [] });
      const d = dropped.get(key); d.n++; if (d.dates.length < 3 && ymd && !d.dates.includes(ymd)) d.dates.push(ymd);
    },
    badDate() { badDates++; },
    add(msg) { if (!other.includes(msg)) other.push(msg); },
    list() {
      const out = [...other];
      if (badDates) out.push(`Skipped ${badDates} ${badDates === 1 ? 'entry' : 'entries'} without a readable date.`);
      for (const [key, d] of dropped) {
        const f = DEF[key];
        out.push(`${f.label}: dropped ${d.n} implausible value${d.n === 1 ? '' : 's'} (outside ${f.min}–${f.max.toLocaleString('en-US')}${f.unit ? ' ' + f.unit : ''})${d.dates.length ? ' on ' + d.dates.join(', ') + (d.n > d.dates.length ? '…' : '') : ''}.`);
      }
      if (unknown.size) { const names = [...unknown]; out.push(`Ignored unknown field${names.length === 1 ? '' : 's'}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}.`); }
      return out;
    },
  };
}

// One value → canonical number or null (unit from the sample, the key, or the value text).
function readValue(key, raw, unit) {
  const p = parseNumber(raw);
  if (!p) return null;
  return convertUnit(key, p.value, unit || p.unit);
}

const inRange = (key, v) => v >= DEF[key].min && v <= DEF[key].max;
const roundField = (key, v) => { const f = 10 ** DEF[key].dp; return Math.round(v * f) / f; };

// Aggregate normalized samples [{ key, value, ymd, t, i }] per date.
function aggregate(samples, warn) {
  const byDay = new Map();
  for (const s of samples) {
    if (DEF[s.key].agg !== 'sum' && !inRange(s.key, s.value)) { warn.drop(s.key, s.value, s.ymd); continue; }
    if (DEF[s.key].agg === 'sum' && s.value < 0) { warn.drop(s.key, s.value, s.ymd); continue; }
    if (!byDay.has(s.ymd)) byDay.set(s.ymd, new Map());
    const f = byDay.get(s.ymd);
    if (!f.has(s.key)) f.set(s.key, []);
    f.get(s.key).push(s);
  }
  const days = [];
  for (const [ymd, fields] of byDay) {
    const day = { date: ymd };
    for (const [key, list] of fields) {
      const agg = DEF[key].agg;
      let v;
      if (agg === 'sum') v = list.reduce((a, s) => a + s.value, 0);
      else if (agg === 'mean') v = list.reduce((a, s) => a + s.value, 0) / list.length;
      else v = [...list].sort((a, b) => (a.t ?? -1) - (b.t ?? -1) || a.i - b.i).pop().value;
      if (agg === 'sum' && !inRange(key, v)) { warn.drop(key, v, ymd); continue; }
      day[key] = roundField(key, v);
    }
    if (Object.keys(day).length > 1) days.push(day);
  }
  return days;
}

// Days semantics: one value per field and date; later rows override earlier ones.
function collectDays(rows, warn) {
  const byDay = new Map();
  for (const { ymd, key, value } of rows) {
    if (!inRange(key, value)) { warn.drop(key, value, ymd); continue; }
    if (!byDay.has(ymd)) byDay.set(ymd, { date: ymd });
    byDay.get(ymd)[key] = roundField(key, value);
  }
  return [...byDay.values()].filter((d) => Object.keys(d).length > 1);
}

function fromDayObjects(list, tz, warn) {
  const rows = [];
  list.forEach((obj, idx) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const dateKey = Object.keys(obj).find(isDateKey);
    const when = dateKey ? parseHealthDate(obj[dateKey], tz) : null;
    if (!when) { warn.badDate(); return; }
    for (const [k, raw] of Object.entries(obj)) {
      if (k === dateKey || raw == null || raw === '') continue;
      const f = fieldFor(k);
      if (!f) { warn.unknown(k); continue; }
      const value = readValue(f.key, raw, f.unit);
      if (value == null) continue;
      rows.push({ ymd: when.ymd, key: f.key, value, i: idx });
    }
  });
  return collectDays(rows, warn);
}

function fromSamples(list, tz, warn) {
  const out = [];
  list.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const typeName = s.type ?? s.name ?? s.key ?? s.identifier ?? s.dataType ?? s.metric ?? s.quantityType;
    const f = fieldFor(typeName);
    if (!f) { warn.unknown(typeName); return; }
    const when = parseHealthDate(s.start ?? s.startDate ?? s.date ?? s.from ?? s.timestamp ?? s.time ?? s.end ?? s.endDate, tz);
    if (!when) { warn.badDate(); return; }
    const value = readValue(f.key, s.value ?? s.qty ?? s.quantity ?? s.amount ?? s.count, s.unit ?? s.units ?? f.unit);
    if (value == null) return;
    out.push({ key: f.key, value, ymd: when.ymd, t: when.min, i });
  });
  return aggregate(out, warn);
}

const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/).map((x) => x.trim()) : v == null ? [] : [v]);

function fromLists(obj, tz, warn) {
  const dateKey = Object.keys(obj).find((k) => isDateKey(k) && !isPlainObject(obj[k]));
  const dates = dateKey ? asList(obj[dateKey]).map((d) => (d === '' ? null : parseHealthDate(d, tz))) : [];
  const samples = [];
  let i = 0;
  for (const [k, raw] of Object.entries(obj)) {
    if (k === dateKey) continue;
    const f = fieldFor(k);
    if (!f) { warn.unknown(k); continue; }
    if (isPlainObject(raw)) { // { dates, values, unit } for this field
      const dk = Object.keys(raw).find(isDateKey);
      const vk = Object.keys(raw).find((x) => /^(values?|qty|quantit(y|ies)|amounts?)$/i.test(x));
      if (!dk || !vk) { warn.add(`${k}: expected { dates, values }.`); continue; }
      const ds = asList(raw[dk]); const vs = asList(raw[vk]);
      if (ds.length !== vs.length) warn.add(`${k}: ${vs.length} values for ${ds.length} dates; unmatched entries skipped.`);
      for (let j = 0; j < Math.min(ds.length, vs.length); j++) {
        const when = parseHealthDate(ds[j], tz);
        if (!when) { if (String(ds[j] || '').trim()) warn.badDate(); continue; }
        const value = vs[j] === '' ? null : readValue(f.key, vs[j], raw.unit ?? raw.units ?? f.unit);
        if (value != null) samples.push({ key: f.key, value, ymd: when.ymd, t: when.min, i: i++ });
      }
      continue;
    }
    const vs = asList(raw);
    if (!dateKey) { warn.add(`${k}: no dates list to align with.`); continue; }
    if (vs.length !== dates.length) warn.add(`${k}: ${vs.length} values for ${dates.length} dates; unmatched entries skipped.`);
    for (let j = 0; j < Math.min(vs.length, dates.length); j++) {
      if (vs[j] === '' || vs[j] == null) continue;
      if (!dates[j]) { warn.badDate(); continue; }
      const value = readValue(f.key, vs[j], f.unit);
      if (value != null) samples.push({ key: f.key, value, ymd: dates[j].ymd, t: dates[j].min, i: i++ });
    }
  }
  return aggregate(samples, warn);
}

/* -------------------------------------------------------------------- CSV */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => { let n = 0, q = false; for (const c of firstLine) { if (c === '"') q = !q; else if (c === ch && !q) n++; } return n; };
  const delim = [',', ';', '\t'].map((d) => [d, count(d)]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

function fromCsv(text, tz, warn) {
  const rows = parseCsv(text);
  if (rows.length < 2) { warn.add('The CSV needs a header row and at least one data row.'); return { days: [], format: 'csv' }; }
  const head = rows[0];
  const norm = head.map(normName);
  if (norm.includes('type') && norm.includes('value')) {
    const objs = rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [normName(h) === 'type' ? 'type' : normName(h) === 'value' ? 'value' : normName(h) === 'unit' ? 'unit' : h, r[i]])));
    return { days: fromSamples(objs, tz, warn), format: 'csv' };
  }
  if (!head.some(isDateKey)) { warn.add('The CSV header has no date column.'); return { days: [], format: 'csv' }; }
  const objs = rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  return { days: fromDayObjects(objs, tz, warn), format: 'csv' };
}

/* ------------------------------------------------------------------- main */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const looksLikeSample = (o) => isPlainObject(o) && ('value' in o || 'qty' in o || 'quantity' in o) && ('type' in o || 'name' in o || 'identifier' in o || 'dataType' in o);

/** See the contract at the top of this file. */
export function parseHealthExport(input, { tz } = {}) {
  const warn = warnBag();
  let data = input; let format = null; let days = [];
  if (typeof data === 'string') {
    const text = data.replace(/^﻿/, '').trim();
    if (!text) return { days: [], warnings: ['Nothing to import.'], format: null };
    if (/^[[{]/.test(text)) {
      const t = text.replace(/[“”]/g, '"');
      try { data = JSON.parse(t); } catch (e) {
        // iOS Shortcuts joins list variables with real line breaks inside "…" strings: escape them and retry.
        try { data = JSON.parse(escapeControlCharsInStrings(t)); } catch { return { days: [], warnings: ['This looks like JSON but could not be read: ' + e.message], format: null }; }
      }
    } else {
      const r = fromCsv(text, tz, warn);
      return finish(r.days, r.format, warn);
    }
  }
  if (Array.isArray(data)) {
    if (data.some(looksLikeSample)) { format = 'samples'; days = fromSamples(data, tz, warn); }
    else { format = 'days'; days = fromDayObjects(data, tz, warn); }
  } else if (isPlainObject(data)) {
    const keys = Object.keys(data);
    const k = (name) => keys.find((x) => normName(x) === name);
    const samplesKey = k('samples') || k('data') || k('records');
    const daysKey = k('days');
    if (samplesKey && Array.isArray(data[samplesKey])) {
      format = 'samples'; days = fromSamples(data[samplesKey], tz, warn);
    } else if (daysKey && Array.isArray(data[daysKey]) && data[daysKey].some(isPlainObject)) {
      format = 'days'; days = fromDayObjects(data[daysKey], tz, warn);
    } else if (daysKey && isPlainObject(data[daysKey])) {
      format = 'days'; days = fromDayObjects(Object.entries(data[daysKey]).map(([d, v]) => ({ ...(isPlainObject(v) ? v : {}), date: d })), tz, warn);
    } else if (keys.every((x) => isYmd(x) || !fieldFor(x)) && keys.some((x) => isYmd(x) && isPlainObject(data[x]))) {
      format = 'days'; days = fromDayObjects(keys.filter(isYmd).map((d) => ({ ...(isPlainObject(data[d]) ? data[d] : {}), date: d })), tz, warn);
    } else {
      const multi = keys.some((x) => { const v = data[x]; return Array.isArray(v) || isPlainObject(v) || (typeof v === 'string' && /\n/.test(v)); });
      if (multi) { format = 'lists'; days = fromLists(data, tz, warn); } else { format = 'days'; days = fromDayObjects([data], tz, warn); }
    }
  } else {
    return { days: [], warnings: ['Nothing to import.'], format: null };
  }
  return finish(days, format, warn);
}

function finish(days, format, warn) {
  const sorted = days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const warnings = warn.list();
  if (!sorted.length) warnings.unshift('No health data found. Expected days, samples, a CSV with a date column, or date/value lists (see Accepted formats).');
  return { days: sorted, warnings, format };
}

/* ------------------------------------------------------------ preview/apply */
/** Compare parsed days with stored `health` records → [{ date, status: 'new'|'changed'|'same', changed: [key], day }]. */
export function diffHealthDays(days, getExisting) {
  return (days || []).map((day) => {
    const cur = getExisting(day.date);
    if (!cur) return { date: day.date, status: 'new', changed: HEALTH_KEYS.filter((k) => isNum(day[k])), day };
    const changed = HEALTH_KEYS.filter((k) => isNum(day[k]) && !(isNum(cur[k]) && roundField(k, cur[k]) === roundField(k, day[k])));
    return { date: day.date, status: changed.length ? 'changed' : 'same', changed, day };
  });
}

/**
 * Write parsed days: upsert `health` (id = date; only new or changed fields), and for days with a weight and no other
 * weigh-in that day, a `body` record { method: 'health' } (updated in place on re-import).
 * → { days, created, updated, unchanged, weighIns }
 */
export function applyHealthImport(store, days) {
  const out = { days: 0, created: 0, updated: 0, unchanged: 0, weighIns: 0 };
  for (const d of diffHealthDays(days, (date) => store.get('health', date))) {
    out.days++;
    if (d.status === 'same') out.unchanged++;
    else {
      const patch = { date: d.date };
      for (const k of d.changed) patch[k] = d.day[k];
      store.upsert('health', d.date, patch);
      if (d.status === 'new') out.created++; else out.updated++;
    }
    if (isNum(d.day.weightLb)) {
      const onDay = store.byDate('body', d.date);
      const mine = onDay.find((b) => b.method === 'health');
      const others = onDay.filter((b) => b !== mine && isNum(b.weightLb));
      if (others.length) continue;
      const fields = { weightLb: d.day.weightLb };
      if (isNum(d.day.bodyFatPct)) fields.bodyFatPct = d.day.bodyFatPct;
      if (!mine) { store.create('body', { date: d.date, at: null, ...fields, method: 'health' }); out.weighIns++; }
      else if (mine.weightLb !== fields.weightLb || (fields.bodyFatPct != null && mine.bodyFatPct !== fields.bodyFatPct)) { store.update('body', mine.id, fields); out.weighIns++; }
    }
  }
  return out;
}
