// Journal UI logic (pure): tag normalization, tag counts, search/filter, grouping by date.
// Tests: tests/ui/records-journal.test.mjs.

/** "#Deep Work " → "deep-work" (lowercase, dashes, max 32 chars); '' when nothing usable. */
export function normalizeTag(s) {
  return String(s ?? '').trim().replace(/^#+/, '').toLowerCase().replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

/** Unique normalized tags of one entry. */
export function entryTags(entry) {
  return [...new Set(((entry && entry.tags) || []).map(normalizeTag).filter(Boolean))];
}

/** Every tag with its use count: most used first, then alphabetical. */
export function allTags(entries) {
  const m = new Map();
  for (const e of entries || []) for (const t of entryTags(e)) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * Filter entries: every query word must appear in the text or a tag (case/accent-insensitive);
 * with tags selected, an entry must carry at least one of them. Newest first.
 */
export function filterEntries(entries, { query = '', tags = [] } = {}) {
  const words = fold(query).split(/\s+/).map((w) => w.replace(/^#/, '')).filter(Boolean);
  const want = new Set((tags || []).map(normalizeTag).filter(Boolean));
  const out = (entries || []).filter((e) => {
    if (!e || e._d) return false;
    const et = entryTags(e);
    if (want.size && !et.some((t) => want.has(t))) return false;
    if (!words.length) return true;
    const hay = fold(e.text) + ' ' + et.join(' ');
    return words.every((w) => hay.includes(w));
  });
  return sortEntries(out);
}

const when = (e) => { const t = Date.parse(e.at || ''); return Number.isFinite(t) ? t : 0; };
/** Newest first: by date, then instant. */
export function sortEntries(entries) {
  return (entries || []).slice().sort((a, b) => (a.date === b.date ? when(b) - when(a) : a.date < b.date ? 1 : -1));
}

/** [{ date, entries }] newest date first (entries keep the newest-first order). */
export function groupByDate(entries) {
  const out = []; let cur = null;
  for (const e of sortEntries(entries)) {
    if (!cur || cur.date !== e.date) { cur = { date: e.date, entries: [] }; out.push(cur); }
    cur.entries.push(e);
  }
  return out;
}
