import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTag, entryTags, allTags, filterEntries, groupByDate, sortEntries } from '../../js/ui/parts/records-journal.js';

const E = [
  { id: '1', date: '2026-09-20', at: '2026-09-20T22:05:00-04:00', text: 'Sleep was much better after moving dinner earlier.', tags: ['sleep', 'Nutrition'] },
  { id: '2', date: '2026-09-23', at: '2026-09-23T21:50:00-04:00', text: 'Heavy squat day felt strong. Keep the 7:30 deep work block.', tags: ['training', '#Deep Work'] },
  { id: '3', date: '2026-09-23', at: '2026-09-23T07:10:00-04:00', text: 'Café meeting ran long; skipped the AM stack.', tags: [] },
  { id: '4', date: '2026-09-24', at: '2026-09-24T08:00:00-04:00', text: 'Deleted', tags: ['sleep'], _d: 1 },
];

test('records/journal: tags normalize and count', () => {
  assert.equal(normalizeTag('  #Deep  Work '), 'deep-work');
  assert.equal(normalizeTag('sleep_quality!'), 'sleep-quality');
  assert.equal(normalizeTag('###'), '');
  assert.equal(normalizeTag('a'.repeat(40)).length, 32);
  assert.deepEqual(entryTags({ tags: ['Sleep', 'sleep', ''] }), ['sleep']);
  assert.deepEqual(allTags(E.slice(0, 3).concat({ tags: ['sleep'] })), [
    { tag: 'sleep', count: 2 }, { tag: 'deep-work', count: 1 }, { tag: 'nutrition', count: 1 }, { tag: 'training', count: 1 },
  ]);
});

test('records/journal: search matches all words (text or tags, accent-insensitive); tag filter matches any', () => {
  assert.deepEqual(filterEntries(E, {}).map((e) => e.id), ['2', '3', '1'], 'newest first, deleted excluded');
  assert.deepEqual(filterEntries(E, { query: 'deep block' }).map((e) => e.id), ['2']);
  assert.deepEqual(filterEntries(E, { query: 'cafe' }).map((e) => e.id), ['3']);
  assert.deepEqual(filterEntries(E, { query: '#nutrition' }).map((e) => e.id), ['1'], 'tags are searchable');
  assert.deepEqual(filterEntries(E, { tags: ['Sleep', 'training'] }).map((e) => e.id), ['2', '1']);
  assert.deepEqual(filterEntries(E, { tags: ['sleep'], query: 'squat' }).map((e) => e.id), []);
});

test('records/journal: grouping by date keeps newest first', () => {
  const g = groupByDate(E.slice(0, 3));
  assert.deepEqual(g.map((x) => x.date), ['2026-09-23', '2026-09-20']);
  assert.deepEqual(g[0].entries.map((e) => e.id), ['2', '3']);
  assert.deepEqual(sortEntries([]), []);
});
