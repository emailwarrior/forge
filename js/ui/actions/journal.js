// OWNER: UI-E (Records). Contract (docs/UI_GUIDE.md §6).
// openJournalEntry: create/edit a `journal` entry (text, tags, date/time). Resolves with the entry id.
import { html, useState, useRef, useEffect } from '../../vendor/preact-htm.js';
import { useApp, useVersion } from '../ctx.js';
import { Button, Chips, Field, Input, SheetFoot, SheetHead, Textarea, TimeInput, Notice } from '../kit.js';
import { isoWithOffset, zonedToMs, localParts } from '../../core/util.js';
import { removeWithUndo } from '../parts/common.js';
import { dateLabel } from '../parts/date.js';
import { allTags, entryTags, normalizeTag } from '../parts/records-journal.js';
import { localHm } from '../parts/records-util.js';
import { DateInput, Group } from '../parts/records-ui.js';

/** openJournalEntry(app, { date, id }) → Promise<string|undefined> (journal id) */
export function openJournalEntry(app, { date, id } = {}) {
  const d = date || app.today();
  return app.sheet(({ close }) => html`<${JournalSheet} date=${d} id=${id} close=${close} />`);
}

function JournalSheet({ date, id, close }) {
  const app = useApp(); useVersion(['journal']);
  const tz = app.dv.tz; const today = app.today();
  const existing = id ? app.store.get('journal', id) : null;
  const [text, setText] = useState(existing ? existing.text || '' : '');
  const [tags, setTags] = useState(existing ? entryTags(existing) : []);
  const [newTag, setNewTag] = useState('');
  const [d, setD] = useState((existing && existing.date) || date || today);
  const [hm, setHm] = useState((existing && localHm(existing.at, tz)) || localParts(Date.now(), tz).hm);
  const [err, setErr] = useState('');
  const ref = useRef(null);
  useEffect(() => { const t = setTimeout(() => { const el = ref.current && ref.current.querySelector('textarea'); if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); } }, 60); return () => clearTimeout(t); }, []);

  const known = allTags(app.store.all('journal')).map((t) => t.tag);
  const options = [...new Set([...known, ...tags])].map((t) => ({ value: t, label: '#' + t }));
  const addTag = () => {
    const t = normalizeTag(newTag);
    if (!t) return;
    setTags((l) => (l.includes(t) ? l : [...l, t]));
    setNewTag('');
  };

  const save = () => {
    const body = text.trim();
    if (!body) { setErr('Write something first.'); return; }
    if (!d) { setErr('Pick a date.'); return; }
    const pending = normalizeTag(newTag);
    const fields = { date: d, at: isoWithOffset(zonedToMs(d, hm || '12:00', tz), tz), text: body, tags: pending && !tags.includes(pending) ? [...tags, pending] : tags };
    if (existing) {
      app.store.update('journal', existing.id, fields);
      app.toast('Entry updated');
      close(existing.id);
    } else {
      const rec = app.store.create('journal', fields);
      app.toast('Saved to journal');
      close(rec.id);
    }
  };
  const del = () => { removeWithUndo(app, 'journal', existing.id, 'Entry'); close(); };
  const onKey = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } };

  return html`<div class="stack" ref=${ref} onKeyDown=${onKey}>
    <${SheetHead} title=${existing ? 'Edit entry' : 'Journal entry'} onClose=${() => close()} />
    <div class="xs muted rec-sheet-sub">${dateLabel(d || today, today)}</div>
    <${Textarea} value=${text} onValue=${(v) => { setText(v); if (err) setErr(''); }} rows="8" class="rec-journal-text"
      placeholder="What happened, what you decided, what moved the numbers." aria-label="Entry text" />
    <${Group} label="Tags">
      <div class="stack sm">
        ${options.length ? html`<${Chips} multi options=${options} value=${tags} onValue=${setTags} />` : null}
        <div class="row" style="gap:8px">
          <${Input} sm value=${newTag} onValue=${setNewTag} placeholder=${options.length ? 'New tag' : 'Add a tag, e.g. sleep'} autocapitalize="off"
            onKeyDown=${(e) => { if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); addTag(); } }} />
          <${Button} size="sm" icon="plus" onClick=${addTag} disabled=${!normalizeTag(newTag)}>Add</${Button}>
        </div>
      </div>
    </${Group}>
    <div class="grid two">
      <${Field} label="Date"><${DateInput} value=${d} onValue=${setD} /></${Field}>
      <${Field} label="Time"><${TimeInput} value=${hm} onValue=${setHm} /></${Field}>
    </div>
    ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
    <${SheetFoot}>
      ${existing ? html`<${Button} variant="danger" icon="trash" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save} disabled=${!text.trim()}>Save</${Button}>
    </${SheetFoot}>
  </div>`;
}
