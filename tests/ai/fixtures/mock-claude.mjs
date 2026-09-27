// Test helpers: a scripted fetch that answers like the Claude Messages API (JSON or SSE stream,
// depending on the request's `stream` flag) and checks invariants on every request.
import assert from 'node:assert/strict';

export const KEY = 'sk-ant-test-0000';
export const API = 'https://api.anthropic.com/v1/messages';

export function aiConfig(extra = {}) {
  return {
    apiKey: KEY, model: 'claude-sonnet-5', fastModel: 'claude-haiku-4-5-20251001', effort: 'medium', webLookup: true,
    retryBaseMs: 1, ...extra,
  };
}

let seq = 0;
const nextId = (p) => `${p}_${(++seq).toString(36).padStart(4, '0')}`;

export function message(content, { stop_reason = 'end_turn', model = 'claude-sonnet-5', usage = {} } = {}) {
  return {
    id: nextId('msg'), type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  };
}
export const text = (t, citations) => (citations ? { type: 'text', text: t, citations } : { type: 'text', text: t });
export const thinking = (t) => ({ type: 'thinking', thinking: t, signature: 'EqQBCkgIBxABGAIiQL' });
export const toolUse = (name, input, id = nextId('toolu')) => ({ type: 'tool_use', id, name, input });
export const serverSearch = (query, id = nextId('srvtoolu')) => ({ type: 'server_tool_use', id, name: 'web_search', input: { query } });
export const searchResult = (toolUseId, results) => ({
  type: 'web_search_tool_result', tool_use_id: toolUseId,
  content: results.map((r) => ({ type: 'web_search_result', url: r.url, title: r.title, encrypted_content: 'Eo8BCioIAhgB', page_age: null })),
});
export const citation = (url, title, cited) => ({ type: 'web_search_result_location', url, title, cited_text: cited, encrypted_index: 'EpABCioIAxgC' });

/* ----------------------------------------------------------- responses */

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...headers } });
}
export function apiError(status, type, msg, headers = {}) {
  return jsonResponse({ type: 'error', error: { type, message: msg }, request_id: 'req_err' }, { status, headers });
}

/** Serialize a message as the SSE event sequence the API streams. */
export function sseText(msg, { errorAfterStart = null } = {}) {
  const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const u = msg.usage || {};
  let out = ev('message_start', {
    message: { ...msg, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: u.input_tokens, output_tokens: 1, cache_creation_input_tokens: u.cache_creation_input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0 } },
  });
  out += ev('ping');
  if (errorAfterStart) return out + ev('error', { error: errorAfterStart });
  msg.content.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      const half = Math.ceil(b.text.length / 2);
      for (const part of [b.text.slice(0, half), b.text.slice(half)]) if (part) out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
      for (const c of b.citations || []) out += ev('content_block_delta', { index, delta: { type: 'citations_delta', citation: c } });
    } else if (b.type === 'thinking') {
      out += ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      out += ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      out += ev('content_block_start', { index, content_block: { ...b, input: {} } });
      const js = JSON.stringify(b.input);
      const k = Math.ceil(js.length / 3);
      for (let i = 0; i < js.length; i += k) out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: js.slice(i, i + k) } });
    } else {
      out += ev('content_block_start', { index, content_block: b });
    }
    out += ev('content_block_stop', { index });
  });
  const deltaUsage = { output_tokens: u.output_tokens };
  if (u.server_tool_use) Object.assign(deltaUsage, { input_tokens: u.input_tokens, server_tool_use: u.server_tool_use });
  out += ev('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: deltaUsage });
  out += ev('message_stop');
  return out;
}

/** SSE response delivered in small byte chunks (exercises buffering across chunk and UTF-8 boundaries). */
export function sseResponse(msg, { chunkSize = 23, status = 200, headers = {}, errorAfterStart = null } = {}) {
  const bytes = new TextEncoder().encode(sseText(msg, { errorAfterStart }));
  let i = 0;
  const stream = new ReadableStream({
    pull(ctl) {
      if (i >= bytes.length) { ctl.close(); return; }
      ctl.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req_test', ...headers } });
}

/* --------------------------------------------------------------- fetch */

/**
 * Scripted fetch. Each step is a Response, a function (call, index) → step, or one of
 * { message } (answered as SSE when the request streams, else JSON), { throw: err }.
 * Every request is checked: URL, method, headers, and that no sampling parameter is ever sent.
 */
export function mockFetch(steps = []) {
  const queue = [...steps];
  const calls = [];
  const violations = [];
  const check = (cond, msg) => { if (!cond) violations.push(msg); };
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = init.headers || {};
    const call = { url, init, body, headers, signal: init.signal };
    calls.push(call);
    check(url === API, 'bad url ' + url);
    check(init.method === 'POST', 'method must be POST');
    check(headers['x-api-key'] === KEY, 'x-api-key missing');
    check(headers['anthropic-version'] === '2023-06-01', 'anthropic-version missing');
    check(headers['content-type'] === 'application/json', 'content-type missing');
    for (const k of ['temperature', 'top_p', 'top_k']) check(!(body && k in body), `${k} must never be sent`);
    const step = queue.shift();
    if (step === undefined) { violations.push(`unexpected request #${calls.length}`); return apiError(500, 'api_error', 'no scripted response'); }
    const out = typeof step === 'function' ? await step(call, calls.length - 1) : step;
    if (out instanceof Response) return out;
    if (out && out.throw) throw out.throw;
    if (out && out.message) return body && body.stream ? sseResponse(out.message, out) : jsonResponse(out.message, out);
    return out;
  };
  fn.calls = calls;
  fn.violations = violations;
  /** Assert no invariant was violated and every scripted step was used. */
  fn.done = () => {
    assert.deepEqual(violations, [], 'request invariants');
    assert.equal(queue.length, 0, 'unused scripted responses');
  };
  return fn;
}

/** Run `fn(stream)` once with streaming and once with JSON responses. */
export async function bothModes(fn) {
  for (const stream of [true, false]) await fn(stream);
}

/** A fetch that never answers until its signal aborts. */
export function hangingFetch() {
  const calls = [];
  const fn = (url, init = {}) => {
    calls.push({ url, init });
    return new Promise((_, reject) => {
      const s = init.signal;
      const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (s) { if (s.aborted) fail(); else s.addEventListener('abort', fail, { once: true }); }
    });
  };
  fn.calls = calls;
  return fn;
}
