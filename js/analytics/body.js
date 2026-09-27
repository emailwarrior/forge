// Body weight trend, energy-balance TDEE, calorie/macro targets and goal projection.
import { addDays, dateRange, isNum, round, clamp, LB_PER_KG } from '../core/util.js';
import { formatNumber as fmtNum, daysBetween as diffDays } from './dataview.js';
import { linreg, mean } from './stats.js';

const KCAL_PER_LB = 3500;
const byDateTime = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || '') < (b.at || '') ? -1 : (a.at || '') > (b.at || '') ? 1 : 0);

// Hacker's-Diet trend: EWMA (alpha 0.1) of one weight per day (the first weigh-in),
// carried forward unchanged over days without a weigh-in. One entry per day first→last.
export function weightTrend(weighIns, { alpha = 0.1 } = {}) {
  const byDate = new Map();
  for (const w of [...(weighIns || [])].filter((x) => x && isNum(x.weightLb) && typeof x.date === 'string').sort(byDateTime)) {
    if (!byDate.has(w.date)) byDate.set(w.date, w.weightLb);
  }
  if (!byDate.size) return [];
  const dates = [...byDate.keys()].sort();
  const out = []; let trend = null;
  for (const d of dateRange(dates[0], dates[dates.length - 1])) {
    const w = byDate.has(d) ? byDate.get(d) : null;
    if (w != null) trend = trend == null ? w : trend + alpha * (w - trend);
    out.push({ date: d, weightLb: w, trendLb: round(trend, 2) });
  }
  return out;
}

// Slope of the trend over the last `days` entries × 7 (lb/week); null with < 7 weigh-ins.
export function rateLbPerWeek(series, days = 28) {
  if (!series || !series.length) return null;
  const win = series.slice(-days);
  if (win.filter((p) => isNum(p.weightLb)).length < 7) return null;
  const { slope } = linreg(win.map((_, i) => i), win.map((p) => p.trendLb));
  return slope == null ? null : round(slope * 7, 2);
}

/* ------------------------------------------------------------ trend lookups */
export function trendSeries(dv) { return dv.memo('body:trend', () => weightTrend(dv.dailyWeights())); }
function seriesUpTo(dv, date) {
  return dv.memo('body:trendTo:' + date, () => trendSeries(dv).filter((p) => p.date <= date));
}
// Trend weight on `date` (carried up to `maxCarry` days past the last weigh-in).
export function trendAt(dv, date, maxCarry = 14) {
  const s = trendSeries(dv); if (!s.length || date < s[0].date) return null;
  const last = s[s.length - 1];
  if (date > last.date) return diffDays(last.date, date) <= maxCarry ? last.trendLb : null;
  const map = dv.memo('body:trendMap', () => new Map(s.map((p) => [p.date, p.trendLb])));
  return map.get(date) ?? null;
}
function latestWeighIn(dv, date) {
  const w = dv.dailyWeights();
  for (let i = w.length - 1; i >= 0; i--) if (w[i].date <= date) return w[i];
  return null;
}
// Best current body-weight estimate: trend, else latest weigh-in, else WHOOP body weight.
function currentWeight(dv, date) {
  const t = trendAt(dv, date); if (isNum(t)) return t;
  const w = latestWeighIn(dv, date); if (w) return w.weightLb;
  const wb = dv.whoopBody(); return wb && isNum(wb.weightLb) ? wb.weightLb : null;
}
// Days with a complete intake log (all meals analyzed), chronological: [{ date, kcal }].
function intakeDays(dv) {
  return dv.memo('body:intakeDays', () => {
    const dates = [...new Set(dv.store.all('meals').map((m) => m.date).filter((d) => typeof d === 'string'))].sort();
    const out = [];
    for (const d of dates) { const it = dv.intake(d); if (it.complete && isNum(it.totals.kcal)) out.push({ date: d, kcal: it.totals.kcal }); }
    return out;
  });
}
function between(arr, from, to) {
  let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].date < from) lo = m + 1; else hi = m; }
  const out = []; for (let i = lo; i < arr.length && arr[i].date <= to; i++) out.push(arr[i]);
  return out;
}
function weightsBetween(dv, from, to) {
  const w = dv.dailyWeights();
  let lo = 0, hi = w.length; while (lo < hi) { const m = (lo + hi) >> 1; if (w[m].date < from) lo = m + 1; else hi = m; }
  const out = []; for (let i = lo; i < w.length && w[i].date <= to; i++) out.push(w[i]);
  return out;
}

/* ------------------------------------------------------------------ TDEE */
// Energy balance over the `window` complete days before `date`:
// TDEE = mean intake (days with complete intake logs) − slope × 3500, where slope is the
// OLS trend (lb/day) of the weigh-ins in the same window. Needs ≥ minDays intake days
// and ≥ 10 weigh-ins.
export function estimateTdee(dv, date, { window = 28, minDays = 14 } = {}) {
  return dv.memo(`body:tdee:${date}:${window}:${minDays}`, () => {
    const start = addDays(date, -window), end = addDays(date, -1);
    const today = dv.asOf();
    const intakes = between(intakeDays(dv), start, end).filter((x) => x.date < today).map((x) => x.kcal);
    const weights = weightsBetween(dv, start, end);
    const n = intakes.length;
    const intakeAvg = n ? Math.round(mean(intakes)) : null;
    const lr = weights.length >= 2 ? linreg(weights.map((w) => diffDays(start, w.date)), weights.map((w) => w.weightLb)) : { slope: null };
    const trendDeltaLb = lr.slope == null ? null : round(lr.slope * window, 2);
    const base = { n, intakeAvg, trendDeltaLb, weighIns: weights.length, window, from: start, to: end };
    if (n < minDays || weights.length < 10 || lr.slope == null) {
      const need = [];
      if (n < minDays) need.push(`${minDays - n} more logged day${minDays - n === 1 ? '' : 's'}`);
      if (weights.length < 10) need.push(`${10 - weights.length} more weigh-in${10 - weights.length === 1 ? '' : 's'}`);
      return { tdee: null, method: 'insufficient', confidence: null, ...base, note: need.length ? 'Needs ' + need.join(' and ') + '.' : 'Not enough data.' };
    }
    const tdee = Math.round((mean(intakes) - lr.slope * KCAL_PER_LB) / 10) * 10;
    const completeness = n / window;
    let confidence = n >= 21 && weights.length >= 16 && completeness >= 0.75 ? 'high'
      : completeness >= 0.5 ? 'medium' : 'low';
    let note = null;
    if (tdee < 1200 || tdee > 6000) { confidence = 'low'; note = 'Estimate is outside a plausible range — check meal logging and weigh-ins.'; }
    return { tdee, method: 'energy-balance', confidence, ...base, note };
  });
}

/* ---------------------------------------------------------------- targets */
// Mifflin–St Jeor resting energy (kcal/day); null when an input is missing.
export function mifflinStJeor({ weightLb, heightIn, age, sex }) {
  if (![weightLb, heightIn, age].every(isNum)) return null;
  const s = sex === 'female' ? -161 : sex === 'male' ? 5 : -78;
  return 10 * (weightLb / LB_PER_KG) + 6.25 * (heightIn * 2.54) - 5 * age + s;
}

// Daily surplus toward the goal: rate-based (rate × 3500 / 7, clamped 100–700) while
// below the goal range, maintenance once the trend reaches it, else settings.surplusKcal.
function surplusFor(profile, targets, weight) {
  const low = profile.goalWeightLow, high = profile.goalWeightHigh, rate = profile.goalRateLbWk;
  if (isNum(low) && isNum(weight) && weight >= low) {
    const above = isNum(high) && weight > high;
    return { kcal: 0, why: above ? 'above the goal range, so no surplus' : 'in the goal range, so no surplus' };
  }
  if (isNum(rate) && rate > 0) {
    const kcal = clamp(Math.round((rate * KCAL_PER_LB) / 7), 100, 700);
    return { kcal, why: `+${kcal} kcal for +${rate} lb/wk` };
  }
  const kcal = isNum(targets.surplusKcal) ? targets.surplusKcal : 0;
  return { kcal, why: `${kcal >= 0 ? '+' : ''}${kcal} kcal surplus from settings` };
}

export function calorieTargets(dv, date) {
  return dv.memo('body:targets:' + date, () => {
    const t = dv.setting('targets'), p = dv.setting('profile');
    const weight = currentWeight(dv, date);
    const surplus = surplusFor(p, t, weight);
    let kcal = null, basis, tdee = null, rationale, tdeeInfo = null;
    if (t.mode === 'manual' && isNum(t.kcal)) {
      kcal = t.kcal; basis = 'manual'; rationale = 'Manual calorie target from settings.';
    } else {
      tdeeInfo = estimateTdee(dv, date);
      if (tdeeInfo.tdee != null) {
        tdee = tdeeInfo.tdee; kcal = tdee + surplus.kcal; basis = 'adaptive';
        rationale = `Measured TDEE ≈ ${fmtNum(tdee)} kcal (${tdeeInfo.n} logged days, ${tdeeInfo.confidence} confidence); ${surplus.why}.`;
      } else {
        basis = 'estimate';
        const age = isNum(p.birthYear) ? Number(date.slice(0, 4)) - p.birthYear : null;
        const bmr = mifflinStJeor({ weightLb: weight, heightIn: p.heightIn, age, sex: p.sex });
        if (bmr != null) {
          tdee = Math.round((bmr * 1.55) / 10) * 10; kcal = tdee + surplus.kcal;
          rationale = `Estimated TDEE ≈ ${fmtNum(tdee)} kcal (Mifflin–St Jeor × 1.55) until enough intake and weigh-ins are logged; ${surplus.why}.`;
        } else {
          rationale = 'Add height, birth year and a weigh-in (or log two weeks of meals and weigh-ins) to get a calorie target.';
        }
      }
    }
    if (kcal != null) kcal = Math.round(kcal / 10) * 10;
    const perLb = isNum(t.proteinPerLb) && isNum(weight) ? Math.round((t.proteinPerLb * weight) / 5) * 5 : null;
    const proteinG = t.mode === 'manual' && isNum(t.proteinG) ? t.proteinG : perLb ?? (isNum(t.proteinG) ? t.proteinG : null);
    const fatG = kcal != null && isNum(t.fatPct) ? Math.round((kcal * t.fatPct) / 100 / 9) : null;
    const carbsG = kcal != null && proteinG != null && fatG != null ? Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4)) : null;
    return {
      kcal, proteinG, fatG, carbsG, fiberG: isNum(t.fiberG) ? t.fiberG : null,
      basis, tdee, rationale,
      surplus: basis === 'manual' ? null : surplus.kcal, weightLb: isNum(weight) ? round(weight, 1) : null, tdeeInfo,
    };
  });
}

/* ------------------------------------------------------------- projection */
export function goalProjection(dv, date = dv.asOf()) {
  const p = dv.setting('profile');
  const low = isNum(p.goalWeightLow) ? p.goalWeightLow : null, high = isNum(p.goalWeightHigh) ? p.goalWeightHigh : null;
  const current = trendAt(dv, date);
  const ratePerWeek = rateLbPerWeek(seriesUpTo(dv, date), 28);
  const out = { currentTrendLb: current, goalLow: low, goalHigh: high, ratePerWeek, goalRate: isNum(p.goalRateLbWk) ? p.goalRateLbWk : null, etaDate: null, weeksToGoal: null, onTrack: null, note: '' };
  if (current == null) return { ...out, note: 'No recent weigh-ins.' };
  if (low == null && high == null) return { ...out, note: 'Set a goal weight range in settings.' };
  if (low != null && current < low) {
    const toGo = low - current;
    if (isNum(ratePerWeek) && ratePerWeek > 0) {
      const weeks = toGo / ratePerWeek;
      out.weeksToGoal = round(weeks, 1);
      out.etaDate = weeks <= 104 ? addDays(date, Math.ceil(weeks * 7)) : null;
    }
    out.onTrack = ratePerWeek == null ? null : out.goalRate > 0 ? ratePerWeek >= 0.75 * out.goalRate : ratePerWeek > 0;
    out.note = ratePerWeek == null ? `${round(toGo, 1)} lb below the goal range; not enough weigh-ins for a rate yet.`
      : ratePerWeek > 0 ? `${round(toGo, 1)} lb to go at ${ratePerWeek} lb/wk${out.etaDate ? '' : ' (more than two years at this rate)'}.`
      : `${round(toGo, 1)} lb below the goal range and the trend is flat or falling.`;
    return out;
  }
  if (high != null && current > high) {
    out.onTrack = null;
    if (isNum(ratePerWeek) && ratePerWeek < 0) { const weeks = (current - high) / -ratePerWeek; out.weeksToGoal = round(weeks, 1); out.etaDate = weeks <= 104 ? addDays(date, Math.ceil(weeks * 7)) : null; }
    out.note = `${round(current - high, 1)} lb above the goal range.`;
    return out;
  }
  return { ...out, weeksToGoal: 0, etaDate: date, onTrack: true, note: 'In the goal range.' };
}

export function bodySummary(dv, date = dv.asOf()) {
  return dv.memo('body:summary:' + date, () => {
    const w = latestWeighIn(dv, date);
    const trend = trendAt(dv, date);
    const at = (n) => trendAt(dv, addDays(date, -n), 0);
    const t7 = at(7), t28 = at(28);
    return {
      weight: w ? w.weightLb : null, weightDate: w ? w.date : null,
      trend,
      change7: isNum(trend) && isNum(t7) ? round(trend - t7, 2) : null,
      change28: isNum(trend) && isNum(t28) ? round(trend - t28, 2) : null,
      rate28: rateLbPerWeek(seriesUpTo(dv, date), 28),
      tdee: estimateTdee(dv, date),
      targets: calorieTargets(dv, date),
      projection: goalProjection(dv, date),
      series: seriesUpTo(dv, date),
    };
  });
}
