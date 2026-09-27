// Settings: pure status and summary logic (index lines, integration states, AI spend, setup checklist).
// Inputs are plain values (settings records, status records, counts); no DOM, no store writes.
import { fmtNum, fmtTime, fmtDate, isNum } from '../../core/util.js';

/* ------------------------------------------------------------------ time */
const toMs = (at) => (at == null || at === '' ? null : typeof at === 'number' ? at : Date.parse(at));

/** 'just now', '12 min ago', '3 h ago', 'yesterday', '4 days ago', 'Sep 12' (future: 'in 5 min'). */
export function relTime(at, now = Date.now()) {
  const ms = toMs(at); if (ms == null || !Number.isFinite(ms)) return 'never';
  const d = now - ms; const a = Math.abs(d);
  const fut = d < 0;
  if (a < 60000) return fut ? 'in under a minute' : 'just now';
  const min = Math.round(a / 60000);
  if (min < 60) return fut ? `in ${min} min` : `${min} min ago`;
  const h = Math.round(a / 3600000);
  if (h < 24) return fut ? `in ${h} h` : `${h} h ago`;
  const days = Math.floor(a / 86400000);
  if (!fut && days < 2) return 'yesterday';
  if (days < 7) return fut ? `in ${days} days` : `${days} days ago`;
  const dt = new Date(ms); const nowY = new Date(now).getFullYear();
  const ymd = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  return fmtDate(ymd, { dow: false, year: dt.getFullYear() !== nowY });
}

/* ---------------------------------------------------------------- models */
export const MODELS = [
  { value: 'claude-sonnet-5', label: 'Sonnet 5', option: 'Sonnet 5 (default)', note: 'Balanced quality and speed; the default.' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', option: 'Opus 5.5', note: 'Most capable; about 2× the Sonnet price per token.' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', option: 'Haiku 4.5', note: 'Fastest; about half the Sonnet price per token.' },
];
export function modelLabel(id) {
  const m = MODELS.find((x) => x.value === id);
  return m ? m.label : id || '—';
}

/** Typical costs (docs/AI_API.md). Estimates, not measurements. */
export const COST_ROWS = [
  { what: 'Meal photo analysis', model: 'Main model', latency: '10–40 s (+5–15 s per web search)', cost: '$0.02–0.06, + $0.02–0.05 per search' },
  { what: 'Meal from text', model: 'Main model', latency: '5–20 s', cost: '$0.01–0.04' },
  { what: 'Lab report extraction', model: 'Main model', latency: '15–60 s', cost: '$0.03–0.15' },
  { what: 'Lab interpretation, nutrition and weekly reviews, Ask', model: 'Main model', latency: '10–40 s', cost: '$0.01–0.06' },
  { what: 'Morning brief', model: 'Fast model', latency: '2–5 s', cost: '< $0.002' },
];

/**
 * AI spend recorded on records between two local dates (inclusive):
 * meals.ai.costUsd, reviews.costUsd, labs.ai.costUsd. → { usd, meals, reviews, labs, n }
 */
export function aiSpend({ meals = [], reviews = [], labs = [] }, from, to) {
  const inRange = (d) => typeof d === 'string' && d >= from && d <= to;
  let usd = 0; const out = { meals: 0, reviews: 0, labs: 0 };
  for (const m of meals) { const c = m && m.ai && m.ai.costUsd; if (inRange(m.date) && isNum(c) && c > 0) { usd += c; out.meals++; } }
  for (const r of reviews) { const c = r && r.costUsd; if (inRange(r.date || (r.createdAt || '').slice(0, 10)) && isNum(c) && c > 0) { usd += c; out.reviews++; } }
  for (const l of labs) { const c = l && l.ai && l.ai.costUsd; if (inRange(l.date || l.collectedAt) && isNum(c) && c > 0) { usd += c; out.labs++; } }
  return { usd: Math.round(usd * 10000) / 10000, ...out, n: out.meals + out.reviews + out.labs };
}
export const fmtUsd = (usd) => (!isNum(usd) ? '—' : usd === 0 ? '$0' : usd < 0.01 ? '< $0.01' : '$' + usd.toFixed(2));

/* ------------------------------------------------------------ integrations */
/**
 * WHOOP state from settings `integrations.whoop` and the `status/whoop` record.
 * → { key: 'off'|'saved'|'pending'|'ok'|'backfill'|'reauth'|'error', tone, text }
 */
export function whoopState(whoop = {}, status = null, now = Date.now()) {
  const st = status || null;
  if (!whoop.connectedAt) {
    if (st && st.lastError === 'reauth-needed') return { key: 'reauth', tone: 'bad', text: 'Reconnect needed' };
    if (whoop.clientId) return { key: 'saved', tone: null, text: 'Credentials saved · not connected' };
    return { key: 'off', tone: null, text: 'Not connected' };
  }
  const requested = toMs(whoop.connectedAt);
  const lastRun = st ? toMs(st.lastRunAt) : null;
  const lastOk = st ? toMs(st.lastOkAt) : null;
  // A (re)connect newer than the last server run: the auth run has not reported yet.
  if (!lastRun || (requested && lastRun < requested - 5000)) return { key: 'pending', tone: 'warn', text: 'Connecting · waiting for the server' };
  if (st.lastError === 'reauth-needed') return { key: 'reauth', tone: 'bad', text: 'Reconnect needed' };
  if (st.lastError === 'not-connected') return { key: 'error', tone: 'bad', text: 'Not connected on the server · connect again' };
  if (st.lastError && (!lastOk || lastRun > lastOk)) {
    const failedAuth = st.detail && st.detail.state === 'auth-failed';
    return { key: 'error', tone: 'bad', text: (failedAuth ? 'Connection failed: ' : 'Sync failed: ') + st.lastError };
  }
  if (!lastOk) return { key: 'pending', tone: 'warn', text: 'Connecting · waiting for the first sync' };
  const backfill = st.detail && st.detail.backfill === 'in-progress';
  const when = relTime(lastOk, now);
  return backfill ? { key: 'backfill', tone: 'good', text: `Connected · importing history · synced ${when}` }
    : { key: 'ok', tone: 'good', text: `Connected · synced ${when}` };
}

/** Last WHOOP run from status detail.lastRun: '14 new or updated (5 sleep, 5 recovery, 2 workouts, 2 cycles)'. */
export function whoopRunText(detail) {
  const r = detail && detail.lastRun; if (!r) return null;
  const c = r.changed || {}; const kinds = [['sleep', 'sleep'], ['recovery', 'recovery'], ['workouts', 'workouts'], ['cycles', 'cycles']];
  const total = kinds.reduce((s, [k]) => s + (isNum(c[k]) ? c[k] : 0), 0);
  if (!total) return 'No new data';
  return `${total} new or updated (${kinds.filter(([k]) => c[k]).map(([k, l]) => `${c[k]} ${l}`).join(', ')})`;
}

/** Last calendar run: 'Read 2 of 2 calendars · 143 events · pushed +3 ~1 −0'. */
export function calendarRunText(detail) {
  if (!detail) return null;
  const parts = [];
  const r = detail.read;
  if (r && isNum(r.calendars)) parts.push(`read ${r.ok ?? 0} of ${r.calendars} calendar${r.calendars === 1 ? '' : 's'}`, `${fmtNum(r.events || 0)} events`);
  const w = detail.write;
  if (w && (isNum(w.inserted) || isNum(w.patched))) parts.push(`FORGE calendar +${w.inserted || 0} ~${(w.patched || 0) + (w.adopted || 0)} −${w.deleted || 0}`);
  if (!parts.length) return null;
  const s = parts.join(' · ');
  return s[0].toUpperCase() + s.slice(1);
}

/** Last push run: 'Sent brief, checkin · 1 device' / 'Nothing due · quiet hours'. */
export function pushRunText(detail) {
  if (!detail) return null;
  const parts = [];
  if (detail.lastSent && Array.isArray(detail.lastSent.kinds) && detail.lastSent.kinds.length) parts.push(`last sent: ${detail.lastSent.kinds.join(', ')}`);
  if (detail.quiet) parts.push('quiet hours');
  if (isNum(detail.subs)) parts.push(`${detail.subs} subscription${detail.subs === 1 ? '' : 's'}`);
  if (!parts.length) return null;
  const s = parts.join(' · ');
  return s[0].toUpperCase() + s.slice(1);
}

/** Google Calendar state from settings `integrations.gcal` + `status/calendar`. */
export function calendarState(gcal = {}, status = null, now = Date.now()) {
  const reads = (gcal.readCalendars || []).filter(Boolean).length;
  if (!gcal.saEmail) return { key: 'off', tone: null, text: 'Not connected' };
  const parts = [`${reads} calendar${reads === 1 ? '' : 's'} read`, gcal.forgeCalendarId ? 'FORGE calendar set' : 'no FORGE calendar'];
  if (!status) return { key: 'pending', tone: 'warn', text: parts.join(' · ') + ' · no sync yet' };
  const lastOk = toMs(status.lastOkAt);
  if (status.lastError && (!lastOk || toMs(status.lastRunAt) > lastOk)) return { key: 'error', tone: 'bad', text: 'Sync issue: ' + status.lastError };
  if (!reads && !gcal.forgeCalendarId) return { key: 'idle', tone: 'warn', text: 'No calendars configured' };
  return { key: 'ok', tone: lastOk ? 'good' : 'warn', text: `${parts.join(' · ')} · ${lastOk ? 'synced ' + relTime(lastOk, now) : 'no successful sync yet'}` };
}

/** Push state from pushSubs records (+ status/push). */
export function pushState(subs = [], status = null) {
  const active = subs.filter((s) => s && !s._d && s.active !== false);
  const dead = new Set((status && status.detail && Array.isArray(status.detail.deadSubs)) ? status.detail.deadSubs : []);
  const live = active.filter((s) => !dead.has(s.id));
  if (!live.length) return { key: 'off', tone: null, text: 'Push off', devices: 0 };
  const names = [...new Set(live.map((s) => s.device || 'Device'))];
  return { key: 'ok', tone: 'good', text: `Push on ${live.length} device${live.length === 1 ? '' : 's'}`, devices: live.length, names };
}

/** One index line for Integrations: 'WHOOP synced 12 min ago · Calendar on · Push on 1 device'. */
export function integrationsSummary(whoop, cal, push, whoopStatus, now = Date.now()) {
  const w = whoop.key === 'ok' || whoop.key === 'backfill' ? `WHOOP synced ${relTime(whoopStatus && whoopStatus.lastOkAt, now)}`
    : whoop.key === 'pending' ? 'WHOOP connecting' : whoop.key === 'reauth' ? 'WHOOP needs reconnect'
    : whoop.key === 'error' ? 'WHOOP sync failed' : 'WHOOP not connected';
  const c = cal.key === 'off' ? 'Calendar off' : cal.key === 'error' ? 'Calendar issue' : 'Calendar on';
  return { tone: whoop.tone === 'bad' || cal.tone === 'bad' ? 'bad' : null, text: [w, c, push.text].join(' · ') };
}

/** GitHub Actions workflow run → { text, tone } ('Success', 'Failed', 'Running', 'Queued'). */
export function runState(run) {
  if (!run) return { text: '—', tone: null };
  if (run.status === 'completed') {
    const c = run.conclusion;
    if (c === 'success') return { text: 'Success', tone: 'good' };
    if (c === 'cancelled' || c === 'skipped') return { text: c === 'cancelled' ? 'Cancelled' : 'Skipped', tone: null };
    return { text: c === 'timed_out' ? 'Timed out' : 'Failed', tone: 'bad' };
  }
  if (run.status === 'in_progress') return { text: 'Running', tone: 'warn' };
  return { text: run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' ? 'Queued' : String(run.status || '—'), tone: null };
}

/** Automation line from the installed record, the latest bundle info and status/run. */
export function automationSummary(installed, latest, runStatus, now = Date.now()) {
  if (!installed) return { key: 'off', tone: 'warn', text: 'Not installed' };
  const upToDate = !!(latest && installed.sha256 === latest.sha256);
  const parts = [`v${installed.version || '?'}`];
  if (latest) parts.push(upToDate ? 'up to date' : `update to v${latest.version} available`);
  if (runStatus && runStatus.lastRunAt) parts.push(`last run ${relTime(runStatus.lastRunAt, now)}`);
  const failing = runStatus && runStatus.lastError;
  return { key: failing ? 'error' : upToDate || !latest ? 'ok' : 'update', tone: failing ? 'bad' : latest && !upToDate ? 'warn' : 'good', text: parts.join(' · '), upToDate };
}

/* ------------------------------------------------------------------ index */
export function syncSummary(s, now = Date.now()) {
  if (!s) return { tone: null, text: '—' };
  if (s.state === 'demo') return { tone: null, text: 'Demo — nothing is saved' };
  if (s.state === 'error') return { tone: 'bad', text: 'Sync issue: ' + (s.error || 'unknown error') };
  if (s.state === 'offline') return { tone: 'warn', text: `Offline${s.pending ? ` · ${s.pending} pending` : ''}` };
  if (s.state === 'pushing' || s.state === 'pulling') return { tone: null, text: 'Syncing…' };
  const when = s.lastSyncAt ? `synced ${relTime(s.lastSyncAt, now)}` : 'not synced yet';
  return { tone: s.pending ? 'warn' : 'good', text: s.pending ? `${s.pending} change${s.pending === 1 ? '' : 's'} pending · ${when}` : when[0].toUpperCase() + when.slice(1) };
}

export function profileSummary(p = {}, today = '') {
  const parts = [];
  if (isNum(p.heightIn)) parts.push(`${Math.floor(p.heightIn / 12)} ft ${fmtNum(p.heightIn % 12, p.heightIn % 1 ? 1 : 0)} in`);
  if (isNum(p.birthYear) && today) parts.push(`${Number(today.slice(0, 4)) - p.birthYear} y`);
  if (isNum(p.goalWeightLow) || isNum(p.goalWeightHigh)) parts.push(`goal ${[p.goalWeightLow, p.goalWeightHigh].filter(isNum).map((x) => fmtNum(x)).join('–')} lb`);
  if (!parts.length) return { tone: 'warn', text: 'Add height, birth year and goal weight' };
  if (!isNum(p.heightIn) || !isNum(p.birthYear)) parts.push('height or birth year missing');
  return { tone: null, text: parts.join(' · ') };
}

/** From calorieTargets(): 'Adaptive · 3,120 kcal · 165 g protein'. */
export function targetsSummary(ct, mode) {
  const m = mode === 'manual' ? 'Manual' : 'Adaptive';
  if (!ct || ct.kcal == null) return { tone: 'warn', text: `${m} · needs a weigh-in, height and birth year` };
  const parts = [m, `${fmtNum(ct.kcal)} kcal`];
  if (isNum(ct.proteinG)) parts.push(`${fmtNum(ct.proteinG)} g protein`);
  if (ct.basis === 'estimate') parts.push('estimated');
  return { tone: null, text: parts.join(' · ') };
}

export function standardsSummary(list = []) {
  const active = list.filter((s) => s && s.active !== false);
  if (!active.length) return { tone: 'warn', text: 'No active standards' };
  const req = active.filter((s) => s.required).length;
  const auto = active.filter((s) => s.auto).length;
  return { tone: null, text: `${active.length} active · ${req} required · ${auto} automatic` };
}

export function rulesSummary(rules = []) {
  const active = rules.filter((r) => r && r.active !== false && String(r.text || '').trim());
  if (!rules.length) return { tone: null, text: 'No rules yet' };
  return { tone: null, text: `${active.length} active rule${active.length === 1 ? '' : 's'}${rules.length > active.length ? ` · ${rules.length - active.length} off` : ''}` };
}

export function notificationsSummary(n = {}, { devices = 0 } = {}) {
  const on = [];
  if (n.morningBrief) on.push('brief');
  if (n.eveningCheckinAt) on.push(`check-in ${fmtTime(n.eveningCheckinAt)}`);
  if (n.weeklyReview) on.push('weekly');
  if (n.doseReminders) on.push('protocol');
  if (!on.length) return { tone: null, text: 'All off' };
  const text = on.join(', ');
  return devices ? { tone: null, text: text[0].toUpperCase() + text.slice(1) } : { tone: 'warn', text: `No device enabled · ${on.length} type${on.length === 1 ? '' : 's'} selected` };
}

export function securitySummary({ lockMode, autoLockMin } = {}) {
  const mode = lockMode === 'session' ? 'Passphrase every session' : 'Stays unlocked on this device';
  return { tone: null, text: autoLockMin ? `${mode} · auto-lock ${autoLockMin} min` : mode };
}

export const THEMES = [{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }];
export const START_OPTIONS = [
  { value: 'today', label: 'Today' }, { value: 'plan', label: 'Plan' }, { value: 'train', label: 'Train' },
  { value: 'fuel', label: 'Fuel' }, { value: 'insights', label: 'Insights' },
];
export function appearanceSummary(ui = {}) {
  const t = (THEMES.find((x) => x.value === ui.theme) || THEMES[0]).label;
  const s = (START_OPTIONS.find((x) => x.value === ui.startScreen) || START_OPTIONS[0]).label;
  return { tone: null, text: `${t} theme · opens on ${s}` };
}

export function aiSummary({ hasKey, ai = {} }) {
  if (!hasKey) return { tone: 'warn', text: 'No API key on this device' };
  return { tone: null, text: `Key set · ${modelLabel(ai.model)}${ai.serverReviews ? ' · server reviews on' : ''}` };
}

/**
 * Setup checklist for the overview: [{ id, section, label, done, optional }].
 * Inputs are booleans/values the caller derives from the store and session.
 */
export function setupChecklist(x) {
  return [
    { id: 'profile', section: 'profile', label: 'Height, birth year and goal weight', done: !!x.profileDone },
    { id: 'weighin', section: null, label: 'First weigh-in', done: !!x.hasWeighIn },
    { id: 'ai', section: 'ai', label: 'Anthropic API key on this device (meal analysis)', done: !!x.hasKey },
    { id: 'automation', section: 'automation', label: 'Server automation installed', done: !!x.automationInstalled },
    { id: 'whoop', section: 'integrations', label: 'WHOOP connected', done: !!x.whoopConnected },
    { id: 'calendar', section: 'integrations', label: 'Google Calendar connected', done: !!x.calendarConnected, optional: true },
    { id: 'push', section: 'integrations', label: 'Notifications on this phone', done: !!x.pushOn, optional: true },
    { id: 'rules', section: 'nutrition', label: 'Your nutrition rules', done: !!x.hasRules, optional: true },
  ];
}
