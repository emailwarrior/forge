// Logging, error shaping and small shared runtime helpers for FORGE automation.
//
// Rules (docs/ARCHITECTURE.md §2, §11): console output carries counts and statuses only.
// Never print tokens, keys, calendar ids, titles, data values or HTTP response bodies.
// Every message passes through redact(), which masks registered secrets and anything
// that looks like a credential, as a second line of defense.

const secrets = new Set();

// Register a runtime secret (env keys, OAuth tokens) so it can never reach a log line
// or a stored error message, even if some library echoes it back.
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

export function redact(text) {
  let s = String(text ?? '');
  for (const v of secrets) if (s.includes(v)) s = s.split(v).join('***');
  return s
    .replace(/\b(Bearer|Basic|vapid t=)\s*[^\s,]+/gi, '$1 ***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***');
}

// One line, bounded, redacted. Used for status.lastError and log lines.
export function shortError(e, max = 180) {
  const msg = e && typeof e === 'object' ? (e.message || e.code || String(e)) : String(e ?? 'error');
  const one = redact(msg).replace(/\s+/g, ' ').trim() || 'error';
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function createLogger({ sink = console, prefix = '[forge]', quiet = false } = {}) {
  const lines = [];
  const write = (level, msg) => {
    const line = `${prefix} ${redact(msg)}`;
    lines.push(line);
    if (quiet) return;
    const fn = level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.log;
    fn.call(sink, line);
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    lines,
  };
}

/* ------------------------------------------------------------ runtime */
export const iso = (ms) => new Date(ms).toISOString();

export const realSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Exponential backoff with jitter: attempt 1 → ~1 s, 2 → ~2 s, 3 → ~4 s … capped.
export function backoffMs(attempt, { base = 1000, cap = 20000 } = {}) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

// Retry-After header → milliseconds (delta-seconds or HTTP date). Defaults when absent.
export function retryAfterMs(value, fallbackMs = 5000, nowMs = Date.now()) {
  if (value == null || value === '') return fallbackMs;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : fallbackMs;
}

// fetch with a per-request timeout (the workflow has a hard 10-minute limit).
export function withTimeout(fetchImpl, ms) {
  return (url, init = {}) => fetchImpl(url, init.signal ? init : { ...init, signal: AbortSignal.timeout(ms) });
}

// Short, safe error code from an OAuth-style error body ({ error: 'invalid_grant' }).
export function oauthCode(data) {
  const c = data && typeof data === 'object' ? data.error : null;
  return typeof c === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(c) ? c : '';
}
