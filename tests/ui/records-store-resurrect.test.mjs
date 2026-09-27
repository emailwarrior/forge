// Fixed-id records (savedQuotes = hash of the quote, snapshots = 'YYYY-MM') are removed with a tombstone.
// Saving the same id again must bring the record back: upsert and create revive; update does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';

test('records/store: re-saving a removed fixed-id record revives it (upsert/create)', () => {
  const s = createStore({ owner: 'app' });
  s.upsert('savedQuotes', 'q1', { text: 'a', who: 'b', savedAt: 1 });
  s.remove('savedQuotes', 'q1');
  s.upsert('savedQuotes', 'q1', { text: 'a', who: 'b', savedAt: 2 });
  assert.equal(s.get('savedQuotes', 'q1').savedAt, 2, 'upsert revives');
  s.upsert('savedQuotes', 'q1', { text: 'a', who: 'b', savedAt: 3, _d: null });
  assert.equal(s.get('savedQuotes', 'q1').savedAt, 3);

  s.create('snapshots', { id: '2026-09', month: '2026-09', gross: 1, items: [] });
  s.remove('snapshots', '2026-09');
  s.create('snapshots', { id: '2026-09', month: '2026-09', gross: 2, items: [] });
  assert.equal(s.get('snapshots', '2026-09').gross, 2, 'create resurrects');
  s.create('snapshots', { id: '2026-09', month: '2026-09', gross: 3, items: [] });
  assert.equal(s.get('snapshots', '2026-09').gross, 3, 'create updates a live record');
});
