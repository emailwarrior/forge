// Integration plumbing used by setup + settings screens: GitHub secrets (sealed box),
// automation install/update, workflow dispatch, WHOOP OAuth, Google service account, Web Push.
import { sealedBox } from '../vendor/sealedbox.js';
import { b64ToBytes, bytesToB64, b64url, hashId, nowIso, sleep, uid } from '../core/util.js';

export const WORKFLOW_FILE = 'forge-sync.yml';
export const WORKFLOW_PATH = '.github/workflows/forge-sync.yml';
export const BUNDLE_PATH = 'automation/forge-automation.mjs';
export const WHOOP_SCOPES = 'offline read:recovery read:cycles read:sleep read:workout read:body_measurement';
const enc = new TextEncoder();

/** App base URL (e.g. https://owner.github.io/forge/). */
export function appBase() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }
export function oauthRedirectUri() { return appBase() + 'callback.html'; }

/** Pre-filled fine-grained token URL (repository selection must still be chosen by hand). */
export function tokenUrl(owner, device = 'device') {
  const p = new URLSearchParams({
    name: ('FORGE vault · ' + device).slice(0, 40),
    description: 'FORGE app access to the private forge-vault repository only.',
    target_name: owner || '', expires_in: '366',
    contents: 'write', actions: 'write', secrets: 'write', workflows: 'write', metadata: 'read',
  });
  return 'https://github.com/settings/personal-access-tokens/new?' + p.toString();
}

/* ------------------------------------------------------------- secrets */
export async function setSecret(gh, name, value) {
  const { key, key_id: keyId } = await gh.getSecretsKey();
  const sealed = sealedBox(enc.encode(String(value)), b64ToBytes(key));
  await gh.putSecret(name, bytesToB64(sealed), keyId);
}
export async function listSecrets(gh) { try { return await gh.listSecrets(); } catch { return null; } }

/* ---------------------------------------------------------- automation */
export async function latestAutomation() {
  const res = await fetch('./dist/automation-version.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Automation bundle info unavailable');
  return res.json();
}
async function upsertFile(gh, path, bytes, message) {
  const cur = await gh.getFile(path);
  return gh.putFile(path, bytes, message, cur && cur.sha);
}
/** Install or update the workflow + bundle in the vault. Needs token Contents + Workflows write. */
export async function installAutomation(session, onStep = () => {}) {
  const { gh, store } = session;
  onStep('Downloading automation bundle');
  const [ver, bundle, workflow] = await Promise.all([
    latestAutomation(),
    fetch('./dist/forge-automation.mjs', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('Bundle download failed'); return r.arrayBuffer(); }),
    fetch('./automation/forge-sync.yml', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('Workflow download failed'); return r.text(); }),
  ]);
  onStep('Verifying automation bundle');
  const bytes = new Uint8Array(bundle);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!ver.sha256 || digest !== ver.sha256) throw new Error('The downloaded automation bundle does not match its published checksum. Reload the app and try again.');
  if (!workflow.includes('__BUNDLE_SHA256__')) throw new Error('Unexpected workflow file (missing the checksum pin).');
  onStep('Installing automation bundle');
  await upsertFile(gh, BUNDLE_PATH, bytes, `Install FORGE automation ${ver.version}`);
  onStep('Installing workflow');
  try {
    // The workflow refuses to run a bundle whose SHA-256 differs from the one pinned here.
    await upsertFile(gh, WORKFLOW_PATH, enc.encode(workflow.split('__BUNDLE_SHA256__').join(digest)), 'Install FORGE workflow');
  } catch (e) {
    if (e.status === 403 || e.status === 404) throw new Error('The token lacks "Workflows: Read and write" permission, so the workflow file could not be installed.');
    throw e;
  }
  store.updateSetting('integrations', { automation: { version: ver.version, sha256: ver.sha256, installedAt: nowIso() } });
  return ver;
}
export async function automationState(session) {
  const installed = session.store.setting('integrations').automation || null;
  let latest = null; try { latest = await latestAutomation(); } catch { /* offline */ }
  return { installed, latest, upToDate: !!(installed && latest && installed.sha256 === latest.sha256) };
}

/**
 * Dispatch a workflow run. Flushes local changes first so the run sees them.
 * GitHub registers a newly committed workflow file asynchronously, so right after installing it a
 * dispatch can answer 404 for a few seconds: pass `waitForWorkflowMs` to keep retrying for that long.
 */
export async function dispatch(session, task = 'auto', payload = '', { waitForWorkflowMs = 0, retryDelayMs = 2500 } = {}) {
  if (session.sync) await session.sync.flush();
  const t0 = Date.now();
  for (;;) {
    try {
      await session.gh.dispatch(WORKFLOW_FILE, { task, payload });
      break;
    } catch (e) {
      if (e.status === 404 && Date.now() - t0 + retryDelayMs <= waitForWorkflowMs) { await sleep(retryDelayMs); continue; }
      if (e.status === 404) throw new Error('Workflow not installed yet (Settings → Automation → Install).');
      if (e.status === 403) throw new Error('The token lacks "Actions: Read and write" permission.');
      throw e;
    }
  }
  return Date.now();
}
/** How long to retry a dispatch right after installing the workflow (GitHub registers it asynchronously). */
export const NEW_WORKFLOW_WAIT_MS = 45000;
/**
 * Poll until status/<id>.lastRunAt is newer than `since` (ms). Every few polls the workflow runs are
 * checked too, so a run that already failed on GitHub (e.g. missing FORGE_DATA_KEY) ends the wait
 * with an error instead of a spinner until the timeout.
 */
export async function waitForStatus(session, id, since, { timeoutMs = 600000, onTick, pollMs = 8000, runCheckEvery = 3 } = {}) { // runs queue + WHOOP backfill can take minutes
  const t0 = Date.now(); let polls = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(pollMs);
    await session.sync.pull();
    const st = session.store.get('status', id);
    if (onTick) onTick(Math.round((Date.now() - t0) / 1000));
    if (st && st.lastRunAt && Date.parse(st.lastRunAt) >= since - 5000) return st;
    if (++polls % runCheckEvery === 0) {
      const run = await failedRunSince(session, since);
      if (run) throw new Error(`The run failed on GitHub (${run.conclusion}). Open the vault's Actions tab to see the log; a missing or wrong FORGE_DATA_KEY secret is the usual cause (Settings → Security → Server data key).`);
    }
  }
  throw new Error('No response from automation yet — check the Actions tab in the vault repository.');
}
/** The newest workflow_dispatch run started since `since` (2 min margin for clock skew), if it completed without success. */
async function failedRunSince(session, since) {
  let runs; try { runs = await session.gh.listRuns(WORKFLOW_FILE, 5); } catch { return null; }
  const latest = (runs || []).find((r) => r && r.event === 'workflow_dispatch' && Date.parse(r.created_at) >= since - 120000);
  return latest && latest.status === 'completed' && latest.conclusion && latest.conclusion !== 'success' ? latest : null;
}
export async function recentRuns(session) { try { return await session.gh.listRuns(WORKFLOW_FILE, 5); } catch { return []; } }

/* --------------------------------------------------------------- WHOOP */
export async function saveWhoopCredentials(session, clientId, clientSecret) {
  await setSecret(session.gh, 'WHOOP_CLIENT_ID', clientId.trim());
  await setSecret(session.gh, 'WHOOP_CLIENT_SECRET', clientSecret.trim());
  session.store.updateSetting('integrations', { whoop: { clientId: clientId.trim() } });
}
export function startWhoopAuth(session) {
  const clientId = session.store.setting('integrations').whoop.clientId;
  if (!clientId) throw new Error('Save the WHOOP client ID first.');
  const state = uid(24);
  localStorage.setItem('forge_oauth', JSON.stringify({ provider: 'whoop', state, at: Date.now() }));
  const p = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: oauthRedirectUri(), scope: WHOOP_SCOPES, state });
  location.assign('https://api.prod.whoop.com/oauth/oauth2/auth?' + p.toString());
}
/** Reads the callback result stored by callback.html; returns null if none. */
export function takeOAuthResult() {
  const raw = localStorage.getItem('forge_oauth_result'); if (!raw) return null;
  localStorage.removeItem('forge_oauth_result');
  const pend = JSON.parse(localStorage.getItem('forge_oauth') || 'null'); localStorage.removeItem('forge_oauth');
  const res = JSON.parse(raw);
  if (!pend || res.state !== pend.state) return { error: 'State mismatch — start the connection again.' };
  if (Date.now() - pend.at > 15 * 60000) return { error: 'The authorization expired — start again.' };
  return { ...res, provider: pend.provider };
}
export async function completeWhoopAuth(session, result) {
  if (result.error) throw new Error(result.error);
  const payload = await session.encryptPayload({ code: result.code, redirectUri: oauthRedirectUri(), state: result.state, at: nowIso() }, 'payload/whoop-auth');
  const since = await dispatch(session, 'whoop-auth', payload);
  session.store.updateSetting('integrations', { whoop: { connectedAt: nowIso() } });
  return since;
}

/* -------------------------------------------------------------- Google */
export async function saveGoogleServiceAccount(session, jsonText) {
  let sa; try { sa = JSON.parse(jsonText); } catch { throw new Error('That is not valid JSON — paste the whole key file.'); }
  if (!sa.client_email || !sa.private_key || sa.type !== 'service_account') throw new Error('This JSON is not a service-account key (needs type, client_email, private_key).');
  await setSecret(session.gh, 'GOOGLE_SA_KEY', JSON.stringify(sa));
  session.store.updateSetting('integrations', { gcal: { saEmail: sa.client_email } });
  return sa.client_email;
}

/* ---------------------------------------------------------------- Push */
export function pushSupported() { return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
export function isStandalone() { return (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
export async function ensureVapid(session) {
  const cur = session.store.setting('integrations').push;
  if (cur.vapidPublicKey) return cur.vapidPublicKey;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  await setSecret(session.gh, 'VAPID_PRIVATE_KEY', jwk.d);
  const vapidPublicKey = b64url(pub);
  session.store.updateSetting('integrations', { push: { vapidPublicKey, subject: appBase() } });
  return vapidPublicKey;
}
/** Must be called from a user gesture. */
export async function subscribePush(session) {
  if (!pushSupported()) throw new Error('This browser does not support push notifications. On iPhone, add FORGE to the Home Screen first.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed.');
  const vapid = await ensureVapid(session);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(vapid) });
  const json = sub.toJSON();
  const id = hashId(json.endpoint);
  session.store.upsert('pushSubs', id, { endpoint: json.endpoint, keys: json.keys, device: deviceLabel(), createdAt: nowIso(), active: true });
  return id;
}
export async function unsubscribePush(session) {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
  if (sub) { session.store.upsert('pushSubs', hashId(sub.endpoint), { active: false }); await sub.unsubscribe(); }
}
function urlB64ToBytes(s) { let t = s.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return b64ToBytes(t); }
export function deviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone'; if (/iPad/.test(ua)) return 'iPad'; if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows PC'; if (/Mac OS X/.test(ua)) return 'Mac'; return 'Browser';
}
