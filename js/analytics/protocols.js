// Protocol items (supplements, peptides, medications): due logic, stacks,
// adherence and dose-cycle views. Skipped doses never count as taken.
import { addDays, weekStart, dateRange, isNum, round } from '../core/util.js';
import { dowOf as dayOfWeek, daysBetween as diffDays } from './dataview.js';
import { mean } from './stats.js';

const dateOf = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const norm = (s) => String(s ?? '').trim().toLowerCase();

// Was the item in use on `date`? Inactive items without an end date are treated as not in use.
export function inWindow(item, date) {
  if (!item) return false;
  const s = dateOf(item.startedAt), e = dateOf(item.endedAt);
  if (s && date < s) return false;
  if (e && date > e) return false;
  if (item.active === false && !e) return false;
  return true;
}

// Active items plus stopped items that have an end date (their history still counts).
function allItems(dv) {
  return dv.memo('prot:items', () => dv.protocolItems({ includeInactive: true }).filter((i) => i.active !== false || dateOf(i.endedAt)));
}
function findItem(dv, item) {
  if (item && typeof item === 'object') return item;
  if (typeof item !== 'string') return null;
  return dv.store.get('protocolItems', item) || null;
}
const itemLabel = (item) => (item ? item.neutralLabel || item.name || item.id : null);

// Sorted unique dates with a taken (non-skipped) dose of the item.
export function doseDates(dv, itemId) {
  return dv.memo('prot:dates:' + itemId, () => {
    const s = new Set();
    for (const d of dv.dosesByItem().get(itemId) || []) if (!d.skipped && typeof d.date === 'string') s.add(d.date);
    return [...s].sort();
  });
}
// Index of the first element > date (upper bound).
function upper(arr, date) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= date) lo = m + 1; else hi = m; } return lo; }
function lower(arr, date) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < date) lo = m + 1; else hi = m; } return lo; }
export function takenOn(dv, itemId, date) { const a = doseDates(dv, itemId); const i = lower(a, date); return i < a.length && a[i] === date; }
function takenBetween(dv, itemId, from, to) { if (from > to) return 0; const a = doseDates(dv, itemId); return upper(a, to) - lower(a, from); }
// Most recent taken-dose date on or before `date`.
export function lastDoseOnOrBefore(dv, itemId, date) { const a = doseDates(dv, itemId); const i = upper(a, date); return i ? a[i - 1] : null; }

// Scheduled (due) on `date`: 'daily' every day; 'days' on listed weekdays (Mon=0);
// 'weekly' on listed weekdays, else once per Mon-start week (due until a dose is logged
// that week, including the day it is taken); 'asneeded' never.
export function isDue(dv, item, date) {
  if (!inWindow(item, date)) return false;
  const sch = item.schedule || {};
  const days = Array.isArray(sch.days) ? sch.days : [];
  switch (sch.type || 'daily') {
    case 'asneeded': return false;
    case 'days': return days.includes(dayOfWeek(date));
    case 'weekly': {
      if (days.length) return days.includes(dayOfWeek(date));
      const ws = weekStart(date);
      return date === ws || takenBetween(dv, item.id, ws, addDays(date, -1)) === 0;
    }
    default: return true;
  }
}

export function dueItems(dv, date) {
  return dv.memo('prot:due:' + date, () => {
    const dayDoses = dv.doses(date);
    return allItems(dv).filter((i) => inWindow(i, date)).map((item) => {
      const doses = dayDoses.filter((d) => d.itemId === item.id);
      return { item, due: isDue(dv, item, date), doses, taken: doses.some((d) => !d.skipped) };
    });
  });
}

// Items of a stack due on `date`; complete = all taken (null when nothing is due).
export function stackStatus(dv, date, stack) {
  const list = dueItems(dv, date).filter((x) => x.due && norm(x.item.schedule && x.item.schedule.stack) === norm(stack));
  return { stack, items: list.map((x) => ({ item: x.item, taken: x.taken })), complete: list.length ? list.every((x) => x.taken) : null };
}

// Per item over [from, to] (future days excluded; today counts only once taken).
// Once-a-week items count weeks: complete weeks, or any week with a dose.
export function adherence(dv, from, to) {
  const today = dv.asOf(); const end = to > today ? today : to;
  const out = [];
  if (from > end) return out;
  for (const item of allItems(dv)) {
    const s = dateOf(item.startedAt), e = dateOf(item.endedAt);
    if ((s && s > end) || (e && e < from)) continue;
    const sch = item.schedule || {};
    const type = sch.type || 'daily';
    let scheduled = 0, taken = 0;
    if (type === 'asneeded') {
      out.push({ item, scheduled: 0, taken: takenBetween(dv, item.id, from, end), rate: null });
      continue;
    }
    if (type === 'weekly' && !(Array.isArray(sch.days) && sch.days.length)) {
      for (let ws = weekStart(from); ws <= end; ws = addDays(ws, 7)) {
        const we = addDays(ws, 6);
        const a = ws < from ? from : ws, b = we > end ? end : we;
        if (!inWindow(item, a) && !inWindow(item, b)) continue;
        const got = takenBetween(dv, item.id, a, b) > 0;
        if (got || (we < today && we <= end)) { scheduled++; if (got) taken++; }
      }
    } else {
      for (const d of dateRange(from, end)) {
        if (!isDue(dv, item, d)) continue;
        const got = takenOn(dv, item.id, d);
        if (d === today && !got) continue;
        scheduled++; if (got) taken++;
      }
    }
    out.push({ item, scheduled, taken, rate: scheduled ? round((taken / scheduled) * 100, 1) : null });
  }
  return out;
}

// Next date (from `today`, inclusive) the item is due and not yet taken.
export function nextDue(dv, item, today = dv.asOf()) {
  const it = findItem(dv, item);
  if (!it || (it.schedule && it.schedule.type === 'asneeded')) return null;
  const e = dateOf(it.endedAt);
  for (let i = 0; i < 70; i++) {
    const d = addDays(today, i);
    if (e && d > e) return null;
    if (isDue(dv, it, d) && !takenOn(dv, it.id, d)) return d;
  }
  return null;
}

/* ------------------------------------------------ helpers used by daily rows */
const MG_PER = { mg: 1, mcg: 0.001, 'µg': 0.001, ug: 0.001, g: 1000 };
export function toMg(amount, unit) { const f = MG_PER[norm(unit)]; return isNum(amount) && f ? amount * f : null; }

const itemsOfKind = (dv, kind) => allItems(dv).filter((i) => i.kind === kind);

// Days since the last taken dose of any peptide item in use on `date` (0 = dosed that day).
export function daysSinceDose(dv, date, kind = 'peptide') {
  let best = null;
  for (const item of itemsOfKind(dv, kind)) {
    if (!inWindow(item, date)) continue;
    const last = lastDoseOnOrBefore(dv, item.id, date);
    if (last) { const d = diffDays(last, date); if (best == null || d < best) best = d; }
  }
  return best;
}
// Sum of taken peptide doses that day in mg (0 when items exist but none taken; null without items).
export function doseMgOn(dv, date, kind = 'peptide') {
  const items = itemsOfKind(dv, kind).filter((i) => inWindow(i, date));
  if (!items.length) return null;
  const ids = new Set(items.map((i) => i.id));
  let total = 0, unknownUnit = false, any = false;
  for (const d of dv.doses(date)) {
    if (!ids.has(d.itemId) || d.skipped) continue;
    any = true;
    const item = items.find((i) => i.id === d.itemId);
    const mg = toMg(isNum(d.amount) ? d.amount : item.amount, d.unit || item.unit);
    if (mg == null) unknownUnit = true; else total += mg;
  }
  if (any && unknownUnit && total === 0) return null;
  return round(total, 3);
}
// % of due items of a kind taken that day (null when none due).
export function kindAdherenceOn(dv, date, kind = 'supplement') {
  const due = dueItems(dv, date).filter((x) => x.due && x.item.kind === kind);
  if (!due.length) return null;
  return round((due.filter((x) => x.taken).length / due.length) * 100, 1);
}

/* ------------------------------------------------------------ dose cycle */
// Same-day metrics grouped by days since the last dose of THIS item (0..6).
// Metric definitions match DailyRow (intake only on complete past days).
export function doseCycle(dv, itemId, { from, to } = {}) {
  const item = findItem(dv, itemId) || (dv.store.getAny ? dv.store.getAny('protocolItems', itemId) : null);
  const id = item ? item.id : itemId;
  const today = dv.asOf();
  const end = to || today; const start = from || addDays(end, -89);
  const KEYS = ['appetite', 'kcalIn', 'proteinG', 'hrv', 'rhr', 'recovery', 'sleepMin'];
  const groups = Array.from({ length: 7 }, () => ({ n: 0, v: Object.fromEntries(KEYS.map((k) => [k, []])) }));
  for (const d of dateRange(start, end)) {
    const last = lastDoseOnOrBefore(dv, id, d);
    if (!last) continue;
    const ds = diffDays(last, d);
    if (ds > 6) continue;
    const g = groups[ds]; g.n++;
    const day = dv.day(d), rec = dv.recovery(d), sl = dv.sleep(d);
    const it = d < today ? dv.intake(d) : null;
    const vals = {
      appetite: day ? day.appetite : null,
      kcalIn: it && it.complete ? it.totals.kcal : null,
      proteinG: it && it.complete ? it.totals.protein : null,
      hrv: rec ? rec.hrv : null, rhr: rec ? rec.rhr : null, recovery: rec ? rec.recovery : null,
      sleepMin: sl ? sl.asleepMin : null,
    };
    for (const k of KEYS) if (isNum(vals[k])) g.v[k].push(vals[k]);
  }
  const dp = { appetite: 1, kcalIn: 0, proteinG: 0, hrv: 1, rhr: 1, recovery: 0, sleepMin: 0 };
  const byDay = groups.map((g, daysSince) => {
    const row = { daysSince, n: g.n };
    for (const k of KEYS) row[k] = round(mean(g.v[k]), dp[k]);
    return row;
  });
  // Weekly totals (Mon-start weeks) in the item's unit.
  const unit = (item && item.unit) || null;
  const doses = (dv.dosesByItem().get(id) || []).filter((d) => !d.skipped && d.date >= start && d.date <= end);
  const weeks = new Map();
  for (let ws = weekStart(start); ws <= end; ws = addDays(ws, 7)) weeks.set(ws, 0);
  for (const d of doses) {
    const u = d.unit || unit; let amt = isNum(d.amount) ? d.amount : item && item.amount;
    if (!isNum(amt)) continue;
    if (unit && u && norm(u) !== norm(unit)) {
      // Convert between mass units (mcg ↔ mg ↔ g); other unit mismatches cannot be summed.
      const mg = toMg(amt, u); const perUnit = toMg(1, unit);
      if (mg == null || !perUnit) continue;
      amt = mg / perUnit;
    }
    const ws = weekStart(d.date); weeks.set(ws, (weeks.get(ws) || 0) + amt);
  }
  const target = item && item.weeklyTarget && isNum(item.weeklyTarget.amount) ? item.weeklyTarget.amount : null;
  const weeklyTotals = [...weeks.entries()].map(([week, amount]) => ({ week, amount: round(amount, 3), unit, target }));
  const all = (dv.dosesByItem().get(id) || []).filter((d) => !d.skipped && typeof d.date === 'string' && d.date <= end);
  const ld = all.length ? all[all.length - 1] : null;
  return {
    item: item ? { id: item.id, label: itemLabel(item), kind: item.kind || null } : null,
    from: start, to: end, byDay, weeklyTotals,
    lastDose: ld ? { date: ld.date, at: ld.at || null, amount: isNum(ld.amount) ? ld.amount : null, unit: ld.unit || unit } : null,
    nextDue: item ? nextDue(dv, item, today) : null,
    n: groups.reduce((s, g) => s + g.n, 0),
  };
}
