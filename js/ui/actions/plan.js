// OWNER: UI-A (Day). Contract (docs/UI_GUIDE.md §6).
// Plan block sheet: create/edit a `plan` record (title, category, start/end, status, actual
// minutes, reminder, calendar, note) with delete + undo. Resolves with the block id.
import { html, useState, useMemo } from '../../vendor/preact-htm.js';
import { useApp, useVersion } from '../ctx.js';
import { SheetHead, SheetFoot, Field, Input, NumberInput, TimeInput, Textarea, Chips, Segmented, ToggleRow, Button, Empty, Notice } from '../kit.js';
import { removeWithUndo } from '../parts/common.js';
import { Group, CATEGORY_OPTIONS, catLabel } from '../parts/day-ui.js';
import { blockSpan, spansOverlap, blockTimeError, addMinutes, nextSlot, changedFields, fmtSpan, fmtMinutes } from '../parts/day-model.js';
import { localParts, hmToMin, minToHm, isNum, relDay } from '../../core/util.js';

const STATUS = [{ value: 'planned', label: 'Planned' }, { value: 'done', label: 'Done' }, { value: 'partial', label: 'Partial' }, { value: 'skipped', label: 'Skipped' }];
const DURATIONS = [[30, '30m'], [45, '45m'], [60, '1h'], [90, '1h 30m'], [120, '2h']];
const KEYS = ['title', 'category', 'start', 'end', 'status', 'actualMin', 'reminder', 'calendar', 'note'];

/** openBlock(app, { date, id, start, end, category }) → Promise<string|undefined> (plan block id) */
export function openBlock(app, { date, id, start, end, category } = {}) {
  const rec = id ? app.store.get('plan', id) : null;
  const d = (rec && rec.date) || date || app.today();
  return app.sheet(({ close }) => html`<${BlockSheet} date=${d} id=${id || null} start=${start} end=${end} category=${category} close=${close} />`);
}

function initial(app, date, rec, { start, end, category }) {
  if (rec) {
    return { title: rec.title || '', category: rec.category || 'personal', start: rec.start || '', end: rec.end || '', status: rec.status || 'planned',
      actualMin: isNum(rec.actualMin) ? rec.actualMin : null, reminder: !!rec.reminder, calendar: rec.calendar !== false, note: rec.note || '' };
  }
  let slot;
  if (start) slot = { start, end: end || addMinutes(start, 60) };
  else if (date === app.today()) slot = nextSlot(localParts(Date.now(), app.dv.tz).min);
  else slot = { start: '09:00', end: '10:00' };
  return { title: '', category: category || 'deep', start: slot.start, end: slot.end, status: 'planned', actualMin: null, reminder: false, calendar: true, note: '' };
}

function BlockSheet({ date, id, start, end, category, close }) {
  const app = useApp(); useVersion(['plan', 'calendarEvents']);
  const { store, dv } = app; const today = app.today();
  const rec = id ? store.get('plan', id) : null;
  const [init] = useState(() => initial(app, date, rec, { start, end, category }));
  const [f, setF] = useState(init);
  const [error, setError] = useState(null);
  const set = (k) => (v) => { setError(null); setF((s) => ({ ...s, [k]: v })); };
  const judged = date <= today;
  const timeErr = blockTimeError(f.start, f.end);
  const span = timeErr ? null : blockSpan(f);

  const clashes = useMemo(() => {
    if (!span) return [];
    const blocks = dv.plan(date).filter((b) => b.id !== id).filter((b) => spansOverlap(blockSpan(b), span)).map((b) => b.title || catLabel(b.category));
    const events = dv.eventBlocks(date).filter((e) => e.start < span.end && span.start < e.end).map((e) => e.title || 'Calendar event');
    return [...blocks, ...events];
  }, [date, id, span && span.start, span && span.end, store.version]);

  if (id && !rec) {
    return html`<div class="stack"><${SheetHead} title="Plan block" onClose=${() => close()} /><${Empty} title="Not found">This block was deleted.</${Empty}></div>`;
  }

  const save = () => {
    if (timeErr) return setError(timeErr);
    if (f.actualMin != null && (!isNum(f.actualMin) || f.actualMin < 0 || f.actualMin > 1440)) return setError('Actual minutes should be between 0 and 1,440.');
    const title = (f.title || '').trim() || catLabel(f.category);
    const fields = { ...f, title, status: judged ? f.status : 'planned', actualMin: judged && (f.status === 'done' || f.status === 'partial') ? f.actualMin : null };
    if (rec) {
      const patch = changedFields(init, fields, KEYS);
      if (Object.keys(patch).length) store.update('plan', id, patch);
      app.toast(Object.keys(patch).length ? 'Block updated' : 'No changes');
      close(id);
      return;
    }
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== ''));
    const created = store.create('plan', { date, ...clean });
    app.toast(`Added ${title} · ${fmtSpan(span.start, span.end)}${date !== today ? ' · ' + relDay(date, today) : ''}`);
    close(created.id);
  };
  const del = () => { removeWithUndo(app, 'plan', id, 'Block'); close(); };
  const dur = span ? span.end - span.start : null;

  return html`<div class="stack">
    <${SheetHead} title=${rec ? 'Edit block' : 'New block'} onClose=${() => close()}>
      ${date !== today ? html`<span class="pill">${relDay(date, today)}</span>` : null}
    </${SheetHead}>
    <${Field} label="Title">
      <${Input} value=${f.title} onValue=${set('title')} placeholder=${catLabel(f.category)} maxlength="120" aria-label="Title" />
    </${Field}>
    <${Group} label="Category"><${Chips} options=${CATEGORY_OPTIONS} value=${f.category} onValue=${set('category')} /></${Group}>
    <div class="grid two">
      <${Field} label="Start"><${TimeInput} value=${f.start} onValue=${(v) => {
        // Moving the start keeps the duration (clamped at midnight).
        setError(null);
        setF((s) => {
          const d = blockSpan(s); const m = hmToMin(v);
          return d && m != null ? { ...s, start: v, end: minToHm(Math.min(1440, m + (d.end - d.start))) } : { ...s, start: v };
        });
      }} aria-label="Start time" /></${Field}>
      <${Field} label="End"><${TimeInput} value=${f.end} onValue=${set('end')} aria-label="End time" /></${Field}>
    </div>
    <div class="row wrap" style="gap:6px;margin-top:-4px">
      ${DURATIONS.map(([m, label]) => html`<button type="button" class="chip day-chip-sm" aria-pressed=${String(dur === m)} aria-label=${'Duration ' + label}
        onClick=${() => { const s = hmToMin(f.start); if (s != null) set('end')(minToHm(Math.min(1440, s + m))); }}>${label}</button>`)}
      <span class="xs muted" style="margin-left:auto">${span ? fmtMinutes(dur) : ''}</span>
    </div>
    ${timeErr && (f.start || f.end) ? html`<div class="xs ink-bad">${timeErr}</div>` : null}
    ${clashes.length ? html`<${Notice} tone="warn">Overlaps ${clashes.slice(0, 3).join(', ')}${clashes.length > 3 ? ` and ${clashes.length - 3} more` : ''}.</${Notice}>` : null}
    ${judged ? html`<${Group} label="Status"><${Segmented} block options=${STATUS} value=${f.status} onValue=${set('status')} label="Status" /></${Group}>` : null}
    ${judged && (f.status === 'done' || f.status === 'partial') ? html`<${Field} label="Actual time (optional)" hint=${dur ? `Planned ${fmtMinutes(dur)}` : null}>
      <${NumberInput} value=${f.actualMin} onValue=${set('actualMin')} suffix="min" step="5" min="0" aria-label="Actual minutes" /></${Field}>` : null}
    <div class="stack xs">
      <${ToggleRow} label="Google Calendar" sub="Pushed to the FORGE calendar when Google is connected" checked=${f.calendar} onValue=${set('calendar')} />
      <${ToggleRow} label="Reminder" sub="Alert when the block starts" checked=${f.reminder} onValue=${set('reminder')} />
    </div>
    <${Field} label="Note"><${Textarea} rows="2" value=${f.note} onValue=${set('note')} placeholder="Optional" /></${Field}>
    ${error ? html`<div class="xs ink-bad" role="alert">${error}</div>` : null}
    <${SheetFoot}>
      ${rec ? html`<${Button} variant="danger" icon="trash" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>${rec ? 'Save' : 'Add block'}</${Button}>
    </${SheetFoot}>
  </div>`;
}
