import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMeal, analyzeMealText, mealTotals, scaleFoodItem, normalizeFoodItem, mentionsBrand } from '../../js/ai/meal.js';
import { NUTRIENT_KEYS } from '../../js/core/schema.js';
import {
  aiConfig, mockFetch, message, text, thinking, toolUse, serverSearch, searchResult, citation, bothModes,
} from './fixtures/mock-claude.mjs';

const IMAGE = { data: '/9j/4AAQSkZJRgABAQAAAQABAAD', mediaType: 'image/jpeg' };
const zeros = () => Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0]));
const item = (o) => ({ name: 'x', portion: '', grams: 0, basis: 'estimate', confidence: 'medium', ...zeros(), ...o });

const MEAL = {
  title: 'Chicken rice bowl',
  portionReference: '10.5 in dinner plate',
  assumptions: ['Chicken grilled with a little oil', 'White jasmine rice', ''],
  items: [
    item({ name: 'Grilled chicken breast', portion: 'two palm-sized pieces', grams: 240, confidence: 'HIGH', kcal: 396, protein: 74.4, fat: 8.6, satFat: 2.4, sodium: 180, potassium: 612, calcium: 36, iron: 1.2, magnesium: 70, vitD: 12 }),
    item({ name: 'White rice', portion: '1 cup', grams: 158.4, basis: 'Web', kcal: 205.3, protein: 4.25, carbs: 44.5, fat: 0.44, fiber: 0.6, sugar: 0.1, satFat: 0.1, sodium: 2, potassium: 55, calcium: 16, iron: 1.9, magnesium: 19 }),
    item({ name: 'Cooking oil (est.)', portion: '1 tsp', grams: 4.5, confidence: 'low', kcal: 40, fat: 4.5, satFat: 0.6 }),
    item({ name: '   ' }),
    item({ name: 'Bad numbers', grams: -5, kcal: 'abc', protein: -2, sodium: Infinity }),
  ],
  confidence: 'high',
  followUp: '',
};

test('analyzeMeal: request shape (image block, strict record_meal, web search, tool_choice auto, context)', async () => {
  const f = mockFetch([{ message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use' }) }]);
  await analyzeMeal(aiConfig({ fetchImpl: f }), {
    image: IMAGE, note: 'double chicken, no rice', at: '2026-09-26T12:34:00-04:00', date: '2026-09-26',
    rules: ['Protein at every meal (40g+)', { text: 'An inactive rule', active: false }],
    recentFoods: ['Chicken rice bowl', { name: 'Overnight oats', totals: { ...zeros(), kcal: 493, protein: 31.5 }, items: [{ name: 'Rolled oats', grams: 80 }, { name: 'Greek yogurt', grams: 170 }] }],
    profile: { weightLb: 172.4, goal: 'lean gain' },
  });
  f.done();
  const b = f.calls[0].body;
  assert.equal(b.model, 'claude-sonnet-5');
  assert.equal(b.max_tokens, 12000);
  assert.deepEqual(b.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
  const rm = b.tools[1];
  assert.equal(rm.name, 'record_meal');
  assert.equal(rm.strict, true);
  assert.equal(rm.input_schema.additionalProperties, false);
  assert.deepEqual([...rm.input_schema.required].sort(), ['assumptions', 'confidence', 'followUp', 'items', 'portionReference', 'title']);
  const itemSchema = rm.input_schema.properties.items.items;
  assert.equal(itemSchema.additionalProperties, false);
  for (const k of ['name', 'portion', 'grams', 'confidence', 'basis', ...NUTRIENT_KEYS]) assert.ok(itemSchema.required.includes(k), k);
  assert.deepEqual(itemSchema.properties.basis.enum, ['estimate', 'label', 'web', 'saved']);
  assert.deepEqual(b.tool_choice, { type: 'auto' });
  assert.equal('thinking' in b, false, 'adaptive thinking left on for the first call');
  assert.equal(b.output_config.effort, 'medium');
  assert.equal('format' in b.output_config, false, 'no structured-output format alongside web search');
  const [img, txt] = b.messages[0].content;
  assert.deepEqual(img, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMAGE.data } });
  assert.match(txt.text, /User note \(ground truth.*"double chicken, no rice"/);
  assert.match(txt.text, /Eaten: 2026-09-26 12:34 \(lunch time\)/);
  assert.match(txt.text, /Protein at every meal/);
  assert.doesNotMatch(txt.text, /inactive rule/);
  assert.match(txt.text, /Overnight oats — 250 g \[Rolled oats, Greek yogurt\]: kcal 493, protein 31.5/);
  assert.match(txt.text, /Foods this user logs often.*Chicken rice bowl/);
  assert.match(txt.text, /body weight 172.4 lb; goal: lean gain/);
  assert.match(txt.text, /Web search: available/);
  assert.match(b.system, /USDA/);
  assert.match(b.system, /hidden calories/i);
  assert.match(b.system, /15%/);
  assert.match(b.system, /Never recommend starting, stopping, or changing the dose/);
});

test('analyzeMeal: no web search tool when ai.webLookup is off', async () => {
  const f = mockFetch([{ message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use' }) }]);
  await analyzeMeal(aiConfig({ fetchImpl: f, webLookup: false }), { image: IMAGE });
  const b = f.calls[0].body;
  assert.deepEqual(b.tools.map((t) => t.name), ['record_meal']);
  assert.match(b.messages[0].content[1].text, /Web search: not available/);
  f.done();
});

test('analyzeMeal: parses record_meal, sanitizes items and computes totals in code', async () => {
  await bothModes(async (stream) => {
    const f = mockFetch([{ message: message([thinking('reasoning'), toolUse('record_meal', { ...MEAL, totals: { kcal: 99999 } })], { stop_reason: 'tool_use', usage: { input_tokens: 3000, output_tokens: 1500 } }) }]);
    const r = await analyzeMeal(aiConfig({ fetchImpl: f, stream }), { image: IMAGE });
    f.done();
    assert.deepEqual(r.items.map((i) => i.name), ['Grilled chicken breast', 'White rice', 'Cooking oil (est.)', 'Bad numbers']);
    const [chicken, rice, oil, bad] = r.items;
    assert.equal(chicken.confidence, 'high');
    assert.equal(rice.basis, 'estimate', "'web' without a search is downgraded");
    assert.equal(rice.grams, 158);
    assert.equal(rice.kcal, 205);
    assert.equal(rice.protein, 4.3);
    assert.equal(rice.fat, 0.4);
    assert.equal(oil.confidence, 'low');
    assert.deepEqual([bad.grams, bad.kcal, bad.protein, bad.sodium], [0, 0, 0, 0]);
    for (const it of r.items) for (const k of NUTRIENT_KEYS) assert.equal(typeof it[k], 'number', k);
    assert.deepEqual(r.totals, {
      kcal: 641, protein: 78.7, carbs: 44.5, fat: 13.5, fiber: 0.6, sugar: 0.1, satFat: 3.1,
      sodium: 182, potassium: 667, calcium: 52, iron: 3.1, magnesium: 89, vitC: 0, vitD: 12,
    });
    assert.equal(r.confidence, 'high');
    assert.equal(r.title, 'Chicken rice bowl');
    assert.deepEqual(r.assumptions, ['Scale reference: 10.5 in dinner plate', 'Chicken grilled with a little oil', 'White jasmine rice']);
    assert.equal(r.reference, '10.5 in dinner plate');
    assert.equal(r.followUp, null);
    assert.equal(r.searched, false);
    assert.deepEqual(r.sources, []);
    assert.equal(r.fallback, false);
    assert.equal(r.model, 'claude-sonnet-5');
    assert.equal(r.costUsd, 0.021); // 3000×$2/M + 1500×$10/M
    assert.equal(r.usage.output_tokens, 1500);
  });
});

test('analyzeMeal: overall confidence never exceeds the calorie-weighted item confidence', async () => {
  const input = { ...MEAL, confidence: 'high', followUp: 'Was the dressing regular or light?', items: [
    item({ name: 'Caesar salad', grams: 300, confidence: 'low', kcal: 480, fat: 40 }),
    item({ name: 'Water', grams: 500, confidence: 'high', kcal: 0 }),
  ] };
  const f = mockFetch([{ message: message([toolUse('record_meal', input)], { stop_reason: 'tool_use' }) }]);
  const r = await analyzeMeal(aiConfig({ fetchImpl: f }), { image: IMAGE });
  assert.equal(r.confidence, 'low');
  assert.equal(r.followUp, 'Was the dressing regular or light?');
  f.done();
});

test('analyzeMeal: web search → searched, cited sources, web basis kept, search cost included', async () => {
  await bothModes(async (stream) => {
    const input = { ...MEAL, items: [item({ name: 'Chipotle chicken', portion: '4 oz', grams: 113, basis: 'web', confidence: 'high', kcal: 180, protein: 32, fat: 7, sodium: 310 })] };
    const content = [
      serverSearch('Chipotle chicken nutrition', 'srv_1'),
      searchResult('srv_1', [{ url: 'https://www.chipotle.com/nutrition-calculator', title: 'Nutrition Calculator | Chipotle' }, { url: 'https://example.com/blog', title: 'Blog' }]),
      text('Chipotle lists chicken at 180 kcal per 4 oz serving.', [citation('https://www.chipotle.com/nutrition-calculator', 'Nutrition Calculator | Chipotle', 'Chicken 4 oz 180 cal')]),
      toolUse('record_meal', input),
    ];
    const f = mockFetch([{ message: message(content, { stop_reason: 'tool_use', usage: { input_tokens: 10000, output_tokens: 2000, server_tool_use: { web_search_requests: 1 } } }) }]);
    const r = await analyzeMeal(aiConfig({ fetchImpl: f, stream }), { image: IMAGE, note: 'Chipotle' });
    f.done();
    assert.equal(r.searched, true);
    assert.deepEqual(r.sources, [{ title: 'Nutrition Calculator | Chipotle', url: 'https://www.chipotle.com/nutrition-calculator' }]);
    assert.equal(r.items[0].basis, 'web');
    assert.equal(r.totals.kcal, 180);
    assert.equal(r.costUsd, 0.05); // 0.02 + 0.02 + 0.01 search
  });
});

test('analyzeMeal: pause_turn mid-search is continued before recording', async () => {
  await bothModes(async (stream) => {
    const paused = [serverSearch('sweetgreen harvest bowl nutrition', 'srv_9'), searchResult('srv_9', [{ url: 'https://www.sweetgreen.com/menu', title: 'Menu' }])];
    const f = mockFetch([
      { message: message(paused, { stop_reason: 'pause_turn', usage: { input_tokens: 4000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } } }) },
      { message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use' }) },
    ]);
    const r = await analyzeMeal(aiConfig({ fetchImpl: f, stream }), { image: IMAGE });
    f.done();
    assert.deepEqual(f.calls[1].body.messages[1], { role: 'assistant', content: paused });
    assert.deepEqual(f.calls[1].body.tools, f.calls[0].body.tools);
    assert.equal(r.searched, true);
    assert.deepEqual(r.sources, [{ title: 'Menu', url: 'https://www.sweetgreen.com/menu' }]);
    assert.equal(r.fallback, false);
  });
});

test('analyzeMeal: fallback forces record_meal with thinking disabled when the first reply has no tool call', async () => {
  await bothModes(async (stream) => {
    const f = mockFetch([
      { message: message([thinking('private reasoning'), text('This looks like grilled chicken over rice, about 1 cup.')], { usage: { input_tokens: 2000, output_tokens: 400 } }) },
      { message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use', usage: { input_tokens: 2500, output_tokens: 900 } }) },
    ]);
    const r = await analyzeMeal(aiConfig({ fetchImpl: f, stream }), { image: IMAGE, note: 'no sauce' });
    f.done();
    const [first, second] = f.calls.map((c) => c.body);
    assert.deepEqual(first.tool_choice, { type: 'auto' });
    assert.deepEqual(second.tool_choice, { type: 'tool', name: 'record_meal' });
    assert.deepEqual(second.thinking, { type: 'disabled' });
    assert.deepEqual(second.tools.map((t) => t.name), ['record_meal']);
    assert.equal(second.tools[0].strict, true);
    assert.equal(second.model, 'claude-sonnet-5');
    assert.equal(second.max_tokens, 8000);
    assert.equal(second.system, first.system);
    assert.equal(second.messages.length, 3);
    assert.deepEqual(second.messages[0], first.messages[0]);
    assert.deepEqual(second.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'This looks like grilled chicken over rice, about 1 cup.' }] });
    assert.equal(second.messages[2].role, 'user');
    assert.match(second.messages[2].content[0].text, /calling record_meal/);
    assert.doesNotMatch(JSON.stringify(second.messages), /private reasoning/);
    assert.equal(r.fallback, true);
    assert.equal(r.totals.kcal, 641);
    assert.equal(r.costUsd, 0.022); // (2000×2+400×10 + 2500×2+900×10)/1e6
    assert.equal(r.usage.input_tokens, 4500);
  });
});

test('analyzeMeal: fallback after a max_tokens cut, with an empty transcript, and when it also fails', async () => {
  const partial = { title: 'x', items: [item({ name: 'half' })] };
  const f = mockFetch([
    { message: message([thinking('long…'), toolUse('record_meal', partial)], { stop_reason: 'max_tokens' }) },
    { message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use' }) },
  ]);
  const r = await analyzeMeal(aiConfig({ fetchImpl: f }), { image: IMAGE });
  f.done();
  assert.equal(r.fallback, true);
  assert.equal(r.items.length, 4);
  // no text to replay: the instruction joins the original user turn
  const second = f.calls[1].body;
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].content.length, 3);
  assert.equal(second.messages[0].content[0].type, 'image');
  assert.match(second.messages[0].content[2].text, /record_meal/);

  const g = mockFetch([{ message: message([text('Cannot tell.')]) }, { message: message([text('Still no tool.')]) }]);
  await assert.rejects(analyzeMeal(aiConfig({ fetchImpl: g }), { image: IMAGE }), (e) => e.code === 'parse');
  g.done();
});

test('analyzeMeal: Opus 5.5 never gets forced tool use; its fallback runs on Sonnet', async () => {
  const f = mockFetch([
    { message: message([text('Chicken and rice.')], { model: 'claude-opus-5-5' }) },
    { message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use' }) },
  ]);
  const r = await analyzeMeal(aiConfig({ fetchImpl: f, model: 'claude-opus-5-5' }), { image: IMAGE });
  f.done();
  assert.equal(f.calls[0].body.model, 'claude-opus-5-5');
  assert.deepEqual(f.calls[0].body.tool_choice, { type: 'auto' });
  assert.equal(f.calls[1].body.model, 'claude-sonnet-5');
  assert.deepEqual(f.calls[1].body.tool_choice, { type: 'tool', name: 'record_meal' });
  assert.equal(r.model, 'claude-opus-5-5');
});

test('analyzeMeal: followUp answers, data-URL images, multiple photos; bad input rejected before any request', async () => {
  const f = mockFetch([{ message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use' }) }]);
  await analyzeMeal(aiConfig({ fetchImpl: f }), {
    image: { data: 'data:image/png;base64,iVBORw0KGgo' },
    images: [{ data: 'UklGRiQAAABXRUJQ', mediaType: 'image/webp' }, { data: 'data:image/png;base64,iVBORw0KGgo' }],
    answers: [{ q: 'Fried or grilled chicken?', a: 'grilled' }],
  });
  f.done();
  const content = f.calls[0].body.messages[0].content;
  assert.deepEqual(content.slice(0, 2).map((c) => [c.source.media_type, c.source.data]), [['image/png', 'iVBORw0KGgo'], ['image/webp', 'UklGRiQAAABXRUJQ']]);
  assert.match(content[2].text, /these 2 photos/);
  assert.match(content[2].text, /Q: Fried or grilled chicken\? A: grilled/);

  const g = mockFetch([]);
  await assert.rejects(analyzeMeal(aiConfig({ fetchImpl: g }), {}), (e) => e.code === 'bad-request');
  await assert.rejects(analyzeMeal(aiConfig({ fetchImpl: g }), { image: { data: 'AAAA', mediaType: 'image/heic' } }), (e) => e.code === 'bad-request' && /heic/.test(e.message));
  await assert.rejects(analyzeMealText(aiConfig({ fetchImpl: g }), { text: '   ' }), (e) => e.code === 'bad-request');
  await assert.rejects(analyzeMeal(aiConfig({ fetchImpl: g, apiKey: '' }), { image: IMAGE }), (e) => e.code === 'no-key');
  assert.equal(g.calls.length, 0);
});

test('analyzeMeal: no food in the photo → empty items, zero totals, low confidence, followUp', async () => {
  const f = mockFetch([{ message: message([toolUse('record_meal', { title: '', portionReference: '', assumptions: [], items: [], confidence: 'medium', followUp: 'I do not see food. What did you eat?' })], { stop_reason: 'tool_use' }) }]);
  const r = await analyzeMeal(aiConfig({ fetchImpl: f }), { image: IMAGE });
  f.done();
  assert.deepEqual(r.items, []);
  assert.equal(r.totals.kcal, 0);
  assert.equal(r.title, '');
  assert.equal(r.confidence, 'low');
  assert.match(r.followUp, /What did you eat/);
});

test('analyzeMealText: web search only when a brand is named and ai.webLookup is on', async () => {
  const run = async (textIn, extra = {}, input = {}) => {
    const f = mockFetch([{ message: message([toolUse('record_meal', MEAL)], { stop_reason: 'tool_use' }) }]);
    const r = await analyzeMealText(aiConfig({ fetchImpl: f, ...extra }), { text: textIn, ...input });
    f.done();
    return { r, body: f.calls[0].body };
  };
  const plain = await run('3 eggs scrambled in butter and 2 slices of sourdough');
  assert.deepEqual(plain.body.tools.map((t) => t.name), ['record_meal']);
  assert.match(plain.body.messages[0].content[0].text, /"3 eggs scrambled in butter and 2 slices of sourdough"/);
  assert.match(plain.body.messages[0].content[0].text, /no photo/i);
  assert.equal(plain.body.messages[0].content.length, 1);
  assert.equal(plain.r.totals.kcal, 641);

  const brand = await run('chicken burrito bowl from Chipotle, no rice');
  assert.deepEqual(brand.body.tools.map((t) => t.name), ['web_search', 'record_meal']);
  const off = await run('Big Mac and medium fries', { webLookup: false });
  assert.deepEqual(off.body.tools.map((t) => t.name), ['record_meal']);
  const forced = await run('homemade chili', {}, { webSearch: true });
  assert.deepEqual(forced.body.tools.map((t) => t.name), ['web_search', 'record_meal']);
  const suppressed = await run('Starbucks grande latte', {}, { webSearch: false });
  assert.deepEqual(suppressed.body.tools.map((t) => t.name), ['record_meal']);
});

test('mentionsBrand heuristics', () => {
  for (const s of ['Chipotle bowl', "Big Mac from McDonald's", 'a Quest bar', 'lunch @ Sweetgreen', "Trader Joe's orange chicken", 'Fairlife shake', 'Kirkland protein bar', 'Oikos Pro™ yogurt', 'bowl from Cava', "Wendy's frosty"]) {
    assert.equal(mentionsBrand(s), true, s);
  }
  for (const s of ['two eggs and toast', "It's a chicken salad", 'ate at 7pm: rice and beans', 'Greek yogurt with honey', 'Caesar salad', 'grilled salmon, potatoes', '', null]) {
    assert.equal(mentionsBrand(s), false, String(s));
  }
});

test('mealTotals, scaleFoodItem and normalizeFoodItem', () => {
  const a = item({ name: 'Oats', grams: 80, kcal: 303, protein: 10.6, carbs: 54.1, fat: 5.3, fiber: 8.1, iron: 3.4 });
  const b = item({ name: 'Milk', grams: 240, kcal: 149, protein: 7.7, carbs: 11.7, fat: 7.9, vitD: 124.4 });
  assert.deepEqual(mealTotals([a, b]), { ...zeros(), kcal: 452, protein: 18.3, carbs: 65.8, fat: 13.2, fiber: 8.1, iron: 3.4, vitD: 124 });
  assert.deepEqual(mealTotals([]), zeros());
  const s = scaleFoodItem(a, 120);
  assert.equal(s.grams, 120);
  assert.equal(s.kcal, 455);
  assert.equal(s.protein, 15.9);
  assert.equal(s.portion, '120 g');
  assert.equal(a.grams, 80, 'input untouched');
  assert.equal(scaleFoodItem(item({ grams: 0, kcal: 50 }), 100).kcal, 50);
  assert.equal(normalizeFoodItem({ name: 'Rice', confidence: 'HIGH', basis: 'LABEL', kcal: '130.4' }).kcal, 130);
  assert.equal(normalizeFoodItem({ name: 'Rice', confidence: 'certain' }).confidence, 'medium');
  assert.equal(normalizeFoodItem({ name: '' }), null);
  assert.equal(normalizeFoodItem(null), null);
});
