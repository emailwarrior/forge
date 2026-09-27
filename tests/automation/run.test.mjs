import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutomation, VERSION } from '../../automation/run.mjs';
import { createLogger, redact, registerSecret, shortError } from '../../automation/log.mjs';
import { bytesToB64 } from '../../js/core/util.js';
import { randomBytes } from '../../js/core/crypto.js';
import { makeVault, git, remoteLog, stubDeps, noSleep, edt, GIT_ENV, track } from './fixtures/helpers.mjs';

const NOW = edt('2026-09-26', '12:00');

test('run: a data key that does not match the vault aborts with exit code 1 and writes nothing', async () => {
  const v = await makeVault();
  const before = await v.files('forge');
  const log = createLogger({ quiet: true });
  const wrong = bytesToB64(randomBytes(32));
  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_DATA_KEY: wrong, FORGE_TASK: 'auto' }), now: () => NOW, git: false, log });
  assert.equal(r.exitCode, 1);
  assert.match(r.error, /does not match this vault/);
  assert.deepEqual(await v.files('forge'), before);
  assert.ok(!log.lines.join('\n').includes(wrong), 'the key is never printed');

  const missing = await runAutomation({ root: v.dir, env: v.env({ FORGE_DATA_KEY: '' }), now: () => NOW, git: false, log: createLogger({ quiet: true }) });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.error, /FORGE_DATA_KEY is not set/);

  const short = await runAutomation({ root: v.dir, env: v.env({ FORGE_DATA_KEY: bytesToB64(randomBytes(16)) }), now: () => NOW, git: false, log: createLogger({ quiet: true }) });
  assert.equal(short.exitCode, 1);
  assert.match(short.error, /malformed/);

  const empty = track(await mkdtemp(join(tmpdir(), 'forge-empty-')));
  const nokeyring = await runAutomation({ root: empty, env: v.env(), now: () => NOW, git: false, log: createLogger({ quiet: true }) });
  assert.equal(nokeyring.exitCode, 1);
  assert.match(nokeyring.error, /keyring\.json not found/);

  // A shard encrypted under another key (with a matching keyring) is reported, never overwritten.
  const w = await makeVault();
  const foreign = await makeVault();
  await mkdir(join(w.dir, 'forge/server'), { recursive: true });
  await writeFile(join(w.dir, 'forge/server/status.enc'), await foreign.bytes('forge/app/settings.enc'));
  const r2 = await runAutomation({ root: w.dir, env: w.env({ FORGE_TASK: 'ping' }), now: () => NOW, git: false, log: createLogger({ quiet: true }) });
  assert.equal(r2.exitCode, 0);
  assert.deepEqual(await w.bytes('forge/server/status.enc'), await foreign.bytes('forge/app/settings.enc'), 'unreadable shard left alone');
});

test('run: ping writes status.run {lastRunAt, version} and commits it as forge-bot', async () => {
  const v = await makeVault({ withGit: true });
  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'ping' }), now: () => NOW, sleep: noSleep, log: createLogger({ quiet: true }) });
  assert.equal(r.exitCode, 0);
  const run = (await v.read('forge/server/status.enc')).r.run;
  assert.equal(run.lastRunAt, new Date(NOW).toISOString());
  assert.equal(run.lastOkAt, run.lastRunAt);
  assert.equal(run.lastError, null);
  assert.equal(run.version, VERSION);
  assert.equal(run.detail.task, 'ping');
  assert.deepEqual(remoteLog(v.remote)[0].split('|'), ['forge-bot', 'forge-bot@users.noreply.github.com', 'forge: automation ping']);
  assert.deepEqual(git(v.remote, ['show', '--name-only', '--format=', 'main']).split('\n'), ['forge/server/status.enc']);
  assert.equal(git(v.dir, ['status', '--porcelain']), '');
});

test('run: unknown task is recorded, never echoed, and exits 0', async () => {
  const v = await makeVault();
  const log = createLogger({ quiet: true });
  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: '$(rm -rf /) weird' }), now: () => NOW, git: false, log });
  assert.equal(r.exitCode, 0);
  const run = (await v.read('forge/server/status.enc')).r.run;
  assert.match(run.lastError, /unknown task/);
  assert.equal(run.detail.task, 'unknown');
  assert.ok(!log.lines.join('\n').includes('rm -rf'));
});

test('run: auto with nothing connected only records the run', async () => {
  const v = await makeVault();
  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'auto' }), now: () => NOW, sleep: noSleep, deps: stubDeps().deps, git: false, log: createLogger({ quiet: true }) });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.results, { reviews: 'skipped', push: 'skipped' });
  const status = (await v.read('forge/server/status.enc')).r;
  assert.deepEqual(Object.keys(status).sort(), ['run']);
  assert.equal(status.run.lastError, null);
});

test('run: a concurrent app commit is rebased over; only forge/server is committed', async () => {
  const v = await makeVault({ withGit: true });
  // "The app" pushes a new app shard after our checkout.
  const other = `${v.dir}-app`;
  git(v.dir, ['clone', '-q', v.remote, other]);
  await writeFile(join(other, 'forge/app/journal-note.txt'), 'app change');
  git(other, ['add', '-A']);
  git(other, ['commit', '-q', '-m', 'forge: sync']);
  git(other, ['push', '-q', 'origin', 'main']);

  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'ping' }), now: () => NOW, sleep: noSleep, log: createLogger({ quiet: true }) });
  assert.equal(r.exitCode, 0);
  const subjects = remoteLog(v.remote).map((l) => l.split('|')[2]);
  assert.deepEqual(subjects.slice(0, 3), ['forge: automation ping', 'forge: sync', 'init vault']);
  assert.equal(git(v.dir, ['rev-parse', 'HEAD']), git(v.remote, ['rev-parse', 'main']));
});

test('run: results that cannot be pushed fail the job after 5 attempts', async () => {
  const v = await makeVault({ withGit: true });
  await rm(v.remote, { recursive: true, force: true });
  const waits = [];
  const log = createLogger({ quiet: true });
  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'ping' }), now: () => NOW, sleep: async (ms) => { waits.push(ms); }, log });
  assert.equal(r.exitCode, 1);
  assert.equal(waits.length, 4, 'five attempts with backoff in between');
  assert.ok(log.lines.some((l) => /persist failed: git push failed/.test(l)));
  // The commit exists locally, ready for the next attempt.
  assert.match(git(v.dir, ['log', '-1', '--format=%s']), /forge: automation ping/);
});

test('log: secrets and credential-looking strings are redacted', () => {
  registerSecret('super-secret-token-value');
  assert.equal(redact('token super-secret-token-value leaked'), 'token *** leaked');
  assert.equal(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer ***');
  assert.equal(redact('share with me@example.com'), 'share with <email>');
  assert.match(redact('key=' + 'x'.repeat(40)), /key=\*\*\*/);
  assert.equal(shortError(new Error('a\nb   c')), 'a b c');
  assert.ok(shortError('y'.repeat(20) + ' ' + 'z '.repeat(200)).length <= 180);
  assert.ok(GIT_ENV.GIT_CONFIG_GLOBAL);
});

test('git subprocesses never inherit vault secrets', async () => {
  const { gitSafeEnv } = await import('../../automation/git.mjs');
  const env = gitSafeEnv({ PATH: '/usr/bin', HOME: '/home/runner', FORGE_DATA_KEY: 'k', GOOGLE_SA_KEY: '{}', ANTHROPIC_API_KEY: 'a', VAPID_PRIVATE_KEY: 'v', WHOOP_CLIENT_SECRET: 's', FORGE_PAYLOAD: 'p' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});
