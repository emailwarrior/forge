// FORGE AI layer: Claude Messages API client. Browser (Safari 16.4+) and Node 20+ (global fetch).
// - Streams by default (SSE) so long thinking / web-search requests never sit on an idle connection;
//   the assembled result is identical to a non-streaming response. `ai.stream = false` disables it.
// - Handles stop_reason 'pause_turn' by resending with the assistant content appended unchanged.
// - Retries 408/409/429/5xx/529 with backoff (honoring retry-after), network errors once.
// - Never sends temperature / top_p / top_k (Sonnet 5 and Opus 5.5 reject non-default values).
// - Forced tool_choice only with thinking disabled; downgraded to 'auto' on models that reject it.
import { AIError, errorFromResponse, errorFromApiError } from './errors.js';
import { costOf, addUsage, roundUsd } from './pricing.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_FAST_MODEL = 'claude-haiku-4-5-20251001';
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_PAUSE_CONTINUATIONS = 4;
const MAX_OUTPUT_TOKENS = 128000;
const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const DEFAULTS = { maxRetries: 3, retryBaseMs: 1000, maxRetryWaitMs: 60000, timeoutMs: 300000 };

/* ------------------------------------------------------------ environment */

/** True in a browser page or worker (adds the direct-browser-access header). */
export function isBrowser() {
  return (typeof window !== 'undefined' && typeof document !== 'undefined') || typeof WorkerGlobalScope !== 'undefined';
}

/**
 * What a model accepts. Unknown models are treated like the current generation.
 * - effort: output_config.effort accepted (not on Haiku / legacy models)
 * - forcedToolChoice: tool_choice any/tool accepted (never on Opus 5.x)
 * - thinkingByDefault: adaptive thinking is on unless disabled
 */
export function modelCaps(model) {
  const m = String(model || '').toLowerCase();
  return {
    effort: !/haiku|claude-3|claude-2|claude-instant/.test(m),
    forcedToolChoice: !/opus-5/.test(m),
    thinkingByDefault: /sonnet-5|opus-5/.test(m),
  };
}

export function buildHeaders(ai) {
  const h = {
    'x-api-key': String(ai && ai.apiKey != null ? ai.apiKey : '').trim(),
    'anthropic-version': API_VERSION,
    'content-type': 'application/json',
  };
  if (isBrowser()) h['anthropic-dangerous-direct-browser-access'] = 'true';
  return h;
}

/* ---------------------------------------------------------- request body */

const clampTokens = (v, def) => (typeof v === 'number' && isFinite(v) && v >= 1 ? Math.min(MAX_OUTPUT_TOKENS, Math.floor(v)) : def);

function normThinking(t) {
  if (t === false) return { type: 'disabled' };
  if (t && typeof t === 'object' && typeof t.type === 'string') return { ...t };
  return null; // model default (adaptive on Sonnet 5 / Opus 5.5, off on Haiku)
}
function normEffort(e) {
  if (typeof e !== 'string') return null;
  const v = e.trim().toLowerCase();
  return EFFORTS.includes(v) ? v : null;
}
function normFormat(f) {
  if (!f || typeof f !== 'object') return null;
  if (f.schema && typeof f.schema === 'object') return { type: 'json_schema', schema: f.schema };
  if (f.type === 'object' && f.properties) return { type: 'json_schema', schema: f }; // a bare JSON schema
  return null;
}

/**
 * Build the Messages API body. Sampling parameters are never read from opts, so they can never be sent.
 * Forced tool_choice ({type:'any'|'tool'}) sets thinking {type:'disabled'}; on models that reject forced
 * tool use it is downgraded to {type:'auto'} and thinking is left alone.
 */
export function buildRequest(ai = {}, opts = {}) {
  const model = opts.model || (ai && ai.model) || DEFAULT_MODEL;
  const caps = modelCaps(model);
  const body = { model, max_tokens: clampTokens(opts.maxTokens, 2048) };
  const sys = opts.system;
  if (sys && (typeof sys === 'string' ? sys.trim() : Array.isArray(sys) && sys.length)) body.system = sys;
  body.messages = Array.isArray(opts.messages) ? opts.messages : [];
  const tools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;
  if (tools) body.tools = tools;

  let thinking = normThinking(opts.thinking);
  let choice = tools && opts.toolChoice && typeof opts.toolChoice === 'object' ? { ...opts.toolChoice } : null;
  if (choice && (choice.type === 'any' || choice.type === 'tool')) {
    if (caps.forcedToolChoice) thinking = { type: 'disabled' };
    else {
      const auto = { type: 'auto' };
      if (choice.disable_parallel_tool_use != null) auto.disable_parallel_tool_use = choice.disable_parallel_tool_use;
      choice = auto;
    }
  }
  if (choice) body.tool_choice = choice;
  if (thinking) body.thinking = thinking;

  const output = {};
  const effort = normEffort(opts.effort !== undefined ? opts.effort : ai && ai.effort);
  if (effort && caps.effort) output.effort = effort;
  const format = normFormat(opts.outputFormat);
  if (format) output.format = format;
  if (Object.keys(output).length) body.output_config = output;

  const stream = opts.stream !== undefined ? opts.stream : ai && ai.stream !== undefined ? ai.stream : true;
  if (stream) body.stream = true;
  return body;
}

/* ------------------------------------------------------------- callClaude */

/**
 * callClaude(ai, { system, messages, tools, toolChoice, outputFormat, maxTokens=2048, model, thinking,
 *                  effort, signal, stream, onProgress })
 *   → { content, stopReason, usage, costUsd, costEstimated, model, requestId }
 * `content` is every assistant block across pause_turn continuations, in order.
 * Throws AIError; stop_reason 'refusal' throws AIError('refused').
 */
export async function callClaude(ai, opts = {}) {
  if (!ai || typeof ai.apiKey !== 'string' || !ai.apiKey.trim()) throw new AIError('no-key');
  if (!Array.isArray(opts.messages) || !opts.messages.length) throw new AIError('bad-request', 'callClaude: messages are required.');
  const base = buildRequest(ai, opts);
  const content = [];
  let usage = null, costUsd = 0, costEstimated = false, stopReason = null, model = base.model, requestId = null;
  let messages = opts.messages;
  for (let turn = 0; ; turn++) {
    const { message, requestId: rid } = await send(ai, { ...base, messages }, opts);
    const blocks = Array.isArray(message.content) ? message.content : [];
    content.push(...blocks);
    usage = addUsage(usage, message.usage || null);
    const c = costOf(message.model || base.model, message.usage);
    costUsd += c.usd;
    costEstimated = costEstimated || c.estimate;
    stopReason = message.stop_reason || null;
    if (message.model) model = message.model;
    if (rid) requestId = rid;
    if (stopReason === 'pause_turn' && turn < MAX_PAUSE_CONTINUATIONS) {
      messages = continuation(opts.messages, content);
      emit(opts.onProgress, { phase: 'continuing', turn: turn + 1 });
      continue;
    }
    break;
  }
  if (stopReason === 'refusal') throw new AIError('refused', 'Claude declined to answer this request.', { requestId });
  return { content, stopReason, usage: usage || {}, costUsd: roundUsd(costUsd), costEstimated, model, requestId };
}

// Original conversation + one assistant turn holding everything produced so far (unchanged).
function continuation(original, content) {
  const last = original[original.length - 1];
  if (last && last.role === 'assistant') {
    const prior = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content || [];
    return [...original.slice(0, -1), { role: 'assistant', content: [...prior, ...content] }];
  }
  return [...original, { role: 'assistant', content: content.slice() }];
}

/* ------------------------------------------------------------- transport */

function retryConfig(ai) {
  const pick = (k) => (typeof ai[k] === 'number' && isFinite(ai[k]) && ai[k] >= 0 ? ai[k] : DEFAULTS[k]);
  return { maxRetries: pick('maxRetries'), retryBaseMs: pick('retryBaseMs'), maxRetryWaitMs: pick('maxRetryWaitMs'), timeoutMs: pick('timeoutMs') };
}

async function send(ai, body, opts) {
  const fetchFn = typeof ai.fetchImpl === 'function' ? ai.fetchImpl : typeof fetch === 'function' ? fetch : null;
  if (!fetchFn) throw new AIError('network', 'fetch is not available in this environment.');
  const cfg = retryConfig(ai);
  const signal = opts.signal || null;
  let payload = body;
  let json = JSON.stringify(payload);
  if (json.length > MAX_REQUEST_BYTES) {
    throw new AIError('bad-request', 'Request is larger than 32 MB. Use fewer or smaller files.', { status: 413 });
  }
  let networkRetries = 0;
  let effortDropped = false;
  const maxNetworkRetries = Math.min(1, cfg.maxRetries);

  for (let attempt = 0; ; attempt++) {
    if (signal && signal.aborted) throw abortedError(signal);
    const link = linkSignal(signal, cfg.timeoutMs);
    let res;
    try {
      res = await fetchFn(API_URL, { method: 'POST', headers: buildHeaders(ai), body: json, signal: link.signal });
    } catch (e) {
      link.done();
      if (signal && signal.aborted) throw abortedError(signal, e);
      if (link.timedOut) throw timeoutError(cfg.timeoutMs, e);
      if (networkRetries < maxNetworkRetries) { networkRetries++; await sleep(backoff(attempt, cfg.retryBaseMs), signal); continue; }
      throw new AIError('network', 'Could not reach the Claude API. Check your connection.', { cause: e });
    }
    const requestId = header(res, 'request-id');

    if (res.ok) {
      let message = null, failure = null;
      try {
        message = payload.stream && isEventStream(res) ? await readEventStream(res, opts.onProgress) : await readJson(res);
      } catch (e) {
        failure = e;
      } finally {
        link.done();
      }
      if (!failure) return { message, requestId };
      if (signal && signal.aborted) throw abortedError(signal, failure);
      if (link.timedOut) throw timeoutError(cfg.timeoutMs, failure);
      if (failure instanceof AIError) {
        if (failure.retryable && attempt < cfg.maxRetries) { await sleep(backoff(attempt, cfg.retryBaseMs), signal); continue; }
        if (!failure.requestId && requestId) failure.requestId = requestId;
        throw failure;
      }
      if (networkRetries < maxNetworkRetries) { networkRetries++; await sleep(backoff(attempt, cfg.retryBaseMs), signal); continue; }
      throw new AIError('network', 'The connection to Claude was interrupted. Try again.', { cause: failure, requestId });
    }

    link.done();
    const errBody = await readErrorBody(res);
    const retryAfter = parseRetryAfter(res);
    // A model that does not take `effort` answers 400 mentioning it: drop it once and resend.
    if (res.status === 400 && !effortDropped && payload.output_config && payload.output_config.effort && /effort/i.test(errText(errBody))) {
      effortDropped = true;
      payload = withoutEffort(payload);
      json = JSON.stringify(payload);
      attempt--;
      continue;
    }
    const should = header(res, 'x-should-retry');
    const retryable = should === 'true' || (should !== 'false' && (RETRY_STATUSES.has(res.status) || res.status >= 500));
    if (retryable && attempt < cfg.maxRetries) {
      const wait = retryAfter != null ? retryAfter * 1000 : backoff(attempt, cfg.retryBaseMs);
      if (wait <= cfg.maxRetryWaitMs) { await sleep(wait, signal); continue; }
    }
    throw errorFromResponse(res.status, errBody, { retryAfter, requestId });
  }
}

function withoutEffort(payload) {
  const out = { ...payload, output_config: { ...payload.output_config } };
  delete out.output_config.effort;
  if (!Object.keys(out.output_config).length) delete out.output_config;
  return out;
}
const errText = (b) => (b && typeof b === 'object' && b.error ? String(b.error.message || '') : typeof b === 'string' ? b : '');

function header(res, name) {
  try { return res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null; } catch { return null; }
}
const isEventStream = (res) => /text\/event-stream/i.test(header(res, 'content-type') || '');

/** retry-after-ms / retry-after (seconds or HTTP date) → seconds, or null. */
export function parseRetryAfter(res) {
  const ms = header(res, 'retry-after-ms');
  if (ms != null && ms !== '' && isFinite(Number(ms))) return Math.max(0, Number(ms) / 1000);
  const ra = header(res, 'retry-after');
  if (ra == null || ra === '') return null;
  if (/^\s*\d+(\.\d+)?\s*$/.test(ra)) return Math.max(0, parseFloat(ra));
  const t = Date.parse(ra);
  return isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : null;
}

const backoff = (attempt, baseMs) => Math.min(baseMs * 2 ** attempt, 20000) * (0.8 + Math.random() * 0.4);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortedError(signal)); return; }
    let timer = null;
    const onAbort = () => { clearTimeout(timer); reject(abortedError(signal)); };
    timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Combines the caller's AbortSignal with a timeout (AbortSignal.any is unavailable on Safari 16.4).
function linkSignal(outer, timeoutMs) {
  const ctl = new AbortController();
  let timedOut = false;
  let timer = null;
  const onAbort = () => { try { ctl.abort(outer.reason); } catch { ctl.abort(); } };
  if (outer) { if (outer.aborted) onAbort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  if (timeoutMs > 0 && isFinite(timeoutMs)) timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  return {
    signal: ctl.signal,
    get timedOut() { return timedOut; },
    done() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (outer) outer.removeEventListener('abort', onAbort);
    },
  };
}

const abortedError = (signal, cause) => new AIError('aborted', 'Cancelled.', { cause: cause !== undefined ? cause : signal && signal.reason });
const timeoutError = (ms, cause) => new AIError('network', `No complete response from Claude after ${Math.round(ms / 1000)} s. Try again.`, { cause });

async function readJson(res) {
  const text = await res.text(); // a failure here is a network error (handled by the caller)
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.content)) throw new AIError('parse', 'Claude returned an unreadable response.');
  return data;
}

async function readErrorBody(res) {
  try {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch { return null; }
}

/* ------------------------------------------------------------- streaming */

async function readEventStream(res, onProgress) {
  const asm = new StreamAssembler(onProgress);
  const decoder = new TextDecoder();
  let buf = '';
  const feed = (chunk) => {
    buf += chunk;
    if (buf.indexOf('\r') >= 0) buf = buf.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      asm.rawEvent(raw);
    }
  };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    let finished = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { finished = true; break; }
        feed(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
        if (asm.stopped) break;
      }
    } finally {
      if (!finished) { try { reader.cancel().catch(() => {}); } catch { /* ignore */ } }
    }
  } else {
    feed(await res.text());
  }
  feed(decoder.decode() + '\n\n');
  return asm.finish();
}

class StreamAssembler {
  constructor(onProgress) {
    this.onProgress = onProgress;
    this.msg = null;
    this.blocks = [];
    this.partial = [];
    this.stopped = false;
  }
  rawEvent(raw) {
    let data = '', has = false;
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) { data += (has ? '\n' : '') + line.slice(line.startsWith('data: ') ? 6 : 5); has = true; }
    }
    if (!has || !data.trim()) return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev && typeof ev === 'object') this.event(ev);
  }
  event(ev) {
    switch (ev.type) {
      case 'message_start':
        this.msg = { ...(ev.message || {}), content: [] };
        this.blocks = []; this.partial = [];
        break;
      case 'content_block_start': {
        const b = ev.content_block ? JSON.parse(JSON.stringify(ev.content_block)) : null;
        if (!b) break;
        this.blocks[ev.index] = b;
        this.partial[ev.index] = '';
        if (b.type === 'thinking' || b.type === 'redacted_thinking') emit(this.onProgress, { phase: 'thinking' });
        else if (b.type === 'server_tool_use') emit(this.onProgress, { phase: 'searching' });
        else if (b.type === 'web_search_tool_result') emit(this.onProgress, { phase: 'searched' });
        else if (b.type === 'tool_use') emit(this.onProgress, { phase: 'tool', name: b.name });
        else if (b.type === 'text') emit(this.onProgress, { phase: 'writing' });
        break;
      }
      case 'content_block_delta': {
        const b = this.blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') b.text = (b.text || '') + (d.text || '');
        else if (d.type === 'input_json_delta') this.partial[ev.index] += d.partial_json || '';
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
        else if (d.type === 'signature_delta') b.signature = (b.signature || '') + (d.signature || '');
        else if (d.type === 'citations_delta') { if (!Array.isArray(b.citations)) b.citations = []; if (d.citation) b.citations.push(d.citation); }
        break;
      }
      case 'content_block_stop': {
        const b = this.blocks[ev.index];
        const pj = this.partial[ev.index];
        if (b && pj) {
          try { b.input = JSON.parse(pj); } catch { b.input = {}; } // truncated (max_tokens) → unusable input
        }
        if (b && b.type === 'server_tool_use' && b.input && b.input.query) emit(this.onProgress, { phase: 'searching', query: String(b.input.query) });
        break;
      }
      case 'message_delta': {
        if (!this.msg) this.msg = { content: [] };
        const d = ev.delta || {};
        if ('stop_reason' in d) this.msg.stop_reason = d.stop_reason;
        if ('stop_sequence' in d) this.msg.stop_sequence = d.stop_sequence;
        if (ev.usage && typeof ev.usage === 'object') {
          // message_delta usage is cumulative: later non-null values replace earlier ones.
          const u = { ...(this.msg.usage || {}) };
          for (const [k, v] of Object.entries(ev.usage)) if (v != null) u[k] = v;
          this.msg.usage = u;
        }
        break;
      }
      case 'message_stop':
        this.stopped = true;
        break;
      case 'error':
        throw errorFromApiError(ev.error);
      default:
        break; // ping and unknown events
    }
  }
  finish() {
    if (!this.msg) throw new Error('Claude stream ended before message_start');
    if (!this.stopped && this.msg.stop_reason == null) throw new Error('Claude stream ended early');
    return { ...this.msg, content: this.blocks.filter(Boolean) };
  }
}

function emit(fn, ev) {
  if (typeof fn !== 'function') return;
  try { fn(ev); } catch { /* UI callbacks never break a request */ }
}

/* -------------------------------------------------------- content helpers */

/** Concatenated text of all text blocks (citation fragments join seamlessly). */
export function textOf(content) {
  let s = '';
  for (const b of content || []) if (b && b.type === 'text' && typeof b.text === 'string') s += b.text;
  return s;
}

/** Last client tool_use block (optionally with the given name), or null. */
export function findToolUse(content, name) {
  let found = null;
  for (const b of content || []) if (b && b.type === 'tool_use' && (!name || b.name === name)) found = b;
  return found;
}

/** Parse a JSON object out of model text (plain, fenced, or embedded). Throws AIError('parse'). */
export function parseJsonText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) throw new AIError('parse', 'Claude returned an empty response.');
  const tries = [s];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) tries.push(fenced[1].trim());
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try { return JSON.parse(t); } catch { /* next */ }
  }
  throw new AIError('parse', "Could not parse Claude's response as JSON.");
}

/** callClaude + structured-output parse. → { data, res } */
export async function callClaudeJson(ai, opts) {
  const res = await callClaude(ai, opts);
  if (res.stopReason === 'max_tokens' || res.stopReason === 'model_context_window_exceeded') {
    throw new AIError('parse', "Claude's response was cut off before it finished. Try again with less input.", { requestId: res.requestId });
  }
  const data = parseJsonText(textOf(res.content));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AIError('parse', 'Claude returned JSON of the wrong shape.');
  return { data, res };
}

/**
 * Cheap key check for Settings: a 1-token request to the fast model.
 * → { ok: true, model, latencyMs, costUsd }; throws AIError ('auth' for a bad key).
 */
export async function verifyKey(ai, { model, signal } = {}) {
  const t0 = Date.now();
  const res = await callClaude({ ...ai, maxRetries: 1 }, {
    model: model || (ai && ai.fastModel) || DEFAULT_FAST_MODEL,
    maxTokens: 1, thinking: false, effort: null, stream: false, signal,
    messages: [{ role: 'user', content: 'ping' }],
  });
  return { ok: true, model: res.model, latencyMs: Date.now() - t0, costUsd: res.costUsd };
}
