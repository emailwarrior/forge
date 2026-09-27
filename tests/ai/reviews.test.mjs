import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nutritionReview, weeklyReview, morningBrief, capWords } from '../../js/ai/reviews.js';
import { askForge } from '../../js/ai/ask.js';
import { NUTRITION_REVIEW_SCHEMA, WEEKLY_REVIEW_SCHEMA } from '../../js/ai/schemas.js';
import { GUARDRAILS } from '../../js/ai/prompts.js';
import { aiConfig, mockFetch, message, text, thinking, bothModes } from './fixtures/mock-claude.mjs';

const MEALS = [
  { id: 'm1', at: '2026-09-26T08:05:00-04:00', slot: 'breakfast', items: [{ name: 'Eggs', grams: 150, kcal: 216, protein: 19, carbs: 1, fat: 15, fiber: 0 }], totals: { kcal: 216, protein: 19, carbs: 1, fat: 15, fiber: 0, sodium: 190 } },
  { id: 'm2', at: '2026-09-26T12:40:00-04:00', slot: 'lunch', title: 'Chicken rice bowl', items: [{ name: 'Chicken', grams: 200, kcal: 330, protein: 62, carbs: 0, fat: 7 }, { name: 'Rice', grams: 250, kcal: 325, protein: 6, carbs: 71, fat: 0.7 }], totals: { kcal: 655, protein: 68, carbs: 71, fat: 7.7, fiber: 1, sodium: 700 } },
  { id: 'm3', _d: 1, at: '2026-09-26T15:00:00-04:00', items: [], totals: { kcal: 999 } },
];
const TARGETS = { kcal: 2600, proteinG: 160, fatG: 78, carbsG: 300, fiberG: 35 };

test('nutritionReview: computed context, JSON schema, guardrails, clamped score', async () => {
  await bothModes(async (stream) => {
    const reply = { score: 104, headline: 'Under-fed day.', wins: ['Protein at lunch 68 g', 'b', 'c', 'd'], gaps: ['Calories 33% of target'], tomorrow: ['Add 200 g Greek yogurt at breakfast (+20 g protein)'], flags: [] };
    const f = mockFetch([{ message: message([thinking('rubric'), text(JSON.stringify(reply))], { usage: { input_tokens: 2500, output_tokens: 700 } }) }]);
    const r = await nutritionReview(aiConfig({ fetchImpl: f, stream }), {
      date: '2026-09-26', meals: MEALS, targets: TARGETS, rules: [{ text: 'Protein at every meal (40g+)', active: true }],
      training: { trained: true, sessions: 1, strain: 14.2 }, bodyTrend: { trendLb: 172.31, rate28: 0.3 }, protocolNotes: 'Appetite lower today',
    });
    f.done();
    const b = f.calls[0].body;
    assert.deepEqual(b.output_config.format, { type: 'json_schema', schema: NUTRITION_REVIEW_SCHEMA });
    assert.ok(b.system.includes(GUARDRAILS));
    assert.match(b.system, /35 points/);
    const p = b.messages[0].content;
    assert.match(p, /Date: 2026-09-26 \(Sat\)/);
    assert.match(p, /Totals: kcal 871 · protein 87 g/);
    assert.match(p, /Vs target \(computed\): kcal 34% \(−1,729\) · protein 54% \(−73 g\)/);
    assert.match(p, /Meals logged: 2/);
    assert.match(p, /- 12:40 lunch Chicken rice bowl: 655 kcal · P 68 · C 71 · F 7.7 · fiber 1 — Chicken 200 g; Rice 250 g/);
    assert.doesNotMatch(p, /999/, 'deleted meal excluded');
    assert.match(p, /Training: \{"trained":true,"sessions":1,"strain":14.2\}/);
    assert.match(p, /Body trend: \{"trendLb":172.31,"rate28":0.3\}/);
    assert.match(p, /Protocol notes \(context only\): Appetite lower today/);
    assert.equal(r.score, 100);
    assert.equal(r.headline, 'Under-fed day.');
    assert.equal(r.wins.length, 3);
    assert.deepEqual(r.flags, []);
    assert.equal(r.costUsd, 0.012);
  });
});

test('weeklyReview: stats, drivers as associations, last focus; parsed focus', async () => {
  const reply = { headline: 'Solid week.', summary: 'Sleep up 22 min.', whatWorked: ['a', 'b'], whatDidnt: ['c'], focus: { title: 'Earlier last meal', why: 'Late meals are associated with lower HRV (n=41).', how: ['Finish dinner by 19:30', 'Prep lunch', 'x', 'y', 'z'] } };
  const f = mockFetch([{ message: message([text(JSON.stringify(reply))]) }]);
  const r = await weeklyReview(aiConfig({ fetchImpl: f }), {
    stats: { week: '2026-W39', from: '2026-09-21', to: '2026-09-27', daysLogged: 7, averages: { sleepMin: 431.456, hrv: null }, highlights: [] },
    drivers: [{ sentence: 'Late last meal is associated with lower next-day HRV.', n: 41, q: 0.0312, strength: 'moderate' }],
    goals: { goalWeightLow: 180 }, lastFocus: { title: 'Lights out 22:30', why: 'Sleep debt', how: ['Phone away 22:00'] },
  });
  f.done();
  const b = f.calls[0].body;
  assert.deepEqual(b.output_config.format, { type: 'json_schema', schema: WEEKLY_REVIEW_SCHEMA });
  assert.match(b.system, /associations/);
  assert.ok(b.system.includes(GUARDRAILS));
  const p = b.messages[0].content;
  assert.match(p, /Week: 2026-W39 \(2026-09-21 to 2026-09-27\)/);
  assert.match(p, /"sleepMin":431.46/);
  assert.doesNotMatch(p, /"hrv"/);
  assert.match(p, /- Late last meal is associated with lower next-day HRV. \(n=41, moderate, q=0.031\)/);
  assert.match(p, /Last week's focus: \{"title":"Lights out 22:30"/);
  assert.equal(r.focus.title, 'Earlier last meal');
  assert.deepEqual(r.focus.how, ['Finish dinner by 19:30', 'Prep lunch', 'x', 'y']);
  assert.deepEqual(r.whatDidnt, ['c']);
  await assert.rejects(weeklyReview(aiConfig({ fetchImpl: mockFetch([]) }), {}), (e) => e.code === 'bad-request');
});

test('morningBrief: fast model, thinking off, plain text capped at 90 words', async () => {
  const long = '## Brief\n**Green, 78.** ' + Array.from({ length: 30 }, (_, i) => `Sentence ${i} is here.`).join(' ');
  const f = mockFetch([{ message: message([text(long)], { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 600, output_tokens: 150 } }) }]);
  const r = await morningBrief(aiConfig({ fetchImpl: f }), {
    date: '2026-09-26',
    readiness: { status: 'ok', band: 'green', score: 78, metrics: { recovery: 72, hrv: 68.2, hrvBase: 61, rhr: 52, rhrBase: 54, sleepMin: 455, sleepNeedMin: 480, sleepDebtMin: 25 }, training: { mode: 'build', detail: 'Moderate strength', strainTarget: [10, 14] }, focus: { start: '08:00', end: '10:00' }, flags: [{ level: 'info', text: 'Resp rate normal' }] },
    plan: [{ start: '07:30', end: '09:30', title: 'Deep work: product', category: 'deep' }],
    events: [{ start: '2026-09-26T10:00:00-04:00', end: '2026-09-26T10:30:00-04:00', title: 'Ops sync' }, { allDay: true, title: 'Holiday' }],
    nutritionTargets: { kcal: 2650, proteinG: 175 },
  });
  f.done();
  const b = f.calls[0].body;
  assert.equal(b.model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.equal('output_config' in b, false, 'no effort for Haiku');
  assert.equal('tools' in b, false);
  assert.ok(b.system.includes(GUARDRAILS));
  const p = b.messages[0].content;
  assert.match(p, /band green, score 78, recovery 72%, HRV 68 ms \(baseline 61\), RHR 52 \(baseline 54\), sleep 7h 35m vs need 8h 00m/);
  assert.match(p, /training call: build — Moderate strength \(strain 10–14\)/);
  assert.match(p, /Plan: 07:30–09:30 Deep work: product \(deep\)/);
  assert.match(p, /Calendar: 10:00–10:30 Ops sync; all day Holiday/);
  assert.match(p, /Nutrition targets: 2,650 kcal, protein 175 g/);
  assert.ok(r.text.split(/\s+/).length <= 90);
  assert.doesNotMatch(r.text, /[#*]/);
  assert.match(r.text, /^Brief Green, 78\./);
  assert.match(r.text, /\.$/);
  assert.equal(r.model, 'claude-haiku-4-5-20251001');
  assert.equal(r.costUsd, 0.00135);
});

test('capWords', () => {
  assert.equal(capWords('one two three', 5), 'one two three');
  assert.equal(capWords('One two three four. Five six', 5), 'One two three four.');
  assert.equal(capWords('A b. C d e f', 4), 'A b. C d…'); // sentence end too early: keep words, mark the cut
  assert.equal(capWords('a b c d e f g h', 4), 'a b c d…');
});

test('askForge: context pack in a cached system block, clean alternating history, markdown answer', async () => {
  await bothModes(async (stream) => {
    const ctx = 'date,sleepMin,hrv\n' + Array.from({ length: 400 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, '0')},420,60`).join('\n');
    const f = mockFetch([{ message: message([thinking('look at data'), text('**Short answer:** yes.\n\n- HRV averaged 60 ms.')], { usage: { input_tokens: 9000, output_tokens: 300, cache_creation_input_tokens: 8000 } }) }]);
    const r = await askForge(aiConfig({ fetchImpl: f, stream }), {
      question: 'Did late meals hurt my HRV?', contextPack: ctx, today: '2026-09-26',
      history: [
        { role: 'assistant', content: 'Welcome.' }, // leading assistant turn dropped
        { role: 'user', content: 'How did I sleep?' },
        { role: 'assistant', content: [{ type: 'text', text: 'Average 7h 00m.' }] },
        { role: 'system', content: 'ignored' },
        { role: 'user', content: '   ' },
        { role: 'user', content: 'And HRV?' },
        { role: 'user', content: 'Also RHR?' },
      ],
    });
    f.done();
    const b = f.calls[0].body;
    assert.equal(b.system.length, 2);
    assert.ok(b.system[0].text.includes(GUARDRAILS));
    assert.match(b.system[0].text, /Today is 2026-09-26/);
    assert.match(b.system[1].text, /^FORGE context pack/);
    assert.deepEqual(b.system[1].cache_control, { type: 'ephemeral' });
    assert.deepEqual(b.messages.map((x) => x.role), ['user', 'assistant', 'user']);
    assert.equal(b.messages[1].content, 'Average 7h 00m.');
    assert.equal(b.messages[2].content, 'And HRV?\n\nAlso RHR?\n\nDid late meals hurt my HRV?');
    assert.equal(r.answer, '**Short answer:** yes.\n\n- HRV averaged 60 ms.');
    // 9000×2 + 300×10 + 8000×2.5 per M
    assert.equal(r.costUsd, 0.041);
  });
});

test('askForge: short context is not cached; empty question rejected; empty answer → parse error', async () => {
  const f = mockFetch([{ message: message([text('Answer.')]) }, { message: message([thinking('…')]) }]);
  const ai = aiConfig({ fetchImpl: f });
  const r = await askForge(ai, { question: 'Hi?', contextPack: 'small' });
  assert.equal(r.answer, 'Answer.');
  assert.equal('cache_control' in f.calls[0].body.system[1], false);
  await assert.rejects(askForge(ai, { question: 'Again?' }), (e) => e.code === 'parse');
  assert.match(f.calls[1].body.system[1].text, /No FORGE data/);
  await assert.rejects(askForge(ai, { question: '  ' }), (e) => e.code === 'bad-request');
  f.done();
});
