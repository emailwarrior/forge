// Optional server-side AI reviews (settings.integrations.ai.serverReviews + ANTHROPIC_API_KEY).
// After 03:00 local: yesterday's nutrition review (when ≥ 2 meals were logged) and, on
// Mondays, last week's weekly review. Existing reviews (app or server) are never redone.
// Written to the server `reviews` shard; the app merges it with its own.
import { localParts, addDays, weekStart, isoWeek } from '../js/core/util.js';
import { makeDataView } from '../js/analytics/dataview.js';
import { putRecord } from './vault-fs.mjs';
import { shortError, iso } from './log.mjs';

const NOT_BEFORE = 3 * 60;
const MAX_FAILURES = 3;
const DRIVER_DAYS = 120;

const countable = (m) => m && m.status !== 'error' && m.status !== 'pending' && m.status !== 'analyzing';

function compactMeal(m) {
  const items = (Array.isArray(m.items) ? m.items : []).map((it) => ({
    name: it.name, portion: it.portion, grams: it.grams, kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat, fiber: it.fiber,
  }));
  return { at: m.at || null, slot: m.slot || null, note: m.note || '', items, totals: m.totals || null };
}

function sumTotals(meals) {
  const t = {};
  for (const m of meals) for (const [k, v] of Object.entries(m.totals || {})) if (typeof v === 'number') t[k] = Math.round(((t[k] || 0) + v) * 10) / 10;
  return t;
}

const minutesBetween = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) && y > x ? Math.round((y - x) / 60000) : null; };

async function nutritionInputs(ctx, dv, date) {
  const nutrition = ctx.need('nutrition');
  const body = ctx.need('body');
  const meals = dv.meals(date).filter(countable).map(compactMeal);
  const day = nutrition.dayNutrition(dv, date) || {};
  const summary = body.bodySummary(dv, date) || null;
  let bodyTrend = null;
  if (summary && typeof summary === 'object') { const { series, ...rest } = summary; bodyTrend = rest; }
  let protocolNotes = [];
  try {
    const due = ctx.need('protocols').dueItems(dv, date) || [];
    const doses = dv.doses(date);
    protocolNotes = due.filter((x) => x && x.item && x.due !== false).map(({ item }) => {
      const label = item.neutralLabel || item.name || 'Protocol item';
      return `${label}: ${doses.some((d) => d.itemId === item.id && !d.skipped) ? 'logged' : 'not logged'}`;
    });
  } catch { protocolNotes = []; }
  const cycle = dv.cycle(date);
  return {
    date,
    meals,
    totals: day.totals || sumTotals(meals),
    targets: day.targets || null,
    rules: (ctx.store.setting('nutritionRules').rules || []).filter((r) => r && r.active !== false && r.text).map((r) => r.text),
    training: {
      dayStrain: cycle ? cycle.strain ?? null : null,
      sessions: dv.sessions(date).map((s) => ({ name: s.name || null, sets: (s.entries || []).reduce((n, e) => n + (e.sets || []).length, 0), durationMin: minutesBetween(s.startAt, s.endAt) })),
      workouts: dv.workouts(date).map((w) => ({ sport: w.sport || null, strain: w.strain ?? null, kcal: w.kcal ?? null, durationMin: minutesBetween(w.start, w.end) })),
    },
    bodyTrend,
    protocolNotes,
  };
}

async function weeklyInputs(ctx, dv, weekFrom) {
  const weekly = ctx.need('weekly');
  const daily = ctx.need('daily');
  const correlations = ctx.need('correlations');
  const stats = weekly.weekStats(dv, weekFrom);
  const rows = daily.buildDaily(dv, addDays(weekFrom, -DRIVER_DAYS), addDays(weekFrom, 6));
  const drivers = (correlations.findDrivers(rows) || []).slice(0, 10);
  const profile = ctx.store.setting('profile');
  const targets = ctx.store.setting('targets');
  const goals = {
    weightLow: profile.goalWeightLow, weightHigh: profile.goalWeightHigh, rateLbWk: profile.goalRateLbWk,
    sleepTargetH: targets.sleepTargetH, deepWorkTargetH: targets.deepWorkTargetH, wake: targets.wake, bedtime: targets.bedtime,
  };
  const prevReview = ctx.store.get('reviews', `weekly:${isoWeek(addDays(weekFrom, -7))}`);
  const lastFocus = (prevReview && prevReview.content && prevReview.content.focus) || null;
  return { stats, drivers, goals, lastFocus };
}

export async function runReviews(ctx, { explicit = false } = {}) {
  const aiSettings = ctx.store.setting('integrations').ai || {};
  if (!aiSettings.serverReviews) return explicit ? { ok: true, skipped: true, detail: { note: 'server reviews are off (integrations.ai.serverReviews)' } } : { quiet: true, skipped: true };
  const prev = (ctx.store.get('status', 'reviews') || {}).detail || {};
  if (!String(ctx.env.ANTHROPIC_API_KEY || '').trim()) return { ok: false, error: 'ANTHROPIC_API_KEY secret is not set', detail: prev };

  const nowMs = ctx.now();
  const lp = localParts(nowMs, ctx.tz);
  const today = lp.ymd;
  const failures = {};   // id -> { n, error, at } (recent only)
  for (const [id, f] of Object.entries(prev.failures || {})) if (f && f.at && Date.parse(f.at) > nowMs - 14 * 86400000) failures[id] = f;
  const detail = { failures, created: [], lastCreatedAt: prev.lastCreatedAt || null, lastCostUsd: prev.lastCostUsd ?? null };
  if (lp.min < NOT_BEFORE) return { ok: true, detail: { ...detail, note: 'waiting until 03:00 local' }, summary: 'not yet 03:00' };

  const dv = makeDataView(ctx.store, { tz: ctx.tz, today });
  // Same shape as js/ai makeAiConfig(); bounded so a slow API cannot outlive the job.
  const ai = {
    apiKey: String(ctx.env.ANTHROPIC_API_KEY).trim(),
    model: aiSettings.model, fastModel: aiSettings.fastModel, effort: aiSettings.effort,
    webLookup: false,
    fetchImpl: ctx.fetch,
    maxRetries: 2,
    maxRetryWaitMs: 30000,
    timeoutMs: Math.max(30000, Math.min(150000, ctx.deadline - Date.now() - 45000)),
  };
  const jobs = [];
  const yesterday = addDays(today, -1);
  const nutritionId = `nutrition:${yesterday}`;
  if (!ctx.store.get('reviews', nutritionId) && dv.meals(yesterday).filter(countable).length >= 2) jobs.push({ id: nutritionId, kind: 'nutrition' });
  if (lp.dow === 0) {
    const weekFrom = addDays(weekStart(today), -7);
    const weeklyId = `weekly:${isoWeek(weekFrom)}`;
    if (!ctx.store.get('reviews', weeklyId)) jobs.push({ id: weeklyId, kind: 'weekly', weekFrom });
  }

  let errors = 0; let cost = 0;
  for (const job of jobs) {
    if ((failures[job.id] && failures[job.id].n) >= MAX_FAILURES) continue;
    if (Date.now() > ctx.deadline) { detail.note = 'time budget reached'; break; }
    // One overall deadline per review: the AI client retries with a fresh per-attempt timeout.
    const signal = AbortSignal.timeout(Math.max(15000, ctx.deadline - Date.now() - 30000));
    try {
      const reviews = ctx.need('aiReviews');
      let res; let fields;
      if (job.kind === 'nutrition') {
        res = await reviews.nutritionReview(ai, { ...(await nutritionInputs(ctx, dv, yesterday)), signal });
        fields = { kind: 'nutrition', period: yesterday, date: yesterday,
          content: { score: res.score ?? null, headline: res.headline ?? '', wins: res.wins || [], gaps: res.gaps || [], tomorrow: res.tomorrow || [], flags: res.flags || [] } };
      } else {
        res = await reviews.weeklyReview(ai, { ...(await weeklyInputs(ctx, dv, job.weekFrom)), signal });
        fields = { kind: 'weekly', period: isoWeek(job.weekFrom), date: job.weekFrom,
          content: { headline: res.headline ?? '', summary: res.summary ?? '', whatWorked: res.whatWorked || [], whatDidnt: res.whatDidnt || [], focus: res.focus || null } };
      }
      putRecord(ctx, 'reviews', job.id, { ...fields, createdAt: iso(nowMs), model: res.model || null, costUsd: typeof res.costUsd === 'number' ? res.costUsd : null, source: 'server' });
      delete failures[job.id];
      detail.created.push(job.id);
      if (typeof res.costUsd === 'number') cost += res.costUsd;
    } catch (e) {
      errors++;
      if (signal.aborted) { detail.note = 'time budget reached; retrying next run'; break; }   // not the review's fault
      const code = e && e.code ? `${e.code}: ` : '';
      failures[job.id] = { n: ((failures[job.id] && failures[job.id].n) || 0) + 1, error: code + shortError(e, 120), at: iso(nowMs) };
    }
  }
  if (detail.created.length) { detail.lastCreatedAt = iso(nowMs); detail.lastCostUsd = Math.round(cost * 10000) / 10000; }
  return {
    ok: errors === 0,
    error: errors ? `${errors} review(s) failed` : null,
    detail,
    summary: `due=${jobs.length} created=${detail.created.length}${errors ? ` failed=${errors}` : ''}`,
  };
}
