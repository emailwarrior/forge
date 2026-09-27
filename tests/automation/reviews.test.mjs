import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutomation } from '../../automation/run.mjs';
import { createLogger } from '../../automation/log.mjs';
import { makeVault, stubDeps, noSleep, edt } from './fixtures/helpers.mjs';

const KEY = 'sk-ant-api03-test-key-value-0123456789';
const MONDAY_0410 = edt('2026-09-28', '04:10');

function reviewVault(extra) {
  return makeVault({
    today: '2026-09-27',   // demo data through Sunday
    server: true,
    mutate: (app) => {
      app.updateSetting('integrations', { ai: { serverReviews: true, model: 'claude-sonnet-5', effort: 'medium' } });
      if (extra) extra(app);
    },
  });
}
const run = (v, at, deps, env = {}, log = createLogger({ quiet: true })) => runAutomation({
  root: v.dir, env: v.env({ FORGE_TASK: 'reviews', ANTHROPIC_API_KEY: KEY, ...env }), now: () => at, sleep: noSleep, deps, git: false, log,
});

test('reviews: after 03:00 creates yesterday\'s nutrition review and, on Monday, last week\'s weekly review', async () => {
  // Make the peptide due on Sundays so yesterday's protocol notes include it.
  const v = await reviewVault((app) => app.update('protocolItems', 'p-pep', { schedule: { type: 'days', days: [6], stack: 'AM' } }));
  const { deps, calls } = stubDeps();
  const log = createLogger({ quiet: true });
  const r = await run(v, MONDAY_0410, deps, {}, log);
  assert.equal(r.results.reviews, 'ok');
  assert.equal(calls.nutritionReview.length, 1);
  assert.equal(calls.weeklyReview.length, 1);

  const { ai, input } = calls.nutritionReview[0];
  assert.equal(ai.apiKey, KEY);
  assert.equal(ai.model, 'claude-sonnet-5');
  assert.equal(ai.webLookup, false);
  assert.ok(ai.timeoutMs <= 150000 && ai.maxRetries <= 2, 'bounded by the job time budget');
  assert.equal(typeof ai.fetchImpl, 'function');
  assert.equal(input.date, '2026-09-27');
  assert.ok(input.meals.length >= 2);
  assert.ok(input.meals.every((m) => !('photo' in m) && !('ai' in m)), 'meal photos and AI metadata are not re-sent');
  assert.deepEqual(input.targets, { kcal: 2800, proteinG: 180 });
  assert.ok(input.bodyTrend && !('series' in input.bodyTrend));
  assert.ok(Array.isArray(input.rules) && input.rules.length === 3);
  assert.ok(input.protocolNotes.some((n) => n.startsWith('Protocol: ')), 'neutral label for the peptide');
  assert.ok(!input.protocolNotes.some((n) => /peptide/i.test(n)));

  const w = calls.weeklyReview[0].input;
  assert.equal(w.stats.week, '2026-W39');
  assert.equal(w.stats.from, '2026-09-21');
  assert.equal(w.drivers.length, 1);
  assert.equal(w.goals.weightLow, 170);
  assert.equal(w.lastFocus, null);

  const shard = (await v.read('forge/server/reviews/2026.enc')).r;
  const n = shard['nutrition:2026-09-27'];
  assert.deepEqual({ kind: n.kind, period: n.period, date: n.date, model: n.model, costUsd: n.costUsd, score: n.content.score, headline: n.content.headline },
    { kind: 'nutrition', period: '2026-09-27', date: '2026-09-27', model: 'claude-sonnet-5', costUsd: 0.0123, score: 81, headline: 'Solid day' });
  assert.equal(n.createdAt, new Date(MONDAY_0410).toISOString());
  const wk = shard['weekly:2026-W39'];
  assert.deepEqual({ kind: wk.kind, period: wk.period, date: wk.date, focus: wk.content.focus.title }, { kind: 'weekly', period: '2026-W39', date: '2026-09-21', focus: 'Earlier dinner' });
  const st = (await v.read('forge/server/status.enc')).r.reviews;
  assert.deepEqual(st.detail.created.sort(), ['nutrition:2026-09-27', 'weekly:2026-W39']);
  assert.ok(!log.lines.join('\n').includes(KEY), 'API key never logged');

  // Existing reviews are never redone.
  const again = stubDeps();
  await run(v, MONDAY_0410 + 3600e3, again.deps);
  assert.equal(again.calls.nutritionReview.length + again.calls.weeklyReview.length, 0);
});

test('reviews: waits for 03:00, skips days with < 2 meals and reviews the app already made', async () => {
  const v = await reviewVault((app) => {
    app.create('reviews', { id: 'weekly:2026-W39', kind: 'weekly', period: '2026-W39', date: '2026-09-21', createdAt: '2026-09-28T07:00:00Z', content: { headline: 'from the app' } });
    for (const m of app.byDate('meals', '2026-09-27').slice(1)) app.remove('meals', m.id);
  });
  const early = stubDeps();
  await run(v, edt('2026-09-28', '02:30'), early.deps);
  assert.equal(early.calls.nutritionReview.length + early.calls.weeklyReview.length, 0);
  assert.match((await v.read('forge/server/status.enc')).r.reviews.detail.note, /03:00/);

  const later = stubDeps();
  await run(v, MONDAY_0410, later.deps);
  assert.equal(later.calls.nutritionReview.length, 0, 'only one meal logged yesterday');
  assert.equal(later.calls.weeklyReview.length, 0, 'the app already wrote this week\'s review');
  assert.equal(await v.tryRead('forge/server/reviews/2026.enc'), null, 'nothing written');
});

test('reviews: off → quiet; enabled without a key → error; failures stop after 3 attempts', async () => {
  const off = await makeVault({ today: '2026-09-27' });
  const s0 = stubDeps();
  const r0 = await runAutomation({ root: off.dir, env: off.env({ FORGE_TASK: 'auto', ANTHROPIC_API_KEY: KEY }), now: () => MONDAY_0410, sleep: noSleep, deps: s0.deps, git: false, log: createLogger({ quiet: true }) });
  assert.equal(r0.results.reviews, 'skipped');
  assert.equal((await off.read('forge/server/status.enc')).r.reviews, undefined);
  assert.equal(s0.calls.nutritionReview.length, 0);

  const v = await reviewVault();
  const r1 = await run(v, MONDAY_0410, stubDeps().deps, { ANTHROPIC_API_KEY: '' });
  assert.equal(r1.results.reviews, 'error');
  assert.match((await v.read('forge/server/status.enc')).r.reviews.lastError, /ANTHROPIC_API_KEY/);

  const failing = stubDeps({ nutritionFails: true });
  for (let i = 0; i < 4; i++) await run(v, MONDAY_0410 + i * 3600e3, failing.deps);
  assert.equal(failing.calls.nutritionReview.length, 3, 'gives up on a review after 3 failures');
  const st = (await v.read('forge/server/status.enc')).r.reviews;
  assert.equal(st.detail.failures['nutrition:2026-09-27'].n, 3);
  assert.match(st.detail.failures['nutrition:2026-09-27'].error, /^bad-request: /);
  assert.equal(failing.calls.weeklyReview.length, 1, 'other reviews still run');
});
