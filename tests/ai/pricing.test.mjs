import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, costUsd, priceFor, addUsage, imageTokens, estimateCost, WEB_SEARCH_USD } from '../../js/ai/pricing.js';

const M = 1_000_000;

test('cost: per-model input/output prices', () => {
  assert.equal(costUsd('claude-sonnet-5', { input_tokens: M, output_tokens: M }), 12);
  assert.equal(costUsd('claude-haiku-4-5-20251001', { input_tokens: M, output_tokens: M }), 6);
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: M, output_tokens: M }), 24);
  assert.equal(costUsd('claude-sonnet-5', { input_tokens: 1234, output_tokens: 567 }), 0.008138);
});

test('cost: cache writes, cache reads and web searches', () => {
  // haiku: 200k in ($0.20) + 10k out ($0.05) + 100k cache write ($0.125) + 1M cache read ($0.10)
  assert.equal(costUsd('claude-haiku-4-5-20251001', {
    input_tokens: 200_000, output_tokens: 10_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: M,
  }), 0.475);
  // sonnet: 1M cache write $2.50 + 1M cache read $0.20
  assert.equal(costUsd('claude-sonnet-5', { cache_creation_input_tokens: M, cache_read_input_tokens: M }), 2.7);
  // opus: cache write $5, read $0.20
  assert.equal(costUsd('claude-opus-5-5', { cache_creation_input_tokens: M, cache_read_input_tokens: M }), 5.2);
  // 1-hour cache writes bill at 2× input
  assert.equal(costUsd('claude-sonnet-5', { cache_creation_input_tokens: 2 * M, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M } }), 6.5);
  // web search: $10 / 1000
  assert.equal(WEB_SEARCH_USD, 0.01);
  const c = costOf('claude-sonnet-5', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } });
  assert.equal(c.usd, 0.03);
  assert.equal(c.searches, 3);
});

test('cost: unknown model uses Sonnet pricing and is marked estimate; dated ids and aliases resolve', () => {
  const u = costOf('claude-something-new', { input_tokens: M });
  assert.equal(u.usd, 2);
  assert.equal(u.estimate, true);
  assert.equal(priceFor('claude-sonnet-5-20260801').estimate, false);
  assert.equal(priceFor('claude-haiku-4-5').model, 'claude-haiku-4-5-20251001');
  assert.equal(priceFor('CLAUDE-OPUS-5-5').input, 4);
  assert.equal(priceFor(undefined).estimate, true);
  assert.equal(costUsd('claude-sonnet-5', null), 0);
  assert.equal(costUsd('claude-sonnet-5', { input_tokens: -5, output_tokens: NaN }), 0);
});

test('addUsage sums nested usage objects', () => {
  const a = { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 }, service_tier: 'standard' };
  const b = { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 100, server_tool_use: { web_search_requests: 2 } };
  assert.deepEqual(addUsage(a, b), { input_tokens: 17, output_tokens: 8, cache_read_input_tokens: 100, server_tool_use: { web_search_requests: 3 }, service_tier: 'standard' });
  assert.deepEqual(addUsage(null, b), b);
  assert.notEqual(addUsage(null, b), b);
  assert.equal(addUsage(null, null), null);
  assert.equal(a.input_tokens, 10, 'inputs untouched');
});

test('image token and pre-flight cost estimates', () => {
  assert.equal(imageTokens(1000, 1000), 1334);
  assert.ok(imageTokens(4032, 3024) <= 1534 + 1);
  assert.equal(imageTokens(0, 100), 0);
  assert.equal(estimateCost('claude-sonnet-5', { inputTokens: 3000, outputTokens: 1500, searches: 1 }).usd, 0.031);
});
