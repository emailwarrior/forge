// Settings: small pure helpers (time zones, height, passphrase strength, validation, storage stats).
import { tzOffsetMin, offsetStr, isNum } from '../../core/util.js';
import { COLLECTIONS } from '../../core/schema.js';

/* ------------------------------------------------------------ time zones */
const FALLBACK_ZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo', 'Europe/London',
  'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
  'Europe/Zurich', 'Europe/Stockholm', 'Europe/Athens', 'Europe/Istanbul', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
];
export function isValidZone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}
/** 'UTC−04:00' (typographic minus) for a zone at an instant. */
export function zoneOffsetLabel(zone, ms = Date.now()) {
  try { return 'UTC' + offsetStr(tzOffsetMin(ms, zone)).replace('-', '−'); } catch { return ''; }
}
/**
 * Time-zone options grouped by region: [{ group, zones: [{ value, label }] }]. Always includes
 * `extra` zones (device zone, current setting) when valid. Labels: 'New York · UTC−04:00'.
 */
export function timeZoneGroups({ extra = [], now = Date.now(), list } = {}) {
  let zones = list;
  if (!zones) { try { zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : null; } catch { zones = null; } }
  const set = new Set(zones && zones.length ? zones : FALLBACK_ZONES);
  set.add('UTC');
  for (const z of extra) if (isValidZone(z)) set.add(z);
  const groups = new Map();
  for (const z of [...set].sort()) {
    const i = z.indexOf('/');
    const group = i < 0 ? 'Other' : z.slice(0, i);
    const city = (i < 0 ? z : z.slice(i + 1)).replace(/_/g, ' ').replace(/\//g, ' · ');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ value: z, label: `${city} · ${zoneOffsetLabel(z, now)}` });
  }
  return [...groups.entries()].map(([group, list2]) => ({ group, zones: list2 })).sort((a, b) => (a.group === 'Other') - (b.group === 'Other') || a.group.localeCompare(b.group));
}

/* ---------------------------------------------------------------- height */
/** 71 → { ft: 5, inch: 11 }; null → { ft: null, inch: null }. */
export function splitHeight(heightIn) {
  if (!isNum(heightIn) || heightIn <= 0) return { ft: null, inch: null };
  const ft = Math.floor(heightIn / 12);
  return { ft, inch: Math.round((heightIn - ft * 12) * 10) / 10 };
}
/** (5, 11) → 71; (null, null) → null; (6, null) → 72. */
export function joinHeight(ft, inch) {
  if (!isNum(ft) && !isNum(inch)) return null;
  const v = (isNum(ft) ? ft : 0) * 12 + (isNum(inch) ? inch : 0);
  return v > 0 ? Math.round(v * 10) / 10 : null;
}

/* ------------------------------------------------------------ validation */
/** Profile field errors: { heightFt, heightIn, birthYear, goalWeightLow, goalWeightHigh, goalRateLbWk }. */
export function profileErrors(p, { year = new Date().getFullYear() } = {}) {
  const e = {};
  const { ft, inch } = p;
  if (ft != null && (!isNum(ft) || ft < 3 || ft > 8)) e.heightFt = '3–8 ft';
  if (inch != null && (!isNum(inch) || inch < 0 || inch >= 12)) e.heightIn = '0–11.9 in';
  if (p.birthYear != null && (!Number.isInteger(p.birthYear) || p.birthYear < year - 110 || p.birthYear > year - 10)) e.birthYear = `${year - 110}–${year - 10}`;
  for (const k of ['goalWeightLow', 'goalWeightHigh']) if (p[k] != null && (!isNum(p[k]) || p[k] < 60 || p[k] > 600)) e[k] = '60–600 lb';
  if (!e.goalWeightLow && !e.goalWeightHigh && isNum(p.goalWeightLow) && isNum(p.goalWeightHigh) && p.goalWeightLow > p.goalWeightHigh) e.goalWeightHigh = 'Must be at least the low end';
  if (p.goalRateLbWk != null && (!isNum(p.goalRateLbWk) || p.goalRateLbWk < -2 || p.goalRateLbWk > 2)) e.goalRateLbWk = '−2 to 2 lb/week';
  return e;
}
/** Targets field errors (numbers only; times come from time inputs). */
export function targetsErrors(t) {
  const e = {};
  const range = (k, lo, hi, msg) => { if (t[k] != null && (!isNum(t[k]) || t[k] < lo || t[k] > hi)) e[k] = msg; };
  range('kcal', 800, 8000, '800–8,000 kcal');
  range('proteinG', 20, 500, '20–500 g');
  range('proteinPerLb', 0.3, 2, '0.3–2 g/lb');
  range('fatPct', 10, 60, '10–60%');
  range('fiberG', 0, 100, '0–100 g');
  range('surplusKcal', -1500, 1500, '−1,500 to 1,500 kcal');
  range('sleepTargetH', 4, 12, '4–12 h');
  range('deepWorkTargetH', 0, 16, '0–16 h');
  return e;
}

/* ------------------------------------------------------ passphrase strength */
export const STRENGTH_LABELS = ['', 'Weak', 'Fair', 'Good', 'Strong'];
/** Same thresholds as setup: ≥70 strong, ≥55 good (the minimum), ≥40 fair, >0 weak. */
export function strengthLevel(bits) { return bits >= 70 ? 4 : bits >= 55 ? 3 : bits >= 40 ? 2 : bits > 0 ? 1 : 0; }
export const MIN_PASSPHRASE_BITS = 55;

/* ------------------------------------------------------------------ data */
export const backupFileName = (today) => `forge-backup-${today}.json`;

/**
 * Records per collection from a store: [{ name, owner ('app'|'server'|'both'), live, deleted, shards }],
 * largest first, collections without records omitted. Also totals.
 */
export function collectionStats(store) {
  const shardsBy = new Map();
  for (const p of store.shardPaths()) { const info = store.shardInfo(p); if (info) shardsBy.set(info.name, (shardsBy.get(info.name) || 0) + 1); }
  const rows = [];
  for (const [name, def] of Object.entries(COLLECTIONS)) {
    const all = store.all(name, { includeDeleted: true });
    const live = store.all(name).length;
    if (!all.length && !shardsBy.get(name)) continue;
    rows.push({ name, owner: def.owners.length > 1 ? 'both' : def.owners[0], live, deleted: all.length - live, shards: shardsBy.get(name) || 0 });
  }
  rows.sort((a, b) => b.live - a.live || a.name.localeCompare(b.name));
  return { rows, shards: store.shardPaths().length, live: rows.reduce((s, r) => s + r.live, 0), deleted: rows.reduce((s, r) => s + r.deleted, 0) };
}

/* ----------------------------------------------------------- nutrition */
/** Generic, evidence-based example rules offered as one-tap suggestions (never defaults). */
export const RULE_SUGGESTIONS = [
  'Protein at every meal, 30–50 g',
  'Last meal 3 h before bed',
  'Fiber ≥ 14 g per 1,000 kcal',
  'Vegetables or fruit at 2+ meals a day',
  'Carbs and protein within 2 h after training',
  'Mostly minimally processed foods',
  'Alcohol ≤ 2 drinks, none within 3 h of bed',
];
const normRule = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Suggestions not already present (case/space-insensitive). */
export function openSuggestions(rules, suggestions = RULE_SUGGESTIONS) {
  const have = new Set((rules || []).map((r) => normRule(r && r.text)));
  return suggestions.filter((s) => !have.has(normRule(s)));
}
/** Move a rule one step: returns a new array (unchanged at the edges). */
export function moveItem(list, id, dir) {
  const arr = [...list]; const i = arr.findIndex((x) => x.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return arr;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return arr;
}

/* ---------------------------------------------------------------- calendar */
/** Normalize a pasted calendar id (trim; accept an embed URL's src= value). */
export function normalizeCalendarId(text) {
  let s = String(text || '').trim();
  const m = /[?&]src=([^&\s]+)/.exec(s);
  if (m) { try { s = decodeURIComponent(m[1]); } catch { s = m[1]; } }
  return s;
}
export function isCalendarId(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}
/** Why a calendar ID will not work for a service account, or '' when it looks fine. */
export function calendarIdIssue(s) {
  const v = String(s || '').trim();
  if (v === 'primary') return '“primary” means the service account’s own empty calendar. Use your calendar’s address (usually your Google email).';
  if (!isCalendarId(v)) return 'Not a calendar address. Use the calendar’s email or its …@group.calendar.google.com ID.';
  return '';
}

/* ---------------------------------------------------------------- secrets */
/** Actions secrets FORGE uses: [{ name, purpose, required }]. */
export const SECRETS = [
  { name: 'FORGE_DATA_KEY', purpose: 'Data key: lets automation decrypt and encrypt the vault', required: true },
  { name: 'WHOOP_CLIENT_ID', purpose: 'WHOOP app client ID' },
  { name: 'WHOOP_CLIENT_SECRET', purpose: 'WHOOP app client secret' },
  { name: 'GOOGLE_SA_KEY', purpose: 'Google service-account key (Calendar)' },
  { name: 'VAPID_PRIVATE_KEY', purpose: 'Push notification signing key' },
  { name: 'ANTHROPIC_API_KEY', purpose: 'Server-side nutrition and weekly reviews' },
];

/** Masked secret for display: 'sk-ant-…9f3Q'. */
export function maskKey(k) {
  const s = String(k || ''); if (!s) return '';
  if (s.length <= 10) return '•'.repeat(s.length);
  return s.slice(0, 7) + '…' + s.slice(-4);
}

/* ------------------------------------------------------------ collections */
export const COLLECTION_LABELS = {
  settings: 'Settings', standards: 'Standards', checks: 'Daily checks', days: 'Day logs', journal: 'Journal entries',
  savedQuotes: 'Saved quotes', exercises: 'Exercises', templates: 'Templates', sessions: 'Training sessions', meals: 'Meals',
  foods: 'Saved foods', protocolItems: 'Protocol items', doses: 'Doses', body: 'Body measurements', health: 'Apple Health days',
  labs: 'Lab panels', plan: 'Plan blocks', reviews: 'Reviews', pushSubs: 'Push devices', snapshots: 'Finance months',
  whoopCycles: 'WHOOP cycles', whoopRecovery: 'WHOOP recoveries', whoopSleep: 'WHOOP sleeps', whoopWorkouts: 'WHOOP workouts',
  whoopBody: 'WHOOP body', calendarEvents: 'Calendar events', calendarMap: 'Calendar sync map', pushLog: 'Push log',
  status: 'Automation status', secrets: 'Server credentials',
};
