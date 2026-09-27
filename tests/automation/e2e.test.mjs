// End-to-end: task 'auto' with the REAL analytics and AI modules (loaded the same way the
// bundle loads them); only the network is mocked (Google, Anthropic) and push is stubbed.
// Guards the contracts in docs/ANALYTICS_API.md and docs/AI_API.md from the automation side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutomation } from '../../automation/run.mjs';
import { createLogger } from '../../automation/log.mjs';
import { makeVault, googleMock, googleEvent, senderStub, addPushSubs, noSleep, edt, json } from './fixtures/helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEEDED = ['readiness', 'protocols', 'nutrition', 'body', 'weekly', 'correlations', 'daily'].map((n) => `js/analytics/${n}.js`).concat('js/ai/reviews.js');
const missing = NEEDED.filter((p) => !existsSync(join(ROOT, p)));

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const SA_JSON = JSON.stringify({ type: 'service_account', private_key_id: 'k1', private_key: privateKey, client_email: 'forge-sync@forge-test.iam.gserviceaccount.com' });
const ME = 'me@example.com';
const FORGE = 'forge-cal@group.calendar.google.com';
const KEY = 'sk-ant-api03-e2e-test-key-0123456789abcdef';

function anthropicMock(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const props = (((body.output_config || {}).format || {}).schema || {}).properties || {};
    const data = 'whatWorked' in props
      ? { headline: 'Steady week.', summary: 'Sleep and training were consistent.', whatWorked: ['Sleep timing'], whatDidnt: ['Late dinners'], focus: { title: 'Dinner by 19:30', why: 'Late meals preceded lower recovery.', how: ['Plan dinner', 'Prep lunch'] } }
      : { score: 78, headline: 'Protein on target, fiber light.', wins: ['Protein at every meal'], gaps: ['Fiber'], tomorrow: ['Add beans at lunch'], flags: [] };
    return json(200, { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(data) }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 250 } }, { 'request-id': 'req_test' });
  };
}

test('e2e: auto with real analytics + AI modules (network mocked)', { skip: missing.length ? `modules not present yet: ${missing.join(', ')}` : false }, async () => {
  const v = await makeVault({
    today: '2026-09-27', days: 60, server: true,
    mutate: (app) => {
      app.updateSetting('integrations', {
        gcal: { saEmail: 'forge-sync@forge-test.iam.gserviceaccount.com', readCalendars: [ME], forgeCalendarId: FORGE, pushPlan: true, pushReminders: true },
        push: { vapidPublicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM' },
        ai: { serverReviews: true, model: 'claude-sonnet-5', effort: 'medium' },
      });
      addPushSubs(app);
      app.create('plan', { id: 'e2e-deep', date: '2026-09-28', start: '08:00', end: '10:00', title: 'Deep work', category: 'deep', status: 'planned', calendar: true });
    },
  });
  const cals = { [ME]: [googleEvent('m1', { date: '2026-09-28', start: '11:00', end: '11:30', summary: 'Standup', attendees: [{ email: ME, self: true, responseStatus: 'accepted' }] })], [FORGE]: [] };
  const g = googleMock({ calendars: cals, pageSize: 50 });
  const ai = [];
  const anthropic = anthropicMock(ai);
  const fetch = (url, init) => (String(url).startsWith('https://api.anthropic.com/') ? anthropic(url, init) : g.fetch(url, init));
  const env = v.env({ FORGE_TASK: 'auto', GOOGLE_SA_KEY: SA_JSON, ANTHROPIC_API_KEY: KEY, VAPID_PRIVATE_KEY: 'unused-with-stub-sender' });
  const log = createLogger({ quiet: true });

  // Sunday 07:10: calendar sync, yesterday's nutrition review, morning brief.
  const push = senderStub();
  const r1 = await runAutomation({ root: v.dir, env, fetch, now: () => edt('2026-09-27', '07:10'), sleep: noSleep, sender: push.sender, git: false, log });
  assert.equal(r1.exitCode, 0);
  assert.deepEqual(r1.results, { calendar: 'ok', reviews: 'ok', push: 'ok' }, JSON.stringify((await v.read('forge/server/status.enc')).r));

  const brief = push.sent.find((s) => s.payload.tag === 'brief');
  assert.ok(brief, 'brief sent');
  assert.match(brief.payload.title, /^Readiness \d+ · (green|yellow|red)$/);
  assert.ok(brief.payload.body.length > 0 && brief.payload.body.length <= 140);

  const cal = (await v.read('forge/server/status.enc')).r.calendar.detail;
  assert.ok(cal.write.desired > 20 && cal.write.inserted === cal.write.desired);
  const inserts = g.calls.filter((c) => c.calendarId === FORGE && c.method === 'POST');
  assert.ok(inserts.some((c) => c.body.extendedProperties.private.forgeRef === 'rem:dose:2026-09-28:p-pep'), 'real dueItems: peptide due Monday');
  assert.ok(inserts.some((c) => c.body.extendedProperties.private.forgeRef === 'plan:e2e-deep'));
  assert.ok(!JSON.stringify(inserts).toLowerCase().includes('peptide'), 'no substance names in calendar events');

  assert.equal(ai.length, 1);
  assert.equal(ai[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(ai[0].headers['x-api-key'], KEY);
  assert.equal(ai[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(ai[0].headers['anthropic-dangerous-direct-browser-access'], undefined, 'server requests are not browser requests');
  assert.equal(ai[0].body.temperature, undefined);
  const n = (await v.read('forge/server/reviews/2026.enc')).r['nutrition:2026-09-26'];
  assert.equal(n.content.score, 78);
  assert.equal(n.model, 'claude-sonnet-5');
  assert.ok(typeof n.costUsd === 'number' && n.costUsd > 0);
  assert.ok(!log.lines.join('\n').includes(KEY));

  // Monday 04:10: last week's weekly review (+ Sunday's nutrition review).
  const r2 = await runAutomation({ root: v.dir, env, fetch, now: () => edt('2026-09-28', '04:10'), sleep: noSleep, sender: senderStub().sender, git: false, log });
  assert.equal(r2.results.reviews, 'ok');
  const reviews = (await v.read('forge/server/reviews/2026.enc')).r;
  assert.equal(reviews['weekly:2026-W39'].content.focus.title, 'Dinner by 19:30');
  assert.ok(reviews['nutrition:2026-09-27']);
  assert.equal(ai.length, 3);
});
