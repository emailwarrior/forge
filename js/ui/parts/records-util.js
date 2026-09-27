// Records area (Protocols, Labs, Finance, Journal, More): small pure formatting helpers.
// No DOM, no store access — covered by tests/ui/records-util.test.mjs.
import { isNum, fmtTime, fmtDate, diffDays, localParts } from '../../core/util.js';

const qtyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
/** Quantity with up to 3 decimals and thousands separators: 5000 → "5,000", 2.25 → "2.25", 0.250 → "0.25". */
export function fmtQty(n) { return isNum(n) ? qtyFmt.format(n) : '—'; }

/** Parse a user-typed number ("1,234.5", " 2 ") → number | null. */
export function parseNum(v) {
  if (isNum(v)) return v;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return isNum(n) ? n : null;
}

/**
 * Relative "time since" for status lines. `then`/`now` are ms (or ISO strings for `then`); `tz` formats older dates.
 * < 1 min "just now", < 60 min "12 min ago", < 24 h "5 h ago", yesterday "Yesterday 9:05 PM", older "Sep 20".
 */
export function agoText(then, now = Date.now(), tz) {
  const t = typeof then === 'string' ? Date.parse(then) : then;
  if (!isNum(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const a = localParts(t, tz); const b = localParts(now, tz);
  const days = diffDays(a.ymd, b.ymd);
  if (days <= 0) return `${h} h ago`;
  if (days === 1) return `Yesterday ${fmtTime(a.hm)}`;
  return fmtDate(a.ymd, { dow: false, year: a.ymd.slice(0, 4) !== b.ymd.slice(0, 4) });
}

/** Local 'HH:MM' and date of an ISO instant (null-safe). */
export function localHm(iso, tz) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!isNum(ms)) return null;
  return localParts(ms, tz).hm;
}

/** Pluralize a count noun: plural(1, 'entry', 'entries') → "1 entry". */
export function plural(n, one, many = one + 's') { return `${isNum(n) ? n.toLocaleString('en-US') : n} ${n === 1 ? one : many}`; }

/** Status line for the vault sync state → { text, tone }. */
export function syncLine(s, { demo, now, tz } = {}) {
  if (demo || (s && s.state === 'demo')) return { text: 'Demo mode — nothing is saved', tone: null };
  if (!s) return { text: 'Unknown', tone: null };
  if (s.state === 'error') return { text: 'Sync issue' + (s.error ? ': ' + s.error : ''), tone: 'bad' };
  if (s.state === 'offline') return { text: `Offline${s.pending ? ` · ${plural(s.pending, 'change')} waiting` : ''}`, tone: 'warn' };
  if (s.state === 'pushing' || s.state === 'pulling') return { text: 'Syncing…', tone: null };
  if (s.pending) return { text: `${plural(s.pending, 'change')} waiting to sync`, tone: null };
  return { text: s.lastSyncAt ? `Synced ${agoText(s.lastSyncAt, now, tz)}` : 'Up to date', tone: 'good' };
}
/** Status line for an automation integration from its `status` record → { text, tone }. */
export function integrationLine(rec, { configured, demo, now, tz } = {}) {
  if (demo) return { text: 'Demo data (synthetic)', tone: null };
  if (rec && rec.lastError) return { text: `Error: ${rec.lastError}${rec.lastOkAt ? ` · last success ${agoText(rec.lastOkAt, now, tz)}` : ''}`, tone: 'bad' };
  if (rec && rec.lastOkAt) return { text: `Last sync ${agoText(rec.lastOkAt, now, tz)}`, tone: 'good' };
  if (rec && rec.lastRunAt) return { text: `Checked ${agoText(rec.lastRunAt, now, tz)} · no data yet`, tone: null };
  if (configured) return { text: 'Connected · waiting for the first sync', tone: null };
  return { text: 'Not connected', tone: null };
}
