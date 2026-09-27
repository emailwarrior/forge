// Weekly rollup (Mon–Sun) with factual highlights and ranked focus candidates.
import { addDays, weekStart as mondayOf, isoWeek, isNum, round, fmtDur } from '../core/util.js';
import { buildDaily } from './daily.js';
import { mean } from './stats.js';
import { prs } from './strength.js';
import { adherence as nutritionAdherence } from './nutrition.js';
import { adherence as protocolAdherence } from './protocols.js';
import { trendAt, calorieTargets, goalProjection } from './body.js';
import { findDrivers } from './correlations.js';
import { formatNumber as fmt } from './dataview.js';

const AVG_KEYS = ['recovery', 'hrv', 'rhr', 'sleepMin', 'sleepNeedMin', 'sleepPerf', 'dayStrain', 'kcalIn', 'proteinG', 'executionScore', 'deepWorkH', 'planAdherence', 'energy', 'meetingMin', 'weightTrendLb'];
const DP = { recovery: 0, hrv: 1, rhr: 1, sleepMin: 0, sleepNeedMin: 0, sleepPerf: 0, dayStrain: 1, kcalIn: 0, proteinG: 0, executionScore: 0, deepWorkH: 1, planAdherence: 0, energy: 1, meetingMin: 0, weightTrendLb: 1 };
const signed = (v, dp = 0) => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), dp) : '—');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function averages(rows) {
  const out = {};
  for (const k of AVG_KEYS) out[k] = round(mean(rows.map((r) => r[k])), DP[k]);
  return out;
}

// Drivers over the 90 days ending `date` (memoized).
function driversAsOf(dv, date) {
  return dv.memo('corr:drivers90:' + date, () => findDrivers(buildDaily(dv, addDays(date, -89), date)));
}

export function weekStats(dv, weekStart) {
  const from = mondayOf(weekStart), to = addDays(from, 6);
  return dv.memo('weekly:' + from, () => {
    const today = dv.asOf();
    const end = to > today ? today : to;
    const rows = from <= end ? buildDaily(dv, from, end) : [];
    const prevRows = buildDaily(dv, addDays(from, -7), addDays(from, -1));
    const avg = averages(rows), prevAvg = averages(prevRows);
    const deltas = {};
    for (const k of AVG_KEYS) deltas[k] = isNum(avg[k]) && isNum(prevAvg[k]) ? round(avg[k] - prevAvg[k], DP[k]) : null;

    const logged = rows.filter((r) => [r.recovery, r.sleepMin, r.mealsCount, r.energy, r.executionScore].some((v) => v != null) || r.sessionSets > 0);
    const rank = (r) => [r.executionScore ?? -1, r.recovery ?? -1];
    const scored = rows.filter((r) => isNum(r.executionScore) || isNum(r.recovery));
    const cmp = (a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; };
    const pick = (r) => (r ? { date: r.date, executionScore: r.executionScore, recovery: r.recovery } : null);
    const best = scored.length ? pick(scored.reduce((a, b) => (cmp(b, a) > 0 ? b : a))) : null;
    const worst = scored.length ? pick(scored.reduce((a, b) => (cmp(b, a) < 0 ? b : a))) : null;

    let sessions = 0; for (const r of rows) sessions += dv.sessions(r.date).length;
    const sets = rows.reduce((s, r) => s + (r.sessionSets || 0), 0);
    const prList = from <= end ? prs(dv, { since: from }).filter((p) => p.date <= end) : [];
    const tEnd = trendAt(dv, end), tStart = trendAt(dv, addDays(from, -1));
    const weightChange = isNum(tEnd) && isNum(tStart) ? round(tEnd - tStart, 2) : null;

    const nut = from <= end ? nutritionAdherence(dv, from, end) : { days: 0, proteinHitRate: null, kcalHitRate: null };
    const supp = from <= end ? protocolAdherence(dv, from, end).filter((x) => x.item.kind === 'supplement' && x.scheduled > 0) : [];
    const sched = supp.reduce((s, x) => s + x.scheduled, 0), taken = supp.reduce((s, x) => s + x.taken, 0);
    const adherence = { protein: nut.proteinHitRate, kcal: nut.kcalHitRate, stack: sched ? round((taken / sched) * 100, 0) : null };
    const perfectDays = rows.filter((r) => r.perfect === true).length;

    const ex = dv.exercises();
    const highlights = [];
    if (sessions) highlights.push(`${plural(sessions, 'training session')}, ${fmt(sets)} hard sets`);
    if (prList.length) {
      const top = prList.filter((p) => p.type !== 'weight').slice(-2).map((p) => `${ex.get(p.exerciseId)?.name || p.exerciseId} ${p.type === 'reps' ? fmt(p.value) + ' reps' : 'e1RM ' + fmt(p.value) + ' lb'}`);
      highlights.push(`${plural(prList.length, 'PR')}${top.length ? ': ' + top.join(', ') : ''}`);
    }
    if (isNum(avg.recovery)) highlights.push(`Recovery averaged ${fmt(avg.recovery)}${isNum(deltas.recovery) ? ` (${signed(deltas.recovery)} vs prior week)` : ''}`);
    if (isNum(avg.sleepMin)) highlights.push(`Sleep averaged ${fmtDur(avg.sleepMin)}`);
    if (isNum(weightChange)) highlights.push(`Weight trend ${signed(weightChange, 1)} lb`);
    if (perfectDays) highlights.push(`${plural(perfectDays, 'perfect day')}`);
    if (nut.days && isNum(nut.proteinHitRate)) highlights.push(`Protein target hit ${nut.proteinHits}/${nut.days} logged days`);

    const focusCandidates = rankFocus(dv, { rows, avg, nut, end });
    return {
      week: isoWeek(from), from, to, complete: to < today, daysLogged: logged.length,
      averages: avg, deltas, best, worst, perfectDays,
      training: { sessions, sets, prs: prList.length, prList },
      weightChange, adherence, highlights, focusCandidates,
    };
  });
}

// Biggest gaps vs targets first. gap is a 0–1 severity used for ranking.
function rankFocus(dv, { rows, avg, nut, end }) {
  const c = [];
  if (nut.days >= 3 && isNum(nut.proteinHitRate) && nut.proteinHitRate < 80) {
    const tgt = isNum(nut.avgProteinVsTarget) && isNum(nut.avgProtein) ? ` vs ${fmt(nut.avgProtein - nut.avgProteinVsTarget)} g target` : '';
    c.push({ key: 'protein', text: 'Hit the protein target on more days', reason: `Protein target met on ${nut.proteinHits} of ${nut.days} logged days (avg ${fmt(nut.avgProtein)} g${tgt}).`, gap: round((100 - nut.proteinHitRate) / 100, 2) });
  }
  const t = dv.setting('targets');
  const need = isNum(avg.sleepNeedMin) ? avg.sleepNeedMin : isNum(t.sleepTargetH) ? t.sleepTargetH * 60 : null;
  if (isNum(avg.sleepMin) && isNum(need) && need - avg.sleepMin >= 20) {
    c.push({ key: 'sleep', text: 'Protect sleep time', reason: `Averaged ${fmtDur(avg.sleepMin)} of sleep vs ${fmtDur(need)} needed.`, gap: round(Math.min(1, (need - avg.sleepMin) / 60), 2) });
  }
  if (isNum(avg.planAdherence) && avg.planAdherence < 85) {
    c.push({ key: 'plan', text: 'Execute the plan as written', reason: `Plan adherence averaged ${fmt(avg.planAdherence)}%.`, gap: round((100 - avg.planAdherence) / 100, 2) });
  }
  const target = calorieTargets(dv, end).kcal;
  if (nut.days >= 3 && isNum(nut.avgVsTarget) && isNum(target) && nut.avgVsTarget < -0.05 * target) {
    const pct = (-nut.avgVsTarget / target) * 100;
    c.push({ key: 'intake', text: 'Eat to the calorie target', reason: `Averaged ${fmt(-nut.avgVsTarget)} kcal/day (${fmt(pct)}%) under target.`, gap: round(Math.min(1, pct / 20), 2) });
  }
  const proj = goalProjection(dv, end);
  if (proj.onTrack === false && isNum(proj.ratePerWeek) && isNum(proj.goalRate)) {
    c.push({ key: 'weight', text: 'Get weight gain back on pace', reason: `Trend ${signed(proj.ratePerWeek, 2)} lb/wk vs a +${proj.goalRate} lb/wk goal.`, gap: round(Math.min(1, Math.max(0.3, (proj.goalRate - proj.ratePerWeek) / Math.max(proj.goalRate, 0.1))), 2) });
  }
  const drv = driversAsOf(dv, end).find((d) => d.direction === 'hurts' || d.direction === 'helps');
  if (drv) c.push({ key: 'driver:' + drv.behavior + ':' + drv.outcome, text: 'Act on your strongest pattern', reason: drv.sentence, gap: { strong: 0.6, moderate: 0.45, weak: 0.3 }[drv.strength] });
  // Ties (e.g. two saturated gaps) go to the more foundational habit.
  const PRIORITY = ['sleep', 'protein', 'intake', 'weight', 'plan', 'driver'];
  const rank = (x) => { const i = PRIORITY.indexOf(x.key.split(':')[0]); return i < 0 ? PRIORITY.length : i; };
  return c.sort((a, b) => b.gap - a.gap || rank(a) - rank(b)).slice(0, 5);
}
