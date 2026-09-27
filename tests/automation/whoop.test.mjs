import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutomation } from '../../automation/run.mjs';
import { mapCycle, mapSleep, mapRecovery, mapWorkout, mapBody, BACKFILL_START, WHOOP_TOKEN_URL } from '../../automation/whoop.mjs';
import { createLogger } from '../../automation/log.mjs';
import { makeVault, whoopDataset, whoopMock, json, noSleep, edt } from './fixtures/helpers.mjs';

const NOW = edt('2026-09-26', '12:00');
const quiet = () => createLogger({ quiet: true });
const tokens = (over = {}) => ({ id: 'whoop', accessToken: 'A1', refreshToken: 'R1', expiresAt: new Date(NOW + 86400e3).toISOString(), scope: 'offline', obtainedAt: new Date(NOW - 3600e3).toISOString(), ...over });
const creds = { WHOOP_CLIENT_ID: 'client-id', WHOOP_CLIENT_SECRET: 'client-secret-value' };

test('whoop mapping: v2 records → ARCHITECTURE §5 fields (local dates, minutes, units)', () => {
  const data = whoopDataset({ endDate: '2026-09-26', days: 2 });
  const cycle = mapCycle(data.cycles[1]);
  assert.equal(cycle.date, '2026-09-26', 'cycle date = local date of start + 12 h');
  assert.equal(cycle.start, '2026-09-25T23:10:00-04:00');
  assert.equal(cycle.end, null, 'ongoing cycle');
  assert.equal(cycle.tz, '-04:00');
  assert.equal(cycle.strain, 9.3);
  assert.equal(cycle.kj, 8289);
  assert.equal(cycle.kcal, Math.round(8289.297 / 4.184));
  assert.equal(cycle.maxHr, 161);

  const sleep = mapSleep(data.sleeps[1]);
  assert.equal(sleep.date, '2026-09-26', 'sleep date = local date of the end (the morning woken up)');
  assert.equal(sleep.bedtime, '23:10');
  assert.equal(sleep.wake, '06:40');
  assert.equal(sleep.lightMin, 200); assert.equal(sleep.deepMin, 100); assert.equal(sleep.remMin, 91);
  assert.equal(sleep.asleepMin, 391, 'asleep = light + sws + rem');
  assert.equal(sleep.inBedMin, 450); assert.equal(sleep.awakeMin, 30);
  assert.equal(sleep.needMin, 475, 'need = sum of the four sleep_needed parts');
  assert.equal(sleep.needNapMin, -5);
  assert.equal(sleep.respRate, 16.1); assert.equal(sleep.efficiency, 91.5); assert.equal(sleep.performance, 82);
  assert.equal(sleep.cycleId, String(data.cycles[1].id));
  assert.equal(sleep.nap, false);

  const rec = mapRecovery(data.recoveries[1], '2026-09-26');
  assert.deepEqual(
    { date: rec.date, cycleId: rec.cycleId, sleepId: rec.sleepId, recovery: rec.recovery, rhr: rec.rhr, hrv: rec.hrv, spo2: rec.spo2, skinTempC: rec.skinTempC, calibrating: rec.calibrating },
    { date: '2026-09-26', cycleId: String(data.cycles[1].id), sleepId: data.sleeps[1].id, recovery: 37, rhr: 58, hrv: 62.8, spo2: 95.7, skinTempC: 33.7, calibrating: false },
  );

  const wo = mapWorkout(data.workouts[0]);
  assert.equal(wo.date, '2026-09-25');
  assert.equal(wo.sport, 'weightlifting'); assert.equal(wo.sportId, 45);
  assert.equal(wo.strain, 11.5); assert.equal(wo.kcal, Math.round(1600.5 / 4.184));
  assert.deepEqual(wo.zonesMin, [2, 20, 25, 12, 5, 1]);

  assert.deepEqual(mapBody({ height_meter: 1.8288, weight_kilogram: 90.7185, max_heart_rate: 195 }), { heightIn: 72, weightLb: 200, maxHr: 195 });

  // Unscored records keep their identity but carry no score values.
  const pending = mapSleep({ ...data.sleeps[0], score_state: 'PENDING_SCORE', score: undefined });
  assert.equal(pending.scoreState, 'PENDING_SCORE'); assert.equal(pending.asleepMin, null); assert.equal(pending.needMin, null);
});

test('whoop sync: first run backfills from 2015 with pagination; recoveries dated by their sleep; forge/app untouched', async () => {
  const v = await makeVault({ serverRecords: { secrets: [tokens()] } });
  const appBefore = await v.files('forge/app');
  const data = whoopDataset({ endDate: '2026-09-26', days: 40 });
  const mock = whoopMock(data);
  const r = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: mock.fetch, now: () => NOW, sleep: noSleep, git: false, log: quiet() });
  assert.equal(r.exitCode, 0);
  assert.equal(r.results.whoop, 'ok');
  assert.equal(mock.calls.filter((c) => c.url.startsWith(WHOOP_TOKEN_URL)).length, 0, 'token valid for > 10 min: no refresh');

  const cycles = (await v.read('forge/server/whoopCycles/2026.enc')).r;
  const sleeps = (await v.read('forge/server/whoopSleep/2026.enc')).r;
  const recs = (await v.read('forge/server/whoopRecovery/2026.enc')).r;
  const wos = (await v.read('forge/server/whoopWorkouts/2026.enc')).r;
  assert.equal(Object.keys(cycles).length, 40);
  assert.equal(Object.keys(sleeps).length, 40);
  assert.equal(Object.keys(recs).length, 40);
  assert.equal(Object.keys(wos).length, 20);
  for (const rec of Object.values(recs)) assert.equal(rec.date, sleeps[rec.sleepId].date, 'recovery date = its sleep date');
  const body = (await v.read('forge/server/whoopBody.enc')).r.body;
  assert.equal(body.weightLb, 200);
  // Record time = WHOOP updated_at, so newer source edits win merges.
  assert.equal(Object.values(cycles)[0]._c, Date.parse('2026-09-26T12:00:00.000Z'));

  // Pagination: limit 25 + nextToken on the second page of the newest chunk.
  const cycleCalls = mock.calls.filter((c) => c.path === '/developer/v2/cycle');
  assert.ok(cycleCalls.every((c) => c.query.limit === '25'));
  assert.ok(cycleCalls.some((c) => c.query.nextToken === '25'), 'second page requested with next_token');
  // Backfill: newest chunk ends now, the oldest starts at 2015-01-01.
  assert.equal(cycleCalls[0].query.end, new Date(NOW).toISOString());
  assert.equal(cycleCalls[cycleCalls.length - 1].query.start, BACKFILL_START);
  // Every data request carries the bearer token; none carries it in the URL.
  for (const c of mock.dataCalls()) { assert.equal(c.headers.Authorization, 'Bearer A1'); assert.ok(!c.url.includes('A1')); }

  const status = (await v.read('forge/server/status.enc')).r;
  assert.equal(status.whoop.lastError, null);
  assert.equal(status.whoop.detail.syncedAt, new Date(NOW).toISOString());
  assert.equal(status.whoop.detail.backfill, 'complete');
  assert.equal(status.whoop.detail.backfillBefore, null);
  assert.equal(status.run.lastError, null);

  assert.deepEqual(await v.files('forge/app'), appBefore, 'automation never writes forge/app/**');

  // Re-syncing identical data: WHOOP shards stay byte-identical (no diff to commit).
  const before = await v.files('forge/server');
  const mock2 = whoopMock(data);
  const later = NOW + 3600e3;
  const r2 = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: mock2.fetch, now: () => later, sleep: noSleep, git: false, log: quiet() });
  assert.equal(r2.results.whoop, 'ok');
  const after = await v.files('forge/server');
  const changed = [...after.keys()].filter((p) => after.get(p) !== before.get(p));
  assert.deepEqual(changed, ['forge/server/status.enc'], 'only the status shard changes');
  // Incremental window: last successful sync − 7 days, no explicit end.
  const incr = mock2.calls.find((c) => c.path === '/developer/v2/cycle');
  assert.equal(incr.query.start, new Date(NOW - 7 * 86400e3).toISOString());
  assert.equal(incr.query.end, undefined);
  assert.deepEqual(await v.files('forge/app'), appBefore);
});

test('whoop sync: 429 honors retry-after, 5xx backs off, newer source data replaces older', async () => {
  const v = await makeVault({ serverRecords: { secrets: [tokens()] } });
  const data = whoopDataset({ endDate: '2026-09-26', days: 5 });
  await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: whoopMock(data).fetch, now: () => NOW, sleep: noSleep, git: false, log: quiet() });

  // WHOOP re-scores the latest recovery.
  const last = data.recoveries[4];
  last.score = { ...last.score, recovery_score: 91 };
  last.updated_at = '2026-09-26T15:30:00.000Z';
  let n429 = 0; let n503 = 0;
  const mock = whoopMock(data, {
    onRequest: (call) => {
      if (call.path === '/developer/v2/cycle' && n429 === 0) { n429++; return json(429, { message: 'Too Many Requests' }, { 'retry-after': '3' }); }
      if (call.path === '/developer/v2/activity/sleep' && n503 === 0) { n503++; return json(503, {}); }
      return null;
    },
  });
  const waits = [];
  const r = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: mock.fetch, now: () => NOW + 3600e3, sleep: async (ms) => { waits.push(ms); }, git: false, log: quiet() });
  assert.equal(r.results.whoop, 'ok');
  assert.ok(waits.includes(3000), 'waited retry-after seconds');
  assert.equal(n503, 1);
  assert.equal(mock.calls.filter((c) => c.path === '/developer/v2/activity/sleep').length, 2, '5xx retried');
  const rec = (await v.read('forge/server/whoopRecovery/2026.enc')).r[String(last.cycle_id)];
  assert.equal(rec.recovery, 91);
  assert.equal(rec._u, Date.parse('2026-09-26T15:30:00.000Z'), 'field time follows updated_at');
});

test('whoop tokens: 401 triggers exactly one refresh; a second 401 means reauth-needed and stops future runs', async () => {
  const v = await makeVault({ serverRecords: { secrets: [tokens()] } });
  const mock = whoopMock(whoopDataset({ days: 3 }), {
    onRequest: (call) => (call.path.startsWith('/developer/') ? json(401, { message: 'Authorization was not valid' }) : null),
  });
  const r = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'auto' }), fetch: mock.fetch, now: () => NOW, sleep: noSleep, git: false, deps: {}, log: quiet() });
  assert.equal(r.exitCode, 0, 'integration errors never fail the job');
  assert.equal(r.results.whoop, 'error');
  const tokenCalls = mock.calls.filter((c) => c.url.startsWith(WHOOP_TOKEN_URL));
  assert.equal(tokenCalls.length, 1);
  assert.deepEqual(tokenCalls[0].form, { grant_type: 'refresh_token', refresh_token: 'R1', client_id: 'client-id', client_secret: 'client-secret-value', scope: 'offline' });
  const status = (await v.read('forge/server/status.enc')).r;
  assert.equal(status.whoop.lastError, 'reauth-needed');
  assert.equal(status.whoop.detail.state, 'reauth-needed');
  const secrets = (await v.read('forge/server/secrets.enc')).r.whoop;
  assert.equal(secrets.refreshToken, 'R2', 'rotated refresh token is kept');
  assert.ok(secrets.invalidAt);

  // Next run does not touch WHOOP until the user reconnects.
  const mock2 = whoopMock(whoopDataset({ days: 3 }));
  const r2 = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'auto' }), fetch: mock2.fetch, now: () => NOW + 3600e3, sleep: noSleep, git: false, deps: {}, log: quiet() });
  assert.equal(r2.results.whoop, 'error');
  assert.equal(mock2.calls.length, 0);
});

test('whoop sync: a refresh that WHOOP rejects (invalid_grant) is reauth-needed; missing client secrets are reported', async () => {
  const v = await makeVault({ serverRecords: { secrets: [tokens({ expiresAt: new Date(NOW + 60e3).toISOString() })] } });
  const mock = whoopMock(whoopDataset({ days: 2 }), {
    onRequest: (call) => (call.url.startsWith(WHOOP_TOKEN_URL) ? json(400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' }) : null),
  });
  const r = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: mock.fetch, now: () => NOW, sleep: noSleep, git: false, log: quiet() });
  assert.equal(r.results.whoop, 'error');
  assert.equal(mock.dataCalls().length, 0, 'no data request with an expiring token that could not be refreshed');
  assert.equal((await v.read('forge/server/status.enc')).r.whoop.lastError, 'reauth-needed');

  const v2 = await makeVault({ serverRecords: { secrets: [tokens()] } });
  const r2 = await runAutomation({ root: v2.dir, env: v2.env({ FORGE_TASK: 'whoop' }), fetch: whoopMock().fetch, now: () => NOW, sleep: noSleep, git: false, log: quiet() });
  assert.equal(r2.results.whoop, 'error');
  assert.match((await v2.read('forge/server/status.enc')).r.whoop.lastError, /WHOOP_CLIENT_ID/);
});

test('whoop backfill resumes across runs when the time budget runs out', async () => {
  const v = await makeVault({ serverRecords: { secrets: [tokens()] } });
  const data = whoopDataset({ endDate: '2026-09-26', days: 30 });
  // The first request of the second (older) chunk outlasts the budget: the newest chunk is
  // complete, the rest must resume next run.
  let delayed = false;
  const mock = whoopMock(data, {
    onRequest: async (call) => {
      if (!delayed && call.path === '/developer/v2/cycle' && call.query.end !== new Date(NOW).toISOString()) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 1100));
      }
      return null;
    },
  });
  const r = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: mock.fetch, now: () => NOW, sleep: noSleep, git: false, whoopBudgetMs: 1000, log: quiet() });
  assert.equal(r.results.whoop, 'ok');
  let st = (await v.read('forge/server/status.enc')).r.whoop.detail;
  assert.equal(st.backfill, 'in-progress');
  assert.ok(st.backfillBefore && st.backfillBefore < new Date(NOW).toISOString());
  assert.equal(st.syncedAt, new Date(NOW).toISOString(), 'newest chunk done: next runs are incremental');
  assert.equal(Object.keys((await v.read('forge/server/whoopCycles/2026.enc')).r).length, 30);

  const mock2 = whoopMock(data);
  const r2 = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: mock2.fetch, now: () => NOW + 3600e3, sleep: noSleep, git: false, log: quiet() });
  assert.equal(r2.results.whoop, 'ok');
  st = (await v.read('forge/server/status.enc')).r.whoop.detail;
  assert.equal(st.backfill, 'complete');
  const starts = mock2.calls.filter((c) => c.path === '/developer/v2/cycle').map((c) => c.query.start);
  assert.equal(starts[0], new Date(NOW - 7 * 86400e3).toISOString(), 'incremental window first');
  assert.equal(starts[starts.length - 1], BACKFILL_START, 'then the rest of the backfill');
});
