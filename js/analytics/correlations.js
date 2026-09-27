// Behavior → outcome associations over DailyRows. Associations only — never causal claims.
// Continuous behaviors: Spearman rho. Binary behaviors: Welch t-test. Tests are stratified
// by weekday vs weekend (within-stratum statistics pooled) so day-of-week patterns —
// meetings, late weekend nights, weekend alcohol — do not masquerade as drivers.
// Benjamini–Hochberg across every pair that was tested.
import { addDays, isNum, round, fmtTime } from '../core/util.js';
import { spearman, corrP, variance, mean, median, normalCdf, tTwoSided, benjaminiHochberg } from './stats.js';
import { formatNumber as fmt, dowOf } from './dataview.js';

const NEXT = ['nextRecovery', 'nextHrv', 'nextRhr', 'nextSleepMin', 'nextSleepPerf', 'nextEnergy'];
const SAME = ['deepWorkH', 'executionScore'];

const hrs = (m) => { const h = m / 60; return (Number.isInteger(h) ? String(h) : fmt(h, 1)) + 'h'; };
const clock = (m, op) => `${op === '≥' ? 'at or after' : 'after'} ${fmtTime(m)}`;

// when: morning = the next morning's recovery metrics; night = the following night's sleep;
// nextDay = the next day's check-in; sameDay = the same calendar day.
export const OUTCOMES = [
  { key: 'nextRecovery', label: 'recovery', when: 'morning', dp: 0, lowerIsBetter: false, text: (s) => `${s} pts recovery` },
  { key: 'nextHrv', label: 'HRV', when: 'morning', dp: 0, lowerIsBetter: false, text: (s) => `${s} ms HRV` },
  { key: 'nextRhr', label: 'resting HR', when: 'morning', dp: 1, lowerIsBetter: true, text: (s) => `${s} bpm resting HR` },
  { key: 'nextSleepMin', label: 'sleep', when: 'night', dp: 0, lowerIsBetter: false, text: (s) => `${s} min of sleep` },
  { key: 'nextSleepPerf', label: 'sleep performance', when: 'night', dp: 0, lowerIsBetter: false, text: (s) => `${s} pts sleep performance` },
  { key: 'nextEnergy', label: 'energy', when: 'nextDay', dp: 1, lowerIsBetter: false, text: (s) => `${s} energy (1–5)` },
  { key: 'deepWorkH', label: 'deep work', when: 'sameDay', dp: 1, lowerIsBetter: false, text: (s) => `${s} h deep work` },
  { key: 'executionScore', label: 'execution score', when: 'sameDay', dp: 0, lowerIsBetter: false, text: (s) => `${s} pts execution score` },
];

// align 'day': the behavior happens on the row's date. align 'night': it describes the night
// that ended on the row's date, so next-morning/night/next-day outcomes use the next row's value.
// subject(t, op) names the "high" group (op is '≥', or '>' when splitting any-vs-none).
export const BEHAVIORS = [
  { key: 'lastMealToBedMin', label: 'time from last meal to bed', type: 'continuous', align: 'day', step: 30, outcomes: NEXT, subject: (t, op) => `Nights with your last meal ${op}${hrs(t)} before bed` },
  { key: 'lastMealMin', label: 'last meal time', type: 'continuous', align: 'day', step: 30, outcomes: NEXT, subject: (t, op) => `Days with your last meal ${clock(t, op)}` },
  { key: 'caffeineLastMin', label: 'last caffeine time', type: 'continuous', align: 'day', step: 30, outcomes: NEXT, subject: (t, op) => `Days with caffeine ${clock(t, op)}` },
  { key: 'alcohol', label: 'alcohol', type: 'binary', align: 'day', outcomes: NEXT, value: (r) => (isNum(r.alcohol) ? r.alcohol > 0 : null), subject: () => 'Days with alcohol' },
  { key: 'bedtimeMin', label: 'bedtime', type: 'continuous', align: 'night', step: 30, outcomes: [...NEXT, ...SAME], subject: (t, op) => `Nights with bedtime ${clock(t, op)}` },
  { key: 'lateWorkout', label: 'late workout', type: 'binary', align: 'day', outcomes: NEXT, value: (r) => (r.workoutCount == null ? null : isNum(r.lastWorkoutEndMin) ? r.lastWorkoutEndMin > 1170 : false), subject: () => 'Days with a workout ending after 7:30 PM' },
  { key: 'dayStrain', label: 'day strain', type: 'continuous', align: 'day', step: 1, outcomes: NEXT, subject: (t, op) => `Days with strain ${op}${fmt(t, t % 1 ? 1 : 0)}` },
  { key: 'kcalIn', label: 'calories eaten', type: 'continuous', align: 'day', step: 250, outcomes: NEXT, subject: (t, op) => `Days eating ${op}${fmt(t)} kcal` },
  { key: 'proteinG', label: 'protein', type: 'continuous', align: 'day', step: 10, outcomes: NEXT, subject: (t, op) => `Days with ${op}${fmt(t)} g protein` },
  { key: 'carbsG', label: 'carbs', type: 'continuous', align: 'day', step: 25, outcomes: NEXT, subject: (t, op) => `Days with ${op}${fmt(t)} g carbs` },
  { key: 'deepWorkH', label: 'deep work', type: 'continuous', align: 'day', step: 0.5, outcomes: NEXT, subject: (t, op) => `Days with ${op}${fmt(t, t % 1 ? 1 : 0)} h deep work` },
  { key: 'meetingMin', label: 'meeting time', type: 'continuous', align: 'day', step: 30, outcomes: [...NEXT, ...SAME], subject: (t, op) => (op === '>' && t === 0 ? 'Days with meetings' : `Days with ${op}${hrs(t)} of meetings`) },
  { key: 'afterHoursMeetingMin', label: 'after-hours meetings', type: 'continuous', align: 'day', step: 15, outcomes: [...NEXT, ...SAME], subject: (t, op) => (op === '>' && t === 0 ? 'Days with after-hours meetings' : `Days with ${op}${fmt(t)} min of after-hours meetings`) },
  { key: 'daysSinceDose', label: 'days since dose', type: 'continuous', align: 'day', step: 1, outcomes: [...NEXT, ...SAME], subject: (t, op) => (op === '>' && t === 0 ? 'Days other than dose days' : `Days ${op}${fmt(t)} day${t === 1 ? '' : 's'} after a dose`) },
  { key: 'sleepMin', label: 'sleep', type: 'continuous', align: 'night', step: 30, outcomes: ['nextEnergy', ...SAME], subject: (t, op) => `Nights with ${op}${hrs(t)} of sleep` },
];

const WHEN = {
  day: { morning: 'next morning', night: 'that night', nextDay: 'the next day', sameDay: 'that day' },
  night: { morning: 'next morning', night: 'that night', nextDay: 'the next day', sameDay: 'the next day' },
};
const TIER = { strong: 3, moderate: 2, weak: 1 };
const strengthOf = (method, size) => {
  const a = Math.abs(size);
  const [w, m, s] = method === 'spearman' ? [0.2, 0.35, 0.5] : [0.3, 0.5, 0.8];
  return a >= s ? 'strong' : a >= m ? 'moderate' : a >= w ? 'weak' : null;
};
const qText = (q) => (q < 0.001 ? 'q<0.001' : `q=${q < 0.01 ? q.toFixed(3) : q.toFixed(2)}`);
const signedFmt = (v, dp) => { let d = dp; while (d < 3 && Number(Math.abs(v).toFixed(d)) === 0) d++; return (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), d); };
const roundStep = (v, step) => Math.round(v / step) * step;

// Behavior value for a row/outcome pair, honoring alignment.
function behaviorValue(b, row, next, outcome) {
  const src = b.align === 'night' && outcome.when !== 'sameDay' ? next : row;
  if (!src) return null;
  const v = b.value ? b.value(src) : src[b.key];
  return v === true || v === false ? v : isNum(v) ? v : null;
}

// High/low split used to express a continuous association in outcome units.
function splitFor(b, xs) {
  const minG = Math.max(5, Math.ceil(0.25 * xs.length));
  const test = (t, op) => {
    if (!isNum(t)) return null;
    const hi = xs.filter((v) => (op === '>' ? v > t : v >= t)).length;
    return Math.min(hi, xs.length - hi) >= minG ? { t, op } : null;
  };
  const med = median(xs);
  return test(roundStep(med, b.step), '≥') || test(med, '≥') || test(Math.min(...xs), '>') || null;
}

// Day type used for stratification: same-day outcomes use the row's own day; next-morning
// and next-night outcomes use the evening's type (Fri/Sat nights precede a weekend day).
function stratumOf(r, o) {
  const dow = dowOf(r.date);
  const weekend = o.when === 'sameDay' ? dow >= 5 : dow === 4 || dow === 5;
  return weekend ? 'weekend' : 'weekday';
}

// Pairs (x, y, stratum) for one behavior/outcome over rows keyed by date.
function collect(b, o, rows, byDate, stratify) {
  const xs = [], ys = [], ss = [];
  for (const r of rows) {
    const y = r[o.key]; if (!isNum(y)) continue;
    const next = b.align === 'night' ? byDate.get(addDays(r.date, 1)) : null;
    const x = behaviorValue(b, r, next, o); if (x == null) continue;
    xs.push(x); ys.push(y); ss.push(stratify ? stratumOf(r, o) : 'all');
  }
  return { xs, ys, ss };
}
const strataOf = (ss) => { const m = new Map(); ss.forEach((s, i) => { if (!m.has(s)) m.set(s, []); m.get(s).push(i); }); return [...m.values()]; };
const pick = (arr, idx) => idx.map((i) => arr[i]);

// Within-stratum Spearman rhos pooled with Fisher z (weights n−3, Spearman SE factor 1.06).
// A single usable stratum falls back to the usual t-approximation p-value.
function pooledSpearman(xs, ys, ss) {
  let wz = 0, w = 0, n = 0; const used = [];
  for (const idx of strataOf(ss)) {
    if (idx.length < 5) continue;
    const r = spearman(pick(xs, idx), pick(ys, idx)); if (!isNum(r)) continue;
    wz += (idx.length - 3) * Math.atanh(Math.max(-0.9999, Math.min(0.9999, r))); w += idx.length - 3; n += idx.length; used.push(idx);
  }
  if (!w) return null;
  const z = wz / w;
  const p = used.length === 1 ? corrP(Math.tanh(z), n) : 2 * normalCdf(-Math.abs(z) / Math.sqrt(1.06 / w));
  return { rho: Math.tanh(z), p, n, used };
}

// Pooled within-stratum mean difference (yes − no). Stratum weights depend only on group
// sizes (n1·n2/(n1+n2)), not on estimated variances, which keeps small strata from making
// the test anti-conservative; variance and Satterthwaite df follow from those fixed weights.
// With one stratum this is exactly Welch's t-test.
function pooledWelch(xs, ys, ss) {
  const parts = [];
  for (const idx of strataOf(ss)) {
    const yes = [], no = [];
    for (const i of idx) (xs[i] ? yes : no).push(ys[i]);
    if (yes.length < 2 || no.length < 2) continue;
    const s1 = variance(yes), s2 = variance(no); const v1 = s1 / yes.length, v2 = s2 / no.length;
    if (!(v1 + v2 > 0)) continue;
    parts.push({ d: mean(yes) - mean(no), v1, v2, s1, s2, n1: yes.length, n2: no.length, w: (yes.length * no.length) / (yes.length + no.length), yes, no });
  }
  if (!parts.length) return null;
  const W = parts.reduce((a, x) => a + x.w, 0);
  const diff = parts.reduce((a, x) => a + x.w * x.d, 0) / W;
  const se2 = parts.reduce((a, x) => a + (x.w / W) ** 2 * (x.v1 + x.v2), 0);
  const dfDen = parts.reduce((a, x) => { const c2 = (x.w / W) ** 2; return a + c2 * c2 * ((x.v1 * x.v1) / (x.n1 - 1) + (x.v2 * x.v2) / (x.n2 - 1)); }, 0);
  const df = dfDen > 0 ? (se2 * se2) / dfDen : null;
  const sp2 = parts.reduce((a, x) => a + (x.n1 - 1) * x.s1 + (x.n2 - 1) * x.s2, 0) / parts.reduce((a, x) => a + x.n1 + x.n2 - 2, 0);
  return {
    diff, p: df ? tTwoSided(diff / Math.sqrt(se2), df) : null, d: sp2 > 0 ? diff / Math.sqrt(sp2) : null,
    nYes: parts.reduce((a, x) => a + x.n1, 0), nNo: parts.reduce((a, x) => a + x.n2, 0),
    yes: parts.flatMap((x) => x.yes), no: parts.flatMap((x) => x.no), strata: parts.length,
  };
}

// Stratum-weighted difference in mean outcome between the high and low behavior groups.
function pooledSplitEffect(xs, ys, used, split) {
  let wd = 0, w = 0; const hiAll = [], loAll = [];
  for (const idx of used) {
    const hi = [], lo = [];
    for (const i of idx) ((split.op === '>' ? xs[i] > split.t : xs[i] >= split.t) ? hi : lo).push(ys[i]);
    hiAll.push(...hi); loAll.push(...lo);
    if (hi.length < 2 || lo.length < 2) continue;
    const wt = 1 / (1 / hi.length + 1 / lo.length);
    wd += wt * (mean(hi) - mean(lo)); w += wt;
  }
  return { effect: w ? wd / w : null, hi: hiAll, lo: loAll };
}

function testPair(b, o, xs, ys, ss, minN) {
  if (xs.length < minN) return null;
  if (b.type === 'binary') {
    const t = pooledWelch(xs, ys, ss);
    if (!t || t.p == null || !isNum(t.d) || t.nYes < 7 || t.nNo < 7 || t.nYes + t.nNo < minN) return null;
    return { method: 'welch', n: t.nYes + t.nNo, p: t.p, size: t.d, d: round(t.d, 2), effect: t.diff, stratified: t.strata > 1, groups: { hi: { n: t.nYes, mean: round(mean(t.yes), 2) }, lo: { n: t.nNo, mean: round(mean(t.no), 2) } }, split: null };
  }
  const c = pooledSpearman(xs, ys, ss);
  if (!c || c.n < minN) return null;
  const split = splitFor(b, c.used.flatMap((idx) => pick(xs, idx)));
  if (!split) return null;
  const e = pooledSplitEffect(xs, ys, c.used, split);
  if (!isNum(e.effect) || e.effect === 0 || Math.sign(e.effect) !== Math.sign(c.rho)) return null;
  return { method: 'spearman', n: c.n, p: c.p, size: c.rho, rho: round(c.rho, 3), effect: e.effect, stratified: c.used.length > 1, groups: { hi: { n: e.hi.length, mean: round(mean(e.hi), 2) }, lo: { n: e.lo.length, mean: round(mean(e.lo), 2) } }, split };
}

export function findDrivers(daily, { minN = 21, maxQ = 0.1, stratify = true } = {}) {
  const rows = (daily || []).filter((r) => r && r.date);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const outcomes = new Map(OUTCOMES.map((o) => [o.key, o]));
  const tested = [];
  for (const b of BEHAVIORS) {
    for (const ok of b.outcomes) {
      const o = outcomes.get(ok); if (!o || o.key === b.key) continue;
      const { xs, ys, ss } = collect(b, o, rows, byDate, stratify);
      const t = testPair(b, o, xs, ys, ss, minN);
      if (t && isNum(t.p)) tested.push({ b, o, ...t });
    }
  }
  const qs = benjaminiHochberg(tested.map((t) => t.p));
  const out = [];
  tested.forEach((t, i) => {
    const q = qs[i];
    const strength = strengthOf(t.method, t.size);
    if (q == null || q > maxQ || !strength) return;
    const good = t.o.lowerIsBetter ? t.effect < 0 : t.effect > 0;
    const effectText = `${t.o.text(signedFmt(t.effect, t.o.dp))} ${WHEN[t.b.align][t.o.when]}`;
    const subject = t.b.type === 'binary' ? t.b.subject() : t.b.subject(t.split.t, t.split.op);
    out.push({
      behavior: t.b.key, outcome: t.o.key, method: t.method,
      effect: round(t.effect, t.o.dp + 1), effectText, n: t.n, p: t.p, q,
      direction: good ? 'helps' : 'hurts', strength,
      sentence: `${subject} are associated with ${effectText} (n=${t.n}, ${qText(q)}).`,
      rho: t.rho ?? null, d: t.d ?? null, stratified: !!t.stratified,
      threshold: t.split ? { value: round(t.split.t, 2), op: t.split.op } : null,
      groups: t.groups,
    });
  });
  const size = (x) => Math.abs(x.method === 'spearman' ? x.rho : x.d / 1.6);
  return out.sort((a, b) => TIER[b.strength] - TIER[a.strength] || a.q - b.q || size(b) - size(a));
}

// How much paired data exists for driver analysis.
export function dataSufficiency(daily, { minN = 21 } = {}) {
  const rows = (daily || []).filter((r) => r && r.date);
  const has = (r, keys) => keys.some((k) => r[k] != null);
  const days = rows.filter((r) => has(r, ['recovery', 'sleepMin', 'kcalIn', 'executionScore', 'energy'])).length;
  const behaviorKeys = ['kcalIn', 'lastMealMin', 'caffeineLastMin', 'alcohol', 'dayStrain', 'deepWorkH', 'meetingMin', 'bedtimeMin'];
  const paired = rows.filter((r) => has(r, ['nextRecovery', 'nextHrv', 'nextSleepMin']) && has(r, behaviorKeys));
  const pairedDays = paired.length;
  const last = rows.length ? rows[rows.length - 1].date : null;
  let readyAt = null, message;
  if (pairedDays >= minN) {
    readyAt = paired[minN - 1].date;
    message = `${pairedDays} paired days — enough to look for patterns (associations, not causes).`;
  } else {
    readyAt = last ? addDays(last, minN - pairedDays) : null;
    message = `${pairedDays} of ${minN} paired days logged — patterns unlock after ${minN - pairedDays} more day${minN - pairedDays === 1 ? '' : 's'} of logs.`;
  }
  return { days, pairedDays, readyAt, minN, message };
}
