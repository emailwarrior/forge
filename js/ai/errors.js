// FORGE AI layer: errors. Every failure raised by js/ai/* is an AIError with a stable `code`
// the UI can switch on (docs/AI_API.md). Browser and Node safe.

export const AI_ERROR_CODES = Object.freeze([
  'no-key', 'auth', 'rate-limit', 'overloaded', 'bad-request', 'network', 'parse', 'refused', 'aborted',
]);

const DEFAULT_MESSAGES = {
  'no-key': 'No Anthropic API key. Add one in Settings → AI.',
  auth: 'The Anthropic API key was rejected. Check it in Settings → AI.',
  'rate-limit': 'Claude API rate limit reached. Try again shortly.',
  overloaded: 'Claude is temporarily unavailable. Try again shortly.',
  'bad-request': 'The Claude API rejected the request.',
  network: 'Could not reach the Claude API. Check your connection.',
  parse: "Could not read Claude's response.",
  refused: 'Claude declined this request.',
  aborted: 'Cancelled.',
};

export class AIError extends Error {
  /**
   * @param {string} code one of AI_ERROR_CODES (unknown codes become 'bad-request')
   * @param {string} [message]
   * @param {{retryAfter?:number, status?:number, type?:string, requestId?:string, cause?:any}} [extra]
   */
  constructor(code, message, extra = {}) {
    const c = AI_ERROR_CODES.includes(code) ? code : 'bad-request';
    super(message || DEFAULT_MESSAGES[c]);
    this.name = 'AIError';
    this.code = c;
    if (extra.retryAfter != null && isFinite(extra.retryAfter)) this.retryAfter = extra.retryAfter; // seconds
    if (extra.status != null) this.status = extra.status;
    if (extra.type) this.type = extra.type; // Anthropic error type, e.g. 'overloaded_error'
    if (extra.requestId) this.requestId = extra.requestId;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
  /** True when retrying later may succeed. */
  get retryable() { return this.code === 'rate-limit' || this.code === 'overloaded' || this.code === 'network'; }
  toJSON() {
    const o = { name: this.name, code: this.code, message: this.message };
    for (const k of ['retryAfter', 'status', 'type', 'requestId']) if (this[k] != null) o[k] = this[k];
    return o;
  }
}

export const isAIError = (e) => !!e && e.name === 'AIError' && typeof e.code === 'string';

/** HTTP status → AIError code. */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 408) return 'network';
  if (status === 529 || status >= 500) return 'overloaded';
  return 'bad-request';
}

const TYPE_TO_CODE = {
  authentication_error: 'auth',
  permission_error: 'auth',
  rate_limit_error: 'rate-limit',
  overloaded_error: 'overloaded',
  api_error: 'overloaded',
  timeout_error: 'network',
  invalid_request_error: 'bad-request',
  request_too_large: 'bad-request',
  not_found_error: 'bad-request',
  billing_error: 'bad-request',
};
/** Anthropic error `type` (used for errors delivered inside a stream) → AIError code. */
export function codeForErrorType(type) { return TYPE_TO_CODE[type] || 'bad-request'; }

const withDetail = (head, detail) => (detail ? `${head}: ${detail}` : head + '.');

/** Build an AIError from a non-2xx HTTP response. `body` is the parsed JSON (or raw text). */
export function errorFromResponse(status, body, { retryAfter = null, requestId = null } = {}) {
  const apiErr = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const type = apiErr && typeof apiErr.type === 'string' ? apiErr.type : null;
  const detail = String((apiErr && apiErr.message) || (typeof body === 'string' ? body : '') || '').trim().slice(0, 400);
  const code = codeForStatus(status);
  let message;
  if (code === 'auth') {
    message = status === 403
      ? withDetail('This API key is not allowed to make this request (403)', detail)
      : 'The Anthropic API key was rejected (401). Check it in Settings → AI.';
  } else if (code === 'rate-limit') {
    message = retryAfter != null ? `Claude API rate limit reached. Try again in ${Math.max(1, Math.ceil(retryAfter))} s.` : 'Claude API rate limit reached. Try again shortly.';
  } else if (code === 'overloaded') {
    message = status === 529 ? 'Claude is overloaded right now (529). Try again in a minute.' : `Claude API error (${status}). Try again shortly.`;
  } else if (code === 'network') {
    message = 'The Claude API timed out (408). Try again.';
  } else if (status === 413) {
    message = 'Request too large for the Claude API (max 32 MB). Use fewer or smaller files.';
  } else if (status === 404) {
    message = withDetail('Not found (404) — check the model name in Settings → AI', detail);
  } else {
    message = withDetail(`Claude API rejected the request (${status})`, detail);
  }
  return new AIError(code, message, { status, type, retryAfter, requestId });
}

/** Build an AIError from an `error` event received mid-stream ({type, message}). */
export function errorFromApiError(err, { requestId = null } = {}) {
  const type = err && typeof err.type === 'string' ? err.type : null;
  const code = codeForErrorType(type);
  const detail = String((err && err.message) || '').trim().slice(0, 400);
  const message = code === 'overloaded' ? 'Claude is temporarily unavailable. Try again shortly.' : withDetail('Claude API error', detail);
  return new AIError(code, message, { type, requestId });
}
