// FORGE automation entry point. Bundled to dist/forge-automation.mjs, installed in the vault
// as automation/forge-automation.mjs and run by .github/workflows/forge-sync.yml from the
// vault checkout root. See docs/ARCHITECTURE.md §11 and automation/README.md.
//
// Flow: verify the data key against forge/keyring.json → decrypt every shard into one store
// (owner 'server') → run the task(s), each isolated with a status record → write changed
// forge/server/** shards → commit + push. Exit code 0 unless the data key is missing/wrong
// (or results could not be pushed, which the vault itself cannot record).
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../js/core/store.js';
import { openVault, loadVault, createWriter, writeStatus } from './vault-fs.mjs';
import { createGit } from './git.mjs';
import { createLogger, registerSecret, shortError, realSleep, withTimeout } from './log.mjs';
import { runWhoop, runWhoopAuth, hasWhoopTokens } from './whoop.mjs';
import { runCalendar } from './gcal.mjs';
import { runNotify } from './push.mjs';
import { runReviews } from './reviews.mjs';

/* global __FORGE_AUTOMATION_VERSION__, __FORGE_AUTOMATION_BUILT_AT__ */
export const VERSION = typeof __FORGE_AUTOMATION_VERSION__ === 'string' ? __FORGE_AUTOMATION_VERSION__ : 'dev';
export const BUILT_AT = typeof __FORGE_AUTOMATION_BUILT_AT__ === 'string' ? __FORGE_AUTOMATION_BUILT_AT__ : null;

export const TASKS = ['auto', 'ping', 'whoop', 'whoop-auth', 'whoop-backfill', 'calendar', 'notify', 'push-test', 'reviews'];
export const SECRET_ENV = ['FORGE_DATA_KEY', 'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'GOOGLE_SA_KEY', 'ANTHROPIC_API_KEY', 'VAPID_PRIVATE_KEY', 'FORGE_PAYLOAD'];

// The job times out at 10 minutes; leave room for checkout, commit and push.
const TOTAL_BUDGET_MS = 8.5 * 60 * 1000;
const WHOOP_BUDGET_AUTO_MS = 5 * 60 * 1000;
const WHOOP_BUDGET_ONLY_MS = 7.5 * 60 * 1000;

// Analytics / AI modules (built by other modules of the app). Loaded lazily so a missing or
// broken module only disables the features that need it; esbuild bundles these literals.
export async function loadDeps() {
  const load = (p) => p.then((m) => m, (e) => ({ __error: e }));
  const [readiness, protocols, nutrition, body, weekly, correlations, daily, aiReviews] = await Promise.all([
    load(import('../js/analytics/readiness.js')),
    load(import('../js/analytics/protocols.js')),
    load(import('../js/analytics/nutrition.js')),
    load(import('../js/analytics/body.js')),
    load(import('../js/analytics/weekly.js')),
    load(import('../js/analytics/correlations.js')),
    load(import('../js/analytics/daily.js')),
    load(import('../js/ai/reviews.js')),
  ]);
  return { readiness, protocols, nutrition, body, weekly, correlations, daily, aiReviews };
}

const NEEDS = {
  readiness: ['readiness'], protocols: ['dueItems'], nutrition: ['dayNutrition'], body: ['bodySummary'],
  weekly: ['weekStats'], correlations: ['findDrivers'], daily: ['buildDaily'], aiReviews: ['nutritionReview', 'weeklyReview'],
};

function makeNeed(deps) {
  return (name) => {
    const m = deps && deps[name];
    if (!m || m.__error || m.__forgeMissing) throw new Error(`${name} module is not available in this build`);
    for (const fn of NEEDS[name] || []) if (typeof m[fn] !== 'function') throw new Error(`${name}.${fn} is not available in this build`);
    return m;
  };
}

function validTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

/**
 * Run one automation task against the vault checkout at `root`.
 * Options (all optional; tests inject them): env, root, task, fetch, now, sleep, sender,
 * deps, log, git (false = write files but do not commit), budgetMs, whoopBudgetMs.
 * Resolves { exitCode, results, store }.
 */
export async function runAutomation(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || createLogger();
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || realSleep;
  const root = opts.root || process.cwd();
  const rawTask = String(opts.task || env.FORGE_TASK || 'auto').trim().toLowerCase() || 'auto';
  const known = TASKS.includes(rawTask);
  const task = known ? rawTask : 'unknown';
  const startedAt = Date.now();
  for (const k of SECRET_ENV) registerSecret(env[k]);
  log.info(`automation ${VERSION}${BUILT_AT ? ` (built ${BUILT_AT})` : ''} task=${task}`);

  let vault;
  try {
    vault = await openVault({ root, dekB64: env.FORGE_DATA_KEY });
  } catch (e) {
    if (e && e.fatal) { log.error(e.message); return { exitCode: 1, error: e.message, results: {} }; }
    throw e;
  }

  const clock = { at: null };
  const store = createStore({ owner: 'server', clock: () => clock.at ?? now() });
  const loaded = await loadVault({ root, key: vault.key, store });
  log.info(`vault: ${loaded.loaded} shard(s) loaded (${loaded.app} app, ${loaded.server} server)`);
  // The key matched the keyring, so these are corrupt or foreign files. They are left untouched
  // (never overwritten) and need a look; paths carry no data.
  if (loaded.unreadable.size) log.error(`vault: ${loaded.unreadable.size} shard(s) could not be decrypted and will not be written: ${[...loaded.unreadable].join(', ')}`);
  const writer = createWriter({ root, key: vault.key, store, baseline: loaded.baseline, unreadable: loaded.unreadable, log });
  const git = opts.git === false ? null : createGit({ cwd: root, env, log, sleep });
  const baseFetch = opts.fetch || ((...a) => globalThis.fetch(...a));
  const budget = opts.budgetMs ?? TOTAL_BUDGET_MS;
  const needsDeps = ['auto', 'calendar', 'notify', 'reviews'].includes(task);

  const ctx = {
    env, log, now, sleep, root, store, task,
    key: vault.key,
    tz: validTz(store.setting('profile').timezone) || 'UTC',
    fetch: withTimeout(baseFetch, 30000),   // callers that pass their own signal keep it
    sender: opts.sender || null,
    deps: opts.deps || (needsDeps ? await loadDeps() : {}),
    startedAt,
    deadline: startedAt + budget,
    whoopDeadline: startedAt + (opts.whoopBudgetMs ?? Math.min(budget, task === 'auto' ? WHOOP_BUDGET_AUTO_MS : WHOOP_BUDGET_ONLY_MS)),
    persistErrors: [],
    withTime(t, fn) { const prev = clock.at; clock.at = t; try { return fn(); } finally { clock.at = prev; } },
    // Write changed server shards and commit + push them right now (token rotations).
    async checkpoint(message) {
      const written = await writer.flush();
      if (!git) return { written: written.length, pushed: false };
      git.stage(written);
      try {
        const r = await git.commitAndPush(message);
        log.info(`git: checkpoint ${r.committed ? 'committed' : 'had nothing new'}${r.pushed ? `, pushed (attempt ${r.attempts})` : ''}`);
        return { written: written.length, ...r };
      } catch (e) {
        const m = shortError(e);
        ctx.persistErrors.push(m);
        log.error(`git: checkpoint failed: ${m}`);
        return { written: written.length, pushed: false, error: m };
      }
    },
  };
  ctx.need = makeNeed(ctx.deps);
  const unavailable = Object.entries(ctx.deps).filter(([, m]) => !m || m.__error || m.__forgeMissing)
    .map(([name, m]) => (m && m.__error ? `${name} (${shortError(m.__error, 80)})` : name));
  if (unavailable.length) log.warn(`modules unavailable in this build: ${unavailable.join(', ')}`);
  if (!validTz(store.setting('profile').timezone)) log.warn('profile timezone not set: using UTC');

  const steps = [];
  const incremental = { mode: 'incremental' };
  switch (task) {
    case 'auto':
      if (hasWhoopTokens(store)) steps.push(['whoop', () => runWhoop(ctx, incremental)]);
      if (String(env.GOOGLE_SA_KEY || '').trim()) steps.push(['calendar', () => runCalendar(ctx)]);
      steps.push(['reviews', () => runReviews(ctx)]);
      steps.push(['push', () => runNotify(ctx)]);
      break;
    case 'whoop': steps.push(['whoop', () => runWhoop(ctx, { ...incremental, explicit: true })]); break;
    case 'whoop-backfill': steps.push(['whoop', () => runWhoop(ctx, { mode: 'backfill', explicit: true })]); break;
    case 'whoop-auth': steps.push(['whoop', () => runWhoopAuth(ctx)]); break;
    case 'calendar': steps.push(['calendar', () => runCalendar(ctx, { explicit: true })]); break;
    case 'notify': steps.push(['push', () => runNotify(ctx, { explicit: true })]); break;
    case 'push-test': steps.push(['push', () => runNotify(ctx, { explicit: true, test: true })]); break;
    case 'reviews': steps.push(['reviews', () => runReviews(ctx, { explicit: true })]); break;
    default: break;   // ping / unknown: status only
  }

  const results = {};
  for (const [id, fn] of steps) {
    if (Date.now() > ctx.deadline) { results[id] = 'skipped'; log.warn(`${id}: skipped (time budget used up)`); continue; }
    let r;
    try { r = (await fn()) || { ok: true }; } catch (e) { r = { ok: false, error: shortError(e) }; }
    results[id] = r.skipped ? 'skipped' : r.ok ? 'ok' : 'error';
    if (!r.quiet) writeStatus(ctx, id, { ok: !!r.ok, skipped: !!r.skipped, error: r.error, detail: r.detail });
    if (r.quiet) continue;
    log.info(`${id}: ${results[id]}${r.summary ? ` ${r.summary}` : ''}${results[id] === 'error' && r.error ? `: ${shortError(r.error)}` : ''}`);
  }

  const failed = Object.keys(results).filter((k) => results[k] === 'error');
  const runError = !known ? `unknown task (expected one of: ${TASKS.join(', ')})` : failed.length ? `failed: ${failed.join(', ')}` : null;
  writeStatus(ctx, 'run', {
    ok: !runError,
    error: runError,
    detail: {
      version: VERSION, builtAt: BUILT_AT, task, steps: results,
      durationMs: Date.now() - startedAt,
      unreadableShards: loaded.unreadable.size,
      checkpointErrors: ctx.persistErrors.length,
    },
    extra: { version: VERSION },
  });
  if (!known) log.error(runError);

  let exitCode = 0;
  try {
    const written = await writer.flush();
    log.info(`vault: ${written.length} shard(s) written`);
    if (git) {
      git.stage(written);
      const r = await git.commitAndPush(`forge: automation ${task}`);
      log.info(r.committed ? `git: committed and pushed (attempt ${r.attempts})` : r.pushed ? `git: pushed earlier commit (attempt ${r.attempts})` : 'git: nothing to commit');
    }
  } catch (e) {
    log.error(`persist failed: ${shortError(e)}`);
    exitCode = 1;
  }
  log.info(`done in ${Math.round((Date.now() - startedAt) / 100) / 10}s`);
  return { exitCode, results, store };
}

export async function main() {
  let code = 1;
  try {
    ({ exitCode: code } = await runAutomation());
  } catch (e) {
    console.error(`[forge] fatal: ${shortError(e)}`);
    code = 1;
  }
  process.exitCode = code;
  // Keep-alive sockets must not hold the job open.
  setTimeout(() => process.exit(code), 3000).unref();
  return code;
}

function isEntryPoint() {
  try {
    return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) main();
