import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';
import { makeDataView } from '../../js/analytics/dataview.js';
import { NUTRIENT_KEYS } from '../../js/core/schema.js';
import { bytesToB64 } from '../../js/core/util.js';
import {
  enqueueAnalysis, cancelAnalysis, jobFor, rememberImages, waitingMeals, failedMeals, analyzeWaiting, activeJobs, subscribeQueue, mealErrorText, _resetQueue,
} from '../../js/ui/parts/fuel-queue.js';
import { aiConfig, mockFetch, message, toolUse, apiError } from '../ai/fixtures/mock-claude.mjs';

const TZ = 'America/New_York';
const zeros = () => Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0]));
const item = (o) => ({ name: 'x', portion: '', grams: 0, basis: 'estimate', confidence: 'medium', ...zeros(), ...o });
const RECORD = {
  title: 'Chicken rice bowl', portionReference: '', assumptions: ['Grilled'], confidence: 'medium', followUp: 'Was there sauce?',
  items: [item({ name: 'Chicken', grams: 200, kcal: 330, protein: 62, fat: 7 }), item({ name: 'Rice', grams: 250, kcal: 325, protein: 6, carbs: 71 })],
};
const reply = (input = RECORD) => ({ message: message([toolUse('record_meal', input)], { stop_reason: 'tool_use' }) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const PHOTO = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);

function makeApp({ fetchSteps = [], key = true } = {}) {
  const store = createStore({ owner: 'app' });
  store.updateSetting('nutritionRules', { rules: [{ id: 'r1', text: 'Protein at every meal', active: true }, { id: 'r2', text: 'Old rule', active: false }] });
  store.updateSetting('profile', { goalWeightLow: 170, goalWeightHigh: 180, goalRateLbWk: 0.3 });
  store.create('body', { date: '2026-09-20', at: '2026-09-20T07:00:00-04:00', weightLb: 164, method: 'scale' });
  store.create('foods', { id: 'f1', name: 'Protein shake', totals: { ...zeros(), kcal: 400, protein: 50 }, items: [], uses: 9 });
  const fetchImpl = mockFetch(fetchSteps);
  const toasts = []; const media = new Map();
  const app = {
    store, dv: makeDataView(store, { tz: TZ, today: '2026-09-26' }),
    session: { mediaBytes: async (p) => { app.mediaReads++; return media.get(p) || null; } },
    ai: () => (key ? aiConfig({ fetchImpl, webLookup: false }) : null),
    toast: (msg, opts) => toasts.push({ msg, opts }),
    mediaReads: 0, fetchImpl, toasts, media,
  };
  return app;
}
function photoMeal(app, id, extra = {}) {
  const path = `media/meals/2026/09/${id}-0.enc`;
  app.media.set(path, PHOTO);
  return app.store.create('meals', { id, date: '2026-09-26', at: '2026-09-26T12:30:00-04:00', timeSource: 'exif', slot: 'lunch', source: 'library', note: 'extra sauce', photo: { path, w: 10, h: 10 }, photos: [{ path, w: 10, h: 10 }], status: 'analyzing', answers: [], followUp: null, ...extra });
}

beforeEach(() => _resetQueue());

test('queue: analyzes a photo meal from stored media and writes the estimate into the record', async () => {
  const app = makeApp({ fetchSteps: [reply()] });
  photoMeal(app, 'm1');
  const seen = [];
  const unsub = subscribeQueue(() => { const j = jobFor('m1'); if (j) seen.push(j.status); });
  const res = await enqueueAnalysis(app, 'm1');
  unsub();
  app.fetchImpl.done();
  assert.equal(res.title, 'Chicken rice bowl');
  assert.ok(seen.includes('queued') && seen.includes('running') && seen.at(-1) === 'done');
  const m = app.store.get('meals', 'm1');
  assert.equal(m.status, 'ready'); assert.equal(m.error, null);
  assert.equal(m.title, 'Chicken rice bowl');
  assert.equal(m.totals.kcal, 655); assert.equal(m.totals.protein, 68);
  assert.equal(m.items.length, 2);
  assert.equal(m.followUp, 'Was there sauce?');
  assert.equal(m.ai.model, 'claude-sonnet-5'); assert.equal(m.ai.confidence, 'medium'); assert.equal(m.ai.title, 'Chicken rice bowl');
  assert.ok(m.ai.at.startsWith('20'));
  const body = app.fetchImpl.calls[0].body;
  const [img, txt] = body.messages[0].content;
  assert.equal(img.source.data, bytesToB64(PHOTO));
  assert.match(txt.text, /extra sauce/);
  assert.match(txt.text, /Protein at every meal/);
  assert.doesNotMatch(txt.text, /Old rule/);
  assert.match(txt.text, /Protein shake/);
  assert.match(txt.text, /body weight 164 lb; goal: gain body weight toward 170–180 lb/);
  assert.equal(app.mediaReads, 1);
});

test('queue: remembered capture images skip the media read; answers are sent; an edited title survives', async () => {
  const app = makeApp({ fetchSteps: [reply({ ...RECORD, title: 'Rice plate', followUp: '' })] });
  photoMeal(app, 'm2', { title: 'Team lunch', ai: { title: 'Chicken bowl' }, answers: [{ q: 'Was there sauce?', a: 'Yes, 2 tbsp teriyaki' }], status: 'ready', totals: { kcal: 500 } });
  rememberImages('m2', [{ data: 'QUJD', mediaType: 'image/jpeg' }]);
  await enqueueAnalysis(app, 'm2');
  assert.equal(app.mediaReads, 0);
  const txt = app.fetchImpl.calls[0].body.messages[0].content;
  assert.equal(txt[0].source.data, 'QUJD');
  assert.match(txt[1].text, /Q: Was there sauce\? A: Yes, 2 tbsp teriyaki/);
  const m = app.store.get('meals', 'm2');
  assert.equal(m.title, 'Team lunch');
  assert.equal(m.ai.title, 'Rice plate');
  assert.equal(m.followUp, null);
});

test('queue: text meals use the description; meals run one at a time in order', async () => {
  const app = makeApp({ fetchSteps: [reply({ ...RECORD, title: 'Eggs and toast' }), reply()] });
  app.store.create('meals', { id: 't1', date: '2026-09-26', at: '2026-09-26T08:00:00-04:00', source: 'text', note: '2 eggs, 2 slices sourdough', status: 'analyzing' });
  photoMeal(app, 'p1');
  const a = enqueueAnalysis(app, 't1'); const b = enqueueAnalysis(app, 'p1');
  assert.equal(jobFor('p1').status, 'queued');
  await Promise.all([a, b]);
  const calls = app.fetchImpl.calls.map((c) => c.body.messages[0].content);
  assert.equal(calls[0].length, 1, 'text only');
  assert.match(calls[0][0].text, /"2 eggs, 2 slices sourdough"/);
  assert.equal(calls[1][0].type, 'image');
  assert.equal(app.store.get('meals', 't1').title, 'Eggs and toast');
  assert.equal(app.store.get('meals', 'p1').status, 'ready');
});

test('queue: a failed first analysis marks the meal error (keeps the photo) and toasts once with Retry', async () => {
  const app = makeApp({ fetchSteps: [apiError(400, 'invalid_request_error', 'Could not process image')] });
  photoMeal(app, 'e1');
  const res = await enqueueAnalysis(app, 'e1');
  await tick();
  assert.equal(res, undefined);
  const m = app.store.get('meals', 'e1');
  assert.equal(m.status, 'error');
  assert.match(m.error, /Could not process image/);
  assert.ok(m.photo.path);
  assert.equal(jobFor('e1').status, 'error'); assert.equal(jobFor('e1').error.code, 'bad-request');
  assert.equal(app.toasts.length, 1);
  assert.match(app.toasts[0].msg, /Analysis failed: Lunch/);
  assert.equal(app.toasts[0].opts.action.label, 'Retry');
});

test('queue: a failed re-analysis keeps the previous estimate and status ready', async () => {
  const app = makeApp({ fetchSteps: [apiError(400, 'invalid_request_error', 'nope')] });
  photoMeal(app, 'r1', { status: 'ready', items: [item({ name: 'Old', kcal: 500 })], totals: { kcal: 500 }, title: 'Old' });
  await enqueueAnalysis(app, 'r1');
  const m = app.store.get('meals', 'r1');
  assert.equal(m.status, 'ready'); assert.equal(m.totals.kcal, 500); assert.equal(m.title, 'Old'); assert.equal(m.error, null);
  assert.equal(jobFor('r1').status, 'error');
});

test('queue: without a key the meal waits as pending; waiting meals can be queued later', async () => {
  const app = makeApp({ key: false });
  photoMeal(app, 'n1', { status: 'pending' });
  photoMeal(app, 'n2', { status: 'analyzing', at: '2026-09-26T08:00:00-04:00' });
  app.store.create('meals', { id: 'n3', date: '2026-09-26', status: 'ready', totals: { kcal: 1 } });
  assert.deepEqual(waitingMeals(app.store).map((m) => m.id), ['n2', 'n1'], 'interrupted + pending, oldest first');
  const n = analyzeWaiting(app);
  assert.equal(n, 2);
  await jobFor('n1').promise;
  await tick();
  assert.equal(app.store.get('meals', 'n1').status, 'pending');
  assert.equal(app.store.get('meals', 'n2').status, 'pending');
  assert.equal(jobFor('n1').error.code, 'no-key');
  assert.equal(app.toasts.length, 0, 'no toast for a missing key');
  assert.equal(mealErrorText({ code: 'no-key' }), 'No Anthropic API key — add one in Settings → AI.');
  assert.equal(mealErrorText({ code: 'rate-limit', retryAfter: 41.2 }), 'Rate limited by the API — retry in 42 s.');
  assert.equal(mealErrorText(new Error('x'.repeat(300))).length, 240);
});

test('queue: cancelling a queued meal returns it to pending; deleted meals are skipped', async () => {
  const app = makeApp({ fetchSteps: [reply()] });
  photoMeal(app, 'c1'); photoMeal(app, 'c2'); photoMeal(app, 'c3');
  const p1 = enqueueAnalysis(app, 'c1'); const p2 = enqueueAnalysis(app, 'c2'); const p3 = enqueueAnalysis(app, 'c3');
  cancelAnalysis('c2');
  app.store.remove('meals', 'c3');
  assert.equal(await p2, undefined);
  await Promise.all([p1, p3]);
  assert.equal(app.store.get('meals', 'c1').status, 'ready');
  assert.equal(app.store.get('meals', 'c2').status, 'pending');
  assert.equal(jobFor('c2').status, 'cancelled');
  assert.equal(jobFor('c3').status, 'cancelled');
  assert.equal(app.fetchImpl.calls.length, 1);
});

test('queue: waiting/failed lists skip meals already queued; failed retries can be limited to recent days', async () => {
  const app = makeApp({ fetchSteps: [reply(), reply()] });
  photoMeal(app, 'w1', { status: 'pending' });
  photoMeal(app, 'w2', { status: 'error', date: '2026-09-01' });
  photoMeal(app, 'w3', { status: 'error' });
  assert.deepEqual(waitingMeals(app.store).map((m) => m.id), ['w1']);
  assert.deepEqual(failedMeals(app.store, '2026-09-20').map((m) => m.id), ['w3']);
  assert.equal(failedMeals(app.store).length, 2);
  const p = enqueueAnalysis(app, 'w1');
  assert.deepEqual(waitingMeals(app.store), [], 'a queued meal is not "waiting"');
  assert.equal(activeJobs().length, 1);
  await p;
  assert.equal(analyzeWaiting(app, { failed: '2026-09-20' }), 1, 'only the recent failure is retried');
  await jobFor('w3').promise;
  assert.equal(app.store.get('meals', 'w3').status, 'ready');
  assert.equal(app.store.get('meals', 'w2').status, 'error');
  assert.equal(activeJobs().length, 0);
});
