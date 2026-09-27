// FORGE AI layer: daily nutrition review, weekly review, morning brief.
// Numbers that can be computed (sums, % of target) are computed here and handed to the model;
// the model applies the rubric and writes. Structured outputs for the reviews, plain text for the brief.
import { callClaude, callClaudeJson, textOf, DEFAULT_FAST_MODEL } from './claude.js';
import { AIError } from './errors.js';
import { NUTRITION_REVIEW_SCHEMA, WEEKLY_REVIEW_SCHEMA } from './schemas.js';
import {
  nutritionReviewSystemPrompt, weeklyReviewSystemPrompt, morningBriefSystemPrompt,
  clip, compact, fmtN, hhmm, textList,
} from './prompts.js';
import { mealTotals } from './meal.js';
import { NUTRIENT_KEYS, NUTRIENT_UNITS } from '../core/schema.js';

const isNum = (v) => typeof v === 'number' && isFinite(v);
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function dowOf(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return DOW[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}
const list = (arr, max) => textList(arr, { max, len: 400 });
const common = (opts) => ({ signal: opts.signal, onProgress: opts.onProgress });

/* --------------------------------------------------------- nutrition day */

/**
 * nutritionReview(ai, { date, meals, totals, targets, rules, training, bodyTrend, protocolNotes, model?, signal? })
 * → { score (0–100), headline, wins, gaps, tomorrow, flags, model, costUsd, costEstimated, usage }
 */
export async function nutritionReview(ai, opts = {}) {
  const { date, meals = [], targets = {}, rules, training, bodyTrend, protocolNotes } = opts;
  const mealList = (Array.isArray(meals) ? meals : []).filter((m) => m && !m._d);
  const totals = opts.totals && typeof opts.totals === 'object' ? opts.totals : mealTotals(mealList.map((m) => m.totals || mealTotals(m.items)));
  const L = [];
  L.push(`Date: ${date || 'unknown'}${dowOf(date) ? ' (' + dowOf(date) + ')' : ''}`);
  L.push('Totals: ' + nutrientLine(totals));
  const t = targets || {};
  const tgt = [];
  if (isNum(t.kcal)) tgt.push(`${fmtN(t.kcal)} kcal`);
  if (isNum(t.proteinG)) tgt.push(`protein ${fmtN(t.proteinG)} g`);
  if (isNum(t.carbsG)) tgt.push(`carbs ${fmtN(t.carbsG)} g`);
  if (isNum(t.fatG)) tgt.push(`fat ${fmtN(t.fatG)} g`);
  if (isNum(t.fiberG)) tgt.push(`fiber ${fmtN(t.fiberG)} g`);
  L.push('Targets: ' + (tgt.length ? tgt.join(' · ') : 'none set'));
  const vs = [];
  const cmp = (label, actual, target, unit) => {
    if (!isNum(actual) || !isNum(target) || target <= 0) return;
    const diff = actual - target;
    vs.push(`${label} ${Math.round((actual / target) * 100)}% (${diff >= 0 ? '+' : '−'}${fmtN(Math.abs(diff))}${unit})`);
  };
  cmp('kcal', totals.kcal, t.kcal, '');
  cmp('protein', totals.protein, t.proteinG, ' g');
  cmp('carbs', totals.carbs, t.carbsG, ' g');
  cmp('fat', totals.fat, t.fatG, ' g');
  cmp('fiber', totals.fiber, t.fiberG, ' g');
  if (vs.length) L.push('Vs target (computed): ' + vs.join(' · '));
  L.push(`Meals logged: ${mealList.length}`);
  for (const m of mealList.slice(0, 12)) L.push(mealLine(m));
  const r = list(rules, 15);
  if (r.length) L.push('', 'Rules:', ...r.map((x) => '- ' + x));
  const tr = compact(training);
  if (tr) L.push('', 'Training: ' + tr);
  const bt = compact(bodyTrend);
  if (bt) L.push('Body trend: ' + bt);
  const pn = list(protocolNotes, 10);
  if (pn.length) L.push('Protocol notes (context only): ' + pn.join(' | '));

  const { data, res } = await callClaudeJson(ai, {
    model: opts.model || (ai && ai.model),
    system: nutritionReviewSystemPrompt(),
    messages: [{ role: 'user', content: L.join('\n') }],
    outputFormat: { type: 'json_schema', schema: NUTRITION_REVIEW_SCHEMA },
    maxTokens: 8000,
    ...common(opts),
  });
  const score = Math.round(Number(data.score));
  return {
    score: isFinite(score) ? Math.max(0, Math.min(100, score)) : null,
    headline: clip(data.headline, 300),
    wins: list(data.wins, 3),
    gaps: list(data.gaps, 3),
    tomorrow: list(data.tomorrow, 3),
    flags: list(data.flags, 5),
    model: res.model, costUsd: res.costUsd, costEstimated: res.costEstimated, usage: res.usage,
  };
}

/** Alias: docs/ARCHITECTURE.md §10 calls this reviewNutritionDay(). */
export const reviewNutritionDay = nutritionReview;

function nutrientLine(t) {
  if (!t) return 'none';
  return NUTRIENT_KEYS.filter((k) => isNum(t[k])).map((k) => `${k} ${fmtN(t[k], 1)}${k === 'kcal' ? '' : ' ' + NUTRIENT_UNITS[k]}`).join(' · ') || 'none';
}
function mealLine(m) {
  const t = m.totals || mealTotals(m.items);
  const head = [hhmm(m.at), m.slot].filter(Boolean).join(' ');
  const title = clip(m.title || m.name || (Array.isArray(m.items) && m.items[0] && m.items[0].name) || 'meal', 60);
  const items = Array.isArray(m.items) ? m.items.slice(0, 8).map((i) => `${clip(i.name, 50)}${isNum(i.grams) && i.grams ? ' ' + Math.round(i.grams) + ' g' : ''}`).join('; ') : '';
  return `- ${head ? head + ' ' : ''}${title}: ${fmtN(t.kcal)} kcal · P ${fmtN(t.protein, 1)} · C ${fmtN(t.carbs, 1)} · F ${fmtN(t.fat, 1)} · fiber ${fmtN(t.fiber, 1)}${items ? ' — ' + items : ''}${m.note ? ` (note: ${clip(m.note, 120)})` : ''}`;
}

/* ---------------------------------------------------------------- weekly */

/**
 * weeklyReview(ai, { stats, drivers, goals, lastFocus, model?, signal? })
 * → { headline, summary, whatWorked, whatDidnt, focus:{ title, why, how }, model, costUsd, costEstimated, usage }
 */
export async function weeklyReview(ai, opts = {}) {
  const { stats, drivers, goals, lastFocus } = opts;
  if (!stats || typeof stats !== 'object') throw new AIError('bad-request', 'weeklyReview needs week statistics.');
  const L = [];
  L.push(`Week: ${stats.week || ''}${stats.from ? ` (${stats.from} to ${stats.to || ''})` : ''}`.trim());
  L.push('Statistics (computed): ' + compact(stats));
  const drv = (Array.isArray(drivers) ? drivers : []).slice(0, 12).map((d) => {
    if (typeof d === 'string') return '- ' + clip(d, 300);
    if (!d || typeof d !== 'object') return '';
    const meta = [isNum(d.n) ? `n=${d.n}` : '', d.strength || '', isNum(d.q) ? `q=${Math.round(d.q * 1000) / 1000}` : ''].filter(Boolean).join(', ');
    return `- ${clip(d.sentence || [d.behavior, d.direction, d.outcome].filter(Boolean).join(' '), 300)}${meta ? ` (${meta})` : ''}`;
  }).filter(Boolean);
  L.push('', drv.length ? 'Associations found in this user\'s data (not causal):' : 'No statistically supported associations yet.', ...drv);
  const g = typeof goals === 'string' ? clip(goals, 600) : compact(goals);
  if (g) L.push('', 'Goals: ' + g);
  if (lastFocus) {
    const lf = typeof lastFocus === 'string' ? clip(lastFocus, 400) : compact(lastFocus);
    if (lf) L.push('', "Last week's focus: " + lf);
  }
  const { data, res } = await callClaudeJson(ai, {
    model: opts.model || (ai && ai.model),
    system: weeklyReviewSystemPrompt(),
    messages: [{ role: 'user', content: L.join('\n') }],
    outputFormat: { type: 'json_schema', schema: WEEKLY_REVIEW_SCHEMA },
    maxTokens: 8000,
    ...common(opts),
  });
  const f = data.focus && typeof data.focus === 'object' ? data.focus : {};
  return {
    headline: clip(data.headline, 300),
    summary: clip(data.summary, 1500),
    whatWorked: list(data.whatWorked, 4),
    whatDidnt: list(data.whatDidnt, 4),
    focus: { title: clip(f.title, 80), why: clip(f.why, 400), how: list(f.how, 4) },
    model: res.model, costUsd: res.costUsd, costEstimated: res.costEstimated, usage: res.usage,
  };
}

/* --------------------------------------------------------- morning brief */

/**
 * morningBrief(ai, { readiness, plan, events, nutritionTargets, date?, model?, signal? }) → { text, model, costUsd, costEstimated, usage }
 * Uses ai.fastModel (default Haiku 4.5), thinking disabled; text capped at 90 words.
 */
export async function morningBrief(ai, opts = {}) {
  const { readiness, plan, events, nutritionTargets, date } = opts;
  const L = [];
  if (date) L.push(`Date: ${date}${dowOf(date) ? ' (' + dowOf(date) + ')' : ''}`);
  L.push('Readiness: ' + (readinessLine(readiness) || 'no data'));
  const blocks = (Array.isArray(plan) ? plan : []).filter((b) => b && !b._d).slice(0, 16)
    .map((b) => `${b.start || ''}–${b.end || ''} ${clip(b.title, 60)}${b.category ? ` (${b.category})` : ''}`.trim());
  L.push('Plan: ' + (blocks.length ? blocks.join('; ') : 'nothing planned'));
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && !e._d).slice(0, 16)
    .map((e) => (e.allDay ? `all day ${clip(e.title, 60)}` : `${hhmm(e.start)}–${hhmm(e.end)} ${clip(e.title, 60)}`));
  L.push('Calendar: ' + (evs.length ? evs.join('; ') : 'no events'));
  const nt = nutritionTargets || {};
  const ntl = [isNum(nt.kcal) ? `${fmtN(nt.kcal)} kcal` : '', isNum(nt.proteinG) ? `protein ${fmtN(nt.proteinG)} g` : ''].filter(Boolean).join(', ');
  L.push('Nutrition targets: ' + (ntl || 'not set'));

  const res = await callClaude(ai, {
    model: opts.model || (ai && ai.fastModel) || DEFAULT_FAST_MODEL,
    system: morningBriefSystemPrompt(),
    messages: [{ role: 'user', content: L.join('\n') }],
    thinking: { type: 'disabled' },
    effort: 'low',
    maxTokens: 400,
    ...common(opts),
  });
  const text = capWords(plainText(textOf(res.content)), 90);
  if (!text) throw new AIError('parse', 'Claude returned an empty brief.', { requestId: res.requestId });
  return { text, model: res.model, costUsd: res.costUsd, costEstimated: res.costEstimated, usage: res.usage };
}

function readinessLine(r) {
  if (!r || typeof r !== 'object') return '';
  const m = r.metrics || {};
  const bits = [];
  if (r.status && r.status !== 'ok') bits.push(`status ${r.status}`);
  if (r.band) bits.push(`band ${r.band}`);
  if (isNum(r.score)) bits.push(`score ${Math.round(r.score)}`);
  if (isNum(m.recovery)) bits.push(`recovery ${Math.round(m.recovery)}%`);
  if (isNum(m.hrv)) bits.push(`HRV ${Math.round(m.hrv)} ms${isNum(m.hrvBase) ? ` (baseline ${Math.round(m.hrvBase)})` : ''}`);
  if (isNum(m.rhr)) bits.push(`RHR ${Math.round(m.rhr)}${isNum(m.rhrBase) ? ` (baseline ${Math.round(m.rhrBase)})` : ''}`);
  if (isNum(m.sleepMin)) bits.push(`sleep ${fmtDur(m.sleepMin)}${isNum(m.sleepNeedMin) ? ` vs need ${fmtDur(m.sleepNeedMin)}` : ''}`);
  if (isNum(m.sleepDebtMin) && m.sleepDebtMin > 0) bits.push(`sleep debt ${fmtDur(m.sleepDebtMin)}`);
  const tr = r.training || {};
  if (tr.mode) bits.push(`training call: ${tr.mode}${tr.detail ? ` — ${clip(tr.detail, 160)}` : ''}${Array.isArray(tr.strainTarget) ? ` (strain ${tr.strainTarget.join('–')})` : ''}`);
  if (r.focus && r.focus.start) bits.push(`focus window ${r.focus.start}–${r.focus.end || ''}${r.focus.note ? ` (${clip(r.focus.note, 100)})` : ''}`);
  const flags = (Array.isArray(r.flags) ? r.flags : []).map((f) => (typeof f === 'string' ? f : f && f.text)).filter(Boolean);
  if (flags.length) bits.push('flags: ' + flags.map((f) => clip(f, 160)).join('; '));
  if (r.summary) bits.push(`summary: ${clip(r.summary, 300)}`);
  return bits.join(', ');
}
function fmtDur(min) { const m = Math.round(min); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; }

function plainText(s) {
  return String(s || '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

/** Trim text to at most `max` words, ending on a sentence boundary when possible. */
export function capWords(text, max = 90) {
  const s = String(text || '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= max) return s;
  const cut = words.slice(0, max).join(' ');
  if (/[.!?]$/.test(cut)) return cut;
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > cut.length * 0.5) return cut.slice(0, stop + 1);
  return cut.replace(/[,;:\s]+$/, '') + '…';
}
