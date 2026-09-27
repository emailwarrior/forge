// FORGE core utilities. Pure functions only; safe in browser and Node.

/* ------------------------------------------------------------------ ids */
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function uid(len = 12) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += B36[bytes[i] % 36];
  return s;
}
// Stable, short, deterministic id from a string (FNV-1a 64-bit folded to base36).
export function hashId(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 14);
}

/* ---------------------------------------------------------------- dates */
export const DAY_MS = 86400000;
export const pad2 = (n) => String(n).padStart(2, '0');

// Local (device) calendar date of a Date object.
export function ymd(d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
export function todayStr(tz) {
  return tz ? localParts(Date.now(), tz).ymd : ymd(new Date());
}
export function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
// Pure calendar arithmetic on 'YYYY-MM-DD' strings (UTC-based, DST-proof).
function ymdToUtc(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function utcToYmd(ms) { const d = new Date(ms); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
export function addDays(s, n) { return utcToYmd(ymdToUtc(s) + n * DAY_MS); }
export function diffDays(a, b) { return Math.round((ymdToUtc(b) - ymdToUtc(a)) / DAY_MS); }
export function dayOfWeek(s) { return (new Date(ymdToUtc(s)).getUTCDay() + 6) % 7; } // Mon=0..Sun=6
export function weekStart(s) { return addDays(s, -dayOfWeek(s)); }
export function monthKey(s) { return s.slice(0, 7); }
export function yearKey(s) { return s.slice(0, 4); }
export function isoWeek(s) {
  const t = ymdToUtc(s); const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; const thu = t + (3 - day) * DAY_MS;
  const y = new Date(thu).getUTCFullYear(); const jan4 = Date.UTC(y, 0, 4);
  const jan4day = (new Date(jan4).getUTCDay() + 6) % 7; const week1Mon = jan4 - jan4day * DAY_MS;
  return y + '-W' + pad2(1 + Math.floor((thu - week1Mon) / (7 * DAY_MS)));
}
export function dateRange(from, to) {
  const out = []; if (!from || !to || from > to) return out;
  for (let s = from; s <= to; s = addDays(s, 1)) out.push(s);
  return out;
}
export function monthsBetween(from, to) {
  const out = []; let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(y + '-' + pad2(m)); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
export function hmToMin(hm) {
  if (hm == null || hm === '') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm)); if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
export function minToHm(min) {
  if (min == null || !isFinite(min)) return '';
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60);
}

/* --------------------------------------------------------- time zones */
const fmtCache = new Map();
function partsFormatter(tz) {
  const key = tz || '';
  if (!fmtCache.has(key)) {
    fmtCache.set(key, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
    }));
  }
  return fmtCache.get(key);
}
export function deviceTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
// Wall-clock parts of an instant in a time zone.
export function localParts(t, tz) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  const p = {}; for (const x of partsFormatter(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  const hour = Number(p.hour) % 24, minute = Number(p.minute);
  const ymdStr = p.year + '-' + p.month + '-' + p.day;
  return { ymd: ymdStr, hm: pad2(hour) + ':' + pad2(minute), min: hour * 60 + minute, second: Number(p.second), dow: dayOfWeek(ymdStr) };
}
// Offset (minutes east of UTC) of a time zone at an instant.
export function tzOffsetMin(ms, tz) {
  const p = localParts(ms, tz);
  const [y, mo, d] = p.ymd.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, Math.floor(p.min / 60), p.min % 60, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}
export function offsetStr(min) {
  const sign = min >= 0 ? '+' : '-'; const a = Math.abs(min);
  return sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}
export function parseOffset(str) {
  if (!str) return 0; if (str === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(str).trim()); if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
// ISO string with explicit offset for an instant in a zone: 2026-09-26T12:34:00-04:00
export function isoWithOffset(ms = Date.now(), tz) {
  const zone = tz || deviceTz(); const off = tzOffsetMin(ms, zone); const p = localParts(ms, zone);
  return p.ymd + 'T' + p.hm + ':' + pad2(p.second) + offsetStr(off);
}
export function nowIso(tz) { return isoWithOffset(Date.now(), tz); }
// Local wall time of a UTC instant given a fixed offset string (e.g. WHOOP timezone_offset).
export function localFromOffset(iso, offset) {
  const ms = Date.parse(iso) + parseOffset(offset) * 60000; const d = new Date(ms);
  const ymdStr = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { ymd: ymdStr, hm: minToHm(min), min, dow: dayOfWeek(ymdStr) };
}
// Build an instant from a local date + 'HH:MM' in a zone (handles DST by iteration).
export function zonedToMs(ymdStr, hm, tz) {
  const [y, mo, d] = ymdStr.split('-').map(Number); const min = hmToMin(hm) || 0;
  const guess = Date.UTC(y, mo - 1, d, Math.floor(min / 60), min % 60);
  let ms = guess - tzOffsetMin(guess, tz) * 60000;
  ms = guess - tzOffsetMin(ms, tz) * 60000;
  return ms;
}
// Minutes of an instant relative to local noon of `refYmd` (bedtimes past midnight stay continuous).
export function minutesFromNoon(t, tz, refYmd) {
  const p = localParts(t, tz); return (diffDays(refYmd, p.ymd) * 1440) + p.min - 720;
}

/* -------------------------------------------------------- formatting */
export const round = (n, d = 0) => { if (n == null || !isFinite(n)) return null; const f = 10 ** d; return Math.round(n * f) / f; };
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const isNum = (n) => typeof n === 'number' && isFinite(n);
const numFmts = new Map();
export function fmtNum(n, dp = 0) {
  if (!isNum(n)) return '—';
  let f = numFmts.get(dp);
  if (!f) { f = new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); numFmts.set(dp, f); }
  return f.format(n);
}
export function fmtCompact(n, dp = 1) {
  if (!isNum(n)) return '—'; const a = Math.abs(n); const s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + round(a / 1e9, dp) + 'B';
  if (a >= 1e6) return s + round(a / 1e6, dp) + 'M';
  if (a >= 1e4) return s + round(a / 1e3, dp) + 'K';
  return s + fmtNum(a, a < 10 && a % 1 ? 1 : 0);
}
export function fmtMoney(n, compact = false) {
  if (!isNum(n)) return '—'; const s = n < 0 ? '-$' : '$'; const a = Math.abs(n);
  if (compact) { if (a >= 1e6) return s + round(a / 1e6, 2) + 'M'; if (a >= 1e3) return s + round(a / 1e3, 1) + 'K'; }
  return s + Math.round(a).toLocaleString('en-US');
}
export function fmtPct(n, dp = 0) { return isNum(n) ? round(n, dp) + '%' : '—'; }
export function fmtDur(min) {
  if (!isNum(min)) return '—'; const m = Math.round(min); const h = Math.floor(Math.abs(m) / 60); const r = Math.abs(m) % 60;
  return (m < 0 ? '-' : '') + (h ? h + 'h ' + pad2(r) + 'm' : r + 'm');
}
export function fmtHours(h) { return isNum(h) ? fmtDur(h * 60) : '—'; }
export function fmtTime(hmOrMin) {
  const min = typeof hmOrMin === 'number' ? hmOrMin : hmToMin(hmOrMin); if (!isNum(min)) return '—';
  const v = ((Math.round(min) % 1440) + 1440) % 1440; let h = Math.floor(v / 60); const m = v % 60; const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12; return h + ':' + pad2(m) + ' ' + ap;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function fmtDate(s, opts = {}) {
  if (!isYmd(s)) return '—'; const [y, m, d] = s.split('-').map(Number);
  const base = MONTHS[m - 1] + ' ' + d; const withDow = opts.dow === false ? base : DOWS[dayOfWeek(s)] + ', ' + base;
  return opts.year ? withDow + ', ' + y : withDow;
}
export const dowName = (i) => DOWS[i];
export const monthName = (i) => MONTHS[i];
export function relDay(s, today = todayStr()) {
  const d = diffDays(today, s);
  if (d === 0) return 'Today'; if (d === -1) return 'Yesterday'; if (d === 1) return 'Tomorrow';
  return fmtDate(s);
}
export function signed(n, dp = 0) { if (!isNum(n)) return '—'; const r = round(n, dp); return (r > 0 ? '+' : '') + fmtNum(r, dp); }

/* ------------------------------------------------------------- units */
export const LB_PER_KG = 2.2046226218;
export const kgToLb = (kg) => (isNum(kg) ? kg * LB_PER_KG : null);
export const lbToKg = (lb) => (isNum(lb) ? lb / LB_PER_KG : null);
export const kjToKcal = (kj) => (isNum(kj) ? kj / 4.184 : null);
export const cToF = (c) => (isNum(c) ? c * 9 / 5 + 32 : null);

/* ------------------------------------------------------------ base64 */
export function bytesToB64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
export const utf8ToB64 = (s) => bytesToB64(new TextEncoder().encode(s));
export const b64ToUtf8 = (b) => new TextDecoder().decode(b64ToBytes(b));
export function b64url(u8) { return bytesToB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function b64urlToBytes(s) { let t = s.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return b64ToBytes(t); }

/* ------------------------------------------------------------- misc */
export function clone(v) { return v == null ? v : (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))); }
// JSON with sorted object keys: deterministic across devices (used for tie-breaks and hashing).
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
export function deepEqual(a, b) { return stableStringify(a) === stableStringify(b); }
export function debounce(fn, ms) {
  let t = null; let pending = [];
  const d = (...args) => { clearTimeout(t); pending = args; t = setTimeout(() => { t = null; fn(...pending); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(...pending); } }; // runs the pending call with its own arguments
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function groupBy(arr, keyFn) {
  const m = new Map(); for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m;
}
export function sum(arr, fn) { let s = 0; for (const x of arr) { const v = fn ? fn(x) : x; if (isNum(v)) s += v; } return s; }
export function mean(arr, fn) { let s = 0, n = 0; for (const x of arr) { const v = fn ? fn(x) : x; if (isNum(v)) { s += v; n++; } } return n ? s / n : null; }
export function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
