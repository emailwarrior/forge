// Journal (#/journal[?tab=quotes]): entries (search, tag filter, grouped by date, tap to edit) and saved quotes.
import { html, useState } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useWide } from '../ctx.js';
import { Page, Section, Card, Button, IconButton, Empty, Segmented, Input, Icon, cx } from '../kit.js';
import { fmtDate, fmtTime, localParts, isNum } from '../../core/util.js';
import { PEOPLE } from '../../data/quotes.js';
import { openJournalEntry } from '../actions/journal.js';
import { dateLabel } from '../parts/date.js';
import { allTags, entryTags, filterEntries, groupByDate } from '../parts/records-journal.js';
import { localHm, plural } from '../parts/records-util.js';

export default function Screen({ route }) {
  const app = useApp(); useVersion(['journal', 'savedQuotes']);
  const tab = route.query.tab === 'quotes' ? 'quotes' : 'entries';
  const entries = app.store.all('journal');
  const quotes = app.store.all('savedQuotes');
  const setTab = (t) => app.nav(t === 'quotes' ? '/journal?tab=quotes' : '/journal');
  const sub = [plural(entries.length, 'entry', 'entries'), plural(quotes.length, 'saved quote')].join(' · ');
  return html`<${Page} title="Journal" sub=${sub} wide
    actions=${html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => openJournalEntry(app, {})}>New</${Button}>`}>
    <div class="rec-tabs"><${Segmented} block value=${tab} onValue=${setTab} options=${[{ value: 'entries', label: 'Entries' }, { value: 'quotes', label: 'Saved quotes' }]} label="Journal view" /></div>
    ${tab === 'quotes' ? html`<${Quotes} quotes=${quotes} />` : html`<${Entries} entries=${entries} />`}
  </${Page}>`;
}

/* ---------------------------------------------------------------- entries */
function Entries({ entries }) {
  const app = useApp(); const wide = useWide();
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState([]);
  const today = app.today();
  if (!entries.length) {
    return html`<${Empty} title="No journal entries yet" action=${html`<${Button} variant="primary" icon="plus" onClick=${() => openJournalEntry(app, {})}>Write the first entry</${Button}>`}>
      Capture what happened and why: decisions, how training felt, what moved sleep or focus. Tag entries (sleep, training, business) to filter them later. Entries are encrypted like everything else.
    </${Empty}>`;
  }
  const tagList = allTags(entries);
  const list = filterEntries(entries, { query, tags });
  const groups = groupByDate(list);
  const filtering = !!query.trim() || tags.length > 0;
  const words = query.toLowerCase().split(/\s+/).map((w) => w.replace(/^#/, '')).filter(Boolean);
  const month = today.slice(0, 7);
  const toggleTag = (t) => setTags((l) => (l.includes(t) ? l.filter((x) => x !== t) : [...l, t]));

  const filters = html`<div class="stack sm">
    <div class="rec-search"><${Icon} name="search" size=${16} />
      <${Input} value=${query} onValue=${setQuery} placeholder="Search entries" type="search" aria-label="Search entries" /></div>
    ${tagList.length ? html`<div class="chips rec-tag-chips">${tagList.map((t) => html`<button type="button" class="chip" aria-pressed=${String(tags.includes(t.tag))} onClick=${() => toggleTag(t.tag)}>
      #${t.tag} <span class="mono xs muted">${t.count}</span></button>`)}</div>` : null}
    <div class="row between xs muted">
      <span>${filtering ? `${list.length} of ${plural(entries.length, 'entry', 'entries')}` : `${plural(entries.length, 'entry', 'entries')} · ${entries.filter((e) => (e.date || '').slice(0, 7) === month).length} this month`}</span>
      ${filtering ? html`<button type="button" class="rec-link" onClick=${() => { setQuery(''); setTags([]); }}>Clear filters</button>` : null}
    </div>
  </div>`;

  const body = groups.length ? html`<div class="stack lg">${groups.map((g) => html`<${Section} title=${dateLabel(g.date, today)} meta=${g.entries.length > 1 ? plural(g.entries.length, 'entry', 'entries') : null}>
      <div class="card flush rec-entries">${g.entries.map((e) => html`<${EntryRow} entry=${e} words=${words} />`)}</div>
    </${Section}>`)}</div>`
    : html`<${Empty} title="No matching entries">Try fewer words or clear the tag filter.</${Empty}>`;

  if (wide) return html`<div class="rec-split"><div class="card rec-sticky">${filters}</div>${body}</div>`;
  return html`<div class="stack">${filters}${body}</div>`;
}

function EntryRow({ entry, words }) {
  const app = useApp(); const tz = app.dv.tz;
  const hm = localHm(entry.at, tz);
  const tags = entryTags(entry);
  return html`<button type="button" class="rec-entry" onClick=${() => openJournalEntry(app, { id: entry.id })}>
    <div class="rec-entry-time mono xs muted">${hm ? fmtTime(hm) : ''}</div>
    <div class="grow stack xs" style="min-width:0">
      <div class="rec-entry-text">${highlight(entry.text || '', words)}</div>
      ${tags.length ? html`<div class="row wrap" style="gap:6px">${tags.map((t) => html`<span class="tag">#${t}</span>`)}</div>` : null}
    </div>
  </button>`;
}

/** Wrap matched words in <mark> (plain strings otherwise; htm escapes everything). */
function highlight(text, words) {
  if (!words.length) return text;
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${esc.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? html`<mark class="rec-mark">${part}</mark>` : part));
}

/* ----------------------------------------------------------------- quotes */
function Quotes({ quotes }) {
  const app = useApp();
  const [open, setOpen] = useState(() => new Set());
  if (!quotes.length) {
    return html`<${Empty} title="No saved quotes" action=${html`<${Button} onClick=${() => app.nav('/today')}>Open Today</${Button}>`}>
      Tap the star on the quote of the day on Today to keep it here, with a short bio of who said it.
    </${Empty}>`;
  }
  const list = quotes.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const remove = (q) => {
    app.store.remove('savedQuotes', q.id);
    app.toast('Removed from saved quotes', { action: { label: 'Undo', onClick: () => app.store.restore('savedQuotes', q.id) } });
  };
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return html`<div class="rec-quotes">${list.map((q) => {
    const bio = PEOPLE[q.who] || '';
    const savedYmd = isNum(q.savedAt) ? localParts(q.savedAt, app.dv.tz).ymd : null;
    return html`<div class="card quote">
      <div class="row between top" style="gap:12px">
        <div class="q grow">“${q.text}”</div>
        <${IconButton} icon="trash" label="Remove quote" sm onClick=${() => remove(q)} />
      </div>
      <div class="by row between wrap" style="gap:8px">
        <span>— ${bio ? html`<button type="button" class="who" aria-expanded=${String(open.has(q.id))} onClick=${() => toggle(q.id)}>${q.who || 'Unknown'}</button>` : q.who || 'Unknown'}</span>
        ${savedYmd ? html`<span class="xs muted">Saved ${fmtDate(savedYmd, { dow: false, year: savedYmd.slice(0, 4) !== app.today().slice(0, 4) })}</span>` : null}
      </div>
      ${bio && open.has(q.id) ? html`<div class=${cx('xs dim')} style="margin-top:8px">${bio}</div>` : null}
    </div>`;
  })}</div>`;
}
