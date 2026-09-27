// Protocol item editor sheet (create/edit/delete). openItemEditor(app, { id, kind }) → Promise<id|'deleted'|undefined>
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion } from '../../ctx.js';
import {
  Button, Chips, Field, Input, NumberInput, Select, SheetFoot, SheetHead, Segmented, Textarea, TimeInput, ToggleRow, IconButton, Notice,
} from '../../kit.js';
import { removeWithUndo } from '../../parts/common.js';
import {
  KINDS, UNITS, FORMS, SCHEDULE_TYPES, DAY_NAMES, emptyItem, draftFromItem, validateItem, itemPayload, defaultNeutralLabel,
  stackNames, stackKey, formLabel,
} from '../../parts/records-protocols.js';
import { DateInput, Group } from '../../parts/records-ui.js';

export function openItemEditor(app, { id, kind } = {}) {
  return app.sheet(({ close }) => html`<${ItemEditor} id=${id} kind=${kind} close=${close} />`, { wide: true });
}

const SCHEDULE_HINT = {
  daily: 'Due every day.',
  days: 'Due on the selected weekdays.',
  weekly: 'Once per week. Pick a day to schedule it, or leave the days empty to keep it due until it is logged each week.',
  asneeded: 'Never due; log it when taken.',
};

function ItemEditor({ id, kind, close }) {
  const app = useApp(); useVersion(['protocolItems']);
  const existing = id ? app.store.get('protocolItems', id) : null;
  const [d, setD] = useState(() => (existing ? draftFromItem(existing) : emptyItem({ kind: kind || 'supplement', today: app.today() })));
  const [neutralTouched, setNeutralTouched] = useState(!!existing);
  const [customStack, setCustomStack] = useState(false);
  const [showErr, setShowErr] = useState(false);
  const errors = validateItem(d);
  const err = (k) => (showErr ? errors[k] : null);
  const set = (k) => (v) => setD((x) => ({ ...x, [k]: v }));
  const setSch = (k) => (v) => setD((x) => ({ ...x, schedule: { ...x.schedule, [k]: v } }));
  const setKind = (k) => setD((x) => ({
    ...x, kind: k,
    neutralLabel: neutralTouched ? x.neutralLabel : defaultNeutralLabel(k),
    form: existing || x.form !== (x.kind === 'peptide' ? 'injection' : 'capsule') ? x.form : k === 'peptide' ? 'injection' : 'capsule',
  }));

  const others = app.store.all('protocolItems').filter((i) => i.id !== id);
  const stacks = [];
  for (const s of ['AM', 'PM', ...stackNames(others)]) if (!stacks.some((x) => stackKey(x) === stackKey(s))) stacks.push(s);
  const curStack = String(d.schedule.stack || '').trim();
  const known = !curStack || stacks.some((s) => stackKey(s) === stackKey(curStack));
  const stackChip = !curStack ? '' : known ? stacks.find((s) => stackKey(s) === stackKey(curStack)) : '__custom';
  const onStackChip = (v) => {
    if (v === '__custom') { setCustomStack(true); if (known) setSch('stack')(''); return; }
    setCustomStack(false); setSch('stack')(v === stackChip ? '' : v);
  };
  const showCustom = customStack || (curStack && !known);
  const type = d.schedule.type || 'daily';
  const times = d.schedule.times || [];
  const wt = d.weeklyTarget;

  const save = () => {
    if (Object.keys(errors).length) { setShowErr(true); return; }
    const fields = itemPayload(d);
    if (existing) {
      app.store.update('protocolItems', existing.id, fields);
      app.toast(`Saved · ${fields.name}`);
      close(existing.id);
    } else {
      const rec = app.store.create('protocolItems', fields);
      app.toast(`Added · ${fields.name}`);
      close(rec.id);
    }
  };
  const del = () => { removeWithUndo(app, 'protocolItems', existing.id, existing.name || 'Item'); close('deleted'); };

  return html`<div class="stack">
    <${SheetHead} title=${existing ? 'Edit item' : 'New protocol item'} onClose=${() => close()} />
    <div class="grid two rec-collapse">
      <${Field} label="Name" error=${err('name')}><${Input} value=${d.name} onValue=${set('name')} placeholder="e.g. Creatine monohydrate" /></${Field}>
      <${Group} label="Kind"><${Segmented} block value=${d.kind} onValue=${setKind} options=${KINDS.map((k) => ({ value: k.value, label: k.label }))} label="Kind" /></${Group}>
    </div>
    <div class="rec-dose-grid">
      <${Field} label="Amount per dose" error=${err('amount')}><${NumberInput} value=${d.amount} onValue=${set('amount')} min="0" placeholder="—" /></${Field}>
      <${Field} label="Unit"><${Select} value=${d.unit || ''} onValue=${set('unit')} options=${[{ value: '', label: '—' }, ...UNITS.map((u) => ({ value: u, label: u }))]} /></${Field}>
      <${Field} label="Form"><${Select} value=${d.form || ''} onValue=${set('form')} options=${[{ value: '', label: '—' }, ...FORMS.map((f) => ({ value: f, label: formLabel(f) }))]} /></${Field}>
    </div>

    <div class="card inset stack">
      <${Group} label="Schedule" hint=${SCHEDULE_HINT[type]}>
        <div><${Segmented} value=${type} onValue=${setSch('type')} options=${SCHEDULE_TYPES} label="Schedule" /></div>
      </${Group}>
      ${type === 'days' || type === 'weekly' ? html`<${Group} label=${type === 'weekly' ? 'Day (optional)' : 'Days'} error=${err('days')}>
        <${Chips} multi options=${DAY_NAMES.map((n, i) => ({ value: i, label: n }))} value=${d.schedule.days || []} onValue=${setSch('days')} /></${Group}>` : null}
      ${type !== 'asneeded' ? html`
        <${Group} label="Stack" hint="Items in the same stack are logged together (Today → AM stack).">
          <div class="stack sm">
            <${Chips} options=${[...stacks.map((s) => ({ value: s, label: s })), { value: '__custom', label: 'Other…' }]} value=${showCustom ? '__custom' : stackChip} onValue=${onStackChip} />
            ${showCustom ? html`<${Input} sm value=${curStack} onValue=${setSch('stack')} placeholder="Stack name, e.g. Pre-workout" aria-label="Stack name" />` : null}
          </div>
        </${Group}>
        <${Group} label="Times" hint="Optional. Used for reminders and as the default time when logging.">
          <div class="stack sm">
            ${times.map((t, i) => html`<div class="row" style="gap:6px">
              <${TimeInput} value=${t} onValue=${(v) => setSch('times')(times.map((x, j) => (j === i ? v : x)))} />
              <${IconButton} icon="x" label="Remove time" onClick=${() => setSch('times')(times.filter((_, j) => j !== i))} /></div>`)}
            <div><${Button} size="sm" icon="plus" onClick=${() => setSch('times')([...times, stackKey(curStack) === 'pm' ? '21:00' : '08:00'])}>Add time</${Button}></div>
          </div>
        </${Group}>` : null}
    </div>

    <div class="stack sm">
      <${ToggleRow} label="Weekly total target" sub="For items taken as split doses toward a weekly total. The dose log shows the week's progress."
        checked=${!!wt} onValue=${(on) => set('weeklyTarget')(on ? { amount: null, unit: d.unit || 'mg' } : null)} />
      ${wt ? html`<div class="grid two">
        <${Field} label="Weekly total" error=${err('weeklyTarget')}><${NumberInput} value=${wt.amount} onValue=${(v) => set('weeklyTarget')({ ...wt, amount: v })} min="0" /></${Field}>
        <${Field} label="Unit"><${Select} value=${wt.unit || ''} onValue=${(v) => set('weeklyTarget')({ ...wt, unit: v })} options=${UNITS} /></${Field}>
      </div>` : null}
    </div>

    <${Field} label="Neutral label" hint="Shown instead of the name wherever text leaves the encrypted vault: notifications and calendar events. Peptides and medications default to “Protocol” so their names never appear on a lock screen or a shared calendar.">
      <${Input} value=${d.neutralLabel} onValue=${(v) => { setNeutralTouched(true); set('neutralLabel')(v); }} placeholder=${d.kind === 'supplement' ? 'Optional' : 'Protocol'} />
    </${Field}>
    <div class="grid two">
      <${Field} label="Started"><${DateInput} value=${d.startedAt} onValue=${set('startedAt')} /></${Field}>
      <${Field} label="Ended" error=${err('endedAt')} hint="Set when you stop; history stays in analytics."><${DateInput} value=${d.endedAt} onValue=${set('endedAt')} /></${Field}>
    </div>
    <${Field} label="Note"><${Textarea} value=${d.note} onValue=${set('note')} rows="2" placeholder="Brand, source, instructions" /></${Field}>
    <${ToggleRow} label="Active" sub="Inactive items leave the daily lists; logged history is kept." checked=${d.active} onValue=${set('active')} />
    ${showErr && Object.keys(errors).length ? html`<${Notice} tone="bad">Check the highlighted fields.</${Notice}>` : null}
    <${SheetFoot}>
      ${existing ? html`<${Button} variant="danger" icon="trash" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>${existing ? 'Save' : 'Add item'}</${Button}>
    </${SheetFoot}>
  </div>`;
}
