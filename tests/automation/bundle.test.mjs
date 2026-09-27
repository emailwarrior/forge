// Build dist/forge-automation.mjs and smoke-test it the way the workflow runs it:
// `node automation/forge-automation.mjs` from the root of a vault checkout (git + remote).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeVault, git, remoteLog, GIT_ENV } from './fixtures/helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(ROOT, 'dist/forge-automation.mjs');
const REQUIRED = ['readiness', 'protocols', 'nutrition', 'body', 'weekly', 'correlations', 'daily']
  .map((n) => `js/analytics/${n}.js`).concat(['js/ai/reviews.js']);

test('bundle: self-contained build; ping from a vault checkout commits a status shard', async (t) => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const missing = REQUIRED.filter((p) => !existsSync(join(ROOT, p)));
  const args = [join(ROOT, 'tools/build-automation.mjs')];
  if (missing.length) {
    t.diagnostic(`analytics/AI modules not present yet, building with --allow-missing: ${missing.join(', ')}`);
    args.push('--allow-missing');
  }
  const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /dist\/forge-automation\.mjs/);

  const bytes = await readFile(BUNDLE);
  const info = JSON.parse(await readFile(join(ROOT, 'dist/automation-version.json'), 'utf8'));
  assert.equal(info.version, pkg.version);
  assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(info.bytes, bytes.length);
  assert.ok(Date.parse(info.builtAt));
  assert.deepEqual(info.missing || [], missing);
  const text = bytes.toString('utf8');
  assert.ok(text.startsWith(`// FORGE automation v${pkg.version}, built ${info.builtAt}`), 'banner with version + build time');
  for (const m of text.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)) assert.match(m[1], /^node:/, `only Node built-ins are imported (${m[1]})`);

  // Install into a vault checkout exactly like the app does.
  const v = await makeVault({ withGit: true });
  await mkdir(join(v.dir, 'automation'), { recursive: true });
  await copyFile(BUNDLE, join(v.dir, 'automation/forge-automation.mjs'));
  git(v.dir, ['add', '-A']);
  git(v.dir, ['commit', '-q', '-m', 'install automation']);
  git(v.dir, ['push', '-q', 'origin', 'main']);

  // Loads with no node_modules anywhere above it.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(join(v.dir, 'automation/forge-automation.mjs')).href)}); console.log(typeof m.runAutomation, m.VERSION);`],
  { cwd: v.dir, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), `function ${pkg.version}`);

  const env = { ...GIT_ENV, FORGE_DATA_KEY: v.dekB64, FORGE_TASK: 'ping', FORGE_PAYLOAD: '' };
  const res = spawnSync(process.execPath, ['automation/forge-automation.mjs'], { cwd: v.dir, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, new RegExp(`\\[forge\\] automation ${pkg.version.replace(/\./g, '\\.')} \\(built `));
  assert.ok(!res.stdout.includes(v.dekB64) && !res.stderr.includes(v.dekB64), 'data key never printed');
  assert.deepEqual(remoteLog(v.remote)[0].split('|'), ['forge-bot', 'forge-bot@users.noreply.github.com', 'forge: automation ping']);
  assert.deepEqual(git(v.remote, ['show', '--name-only', '--format=', 'main']).split('\n'), ['forge/server/status.enc']);
  const run = (await v.read('forge/server/status.enc')).r.run;
  assert.equal(run.version, pkg.version);
  assert.equal(run.detail.builtAt, info.builtAt);
  assert.equal(run.lastError, null);

  // `auto` evaluates the lazily loaded analytics/AI modules inside the bundle.
  const auto = spawnSync(process.execPath, ['automation/forge-automation.mjs'], { cwd: v.dir, env: { ...env, FORGE_TASK: 'auto' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(auto.status, 0, auto.stderr + auto.stdout);
  if (!missing.length) assert.ok(!/modules unavailable/.test(auto.stdout + auto.stderr), auto.stdout + auto.stderr);
  assert.equal(remoteLog(v.remote)[0].split('|')[2], 'forge: automation auto');

  // Wrong key: non-zero exit, clear message, nothing committed.
  const head = git(v.remote, ['rev-parse', 'main']);
  const bad = spawnSync(process.execPath, ['automation/forge-automation.mjs'], { cwd: v.dir, env: { ...env, FORGE_DATA_KEY: randomBytes(32).toString('base64') }, encoding: 'utf8', timeout: 60000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr + bad.stdout, /does not match this vault/);
  assert.equal(git(v.remote, ['rev-parse', 'main']), head);
});
