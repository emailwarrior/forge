import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callClaude, callClaudeJson, buildRequest, verifyKey, textOf, findToolUse, parseJsonText, isBrowser } from '../../js/ai/claude.js';
import { AIError } from '../../js/ai/errors.js';
import {
  aiConfig, mockFetch, message, text, thinking, toolUse, serverSearch, searchResult, citation, apiError, jsonResponse,
  sseResponse, sseText, bothModes, hangingFetch,
} from './fixtures/mock-claude.mjs';

const USER = [{ role: 'user', content: 'hello' }];

test('headers: key, version, content-type; browser header only when window and document exist', async () => {
  const f = mockFetch([{ message: message([text('a')]) }, { message: message([text('b')]) }, { message: message([text('c')]) }]);
  const ai = aiConfig({ fetchImpl: f });
  assert.equal(isBrowser(), false);
  await callClaude(ai, { messages: USER });
  assert.equal('anthropic-dangerous-direct-browser-access' in f.calls[0].headers, false);

  globalThis.window = {};
  globalThis.document = {};
  try {
    assert.equal(isBrowser(), true);
    await callClaude(ai, { messages: USER });
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
  assert.equal(f.calls[1].headers['anthropic-dangerous-direct-browser-access'], 'true');

  await callClaude(ai, { messages: USER });
  assert.equal('anthropic-dangerous-direct-browser-access' in f.calls[2].headers, false);
  for (const c of f.calls) {
    assert.equal(c.headers['x-api-key'], ai.apiKey);
    assert.equal(c.headers['anthropic-version'], '2023-06-01');
    assert.equal(c.headers['content-type'], 'application/json');
  }
  f.done();
});

test('body: sampling params are never sent; effort, output format, max_tokens and stream map correctly', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  const f = mockFetch([{ message: message([text('{"a":"x"}')]) }, { message: message([text('ok')], { model: 'claude-haiku-4-5-20251001' }) }]);
  const ai = aiConfig({ fetchImpl: f });
  await callClaude(ai, {
    messages: USER, system: 'sys', temperature: 0.2, top_p: 0.9, top_k: 5, effort: 'HIGH', maxTokens: 999,
    outputFormat: { type: 'json_schema', schema },
  });
  const b = f.calls[0].body;
  assert.equal(b.model, 'claude-sonnet-5');
  assert.equal(b.max_tokens, 999);
  assert.equal(b.system, 'sys');
  assert.equal(b.stream, true);
  assert.deepEqual(b.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tools', 'tool_choice']) assert.equal(k in b, false, k);

  // Haiku: effort is not sent (unsupported); default max_tokens 2048
  await callClaude(ai, { messages: USER, model: 'claude-haiku-4-5-20251001' });
  const h = f.calls[1].body;
  assert.equal(h.max_tokens, 2048);
  assert.equal('output_config' in h, false);
  f.done();
});

test('buildRequest: forced tool_choice disables thinking; Opus 5.5 downgrades forced tool use to auto', () => {
  const tools = [{ name: 'x', input_schema: { type: 'object', properties: {}, additionalProperties: false } }];
  const ai = aiConfig();
  const s = buildRequest(ai, { messages: USER, tools, toolChoice: { type: 'tool', name: 'x' } });
  assert.deepEqual(s.tool_choice, { type: 'tool', name: 'x' });
  assert.deepEqual(s.thinking, { type: 'disabled' });
  const any = buildRequest(ai, { messages: USER, tools, toolChoice: { type: 'any' }, thinking: { type: 'adaptive' } });
  assert.deepEqual(any.thinking, { type: 'disabled' });
  const o = buildRequest(ai, { messages: USER, tools, toolChoice: { type: 'tool', name: 'x' }, model: 'claude-opus-5-5' });
  assert.deepEqual(o.tool_choice, { type: 'auto' });
  assert.equal('thinking' in o, false);
  const auto = buildRequest(ai, { messages: USER, tools, toolChoice: { type: 'auto' } });
  assert.deepEqual(auto.tool_choice, { type: 'auto' });
  assert.equal('thinking' in auto, false); // adaptive default left alone
  assert.deepEqual(buildRequest(ai, { messages: USER, thinking: false }).thinking, { type: 'disabled' });
  assert.equal('tool_choice' in buildRequest(ai, { messages: USER, toolChoice: { type: 'auto' } }), false); // no tools → no tool_choice
  assert.equal('stream' in buildRequest({ ...ai, stream: false }, { messages: USER }), false);
  assert.equal('effort' in (buildRequest(ai, { messages: USER, effort: 'bogus' }).output_config || {}), false);
});

test('streaming and JSON responses assemble identical content, usage and cost', async () => {
  const content = [
    thinking('Let me look at this.'),
    serverSearch('chipotle chicken nutrition', 'srvtoolu_1'),
    searchResult('srvtoolu_1', [{ url: 'https://www.chipotle.com/nutrition-calculator', title: 'Nutrition Calculator' }]),
    text('Chicken (4 oz) is 180 kcal — per the calculator ≈ official.', [citation('https://www.chipotle.com/nutrition-calculator', 'Nutrition Calculator', 'Chicken 180')]),
    toolUse('record', { a: 1, nested: { b: [1, 2, 3] }, s: 'ünïcödé ≈ – ok' }, 'toolu_1'),
  ];
  const msg = message(content, { stop_reason: 'tool_use', usage: { input_tokens: 5000, output_tokens: 800, server_tool_use: { web_search_requests: 1 } } });
  const results = [];
  await bothModes(async (stream) => {
    const f = mockFetch([{ message: msg, chunkSize: 7 }]);
    results.push(await callClaude(aiConfig({ fetchImpl: f, stream }), { messages: USER }));
    assert.equal(f.calls[0].body.stream === true, stream);
    f.done();
  });
  const [s, j] = results;
  assert.deepEqual(s.content, content);
  assert.deepEqual(j.content, content);
  assert.equal(s.stopReason, 'tool_use');
  assert.equal(s.usage.output_tokens, 800);
  assert.equal(s.usage.server_tool_use.web_search_requests, 1);
  // 5000 × $2/M + 800 × $10/M + 1 search × $0.01
  assert.equal(s.costUsd, 0.028);
  assert.equal(j.costUsd, 0.028);
  assert.equal(s.model, 'claude-sonnet-5');
  assert.equal(s.requestId, 'req_test');
  assert.equal(textOf(s.content), content[3].text);
  assert.equal(findToolUse(s.content, 'record').input.nested.b[2], 3);
});

test('SSE parser: CRLF line endings split across 1-byte chunks; onProgress phases', async () => {
  const content = [
    thinking('hmm'),
    serverSearch('fairlife core power nutrition', 'srv_2'),
    searchResult('srv_2', [{ url: 'https://fairlife.com/core-power', title: 'Core Power' }]),
    text('Found it — 26 g protein.'),
    toolUse('record', { ok: true }, 'toolu_2'),
  ];
  const msg = message(content, { stop_reason: 'tool_use' });
  const crlf = new TextEncoder().encode(sseText(msg).replace(/\n/g, '\r\n'));
  let i = 0;
  const body = new ReadableStream({ pull(ctl) { if (i >= crlf.length) ctl.close(); else ctl.enqueue(crlf.slice(i, ++i)); } });
  const f = mockFetch([new Response(body, { headers: { 'content-type': 'text/event-stream' } })]);
  const phases = [];
  const res = await callClaude(aiConfig({ fetchImpl: f }), {
    messages: USER,
    onProgress: (e) => { phases.push(e.query ? `${e.phase}:${e.query}` : e.name ? `${e.phase}:${e.name}` : e.phase); if (e.phase === 'writing') throw new Error('UI bug'); },
  });
  assert.deepEqual(res.content, content);
  assert.deepEqual(phases, ['thinking', 'searching', 'searching:fairlife core power nutrition', 'searched', 'writing', 'tool:record']);
  f.done();
});

test('pause_turn: resends the conversation with the assistant content appended unchanged', async () => {
  await bothModes(async (stream) => {
    const paused = [serverSearch('big mac nutrition', 'srv_1'), searchResult('srv_1', [{ url: 'https://www.mcdonalds.com/us/en-us/product/big-mac.html', title: 'Big Mac' }])];
    const f = mockFetch([
      { message: message(paused, { stop_reason: 'pause_turn', usage: { input_tokens: 2000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } } }) },
      { message: message([text('Big Mac: 590 kcal.')], { usage: { input_tokens: 3000, output_tokens: 200 } }) },
    ]);
    const res = await callClaude(aiConfig({ fetchImpl: f, stream }), { messages: USER, system: 's' });
    assert.equal(f.calls.length, 2);
    const second = f.calls[1].body;
    assert.equal(second.messages.length, 2);
    assert.deepEqual(second.messages[0], USER[0]);
    assert.deepEqual(second.messages[1], { role: 'assistant', content: paused });
    assert.equal(second.system, 's');
    assert.equal(res.stopReason, 'end_turn');
    assert.deepEqual(res.content, [...paused, text('Big Mac: 590 kcal.')]);
    assert.equal(res.usage.input_tokens, 5000);
    assert.equal(res.usage.output_tokens, 300);
    // (2000×2 + 100×10)/1e6 + 0.01 + (3000×2 + 200×10)/1e6
    assert.equal(res.costUsd, 0.023);
    f.done();
  });
});

test('pause_turn continuation is capped', async () => {
  const steps = [];
  for (let i = 0; i < 5; i++) steps.push({ message: message([text('…' + i)], { stop_reason: 'pause_turn' }) });
  const f = mockFetch(steps);
  const res = await callClaude(aiConfig({ fetchImpl: f }), { messages: USER });
  assert.equal(f.calls.length, 5); // 1 + 4 continuations
  assert.equal(res.stopReason, 'pause_turn');
  f.done();
});

test('429: honors retry-after, then succeeds', async () => {
  const f = mockFetch([
    apiError(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', { 'retry-after': '0.06' }),
    { message: message([text('ok')]) },
  ]);
  const t0 = Date.now();
  const res = await callClaude(aiConfig({ fetchImpl: f, retryBaseMs: 5000 }), { messages: USER });
  const waited = Date.now() - t0;
  assert.equal(res.content[0].text, 'ok');
  assert.equal(f.calls.length, 2);
  assert.ok(waited >= 50, `waited ${waited} ms`);
  assert.ok(waited < 2000, 'used retry-after, not the 5 s backoff');
  f.done();
});

test('429 with retry-after beyond the wait cap fails fast with retryAfter', async () => {
  const f = mockFetch([apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '120' })]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: f }), { messages: USER }), (e) => {
    assert.ok(e instanceof AIError);
    assert.equal(e.code, 'rate-limit');
    assert.equal(e.retryAfter, 120);
    assert.equal(e.status, 429);
    assert.match(e.message, /120 s/);
    return true;
  });
  assert.equal(f.calls.length, 1);
  f.done();
});

test('529 and 5xx: retried with backoff up to maxRetries, then AIError overloaded', async () => {
  const f = mockFetch([apiError(529, 'overloaded_error', 'Overloaded'), apiError(500, 'api_error', 'x'), apiError(529, 'overloaded_error', 'Overloaded'), apiError(529, 'overloaded_error', 'Overloaded')]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: f }), { messages: USER }), (e) => e.code === 'overloaded' && e.status === 529 && e.retryable);
  assert.equal(f.calls.length, 4);
  f.done();

  const g = mockFetch([apiError(503, 'api_error', 'x'), { message: message([text('fine')]) }]);
  assert.equal((await callClaude(aiConfig({ fetchImpl: g }), { messages: USER })).content[0].text, 'fine');
  g.done();

  const h = mockFetch([apiError(500, 'api_error', 'x', { 'x-should-retry': 'false' })]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: h }), { messages: USER }), (e) => e.code === 'overloaded');
  assert.equal(h.calls.length, 1);
  h.done();
});

test('401 → AIError auth (not retried); 403 → auth; 400/404/413 → bad-request', async () => {
  const f = mockFetch([apiError(401, 'authentication_error', 'invalid x-api-key')]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: f }), { messages: USER }), (e) => {
    assert.ok(e instanceof AIError);
    assert.equal(e.name, 'AIError');
    assert.equal(e.code, 'auth');
    assert.equal(e.status, 401);
    assert.equal(e.type, 'authentication_error');
    assert.equal(e.retryable, false);
    return true;
  });
  assert.equal(f.calls.length, 1);
  f.done();

  const cases = [
    [403, 'permission_error', 'auth'], [400, 'invalid_request_error', 'bad-request'], [404, 'not_found_error', 'bad-request'],
    [413, 'request_too_large', 'bad-request'],
  ];
  for (const [status, type, code] of cases) {
    const g = mockFetch([apiError(status, type, `detail ${status}`)]);
    await assert.rejects(callClaude(aiConfig({ fetchImpl: g }), { messages: USER }), (e) => e.code === code && e.status === status);
    g.done();
  }
  const h = mockFetch([apiError(400, 'invalid_request_error', 'messages: text content blocks must be non-empty')]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: h }), { messages: USER }), /text content blocks must be non-empty/);
  h.done();
});

test('a 400 about effort is retried once without output_config.effort', async () => {
  const f = mockFetch([apiError(400, 'invalid_request_error', 'output_config.effort: not supported for this model'), { message: message([text('ok')], { model: 'claude-future-1' }) }]);
  const res = await callClaude(aiConfig({ fetchImpl: f, model: 'claude-future-1' }), { messages: USER });
  assert.equal(res.content[0].text, 'ok');
  assert.equal(f.calls[0].body.output_config.effort, 'medium');
  assert.equal('output_config' in f.calls[1].body, false);
  assert.equal(res.costEstimated, true); // unknown model priced as Sonnet
  f.done();
});

test('an error event inside the stream is retried like a 529', async () => {
  const good = message([text('recovered')]);
  const f = mockFetch([
    sseResponse(good, { errorAfterStart: { type: 'overloaded_error', message: 'Overloaded' } }),
    { message: good },
  ]);
  const res = await callClaude(aiConfig({ fetchImpl: f }), { messages: USER });
  assert.equal(res.content[0].text, 'recovered');
  assert.equal(f.calls.length, 2);
  f.done();

  const g = mockFetch([sseResponse(good, { errorAfterStart: { type: 'invalid_request_error', message: 'bad' } })]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: g }), { messages: USER }), (e) => e.code === 'bad-request');
  g.done();
});

test('network failure is retried once, then AIError network', async () => {
  const boom = new TypeError('fetch failed');
  const f = mockFetch([{ throw: boom }, { message: message([text('ok')]) }]);
  assert.equal((await callClaude(aiConfig({ fetchImpl: f }), { messages: USER })).content[0].text, 'ok');
  f.done();
  const g = mockFetch([{ throw: boom }, { throw: boom }]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: g }), { messages: USER }), (e) => e.code === 'network' && e.cause === boom);
  g.done();
});

test('truncated stream (no message_stop) counts as a network interruption', async () => {
  const full = message([text('whole answer')]);
  const cut = new Response('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { ...full, content: [], stop_reason: null } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const f = mockFetch([cut, { message: full }]);
  const res = await callClaude(aiConfig({ fetchImpl: f }), { messages: USER });
  assert.equal(res.content[0].text, 'whole answer');
  f.done();
});

test('timeout → AIError network; caller abort → AIError aborted', async () => {
  const h = hangingFetch();
  await assert.rejects(callClaude(aiConfig({ fetchImpl: h, timeoutMs: 30 }), { messages: USER }), (e) => e.code === 'network' && /after 0 s|No complete response/.test(e.message));
  assert.equal(h.calls.length, 1); // timeouts are not retried

  const h2 = hangingFetch();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: h2 }), { messages: USER, signal: ctl.signal }), (e) => e.code === 'aborted');

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(callClaude(aiConfig({ fetchImpl: h2 }), { messages: USER, signal: pre.signal }), (e) => e.code === 'aborted');

  // abort during a retry wait
  const f = mockFetch([apiError(529, 'overloaded_error', 'x', { 'retry-after': '5' })]);
  const c2 = new AbortController();
  setTimeout(() => c2.abort(), 20);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: f }), { messages: USER, signal: c2.signal }), (e) => e.code === 'aborted');
  f.done();
});

test('refusal → AIError refused; missing key → AIError no-key without a request', async () => {
  const f = mockFetch([{ message: message([text('')], { stop_reason: 'refusal' }) }]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: f }), { messages: USER }), (e) => e.code === 'refused');
  f.done();
  const g = mockFetch([]);
  await assert.rejects(callClaude(aiConfig({ fetchImpl: g, apiKey: '  ' }), { messages: USER }), (e) => e.code === 'no-key');
  await assert.rejects(callClaude(null, { messages: USER }), (e) => e.code === 'no-key');
  assert.equal(g.calls.length, 0);
});

test('oversized request is rejected locally', async () => {
  const g = mockFetch([]);
  const huge = 'A'.repeat(33 * 1024 * 1024);
  await assert.rejects(
    callClaude(aiConfig({ fetchImpl: g }), { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: huge } }] }] }),
    (e) => e.code === 'bad-request' && e.status === 413,
  );
  assert.equal(g.calls.length, 0);
});

test('callClaudeJson parses structured output; max_tokens → AIError parse', async () => {
  const f = mockFetch([
    { message: message([thinking('hmm'), text('{"a":"x","n":2}')]) },
    { message: message([text('{"a":')], { stop_reason: 'max_tokens' }) },
  ]);
  const ai = aiConfig({ fetchImpl: f });
  const { data } = await callClaudeJson(ai, { messages: USER, outputFormat: { schema: { type: 'object' } } });
  assert.deepEqual(data, { a: 'x', n: 2 });
  assert.deepEqual(f.calls[0].body.output_config.format, { type: 'json_schema', schema: { type: 'object' } });
  await assert.rejects(callClaudeJson(ai, { messages: USER }), (e) => e.code === 'parse');
  f.done();
  assert.deepEqual(parseJsonText('```json\n{"x":1}\n```'), { x: 1 });
  assert.deepEqual(parseJsonText('Here you go: {"x":2} thanks'), { x: 2 });
  assert.throws(() => parseJsonText('nope'), (e) => e.code === 'parse');
});

test('verifyKey sends a 1-token request to the fast model', async () => {
  const f = mockFetch([jsonResponse(message([text('p')], { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 8, output_tokens: 1 } }))]);
  const r = await verifyKey(aiConfig({ fetchImpl: f }));
  assert.equal(r.ok, true);
  assert.equal(r.model, 'claude-haiku-4-5-20251001');
  const b = f.calls[0].body;
  assert.equal(b.model, 'claude-haiku-4-5-20251001');
  assert.equal(b.max_tokens, 1);
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.equal('stream' in b, false);
  assert.equal('output_config' in b, false);
  f.done();
});
