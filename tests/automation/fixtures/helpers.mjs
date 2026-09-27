// Test fixtures for automation: temp encrypted vaults (optionally git repos with a bare
// remote), WHOOP / Google Calendar mock servers, a push sender stub and analytics/AI stubs.
// Everything is offline: importing this module disables the real global fetch.
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createStore } from '../../../js/core/store.js';
import { loadDemo } from '../../../js/dev/demo.js';
import { encodeJson, decodeJson, keyId, importDek, randomBytes } from '../../../js/core/crypto.js';
import { bytesToB64, addDays, isoWeek, dayOfWeek, pad2, hashId } from '../../../js/core/util.js';
import { parseShardPath, KEYRING_PATH } from '../../../js/core/schema.js';

globalThis.fetch = async () => { throw new Error('network access is disabled in tests'); };

// Temp directories created by this test process are removed when it exits.
const tempPaths = new Set();
export function track(path) { tempPaths.add(path); return path; }
process.on('exit', () => { for (const p of tempPaths) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } } });

export const TZ = 'America/New_York';
export const noSleep = async () => {};
// Wall time in New York (EDT, UTC−4 in late September) → epoch ms.
export const edt = (ymd, hm) => Date.parse(`${ymd}T${hm}:00-04:00`);

/* ------------------------------------------------------------------ git */
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function remoteLog(remote) {
  return git(remote, ['log', '--format=%an|%ae|%s', 'main']).split('\n').filter(Boolean);
}
export function remoteFile(remote, path) {
  return new Uint8Array(execFileSync('git', ['show', `main:${path}`], { cwd: remote, env: GIT_ENV }));
}

/* ---------------------------------------------------------------- vault */
async function writeShard(dir, key, path, shard) {
  const abs = join(dir, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, await encodeJson(key, path, shard));
}

/**
 * Create a temp vault: keyring + encrypted demo app shards (+ demo server shards when
 * `server`), optional extra server records, optional git repo with a bare remote.
 */
export async function makeVault({ today = '2026-09-26', days = 45, server = false, mutate, serverRecords, withGit = false } = {}) {
  const dir = track(await mkdtemp(join(tmpdir(), 'forge-vault-')));
  track(`${dir}-remote.git`);
  track(`${dir}-app`);
  const dekRaw = randomBytes(32);
  const dekB64 = bytesToB64(dekRaw);
  const key = await importDek(dekRaw);
  await mkdir(join(dir, 'forge'), { recursive: true });
  await writeFile(join(dir, KEYRING_PATH), JSON.stringify({ v: 1, kid: await keyId(dekRaw), createdAt: new Date().toISOString() }, null, 2));
  await writeFile(join(dir, 'forge/meta.json'), JSON.stringify({ schema: 3, encrypted: true, createdAt: new Date().toISOString() }));

  const app = createStore({ owner: 'app' });
  loadDemo(app, { today, days, tz: TZ });
  if (mutate) await mutate(app);
  for (const path of app.shardPaths()) {
    const info = parseShardPath(path);
    if (info.owner === 'server' && !server) continue;
    await writeShard(dir, key, path, app.serializeShard(path));
  }
  if (serverRecords) {
    const s = createStore({ owner: 'server' });
    for (const [coll, list] of Object.entries(serverRecords)) for (const r of list) { const { id, ...f } = r; s.update(coll, id, f); }
    for (const { path } of s.dirty()) {
      let existing = null;
      try { existing = await decodeJson(key, path, new Uint8Array(await readFile(join(dir, path)))); } catch { existing = null; }
      const shard = s.serializeShard(path);
      if (existing) shard.r = { ...existing.r, ...shard.r };
      await writeShard(dir, key, path, shard);
    }
  }
  const vault = {
    dir, key, dekB64, app,
    env: (extra = {}) => ({ ...GIT_ENV, FORGE_DATA_KEY: dekB64, FORGE_TASK: '', FORGE_PAYLOAD: '', ...extra }),
    read: async (path) => decodeJson(key, path, new Uint8Array(await readFile(join(dir, path)))),
    tryRead: async (path) => { try { return await vault.read(path); } catch { return null; } },
    bytes: async (path) => new Uint8Array(await readFile(join(dir, path))),
    files: (sub) => hashTree(dir, sub),
    // Simulate the app writing one of its shards.
    writeApp: async (path) => writeShard(dir, key, path, app.serializeShard(path)),
    // Overwrite any shard with a given plaintext (e.g. to simulate a lost commit).
    writeRaw: async (path, shard) => writeShard(dir, key, path, shard),
    remote: null,
  };
  if (withGit) {
    const remote = `${dir}-remote.git`;
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env: GIT_ENV });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init vault']);
    git(dir, ['remote', 'add', 'origin', remote]);
    git(dir, ['push', '-q', '-u', 'origin', 'main']);
    vault.remote = remote;
  }
  return vault;
}

export async function hashTree(root, sub = '') {
  const out = new Map();
  async function walk(abs, rel) {
    let entries = [];
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(abs, e.name), r);
      else out.set(r, createHash('sha256').update(await readFile(join(abs, e.name))).digest('hex'));
    }
  }
  await walk(join(root, sub), sub);
  return out;
}

/* ----------------------------------------------------------------- HTTP */
export const json = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

/* ---------------------------------------------------------------- WHOOP */
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const z = (ms) => new Date(ms).toISOString();

// Realistic WHOOP v2 records for `days` nights ending on `endDate` (New York, −04:00).
export function whoopDataset({ endDate = '2026-09-26', days = 40, updatedAt = '2026-09-26T12:00:00.000Z' } = {}) {
  const cycles = [], sleeps = [], recoveries = [], workouts = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(endDate, -(days - 1 - i));
    const bed = Date.parse(`${addDays(date, -1)}T23:10:00-04:00`);
    const wake = Date.parse(`${date}T06:40:00-04:00`);
    const cycleId = 93000000 + i;
    const sleepId = uuid(i + 1);
    const next = i < days - 1 ? Date.parse(`${date}T23:10:00-04:00`) : null;
    cycles.push({
      id: cycleId, user_id: 1, created_at: z(bed), updated_at: updatedAt, start: z(bed), end: next ? z(next) : null,
      timezone_offset: '-04:00', score_state: 'SCORED',
      score: { strain: 8 + (i % 7) + 0.2951, kilojoule: 8288.297 + i, average_heart_rate: 68, max_heart_rate: 160 + (i % 10) },
    });
    sleeps.push({
      id: sleepId, cycle_id: cycleId, user_id: 1, created_at: z(wake), updated_at: updatedAt, start: z(bed), end: z(wake),
      timezone_offset: '-04:00', nap: false, score_state: 'SCORED',
      score: {
        stage_summary: {
          total_in_bed_time_milli: 27000000, total_awake_time_milli: 1800000, total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 12000000, total_slow_wave_sleep_time_milli: 6000000, total_rem_sleep_time_milli: 5400000 + i * 60000,
          sleep_cycle_count: 4, disturbance_count: 9,
        },
        sleep_needed: { baseline_milli: 27000000, need_from_sleep_debt_milli: 1200000, need_from_recent_strain_milli: 600000, need_from_recent_nap_milli: -300000 },
        respiratory_rate: 16.11328125, sleep_performance_percentage: 82, sleep_consistency_percentage: 71, sleep_efficiency_percentage: 91.4567,
      },
    });
    recoveries.push({
      cycle_id: cycleId, sleep_id: sleepId, user_id: 1, created_at: z(wake + 600000), updated_at: updatedAt, score_state: 'SCORED',
      score: { user_calibrating: false, recovery_score: 30 + ((i * 7) % 60), resting_heart_rate: 58, hrv_rmssd_milli: 61.813562 + i, spo2_percentage: 95.6875, skin_temp_celsius: 33.7 },
      _t: bed,
    });
    if (i % 2 === 0) {
      const ws = Date.parse(`${date}T17:00:00-04:00`);
      workouts.push({
        id: uuid(5000 + i), user_id: 1, created_at: z(ws + 3900000), updated_at: updatedAt, start: z(ws), end: z(ws + 3900000),
        timezone_offset: '-04:00', sport_name: 'weightlifting', sport_id: 45, score_state: 'SCORED',
        score: {
          strain: 11.456, average_heart_rate: 121, max_heart_rate: 171, kilojoule: 1600.5, percent_recorded: 100, distance_meter: null,
          altitude_gain_meter: null, altitude_change_meter: null,
          zone_durations: { zone_zero_milli: 120000, zone_one_milli: 1200000, zone_two_milli: 1500000, zone_three_milli: 720000, zone_four_milli: 300000, zone_five_milli: 60000 },
        },
      });
    }
  }
  return { cycles, sleeps, recoveries, workouts, body: { height_meter: 1.8288, weight_kilogram: 90.7185, max_heart_rate: 195 } };
}

/**
 * WHOOP API mock over a dataset. `onRequest(call, calls)` may return a Response to override.
 * Collections honor start (inclusive) / end (exclusive) on the record start, newest first,
 * `limit` ≤ 25 and an offset-based next_token.
 */
export function whoopMock(data = whoopDataset(), { onRequest, tokens = () => ({ access_token: 'A2', refresh_token: 'R2', expires_in: 3600, scope: 'offline read:recovery', token_type: 'bearer' }) } = {}) {
  const calls = [];
  const sets = { '/v2/cycle': data.cycles, '/v2/activity/sleep': data.sleeps, '/v2/activity/workout': data.workouts, '/v2/recovery': data.recoveries };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { url: String(url), path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? String(init.body) : null };
    call.form = call.body ? Object.fromEntries(new URLSearchParams(call.body)) : null;
    calls.push(call);
    if (onRequest) { const r = await onRequest(call, calls); if (r) return r; }
    if (u.origin + u.pathname === 'https://api.prod.whoop.com/oauth/oauth2/token') return json(200, tokens(call));
    const path = u.pathname.replace(/^\/developer/, '');
    if (sets[path]) {
      const start = call.query.start ? Date.parse(call.query.start) : -Infinity;
      const end = call.query.end ? Date.parse(call.query.end) : Infinity;
      const limit = Math.min(25, Number(call.query.limit) || 10);
      const t = (r) => (r._t ?? Date.parse(r.start));
      const all = sets[path].filter((r) => t(r) >= start && t(r) < end).sort((a, b) => t(b) - t(a));
      const offset = Number(call.query.nextToken || 0);
      const page = all.slice(offset, offset + limit).map(({ _t, ...r }) => r);
      return json(200, { records: page, next_token: offset + limit < all.length ? String(offset + limit) : null });
    }
    if (path === '/v2/user/measurement/body') return json(200, data.body);
    return json(404, { error: 'not found' });
  };
  return { fetch, calls, dataCalls: () => calls.filter((c) => c.path.startsWith('/developer/')) };
}

/* --------------------------------------------------------------- Google */
export function googleEvent(id, { date, start, end, summary = 'Meeting', tz = TZ, allDay = false, status = 'confirmed', attendees, organizerSelf = false, forgeRef, updated = '2026-09-20T10:00:00.000Z' }) {
  const ev = { kind: 'calendar#event', id, status, summary, updated, organizer: { email: 'someone@example.com', self: organizerSelf } };
  if (allDay) { ev.start = { date }; ev.end = { date: end || addDays(date, 1) }; }
  else { ev.start = { dateTime: `${date}T${start}:00-04:00`, timeZone: tz }; ev.end = { dateTime: `${date}T${end}:00-04:00`, timeZone: tz }; }
  if (attendees) ev.attendees = attendees;
  if (forgeRef) ev.extendedProperties = { private: { forgeRef } };
  return ev;
}

/** Google OAuth + Calendar v3 mock. calendars: { id: [event] }. */
export function googleMock({ calendars = {}, pageSize = 2, deleteStatus = null, now = () => Date.now() } = {}) {
  const calls = []; let seq = 1;
  const evStart = (e) => Date.parse(e.start.dateTime || `${e.start.date}T00:00:00-04:00`);
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const call = { method, url: String(url), path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : String(init.body)) : null };
    calls.push(call);
    if (u.href === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.test-access-token', expires_in: 3599, token_type: 'Bearer' });
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return json(404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });
    const calId = decodeURIComponent(m[1]); const evId = m[2] ? decodeURIComponent(m[2]) : null;
    call.calendarId = calId; call.eventId = evId;
    const list = calendars[calId];
    if (!list) return json(404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });
    if (method === 'GET' && !evId) {
      const tMin = Date.parse(call.query.timeMin), tMax = Date.parse(call.query.timeMax);
      const all = list.filter((e) => evStart(e) >= tMin && evStart(e) < tMax).sort((a, b) => evStart(a) - evStart(b));
      const offset = Number(call.query.pageToken || 0);
      const items = all.slice(offset, offset + pageSize);
      const body = { kind: 'calendar#events', items: structuredClone(items) };
      if (offset + pageSize < all.length) body.nextPageToken = String(offset + pageSize);
      return json(200, body);
    }
    if (method === 'POST' && !evId) {
      const ev = { kind: 'calendar#event', ...structuredClone(call.body), id: `fev${seq++}`, status: 'confirmed', updated: new Date(now()).toISOString() };
      list.push(ev);
      return json(200, structuredClone(ev));
    }
    const idx = list.findIndex((e) => e.id === evId);
    if (method === 'PATCH') {
      if (idx < 0) return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
      Object.assign(list[idx], structuredClone(call.body), { updated: new Date(now()).toISOString() });
      return json(200, structuredClone(list[idx]));
    }
    if (method === 'DELETE') {
      if (deleteStatus) return json(deleteStatus, { error: { code: deleteStatus, errors: [{ reason: 'deleted' }] } });
      if (idx < 0) return json(410, { error: { code: 410, errors: [{ reason: 'deleted' }] } });
      list.splice(idx, 1);
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  };
  const writes = () => calls.filter((c) => c.calendarId && c.method !== 'GET');
  return { fetch, calls, writes };
}

/* ----------------------------------------------------------------- push */
export function senderStub({ gone = [] } = {}) {
  const sent = [];
  const sender = async (sub, payload, opts) => {
    if (gone.includes(sub.endpoint)) { const e = new Error('Received unexpected response code'); e.statusCode = 410; throw e; }
    sent.push({ endpoint: sub.endpoint, keys: sub.keys, payload: JSON.parse(payload), opts });
    return { statusCode: 201 };
  };
  return { sender, sent };
}
export const SUBS = ['https://fcm.googleapis.com/fcm/send/device-one', 'https://web.push.apple.com/device-two'];
export function addPushSubs(app, endpoints = SUBS) {
  for (const endpoint of endpoints) {
    app.create('pushSubs', { id: hashId(endpoint), endpoint, keys: { p256dh: 'BPubKey' + pad2(endpoints.indexOf(endpoint)), auth: 'authsecret' }, device: 'test', createdAt: '2026-09-01T00:00:00Z', active: true });
  }
}

/* -------------------------------------------------- analytics / AI stubs */
function simpleDue(item, date) {
  const s = item.schedule || {};
  if (s.type === 'asneeded') return false;
  if (s.type === 'days' || s.type === 'weekly') return (s.days || []).includes(dayOfWeek(date));
  return true;
}

export function stubDeps({ readiness, nutritionFails = false } = {}) {
  const calls = { readiness: [], dueItems: [], nutritionReview: [], weeklyReview: [] };
  const deps = {
    readiness: {
      readiness: (dv, date) => {
        calls.readiness.push(date);
        return readiness || { date, status: 'ok', band: 'green', score: 72, summary: 'Recovery is solid. Train as planned and protect the 09:00 focus block.' };
      },
    },
    protocols: {
      dueItems: (dv, date) => {
        calls.dueItems.push(date);
        return dv.protocolItems().map((item) => ({ item, due: simpleDue(item, date), doses: dv.doses(date).filter((d) => d.itemId === item.id) }));
      },
    },
    nutrition: { dayNutrition: (dv, date) => ({ date, totals: { kcal: 2400, protein: 170 }, targets: { kcal: 2800, proteinG: 180 } }) },
    body: { bodySummary: () => ({ weight: 180.2, trend: 179.8, change7: 0.3, change28: 1.1, rate28: 0.28, series: [{ date: '2026-09-01', trendLb: 178 }] }) },
    weekly: { weekStats: (dv, ws) => ({ week: isoWeek(ws), from: ws, to: addDays(ws, 6), daysLogged: 7, highlights: ['Seven training days'] }) },
    correlations: { findDrivers: () => [{ behavior: 'sleepMin', outcome: 'nextHrv', sentence: 'More sleep is associated with higher next-day HRV.', strength: 'moderate', n: 40, q: 0.04 }] },
    daily: { buildDaily: () => [] },
    aiReviews: {
      nutritionReview: async (ai, input) => {
        calls.nutritionReview.push({ ai, input });
        if (nutritionFails) throw Object.assign(new Error('The Claude API rejected the request.'), { name: 'AIError', code: 'bad-request' });
        return { score: 81, headline: 'Solid day', wins: ['Protein at every meal'], gaps: ['Fiber'], tomorrow: ['Add vegetables at lunch'], flags: [], model: 'claude-sonnet-5', costUsd: 0.0123 };
      },
      weeklyReview: async (ai, input) => {
        calls.weeklyReview.push({ ai, input });
        return { headline: 'Consistent week', summary: 'Training and sleep were steady.', whatWorked: ['Sleep'], whatDidnt: ['Late dinners'], focus: { title: 'Earlier dinner', why: 'Sleep quality', how: ['Eat by 19:30'] }, model: 'claude-sonnet-5', costUsd: 0.0456 };
      },
    },
  };
  return { deps, calls };
}
