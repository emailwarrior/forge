import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_MEAL_TOOL, LAB_EXTRACT_SCHEMA, LAB_INTERPRET_SCHEMA, NUTRITION_REVIEW_SCHEMA, WEEKLY_REVIEW_SCHEMA, schemaReport, webSearchTool,
} from '../../js/ai/schemas.js';
import {
  GUARDRAILS, mealSystemPrompt, labsExtractSystemPrompt, labsInterpretSystemPrompt, nutritionReviewSystemPrompt,
  weeklyReviewSystemPrompt, morningBriefSystemPrompt, askSystemPrompt, compact, prune, clip, hhmm,
} from '../../js/ai/prompts.js';
import { NUTRIENT_KEYS } from '../../js/core/schema.js';
import * as ai from '../../js/ai/index.js';

test('schemas respect structured-output limits (no optional or union properties, no bounds, closed objects)', () => {
  const all = [RECORD_MEAL_TOOL.input_schema, LAB_EXTRACT_SCHEMA, LAB_INTERPRET_SCHEMA, NUTRITION_REVIEW_SCHEMA, WEEKLY_REVIEW_SCHEMA];
  let optional = 0, unions = 0;
  for (const s of all) {
    const r = schemaReport(s);
    assert.deepEqual(r.problems, []);
    optional += r.optional; unions += r.unions;
  }
  assert.ok(optional <= 24);
  assert.ok(unions <= 16);
  assert.equal(optional, 0);
  const bad = schemaReport({ type: 'object', properties: { a: { type: 'number', minimum: 0 }, b: { type: ['string', 'null'] } }, required: ['a'] });
  assert.equal(bad.optional, 1);
  assert.equal(bad.unions, 1);
  assert.equal(bad.problems.length, 2);
});

test('record_meal: strict tool, every item carries all 14 nutrients and the FoodItem fields', () => {
  assert.equal(RECORD_MEAL_TOOL.strict, true);
  const it = RECORD_MEAL_TOOL.input_schema.properties.items.items;
  assert.deepEqual(it.required, ['name', 'portion', 'grams', 'basis', 'confidence', ...NUTRIENT_KEYS]);
  for (const k of NUTRIENT_KEYS) assert.equal(it.properties[k].type, 'number');
  assert.deepEqual(webSearchTool(), { type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
});

test('every system prompt carries the guardrails and the style rules', () => {
  const prompts = [mealSystemPrompt(), labsExtractSystemPrompt(), labsInterpretSystemPrompt(), nutritionReviewSystemPrompt(), weeklyReviewSystemPrompt(), morningBriefSystemPrompt(), askSystemPrompt({ today: '2026-09-26' })];
  for (const p of prompts) {
    assert.ok(p.includes(GUARDRAILS));
    assert.match(p, /not medical advice/i);
    assert.match(p, /never recommend starting, stopping, or changing the dose/i);
    assert.match(p, /physician/);
    assert.match(p, /no emojis/i);
    assert.match(p, /no moralizing/i);
    assert.doesNotMatch(p, /temperature/);
  }
});

test('prompt helpers', () => {
  assert.equal(compact({ a: 1.23456, b: null, c: '', d: [], e: { f: undefined }, g: [null, 2], _u: 5 }), '{"a":1.23,"g":[2]}');
  assert.equal(compact(null), '');
  assert.equal(prune(NaN), undefined);
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(hhmm('2026-09-26T07:05:00-04:00'), '07:05');
  assert.equal(hhmm('21:30'), '21:30');
  assert.equal(hhmm(null), '');
});

test('index exports the documented API', () => {
  for (const name of ['callClaude', 'analyzeMeal', 'analyzeMealText', 'extractLabs', 'interpretLabs', 'nutritionReview', 'weeklyReview', 'morningBrief', 'askForge', 'readExifDate', 'timeFromFilename', 'prepareImage', 'makeThumb', 'AIError', 'costUsd', 'makeAiConfig', 'verifyKey']) {
    assert.equal(typeof ai[name], 'function', name);
  }
  const cfg = ai.makeAiConfig({ model: 'claude-opus-5-5', webLookup: false }, ' key \n', { timeoutMs: 1000 });
  assert.deepEqual(cfg, { apiKey: 'key', model: 'claude-opus-5-5', fastModel: 'claude-haiku-4-5-20251001', effort: 'medium', webLookup: false, timeoutMs: 1000 });
  assert.equal(ai.makeAiConfig(undefined, undefined).model, 'claude-sonnet-5');
});
