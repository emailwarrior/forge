// Insights (UI-D): pure presentation helpers — periods, buckets, baseline bands, deltas, pairing.
// No DOM and no Preact here, so everything is unit-tested in Node (tests/ui/insights-logic.test.mjs).
// Metrics themselves come from js/analytics; these helpers only shape them for charts and copy.
import { addDays, diffDays, weekStart, isYmd, isNum, round, fmtDate, fmtTime, fmtNum, signed } from '../../core/util.js';
import { mean, sd, median, spearman } from '../../analytics/stats.js';

/* -------------------------------------------------------------- ranges */
export const RANGES = [14, 30, 90, 180, 365];
export const rangeLabel = (d) => (d === 365 ? '1y' : d + 'd');

/** A valid range from a query value ('90', 90), else the fallback. */
export function parseRange(value, fallback) {
  const n = Number(value);
  return RANGES.includes(n) ? n : fallback;
}

// Collections that carry dated personal data (used to find where the history starts).
const START_COLLS = ['whoopRecovery', 'whoopSleep', 'whoopCycles', 'whoopWorkouts', 'meals', 'sessions', 'checks', 'body', 'days', 'plan', 'health', 'doses', 'calendarEvents'];

/** Earliest 'YYYY-MM-DD' with any data (store-like object with all(coll)); null for an empty vault. */
export function dataStartOf(store) {
  let min = null;
  for (const c of START_COLLS) {
    let list; try { list = store.all(c); } catch { list = []; }
    for (const r of list) {
      const d = r && typeof r.date === 'string' ? r.date.slice(0, 10) : null;
      if (d && isYmd(d) && (!min || d < min)) min = d;
    }
  }
  return min;
}

/**
 * The analysis window for a range ending today, clamped to where the data starts (so a 1-year view of
 * 4 months of history does not compute or draw 8 empty months), plus the previous window of equal length.
 * → { from, to, days, nominal, clamped, prevFrom, prevTo, prevDays }
 */
export function periodFor(today, days, dataStart) {
  const nominalFrom = addDays(today, -(days - 1));
  let from = nominalFrom;
  if (dataStart && dataStart > nominalFrom) from = dataStart > today ? today : dataStart;
  const len = diffDays(from, today) + 1;
  const prevTo = addDays(from, -1);
  let prevFrom = addDays(from, -len);
  let hasPrev = !!dataStart && prevTo >= dataStart;
  if (hasPrev && prevFrom < dataStart) prevFrom = dataStart;
  return {
    from, to: today, days: len, nominal: days, clamped: from !== nominalFrom,
    prevFrom: hasPrev ? prevFrom : null, prevTo: hasPrev ? prevTo : null,
    prevDays: hasPrev ? diffDays(prevFrom, prevTo) + 1 : 0,
  };
}

/* ------------------------------------------------------------- values */
const get = (row, key) => (typeof key === 'function' ? key(row) : row ? row[key] : null);
/** Finite values of a key (or accessor) across rows. */
export function valuesOf(rows, key) { const out = []; for (const r of rows || []) { const v = get(r, key); if (isNum(v)) out.push(v); } return out; }
/** Number of rows with a finite value. */
export const nOf = (rows, key) => valuesOf(rows, key).length;
/** Mean of the finite values (null when none). */
export const avgOf = (rows, key) => mean(valuesOf(rows, key));
/** Rows strictly before `date` (complete days: nutrition, plan, deep work accumulate during today). */
export const before = (rows, date) => (rows || []).filter((r) => r.date < date);
/** [{x: date, y}] with nulls kept (a line breaks at a null). */
export function seriesOf(rows, key, map) {
  return (rows || []).map((r) => { const v = get(r, key); return { x: r.date, y: isNum(v) ? (map ? map(v, r) : v) : null }; });
}

/* ------------------------------------------------------------ buckets */
/** Daily bars up to ~6 weeks; weekly bars beyond (bars stay readable at 390 px). */
export const bucketMode = (days) => (days > 45 ? 'week' : 'day');

/**
 * Bars for a key: daily values, or Monday-week aggregates (mean or sum of the days with data).
 * → [{ x, y, n, days, label }]; `fmt(y)` formats the tooltip label.
 */
export function bucketRows(rows, key, { mode = 'day', agg = 'mean', fmt } = {}) {
  const f = fmt || ((v) => fmtNum(v, 1));
  if (mode === 'day') {
    return (rows || []).map((r) => { const v = get(r, key); const y = isNum(v) ? v : null; return { x: r.date, y, n: y == null ? 0 : 1, days: 1, label: `${fmtDate(r.date)}${y == null ? ' · no data' : ' · ' + f(y)}` }; });
  }
  const weeks = new Map();
  for (const r of rows || []) {
    const w = weekStart(r.date);
    if (!weeks.has(w)) weeks.set(w, { vals: [], days: 0 });
    const b = weeks.get(w); b.days++;
    const v = get(r, key); if (isNum(v)) b.vals.push(v);
  }
  return [...weeks.entries()].map(([w, b]) => {
    const y = b.vals.length ? (agg === 'sum' ? b.vals.reduce((a, c) => a + c, 0) : mean(b.vals)) : null;
    const what = agg === 'sum' ? 'total' : 'avg';
    return { x: w, y, n: b.vals.length, days: b.days, label: `Week of ${fmtDate(w, { dow: false })} · ${y == null ? 'no data' : f(y) + ' ' + what}${b.days < 7 ? ` (${b.days} days)` : ''}` };
  });
}

/** Stacked parts per day or week (mean per day in the bucket, per key). → [{ x, parts: {key: value} }] */
export function bucketParts(rows, keys, { mode = 'day' } = {}) {
  if (mode === 'day') return (rows || []).map((r) => ({ x: r.date, parts: Object.fromEntries(keys.map((k) => [k, isNum(r[k]) ? r[k] : null])) }));
  const weeks = new Map();
  for (const r of rows || []) {
    const w = weekStart(r.date);
    if (!weeks.has(w)) weeks.set(w, Object.fromEntries(keys.map((k) => [k, []])));
    const b = weeks.get(w); for (const k of keys) if (isNum(r[k])) b[k].push(r[k]);
  }
  return [...weeks.entries()].map(([w, b]) => ({ x: w, parts: Object.fromEntries(keys.map((k) => [k, mean(b[k])])) }));
}

/* ------------------------------------------------------- baseline band */
/**
 * Trailing baseline per row: mean ± k·SD of the `window` days BEFORE the row's date (the day itself is
 * excluded, like analytics/readiness baselines). Rows must be consecutive days. Null until `minN` values.
 * → [{ x, lo, hi, mean, n }]
 */
export function trailingBand(rows, key, { window = 30, minN = 7, k = 1 } = {}) {
  const out = [];
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const from = addDays(list[i].date, -window);
    const vals = [];
    for (let j = Math.max(0, i - window - 1); j < i; j++) { if (list[j].date < from) continue; const v = get(list[j], key); if (isNum(v)) vals.push(v); }
    if (vals.length < minN) { out.push({ x: list[i].date, lo: null, hi: null, mean: null, n: vals.length }); continue; }
    const m = mean(vals), s = sd(vals) || 0;
    out.push({ x: list[i].date, lo: m - k * s, hi: m + k * s, mean: m, n: vals.length });
  }
  return out;
}

/** Deviation of each row's value from its trailing baseline mean. → [{x, y}] */
export function deviationSeries(rows, key, opts) {
  const band = trailingBand(rows, key, opts);
  return (rows || []).map((r, i) => { const v = get(r, key); const m = band[i].mean; return { x: r.date, y: isNum(v) && isNum(m) ? round(v - m, 2) : null }; });
}

/* -------------------------------------------------------------- deltas */
/**
 * Change between two period values for copy + tone.
 * opts: { dp, suffix, lowerIsBetter, neutral, pct (percent change instead of difference), label }
 * → { value, text, tone: 'good'|'bad'|null } | null
 */
export function deltaInfo(cur, prev, { dp = 0, suffix = '', lowerIsBetter = false, neutral = false, pct = false, label = '' } = {}) {
  if (!isNum(cur) || !isNum(prev)) return null;
  const value = pct ? (prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100) : cur - prev;
  if (!isNum(value)) return null;
  const r = round(value, dp) || 0; // no "-0"
  const text = `${signed(r, dp)}${pct ? '%' : suffix}${label ? ' ' + label : ''}`;
  const tone = neutral || r === 0 ? null : (r > 0) !== !!lowerIsBetter ? 'good' : 'bad';
  return { value: r, text, tone };
}

/** Signed number without "-0" / "-0.0" (axis ticks, deviations): 0.25 → '+0.3', -0.0001 → '0.0'. */
export function fmtSigned(v, dp = 0) {
  if (!isNum(v)) return '—';
  const r = round(v, dp) || 0;
  return signed(r, dp);
}

/** Percent change (null when not computable). */
export const pctChange = (cur, prev) => (isNum(cur) && isNum(prev) && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null);

/* ------------------------------------------------------------ grouping */
/** Mean outcome above/below a threshold. points [{x, y}] → { hi: {n, mean}, lo: {n, mean} } */
export function splitCompare(points, threshold, op = '>=') {
  const hi = [], lo = [];
  for (const p of points || []) {
    if (!isNum(p.x) || !isNum(p.y)) continue;
    ((op === '>' ? p.x > threshold : p.x >= threshold) ? hi : lo).push(p.y);
  }
  return { hi: { n: hi.length, mean: mean(hi) }, lo: { n: lo.length, mean: mean(lo) } };
}

/**
 * Spearman rho of paired points plus a median split comparison. With `step`, the split threshold is the
 * median rounded to that step (readable: 11:00 AM instead of 10:52 AM) unless that empties a group.
 * → { n, rho, split, threshold }
 */
export function pairSummary(points, { step } = {}) {
  const pts = (points || []).filter((p) => isNum(p.x) && isNum(p.y));
  if (pts.length < 3) return { n: pts.length, rho: null, threshold: null, split: null };
  const rho = spearman(pts.map((p) => p.x), pts.map((p) => p.y));
  let t = median(pts.map((p) => p.x));
  if (step) { const r = Math.round(t / step) * step; const s = splitCompare(pts, r); if (s.hi.n && s.lo.n) t = r; }
  const split = splitCompare(pts, t);
  return { n: pts.length, rho: isNum(rho) ? round(rho, 2) : null, threshold: t, split: split.hi.n && split.lo.n ? split : null };
}

/** Counts per bin. edges ascending, last may be Infinity. → [{ label, lo, hi, n }] */
export function histogram(values, edges, { unit = '' } = {}) {
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const label = i === 0 && lo <= 0 ? `<${hi}${unit}` : hi === Infinity ? `${lo}${unit}+` : `${lo}–${hi - 1}${unit}`;
    bins.push({ label, lo, hi, n: 0 });
  }
  for (const v of values || []) {
    if (!isNum(v)) continue;
    const b = bins.find((x) => v >= x.lo && v < x.hi) || (v < edges[0] ? bins[0] : null);
    if (b) b.n++;
  }
  return bins;
}

/* ------------------------------------------------------------ strength */
/**
 * Weekly strength index: each lift's best e1RM that week relative to its first e1RM in [from, to]
 * (= 100), averaged over the lifts trained that week. histories: [[{date, e1rm}]] → [{ x: Monday, y }]
 */
export function strengthIndex(histories, from, to) {
  const weeks = new Map();
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) weeks.set(w, []);
  for (const h of histories || []) {
    const pts = (h || []).filter((p) => p && p.date >= from && p.date <= to && isNum(p.e1rm));
    if (!pts.length) continue;
    const base = pts[0].e1rm; const best = new Map();
    for (const p of pts) { const w = weekStart(p.date); best.set(w, Math.max(best.get(w) ?? -Infinity, p.e1rm)); }
    for (const [w, v] of best) if (weeks.has(w)) weeks.get(w).push((v / base) * 100);
  }
  return [...weeks.entries()].map(([x, v]) => ({ x, y: v.length ? round(mean(v), 1) : null }));
}

/** Best value of `key` within [from, to] in a history list (null when none). */
export function bestIn(history, from, to, key = 'e1rm') {
  let best = null;
  for (const p of history || []) if (p && p.date >= from && p.date <= to && isNum(p[key]) && (best == null || p[key] > best)) best = p[key];
  return best;
}

/** Median of percent changes cur vs prev over items [{cur, prev}] with both values. → { median, n } */
export function medianChange(items) {
  const ch = (items || []).map((x) => pctChange(x.cur, x.prev)).filter(isNum);
  return { median: ch.length ? round(median(ch), 1) : null, n: ch.length };
}

/* ------------------------------------------------------------- drivers */
/**
 * (x, y) pairs behind one findDrivers() result, aligned exactly like analytics/correlations:
 * night behaviors (bedtime, sleep) describe the night that ended on the row's date, so for
 * next-morning / next-night / next-day outcomes they come from the following row.
 * → [{ x (number|boolean), y, date }]
 */
export function driverPairs(driver, rows, { behaviors, outcomes }) {
  const b = (behaviors || []).find((x) => x.key === driver.behavior);
  const o = (outcomes || []).find((x) => x.key === driver.outcome);
  if (!b || !o) return [];
  const byDate = new Map((rows || []).map((r) => [r.date, r]));
  const out = [];
  for (const r of rows || []) {
    const y = r[o.key]; if (!isNum(y)) continue;
    const src = b.align === 'night' && o.when !== 'sameDay' ? byDate.get(addDays(r.date, 1)) : r;
    if (!src) continue;
    const v = b.value ? b.value(src) : src[b.key];
    const x = v === true || v === false ? v : isNum(v) ? v : null;
    if (x == null) continue;
    out.push({ x, y, date: r.date });
  }
  return out;
}

/** q-value label as in findDrivers() sentences: 'q<0.001', 'q=0.004', 'q=0.07'. */
export const fmtQ = (q) => (!isNum(q) ? 'q=—' : q < 0.001 ? 'q<0.001' : `q=${q < 0.01 ? q.toFixed(3) : q.toFixed(2)}`);

/** A findDrivers() sentence without its trailing "(n=…, q…)" (shown separately as tags). */
export const driverSentence = (d) => String((d && d.sentence) || '').replace(/\s*\(n=\d+, q[<=][^)]*\)\.?$/, '.');

/* --------------------------------------------------------- time of day */
const CLOCK_STEPS = [10, 15, 20, 30, 60, 90, 120, 180, 240, 360];
/** Ticks for minutes-after-midnight axes on round clock steps (≤ maxTicks + 1). */
export function clockTicks(lo, hi, maxTicks = 4) {
  if (!isNum(lo) || !isNum(hi)) return [0, 60];
  if (hi - lo < 10) { lo -= 15; hi += 15; }
  const step = CLOCK_STEPS.find((s) => (hi - lo) / s <= maxTicks) || 720;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const out = []; for (let v = a; v <= b; v += step) out.push(v);
  return out;
}
/** Clock label for minutes after midnight (bedtimes past midnight wrap): 1410 → '11:30 PM'. */
export const fmtClock = (min) => fmtTime(min);
/** Compact clock label for axis ticks: whole hours drop ':00' (480 → '8 AM', 1410 → '11:30 PM'). */
export const fmtClockAxis = (min) => (isNum(min) ? fmtTime(min).replace(':00 ', ' ') : '—');

/* ---------------------------------------------------------------- weeks */
/** Monday of the last complete Mon–Sun week before `today`. */
export const lastCompleteWeek = (today) => addDays(weekStart(today), -7);
/** 'Sep 14 – 20', 'Aug 31 – Sep 6' (year appended when it differs from `today`'s). */
export function weekLabel(monday, today) {
  const sun = addDays(monday, 6);
  const m1 = fmtDate(monday, { dow: false }), m2 = fmtDate(sun, { dow: false });
  const sameMonth = monday.slice(5, 7) === sun.slice(5, 7);
  const tail = sameMonth ? m2.split(' ')[1] : m2;
  const year = today && monday.slice(0, 4) !== today.slice(0, 4) ? ', ' + monday.slice(0, 4) : '';
  return `${m1} – ${tail}${year}`;
}

/** Share of values meeting a predicate, as a whole percent (null when none). */
export function shareOf(values, pred) {
  const v = (values || []).filter(isNum);
  return v.length ? Math.round((v.filter(pred).length / v.length) * 100) : null;
}

/** Plain count text: '1 day', '12 days'. */
export const plural = (n, word, many) => `${fmtNum(n)} ${n === 1 ? word : many || word + 's'}`;
