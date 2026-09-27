import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  timeZoneGroups, isValidZone, zoneOffsetLabel, splitHeight, joinHeight, profileErrors, targetsErrors, strengthLevel, backupFileName,
  collectionStats, openSuggestions, moveItem, normalizeCalendarId, isCalendarId, calendarIdIssue, maskKey, RULE_SUGGESTIONS, SECRETS, COLLECTION_LABELS,
} from '../../js/ui/parts/settings-util.js';
import { startRedirect, idleExpired } from '../../js/ui/parts/settings-shell.js';
import { passphraseBits } from '../../js/core/crypto.js';
import { createStore } from '../../js/core/store.js';
import { COLLECTIONS } from '../../js/core/schema.js';
import { loadDemo } from '../../js/dev/demo.js';

test('settings-util: time zones are grouped, include extras and carry offsets', () => {
  const groups = timeZoneGroups({ extra: ['America/New_York', 'Not/AZone'], now: Date.parse('2026-01-15T12:00:00Z') });
  const flat = groups.flatMap((g) => g.zones.map((z) => z.value));
  assert.ok(flat.includes('America/New_York'));
  assert.ok(flat.includes('UTC'));
  assert.ok(!flat.includes('Not/AZone'));
  assert.equal(new Set(flat).size, flat.length, 'no duplicates');
  const ny = groups.find((g) => g.group === 'America').zones.find((z) => z.value === 'America/New_York');
  assert.equal(ny.label, 'New York · UTC−05:00');
  assert.equal(groups[groups.length - 1].group, 'Other', 'zones without a region come last');
  const small = timeZoneGroups({ list: ['Europe/Paris', 'Asia/Tokyo'], now: Date.parse('2026-07-01T00:00:00Z') });
  assert.deepEqual(small.map((g) => g.group), ['Asia', 'Europe', 'Other']);
  assert.equal(zoneOffsetLabel('Asia/Kolkata', Date.parse('2026-07-01T00:00:00Z')), 'UTC+05:30');
  assert.ok(isValidZone('Europe/Berlin') && !isValidZone('') && !isValidZone('Mars/Base'));
});

test('settings-util: height split/join', () => {
  assert.deepEqual(splitHeight(71), { ft: 5, inch: 11 });
  assert.deepEqual(splitHeight(72.5), { ft: 6, inch: 0.5 });
  assert.deepEqual(splitHeight(null), { ft: null, inch: null });
  assert.equal(joinHeight(5, 11), 71);
  assert.equal(joinHeight(6, null), 72);
  assert.equal(joinHeight(null, null), null);
  assert.equal(joinHeight(5, 10.5), 70.5);
});

test('settings-util: profile and target validation', () => {
  assert.deepEqual(profileErrors({ ft: 5, inch: 9, birthYear: 1990, goalWeightLow: 160, goalWeightHigh: 170, goalRateLbWk: 0.3 }, { year: 2026 }), {});
  const e = profileErrors({ ft: 9, inch: 12, birthYear: 2024, goalWeightLow: 200, goalWeightHigh: 190, goalRateLbWk: 5 }, { year: 2026 });
  assert.ok(e.heightFt && e.heightIn && e.birthYear && e.goalWeightHigh && e.goalRateLbWk);
  assert.deepEqual(profileErrors({ ft: null, inch: null, birthYear: null, goalWeightLow: null, goalWeightHigh: null, goalRateLbWk: null }), {});
  assert.deepEqual(targetsErrors({ kcal: 3000, proteinG: 170, proteinPerLb: 0.9, fatPct: 27, fiberG: 35, surplusKcal: 250, sleepTargetH: 8, deepWorkTargetH: 4 }), {});
  const t = targetsErrors({ kcal: 100, fatPct: 80, sleepTargetH: 2 });
  assert.ok(t.kcal && t.fatPct && t.sleepTargetH);
  assert.deepEqual(targetsErrors({ kcal: null }), {});
});

test('settings-util: passphrase strength matches setup thresholds', () => {
  assert.equal(strengthLevel(0), 0);
  assert.equal(strengthLevel(30), 1);
  assert.equal(strengthLevel(40), 2);
  assert.equal(strengthLevel(55), 3);
  assert.equal(strengthLevel(70), 4);
  assert.ok(strengthLevel(passphraseBits('correct horse battery staple lamp')) >= 3);
  assert.ok(strengthLevel(passphraseBits('hunter2')) < 3);
});

test('settings-util: storage stats from a store', () => {
  const store = createStore({ owner: 'app' });
  loadDemo(store, { today: '2026-09-26', tz: 'America/New_York', days: 20 });
  store.create('journal', { id: 'gone', date: '2026-09-20', text: 'x' });
  store.remove('journal', 'gone');
  const st = collectionStats(store);
  assert.ok(st.rows.length > 5);
  assert.equal(st.shards, store.shardPaths().length);
  const j = st.rows.find((r) => r.name === 'journal');
  assert.equal(j.deleted, 1);
  assert.equal(st.rows.find((r) => r.name === 'meals').owner, 'both');
  assert.equal(st.rows.find((r) => r.name === 'whoopSleep').owner, 'server');
  for (let i = 1; i < st.rows.length; i++) assert.ok(st.rows[i - 1].live >= st.rows[i].live, 'largest first');
  for (const name of Object.keys(COLLECTIONS)) assert.ok(COLLECTION_LABELS[name], name);
});

test('settings-util: rules, calendars, secrets, misc', () => {
  assert.equal(backupFileName('2026-09-26'), 'forge-backup-2026-09-26.json');
  const open = openSuggestions([{ text: '  protein at EVERY meal,  30–50 g' }]);
  assert.equal(open.length, RULE_SUGGESTIONS.length - 1);
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveItem(list, 'c', -1).map((x) => x.id), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(list, 'a', -1).map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(normalizeCalendarId('  me@gmail.com '), 'me@gmail.com');
  assert.equal(normalizeCalendarId('https://calendar.google.com/calendar/embed?src=abc%40group.calendar.google.com&ctz=UTC'), 'abc@group.calendar.google.com');
  assert.ok(isCalendarId('abc@group.calendar.google.com'));
  assert.ok(!isCalendarId('primary'));
  assert.match(calendarIdIssue('primary'), /service account/);
  assert.equal(calendarIdIssue('me@gmail.com'), '');
  assert.ok(calendarIdIssue('not an id'));
  assert.equal(maskKey('sk-ant-api03-abcdefghijklmnop-XYZ9'), 'sk-ant-…XYZ9');
  assert.equal(maskKey(''), '');
  assert.ok(SECRETS.find((s) => s.name === 'FORGE_DATA_KEY').required);
});

test('settings-shell: start screen only for an empty route; idle timer', () => {
  assert.equal(startRedirect('', 'plan'), '#/plan');
  assert.equal(startRedirect('#', 'fuel'), '#/fuel');
  assert.equal(startRedirect('#/', 'insights'), '#/insights');
  assert.equal(startRedirect('#/today', 'plan'), null, 'explicit routes are respected');
  assert.equal(startRedirect('#/settings/integrations', 'plan'), null);
  assert.equal(startRedirect('', 'today'), null);
  assert.equal(startRedirect('', 'bogus'), null);
  assert.equal(idleExpired(0, 5 * 60000, 5), true);
  assert.equal(idleExpired(0, 5 * 60000 - 1, 5), false);
  assert.equal(idleExpired(0, 1e12, 0), false, 'off');
  assert.equal(idleExpired(0, 1e12, null), false);
});
