// Compact markdown context for AI prompts: a CSV of key daily columns plus short sections.
// Never includes credentials or integration settings; journal text only when asked.
// Protocol items are shown by their neutralLabel when one is set.
import { addDays, minToHm, isNum, round } from '../core/util.js';
import { buildDaily } from './daily.js';
import { readiness } from './readiness.js';
import { calorieTargets, bodySummary } from './body.js';
import { adherenceByStandard, resolveTarget } from './execution.js';
import { adherence as protocolAdherence, lastDoseOnOrBefore } from './protocols.js';
import { labSummary } from './labs.js';
import { strengthSummary, prs } from './strength.js';
import { findDrivers } from './correlations.js';
import { formatNumber as fmt, daysBetween } from './dataview.js';

const h = (min) => (isNum(min) ? round(min / 60, 1) : null);
const hm = (min) => (isNum(min) ? minToHm(min) : null);
const r = (v, dp = 0) => (isNum(v) ? round(v, dp) : null);
const signed = (v, dp = 0) => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), dp) : 'n/a');

const COLUMNS = [
  ['date', (x) => x.date],
  ['rec', (x) => x.recovery],
  ['hrv', (x) => r(x.hrv)],
  ['rhr', (x) => r(x.rhr)],
  ['sleep_h', (x) => h(x.sleepMin)],
  ['bed', (x) => hm(x.bedtimeMin)],
  ['strain', (x) => r(x.dayStrain, 1)],
  ['kcal', (x) => r(x.kcalIn)],
  ['prot_g', (x) => r(x.proteinG)],
  ['meal_bed_h', (x) => h(x.lastMealToBedMin)],
  ['train', (x) => (x.trainedStrength ? 'S' : '') + (x.trainedCardio ? 'C' : '')],
  ['wt_trend', (x) => r(x.weightTrendLb, 1)],
  ['exec', (x) => r(x.executionScore)],
  ['deep_h', (x) => r(x.deepWorkH, 1)],
  ['meet_h', (x) => h(x.meetingMin)],
  ['dose_d', (x) => x.daysSinceDose],
  ['alc', (x) => x.alcohol],
  ['energy', (x) => x.energy],
];
const cell = (v) => (v == null || v === '' ? '' : String(v).replace(/[,\n]/g, ' '));

function scheduleText(item) {
  const s = item.schedule || {}; const D = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = Array.isArray(s.days) && s.days.length ? s.days.map((d) => D[d]).join('/') : '';
  const when = s.type === 'daily' || !s.type ? 'daily' : s.type === 'days' ? days : s.type === 'weekly' ? (days ? `weekly (${days})` : 'weekly') : 'as needed';
  return when + (s.stack ? ` (${s.stack})` : '');
}

export function contextPack(dv, date = dv.asOf(), { days = 30, includeJournal = false } = {}) {
  const from = addDays(date, -(days - 1));
  const rows = buildDaily(dv, from, date);
  const out = [];
  out.push(`# FORGE context — ${date} (last ${days} days)`);
  out.push('From the user\'s own logs. Units: lb, kcal, g; local 24h times; blank = not logged. Patterns listed are associations, not causes.');

  // Goals & targets
  const p = dv.setting('profile'), t = dv.setting('targets');
  const body = bodySummary(dv, date); const ct = calorieTargets(dv, date);
  out.push('', '## Goals & targets');
  const goal = isNum(p.goalWeightLow) || isNum(p.goalWeightHigh) ? `${p.goalWeightLow ?? '?'}–${p.goalWeightHigh ?? '?'} lb${isNum(p.goalRateLbWk) ? ` at +${p.goalRateLbWk} lb/wk` : ''}` : 'not set';
  out.push(`- Weight: trend ${isNum(body.trend) ? fmt(body.trend, 1) + ' lb' : 'n/a'} (28-day rate ${isNum(body.rate28) ? signed(body.rate28, 2) + ' lb/wk' : 'n/a'}); goal ${goal}. ${body.projection.note}`);
  out.push(`- Nutrition: ${isNum(ct.kcal) ? fmt(ct.kcal) + ' kcal' : 'no kcal target'}, protein ${isNum(ct.proteinG) ? ct.proteinG + ' g' : 'n/a'}, fat ${isNum(ct.fatG) ? ct.fatG + ' g' : 'n/a'}, carbs ${isNum(ct.carbsG) ? ct.carbsG + ' g' : 'n/a'} (${ct.basis}). ${ct.rationale}`);
  out.push(`- Schedule: wake ${t.wake}, bed ${t.bedtime}, sleep ${t.sleepTargetH} h, caffeine by ${t.caffeineCutoff}, last meal by ${t.lastMealBy}, deep work ${t.deepWorkTargetH} h/day.`);

  // Daily CSV
  out.push('', '## Daily log (CSV)', 'Columns: rec = recovery %, bed = bedtime the night before, meal_bed_h = last meal → bedtime that night, train S/C = strength/cardio, exec = standards score %, dose_d = days since protocol dose.');
  out.push('```csv', COLUMNS.map((c) => c[0]).join(','));
  for (const row of rows) out.push(COLUMNS.map(([, f]) => cell(f(row))).join(','));
  out.push('```');

  // Readiness on the date
  const rd = readiness(dv, date);
  out.push('', '## Readiness', `- ${rd.summary} Training: ${rd.training.label} (strain ${rd.training.strainTarget.join('–')}).`);
  for (const f of rd.flags.filter((x) => x.level !== 'info')) out.push(`- ${f.level.toUpperCase()}: ${f.text}`);

  // Standards
  const adh = adherenceByStandard(dv, addDays(date, -13), date).filter((a) => a.applicableDays > 0);
  if (adh.length) {
    out.push('', '## Standards (last 14 days)');
    for (const a of adh) {
      const t = resolveTarget(dv, a.standard, date);
      const op = { '>=': '≥', '<=': '≤' }[t && t.op] || (t && t.op) || '';
      const unit = t && t.unit ? (t.unit === '%' ? '%' : ' ' + t.unit) : '';
      const tg = t && t.value != null ? ` (${op}${t.value}${unit})` : '';
      out.push(`- ${a.standard.name}${tg}: ${isNum(a.rate) ? fmt(a.rate) + '%' : 'n/a'} of ${a.knownDays} days${a.standard.required ? '' : ' (optional)'}`);
    }
  }

  // Protocols
  const prot = protocolAdherence(dv, addDays(date, -(days - 1)), date);
  if (prot.length) {
    out.push('', '## Protocol items (adherence over the window)');
    for (const x of prot) {
      const it = x.item; const label = it.neutralLabel || it.name;
      const amt = isNum(it.amount) ? ` ${it.amount}${it.unit ? ' ' + it.unit : ''}` : '';
      const last = lastDoseOnOrBefore(dv, it.id, date);
      const extra = it.kind === 'supplement' ? '' : `; last dose ${last ? `${daysBetween(last, date)} d ago` : 'none'}`;
      const kind = it.neutralLabel ? 'protocol' : it.kind || 'item';
      out.push(`- ${label}${amt}, ${scheduleText(it)}, ${kind}: ${isNum(x.rate) ? fmt(x.rate) + '%' : 'n/a'}${extra}`);
    }
  }

  // Strength
  const st = strengthSummary(dv, date);
  if (st.topLifts.length) {
    out.push('', '## Strength (e1RM = estimated 1-rep max)');
    for (const l of st.topLifts) out.push(`- ${l.name}: ${l.metric === 'e1rm' ? 'e1RM ' + fmt(l.e1rm) + ' lb' : 'best ' + fmt(l.best) + ' reps'}, 28d ${isNum(l.change28Pct) ? signed(l.change28Pct, 1) + '%' : 'n/a'}, ${l.status}`);
    const prCount = prs(dv, { since: addDays(date, -27) }).filter((x) => x.date <= date).length;
    out.push(`- Sessions in last 28 days: ${st.sessions28}; PRs in last 28 days: ${prCount}`);
  }

  // Labs
  const labs = labSummary(dv);
  if (labs.latest) {
    out.push('', `## Labs (latest panel ${labs.latest.date}; flags use the report's reference range)`);
    if (!labs.flagged.length) out.push('- No markers outside the reference range.');
    for (const f of labs.flagged) out.push(`- ${f.name}: ${f.value}${f.unit ? ' ' + f.unit : ''} (ref ${f.refLow ?? ''}–${f.refHigh ?? ''}) ${f.flag.toUpperCase()}`);
    const ch = labs.changes.filter((c) => isNum(c.pct) && Math.abs(c.pct) >= 10).slice(0, 5);
    if (ch.length) out.push(`- Largest changes vs previous panel: ${ch.map((c) => `${c.name} ${signed(c.pct, 0)}%`).join(', ')}`);
  }

  // Associations
  const drivers = dv.memo('corr:drivers90:' + date, () => findDrivers(buildDaily(dv, addDays(date, -89), date))).slice(0, 6);
  if (drivers.length) {
    out.push('', '## Patterns in the last 90 days (associations, not causes)');
    for (const d of drivers) out.push(`- ${d.sentence}`);
  }

  // Journal (opt-in)
  if (includeJournal) {
    const entries = dv.range('journal', from, date).filter((j) => j.text).slice(-10);
    if (entries.length) {
      out.push('', '## Journal (most recent)');
      for (const j of entries) out.push(`- ${j.date}: ${String(j.text).replace(/\s+/g, ' ').slice(0, 280)}`);
    }
  }
  return out.join('\n') + '\n';
}
