// Standards: evaluation per day (manual checks override auto sources), day score,
// perfect-day streaks and per-standard adherence. See docs/ARCHITECTURE.md §8.
import { dateRange, hmToMin, minToHm, isNum, round } from '../core/util.js';
import { formatNumber as fmtNum, dowOf as dayOfWeek } from './dataview.js';
import { calorieTargets } from './body.js';
import { stackStatus, isDue, takenOn } from './protocols.js';

const standardsOf = (dv) => dv.memo('exec:standards', () => dv.standards());
const checksOf = (dv, date) => dv.memo('exec:checks:' + date, () => dv.checks(date));

// Sources whose value can still change later today (a false today is "pending", not "missed").
const ACCUMULATING = /^(plan\.adherence|training\.session|nutrition\.|protocol\.|day\.deepWork)/;
// Sources whose value means "it happened" (so an 'avoid' standard is done when false).
const OCCURRENCE = /^(training\.session|nutrition\.item:)/;

export function isApplicable(standard, date) {
  if (!standard || standard._d || standard.active === false) return false;
  if (standard.effectiveFrom && date < String(standard.effectiveFrom).slice(0, 10)) return false;
  if (Array.isArray(standard.days) && !standard.days.includes(dayOfWeek(date))) return false;
  return true;
}

/* ------------------------------------------------------------- auto sources */
// First date a source was tracked at all. Before it, "nothing logged" means unknown, not missed
// (a new vault must not score every earlier day as a failure).
function trackingStart(dv, what) {
  return dv.memo('exec:start:' + what, () => {
    const colls = what === 'training' ? ['sessions', 'whoopWorkouts', 'whoopCycles'] : ['meals'];
    let min = null;
    for (const c of colls) for (const r of dv.store.all(c)) if (r.date && (!min || r.date < min)) min = r.date;
    return min;
  });
}
const beforeTracking = (dv, what, date) => { const s = trackingStart(dv, what); return !s || date < s; };

// → { value, unit } | null. value: 'HH:MM' for times, number, or boolean; null = unknown.
export function autoValue(dv, source, date) {
  if (!source || typeof source !== 'string') return null;
  const [kind, ...rest] = source.split(':'); const arg = rest.join(':');
  switch (kind) {
    case 'whoop.wake': {
      const s = dv.sleep(date); if (!s) return { value: null, unit: 'time' };
      const hm = hmToMin(s.wake); const min = hm != null ? hm : dv.minutesAfter(s.end, date, s.tz);
      return { value: min == null ? null : minToHm(min), unit: 'time' };
    }
    case 'whoop.sleep': {
      const s = dv.sleep(date);
      return { value: s && isNum(s.asleepMin) ? round(s.asleepMin / 60, 2) : null, unit: 'h' };
    }
    case 'plan.adherence': return { value: dv.planSummary(date).adherence, unit: '%' };
    case 'training.session': {
      if (dv.sessions(date).length || dv.workouts(date).length) return { value: true, unit: 'bool' };
      return { value: beforeTracking(dv, 'training', date) ? null : false, unit: 'bool' };
    }
    case 'nutrition.meals': { const n = dv.intake(date).count; return { value: !n && beforeTracking(dv, 'meals', date) ? null : n, unit: 'meals' }; }
    case 'nutrition.protein': { const it = dv.intake(date); return { value: it.analyzed ? it.totals.protein : null, unit: 'g' }; }
    case 'nutrition.kcal': { const it = dv.intake(date); return { value: it.analyzed ? it.totals.kcal : null, unit: 'kcal' }; }
    case 'nutrition.item': {
      const it = dv.intake(date); const needle = arg.trim().toLowerCase();
      if (!it.count || !needle) return { value: null, unit: 'bool' };
      const hit = it.records.some((m) => (m.items || []).some((i) => i && String(i.name || '').toLowerCase().includes(needle)));
      // Unanalyzed meals have no items yet: "not eaten" cannot be claimed until they are.
      return { value: hit ? true : it.pending ? null : false, unit: 'bool' };
    }
    case 'protocol.stack': {
      const st = stackStatus(dv, date, arg);
      return { value: st.complete, unit: 'bool', na: !st.items.length };
    }
    case 'protocol.item': {
      const item = dv.store.get('protocolItems', arg); if (!item) return { value: null, unit: 'bool' };
      if (takenOn(dv, item.id, date)) return { value: true, unit: 'bool' };
      const due = isDue(dv, item, date);
      return { value: due ? false : null, unit: 'bool', na: !due };
    }
    case 'day.caffeineCutoff': {
      const d = dv.day(date); let last = hmToMin(d && d.caffeineLastAt);
      const cutoff = hmToMin(dv.setting('targets').caffeineCutoff);
      if (last == null || cutoff == null) return { value: null, unit: 'bool' };
      if (last < 240) last += 1440; // after midnight belongs to the evening
      return { value: last <= cutoff, unit: 'bool' };
    }
    case 'day.deepWork': return { value: dv.deepWorkH(date), unit: 'h' };
    default: return null;
  }
}

// Resolve target.value 'target' from settings for known sources.
export function resolveTarget(dv, standard, date) {
  const t = standard && standard.target; if (!t) return null;
  let value = t.value;
  if (value === 'target') {
    const s = dv.setting('targets'); const src = String(standard.auto || '');
    if (src === 'whoop.wake') value = s.wake;
    else if (src === 'day.deepWork') value = s.deepWorkTargetH;
    else if (src === 'whoop.sleep') value = s.sleepTargetH;
    else if (src === 'day.caffeineCutoff') value = s.caffeineCutoff;
    else if (src === 'nutrition.protein') value = calorieTargets(dv, date).proteinG;
    else if (src === 'nutrition.kcal') value = calorieTargets(dv, date).kcal;
    else value = null;
    if (value === undefined) value = null;
  }
  return { op: t.op || (standard.kind === 'time' ? '<=' : '>='), value, unit: t.unit || null };
}

function compare(a, op, b) {
  switch (op) {
    case '<=': return a <= b; case '<': return a < b; case '>': return a > b;
    case '==': case '=': return a === b; default: return a >= b;
  }
}
const timeMin = (v) => (isNum(v) ? v : hmToMin(v));
function convertUnit(v, from, to) {
  if (!isNum(v) || !from || !to || from === to) return v;
  if (from === 'h' && to === 'min') return v * 60;
  if (from === 'min' && to === 'h') return v / 60;
  return v;
}

// done for a value: true | false | null (cannot judge). Booleans from check records are
// done-values (legacy true = done for any kind); live occurrence sources mean "it happened".
function judge(kind, value, target, { unit, source, fromCheck }) {
  if (value === true || value === false) {
    const occurred = !fromCheck && OCCURRENCE.test(source || '');
    return kind === 'avoid' && occurred ? !value : value;
  }
  if (kind === 'time' || (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value))) {
    let v = timeMin(value); const t = target ? timeMin(target.value) : null;
    if (v == null || t == null) return null;
    if (t >= 1080 && v < 720) v += 1440; // evening targets: after-midnight values are late
    return compare(v, target.op, t);
  }
  if (isNum(value)) {
    if (kind === 'check') return target && isNum(target.value) ? compare(value, target.op, target.value) : value > 0;
    if (kind === 'avoid') return value === 0;
    if (!target || !isNum(target.value)) return null;
    return compare(convertUnit(value, unit, target.unit), target.op, target.value);
  }
  return null;
}

function display(kind, value, done, unit) {
  if (value == null) return '—';
  if (value === true || value === false) return done ? (kind === 'avoid' ? 'Avoided' : 'Done') : (kind === 'avoid' ? 'Slipped' : 'Missed');
  if (typeof value === 'string') return value;
  if (!isNum(value)) return String(value);
  const u = unit === '%' ? '%' : unit === 'h' ? ' h' : unit === 'g' ? ' g' : unit === 'kcal' ? ' kcal' : unit === 'min' ? ' min' : unit === 'meals' ? (value === 1 ? ' meal' : ' meals') : '';
  return fmtNum(value, unit === 'h' && value % 1 ? 1 : 0) + u;
}

// Did the user open the day (check-in or any check)? Unchecked manual items then count as missed.
const touched = (dv, date) => !!dv.day(date) || checksOf(dv, date).size > 0;

export function evaluateStandard(dv, standard, date) {
  const r = evaluate(dv, standard, date);
  // Today is still open: anything not yet known is pending rather than unknown.
  return r.status === 'unknown' && r.done === null && date === dv.asOf() ? { ...r, status: 'pending' } : r;
}

function evaluate(dv, standard, date) {
  const today = dv.asOf();
  const applicable = isApplicable(standard, date);
  const target = applicable ? resolveTarget(dv, standard, date) : (standard && standard.target) || null;
  const base = { standard, applicable, value: null, display: '—', done: null, source: 'none', target, status: applicable ? 'unknown' : 'na' };
  if (!applicable) return base;
  if (date > today) return { ...base, status: 'future' };
  const kind = standard.kind || 'check';
  const check = checksOf(dv, date).get(standard.id);
  const hasCheck = check && !check._d && check.value != null;
  const finish = (value, source, unit, fromCheck) => {
    const judged = judge(kind, value, target, { unit, source: standard.auto, fromCheck });
    let done = judged, status = judged === true ? 'done' : judged === false ? 'missed' : 'unknown';
    if (judged === false && source === 'auto' && date === today && ACCUMULATING.test(standard.auto || '')) { done = null; status = 'pending'; }
    return { ...base, value, display: display(kind, value, judged, unit || (target && target.unit)), done, source, status };
  };
  // 1) Manual check records always win.
  if (hasCheck && check.source !== 'auto') return finish(check.value, 'manual', target && target.unit, true);
  // 2) Live auto source.
  const auto = standard.auto ? autoValue(dv, standard.auto, date) : null;
  if (auto && auto.value != null) return finish(auto.value, 'auto', auto.unit, false);
  if (auto && auto.na && !hasCheck) return { ...base, status: 'na', display: 'Nothing due' };
  // 3) A stored auto check (e.g. imported history) when the live source has nothing.
  if (hasCheck) return finish(check.value, 'auto', target && target.unit, true);
  // 4) Nothing recorded.
  if (date === today) return { ...base, status: 'pending' };
  if (!standard.auto && touched(dv, date)) return { ...base, done: false, status: 'missed', display: 'Not logged' };
  return base;
}

const weightOf = (s) => (isNum(s.weight) && s.weight > 0 ? s.weight : 1);

// score = Σweight(done) / Σweight(known) × 100 over applicable standards.
export function dayExecution(dv, date) {
  return dv.memo('exec:day:' + date, () => {
    const items = standardsOf(dv).filter((s) => isApplicable(s, date)).map((s) => evaluateStandard(dv, s, date));
    let wDone = 0, wKnown = 0, reqDone = 0, reqTotal = 0, pending = 0, reqPending = false;
    for (const it of items) {
      const w = weightOf(it.standard);
      if (it.done != null) { wKnown += w; if (it.done) wDone += w; }
      if (it.status === 'pending') pending++;
      if (it.standard.required) { reqTotal++; if (it.done === true) reqDone++; else if (it.status === 'pending') reqPending = true; }
    }
    const future = date > dv.asOf();
    let perfect = null;
    if (!future && reqTotal > 0) perfect = reqDone === reqTotal ? true : reqPending ? null : false;
    return { date, score: wKnown > 0 ? round((wDone / wKnown) * 100, 1) : null, items, required: { done: reqDone, total: reqTotal }, perfect, pending };
  });
}

// Perfect-day streaks. Days with no required standards (or still pending today) neither
// extend nor break a streak.
export function streaks(dv, until = dv.asOf()) {
  const first = dv.firstDate();
  if (!first || first > until) return { current: 0, longest: 0, lastPerfect: null };
  let run = 0, longest = 0, lastPerfect = null;
  for (const d of dateRange(first, until)) {
    const p = dayExecution(dv, d).perfect;
    if (p === true) { run++; if (run > longest) longest = run; lastPerfect = d; }
    else if (p === false) run = 0;
  }
  return { current: run, longest, lastPerfect };
}

// Per standard over [from, to] (≤ today): rate = done / days with a known result × 100.
export function adherenceByStandard(dv, from, to) {
  const today = dv.asOf(); const end = to > today ? today : to;
  const dates = dateRange(from, end);
  return standardsOf(dv).map((standard) => {
    let applicableDays = 0, knownDays = 0, doneDays = 0;
    for (const d of dates) {
      if (!isApplicable(standard, d)) continue;
      applicableDays++;
      const it = dayExecution(dv, d).items.find((x) => x.standard.id === standard.id);
      if (it && it.done != null) { knownDays++; if (it.done) doneDays++; }
    }
    return { standard, applicableDays, knownDays, doneDays, rate: knownDays ? round((doneDays / knownDays) * 100, 1) : null };
  });
}
