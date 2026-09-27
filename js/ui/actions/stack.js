// OWNER: UI-E (Records). Contract (docs/UI_GUIDE.md §6).
// openStackLog: one-tap logging of a stack (AM/PM/custom) as `doses` records.
// openDoseLog: log or edit a single dose (item, amount, unit, date/time, injection site, skipped, note),
// with the week's total vs `weeklyTarget` computed from the records. FORGE records; it never suggests doses.
import { html, useState } from '../../vendor/preact-htm.js';
import { useApp, useVersion } from '../ctx.js';
import { Button, Check, Empty, Field, NumberInput, Select, SheetFoot, SheetHead, TimeInput, ToggleRow, Input, Segmented, Notice } from '../kit.js';
import { stackStatus, dueItems } from '../../analytics/protocols.js';
import { isoWithOffset, zonedToMs, localParts, isNum, fmtTime } from '../../core/util.js';
import { removeWithUndo } from '../parts/common.js';
import { dateLabel } from '../parts/date.js';
import {
  amountText, defaultDoseTime, stackNames, stackKey, stackTitle, lastSite, nextSite, UNITS, weekTotal, convertAmount,
  scheduleText, kindLabel, SITES,
} from '../parts/records-protocols.js';
import { localHm, plural } from '../parts/records-util.js';
import { DateInput, SitePicker, WeekTotal, Group } from '../parts/records-ui.js';

const nowHm = (tz) => localParts(Date.now(), tz).hm;
const atFor = (date, hm, tz) => isoWithOffset(zonedToMs(date, hm, tz), tz);
const isInjection = (item) => !!item && item.form === 'injection';
const itemDoses = (app, id) => app.dv.dosesByItem().get(id) || [];

/* ============================================================ stack log */

/** openStackLog(app, { date, stack }) → Promise<number|undefined> (doses logged) */
export function openStackLog(app, { date, stack } = {}) {
  const d = date || app.today();
  return app.sheet(({ close }) => html`<${StackLogSheet} date=${d} stack=${stack} close=${close} />`);
}

function StackLogSheet({ date, stack, close }) {
  const app = useApp(); useVersion(['protocolItems', 'doses']);
  const names = stackNames(app.dv.protocolItems());
  const initial = (stack && names.find((n) => stackKey(n) === stackKey(stack))) || stack || names[0] || null;
  const [cur, setCur] = useState(initial);
  return html`<div class="stack">
    <${SheetHead} title=${cur ? stackTitle(cur) : 'Log stack'} onClose=${() => close()} />
    <div class="xs muted rec-sheet-sub">${dateLabel(date, app.today())}</div>
    ${names.length > 1 ? html`<div><${Segmented} value=${names.find((n) => stackKey(n) === stackKey(cur)) || cur} onValue=${setCur} options=${names} label="Stack" /></div>` : null}
    <${StackBody} key=${stackKey(cur) + '|' + date} date=${date} stack=${cur} close=${close} />
  </div>`;
}

function StackBody({ date, stack, close }) {
  const app = useApp(); const dv = app.dv; const tz = dv.tz; const today = app.today();
  const st = stack ? stackStatus(dv, date, stack) : { items: [], complete: null };
  const inStack = stack ? dv.protocolItems().filter((i) => stackKey(i.schedule && i.schedule.stack) === stackKey(stack)) : [];
  const notDue = inStack.filter((i) => !st.items.some((x) => x.item.id === i.id) && !(i.schedule && i.schedule.type === 'asneeded'));
  const open = st.items.filter((x) => !x.taken).map((x) => x.item);
  const [checked, setChecked] = useState(() => new Set(open.map((i) => i.id)));
  const [hm, setHm] = useState(() => defaultDoseTime({ date, today, nowHm: nowHm(tz), items: st.items.map((x) => x.item), stack }));
  const [sites, setSites] = useState(() => Object.fromEntries(open.filter(isInjection).map((i) => [i.id, nextSite(lastSite(itemDoses(app, i.id)))])));
  const [busy, setBusy] = useState(false);
  const toLog = open.filter((i) => checked.has(i.id));
  const toggle = (id) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const takenAt = (id) => { const d = dv.doses(date).find((x) => x.itemId === id && !x.skipped); return d ? localHm(d.at, tz) : null; };

  const log = () => {
    if (!toLog.length || busy) return;
    if (date > today) { app.toast('Pick today or an earlier date.', { tone: 'error' }); return; }
    setBusy(true);
    const at = atFor(date, hm || '08:00', tz);
    const ids = toLog.map((item) => app.store.create('doses', {
      itemId: item.id, date, at, amount: isNum(item.amount) ? item.amount : null, unit: item.unit || null,
      ...(isInjection(item) && sites[item.id] ? { site: sites[item.id] } : {}),
    }).id);
    app.toast(`Logged ${plural(ids.length, 'item')} · ${stackTitle(stack)}`, { action: { label: 'Undo', onClick: () => ids.forEach((id) => app.store.remove('doses', id)) } });
    close(ids.length);
  };

  if (!stack || !inStack.length) {
    return html`<div class="stack">
      <${Empty} title=${stack ? `Nothing uses the ${stackTitle(stack)}` : 'No stacks yet'}>
        Give items a stack (AM, PM or your own name) in Protocols, then log them together here.</${Empty}>
      <${SheetFoot}><${Button} onClick=${() => close()}>Close</${Button}>
        <${Button} variant="primary" onClick=${() => { close(); app.nav('/protocols'); }}>Open Protocols</${Button}></${SheetFoot}>
    </div>`;
  }

  return html`<div class="stack">
    ${st.items.length ? html`<div class="rec-check-list">
      ${st.items.map(({ item, taken }) => {
        const on = taken || checked.has(item.id);
        const t = taken ? takenAt(item.id) : null;
        return html`<div class=${'rec-check-row' + (taken ? ' done' : '')}>
          <${Check} state=${on} label=${item.name} onClick=${taken ? undefined : () => toggle(item.id)} />
          <button type="button" class="grow rec-row-btn" disabled=${taken} onClick=${() => toggle(item.id)}>
            <span class="strong small ellipsis">${item.name}</span>
            <span class="xs muted">${[amountText(item.amount, item.unit), taken ? (t ? `Taken ${fmtTime(t)}` : 'Taken') : null].filter(Boolean).join(' · ')}</span>
          </button>
          ${!taken && isInjection(item) ? html`<select class="select rec-site-select" aria-label=${'Site for ' + item.name} value=${sites[item.id] || ''}
            onChange=${(e) => { const v = e.currentTarget.value; setSites((s) => ({ ...s, [item.id]: v })); }}>
            ${['', ...SITES].map((s) => html`<option value=${s}>${s || 'No site'}</option>`)}</select>` : null}
        </div>`;
      })}
    </div>` : html`<${Notice}>Nothing in the ${stackTitle(stack)} is scheduled on this day.</${Notice}>`}
    ${notDue.length ? html`<div class="xs muted">Not scheduled this day: ${notDue.map((i, k) => html`${k ? ', ' : ''}<button type="button" class="rec-link" onClick=${() => openDoseLog(app, { date, itemId: i.id })}>${i.name}</button> (${scheduleText(i.schedule)})`)}</div>` : null}
    ${open.length ? html`<${Field} label="Time taken"><${TimeInput} value=${hm} onValue=${setHm} /></${Field}>` : null}
    <${SheetFoot}>
      <${Button} onClick=${() => close()}>${open.length ? 'Cancel' : 'Close'}</${Button}>
      ${open.length ? html`<${Button} variant="primary" disabled=${!toLog.length} loading=${busy} onClick=${log}>${toLog.length ? `Log ${plural(toLog.length, 'item')}` : 'Nothing selected'}</${Button}>`
        : st.items.length ? html`<${Button} variant="primary" icon="check" onClick=${() => close(0)}>All taken</${Button}>` : null}
    </${SheetFoot}>
  </div>`;
}

/* ============================================================= dose log */

/** openDoseLog(app, { date, itemId, id }) → Promise<string|undefined> (dose id) */
export function openDoseLog(app, { date, itemId, id } = {}) {
  const d = date || app.today();
  return app.sheet(({ close }) => html`<${DoseSheet} date=${d} itemId=${itemId} id=${id} close=${close} />`);
}

function defaultItemId(app, date) {
  const due = dueItems(app.dv, date).filter((x) => x.item.active !== false);
  const open = due.find((x) => x.due && !x.taken);
  if (open) return open.item.id;
  const first = app.dv.protocolItems()[0];
  return first ? first.id : null;
}

function initialForm(app, { date, itemId, existing }) {
  const tz = app.dv.tz; const today = app.today();
  const id0 = (existing && existing.itemId) || itemId || defaultItemId(app, date);
  const item = id0 ? app.store.getAny('protocolItems', id0) : null;
  const d0 = (existing && existing.date) || date || today;
  if (existing) {
    return {
      itemId: id0, date: d0, hm: localHm(existing.at, tz) || defaultDoseTime({ date: d0, today, nowHm: nowHm(tz), items: item ? [item] : [] }),
      amount: isNum(existing.amount) ? existing.amount : item && isNum(item.amount) ? item.amount : null,
      unit: existing.unit || (item && item.unit) || '', site: existing.site || '', skipped: !!existing.skipped, note: existing.note || '',
    };
  }
  return { itemId: id0, date: d0, hm: defaultDoseTime({ date: d0, today, nowHm: nowHm(tz), items: item ? [item] : [], stack: item && item.schedule && item.schedule.stack }), ...itemDefaults(app, item), skipped: false, note: '' };
}
function itemDefaults(app, item) {
  if (!item) return { amount: null, unit: '', site: '' };
  return {
    amount: isNum(item.amount) ? item.amount : null, unit: item.unit || '',
    site: isInjection(item) ? nextSite(lastSite(itemDoses(app, item.id))) : '',
  };
}

function DoseSheet({ date, itemId, id, close }) {
  const app = useApp(); useVersion(['protocolItems', 'doses']);
  const existing = id ? app.store.get('doses', id) : null;
  const [f, setF] = useState(() => initialForm(app, { date, itemId, existing }));
  const [err, setErr] = useState('');
  const today = app.today(); const tz = app.dv.tz;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const active = app.dv.protocolItems();
  const item = f.itemId ? app.store.getAny('protocolItems', f.itemId) : null;
  const options = [...active];
  if (item && !options.some((i) => i.id === item.id)) options.unshift(item);
  const pickItem = (nid) => { const it = app.store.getAny('protocolItems', nid); setF((x) => ({ ...x, itemId: nid, ...itemDefaults(app, it) })); };

  if (!options.length) {
    return html`<div class="stack">
      <${SheetHead} title="Log dose" onClose=${() => close()} />
      <${Empty} title="Add a protocol item first">Each supplement, peptide or medication is set up once (amount, unit, schedule, stack). Doses are then logged against it.</${Empty}>
      <${SheetFoot}><${Button} onClick=${() => close()}>Close</${Button}>
        <${Button} variant="primary" icon="plus" onClick=${async () => {
          const { openItemEditor } = await import('../screens/protocols/editor.js');
          const nid = await openItemEditor(app, {});
          if (nid && nid !== 'deleted') pickItem(nid);
        }}>Add item</${Button}></${SheetFoot}>
    </div>`;
  }

  const doses = item ? itemDoses(app, item.id) : [];
  const wt = item && item.weeklyTarget && isNum(item.weeklyTarget.amount) ? item.weeklyTarget : null;
  const unit = wt ? wt.unit || item.unit : item && item.unit;
  const showWeek = !!item && (!!wt || (item.schedule && item.schedule.type) !== 'daily');
  const week = showWeek && f.date ? weekTotal(doses, { itemId: item.id, date: f.date, unit, fallbackUnit: item.unit, fallbackAmount: item.amount, excludeId: id }) : null;
  const add = !f.skipped ? convertAmount(f.amount, f.unit, unit) : 0;
  const after = week && add != null ? Math.round((week.total + add) * 1e6) / 1e6 : null;
  const last = lastSiteRecord(doses, id);
  const showSite = isInjection(item) || !!f.site;

  const save = () => {
    setErr('');
    if (!item) { setErr('Pick an item.'); return; }
    if (!f.date) { setErr('Pick a date.'); return; }
    if (f.date > today) { setErr('Doses are records of what was taken: pick today or an earlier date.'); return; }
    if (f.amount != null && !(isNum(f.amount) && f.amount >= 0)) { setErr('Amount must be a number.'); return; }
    const fields = {
      itemId: item.id, date: f.date, at: atFor(f.date, f.hm || '08:00', tz),
      amount: isNum(f.amount) ? f.amount : null, unit: f.unit || null, site: showSite && f.site ? f.site : null,
      skipped: !!f.skipped, note: f.note.trim() || null,
    };
    if (existing) {
      app.store.update('doses', existing.id, fields);
      app.toast('Dose updated');
      close(existing.id);
      return;
    }
    const rec = app.store.create('doses', fields);
    const what = f.skipped ? `Skipped ${item.name} recorded` : `Logged ${item.name}${isNum(f.amount) ? ' · ' + amountText(f.amount, f.unit) : ''}`;
    app.toast(what, { action: { label: 'Undo', onClick: () => app.store.remove('doses', rec.id) } });
    close(rec.id);
  };
  const del = () => { removeWithUndo(app, 'doses', existing.id, 'Dose'); close(); };

  return html`<div class="stack">
    <${SheetHead} title=${existing ? 'Edit dose' : 'Log dose'} onClose=${() => close()} />
    ${existing ? null : html`<div class="xs muted rec-sheet-sub">${dateLabel(f.date || today, today)}</div>`}
    <${Field} label="Item">
      <${Select} value=${f.itemId || ''} onValue=${pickItem} disabled=${!!existing}
        options=${options.map((i) => ({ value: i.id, label: `${i.name}${i.active === false ? ' (inactive)' : ''} · ${kindLabel(i.kind)}` }))} />
    </${Field}>
    <div class="grid two">
      <${Field} label="Amount"><${NumberInput} value=${f.amount} onValue=${set('amount')} min="0" placeholder="—" /></${Field}>
      <${Field} label="Unit"><${Select} value=${f.unit} onValue=${set('unit')} options=${unitOptions(f.unit)} /></${Field}>
    </div>
    <div class="grid two">
      <${Field} label="Date"><${DateInput} value=${f.date} onValue=${set('date')} max=${today} /></${Field}>
      <${Field} label="Time"><${TimeInput} value=${f.hm} onValue=${set('hm')} /></${Field}>
    </div>
    ${showSite ? html`<${Group} label="Injection site"><${SitePicker} value=${f.site} onValue=${set('site')} last=${last} next=${last ? nextSite(last.site) : null} /></${Group}>` : null}
    ${week ? html`<${WeekTotal} from=${week.from} to=${week.to} sofar=${week.total} after=${after} target=${wt ? wt.amount : null} unit=${unit} unconverted=${week.unconverted} />` : null}
    <${ToggleRow} label="Skipped" sub="Recorded, but not counted as taken" checked=${f.skipped} onValue=${set('skipped')} />
    <${Field} label="Note"><${Input} value=${f.note} onValue=${set('note')} placeholder="Optional" /></${Field}>
    ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
    <${SheetFoot}>
      ${existing ? html`<${Button} variant="danger" icon="trash" onClick=${del} aria-label="Delete dose">Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>${existing ? 'Save' : f.skipped ? 'Record skip' : 'Log dose'}</${Button}>
    </${SheetFoot}>
  </div>`;
}

const unitOptions = (cur) => [{ value: '', label: '—' }, ...(cur && !UNITS.includes(cur) ? [{ value: cur, label: cur }] : []), ...UNITS.map((u) => ({ value: u, label: u }))];
function lastSiteRecord(doses, excludeId) {
  const list = doses.filter((d) => d.id !== excludeId && !d.skipped && d.site);
  if (!list.length) return null;
  const site = lastSite(list);
  const rec = list.filter((d) => d.site === site).pop();
  return { site, date: rec ? rec.date : null };
}
