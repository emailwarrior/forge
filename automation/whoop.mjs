// WHOOP API v2 → FORGE server collections (docs/ARCHITECTURE.md §5).
//
// Token safety: WHOOP refresh tokens rotate and the previous one dies on use. A refresh
// happens only when the access token expires within 10 minutes (or once after a 401),
// and the new tokens are committed and pushed to the vault before any data request.
//
// Sync window: the last successful sync − 7 days. The first run after connecting
// backfills everything since 2015-01-01 newest-first in ~6-month chunks under a time
// budget; unfinished backfill resumes on the next run (detail.backfillBefore).
import {
  localFromOffset, localParts, parseOffset, offsetStr, pad2, round, isNum, kjToKcal, kgToLb, b64ToBytes,
} from '../js/core/util.js';
import { decryptBytes } from '../js/core/crypto.js';
import { putRecord } from './vault-fs.mjs';
import { shortError, backoffMs, retryAfterMs, oauthCode, registerSecret, iso } from './log.mjs';

export const WHOOP_API = 'https://api.prod.whoop.com/developer';
export const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
export const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const WHOOP_SCOPES = 'offline read:recovery read:cycles read:sleep read:workout read:body_measurement';
export const BACKFILL_START = '2015-01-01T00:00:00.000Z';
export const PAYLOAD_PATH = 'payload/whoop-auth';
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;
export const OVERLAP_MS = 7 * 86400000;
export const CHUNK_MS = 182 * 86400000;
export const PAGE_LIMIT = 25;
export const MIN_INTERVAL_MS = 650;   // ≤ ~92 requests/minute (WHOOP allows 100)
const MAX_PAGES = 500;
const H12 = 12 * 3600000;
const ZONES = ['zone_zero_milli', 'zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli'];

/* ------------------------------------------------------------ mapping */
const num = (v) => (isNum(v) ? v : null);
const mins = (ms) => (isNum(ms) ? round(ms / 60000, 1) : null);
const str = (v) => (v == null ? null : String(v));

// ISO instant re-expressed as local wall time with the record's own offset (seconds precision).
export function localIso(value, offset) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const off = parseOffset(offset);
  const d = new Date(ms + off * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${offsetStr(off)}`;
}
const localAt = (value, offset, addMs = 0) => localFromOffset(new Date(Date.parse(value) + addMs).toISOString(), offset);

// Field time for a source record: newer WHOOP edits win merges; identical data is a no-op.
export function sourceTime(rec) {
  const t = Date.parse(rec && (rec.updated_at || rec.created_at));
  return Number.isFinite(t) ? t : null;
}

export function mapCycle(c) {
  const s = c.score || {};
  const kj = num(s.kilojoule);
  return {
    date: localAt(c.start, c.timezone_offset, H12).ymd,
    start: localIso(c.start, c.timezone_offset),
    end: c.end ? localIso(c.end, c.timezone_offset) : null,
    tz: c.timezone_offset ?? null,
    scoreState: c.score_state ?? null,
    strain: round(s.strain, 1),
    kj: round(kj, 0),
    kcal: round(kjToKcal(kj), 0),
    avgHr: round(s.average_heart_rate, 0),
    maxHr: round(s.max_heart_rate, 0),
    steps: num(c.step_count ?? s.step_count),
  };
}

export function mapSleep(s) {
  const sc = s.score || {};
  const st = sc.stage_summary || {};
  const need = sc.sleep_needed || {};
  const light = st.total_light_sleep_time_milli, sws = st.total_slow_wave_sleep_time_milli, rem = st.total_rem_sleep_time_milli;
  const asleep = [light, sws, rem].some(isNum) ? (num(light) || 0) + (num(sws) || 0) + (num(rem) || 0) : null;
  const parts = [need.baseline_milli, need.need_from_sleep_debt_milli, need.need_from_recent_strain_milli, need.need_from_recent_nap_milli];
  const needMs = parts.some(isNum) ? parts.reduce((a, v) => a + (num(v) || 0), 0) : null;
  const tz = s.timezone_offset ?? null;
  const endLocal = localAt(s.end || s.start, tz);
  return {
    date: endLocal.ymd,
    cycleId: str(s.cycle_id),
    start: localIso(s.start, tz),
    end: s.end ? localIso(s.end, tz) : null,
    tz,
    nap: !!s.nap,
    scoreState: s.score_state ?? null,
    inBedMin: mins(st.total_in_bed_time_milli),
    awakeMin: mins(st.total_awake_time_milli),
    lightMin: mins(light),
    deepMin: mins(sws),
    remMin: mins(rem),
    asleepMin: mins(asleep),
    cycles: num(st.sleep_cycle_count),
    disturbances: num(st.disturbance_count),
    needMin: mins(needMs),
    needBaselineMin: mins(need.baseline_milli),
    needDebtMin: mins(need.need_from_sleep_debt_milli),
    needStrainMin: mins(need.need_from_recent_strain_milli),
    needNapMin: mins(need.need_from_recent_nap_milli),
    respRate: round(sc.respiratory_rate, 1),
    performance: round(sc.sleep_performance_percentage, 0),
    consistency: round(sc.sleep_consistency_percentage, 0),
    efficiency: round(sc.sleep_efficiency_percentage, 1),
    bedtime: localAt(s.start, tz).hm,
    wake: s.end ? endLocal.hm : null,
  };
}

export function mapRecovery(r, date) {
  const sc = r.score || {};
  return {
    date,
    cycleId: str(r.cycle_id),
    sleepId: str(r.sleep_id),
    scoreState: r.score_state ?? null,
    calibrating: typeof sc.user_calibrating === 'boolean' ? sc.user_calibrating : null,
    recovery: round(sc.recovery_score, 0),
    rhr: round(sc.resting_heart_rate, 0),
    hrv: round(sc.hrv_rmssd_milli, 1),
    spo2: round(sc.spo2_percentage, 1),
    skinTempC: round(sc.skin_temp_celsius, 2),
  };
}

export function mapWorkout(w) {
  const sc = w.score || {};
  const z = sc.zone_durations || sc.zone_duration || null;
  const kj = num(sc.kilojoule);
  const tz = w.timezone_offset ?? null;
  return {
    date: localAt(w.start, tz).ymd,
    start: localIso(w.start, tz),
    end: w.end ? localIso(w.end, tz) : null,
    tz,
    sport: w.sport_name ?? null,
    sportId: num(w.sport_id),
    scoreState: w.score_state ?? null,
    strain: round(sc.strain, 1),
    avgHr: round(sc.average_heart_rate, 0),
    maxHr: round(sc.max_heart_rate, 0),
    kj: round(kj, 0),
    kcal: round(kjToKcal(kj), 0),
    percentRecorded: round(sc.percent_recorded, 1),
    distanceM: round(sc.distance_meter, 1),
    altGainM: round(sc.altitude_gain_meter, 1),
    zonesMin: z ? ZONES.map((k) => mins(z[k])) : null,
  };
}

export function mapBody(b) {
  return {
    heightIn: isNum(b.height_meter) ? round(b.height_meter / 0.0254, 1) : null,
    weightLb: round(kgToLb(b.weight_kilogram), 1),
    maxHr: num(b.max_heart_rate),
  };
}

// Recovery date = the local date of its sleep (the morning woken up); fallback: cycle
// start + 12 h local; last resort: creation time in the profile time zone.
function recoveryDate(ctx, r) {
  if (r.sleep_id != null) {
    const s = ctx.store.get('whoopSleep', String(r.sleep_id));
    if (s && s.date) return s.date;
  }
  const c = ctx.store.get('whoopCycles', String(r.cycle_id));
  if (c && c.start) return localAt(c.start, c.tz, H12).ymd;
  const t = r.created_at || r.updated_at;
  return t ? localParts(t, ctx.tz).ymd : null;
}

// A sleep's end (and so its date) can change after the recovery was stored.
function repairRecoveryDates(ctx) {
  let n = 0;
  for (const r of ctx.store.all('whoopRecovery')) {
    if (!r.sleepId) continue;
    const s = ctx.store.get('whoopSleep', r.sleepId);
    if (s && s.date && s.date !== r.date && putRecord(ctx, 'whoopRecovery', r.id, { date: s.date })) n++;
  }
  return n;
}

/* ------------------------------------------------------------- tokens */
export function hasWhoopTokens(store) {
  const t = store.get('secrets', 'whoop');
  return !!(t && t.accessToken && t.refreshToken);
}

function clientCreds(ctx) {
  const clientId = String(ctx.env.WHOOP_CLIENT_ID || '').trim();
  const clientSecret = String(ctx.env.WHOOP_CLIENT_SECRET || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const reauthError = () => Object.assign(new Error('reauth-needed'), { reauth: true });

async function tokenRequest(ctx, params, what) {
  const body = new URLSearchParams(params).toString();
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await ctx.fetch(WHOOP_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      });
    } catch {
      if (attempt < 3) { await ctx.sleep(backoffMs(attempt)); continue; }
      throw new Error(`WHOOP ${what}: network error`);
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await ctx.sleep(res.status === 429 ? Math.min(retryAfterMs(res.headers.get('retry-after')), 30000) : backoffMs(attempt));
      continue;
    }
    if (!res.ok || !data || typeof data.access_token !== 'string') {
      const code = oauthCode(data);
      const err = new Error(`WHOOP ${what} failed (HTTP ${res.status}${code ? ' ' + code : ''})`);
      err.reauth = res.status === 400 || res.status === 401 || code === 'invalid_grant';
      throw err;
    }
    registerSecret(data.access_token);
    registerSecret(data.refresh_token);
    return data;
  }
}

function tokenRecord(data, nowMs, prev = {}) {
  const ttl = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || prev.refreshToken || null,
    expiresAt: iso(nowMs + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000),
    scope: data.scope || prev.scope || null,
    obtainedAt: iso(nowMs),
    invalidAt: null,
  };
}

const saveTokens = (ctx, tokens) => putRecord(ctx, 'secrets', 'whoop', tokens);
const markInvalid = (ctx) => putRecord(ctx, 'secrets', 'whoop', { invalidAt: iso(ctx.now()) });

function createSession(ctx, tokens, creds) {
  const session = {
    tokens: { ...tokens },
    rotations: 0,
    refreshedOn401: false,
    // Rotate, then commit + push the new tokens BEFORE anything else talks to WHOOP.
    async refresh(reason) {
      let data;
      try {
        data = await tokenRequest(ctx, {
          grant_type: 'refresh_token', refresh_token: session.tokens.refreshToken,
          client_id: creds.clientId, client_secret: creds.clientSecret, scope: 'offline',
        }, 'token refresh');
      } catch (e) {
        if (e.reauth) { markInvalid(ctx); throw reauthError(); }
        throw e;
      }
      session.tokens = tokenRecord(data, ctx.now(), session.tokens);
      session.rotations++;
      saveTokens(ctx, session.tokens);
      ctx.log.info(`whoop: tokens rotated (${reason}); persisting before fetching data`);
      await ctx.checkpoint('forge: whoop token rotation');
    },
  };
  return session;
}

/* ---------------------------------------------------------------- API */
function createApi(ctx, session, deadline) {
  let lastAt = 0;
  let requests = 0;
  async function get(path, query) {
    const url = WHOOP_API + path + (query ? '?' + new URLSearchParams(query).toString() : '');
    let attempt = 0; let limited = 0;
    for (;;) {
      if (Date.now() > deadline) throw Object.assign(new Error('WHOOP time budget reached'), { deadline: true });
      const wait = lastAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await ctx.sleep(wait);
      lastAt = Date.now();
      requests++;
      let res;
      try {
        res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${session.tokens.accessToken}`, Accept: 'application/json' } });
      } catch {
        if (++attempt <= 4) { await ctx.sleep(backoffMs(attempt)); continue; }
        throw new Error(`WHOOP ${path}: network error`);
      }
      if (res.status === 401) {
        if (!session.refreshedOn401) { session.refreshedOn401 = true; await session.refresh('401'); continue; }
        markInvalid(ctx);
        throw reauthError();
      }
      if (res.status === 429) {
        const ms = retryAfterMs(res.headers.get('retry-after'), 60000);
        if (++limited <= 5 && Date.now() + ms < deadline) {
          ctx.log.warn(`whoop: rate limited, waiting ${Math.ceil(ms / 1000)}s`);
          await ctx.sleep(ms);
          continue;
        }
        throw Object.assign(new Error('WHOOP rate limit reached — continuing next run'), { rateLimited: true });
      }
      if (res.status >= 500) {
        if (++attempt <= 4) { await ctx.sleep(backoffMs(attempt)); continue; }
        throw new Error(`WHOOP ${path}: HTTP ${res.status}`);
      }
      if (res.status === 404 && path.startsWith('/v2/user/')) return null;
      if (!res.ok) throw new Error(`WHOOP ${path}: HTTP ${res.status}`);
      try { return await res.json(); } catch { throw new Error(`WHOOP ${path}: invalid JSON`); }
    }
  }
  // Collections come newest-first, ≤ 25 per page, cursor in next_token. A window is either
  // fully listed or an error (a partial list must not advance the sync cursor).
  async function list(path, { start, end }) {
    const out = []; const seen = new Set(); let token = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = { limit: String(PAGE_LIMIT) };
      if (start) q.start = start;
      if (end) q.end = end;
      if (token) q.nextToken = token;
      const data = await get(path, q);
      if (data && Array.isArray(data.records)) out.push(...data.records);
      token = (data && (data.next_token || data.nextToken)) || null;
      if (!token) return out;
      if (seen.has(token)) break;
      seen.add(token);
    }
    throw new Error(`WHOOP ${path}: pagination did not terminate`);
  }
  return { get, list, get requests() { return requests; } };
}

const KINDS = [
  ['cycles', '/v2/cycle'], ['sleep', '/v2/activity/sleep'], ['workouts', '/v2/activity/workout'], ['recovery', '/v2/recovery'],
];

// Fetch one time window of every collection. Cycles and sleeps land in the store first
// so recoveries can take their date from them.
async function fetchWindow(ctx, api, win, tally) {
  for (const [kind, path] of KINDS) {
    const records = await api.list(path, win);
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      let coll, id, fields;
      if (kind === 'cycles') {
        if (r.id == null || !r.start) continue;
        coll = 'whoopCycles'; id = String(r.id); fields = mapCycle(r);
      } else if (kind === 'sleep') {
        if (r.id == null || !r.start) continue;
        coll = 'whoopSleep'; id = String(r.id); fields = mapSleep(r);
      } else if (kind === 'workouts') {
        if (r.id == null || !r.start) continue;
        coll = 'whoopWorkouts'; id = String(r.id); fields = mapWorkout(r);
      } else {
        if (r.cycle_id == null) continue;
        const date = recoveryDate(ctx, r);
        if (!date) continue;
        coll = 'whoopRecovery'; id = String(r.cycle_id); fields = mapRecovery(r, date);
      }
      tally.fetched[kind]++;
      if (putRecord(ctx, coll, id, fields, sourceTime(r))) tally.changed[kind]++;
    }
  }
}

/* --------------------------------------------------------------- sync */
async function sync(ctx, session, { mode, prev }) {
  const deadline = ctx.whoopDeadline ?? ctx.deadline;
  const runStart = ctx.now();
  const tally = { fetched: { cycles: 0, recovery: 0, sleep: 0, workouts: 0 }, changed: { cycles: 0, recovery: 0, sleep: 0, workouts: 0 } };
  const detail = { ...prev };
  delete detail.state;
  const full = mode !== 'incremental' || !prev.syncedAt;
  let backfillBefore = full ? iso(runStart) : (prev.backfillBefore || null);
  detail.backfillBefore = backfillBefore;   // a requested backfill stays pending until it completes
  const api = createApi(ctx, session, deadline);
  let outcome = { ok: true };
  try {
    if (!(Date.parse(session.tokens.expiresAt) - ctx.now() > REFRESH_MARGIN_MS)) await session.refresh('expiring');
    if (!full) {
      const start = iso(Date.parse(prev.syncedAt) - OVERLAP_MS);
      await fetchWindow(ctx, api, { start, end: null }, tally);
      detail.syncedAt = iso(runStart);
    }
    let chunks = 0;
    const floor = Date.parse(BACKFILL_START);
    while (backfillBefore) {
      const endMs = Date.parse(backfillBefore);
      const startMs = Math.max(floor, endMs - CHUNK_MS);
      await fetchWindow(ctx, api, { start: iso(startMs), end: iso(endMs) }, tally);
      backfillBefore = startMs <= floor ? null : iso(startMs);
      detail.backfillBefore = backfillBefore;
      if (full && chunks === 0) detail.syncedAt = iso(runStart);   // newest data is in: go incremental next time
      chunks++;
    }
    detail.backfillBefore = null;
    detail.bodyError = null;
    try {
      const body = await api.get('/v2/user/measurement/body');
      if (body && typeof body === 'object') putRecord(ctx, 'whoopBody', 'body', mapBody(body));
    } catch (e) {
      if (e.reauth || e.deadline || e.rateLimited) throw e;
      detail.bodyError = shortError(e);   // optional endpoint: never fails the sync
    }
  } catch (e) {
    if (e.deadline && backfillBefore && detail.syncedAt) outcome = { ok: true, partial: true };
    else if (e.reauth) outcome = { ok: false, error: 'reauth-needed', state: 'reauth-needed' };
    else if (e.rateLimited) outcome = { ok: false, error: shortError(e), state: 'rate-limited' };
    else outcome = { ok: false, error: shortError(e), state: 'error' };
  }
  const repaired = repairRecoveryDates(ctx);
  detail.state = outcome.state || (outcome.partial || detail.backfillBefore ? 'backfilling' : 'ok');
  detail.backfill = detail.backfillBefore ? 'in-progress' : 'complete';
  detail.lastRun = { at: iso(runStart), mode, fetched: tally.fetched, changed: tally.changed, requests: api.requests, rotations: session.rotations, repaired };
  const f = tally.fetched; const c = tally.changed;
  const summary = `fetched c/r/s/w=${f.cycles}/${f.recovery}/${f.sleep}/${f.workouts} changed=${c.cycles + c.recovery + c.sleep + c.workouts} requests=${api.requests}${detail.backfillBefore ? ' (backfill continues next run)' : ''}`;
  return { ok: outcome.ok, error: outcome.error || null, detail, summary };
}

export async function runWhoop(ctx, { mode = 'incremental', explicit = false } = {}) {
  const prev = (ctx.store.get('status', 'whoop') || {}).detail || {};
  const tokens = ctx.store.get('secrets', 'whoop');
  if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
    return explicit ? { ok: false, error: 'not-connected', detail: { ...prev, state: 'not-connected' } } : { quiet: true, skipped: true };
  }
  if (tokens.invalidAt) return { ok: false, error: 'reauth-needed', detail: { ...prev, state: 'reauth-needed' } };
  const creds = clientCreds(ctx);
  if (!creds) return { ok: false, error: 'WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET secrets are not set', detail: prev };
  return sync(ctx, createSession(ctx, tokens, creds), { mode, prev });
}

// whoop-auth: decrypt the app's payload, exchange the code, persist tokens immediately, backfill.
export async function runWhoopAuth(ctx) {
  const prev = (ctx.store.get('status', 'whoop') || {}).detail || {};
  const creds = clientCreds(ctx);
  if (!creds) return { ok: false, error: 'WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET secrets are not set', detail: prev };
  let payload;
  try { payload = await readAuthPayload(ctx); } catch (e) {
    return { ok: false, error: `auth payload rejected: ${shortError(e)}`, detail: { ...prev, state: 'auth-failed' } };
  }
  let data;
  try {
    data = await tokenRequest(ctx, {
      grant_type: 'authorization_code', code: payload.code, redirect_uri: payload.redirectUri,
      client_id: creds.clientId, client_secret: creds.clientSecret,
    }, 'code exchange');
  } catch (e) {
    return { ok: false, error: shortError(e), detail: { ...prev, state: 'auth-failed' } };
  }
  const tokens = tokenRecord(data, ctx.now());
  saveTokens(ctx, tokens);
  ctx.log.info('whoop: connected; persisting tokens before backfill');
  await ctx.checkpoint('forge: whoop connected');
  const next = { ...prev, connectedAt: iso(ctx.now()), authRequestedAt: typeof payload.at === 'string' || isNum(payload.at) ? payload.at : null };
  delete next.syncedAt; delete next.backfillBefore;
  return sync(ctx, createSession(ctx, tokens, creds), { mode: 'auth', prev: next });
}

export async function readAuthPayload(ctx) {
  const text = String(ctx.env.FORGE_PAYLOAD || '').trim();
  if (!text) throw new Error('FORGE_PAYLOAD is empty');
  const bytes = await decryptBytes(ctx.key, b64ToBytes(text), PAYLOAD_PATH);
  let p;
  try { p = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('payload is not JSON'); }
  if (!p || typeof p.code !== 'string' || !p.code || typeof p.redirectUri !== 'string' || !p.redirectUri) {
    throw new Error('payload is missing code/redirectUri');
  }
  registerSecret(p.code);
  return p;
}
