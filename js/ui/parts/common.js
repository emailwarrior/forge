// Small cross-screen helpers and components.
import { html, useState } from '../../vendor/preact-htm.js';
import { useApp, useVersion } from '../ctx.js';
import { Icon, IconButton } from '../kit.js';
import { hashId } from '../../core/util.js';
import { quoteForDate } from '../../data/quotes.js';

/** Soft-delete a record with an Undo toast. */
export function removeWithUndo(app, coll, id, what = 'Entry') {
  app.store.remove(coll, id);
  app.toast(`${what} deleted`, { action: { label: 'Undo', onClick: () => app.store.restore(coll, id) } });
}

/** Saved-quote id (same rule as the v2 migration). */
export const quoteId = (text, who) => hashId(text + '|' + (who || ''));

/** Quote of the day with author bio (tap the name) and save toggle: { date } */
export function QuoteCard({ date }) {
  const app = useApp(); useVersion(['savedQuotes']);
  const q = quoteForDate(date);
  const id = quoteId(q.text, q.who);
  const saved = app.store.get('savedQuotes', id);
  const [bio, setBio] = useState(false);
  const toggle = () => {
    if (saved) { app.store.remove('savedQuotes', id); app.toast('Removed from saved quotes'); }
    else { app.store.upsert('savedQuotes', id, { text: q.text, who: q.who, savedAt: Date.now(), _d: null }); app.toast('Saved to Journal → Quotes'); } // _d: null re-saves a previously removed quote (same id)
  };
  return html`<div class="card quote">
    <div class="row between top" style="gap:12px">
      <div class="q grow">“${q.text}”</div>
      <${IconButton} icon=${saved ? 'starFill' : 'star'} label=${saved ? 'Unsave quote' : 'Save quote'} sm onClick=${toggle} style=${saved ? 'color:var(--accent)' : ''} />
    </div>
    <div class="by">— <button type="button" class="who" title=${q.bio} onClick=${() => setBio(!bio)}>${q.who}</button></div>
    ${bio && q.bio ? html`<div class="xs dim" style="margin-top:8px"><${Icon} name="info" size=${12} /> ${q.bio}</div>` : null}
  </div>`;
}
