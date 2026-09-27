import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtQty, parseNum, agoText, plural, localHm, syncLine, integrationLine } from '../../js/ui/parts/records-util.js';

test('records/util: quantities and number parsing', () => {
  assert.equal(fmtQty(5000), '5,000');
  assert.equal(fmtQty(2.25), '2.25');
  assert.equal(fmtQty(0.1234), '0.123');
  assert.equal(fmtQty(null), '—');
  assert.equal(parseNum('1,234.5'), 1234.5);
  assert.equal(parseNum(' 2 '), 2);
  assert.equal(parseNum('1,5'), 1.5, 'decimal comma');
  assert.equal(parseNum('.5'), 0.5);
  assert.equal(parseNum('<0.5'), null);
  assert.equal(parseNum('abc'), null);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum(3), 3);
  assert.equal(plural(1, 'entry', 'entries'), '1 entry');
  assert.equal(plural(1200, 'item'), '1,200 items');
});

test('records/util: relative times', () => {
  const tz = 'America/New_York';
  const now = Date.parse('2026-09-26T16:00:00Z'); // 12:00 local
  assert.equal(agoText(now - 20 * 1000, now, tz), 'just now');
  assert.equal(agoText(now - 12 * 60000, now, tz), '12 min ago');
  assert.equal(agoText(now - 5 * 3600000, now, tz), '5 h ago');
  assert.equal(agoText('2026-09-26T01:05:00Z', now, tz), 'Yesterday 9:05 PM');
  assert.equal(agoText('2026-09-20T15:00:00Z', now, tz), 'Sep 20');
  assert.equal(agoText('2025-12-20T15:00:00Z', now, tz), 'Dec 20, 2025');
  assert.equal(agoText(null, now, tz), '—');
  assert.equal(localHm('2026-09-26T07:15:00-04:00', tz), '07:15');
  assert.equal(localHm('', tz), null);
});

test('records/util: sync and integration status lines', () => {
  const tz = 'America/New_York'; const now = Date.parse('2026-09-26T16:00:00Z');
  assert.deepEqual(syncLine({ state: 'idle', pending: 0, lastSyncAt: now - 5 * 60000 }, { now, tz }), { text: 'Synced 5 min ago', tone: 'good' });
  assert.deepEqual(syncLine({ state: 'idle', pending: 2 }, { now, tz }), { text: '2 changes waiting to sync', tone: null });
  assert.equal(syncLine({ state: 'error', error: 'HTTP 401' }, { now, tz }).text, 'Sync issue: HTTP 401');
  assert.equal(syncLine({ state: 'offline', pending: 1 }, { now, tz }).text, 'Offline · 1 change waiting');
  assert.equal(syncLine({ state: 'idle' }, { demo: true }).text, 'Demo mode — nothing is saved');
  assert.deepEqual(integrationLine(null, { now, tz }), { text: 'Not connected', tone: null });
  assert.equal(integrationLine(null, { configured: true, now, tz }).text, 'Connected · waiting for the first sync');
  assert.deepEqual(integrationLine({ lastOkAt: '2026-09-26T15:30:00Z', lastError: null }, { now, tz }), { text: 'Last sync 30 min ago', tone: 'good' });
  assert.deepEqual(integrationLine({ lastOkAt: '2026-09-26T13:00:00Z', lastError: 'token expired' }, { now, tz }), { text: 'Error: token expired · last success 3 h ago', tone: 'bad' });
  assert.equal(integrationLine({ lastRunAt: '2026-09-26T15:59:00Z', lastOkAt: null }, { now, tz }).text, 'Checked 1 min ago · no data yet');
});
