// Plan → sheets: "Draft my day" (suggestDay), day templates (save / apply / delete) and
// "Copy from…" another date. Every bulk add skips blocks that overlap the day's existing plan
// and offers Undo.
import { html, useState, useMemo } from '../../../vendor/preact-htm.js';
import { useApp, useVersion } from '../../ctx.js';
import { SheetHead, SheetFoot, Field, Input, Button, IconButton, Check, Chips, Notice, Empty, Icon, cx } from '../../kit.js';
import { removeWithUndo } from '../../parts/common.js';
import { CatSwatch, catLabel } from '../../parts/day-ui.js';
import { blockSpan, blocksOverlap, mergeDraft, planFields, templateBlocks, fmtSpan, fmtMinutes } from '../../parts/day-model.js';
import { suggestDay } from '../../../analytics/index.js';
import { addDays, dayOfWeek, dowName, fmtDate, relDay } from '../../../core/util.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Create plan records for `blocks` on `date`; toast with Undo. → created ids */
function addBlocks(app, date, blocks, message, extra) {
  const ids = blocks.map((b) => app.store.create('plan', planFields(date, b, extra)).id);
  app.toast(message(ids.length), ids.length ? { action: { label: 'Undo', onClick: () => { for (const id of ids) app.store.remove('plan', id); } } } : {});
  return ids;
}
const skippedText = (n) => (n ? ` · skipped ${n} that overlapped existing blocks` : '');

function BlockLine({ b, clash, lead }) {
  const sp = blockSpan(b);
  return html`<div class=${cx('day-pblock', clash && 'clash')}>
    ${lead || null}
    <span class="tm mono">${sp ? fmtSpan(sp.start, sp.end) : '—'}</span>
    <${CatSwatch} category=${b.category} />
    <span class="grow ellipsis">${b.title || catLabel(b.category)}</span>
    ${clash ? html`<span class="tag ink-warn">overlaps</span>` : null}
  </div>`;
}

/* ------------------------------------------------------------ draft */
export function openDraft(app, date) {
  return app.sheet(({ close }) => html`<${DraftSheet} date=${date} close=${close} />`, { wide: true });
}

function DraftSheet({ date, close }) {
  const app = useApp(); useVersion(['plan']);
  const draft = useMemo(() => suggestDay(app.dv, date), [date]);
  const existing = app.dv.plan(date);
  const [off, setOff] = useState(() => new Set());
  const clash = draft.blocks.map((b) => existing.some((x) => blocksOverlap(x, b)));
  const { add, skipped } = mergeDraft(existing, draft.blocks.filter((_, i) => !off.has(i)));
  const toggle = (i) => setOff((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const basis = draft.basis === 'template' ? 'Starts from your most recently edited day template'
    : draft.basis === 'history' ? `Starts from your usual ${dowName(dayOfWeek(date))} blocks` : 'No template or recent history — focus window only';
  const apply = () => { const ids = addBlocks(app, date, add, (n) => `Added ${plural(n, 'block')}${skippedText(skipped.length)}`); close(ids.length); };
  return html`<div class="stack">
    <${SheetHead} title=${'Draft · ' + relDay(date, app.today())} onClose=${() => close()} />
    <div class="small dim">${basis}. Recovery-aware: ${draft.mode} mode${draft.mode === 'recover' ? ' swaps hard training for zone 2 or mobility' : ''}; never overlaps calendar events.</div>
    ${draft.blocks.length ? html`<div class="day-draft">
      ${draft.blocks.map((b, i) => html`<div key=${i} class=${cx('day-draft-row', off.has(i) && 'off')}>
        <${Check} state=${!off.has(i)} onClick=${() => toggle(i)} label=${'Include ' + (b.title || 'block')} />
        <div class="grow" style="min-width:0">
          <${BlockLine} b=${b} clash=${clash[i]} />
          <div class="xs muted" style="margin-top:2px">${b.reason}</div>
        </div>
      </div>`)}
    </div>` : html`<${Empty} title="No draft for this day">Save a typical day as a template (Templates → Save), or plan a few ${dowName(dayOfWeek(date))}s — drafts start from those.</${Empty}>`}
    ${draft.notes.length ? html`<div class="day-flags">${draft.notes.map((n) => html`<div class="f"><${Icon} name="info" size=${14} /><span>${n}</span></div>`)}</div>` : null}
    ${skipped.length ? html`<${Notice} tone="warn">${plural(skipped.length, 'selected block')} overlap${skipped.length === 1 ? 's' : ''} the existing plan and will be skipped.</${Notice}>` : null}
    <${SheetFoot}>
      <${Button} onClick=${() => close()}>Cancel</${Button}>
      <${Button} variant="primary" disabled=${!add.length} onClick=${apply}>${add.length ? `Add ${plural(add.length, 'block')}` : 'Nothing to add'}</${Button}>
    </${SheetFoot}>
  </div>`;
}

/* -------------------------------------------------------- templates */
export function openTemplates(app, date) {
  return app.sheet(({ close }) => html`<${TemplatesSheet} date=${date} close=${close} />`, { wide: true });
}

function spanOf(blocks) {
  const sp = (blocks || []).map(blockSpan).filter(Boolean);
  if (!sp.length) return null;
  return { start: Math.min(...sp.map((s) => s.start)), end: Math.max(...sp.map((s) => s.end)), total: sp.reduce((t, s) => t + s.end - s.start, 0) };
}

function TemplatesSheet({ date, close }) {
  const app = useApp(); useVersion(['templates', 'plan']);
  const list = app.dv.templates('day').slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const existing = app.dv.plan(date);
  const apply = (t) => {
    const { add, skipped } = mergeDraft(existing, t.blocks || []);
    if (!add.length) { app.toast(`Nothing added — every block of “${t.name}” overlaps this day’s plan`); return; }
    const ids = addBlocks(app, date, add, (n) => `Applied “${t.name}” · ${plural(n, 'block')}${skippedText(skipped.length)}`, { templateId: t.id });
    close(ids.length);
  };
  const save = () => app.sheet(({ close: c2 }) => html`<${SaveTemplateSheet} date=${date} close=${c2} />`);
  return html`<div class="stack">
    <${SheetHead} title="Day templates" onClose=${() => close()} />
    <div class="card inset tight row between wrap" style="gap:10px">
      <div class="grow" style="min-width:200px"><div class="small strong">Save this day</div>
        <div class="xs muted">${existing.length ? `${plural(existing.length, 'block')} on ${fmtDate(date)} become a reusable day.` : 'Add blocks to this day first, then save them as a template.'}</div></div>
      <${Button} size="sm" icon="save" disabled=${!existing.length} onClick=${save}>Save as template</${Button}>
    </div>
    <div class="eyebrow" style="margin-top:4px">Apply to ${relDay(date, app.today())}</div>
    ${list.length ? html`<div class="list day-tpl-list">${list.map((t) => {
      const sp = spanOf(t.blocks);
      return html`<div key=${t.id} class="list-row">
        <div class="grow" style="min-width:0"><div class="title ellipsis">${t.name || 'Untitled'}</div>
          <div class="meta">${plural((t.blocks || []).length, 'block')}${sp ? ` · ${fmtSpan(sp.start, sp.end)} · ${fmtMinutes(sp.total)} planned` : ''}</div></div>
        <div class="row" style="gap:4px">
          <${Button} size="sm" onClick=${() => apply(t)}>Apply</${Button}>
          <${IconButton} icon="trash" label=${'Delete template ' + (t.name || '')} sm onClick=${() => removeWithUndo(app, 'templates', t.id, 'Template')} />
        </div>
      </div>`;
    })}</div>` : html`<${Empty} title="No day templates yet">Build a typical day on the schedule, then save it here. “Draft my day” starts from your most recently edited template.</${Empty}>`}
    <div class="xs muted">Applying adds blocks that do not overlap the day’s existing plan.</div>
  </div>`;
}

function SaveTemplateSheet({ date, close }) {
  const app = useApp();
  const blocks = useMemo(() => templateBlocks(app.dv.plan(date)), [date]);
  const [name, setName] = useState(dayOfWeek(date) >= 5 ? 'Weekend' : 'Weekday');
  const [error, setError] = useState(null);
  const save = async () => {
    const n = name.trim();
    if (!n) return setError('Name the template.');
    const same = app.dv.templates('day').find((t) => String(t.name || '').trim().toLowerCase() === n.toLowerCase());
    if (same) {
      const ok = await app.confirm({ title: `Replace “${same.name}”?`, message: `Its ${plural((same.blocks || []).length, 'block')} will be replaced by the ${plural(blocks.length, 'block')} of ${fmtDate(date)}.`, confirmLabel: 'Replace' });
      if (!ok) return;
      app.store.update('templates', same.id, { blocks });
      app.toast(`Updated template “${same.name}” · ${plural(blocks.length, 'block')}`);
      close(same.id);
      return;
    }
    const rec = app.store.create('templates', { kind: 'day', name: n, blocks });
    app.toast(`Saved template “${n}” · ${plural(blocks.length, 'block')}`);
    close(rec.id);
  };
  return html`<div class="stack">
    <${SheetHead} title="Save as template" onClose=${() => close()} />
    <${Field} label="Name" error=${error}><${Input} value=${name} onValue=${(v) => { setName(v); setError(null); }} maxlength="60" aria-label="Template name" /></${Field}>
    <div class="day-draft">${blocks.map((b, i) => html`<${BlockLine} key=${i} b=${b} />`)}</div>
    <div class="xs muted">Times, titles, categories and reminder flags are saved; statuses and notes are not.</div>
    <${SheetFoot}>
      <${Button} onClick=${() => close()}>Cancel</${Button}>
      <${Button} variant="primary" disabled=${!blocks.length} onClick=${save}>Save template</${Button}>
    </${SheetFoot}>
  </div>`;
}

/* ------------------------------------------------------ copy from… */
export function openCopyFrom(app, date) {
  return app.sheet(({ close }) => html`<${CopyFromSheet} date=${date} close=${close} />`, { wide: true });
}

function CopyFromSheet({ date, close }) {
  const app = useApp(); useVersion(['plan']);
  const [src, setSrc] = useState(addDays(date, -7));
  const blocks = /^\d{4}-\d{2}-\d{2}$/.test(src) ? app.dv.plan(src) : [];
  const existing = app.dv.plan(date);
  const { add, skipped } = mergeDraft(existing, blocks);
  const quick = [
    { value: addDays(date, -7), label: `Last ${dowName(dayOfWeek(date))}` },
    { value: addDays(date, -1), label: 'Day before' },
    { value: addDays(date, -14), label: '2 weeks ago' },
  ];
  const copy = () => { const ids = addBlocks(app, date, add, (n) => `Copied ${plural(n, 'block')} from ${fmtDate(src)}${skippedText(skipped.length)}`); close(ids.length); };
  return html`<div class="stack">
    <${SheetHead} title=${'Copy a plan to ' + relDay(date, app.today())} onClose=${() => close()} />
    <${Chips} options=${quick} value=${src} onValue=${setSrc} />
    <${Field} label="From"><${Input} type="date" value=${src} onValue=${setSrc} aria-label="Copy from date" /></${Field}>
    ${blocks.length ? html`<div class="day-draft">${blocks.map((b) => html`<${BlockLine} key=${b.id} b=${b} clash=${existing.some((x) => blocksOverlap(x, b))} />`)}</div>`
      : html`<div class="small dim">${fmtDate(src)} has no plan blocks.</div>`}
    ${skipped.length ? html`<div class="xs muted">${plural(skipped.length, 'block')} overlap this day’s plan and will be skipped.</div>` : null}
    <div class="xs muted">Copies start as planned; statuses, actual minutes and notes are not copied.</div>
    <${SheetFoot}>
      <${Button} onClick=${() => close()}>Cancel</${Button}>
      <${Button} variant="primary" disabled=${!add.length} onClick=${copy}>${add.length ? `Copy ${plural(add.length, 'block')}` : 'Nothing to copy'}</${Button}>
    </${SheetFoot}>
  </div>`;
}
