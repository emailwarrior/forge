import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  relTime, modelLabel, aiSpend, fmtUsd, whoopState, whoopRunText, calendarRunText, pushRunText, calendarState, pushState,
  integrationsSummary, runState, automationSummary, syncSummary, profileSummary, targetsSummary, standardsSummary, rulesSummary,
  notificationsSummary, securitySummary, appearanceSummary, aiSummary, setupChecklist,
} from '../../js/ui/parts/settings-status.js';

const NOW = Date.parse('2026-09-26T22:00:00-04:00');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

test('settings-status: relTime', () => {
  assert.equal(relTime(NOW - 20000, NOW), 'just now');
  assert.equal(relTime(ago(12), NOW), '12 min ago');
  assert.equal(relTime(ago(180), NOW), '3 h ago');
  assert.equal(relTime(ago(30 * 60), NOW), 'yesterday');
  assert.equal(relTime(ago(4 * 1440), NOW), '4 days ago');
  assert.match(relTime(ago(20 * 1440), NOW), /^Sep \d+$/);
  assert.match(relTime(Date.parse('2025-03-02T12:00:00Z'), NOW), /2025/);
  assert.equal(relTime(NOW + 5 * 60000, NOW), 'in 5 min');
  assert.equal(relTime(null, NOW), 'never');
  assert.equal(relTime('garbage', NOW), 'never');
});

test('settings-status: WHOOP states', () => {
  assert.equal(whoopState({}, null, NOW).key, 'off');
  assert.equal(whoopState({ clientId: 'abc' }, null, NOW).key, 'saved');
  const connectedAt = ago(30);
  assert.equal(whoopState({ clientId: 'abc', connectedAt }, null, NOW).key, 'pending');
  // an older status from before the (re)connect does not count yet
  assert.equal(whoopState({ connectedAt }, { lastRunAt: ago(120), lastOkAt: ago(120), lastError: null }, NOW).key, 'pending');
  const ok = whoopState({ connectedAt }, { lastRunAt: ago(10), lastOkAt: ago(10), lastError: null, detail: { backfill: 'complete' } }, NOW);
  assert.equal(ok.key, 'ok'); assert.equal(ok.tone, 'good'); assert.match(ok.text, /10 min ago/);
  assert.equal(whoopState({ connectedAt }, { lastRunAt: ago(10), lastOkAt: ago(10), detail: { backfill: 'in-progress' } }, NOW).key, 'backfill');
  assert.equal(whoopState({ connectedAt }, { lastRunAt: ago(10), lastOkAt: ago(70), lastError: 'reauth-needed' }, NOW).key, 'reauth');
  const err = whoopState({ connectedAt }, { lastRunAt: ago(10), lastOkAt: ago(70), lastError: 'HTTP 500', detail: {} }, NOW);
  assert.equal(err.key, 'error'); assert.match(err.text, /HTTP 500/);
  assert.match(whoopState({ connectedAt }, { lastRunAt: ago(10), lastOkAt: null, lastError: 'bad code', detail: { state: 'auth-failed' } }, NOW).text, /Connection failed/);
  assert.equal(whoopState({ connectedAt }, { lastRunAt: ago(10), lastError: 'not-connected' }, NOW).key, 'error');
  // an error older than the last success is history, not the current state
  assert.equal(whoopState({ connectedAt }, { lastRunAt: ago(10), lastOkAt: ago(10), lastError: null }, NOW).key, 'ok');
});

test('settings-status: run texts', () => {
  assert.equal(whoopRunText(null), null);
  assert.equal(whoopRunText({ lastRun: { changed: { cycles: 0, recovery: 0, sleep: 0, workouts: 0 } } }), 'No new data');
  assert.equal(whoopRunText({ lastRun: { changed: { cycles: 1, recovery: 2, sleep: 2, workouts: 0 } } }), '5 new or updated (2 sleep, 2 recovery, 1 cycles)');
  assert.equal(calendarRunText({ read: { calendars: 2, ok: 2, events: 143 }, write: { inserted: 3, patched: 1, adopted: 0, deleted: 0 } }), 'Read 2 of 2 calendars · 143 events · FORGE calendar +3 ~1 −0');
  assert.equal(calendarRunText({ notes: ['x'] }), null);
  assert.equal(pushRunText({ subs: 1, lastSent: { kinds: ['brief'] }, quiet: false }), 'Last sent: brief · 1 subscription');
  assert.equal(pushRunText({ subs: 2, quiet: true }), 'Quiet hours · 2 subscriptions');
});

test('settings-status: calendar, push and integrations line', () => {
  assert.equal(calendarState({}, null, NOW).key, 'off');
  assert.equal(calendarState({ saEmail: 'sa@x.iam.gserviceaccount.com', readCalendars: ['me@x.com'] }, null, NOW).key, 'pending');
  const ok = calendarState({ saEmail: 'sa@x', readCalendars: ['me@x.com'], forgeCalendarId: 'f@group.calendar.google.com' }, { lastRunAt: ago(5), lastOkAt: ago(5) }, NOW);
  assert.equal(ok.key, 'ok'); assert.match(ok.text, /1 calendar read · FORGE calendar set · synced 5 min ago/);
  assert.equal(calendarState({ saEmail: 'sa@x', readCalendars: ['a'] }, { lastRunAt: ago(5), lastOkAt: ago(90), lastError: '1 calendar(s) could not be read' }, NOW).key, 'error');
  const subs = [{ id: 'a', device: 'iPhone', active: true }, { id: 'b', device: 'Mac', active: true }, { id: 'c', device: 'Old', active: false }];
  assert.equal(pushState([], null).key, 'off');
  assert.equal(pushState(subs, null).devices, 2);
  assert.equal(pushState(subs, { detail: { deadSubs: ['a'] } }).devices, 1, 'dead endpoints do not count');
  const line = integrationsSummary(whoopState({ connectedAt: ago(300) }, { lastRunAt: ago(3), lastOkAt: ago(3) }, NOW), ok, pushState(subs, null), { lastOkAt: ago(3) }, NOW);
  assert.equal(line.text, 'WHOOP synced 3 min ago · Calendar on · Push on 2 devices');
  assert.equal(integrationsSummary(whoopState({}, null, NOW), calendarState({}, null, NOW), pushState([], null), null, NOW).text, 'WHOOP not connected · Calendar off · Push off');
});

test('settings-status: automation and GitHub runs', () => {
  assert.equal(automationSummary(null, { version: '3.0.0', sha256: 'a' }, null, NOW).key, 'off');
  const inst = { version: '3.0.0', sha256: 'a', installedAt: ago(100) };
  assert.match(automationSummary(inst, { version: '3.0.0', sha256: 'a' }, { lastRunAt: ago(12) }, NOW).text, /v3\.0\.0 · up to date · last run 12 min ago/);
  const old = automationSummary(inst, { version: '3.0.1', sha256: 'b' }, null, NOW);
  assert.equal(old.key, 'update'); assert.equal(old.tone, 'warn');
  assert.equal(automationSummary(inst, undefined, { lastRunAt: ago(1), lastError: 'failed: whoop' }, NOW).tone, 'bad');
  assert.deepEqual(runState({ status: 'completed', conclusion: 'success' }), { text: 'Success', tone: 'good' });
  assert.equal(runState({ status: 'completed', conclusion: 'failure' }).tone, 'bad');
  assert.equal(runState({ status: 'in_progress' }).text, 'Running');
  assert.equal(runState({ status: 'queued' }).text, 'Queued');
});

test('settings-status: index lines', () => {
  assert.match(syncSummary({ state: 'idle', pending: 0, lastSyncAt: NOW - 120000 }, NOW).text, /^Synced 2 min ago$/);
  assert.equal(syncSummary({ state: 'idle', pending: 3, lastSyncAt: NOW - 120000 }, NOW).tone, 'warn');
  assert.equal(syncSummary({ state: 'error', error: 'Bad credentials' }, NOW).tone, 'bad');
  assert.match(syncSummary({ state: 'demo' }, NOW).text, /Demo/);
  assert.equal(profileSummary({ heightIn: 69, birthYear: 1990, goalWeightLow: 160, goalWeightHigh: 170 }, '2026-09-26').text, '5 ft 9 in · 36 y · goal 160–170 lb');
  assert.equal(profileSummary({}, '2026-09-26').tone, 'warn');
  assert.equal(targetsSummary({ kcal: 3120, proteinG: 165, basis: 'adaptive' }, 'adaptive').text, 'Adaptive · 3,120 kcal · 165 g protein');
  assert.equal(targetsSummary({ kcal: null }, 'adaptive').tone, 'warn');
  assert.equal(standardsSummary([{ active: true, required: true, auto: 'whoop.wake' }, { active: true }, { active: false, required: true }]).text, '2 active · 1 required · 1 automatic');
  assert.equal(rulesSummary([]).text, 'No rules yet');
  assert.equal(rulesSummary([{ text: 'a', active: true }, { text: 'b', active: false }]).text, '1 active rule · 1 off');
  assert.equal(notificationsSummary({ morningBrief: true, eveningCheckinAt: '21:30', weeklyReview: false, doseReminders: true }, { devices: 1 }).text, 'Brief, check-in 9:30 PM, protocol');
  assert.deepEqual(notificationsSummary({ morningBrief: true }, { devices: 0 }), { tone: 'warn', text: 'No device enabled · 1 type selected' });
  assert.equal(notificationsSummary({}, { devices: 1 }).text, 'All off');
  assert.equal(securitySummary({ lockMode: 'session', autoLockMin: 15 }).text, 'Passphrase every session · auto-lock 15 min');
  assert.equal(appearanceSummary({ theme: 'dark', startScreen: 'plan' }).text, 'Dark theme · opens on Plan');
  assert.equal(aiSummary({ hasKey: false }).tone, 'warn');
  assert.equal(aiSummary({ hasKey: true, ai: { model: 'claude-opus-5-5', serverReviews: true } }).text, 'Key set · Opus 5.5 · server reviews on');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('custom-model'), 'custom-model');
});

test('settings-status: AI spend from stored records', () => {
  const r = aiSpend({
    meals: [{ date: '2026-09-20', ai: { costUsd: 0.031 } }, { date: '2026-08-01', ai: { costUsd: 1 } }, { date: '2026-09-21', ai: { costUsd: 0 } }, { date: '2026-09-22' }],
    reviews: [{ date: '2026-09-21', costUsd: 0.02 }, { createdAt: '2026-09-23T03:00:00Z', costUsd: 0.01 }],
    labs: [{ collectedAt: '2026-09-10', ai: { costUsd: 0.1 } }],
  }, '2026-08-28', '2026-09-26');
  assert.equal(r.meals, 1); assert.equal(r.reviews, 2); assert.equal(r.labs, 1); assert.equal(r.n, 4);
  assert.equal(r.usd, 0.161);
  assert.equal(fmtUsd(0.161), '$0.16'); assert.equal(fmtUsd(0.004), '< $0.01'); assert.equal(fmtUsd(0), '$0'); assert.equal(fmtUsd(null), '—');
});

test('settings-status: setup checklist', () => {
  const list = setupChecklist({ profileDone: true, hasKey: true });
  assert.equal(list.length, 8);
  assert.equal(list.filter((c) => c.done).length, 2);
  assert.ok(list.find((c) => c.id === 'calendar').optional);
  assert.equal(list.find((c) => c.id === 'weighin').section, null);
});
