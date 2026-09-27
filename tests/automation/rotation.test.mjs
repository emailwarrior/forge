// Token rotation ordering against a real git repository with a bare remote: rotated WHOOP
// tokens must be committed AND pushed before the first data request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutomation } from '../../automation/run.mjs';
import { WHOOP_TOKEN_URL, PAYLOAD_PATH } from '../../automation/whoop.mjs';
import { createLogger } from '../../automation/log.mjs';
import { encryptBytes, decodeJson } from '../../js/core/crypto.js';
import { bytesToB64 } from '../../js/core/util.js';
import { makeVault, whoopDataset, whoopMock, remoteLog, remoteFile, git, noSleep, edt } from './fixtures/helpers.mjs';

const NOW = edt('2026-09-26', '12:00');
const creds = { WHOOP_CLIENT_ID: 'client-id', WHOOP_CLIENT_SECRET: 'client-secret-value' };
const SECRETS = 'forge/server/secrets.enc';

async function remoteTokens(v) {
  try { return (await decodeJson(v.key, SECRETS, remoteFile(v.remote, SECRETS))).r.whoop; } catch { return null; }
}

test('rotation: expiring token is refreshed, committed and pushed before any WHOOP data request', async () => {
  const v = await makeVault({
    withGit: true,
    serverRecords: { secrets: [{ id: 'whoop', accessToken: 'A1', refreshToken: 'R1', expiresAt: new Date(NOW + 5 * 60e3).toISOString(), scope: 'offline', obtainedAt: new Date(NOW - 55 * 60e3).toISOString() }] },
  });
  const initial = git(v.dir, ['rev-parse', 'HEAD']);
  const order = [];
  let atFirstData = null;   // what the remote held when the first data request went out
  const mock = whoopMock(whoopDataset({ days: 10 }), {
    onRequest: async (call) => {
      if (call.url.startsWith(WHOOP_TOKEN_URL)) { order.push('token'); return null; }
      if (call.path.startsWith('/developer/')) {
        order.push('data');
        if (!atFirstData) atFirstData = { tokens: await remoteTokens(v), head: remoteLog(v.remote)[0] };
      }
      return null;
    },
  });
  const log = createLogger({ quiet: true });
  const r = await runAutomation({ root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop' }), fetch: mock.fetch, now: () => NOW, sleep: noSleep, log });
  assert.equal(r.exitCode, 0);
  assert.equal(r.results.whoop, 'ok');
  assert.ok(atFirstData, 'data was fetched');
  assert.equal(atFirstData.tokens && atFirstData.tokens.refreshToken, 'R2', 'rotated refresh token pushed before the first data request');
  assert.equal(atFirstData.tokens.accessToken, 'A2');
  assert.deepEqual(atFirstData.head.split('|'), ['forge-bot', 'forge-bot@users.noreply.github.com', 'forge: whoop token rotation']);
  assert.equal(order[0], 'token');
  assert.equal(order.filter((x) => x === 'token').length, 1, 'exactly one rotation');
  assert.deepEqual(mock.calls.find((c) => c.url.startsWith(WHOOP_TOKEN_URL)).form, {
    grant_type: 'refresh_token', refresh_token: 'R1', client_id: 'client-id', client_secret: 'client-secret-value', scope: 'offline',
  });

  // Remote history: rotation first, then the data commit, both by forge-bot.
  const logLines = remoteLog(v.remote);
  assert.deepEqual(logLines.slice(0, 2).map((l) => l.split('|')[2]), ['forge: automation whoop', 'forge: whoop token rotation']);
  for (const l of logLines.slice(0, 2)) assert.ok(l.startsWith('forge-bot|forge-bot@users.noreply.github.com|'));
  // Only forge/server/** changed on the remote.
  const changed = git(v.remote, ['diff', '--name-only', initial, 'main']).split('\n').filter(Boolean);
  assert.ok(changed.length > 3);
  for (const p of changed) assert.ok(p.startsWith('forge/server/'), p);
  assert.equal((await remoteTokens(v)).refreshToken, 'R2');
  // Working tree is clean and in sync with the remote.
  assert.equal(git(v.dir, ['status', '--porcelain']), '');
  assert.equal(git(v.dir, ['rev-parse', 'HEAD']), git(v.remote, ['rev-parse', 'main']));
  // Logs never contain token values or the client secret.
  const text = log.lines.join('\n');
  for (const s of ['A1', 'A2', 'R1', 'R2', 'client-secret-value']) assert.ok(!new RegExp(`\\b${s}\\b`).test(text), `log leaks ${s}`);
});

test('whoop-auth: decrypts the payload, exchanges the code, pushes tokens, then backfills', async () => {
  const v = await makeVault({ withGit: true });
  const payload = { code: 'auth-code-123456', redirectUri: 'https://example.github.io/forge/', state: 'st4te', at: new Date(NOW - 60e3).toISOString() };
  const blob = await encryptBytes(v.key, new TextEncoder().encode(JSON.stringify(payload)), PAYLOAD_PATH);
  let atFirstData = null;
  const mock = whoopMock(whoopDataset({ days: 8 }), {
    tokens: () => ({ access_token: 'AX', refresh_token: 'RX', expires_in: 3600, scope: 'offline read:recovery read:cycles read:sleep read:workout read:body_measurement', token_type: 'bearer' }),
    onRequest: async (call) => {
      if (call.path.startsWith('/developer/') && !atFirstData) atFirstData = { tokens: await remoteTokens(v), head: remoteLog(v.remote)[0] };
      return null;
    },
  });
  const r = await runAutomation({
    root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop-auth', FORGE_PAYLOAD: bytesToB64(blob) }),
    fetch: mock.fetch, now: () => NOW, sleep: noSleep, log: createLogger({ quiet: true }),
  });
  assert.equal(r.results.whoop, 'ok');
  assert.ok(atFirstData);
  assert.equal(atFirstData.tokens && atFirstData.tokens.refreshToken, 'RX', 'tokens pushed before the backfill starts');
  assert.equal(atFirstData.head.split('|')[2], 'forge: whoop connected');
  const exchange = mock.calls.find((c) => c.url.startsWith(WHOOP_TOKEN_URL));
  assert.deepEqual(exchange.form, { grant_type: 'authorization_code', code: 'auth-code-123456', redirect_uri: 'https://example.github.io/forge/', client_id: 'client-id', client_secret: 'client-secret-value' });
  assert.equal(mock.calls.filter((c) => c.url.startsWith(WHOOP_TOKEN_URL)).length, 1, 'fresh tokens are not refreshed again');
  const status = (await v.read('forge/server/status.enc')).r.whoop;
  assert.equal(status.lastError, null);
  assert.equal(status.detail.backfill, 'complete');
  assert.ok(status.detail.connectedAt);
  assert.equal(Object.keys((await v.read('forge/server/whoopSleep/2026.enc')).r).length, 8);
  assert.equal(git(v.dir, ['rev-parse', 'HEAD']), git(v.remote, ['rev-parse', 'main']));

  // A tampered / foreign payload is rejected without touching the token endpoint.
  const other = await makeVault({ withGit: true });
  const foreign = await encryptBytes(other.key, new TextEncoder().encode(JSON.stringify(payload)), PAYLOAD_PATH);
  const mock2 = whoopMock();
  const r2 = await runAutomation({
    root: v.dir, env: v.env({ ...creds, FORGE_TASK: 'whoop-auth', FORGE_PAYLOAD: bytesToB64(foreign) }),
    fetch: mock2.fetch, now: () => NOW + 60e3, sleep: noSleep, log: createLogger({ quiet: true }),
  });
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.results.whoop, 'error');
  assert.equal(mock2.calls.length, 0);
  assert.match((await v.read('forge/server/status.enc')).r.whoop.lastError, /auth payload rejected/);
  assert.equal((await v.read(SECRETS)).r.whoop.refreshToken, 'RX', 'existing tokens untouched');
});
