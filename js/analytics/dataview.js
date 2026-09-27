// DataView: typed, per-date accessors over the store. The only bridge between
// storage and analytics. Pure reads; results memoized per store version.
import { todayStr, deviceTz, hmToMin, localParts, localFromOffset, addDays, minToHm, isNum, round } from '../core/util.js';
import { NUTRIENT_KEYS } from '../core/schema.js';

const byTime = (a, b) => { const x = a.at || a.start || a.startAt || '', y = b.at || b.start || b.startAt || ''; return x < y ? -1 : x > y ? 1 : 0; };

export function makeDataView(store, { tz, today } = {}) {
  const zone = tz || store.setting('profile').timezone || deviceTz();
  let memoVersion = -1; let memo = new Map();

  function cached(key, fn) {
    if (store.version !== memoVersion) { memo = new Map(); memoVersion = store.version; }
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  }
  const indexBy = (coll, keyFn) => cached('idx:' + coll, () => {
    const m = new Map();
    for (const r of store.all(coll)) { const k = keyFn(r); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    for (const arr of m.values()) arr.sort(byTime);
    return m;
  });
  const onDate = (coll) => (date) => store.byDate(coll, date).slice().sort(byTime);

  const dv = {
    store,
    tz: zone,
    version: () => store.version,
    memo: cached,
    today: () => todayStr(zone),
    settings: (id) => store.setting(id),

    /* ---------------- WHOOP ---------------- */
    recovery(date) {
      const list = store.byDate('whoopRecovery', date);
      if (!list.length) return null;
      return list.find((r) => r.scoreState === 'SCORED') || list[list.length - 1];
    },
    sleep(date) {
      const list = store.byDate('whoopSleep', date).filter((s) => !s.nap);
      if (!list.length) return null;
      return list.slice().sort((a, b) => (a.asleepMin || 0) - (b.asleepMin || 0)).pop();
    },
    naps: (date) => store.byDate('whoopSleep', date).filter((s) => s.nap),
    cycle(date) { const l = store.byDate('whoopCycles', date); return l.length ? l[l.length - 1] : null; },
    workouts: onDate('whoopWorkouts'),
    whoopBody: () => store.get('whoopBody', 'body'),

    /* ---------------- app data ---------------- */
    meals: onDate('meals'),
    sessions: onDate('sessions'),
    doses: onDate('doses'),
    plan: (date) => store.byDate('plan', date).slice().sort((a, b) => (hmToMin(a.start) ?? 0) - (hmToMin(b.start) ?? 0)),
    events: (date) => store.byDate('calendarEvents', date).filter((e) => !e.isForge && e.status !== 'cancelled').sort(byTime),
    forgeEvents: (date) => store.byDate('calendarEvents', date).filter((e) => e.isForge),
    body: onDate('body'),
    health: (date) => store.get('health', date),
    day: (date) => store.get('days', date),
    journal: onDate('journal'),
    checks(date) { const m = new Map(); for (const c of store.byDate('checks', date)) m.set(c.standardId, c); return m; },
    review: (kind, period) => store.get('reviews', `${kind}:${period}`),

    /* ---------------- libraries ---------------- */
    standards: ({ includeInactive = false } = {}) => store.all('standards').filter((s) => includeInactive || s.active !== false).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)),
    protocolItems: ({ includeInactive = false } = {}) => store.all('protocolItems').filter((p) => includeInactive || p.active !== false),
    exercises: () => cached('exercises', () => new Map(store.all('exercises').map((e) => [e.id, e]))),
    foods: () => store.all('foods'),
    labs: () => store.all('labs').slice().sort((a, b) => (a.collectedAt < b.collectedAt ? -1 : 1)),
    snapshots: () => store.all('snapshots').slice().sort((a, b) => (a.month < b.month ? -1 : 1)),
    templates: (kind) => store.all('templates').filter((t) => !kind || t.kind === kind),

    /* ---------------- ranges ---------------- */
    range: (coll, from, to) => store.range(coll, from, to),
    // Chronological list of every weigh-in (all time).
    weighIns: () => cached('weighIns', () => store.all('body').filter((b) => typeof b.weightLb === 'number').sort(byTime)),
    // All sessions (chronological) — strength analytics need full history.
    allSessions: () => cached('allSessions', () => store.all('sessions').slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byTime(a, b)))),
    allDoses: () => cached('allDoses', () => store.all('doses').slice().sort(byTime)),
    dosesByItem: () => indexBy('doses', (d) => d.itemId),
    // Earliest date with any data (for "days of data" statements).
    firstDate: () => cached('firstDate', () => {
      let min = null;
      for (const c of ['whoopRecovery', 'meals', 'sessions', 'checks', 'body', 'days', 'plan']) {
        const a = store.all(c); for (const r of a) if (r.date && (!min || r.date < min)) min = r.date;
      }
      return min;
    }),
  };

  /* ================================================================
   * Additive accessors (analytics helpers). Everything below is new;
   * nothing above changed behaviour. Per-date aggregates are memoized
   * per store version like everything else.
   * ================================================================ */

  // Deterministic "today" (tests, replays). Without the option dv.today() is unchanged.
  if (typeof today === 'function') dv.today = today;
  else if (typeof today === 'string') dv.today = () => today;

  Object.assign(dv, {
    // dv.today() memoized per store version (todayStr is slow in hot loops).
    asOf: () => cached('dv:today', () => dv.today()),
    // store.setting(id) memoized per store version (it deep-merges defaults on every call).
    setting: (id) => cached('dv:setting:' + id, () => store.setting(id)),
    // Drop memoized results (e.g. when the local date rolls over without a store change).
    invalidate: () => { memoVersion = -1; },

    // Local {ymd, min} of an ISO instant; `offset` = the record's tz ('-04:00' or IANA name).
    clock: (iso, offset) => localClock(iso, zone, offset),
    // Minutes of an instant after local midnight of `refDate` (continuous across midnight).
    minutesAfter: (iso, refDate, offset) => minutesAfter(iso, refDate, zone, offset),

    // Night that ended on the morning of `date`: bedtime minutes after midnight of date−1
    // (23:30 → 1410, 00:30 → 1470) and wake minutes after midnight of `date`.
    sleepClock: (date) => cached('dv:sleepClock:' + date, () => sleepClock(dv, date)),

    // Nutrition totals for a date. `complete` = at least one analyzed meal and none unanalyzed.
    intake: (date) => cached('dv:intake:' + date, () => computeIntake(dv, date)),

    // Plan blocks with minutes and credit (done 100%, partial 50%, skipped/planned 0).
    planSummary: (date) => cached('dv:plan:' + date, () => computePlan(dv, date)),

    // True when a calendar is connected (events exist or Google Calendar is configured).
    hasCalendar: () => cached('dv:hasCal', () => {
      if (store.all('calendarEvents').length) return true;
      const g = store.setting('integrations').gcal || {};
      return !!(g.saEmail || (g.readCalendars || []).length);
    }),
    // Dates the calendar sync has covered: [from, to] or null. Outside it meeting load is unknown, not zero.
    calendarRange: () => cached('dv:calRange', () => {
      const st = store.get('status', 'calendar'); const d = (st && st.detail) || {}; const win = d['window'] || {};
      let from = d.coverageFrom || win.from || null; let to = win.to || null;
      for (const e of store.all('calendarEvents')) if (e.date && (!from || e.date < from)) from = e.date;
      return from ? { from, to } : null; // to = null → no known upper bound
    }),
    // Timed, non-FORGE, non-cancelled events as minute intervals within [0, 1440].
    eventBlocks: (date) => cached('dv:events:' + date, () => computeEventBlocks(dv, date)),
    // Meeting load for a date; null when no calendar is connected (unknown, not zero).
    eventLoad: (date) => cached('dv:eventLoad:' + date, () => computeEventLoad(dv, date)),

    // One weight per date (first weigh-in of the day; Apple Health weight as fallback).
    dailyWeights: () => cached('dv:weights', () => computeDailyWeights(dv)),
    weightOn: (date) => cached('dv:weightMap', () => new Map(dv.dailyWeights().map((w) => [w.date, w.weightLb]))).get(date) ?? null,

    // Deep-work hours: the day log's deepWorkH, else done/partial 'deep' plan blocks
    // (only once at least one deep block has been marked done/partial/skipped).
    deepWorkH: (date) => cached('dv:deep:' + date, () => {
      const d = dv.day(date);
      if (d && isNum(d.deepWorkH)) return d.deepWorkH;
      if (date > dv.asOf()) return null;
      const deep = dv.planSummary(date).blocks.filter((b) => b.category === 'deep' && b.min != null);
      if (!deep.some((b) => b.status !== 'planned')) return null;
      return round(deep.reduce((s, b) => s + b.doneMin, 0) / 60, 2);
    }),
  });
  return dv;
}

/* ------------------------------------------------------- fast pure helpers */
// en-US number formatting without Intl (toLocaleString is slow in hot loops).
export function formatNumber(n, dp = 0) {
  if (!isNum(n)) return '—';
  const s = Math.abs(n).toFixed(dp); const dot = s.indexOf('.');
  const int = (dot < 0 ? s : s.slice(0, dot)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 && Number(s) !== 0 ? '-' : '') + int + (dot < 0 ? '' : s.slice(dot));
}
// Cached day number (days since 1970-01-01) and weekday (Mon=0) of 'YYYY-MM-DD'.
const dayNumCache = new Map();
export function dayNum(date) {
  let v = dayNumCache.get(date);
  if (v === undefined) {
    v = Math.round(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400000);
    if (dayNumCache.size > 50000) dayNumCache.clear();
    dayNumCache.set(date, v);
  }
  return v;
}
export const dowOf = (date) => (((dayNum(date) + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);

/* ------------------------------------------------------------ time helpers */
const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const OFFSET_RE = /^(Z|[+-]\d{2}:?\d{2})$/i;
const zoneCache = new Map();

// Local wall clock of an ISO instant as { ymd, min }.
// - `offset` like '-04:00' (WHOOP records carry `tz`) converts the instant to that offset;
//   an IANA name converts to that zone;
// - otherwise a string with a numeric offset is read as recorded (its wall clock is local),
//   a 'Z' string is converted to `zone`, and a string without offset is taken as local.
export function localClock(iso, zone, offset) {
  if (typeof iso !== 'string') return null;
  const m = ISO_RE.exec(iso.trim());
  if (!m) return null;
  const wall = { ymd: m[1], min: Number(m[2]) * 60 + Number(m[3]) };
  if (typeof offset === 'string' && offset) {
    if (!m[4]) return wall;
    if (OFFSET_RE.test(offset)) { const l = localFromOffset(iso, offset); return { ymd: l.ymd, min: l.min }; }
    if (offset.includes('/')) return viaZone(iso, offset);
  }
  if (!m[4] || m[4].toUpperCase() !== 'Z') return wall;
  return viaZone(iso, zone);
}
function viaZone(iso, zone) {
  const key = iso + '|' + (zone || '');
  let v = zoneCache.get(key);
  if (!v) {
    const p = localParts(iso, zone); v = { ymd: p.ymd, min: p.min };
    if (zoneCache.size > 20000) zoneCache.clear();
    zoneCache.set(key, v);
  }
  return v;
}
export function minutesAfter(iso, refDate, zone, offset) {
  const c = localClock(iso, zone, offset);
  return c ? (dayNum(c.ymd) - dayNum(refDate)) * 1440 + c.min : null;
}

// Merge [start, end] intervals (minutes) into a sorted, non-overlapping list.
export function mergeIntervals(list) {
  const arr = (list || []).filter((x) => x && x[1] > x[0]).map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of arr) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else out.push(iv);
  }
  return out;
}
// Free gaps inside [from, to] around merged busy intervals.
export function freeGaps(busy, from, to) {
  const out = []; let cur = from;
  for (const [s, e] of mergeIntervals(busy)) {
    if (e <= cur) continue;
    if (s >= to) break;
    if (s > cur) out.push([cur, Math.min(s, to)]);
    cur = Math.max(cur, e);
    if (cur >= to) break;
  }
  if (cur < to) out.push([cur, to]);
  return out;
}
const overlapLen = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/* -------------------------------------------------------- per-date aggregates */
function sleepClock(dv, date) {
  const s = dv.sleep(date);
  if (!s) return { bedMin: null, wakeMin: null };
  // Prefer the precomputed local 'HH:MM' fields; fall back to the instants.
  let bedMin = hmToMin(s.bedtime);
  if (bedMin != null) { if (bedMin < 720) bedMin += 1440; } else bedMin = minutesAfter(s.start, addDays(date, -1), dv.tz, s.tz);
  let wakeMin = hmToMin(s.wake);
  if (wakeMin == null) wakeMin = minutesAfter(s.end, date, dv.tz, s.tz);
  return { bedMin, wakeMin };
}

function mealTotals(m) {
  if (m.totals && typeof m.totals === 'object' && isNum(m.totals.kcal)) return m.totals;
  if (Array.isArray(m.items) && m.items.some((i) => i && isNum(i.kcal))) {
    const t = {};
    for (const it of m.items) for (const k of NUTRIENT_KEYS) if (it && isNum(it[k])) t[k] = (t[k] || 0) + it[k];
    return t;
  }
  return null;
}

function computeIntake(dv, date) {
  const meals = dv.meals(date);
  const totals = {}; for (const k of NUTRIENT_KEYS) totals[k] = null;
  let analyzed = 0, pending = 0, failed = 0, waiting = 0, lowConfidence = 0;
  let firstMin = null, lastMin = null, firstAt = null, lastAt = null;
  const perMeal = [];
  for (const m of meals) {
    const t = mealTotals(m);
    if (t) {
      analyzed++;
      for (const k of NUTRIENT_KEYS) if (isNum(t[k])) totals[k] = (totals[k] || 0) + t[k];
    } else { pending++; if (m.status === 'error') failed++; else if (m.status === 'pending') waiting++; }
    if (m.ai && m.ai.confidence === 'low') lowConfidence++;
    const min = minutesAfter(m.at, date, dv.tz);
    perMeal.push({ id: m.id, at: m.at || null, min, slot: m.slot || null, status: m.status || null, totals: t });
    if (min != null) {
      if (firstMin == null || min < firstMin) { firstMin = min; firstAt = m.at; }
      if (lastMin == null || min > lastMin) { lastMin = min; lastAt = m.at; }
    }
  }
  for (const k of NUTRIENT_KEYS) if (totals[k] != null) totals[k] = round(totals[k], 1);
  return {
    date, count: meals.length, analyzed, pending, failed, waiting, lowConfidence, // waiting = saved, not yet sent for analysis
    complete: analyzed > 0 && pending === 0, totals, meals: perMeal, records: meals,
    firstMin, lastMin, firstAt, lastAt,
  };
}

function computePlan(dv, date) {
  const past = date <= dv.asOf();
  const blocks = dv.plan(date).map((b) => {
    const s = hmToMin(b.start); let e = hmToMin(b.end);
    if (s != null && e != null && e <= s) e += 1440; // crosses midnight
    const min = s != null && e != null ? e - s : null;
    const status = b.status || 'planned';
    const credit = status === 'done' ? 1 : status === 'partial' ? 0.5 : 0;
    return { id: b.id, start: b.start, end: b.end, startMin: s, endMin: e, min, title: b.title || '', category: b.category || 'personal', status, credit, doneMin: min == null ? null : min * credit, record: b };
  });
  let plannedMin = 0, doneMin = 0; const cats = new Map();
  for (const b of blocks) {
    if (b.min == null) continue;
    plannedMin += b.min; doneMin += b.doneMin;
    const c = cats.get(b.category) || { category: b.category, plannedMin: 0, doneMin: 0 };
    c.plannedMin += b.min; c.doneMin += b.doneMin; cats.set(b.category, c);
  }
  const byCategory = [...cats.values()].map((c) => ({ category: c.category, plannedMin: c.plannedMin, doneMin: past ? c.doneMin : null }));
  return {
    date, blocks,
    plannedMin: blocks.length ? plannedMin : null,
    doneMin: blocks.length && past ? doneMin : null,
    adherence: plannedMin > 0 && past ? round((doneMin / plannedMin) * 100, 1) : null,
    byCategory,
  };
}

function computeEventBlocks(dv, date) {
  const out = [];
  for (const e of dv.events(date)) {
    if (e.allDay || e.status === 'declined') continue;
    let s = minutesAfter(e.start, date, dv.tz), en = minutesAfter(e.end, date, dv.tz);
    if (s == null || en == null) continue;
    s = Math.max(0, s); en = Math.min(1440, en);
    if (en <= s) continue;
    out.push({ id: e.id, title: e.title || '', start: s, end: en, attendees: e.attendees ?? null });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Working window used for after-hours and free-block statistics (08:00–18:00).
export const WORK_START = 480, WORK_END = 1080;

function computeEventLoad(dv, date) {
  if (!dv.hasCalendar()) return null;
  const cov = dv.calendarRange();
  if (!cov || date < cov.from || (cov.to && date > cov.to)) return null;
  const ev = dv.eventBlocks(date);
  const merged = mergeIntervals(ev.map((e) => [e.start, e.end]));
  let meetingMin = 0, afterHoursMin = 0;
  for (const [s, e] of merged) { meetingMin += e - s; afterHoursMin += (e - s) - overlapLen(s, e, WORK_START, WORK_END); }
  let backToBack = 0, prevEnd = null;
  for (const e of ev) { if (prevEnd != null && e.start - prevEnd <= 5) backToBack++; prevEnd = prevEnd == null ? e.end : Math.max(prevEnd, e.end); }
  const gaps = freeGaps(merged, WORK_START, WORK_END).map(([s, e]) => e - s);
  const free = gaps.reduce((a, b) => a + b, 0);
  const shortFree = gaps.filter((g) => g < 60).reduce((a, b) => a + b, 0);
  return {
    date, meetingMin, count: ev.length, afterHoursMin, backToBack,
    longestFreeBlockMin: gaps.length ? Math.max(...gaps) : 0,
    // Share of free work-hours time sitting in gaps shorter than 60 min (0 = unfragmented).
    fragmentation: free > 0 ? round(shortFree / free, 2) : null,
    firstStart: ev.length ? minToHm(ev[0].start) : null,
    lastEnd: ev.length ? minToHm(Math.max(...ev.map((e) => e.end))) : null,
    busy: merged, events: ev,
  };
}

function computeDailyWeights(dv) {
  const byDate = new Map();
  for (const w of dv.weighIns()) {
    if (typeof w.date !== 'string') continue;
    const cur = byDate.get(w.date);
    // Earliest weigh-in of the day (morning weight); untimed entries lose to timed ones.
    if (!cur || (w.at && (!cur.at || w.at < cur.at))) byDate.set(w.date, { date: w.date, at: w.at || null, weightLb: w.weightLb, source: 'body' });
  }
  for (const h of dv.store.all('health')) {
    if (h && typeof h.date === 'string' && isNum(h.weightLb) && !byDate.has(h.date)) byDate.set(h.date, { date: h.date, at: null, weightLb: h.weightLb, source: 'health' });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
