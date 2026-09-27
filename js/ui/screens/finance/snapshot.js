// Monthly snapshot editor sheet (id = 'YYYY-MM'): gross revenue, asset/liability items, note.
// openSnapshotEditor(app, { month }) → Promise<month|undefined>
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion } from '../../ctx.js';
import { Button, Field, IconButton, Input, NumberInput, Select, SheetFoot, SheetHead, Textarea, Notice, KV } from '../../kit.js';
import { netWorth } from '../../../analytics/finance.js';
import { fmtMoney, isNum } from '../../../core/util.js';
import { removeWithUndo } from '../../parts/common.js';
import {
  CATEGORIES, monthLabel, monthOptions, previousSnapshot, copyItems, draftFromSnapshot, emptySnapshot, snapshotPayload, guessCategory,
} from '../../parts/records-finance.js';

export function openSnapshotEditor(app, { month } = {}) {
  return app.sheet(({ close }) => html`<${SnapshotEditor} month=${month || app.today().slice(0, 7)} close=${close} />`, { wide: true });
}

let rid = 0;
const withRid = (items, touched = true) => items.map((it) => ({ ...it, rid: 'i' + (++rid), catTouched: touched }));
const blankRow = (type = 'asset') => ({ name: '', type, value: null, category: type === 'liability' ? 'debt' : 'other', rid: 'i' + (++rid), catTouched: false });

function load(app, month) {
  const s = app.store.get('snapshots', month);
  const d = s ? draftFromSnapshot(s) : emptySnapshot(month);
  return { ...d, items: withRid(d.items) };
}

function SnapshotEditor({ month: initialMonth, close }) {
  const app = useApp(); useVersion(['snapshots', 'settings']);
  const [d, setD] = useState(() => load(app, initialMonth));
  const [err, setErr] = useState('');
  const fin = app.store.setting('finance');
  const snaps = app.store.all('snapshots');
  const existing = app.store.get('snapshots', d.month);
  const prev = previousSnapshot(snaps, d.month);
  const months = [...new Set([...monthOptions(app.today(), 36), ...snaps.map((s) => s.month).filter(Boolean)])].sort().reverse();
  const recorded = new Set(snaps.map((s) => s.month));

  const setMonth = (m) => {
    if (m === d.month) return;
    if (app.store.get('snapshots', m)) setD(load(app, m));
    else setD((x) => ({ ...x, month: m }));
  };
  const setItem = (i, patch) => setD((x) => ({ ...x, items: x.items.map((it, j) => {
    if (j !== i) return it;
    const next = { ...it, ...patch };
    if (!next.catTouched && ('name' in patch || 'type' in patch)) next.category = guessCategory(next.name, next.type);
    return next;
  }) }));
  const addRow = (type) => setD((x) => ({ ...x, items: [...x.items, blankRow(type)] }));
  const removeRow = (i) => setD((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }));
  const copyPrev = async () => {
    if (!prev) return;
    const hasItems = d.items.some((it) => String(it.name || '').trim() || isNum(it.value));
    if (hasItems && !(await app.confirm({ title: `Replace items with ${monthLabel(prev.month)}?`, message: 'The items in this form are replaced by last month’s names, categories and values. Update the values before saving.', confirmLabel: 'Replace' }))) return;
    setD((x) => ({ ...x, items: withRid(copyItems(prev.items)) }));
  };

  const payload = snapshotPayload(d);
  const nw = netWorth(payload, fin);
  const save = () => {
    setErr('');
    if (!payload.items.length && !isNum(payload.gross)) { setErr('Add the month’s gross revenue or at least one balance.'); return; }
    app.store.create('snapshots', { id: d.month, ...payload }); // create also re-saves a month that was deleted earlier
    app.toast(`${existing ? 'Updated' : 'Saved'} ${monthLabel(d.month)} snapshot`);
    close(d.month);
  };
  const del = () => { removeWithUndo(app, 'snapshots', existing.id, `${monthLabel(existing.month)} snapshot`); close(); };

  return html`<div class="stack">
    <${SheetHead} title=${existing ? `Edit ${monthLabel(d.month)}` : 'New monthly snapshot'} onClose=${() => close()} />
    <div class="grid two rec-collapse">
      <${Field} label="Month" hint=${existing ? 'Editing the recorded snapshot for this month.' : null}>
        <${Select} value=${d.month} onValue=${setMonth} options=${months.map((m) => ({ value: m, label: monthLabel(m) + (recorded.has(m) ? ' · recorded' : '') }))} />
      </${Field}>
      <${Field} label="Company gross revenue (month)" hint="Feeds the equity estimate.">
        <${NumberInput} value=${d.gross} onValue=${(v) => setD((x) => ({ ...x, gross: v }))} min="0" step="100" suffix="$" placeholder="0" />
      </${Field}>
    </div>

    <div class="stack sm">
      <div class="row between wrap" style="gap:8px">
        <span class="label-text">Balances</span>
        ${prev ? html`<${Button} size="sm" variant="ghost" icon="copy" onClick=${copyPrev}>Copy ${monthLabel(prev.month, { short: true })} items</${Button}>` : null}
      </div>
      ${d.items.length ? html`<div class="rec-fin-rows">
        <div class="rec-fin-row rec-fin-headrow xs muted hide-sm" aria-hidden="true"><span>Name</span><span>Type</span><span>Category</span><span>Value</span><span></span></div>
        ${d.items.map((it, i) => html`<div class="rec-fin-row" key=${it.rid}>
          <${Input} class="rec-fin-name" value=${it.name} onValue=${(v) => setItem(i, { name: v })} placeholder=${it.type === 'liability' ? 'e.g. Car loan' : 'e.g. Checking'} aria-label="Name" />
          <${Select} value=${it.type} onValue=${(v) => setItem(i, { type: v })} options=${[{ value: 'asset', label: 'Asset' }, { value: 'liability', label: 'Liability' }]} aria-label="Type" />
          <${Select} value=${it.category} onValue=${(v) => setItem(i, { category: v, catTouched: true })} options=${CATEGORIES.map((c) => ({ value: c.id, label: c.label }))} aria-label="Category" />
          <${NumberInput} value=${it.value} onValue=${(v) => setItem(i, { value: v })} min="0" step="100" placeholder="0" aria-label="Value" />
          <${IconButton} icon="x" label="Remove" onClick=${() => removeRow(i)} />
        </div>`)}
      </div>` : html`<div class="dim small">No balances yet${prev ? ` — copy ${monthLabel(prev.month)}’s items or add them` : ''}. Cash, investments, retirement, property, vehicles and debts all count.</div>`}
      <div class="row wrap" style="gap:8px">
        <${Button} size="sm" icon="plus" onClick=${() => addRow('asset')}>Asset</${Button}>
        <${Button} size="sm" icon="plus" onClick=${() => addRow('liability')}>Liability</${Button}>
      </div>
    </div>

    <div class="card inset tight">
      <${KV} items=${[
        ['Assets', fmtMoney(nw.assets)],
        ['Liabilities', nw.liabilities ? '−' + fmtMoney(nw.liabilities) : fmtMoney(0)],
        ['Company equity (estimate)', isNum(nw.equity) ? fmtMoney(nw.equity) : '—'],
        ['Net worth', html`<b>${fmtMoney(nw.total)}</b>`],
      ]} />
    </div>
    <${Field} label="Note"><${Textarea} value=${d.note} onValue=${(v) => setD((x) => ({ ...x, note: v }))} rows="2" placeholder="Optional" /></${Field}>
    ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
    <${SheetFoot}>
      ${existing ? html`<${Button} variant="danger" icon="trash" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>Save snapshot</${Button}>
    </${SheetFoot}>
  </div>`;
}
