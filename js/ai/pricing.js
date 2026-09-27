// FORGE AI layer: token pricing and cost accounting (USD). Pure; browser and Node safe.
// Prices per million tokens. Cache writes are 5-minute writes; 1-hour writes (if ever used) bill at 2× input.

export const PRICES = Object.freeze({
  'claude-sonnet-5':           Object.freeze({ input: 2, output: 10, cacheWrite: 2.5,  cacheRead: 0.2 }),
  'claude-haiku-4-5-20251001': Object.freeze({ input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 }),
  'claude-opus-5-5':           Object.freeze({ input: 4, output: 20, cacheWrite: 5,    cacheRead: 0.2 }),
});
export const WEB_SEARCH_USD = 10 / 1000; // $10 per 1,000 searches
const FALLBACK_MODEL = 'claude-sonnet-5';

const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
// 'claude-haiku-4-5-20251001' and 'claude-haiku-4-5' price the same; dated snapshots match their alias.
const baseId = (m) => String(m || '').toLowerCase().trim().replace(/-latest$/, '').replace(/-\d{8}$/, '');

export const roundUsd = (x) => Math.round((Number(x) || 0) * 1e6) / 1e6;

/** Price row for a model. Unknown models use Sonnet pricing with `estimate: true`. */
export function priceFor(model) {
  const b = baseId(model);
  if (b) for (const key of Object.keys(PRICES)) if (baseId(key) === b) return { ...PRICES[key], model: key, estimate: false };
  return { ...PRICES[FALLBACK_MODEL], model: FALLBACK_MODEL, estimate: true };
}

/**
 * Cost of one API response.
 * usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *          cache_creation?: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens },
 *          server_tool_use?: { web_search_requests } }
 * → { usd, estimate, searches }
 */
export function costOf(model, usage) {
  const p = priceFor(model);
  const u = usage || {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheTotal = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const write1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const write5m = cc && cc.ephemeral_5m_input_tokens != null ? num(cc.ephemeral_5m_input_tokens) : Math.max(0, cacheTotal - write1h);
  const searches = num(u.server_tool_use && u.server_tool_use.web_search_requests);
  const usd = (input * p.input + output * p.output + write5m * p.cacheWrite + write1h * p.input * 2 + cacheRead * p.cacheRead) / 1e6
    + searches * WEB_SEARCH_USD;
  return { usd: roundUsd(usd), estimate: p.estimate, searches };
}

/** Convenience: cost in USD only. */
export function costUsd(model, usage) { return costOf(model, usage).usd; }

/** Sum two usage objects (numeric fields add, nested objects recurse; either may be null). */
export function addUsage(a, b) {
  if (!a) return b ? cloneUsage(b) : null;
  if (!b) return cloneUsage(a);
  const out = cloneUsage(a);
  for (const [k, v] of Object.entries(b)) {
    if (v == null) continue;
    if (typeof v === 'number') out[k] = (typeof out[k] === 'number' ? out[k] : 0) + v;
    else if (typeof v === 'object' && !Array.isArray(v)) out[k] = addUsage(out[k] && typeof out[k] === 'object' ? out[k] : null, v);
    else if (out[k] == null) out[k] = v;
  }
  return out;
}
function cloneUsage(u) {
  const o = {};
  for (const [k, v] of Object.entries(u || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? cloneUsage(v) : v;
  return o;
}

/** Approximate input tokens for an image of w×h px as Claude sees it (long edge capped at ~1568 px). */
export function imageTokens(width, height) {
  let w = num(width), h = num(height);
  if (!w || !h) return 0;
  const long = Math.max(w, h);
  if (long > 1568) { const k = 1568 / long; w *= k; h *= k; }
  if (w * h > 1_150_000) { const k = Math.sqrt(1_150_000 / (w * h)); w *= k; h *= k; }
  return Math.ceil((w * h) / 750);
}

/** Rough pre-flight estimate for UI hints: { usd, estimate }. */
export function estimateCost(model, { inputTokens = 0, outputTokens = 0, searches = 0 } = {}) {
  return costOf(model, { input_tokens: inputTokens, output_tokens: outputTokens, server_tool_use: { web_search_requests: searches } });
}
