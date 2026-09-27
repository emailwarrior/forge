// Protocols UI logic (pure): vocabularies, schedule text, amounts, unit conversion, weekly totals,
// injection-site rotation, stack grouping, item editor validation/payload.
// Tests: tests/ui/records-protocols.test.mjs. FORGE records what is taken; nothing here suggests doses.
import { isNum, fmtTime, weekStart, addDays, hmToMin } from '../../core/util.js';
import { fmtQty } from './records-util.js';

export const KINDS = [
  { value: 'supplement', label: 'Supplement', plural: 'Supplements' },
  { value: 'peptide', label: 'Peptide', plural: 'Peptides' },
  { value: 'medication', label: 'Medication', plural: 'Medications' },
];
export const kindLabel = (k) => (KINDS.find((x) => x.value === k) || { label: 'Item' }).label;
export const UNITS = ['mg', 'mcg', 'g', 'IU', 'ml', 'units', 'capsule', 'tablet', 'scoop', 'drop'];
export const FORMS = ['capsule', 'tablet', 'powder', 'liquid', 'injection', 'other'];
export const SCHEDULE_TYPES = [
  { value: 'daily', label: 'Daily' }, { value: 'days', label: 'Days' },
  { value: 'weekly', label: 'Weekly' }, { value: 'asneeded', label: 'As needed' },
];
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const SITES = ['Abdomen L', 'Abdomen R', 'Thigh L', 'Thigh R', 'Glute L', 'Glute R', 'Arm L', 'Arm R'];
export const NEUTRAL_DEFAULT = 'Protocol';

const COUNT_UNITS = new Set(['capsule', 'tablet', 'scoop', 'drop']);
const MASS = { mcg: 0.001, 'µg': 0.001, ug: 0.001, mg: 1, g: 1000 };
const normUnit = (u) => { const s = String(u ?? '').trim().toLowerCase(); return s === 'unit' ? 'units' : s; };
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const formLabel = (f) => cap(String(f || ''));

/** Neutral label used outside the app (notifications, calendar): "Protocol" for peptides and medications. */
export const defaultNeutralLabel = (kind) => (kind === 'peptide' || kind === 'medication' ? NEUTRAL_DEFAULT : '');

/** Unit shown next to an amount: count units pluralize ("2 capsules"), "1 unit". */
export function unitLabel(unit, amount) {
  const u = String(unit ?? '').trim();
  const l = u.toLowerCase();
  if (COUNT_UNITS.has(l)) return amount === 1 ? l : l + 's';
  if (l === 'units' && amount === 1) return 'unit';
  return u;
}
/** "5,000 IU", "2 capsules", "0.25 mg"; '' when the amount is unknown. */
export function amountText(amount, unit) {
  if (!isNum(amount)) return '';
  const u = unitLabel(unit, amount);
  return u ? `${fmtQty(amount)} ${u}` : fmtQty(amount);
}

/** Weekday list (Mon=0) → "Mon & Thu", "Mon, Wed & Fri", "Weekdays", "Every day"; '' when empty. */
export function daysText(days) {
  const d = [...new Set((Array.isArray(days) ? days : []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b);
  if (!d.length) return '';
  if (d.length === 7) return 'Every day';
  if (d.join() === '0,1,2,3,4') return 'Weekdays';
  if (d.join() === '5,6') return 'Weekends';
  const names = d.map((i) => DAY_NAMES[i]);
  return names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
}

/** Valid, unique, sorted 'HH:MM' list. */
export function normTimes(times) {
  return [...new Set((Array.isArray(times) ? times : []).map((t) => String(t || '').trim())
    .filter((t) => /^\d{2}:\d{2}$/.test(t) && hmToMin(t) < 1440))].sort();
}

/** Schedule → "Daily · AM", "Mon & Thu · 7:00 AM", "Weekly · Sun", "Once a week", "As needed". */
export function scheduleText(schedule) {
  const s = schedule || {};
  const type = s.type || 'daily';
  if (type === 'asneeded') return 'As needed';
  const days = daysText(s.days);
  const parts = [type === 'daily' ? 'Daily' : type === 'days' ? (days || 'No days set') : days ? `Weekly · ${days}` : 'Once a week'];
  const stack = String(s.stack || '').trim();
  if (stack) parts.push(stack);
  const times = normTimes(s.times);
  if (times.length) parts.push(times.map((t) => fmtTime(t)).join(', '));
  return parts.join(' · ');
}

/** Convert between mass units (mcg/mg/g); same unit passes through; anything else → null. */
export function convertAmount(amount, from, to) {
  if (!isNum(amount)) return null;
  const f = normUnit(from), t = normUnit(to);
  if (f === t) return amount;
  if (MASS[f] && MASS[t]) return r6((amount * MASS[f]) / MASS[t]);
  return null;
}

const whenMs = (d) => { const t = Date.parse(d.at || ''); return isNum(t) ? t : Date.parse((d.date || '1970-01-01') + 'T12:00:00Z'); };
const byWhen = (a, b) => whenMs(a) - whenMs(b);

/**
 * Taken total of one item in the Mon–Sun week containing `date`, expressed in `unit` (mass units convert).
 * Skipped and deleted doses never count; `excludeId` leaves out the dose being edited.
 * → { from, to, total, count, unconverted }
 */
export function weekTotal(doses, { itemId, date, unit, fallbackUnit, fallbackAmount, excludeId } = {}) {
  const from = weekStart(date), to = addDays(from, 6);
  let total = 0, count = 0, unconverted = 0;
  for (const d of doses || []) {
    if (!d || d.itemId !== itemId || d.skipped || d._d || (excludeId && d.id === excludeId)) continue;
    if (typeof d.date !== 'string' || d.date < from || d.date > to) continue;
    const amt = isNum(d.amount) ? d.amount : fallbackAmount;
    const v = convertAmount(amt, d.unit || fallbackUnit, unit);
    if (v == null) { unconverted++; continue; }
    total += v; count++;
  }
  return { from, to, total: r6(total), count, unconverted };
}

/** Latest taken (non-skipped) dose, or null. */
export function lastTakenDose(doses) {
  const list = (doses || []).filter((d) => d && !d.skipped && !d._d);
  return list.length ? list.slice().sort(byWhen)[list.length - 1] : null;
}
/** Site of the latest taken dose that recorded one. */
export function lastSite(doses) {
  const list = (doses || []).filter((d) => d && !d.skipped && !d._d && d.site).sort(byWhen);
  return list.length ? list[list.length - 1].site : null;
}
/** Next site in the rotation after `last` (the first site when unknown). */
export function nextSite(last) {
  const i = SITES.findIndex((s) => s.toLowerCase() === String(last ?? '').trim().toLowerCase());
  return SITES[(i + 1) % SITES.length];
}
/** Per-site use counts and last date (rotation order first, then any other recorded sites). */
export function siteHistory(doses, { since } = {}) {
  const map = new Map(SITES.map((s) => [s.toLowerCase(), { site: s, count: 0, last: null }]));
  for (const d of doses || []) {
    if (!d || d.skipped || d._d || !d.site || (since && d.date < since)) continue;
    const k = String(d.site).trim().toLowerCase();
    if (!map.has(k)) map.set(k, { site: String(d.site).trim(), count: 0, last: null });
    const e = map.get(k); e.count++;
    if (!e.last || d.date > e.last) e.last = d.date;
  }
  return [...map.values()];
}

/** Case-insensitive stack comparison key. */
export const stackKey = (s) => String(s ?? '').trim().toLowerCase();
/** "AM" → "AM stack"; names already ending in "stack" are kept ("Morning stack"). */
export function stackTitle(s) {
  const t = String(s ?? '').trim();
  if (!t) return 'Other scheduled';
  return /\bstack$/i.test(t) ? t : `${t} stack`;
}
/** Stack names used by active items: AM, PM, then others alphabetically (first-seen spelling). */
export function stackNames(items) {
  const seen = new Map();
  for (const it of items || []) {
    if (!it || it.active === false) continue;
    const s = String((it.schedule && it.schedule.stack) || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (!seen.has(k)) seen.set(k, s);
  }
  const rank = (k) => (k === 'am' ? 0 : k === 'pm' ? 1 : 2);
  return [...seen.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([, v]) => v);
}

const firstTime = (it) => normTimes(it && it.schedule && it.schedule.times)[0] || '99:99';
/**
 * Today panel groups from analytics dueItems(): items due or taken on the date, grouped by stack
 * (AM, PM, custom, then items without a stack as `stack: null`). → [{ stack, rows:[{item, due, taken, doses}], taken, total }]
 */
export function todayGroups(due) {
  const rows = (due || []).filter((x) => x && (x.due || x.taken));
  const names = stackNames(rows.map((x) => ({ ...x.item, active: true })));
  const groups = names.map((stack) => ({ stack, rows: [] }));
  const other = { stack: null, rows: [] };
  for (const x of rows) {
    const k = stackKey(x.item.schedule && x.item.schedule.stack);
    const g = k ? groups.find((gg) => stackKey(gg.stack) === k) : null;
    (g || other).rows.push(x);
  }
  const out = other.rows.length ? [...groups, other] : groups;
  for (const g of out) {
    g.rows.sort((a, b) => firstTime(a.item).localeCompare(firstTime(b.item)) || String(a.item.name || '').localeCompare(String(b.item.name || '')));
    g.total = g.rows.filter((r) => r.due).length;
    g.taken = g.rows.filter((r) => r.due && r.taken).length;
  }
  return out;
}

/** Default dose time: now for today; else the earliest scheduled time; else a stack-based guess. */
export function defaultDoseTime({ date, today, nowHm, items = [], stack } = {}) {
  if (date === today && nowHm) return nowHm;
  const times = items.flatMap((it) => normTimes(it && it.schedule && it.schedule.times)).sort();
  if (times.length) return times[0];
  return stackKey(stack) === 'pm' ? '21:00' : '08:00';
}

/* ------------------------------------------------------------- editor */
export function emptyItem({ kind = 'supplement', today = null } = {}) {
  return {
    name: '', kind, amount: null, unit: 'mg', form: kind === 'peptide' ? 'injection' : 'capsule',
    schedule: { type: 'daily', days: [], times: [], stack: '' },
    weeklyTarget: null, neutralLabel: defaultNeutralLabel(kind),
    startedAt: today, endedAt: null, note: '', active: true,
  };
}
/** Editor draft from a stored item (never mutates it). */
export function draftFromItem(item) {
  const s = item.schedule || {};
  return {
    name: item.name || '', kind: item.kind || 'supplement', amount: isNum(item.amount) ? item.amount : null,
    unit: item.unit || '', form: item.form || '',
    schedule: { type: s.type || 'daily', days: Array.isArray(s.days) ? [...s.days] : [], times: Array.isArray(s.times) ? [...s.times] : [], stack: s.stack || '' },
    weeklyTarget: item.weeklyTarget && isNum(item.weeklyTarget.amount) ? { amount: item.weeklyTarget.amount, unit: item.weeklyTarget.unit || item.unit || '' } : null,
    neutralLabel: item.neutralLabel || '', startedAt: item.startedAt ? String(item.startedAt).slice(0, 10) : null,
    endedAt: item.endedAt ? String(item.endedAt).slice(0, 10) : null, note: item.note || '', active: item.active !== false,
  };
}
/** Field errors for an editor draft ({} when valid). */
export function validateItem(d) {
  const e = {};
  if (!String(d.name || '').trim()) e.name = 'Name the item.';
  if (d.amount != null && !(isNum(d.amount) && d.amount > 0)) e.amount = 'Amount must be a positive number.';
  const type = (d.schedule && d.schedule.type) || 'daily';
  const days = (d.schedule && d.schedule.days) || [];
  if (type === 'days' && !days.length) e.days = 'Pick at least one day.';
  if (d.weeklyTarget && !(isNum(d.weeklyTarget.amount) && d.weeklyTarget.amount > 0)) e.weeklyTarget = 'Enter the weekly total.';
  if (d.startedAt && d.endedAt && d.endedAt < d.startedAt) e.endedAt = 'Ends before it starts.';
  return e;
}
/** Record fields for protocolItems from a (valid) draft. */
export function itemPayload(d) {
  const type = (d.schedule && d.schedule.type) || 'daily';
  const days = [...new Set(((d.schedule && d.schedule.days) || []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b);
  const stack = String((d.schedule && d.schedule.stack) || '').trim();
  const wt = d.weeklyTarget && isNum(d.weeklyTarget.amount) && d.weeklyTarget.amount > 0 ? { amount: d.weeklyTarget.amount, unit: d.weeklyTarget.unit || d.unit || null } : null;
  return {
    name: String(d.name || '').trim(), kind: d.kind || 'supplement',
    amount: isNum(d.amount) ? d.amount : null, unit: d.unit || null, form: d.form || null,
    schedule: {
      type, days: type === 'days' || type === 'weekly' ? days : [],
      times: type === 'asneeded' ? [] : normTimes(d.schedule && d.schedule.times),
      stack: type === 'asneeded' ? null : stack || null,
    },
    weeklyTarget: wt, neutralLabel: String(d.neutralLabel || '').trim() || null,
    startedAt: d.startedAt || null, endedAt: d.endedAt || null,
    note: String(d.note || '').trim() || null, active: d.active !== false,
  };
}
