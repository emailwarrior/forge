// Day area (Today + Plan) — pure helpers: timeline merge, plan-block overlap and schedule
// layout, drafts/templates/copies, week aggregation, timing vs targets, field diffs and a few
// formatters. No DOM, no Preact: unit-tested in tests/ui/day-model.test.mjs.
import { hmToMin, minToHm, addDays, dateRange, isNum, round, fmtTime, fmtNum, fmtDur } from '../../core/util.js';
import { minutesAfter } from '../../analytics/dataview.js';
import { isWorkingSet } from '../../analytics/strength.js';

/* ------------------------------------------------------------------ blocks */

/** Minute span of a plan block ({start,end} 'HH:MM'); an end at or before the start runs past midnight. */
export function blockSpan(b) {
  const s = hmToMin(b && b.start); let e = hmToMin(b && b.end);
  if (s == null || e == null) return null;
  if (e <= s) e += 1440;
  return { start: s, end: e };
}
export const spansOverlap = (a, b) => !!a && !!b && a.start < b.end && b.start < a.end;
export const blocksOverlap = (a, b) => spansOverlap(blockSpan(a), blockSpan(b));
export function blockMinutes(b) { const s = blockSpan(b); return s ? s.end - s.start : null; }

/** Validation message for a block's times, or null. An end of 00:00 means midnight. */
export function blockTimeError(start, end) {
  const s = hmToMin(start), e = hmToMin(end);
  if (s == null) return 'Set a start time.';
  if (e == null) return 'Set an end time.';
  if (e === 0 && s > 0) return null;
  if (e <= s) return 'End must be after start.';
  return null;
}

/** 'HH:MM' + minutes → 'HH:MM' (wraps at midnight: 23:30 + 30 → '00:00'). */
export function addMinutes(hm, min) { const s = hmToMin(hm); return s == null ? '' : minToHm(s + min); }

/** Next 30-minute boundary after `nowMin` as a 1-hour slot (clamped to end by midnight). */
export function nextSlot(nowMin, dur = 60) {
  const s = Math.min(1440 - 30, Math.ceil((nowMin + 1) / 30) * 30);
  return { start: minToHm(s), end: minToHm(Math.min(1440, s + dur)) };
}

/** A tap at `min` on the schedule → a new slot snapped to `step`, `dur` long, inside [from, to]. */
export function slotAt(min, { step = 30, dur = 60, from = 0, to = 1440 } = {}) {
  let s = Math.floor(min / step) * step;
  s = Math.max(from, Math.min(s, to - step));
  const e = Math.min(to, s + dur, 1440);
  return { start: minToHm(s), end: minToHm(e) };
}

/** Fields for a new `plan` record from a draft/template/copied block. */
export function planFields(date, b, extra = {}) {
  const out = {
    date, start: b.start, end: b.end, title: (b.title && String(b.title).trim()) || 'Block',
    category: b.category || 'personal', status: 'planned', calendar: b.calendar !== false, reminder: !!b.reminder,
  };
  return { ...out, ...extra };
}

/** Template blocks from plan blocks (sorted by start). */
export function templateBlocks(blocks) {
  return (blocks || []).filter((b) => blockSpan(b))
    .map((b) => ({ start: b.start, end: b.end, title: b.title || 'Block', category: b.category || 'personal', reminder: !!b.reminder }))
    .sort((a, b) => blockSpan(a).start - blockSpan(b).start);
}

/**
 * Which draft blocks fit into a day: a block is skipped when it overlaps an existing block or a
 * draft block accepted before it. → { add, skipped }
 */
export function mergeDraft(existing, draft) {
  const taken = (existing || []).map(blockSpan).filter(Boolean);
  const add = [], skipped = [];
  for (const b of draft || []) {
    const sp = blockSpan(b);
    if (!sp || taken.some((t) => spansOverlap(t, sp))) { skipped.push(b); continue; }
    taken.push(sp); add.push(b);
  }
  return { add, skipped };
}

/**
 * Copy the previous week's plan into this week, day by day, only into days without blocks and
 * (with `from`) only into dates on/after `from` — past days are never back-filled.
 * byDate: (date) → plan blocks. → { add: [planFields], copiedDays, skippedDays (already planned), emptySource, pastDays }
 */
export function weekCopyPlan(weekDates, byDate, { from } = {}) {
  const add = [], copiedDays = [], skippedDays = [], emptySource = [], pastDays = [];
  for (const d of weekDates) {
    if (from && d < from) { pastDays.push(d); continue; }
    const src = (byDate(addDays(d, -7)) || []).filter((b) => blockSpan(b));
    if (!src.length) { emptySource.push(d); continue; }
    if ((byDate(d) || []).length) { skippedDays.push(d); continue; }
    copiedDays.push(d);
    for (const b of src) add.push(planFields(d, b));
  }
  return { add, copiedDays, skippedDays, emptySource, pastDays };
}

/* ---------------------------------------------------------- schedule layout */

/**
 * Column layout for overlapping schedule items ({start, end} minutes). Transitively overlapping
 * items form a cluster; each item takes the first free column; `cols` = columns in its cluster.
 * Returns new objects `{...item, col, cols}` sorted by start.
 */
export function layoutColumns(items) {
  const sorted = (items || []).map((it, idx) => ({ it, idx }))
    .filter(({ it }) => isNum(it.start) && isNum(it.end) && it.end > it.start)
    .sort((a, b) => a.it.start - b.it.start || b.it.end - a.it.end || a.idx - b.idx);
  const out = []; let cluster = [], colEnds = [], clusterEnd = -Infinity;
  const flush = () => { for (const c of cluster) c.cols = colEnds.length; cluster = []; colEnds = []; clusterEnd = -Infinity; };
  for (const { it } of sorted) {
    if (it.start >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= it.start);
    if (col < 0) { col = colEnds.length; colEnds.push(it.end); } else colEnds[col] = it.end;
    const placed = { ...it, col, cols: 1 };
    cluster.push(placed); out.push(placed);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

/** Hour-aligned visible range covering [from, to] and every item (max 6 h past midnight). */
export function scheduleRange(items, { from = 300, to = 1440 } = {}) {
  let lo = from, hi = to;
  for (const i of items || []) {
    if (isNum(i.start)) lo = Math.min(lo, Math.floor(i.start / 60) * 60);
    if (isNum(i.end)) hi = Math.max(hi, Math.ceil(i.end / 60) * 60);
  }
  return { from: Math.max(0, lo), to: Math.min(1440 + 360, hi) };
}

/* ---------------------------------------------------------------- timeline */

const SLOT_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack', shake: 'Shake', pre: 'Pre-workout', post: 'Post-workout' };
export const slotLabel = (slot) => SLOT_LABEL[slot] || null;

/** Display title of a meal: its title, else its first item names, else the slot. */
export function mealTitle(m) {
  if (!m) return 'Meal';
  if (m.title && String(m.title).trim()) return String(m.title).trim();
  const names = (Array.isArray(m.items) ? m.items : []).map((i) => i && i.name).filter(Boolean);
  if (names.length) return names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
  return SLOT_LABEL[m.slot] || 'Meal';
}

/** Working sets, volume (lb), exercises, duration and cardio minutes of a session. */
export function sessionSummary(s, date, tz) {
  let sets = 0, volume = 0; const ex = new Set();
  for (const e of (s && s.entries) || []) {
    let any = false;
    for (const set of (e && e.sets) || []) {
      if (!isWorkingSet(set)) continue;
      sets++; any = true; volume += (isNum(set.w) ? set.w : 0) * (isNum(set.reps) ? set.reps : 0);
    }
    if (any && e.exerciseId) ex.add(e.exerciseId);
  }
  const a = s && s.startAt ? minutesAfter(s.startAt, date, tz) : null;
  const b = s && s.endAt ? minutesAfter(s.endAt, date, tz) : null;
  const cardio = ((s && s.cardio) || []).filter(Boolean);
  const cardioMin = cardio.reduce((t, c) => t + (isNum(c.durationMin) ? c.durationMin : 0), 0);
  return {
    sets, volume: round(volume, 0), exercises: ex.size, open: !!(s && !s.endAt),
    startMin: a, endMin: b, durationMin: a != null && b != null && b > a ? b - a : null,
    cardio: cardio.length, cardioMin: cardio.length ? cardioMin : null,
  };
}

const KIND_ORDER = { event: 0, sleep: 1, nap: 2, block: 3, session: 4, workout: 5, meal: 6, doses: 7, weigh: 8, journal: 9, bed: 10 };

/**
 * One chronological list for a date. Inputs are raw records (as the DataView returns them):
 * { date, tz, sleep (night that ended this morning), naps, nextSleep (night starting this evening),
 *   plan, events, meals, sessions, workouts, doses, body, journal }.
 * Entries: { kind, key, min (sort minute after local midnight; null = untimed, sorted last),
 *   endMin?, startMin? (sleep: bedtime, negative = previous evening), allDay?, declined?,
 *   workout? (a session's linked WHOOP workout), doses? (same-minute doses), rec }.
 */
export function buildTimeline(src) {
  const { date, tz } = src;
  const at = (iso, off) => (iso ? minutesAfter(iso, date, tz, off) : null);
  const out = [];
  const sl = src.sleep;
  if (sl) {
    let wake = hmToMin(sl.wake); if (wake == null) wake = at(sl.end, sl.tz);
    let bed = hmToMin(sl.bedtime);
    if (bed != null) { if (bed >= 720) bed -= 1440; } else bed = at(sl.start, sl.tz);
    out.push({ kind: 'sleep', key: 'sleep:' + sl.id, min: wake, startMin: bed, endMin: wake, rec: sl });
  }
  for (const n of src.naps || []) out.push({ kind: 'nap', key: 'nap:' + n.id, min: at(n.start, n.tz), endMin: at(n.end, n.tz), rec: n });
  const ns = src.nextSleep;
  if (ns) {
    let bed = hmToMin(ns.bedtime);
    if (bed != null) { if (bed < 720) bed += 1440; } else bed = at(ns.start, ns.tz);
    if (bed != null) out.push({ kind: 'bed', key: 'bed:' + ns.id, min: bed, rec: ns });
  }
  for (const b of src.plan || []) {
    const sp = blockSpan(b);
    out.push({ kind: 'block', key: 'block:' + b.id, min: sp ? sp.start : null, endMin: sp ? sp.end : null, rec: b });
  }
  for (const e of src.events || []) {
    if (e.allDay) out.push({ kind: 'event', key: 'event:' + e.id, min: -1, allDay: true, declined: e.status === 'declined', rec: e });
    else out.push({ kind: 'event', key: 'event:' + e.id, min: at(e.start), endMin: at(e.end), declined: e.status === 'declined', rec: e });
  }
  for (const m of src.meals || []) out.push({ kind: 'meal', key: 'meal:' + m.id, min: at(m.at), rec: m });
  const wo = src.workouts || [];
  const byId = new Map(wo.map((w) => [w.id, w])); const linked = new Set();
  for (const s of src.sessions || []) {
    const w = s.whoopWorkoutId ? byId.get(s.whoopWorkoutId) || null : null;
    if (w) linked.add(w.id);
    out.push({ kind: 'session', key: 'session:' + s.id, min: at(s.startAt), endMin: at(s.endAt), workout: w, rec: s });
  }
  for (const w of wo) if (!linked.has(w.id)) out.push({ kind: 'workout', key: 'workout:' + w.id, min: at(w.start, w.tz), endMin: at(w.end, w.tz), rec: w });
  const groups = new Map();
  for (const d of src.doses || []) {
    const m = at(d.at); const k = m == null ? 'untimed' : String(m);
    if (!groups.has(k)) groups.set(k, { kind: 'doses', key: 'doses:' + k, min: m, doses: [] });
    groups.get(k).doses.push(d);
  }
  out.push(...groups.values());
  for (const b of src.body || []) out.push({ kind: 'weigh', key: 'weigh:' + b.id, min: at(b.at), rec: b });
  for (const j of src.journal || []) out.push({ kind: 'journal', key: 'journal:' + j.id, min: at(j.at), rec: j });
  const k = (x) => (x.min == null ? Infinity : x.min);
  return out.sort((a, b) => k(a) - k(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Index at which the "now" marker goes: before the first entry that starts after `nowMin`. */
export function nowIndex(entries, nowMin) {
  const i = (entries || []).findIndex((e) => e.min != null && e.min > nowMin);
  if (i >= 0) return i;
  const firstUntimed = (entries || []).findIndex((e) => e.min == null);
  return firstUntimed >= 0 ? firstUntimed : (entries || []).length;
}

/* --------------------------------------------------------------- week view */

/**
 * Plan/meeting aggregation for the Mon–Sun week starting `from`:
 * { from, to, rows: [{date, past, blocks, plannedMin, doneMin, adherence, meetingMin, meetingCount, byCategory}],
 *   totals: {plannedMin, doneMin, adherence, meetingMin, meetingCount, days, judgedDays} }.
 * Totals: adherence = done / planned over days that can be judged (today and earlier).
 */
export function weekRows(dv, from) {
  const dates = dateRange(from, addDays(from, 6));
  const today = dv.asOf ? dv.asOf() : dv.today();
  const rows = dates.map((date) => {
    const p = dv.planSummary(date); const load = dv.eventLoad(date);
    return {
      date, past: date <= today, blocks: p.blocks.length, plannedMin: p.plannedMin, doneMin: p.doneMin, adherence: p.adherence,
      meetingMin: load ? load.meetingMin : null, meetingCount: load ? load.count : null, byCategory: p.byCategory,
    };
  });
  const judged = rows.filter((r) => r.doneMin != null && r.plannedMin > 0);
  const jp = judged.reduce((s, r) => s + r.plannedMin, 0), jd = judged.reduce((s, r) => s + r.doneMin, 0);
  const meet = rows.filter((r) => r.meetingMin != null);
  return {
    from, to: dates[6], rows,
    totals: {
      plannedMin: rows.reduce((s, r) => s + (r.plannedMin || 0), 0),
      doneMin: judged.length ? jd : null,
      adherence: jp > 0 ? round((jd / jp) * 100, 1) : null,
      meetingMin: meet.length ? meet.reduce((s, r) => s + r.meetingMin, 0) : null,
      meetingCount: meet.length ? meet.reduce((s, r) => s + (r.meetingCount || 0), 0) : null,
      days: rows.filter((r) => r.blocks > 0).length, judgedDays: judged.length,
    },
  };
}

/* ------------------------------------------------------------------ timing */

/**
 * Timing of one day vs targets. Inputs are minutes after local midnight of the day
 * (bedMin may exceed 1440 after midnight; caffeine before 04:00 counts as after midnight).
 * → [{ key, label, actual, target, delta (actual − target, min), hit }]
 */
export function dayTiming({ wakeMin, caffeineMin, lastMealMin, bedMin } = {}, targets = {}) {
  const tgt = (hm, evening) => { let m = hmToMin(hm); if (m != null && evening && m < 720) m += 1440; return m; };
  let caf = caffeineMin; if (isNum(caf) && caf < 240) caf += 1440;
  const rows = [
    { key: 'wake', label: 'Wake', actual: wakeMin, target: tgt(targets.wake) },
    { key: 'caffeine', label: 'Last caffeine', actual: caf, target: tgt(targets.caffeineCutoff) },
    { key: 'lastMeal', label: 'Last meal', actual: lastMealMin, target: tgt(targets.lastMealBy) },
    { key: 'bedtime', label: 'Bedtime', actual: bedMin, target: tgt(targets.bedtime, true) },
  ];
  return rows.map((r) => {
    const ok = isNum(r.actual) && isNum(r.target);
    return { ...r, actual: isNum(r.actual) ? r.actual : null, delta: ok ? r.actual - r.target : null, hit: ok ? r.actual <= r.target : null };
  });
}

/* -------------------------------------------------------------- field diffs */

const normVal = (v) => { if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; } return v === undefined ? null : v; };

/** Patch of the fields in `keys` whose value differs between `original` and `draft` ('' → null, strings trimmed). */
export function changedFields(original, draft, keys) {
  const patch = {};
  for (const k of keys) {
    const a = normVal(original ? original[k] : undefined), b = normVal(draft ? draft[k] : undefined);
    if (a === b) continue;
    if (a !== null && b !== null && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b)) continue;
    patch[k] = b;
  }
  return patch;
}

/* --------------------------------------------------------------- formatters */

/** '9:30–10:00 AM' / '11:30 AM–1:00 PM' from minutes (end may exceed 1440). */
export function fmtSpan(startMin, endMin) {
  if (!isNum(startMin)) return '—';
  const a = fmtTime(startMin);
  if (!isNum(endMin)) return a;
  const b = fmtTime(endMin);
  return a.slice(-2) === b.slice(-2) ? a.slice(0, -3) + '–' + b : a + '–' + b;
}

const OPS = { '<=': '≤', '>=': '≥', '<': '<', '>': '>', '==': '=', '=': '=' };
const UNIT = { '%': '%', h: ' h', min: ' min', g: ' g', kcal: ' kcal', mg: ' mg', lb: ' lb' };

/** Readable target: '≥ 30 min', '≤ 6:30 AM', '≥ 90%', '≥ 3'. Null target → ''. */
export function targetText(target, kind) {
  if (!target) return '';
  const op = OPS[target.op] || (kind === 'time' ? '≤' : '≥');
  const v = target.value;
  if (v == null || v === 'target') return 'target not set';
  if (kind === 'time' || (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v))) return `${op} ${fmtTime(v)}`;
  if (!isNum(Number(v))) return `${op} ${v}`;
  const n = Number(v);
  return `${op} ${fmtNum(n, n % 1 ? 1 : 0)}${UNIT[target.unit] || (target.unit ? ' ' + target.unit : '')}`;
}

/** Dose/protocol amount: integers with separators ('5,000'), fractions kept to 3 dp ('0.25'). */
export function fmtAmount(n) {
  if (!isNum(n)) return '';
  return Number.isInteger(n) ? fmtNum(n) : String(round(n, 3));
}

/** Signed number with a typographic minus (matches analytics copy): '+1.0', '−2.2', '0'. */
export function fmtSigned(n, dp = 0) {
  if (!isNum(n)) return '—';
  const r = round(n, dp);
  if (r === 0) return fmtNum(0, dp);
  return (r > 0 ? '+' : '−') + fmtNum(Math.abs(r), dp);
}

/** Signed minutes as '+1h 19m' / '−25m' / 'on time'. */
export function fmtDelta(min) {
  if (!isNum(min)) return '—';
  const m = Math.round(min); if (m === 0) return 'on time';
  const a = Math.abs(m); const h = Math.floor(a / 60), r = a % 60;
  return (m > 0 ? '+' : '−') + (h ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`);
}

/** '12 min ago' / '3 h ago' / '2 d ago' / 'just now' for an instant. */
export function fmtAgo(iso, nowMs = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!isFinite(t)) return '—';
  const min = Math.max(0, Math.round((nowMs - t) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

/** Duration (UI_GUIDE: via fmtDur): 405 → '6h 45m', 60 → '1h 00m', 30 → '30m', null → '—'. */
export const fmtMinutes = (min) => fmtDur(min);
