// Fuel: module-level meal analysis queue. Jobs run one at a time and write their results into the meal
// record, so capture and detail sheets can close while analysis continues. No DOM or preact here
// (Node-testable: tests/ui/fuel-queue.test.mjs); the hook lives in fuel-ui.js.
//
// app needs: store, dv, session.mediaBytes(path), ai() → config|null; optional toast(msg, opts).
import { analyzeMeal, analyzeMealText } from '../../ai/meal.js';
import { AIError } from '../../ai/errors.js';
import { calorieTargets } from '../../analytics/body.js';
import { bytesToB64, nowIso } from '../../core/util.js';
import { analysisPatch, hasEstimate, mealPhotos, analyzable, sortFoods, goalText, mealTitle } from './fuel-logic.js';

const jobs = new Map();   // mealId → { mealId, app, status: queued|running|done|error|cancelled, phase, query, startedAt, finishedAt, error, result, promise }
const waiting = [];       // mealIds in run order
const images = new Map(); // mealId → [{ data, mediaType }] kept from capture (avoids decrypting the photo again)
const subs = new Set();
let worker = null;
let rev = 0;

function emit() { rev++; for (const fn of [...subs]) { try { fn(rev); } catch (e) { console.warn('[fuel-queue]', e); } } }

/** Subscribe to queue changes → unsubscribe. */
export function subscribeQueue(fn) { subs.add(fn); return () => subs.delete(fn); }
export const queueRev = () => rev;
/** The latest job for a meal (also finished ones, until replaced or dismissed), or null. */
export const jobFor = (mealId) => jobs.get(mealId) || null;
export const isActive = (job) => !!job && (job.status === 'queued' || job.status === 'running');
export const activeJobs = () => [...jobs.values()].filter(isActive);
/** Keep the prepared photo(s) of a just-captured meal in memory for its first analysis. */
export function rememberImages(mealId, list) { if (Array.isArray(list) && list.length) images.set(mealId, list); }

/** Short error text stored on a failed meal record. */
export function mealErrorText(e) {
  switch (e && e.code) {
    case 'no-key': return 'No Anthropic API key — add one in Settings → AI.';
    case 'auth': return 'The API key was rejected — check Settings → AI.';
    case 'rate-limit': return 'Rate limited by the API — retry ' + (e.retryAfter ? `in ${Math.ceil(e.retryAfter)} s.` : 'in a minute.');
    case 'overloaded': return 'The API was overloaded — retry.';
    case 'network': return 'Could not reach the API — retry when online.';
    case 'parse': return 'The estimate could not be read — retry, or add a note.';
    case 'refused': return 'The model declined this request.';
    default: return String((e && e.message) || 'Analysis failed.').slice(0, 240);
  }
}

/**
 * Queue a meal for (re-)analysis. Resolves with the analysis result, or undefined on error/cancel.
 * Re-queuing a meal that is already queued or running returns the pending promise.
 */
export function enqueueAnalysis(app, mealId) {
  const cur = jobs.get(mealId);
  if (isActive(cur)) return cur.promise;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  jobs.set(mealId, { mealId, app, status: 'queued', phase: null, query: null, startedAt: 0, finishedAt: 0, error: null, result: null, promise, resolve, ctl: null });
  waiting.push(mealId);
  emit();
  pump();
  return promise;
}

/** Cancel a queued or running analysis (silent; the meal goes back to pending, or keeps its estimate). */
export function cancelAnalysis(mealId) {
  const job = jobs.get(mealId);
  if (!job) return;
  if (job.status === 'queued') {
    const i = waiting.indexOf(mealId); if (i >= 0) waiting.splice(i, 1);
    const m = job.app.store && job.app.store.get('meals', mealId);
    if (m && m.status === 'analyzing') job.app.store.update('meals', mealId, { status: hasEstimate(m) ? 'ready' : 'pending' });
    settle(job, 'cancelled');
  } else if (job.status === 'running' && job.ctl) job.ctl.abort();
}

/** Forget a finished job (e.g. after its error was shown). */
export function dismissJob(mealId) {
  const job = jobs.get(mealId);
  if (job && !isActive(job)) { jobs.delete(mealId); emit(); }
}

/** Meals waiting for analysis and not queued: status pending, or analyzing with nothing running (interrupted by a reload). Oldest first. */
export function waitingMeals(store) {
  return store.all('meals').filter((m) => (m.status === 'pending' || m.status === 'analyzing') && !isActive(jobs.get(m.id)))
    .sort((a, b) => (Date.parse(a.at) || Date.parse(a.date) || 0) - (Date.parse(b.at) || Date.parse(b.date) || 0));
}

/** Failed meals not queued again, optionally only those dated on/after `since` ('YYYY-MM-DD'). */
export function failedMeals(store, since = null) {
  return store.all('meals').filter((m) => m.status === 'error' && !isActive(jobs.get(m.id)) && (!since || (m.date || '') >= since));
}

/** Queue every waiting meal (and failed ones when `failed`: true, or a 'YYYY-MM-DD' lower bound). → number queued. */
export function analyzeWaiting(app, { failed = false } = {}) {
  const list = waitingMeals(app.store);
  if (failed) for (const m of failedMeals(app.store, failed === true ? null : failed)) if (!list.includes(m)) list.push(m);
  for (const m of list) enqueueAnalysis(app, m.id);
  return list.length;
}

function settle(job, status, error = null, result = null) {
  Object.assign(job, { status, error, result, finishedAt: Date.now(), ctl: null, phase: null, query: null });
  job.resolve(status === 'done' ? result : undefined);
  emit();
}

function pump() {
  if (worker) return;
  worker = (async () => {
    const failed = [];
    while (waiting.length) {
      const job = jobs.get(waiting.shift());
      if (!job || job.status !== 'queued') continue;
      await run(job);
      if (job.status === 'error' && job.error && job.error.code !== 'no-key') failed.push(job);
    }
    worker = null;
    const app = failed.length ? failed[failed.length - 1].app : null;
    if (app && typeof app.toast === 'function') {
      const one = failed.length === 1 ? app.store.get('meals', failed[0].mealId) : null;
      app.toast(failed.length === 1 ? `Analysis failed: ${one ? mealTitle(one) : 'meal'} — ${mealErrorText(failed[0].error)}` : `${failed.length} meals failed analysis`, {
        tone: 'error', ms: 8000, action: { label: 'Retry', onClick: () => failed.forEach((j) => enqueueAnalysis(j.app, j.mealId)) },
      });
    }
  })();
}

async function run(job) {
  const { app, mealId } = job;
  const store = app.store;
  const meal = store && store.get('meals', mealId);
  if (!meal) return settle(job, 'cancelled');
  const ai = typeof app.ai === 'function' ? app.ai() : null;
  if (!ai) {
    if (!hasEstimate(meal)) store.update('meals', mealId, { status: 'pending', error: null });
    return settle(job, 'error', new AIError('no-key'));
  }
  const had = hasEstimate(meal);
  const ctl = new AbortController();
  Object.assign(job, { status: 'running', phase: 'thinking', query: null, startedAt: Date.now(), ctl, error: null });
  emit();
  if (meal.status !== 'analyzing' || meal.error) store.update('meals', mealId, { status: 'analyzing', error: null });
  const onProgress = (ev) => { if (ev && ev.phase && job.status === 'running') { job.phase = ev.phase; job.query = ev.query || null; emit(); } };
  try {
    const input = await buildInput(app, meal, ctl.signal, onProgress);
    const res = input.text != null ? await analyzeMealText(ai, input) : await analyzeMeal(ai, input);
    const cur = store.get('meals', mealId);
    if (!cur) return settle(job, 'cancelled'); // deleted while analyzing
    store.update('meals', mealId, analysisPatch(cur, res, nowIso(app.dv && app.dv.tz)));
    images.delete(mealId);
    return settle(job, 'done', null, res);
  } catch (e) {
    const cur = store.get('meals', mealId);
    if (e && e.code === 'aborted') {
      if (cur) store.update('meals', mealId, { status: had ? 'ready' : 'pending' });
      return settle(job, 'cancelled');
    }
    if (!(e && e.code)) console.warn('[fuel-queue]', e);
    if (cur) store.update('meals', mealId, had ? { status: 'ready', error: null } : { status: 'error', error: mealErrorText(e) });
    return settle(job, 'error', e);
  }
}

/** Shared AI context for a meal: active rules, saved foods, trend weight + goal. */
export function mealContext(app, date) {
  const store = app.store;
  const rules = ((store.setting('nutritionRules') || {}).rules || []).filter((r) => r && r.active !== false && r.text).map((r) => r.text);
  const recentFoods = sortFoods(store.all('foods')).slice(0, 20).map((f) => ({ name: f.name, totals: f.totals, items: f.items }));
  let weightLb = null;
  try { weightLb = app.dv ? calorieTargets(app.dv, date).weightLb : null; } catch { weightLb = null; }
  const goal = goalText(store.setting('profile'), weightLb);
  return { rules, recentFoods, profile: { weightLb, goal } };
}

async function buildInput(app, meal, signal, onProgress) {
  const base = { at: meal.at, date: meal.date, answers: meal.answers || [], ...mealContext(app, meal.date), signal, onProgress };
  const kind = analyzable(meal);
  if (kind === 'text') return { ...base, text: String(meal.note).trim() };
  if (kind !== 'photo') throw new AIError('bad-request', 'Nothing to analyze — add a photo or a description.');
  let list = images.get(meal.id);
  if (!list) {
    list = [];
    for (const p of mealPhotos(meal)) {
      const bytes = await app.session.mediaBytes(p.path);
      if (!bytes) throw new AIError('bad-request', 'The photo is not on this device yet. Sync, then retry.');
      list.push({ data: bytesToB64(bytes), mediaType: p.mediaType || 'image/jpeg' });
    }
  }
  return { ...base, images: list, note: meal.note || '' };
}

/** Test hook: clear all state. */
export function _resetQueue() { for (const j of jobs.values()) if (j.ctl) j.ctl.abort(); jobs.clear(); waiting.length = 0; images.clear(); worker = null; emit(); }
