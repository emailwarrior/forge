// Daily readiness: baselines, band, drivers, training mode and a focus window.
import { addDays, hmToMin, minToHm, isNum, round, clamp, fmtDur } from '../core/util.js';
import { buildDaily } from './daily.js';
import { mean, sd, zscore, welch, cohensD } from './stats.js';
import { formatNumber as fmt, mergeIntervals } from './dataview.js';

const BASE_KEYS = ['hrv', 'rhr', 'sleepMin', 'recovery', 'respRate', 'skinTempC'];
const MIN_N = 7;
const signed = (v, dp = 0) => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), dp) : '—');

// { key: {mean, sd, n} } from the `window` days BEFORE `date` (the date itself is excluded).
export function baselines(daily, date, window = 30) {
  const from = addDays(date, -window);
  const rows = (daily || []).filter((r) => r && r.date >= from && r.date < date);
  const out = {};
  for (const k of BASE_KEYS) {
    const v = rows.map((r) => r[k]).filter(isNum);
    out[k] = { mean: v.length ? mean(v) : null, sd: v.length >= 2 ? sd(v) : null, n: v.length };
  }
  return out;
}

const MODES = {
  push: { label: 'Push', strainTarget: [14, 18], detail: 'Well recovered — a hard session fits today (strain 14–18).' },
  build: { label: 'Build', strainTarget: [11, 14], detail: 'Train normally — steady, productive work (strain 11–14).' },
  maintain: { label: 'Maintain', strainTarget: [8, 11], detail: 'Keep it moderate — technique and lighter volume (strain 8–11).' },
  recover: { label: 'Recover', strainTarget: [0, 8], detail: 'Zone 2 or mobility only — keep strain under 8.' },
};
const ADVICE = { push: 'a good day to push', build: 'train normally', maintain: 'keep training moderate', recover: 'prioritize recovery' };

export function readiness(dv, date = dv.asOf()) {
  return dv.memo('ready:' + date, () => compute(dv, date));
}

function compute(dv, date) {
  const rows = buildDaily(dv, addDays(date, -90), date);
  const row = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || null;
  const base = baselines(rows, date, 30);
  const targets = dv.setting('targets');
  const sl = dv.sleep(date);
  const ok = (b) => b.n >= MIN_N && isNum(b.sd);

  const hrvZ = ok(base.hrv) ? zscore(row.hrv, base.hrv.mean, base.hrv.sd) : null;
  const rhrZ = ok(base.rhr) ? zscore(row.rhr, base.rhr.mean, base.rhr.sd) : null;
  const needMin = isNum(row.sleepNeedMin) ? row.sleepNeedMin : isNum(targets.sleepTargetH) ? targets.sleepTargetH * 60 : null;
  const sleepRatio = isNum(row.sleepMin) && needMin ? row.sleepMin / needMin : null;
  const sleepDebtMin = sl && isNum(sl.needDebtMin) ? sl.needDebtMin : rollingDebt(rows, targets);
  const respDelta = isNum(row.respRate) && base.respRate.n >= MIN_N ? row.respRate - base.respRate.mean : null;
  const skinTempDelta = isNum(row.skinTempC) && base.skinTempC.n >= MIN_N ? row.skinTempC - base.skinTempC.mean : null;

  const hasData = [row.recovery, row.hrv, row.rhr, row.sleepMin].some(isNum);
  const calibrating = !ok(base.hrv) || row.calibrating === true;
  const status = !hasData ? 'no-data' : calibrating ? 'calibrating' : 'ok';

  // Score: WHOOP recovery when present, else a composite of HRV/RHR z-scores and sleep vs need.
  let score = null, scoreSource = null;
  if (isNum(row.recovery)) { score = row.recovery; scoreSource = 'whoop'; }
  else if (status === 'ok' && (isNum(hrvZ) || isNum(rhrZ))) {
    const parts = [];
    if (isNum(hrvZ)) parts.push([clamp(hrvZ, -3, 3), 1]);
    if (isNum(rhrZ)) parts.push([clamp(-rhrZ, -3, 3), 0.6]);
    if (isNum(sleepRatio)) parts.push([clamp((sleepRatio - 1) / 0.1, -3, 3), 0.6]);
    const c = parts.reduce((s, [v, w]) => s + v * w, 0) / parts.reduce((s, [, w]) => s + w, 0);
    score = clamp(Math.round(50 + 20 * c), 0, 100); scoreSource = 'composite';
  }
  const band = score == null ? null : score >= 67 ? 'green' : score >= 34 ? 'yellow' : 'red';
  const illness = isNum(respDelta) && respDelta >= 1.0 && ((isNum(skinTempDelta) && skinTempDelta >= 0.5) || (isNum(hrvZ) && hrvZ <= -1.5));

  const drivers = buildDrivers(rows, row, prev, { base, hrvZ, rhrZ, needMin, sleepRatio, sleepDebtMin });
  // Good sleep = last night covered ≥ 90% of need (WHOOP's need already includes its sleep debt).
  const goodSleep = isNum(sleepRatio) ? sleepRatio >= 0.9 : isNum(row.sleepPerf) && row.sleepPerf >= 85;
  let mode;
  if (illness || band === 'red') mode = 'recover';
  else if (band === 'green') mode = goodSleep ? 'push' : 'build';
  else if (band === 'yellow') mode = score >= 50 ? 'build' : 'maintain';
  else mode = 'build';
  const m = MODES[mode];
  const detail = illness ? 'Possible illness signs — rest, easy zone 2 or mobility only.' : band == null ? 'No readiness score yet — train by feel (strain 11–14).' : m.detail;
  const training = { mode, label: m.label, detail, strainTarget: m.strainTarget.slice() };

  const flags = [];
  if (illness) flags.push({ level: 'alert', text: `Respiratory rate ${signed(respDelta, 1)} br/min${isNum(skinTempDelta) && skinTempDelta >= 0.5 ? ` and skin temp ${signed(skinTempDelta, 1)} °C` : ' and HRV well below baseline'} vs baseline — possible illness; consider an easy day.` });
  if (status === 'no-data') flags.push({ level: 'info', text: 'No recovery or sleep data for this date yet.' });
  else if (status === 'calibrating') flags.push({ level: 'info', text: row.calibrating === true ? 'WHOOP is still calibrating.' : `Baselines are calibrating (${base.hrv.n} of ${MIN_N} days) — z-scores start after a week of data.` });
  if (isNum(hrvZ) && hrvZ <= -2) flags.push({ level: 'warn', text: 'HRV is well below your baseline.' });
  if (isNum(rhrZ) && rhrZ >= 2) flags.push({ level: 'warn', text: 'Resting HR is well above your baseline.' });
  if (isNum(row.sleepMin) && row.sleepMin < 360) flags.push({ level: 'warn', text: `Only ${fmtDur(row.sleepMin)} of sleep.` });

  const focus = focusWindow(dv, date, row, band, targets);
  const metrics = {
    recovery: row.recovery, hrv: row.hrv, hrvBase: round(base.hrv.mean, 1), hrvZ: round(hrvZ, 2),
    rhr: row.rhr, rhrBase: round(base.rhr.mean, 1), rhrZ: round(rhrZ, 2),
    sleepMin: row.sleepMin, sleepNeedMin: needMin, sleepDebtMin: isNum(sleepDebtMin) ? Math.round(sleepDebtMin) : null, sleepPerf: row.sleepPerf,
    respRate: row.respRate, respDelta: round(respDelta, 2), skinTempDelta: round(skinTempDelta, 2),
  };
  const summary = summarize(status, score, scoreSource, band, drivers, mode, illness, date === dv.asOf() ? 'today' : 'this day');
  return { date, status, band, score, scoreSource, metrics, drivers, training, focus, flags, summary };
}

// Fallback debt when WHOOP has none: shortfall vs each night's need (else the sleep
// target) summed over the last 3 nights.
function rollingDebt(rows, targets) {
  const target = isNum(targets.sleepTargetH) ? targets.sleepTargetH * 60 : null;
  const nights = rows.slice(-3).filter((r) => isNum(r.sleepMin) && (isNum(r.sleepNeedMin) || target));
  if (!nights.length) return null;
  return nights.reduce((s, r) => s + Math.max(0, (isNum(r.sleepNeedMin) ? r.sleepNeedMin : target) - r.sleepMin), 0);
}

function buildDrivers(rows, row, prev, c) {
  const out = [];
  const push = (key, label, value, text, impact, weight, phrase) => out.push({ key, label, value, text, impact, weight: round(Math.min(3, Math.max(0, weight)), 2), phrase });
  const imp = (z, lowerIsBetter = false) => { const g = lowerIsBetter ? -z : z; return g >= 0.5 ? 'positive' : g <= -0.5 ? 'negative' : 'neutral'; };
  if (isNum(c.hrvZ)) push('hrv', 'HRV', row.hrv, `HRV ${fmt(row.hrv, 0)} ms vs ${fmt(c.base.hrv.mean, 0)} baseline (${signed(c.hrvZ, 1)} SD)`, imp(c.hrvZ), Math.abs(c.hrvZ), c.hrvZ >= 0 ? 'HRV above baseline' : 'HRV below baseline');
  if (isNum(c.rhrZ)) push('rhr', 'Resting HR', row.rhr, `Resting HR ${fmt(row.rhr, 0)} bpm vs ${fmt(c.base.rhr.mean, 0)} baseline (${signed(c.rhrZ, 1)} SD)`, imp(c.rhrZ, true), Math.abs(c.rhrZ), c.rhrZ > 0 ? 'resting HR above baseline' : 'resting HR below baseline');
  if (isNum(c.sleepRatio)) {
    const r = c.sleepRatio;
    push('sleep', 'Sleep', row.sleepMin, `Slept ${fmtDur(row.sleepMin)} vs ${fmtDur(c.needMin)} need (${Math.round(r * 100)}%)`, r >= 0.95 ? 'positive' : r < 0.85 ? 'negative' : 'neutral', Math.abs(r - 1) / 0.1, r >= 0.95 ? 'sleep that met your need' : 'short sleep');
  }
  if (isNum(c.sleepDebtMin) && c.sleepDebtMin >= 45) push('sleepDebt', 'Sleep debt', Math.round(c.sleepDebtMin), `Sleep debt ${fmtDur(c.sleepDebtMin)}`, 'negative', c.sleepDebtMin / 60, 'sleep debt');
  if (prev && isNum(prev.dayStrain)) {
    const s = prev.dayStrain;
    if (s >= 16) push('priorStrain', "Yesterday's strain", s, `Yesterday's strain ${fmt(s, 1)} (high)`, 'negative', (s - 14) / 2, 'a hard day yesterday');
    else if (s <= 8) push('priorStrain', "Yesterday's strain", s, `Yesterday's strain ${fmt(s, 1)} (light)`, 'positive', 0.5, 'a light day yesterday');
  }
  if (prev && isNum(prev.alcohol) && prev.alcohol > 0) push('alcohol', 'Alcohol', prev.alcohol, `${fmt(prev.alcohol, 0)} drink${prev.alcohol === 1 ? '' : 's'} yesterday`, 'negative', 1 + prev.alcohol * 0.3, 'alcohol yesterday');
  if (prev && isNum(prev.lastMealToBedMin)) {
    const g = prev.lastMealToBedMin;
    if (g < 120) push('lateMeal', 'Late last meal', g, `Last meal ${fmtDur(g)} before bed`, 'negative', 0.5 + (120 - g) / 60, 'a late last meal');
    else if (g >= 180) push('lateMeal', 'Meal timing', g, `Last meal ${fmtDur(g)} before bed`, 'positive', 0.5, 'an early last meal');
  }
  const dose = doseEffect(rows, row);
  if (dose) push('daysSinceDose', 'Days since dose', row.daysSinceDose, dose.text, dose.diff > 0 ? 'positive' : 'negative', Math.abs(dose.d), dose.phrase);
  return out.sort((a, b) => b.weight - a.weight);
}

// Only when history shows it: does the current days-since-dose group differ from other days?
function doseEffect(rows, row) {
  if (!isNum(row.daysSinceDose) || row.daysSinceDose > 6) return null;
  const k = row.daysSinceDose;
  const hist = rows.slice(0, -1).filter((r) => isNum(r.daysSinceDose) && r.daysSinceDose <= 6);
  for (const [metric, label, unit] of [['recovery', 'recovery', ' pts'], ['hrv', 'HRV', ' ms']]) {
    const inG = hist.filter((r) => r.daysSinceDose === k && isNum(r[metric])).map((r) => r[metric]);
    const outG = hist.filter((r) => r.daysSinceDose !== k && isNum(r[metric])).map((r) => r[metric]);
    if (inG.length < 5 || outG.length < 10) continue;
    const w = welch(inG, outG); const d = cohensD(inG, outG);
    if (w.p == null || w.p >= 0.1 || !isNum(d) || Math.abs(d) < 0.4) continue;
    const day = k === 0 ? 'Dose day' : `Day ${k} after a dose`;
    return { diff: w.diff, d, text: `${day}: ${label} typically ${signed(w.diff, 0)}${unit} vs other days (n=${inG.length})`, phrase: `${k === 0 ? 'dose day' : `day ${k} after a dose`}` };
  }
  return null;
}

function summarize(status, score, scoreSource, band, drivers, mode, illness, when) {
  if (status === 'no-data') return `No recovery data for ${when} yet — train by feel and keep the plan.`;
  const head = score == null ? 'Baselines are still calibrating'
    : scoreSource === 'whoop' ? `Recovery ${score}% (${band})` : `Readiness ${score} (${band})`;
  const phrases = drivers.filter((d) => d.impact !== 'neutral' && d.phrase).slice(0, 2).map((d) => d.phrase);
  const why = phrases.length ? ` with ${phrases.join(' and ')}` : '';
  const advice = illness ? 'possible illness signs, so prioritize recovery' : ADVICE[mode];
  return `${head}${why} — ${advice}.`;
}

// First free 90–150 min window starting ~60–90 min after waking; later if meetings collide.
function focusWindow(dv, date, row, band, targets) {
  const wake = isNum(row.wakeMin) ? row.wakeMin : hmToMin(targets.wake);
  if (!isNum(wake)) return { start: null, end: null, note: 'Set a wake time to get a focus window.' };
  const busy = mergeIntervals(dv.eventBlocks(date).map((e) => [e.start, e.end]));
  const free = (s, e) => e <= 1440 && !busy.some(([a, b]) => s < b && a < e);
  const lens = band === 'red' ? [90] : [150, 120, 90];
  const q = (m) => Math.ceil(m / 15) * 15;
  const early = q(wake + 60), late = q(wake + 90);
  for (const len of lens) for (let s = early; s <= late; s += 15) if (free(s, s + len)) return mk(s, len, `~${Math.round((s - wake) / 15) * 15} min after waking${band === 'red' ? ' (kept short on a low-recovery day)' : ''}.`);
  const limit = Math.min(wake + 9 * 60, 1320);
  for (let s = late + 15; s + 90 <= limit; s += 15) for (const len of lens) if (free(s, s + len)) return mk(s, len, 'Moved later to avoid meetings.');
  return { start: null, end: null, note: 'No free 90-minute window around meetings today.' };
  function mk(s, len, note) { return { start: minToHm(s), end: minToHm(s + len), note: `${len}-min focus block ${note}` }; }
}
