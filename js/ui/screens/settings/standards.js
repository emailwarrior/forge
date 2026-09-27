// Settings → Standards: the ordered list (today's status + 28-day adherence), reorder mode, and the
// editor sheet with a live evaluateStandard() preview for today and the last 7 days.
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics } from '../../ctx.js';
import { Button, IconButton, Field, Input, NumberInput, TimeInput, Select, Pill, Chips, ToggleRow, Notice, Empty, SheetHead, SheetFoot, Icon, cx } from '../../kit.js';
import { Block, Seg, FieldGroup } from '../../parts/settings-ui.js';
import { removeWithUndo } from '../../parts/common.js';
import {
  KINDS, OPS, TIME_OPS, DAY_LABELS, ALL_DAYS, AUTO_SOURCES, parseAutoSource, buildAutoSource, kindsFor, needsTarget, sourceLabel,
  daysLabel, newStandard, draftFrom, applyChange, withTargetValue, validateStandard, toRecord, changedFields, sortStandards, reorder,
  nextOrder, stacksOf, targetText,
} from '../../parts/settings-standards.js';
import { STANDARD_CATEGORIES } from '../../../core/schema.js';
import { evaluateStandard, adherenceByStandard, resolveTarget } from '../../../analytics/index.js';
import { addDays, fmtTime, fmtDate, fmtNum, uid, isNum, dayOfWeek } from '../../../core/util.js';

const STATUS_TONE = { done: 'good', missed: 'bad', pending: null, unknown: null, na: null, future: null };
// evaluateStandard().display, with clock times as '7:49 AM'.
const shown = (d) => (typeof d === 'string' && /^\d{1,2}:\d{2}$/.test(d) ? fmtTime(d) : d);
function statusLabel(ev) {
  if (!ev) return '—';
  if (ev.status === 'na') return 'Not today';
  if (ev.status === 'pending') return ev.display && ev.display !== '—' ? shown(ev.display) : 'Pending';
  if (ev.status === 'unknown') return 'No data';
  return ev.display && ev.display !== '—' ? shown(ev.display) : ev.status === 'done' ? 'Done' : 'Missed';
}
const OP_WORD = { time: { '<=': 'by', '<': 'before', '>=': 'at or after', '>': 'after', '=': 'at' }, other: { '<=': '≤', '<': '<', '>=': '≥', '>': '>', '=': '=', '==': '=' } };
function targetPhrase(target, kind) {
  if (!target || target.value == null) return '';
  const op = (kind === 'time' ? OP_WORD.time : OP_WORD.other)[target.op] || target.op;
  if (kind === 'time') return `${op} ${fmtTime(target.value)}`;
  const u = target.unit ? (target.unit === '%' ? '%' : ' ' + target.unit) : '';
  return `${op} ${fmtNum(target.value, isNum(target.value) && target.value % 1 ? 1 : 0)}${u}`;
}
const fmtTarget = (d) => targetText(d, fmtTime);

export default function StandardsSection() {
  const app = useApp(); useVersion(['standards', 'protocolItems']);
  const today = app.today();
  const [reordering, setReordering] = useState(false);
  const all = sortStandards(app.store.all('standards'));
  const active = all.filter((s) => s.active !== false);
  const inactive = all.filter((s) => s.active === false);
  const items = app.store.all('protocolItems');
  const evals = useAnalytics(() => new Map(active.map((s) => [s.id, evaluateStandard(app.dv, s, today)])), [today]);
  const adh = useAnalytics(() => new Map(adherenceByStandard(app.dv, addDays(today, -27), today).map((a) => [a.standard.id, a])), [today]);
  const open = (id) => app.sheet(({ close }) => html`<${StandardSheet} id=${id} close=${close} />`);
  const move = (id, dir) => {
    const changes = reorder([...active, ...inactive], id, dir);
    for (const c of changes) app.store.update('standards', c.id, { order: c.order });
  };
  const required = active.filter((s) => s.required).length;
  return html`<div class="stack lg">
    <${Block} title=${`Active standards · ${active.length}`} desc=${`${required} required for a perfect day. Automatic ones fill in from their source; an entry on Today always wins.`}
      action=${active.length > 1 ? html`<${Button} size="sm" variant=${reordering ? 'primary' : undefined} icon=${reordering ? 'check' : 'grip'} onClick=${() => setReordering(!reordering)}>${reordering ? 'Done' : 'Reorder'}</${Button}>` : null}>
      ${active.length ? html`<div class="card flush set-std-list">${active.map((s, i) => html`<${StdRow} key=${s.id} s=${s} items=${items} ev=${evals && evals.get(s.id)} adh=${adh && adh.get(s.id)}
          reordering=${reordering} first=${i === 0} last=${i === active.length - 1} onMove=${move} onOpen=${open} />`)}</div>`
        : html`<${Empty} title="No active standards">Standards define a complete day: wake time, training, protein, deep work. Add the first one.</${Empty}>`}
      <div class="row wrap" style="gap:8px"><${Button} icon="plus" onClick=${() => open(null)}>Add standard</${Button}>
        <span class="xs muted">Today: ${fmtDate(today)} · status and 28-day completion shown on each row.</span></div>
    </${Block}>
    ${inactive.length ? html`<${Block} title=${`Inactive · ${inactive.length}`} desc="Kept for history; not scored.">
      <div class="card flush set-std-list">${inactive.map((s) => html`<${StdRow} key=${s.id} s=${s} items=${items} inactive onOpen=${open} />`)}</div>
    </${Block}>` : null}
  </div>`;
}

function StdRow({ s, items, ev, adh, reordering, first, last, onMove, onOpen, inactive }) {
  const d = draftFrom(s);
  const meta = [s.category, fmtTarget(d) || KINDS.find((k) => k.value === d.kind).label, sourceLabel(s.auto, { items, short: true }), daysLabel(s.days), s.required ? null : 'optional', d.weight !== 2 ? `weight ${d.weight}` : null].filter(Boolean);
  return html`<div class=${cx('list-row set-std-row', !reordering && 'link', inactive && 'dim')} role=${reordering ? undefined : 'button'} tabIndex=${reordering ? undefined : 0}
      onClick=${reordering ? undefined : () => onOpen(s.id)} onKeyDown=${reordering ? undefined : (e) => { if (e.key === 'Enter') onOpen(s.id); }}>
    <div class="grow" style="min-width:0">
      <div class="title set-std-title">${s.name || 'Untitled'}${s.auto ? html` <span class="tag" title="Filled automatically">auto</span>` : null}</div>
      <div class="meta set-std-meta">${meta.join(' · ')}</div>
    </div>
    ${reordering ? html`<div class="row" style="gap:2px">
        <${IconButton} icon="chevronUp" label=${'Move ' + s.name + ' up'} bordered disabled=${first} onClick=${() => onMove(s.id, -1)} />
        <${IconButton} icon="chevronDown" label=${'Move ' + s.name + ' down'} bordered disabled=${last} onClick=${() => onMove(s.id, 1)} /></div>`
      : inactive ? html`<${Icon} name="chevronRight" size=${16} class="muted" />`
      : html`<div class="set-std-trail">
          <${Pill} tone=${ev ? STATUS_TONE[ev.status] : null}>${statusLabel(ev)}</${Pill}>
          <span class="xs muted num" title="Done on known days in the last 28 days">${adh && adh.rate != null ? `${fmtNum(adh.rate)}% · 28 d` : '— · 28 d'}</span>
        </div>`}
  </div>`;
}

/* ------------------------------------------------------------ editor */
function StandardSheet({ id, close }) {
  const app = useApp(); useVersion(['standards', 'protocolItems']);
  const today = app.today();
  const rec = id ? app.store.get('standards', id) : null;
  const [draft, setDraft] = useState(() => (rec ? draftFrom(rec) : { ...newStandard({ today, order: nextOrder(app.store.all('standards')) }), id: uid() }));
  const [tried, setTried] = useState(false);
  const items = app.store.all('protocolItems').filter((x) => x.active !== false);
  const v = validateStandard(draft, { protocolItems: app.store.all('protocolItems') });
  const err = (k) => (tried ? v.errors[k] : null);
  const change = (patch) => setDraft((d) => applyChange(d, patch));
  const src = parseAutoSource(draft.auto);
  const kinds = kindsFor(draft.auto);

  const save = () => {
    setTried(true);
    if (!v.ok) return;
    const fields = toRecord(draft);
    if (rec) {
      const ch = changedFields(rec, fields);
      if (Object.keys(ch).length) app.store.update('standards', rec.id, ch);
      app.toast(Object.keys(ch).length ? 'Standard saved' : 'No changes');
    } else {
      app.store.create('standards', { id: draft.id, ...fields });
      app.toast('Standard added');
    }
    close(true);
  };
  const del = () => { close(); removeWithUndo(app, 'standards', rec.id, 'Standard'); };

  const srcGroups = [...new Set(AUTO_SOURCES.map((s) => s.group))];
  return html`<div class="stack">
    <${SheetHead} title=${rec ? 'Edit standard' : 'New standard'} onClose=${() => close()} />
    <${Field} label="Name" error=${err('name')}><${Input} value=${draft.name} onValue=${(x) => change({ name: x })} placeholder="e.g. Wake on time" maxlength="80" /></${Field}>
    <div class="set-cols">
      <${Field} label="Category" error=${err('category')}>
        <${Select} value=${draft.category} onValue=${(x) => change({ category: x })}
          options=${[...new Set([...STANDARD_CATEGORIES, draft.category].filter(Boolean))]} /></${Field}>
      <${FieldGroup} label="Weight" error=${err('weight')} hint="Share of the day score">
        <${Seg} block value=${draft.weight} onValue=${(x) => change({ weight: x })} label="Weight" options=${[1, 2, 3].map((n) => ({ value: n, label: String(n) }))} />
      </${FieldGroup}>
    </div>

    <${Field} label="Measured by" error=${err('auto')} hint=${src.id ? 'Filled in automatically; a manual entry on Today always wins.' : 'You tick or enter it on Today.'}>
      <select class="select" value=${src.id} onChange=${(e) => change({ auto: buildAutoSource(e.currentTarget.value, '') })} aria-label="Measured by">
        ${srcGroups.map((g) => html`<optgroup label=${g}>${AUTO_SOURCES.filter((s) => s.group === g).map((s) => html`<option value=${s.id}>${s.label}</option>`)}</optgroup>`)}
        ${src.id && !src.def ? html`<option value=${src.id}>${draft.auto} (unknown)</option>` : null}
      </select>
    </${Field}>
    ${src.def && src.def.param ? html`<${SourceParam} draft=${draft} src=${src} items=${items} onChange=${change} error=${err('auto')} />` : null}

    <${FieldGroup} label="Kind" error=${err('kind')} hint=${(KINDS.find((k) => k.value === draft.kind) || {}).hint} class="set-kind">
      <${Seg} block value=${draft.kind} onValue=${(x) => change({ kind: x })} label="Kind"
        options=${KINDS.map((k) => ({ value: k.value, label: k.label, disabled: !kinds.includes(k.value), title: kinds.includes(k.value) ? k.hint : 'Not available for this source' }))} />
    </${FieldGroup}>
    ${needsTarget(draft.kind) ? html`<${TargetEditor} draft=${draft} setDraft=${setDraft} error=${err('target')} />` : null}

    <${FieldGroup} label="Days" error=${err('days')} class="set-days">
      <${Chips} multi value=${draft.days} onValue=${(x) => change({ days: [...x].sort((a, b) => a - b) })} options=${DAY_LABELS.map((l, i) => ({ value: i, label: l }))} />
      <div class="row" style="gap:6px"><${Button} size="sm" variant="ghost" onClick=${() => change({ days: [...ALL_DAYS] })}>Every day</${Button}>
        <${Button} size="sm" variant="ghost" onClick=${() => change({ days: [0, 1, 2, 3, 4] })}>Weekdays</${Button}>
        <${Button} size="sm" variant="ghost" onClick=${() => change({ days: [5, 6] })}>Weekends</${Button}></div>
    </${FieldGroup}>
    <div class="card inset tight stack xs">
      <${ToggleRow} label="Required" sub="Needed for a perfect day" checked=${draft.required} onValue=${(x) => change({ required: x })} />
      <${ToggleRow} label="Active" sub="Inactive standards are kept for history but not scored" checked=${draft.active} onValue=${(x) => change({ active: x })} />
    </div>
    ${draft.effectiveFrom <= SINCE_ALWAYS ? html`<${FieldGroup} label="Counts from" hint="Every day with data is scored with the current definition.">
        <div class="row between wrap" style="gap:8px"><span class="small">The beginning</span>
          <${Button} size="sm" variant="ghost" onClick=${() => change({ effectiveFrom: today })}>Start today instead</${Button}></div>
      </${FieldGroup}>`
      : html`<${Field} label="Counts from" error=${err('effectiveFrom')}
      hint=${rec ? 'Days before this date ignore the standard; edits re-score every day since then.' : 'Starts today, so past days are not re-scored.'}>
      <div class="row" style="gap:8px"><input class="input mono grow" type="date" value=${draft.effectiveFrom} max=${addDays(today, 365)} onInput=${(e) => change({ effectiveFrom: e.currentTarget.value })} />
        <${Button} size="sm" variant="ghost" onClick=${() => change({ effectiveFrom: '1970-01-01' })}>From the beginning</${Button}></div>
    </${Field}>`}

    <${Preview} draft=${draft} valid=${v.ok} />
    ${v.warnings.length ? html`<${Notice} tone="warn">${v.warnings.join(' ')}</${Notice}>` : null}
    ${tried && !v.ok ? html`<${Notice} tone="bad">Fix the highlighted fields to save.</${Notice}>` : null}
    <${SheetFoot}>
      ${rec ? html`<${Button} variant="ghost" class="danger" icon="trash" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>${rec ? 'Save' : 'Add standard'}</${Button}>
    </${SheetFoot}>
  </div>`;
}

function SourceParam({ draft, src, items, onChange, error }) {
  const set = (arg) => onChange({ auto: buildAutoSource(src.id, arg) });
  if (src.def.param === 'text') {
    return html`<${Field} label="Food name contains" error=${error} hint="Matches any logged food item whose name contains this text (case-insensitive).">
      <${Input} value=${src.arg} onValue=${set} placeholder="e.g. salmon" maxlength="40" /></${Field}>`;
  }
  if (src.def.param === 'stack') {
    const stacks = stacksOf(items);
    if (!stacks.length) {
      return html`<${Field} label="Stack" error=${error} hint="No protocol items have a stack yet. Stacks (e.g. AM, PM) are set on items in Protocols.">
        <${Input} value=${src.arg} onValue=${set} placeholder="e.g. AM" maxlength="20" /></${Field}>`;
    }
    const opts = [...new Set([...(src.arg ? [src.arg] : []), ...stacks])];
    return html`<${Field} label="Stack" error=${error} hint="Done when every active item in the stack that is due that day is logged.">
      <${Select} value=${src.arg} onValue=${set} options=${[{ value: '', label: 'Choose a stack' }, ...opts.map((s) => ({ value: s, label: s }))]} /></${Field}>`;
  }
  if (!items.length) {
    return html`<${Notice}>No protocol items yet. Add supplements, peptides or medications in Protocols, then pick one here.</${Notice}>`;
  }
  return html`<${Field} label="Protocol item" error=${error} hint="Done when a dose of this item is logged on a day it is due.">
    <${Select} value=${src.arg} onValue=${set} options=${[{ value: '', label: 'Choose an item' }, ...items.map((x) => ({ value: x.id, label: `${x.name} (${x.kind || 'item'})` }))]} /></${Field}>`;
}

function TargetEditor({ draft, setDraft, error }) {
  const app = useApp(); const today = app.today();
  const src = parseAutoSource(draft.auto);
  const t = draft.target || {};
  const sentinel = src.def && src.def.sentinel;
  const useSettings = t.value === 'target';
  const setOp = (op) => setDraft((d) => ({ ...d, target: { ...(d.target || {}), op } }));
  const setVal = (value) => setDraft((d) => withTargetValue(d, value));
  const resolved = useSettings ? resolveTarget(app.dv, { ...draft, target: { ...t } }, today) : null;
  const resolvedText = !resolved || resolved.value == null ? 'not set yet' : draft.kind === 'time' ? fmtTime(resolved.value) : `${fmtNum(resolved.value, isNum(resolved.value) && resolved.value % 1 ? 1 : 0)}${resolved.unit ? (resolved.unit === '%' ? '%' : ' ' + resolved.unit) : ''}`;
  const fixedUnit = src.def && src.def.unit && draft.kind === 'number' ? src.def.unit : null;
  return html`<${FieldGroup} label="Target" error=${error}>
    <div class="set-target">
      <${Select} value=${t.op || (draft.kind === 'time' ? '<=' : '>=')} onValue=${setOp} options=${draft.kind === 'time' ? TIME_OPS : OPS} aria-label="Comparison" />
      ${useSettings ? html`<div class="input set-target-ref">${sentinel.label}: <b class="num">${resolvedText}</b></div>`
        : draft.kind === 'time' ? html`<${TimeInput} value=${typeof t.value === 'string' ? t.value : ''} onValue=${(x) => setVal(x || null)} aria-label="Target time" />`
        : html`<${NumberInput} value=${isNum(t.value) ? t.value : null} onValue=${setVal} step="any" min="0" aria-label="Target value"
            suffix=${fixedUnit ? (fixedUnit === '%' ? '%' : fixedUnit) : undefined} />`}
    </div>
    ${!useSettings && draft.kind === 'duration' ? html`<${Seg} value=${t.unit === 'h' ? 'h' : 'min'} onValue=${(u) => setDraft((d) => ({ ...d, target: { ...(d.target || {}), unit: u } }))} label="Unit"
        options=${[{ value: 'min', label: 'Minutes' }, { value: 'h', label: 'Hours' }]} />` : null}
    ${!useSettings && draft.kind === 'number' && !fixedUnit ? html`<${Input} sm value=${t.unit || ''} onValue=${(u) => setDraft((d) => ({ ...d, target: { ...(d.target || {}), unit: u.trim() || null } }))} placeholder="Unit (optional), e.g. pages" maxlength="12" aria-label="Unit" />` : null}
    ${sentinel ? html`<${ToggleRow} label="Use the target from Settings → Targets" sub=${`Follows your ${sentinel.label} when it changes (now ${useSettings ? resolvedText : 'off'}).`}
        checked=${useSettings} onValue=${(on) => setVal(on ? 'target' : null)} />` : null}
  </${FieldGroup}>`;
}

function Preview({ draft, valid }) {
  const app = useApp(); const today = app.today();
  const key = JSON.stringify(draft);
  const res = useAnalytics(() => {
    if (!valid) return null;
    const std = { id: draft.id || 'preview', ...toRecord(draft) };
    const now = evaluateStandard(app.dv, std, today);
    const asIf = { ...std, effectiveFrom: '1970-01-01', active: true };
    const week = [];
    for (let i = 7; i >= 1; i--) { const d = addDays(today, -i); week.push({ date: d, ev: evaluateStandard(app.dv, asIf, d) }); }
    return { now, week };
  }, [key, valid, today]);
  if (!valid) return html`<div class="set-preview muted small">Complete the fields above to preview how today scores.</div>`;
  if (!res) return null;
  const ev = res.now;
  const src = ev.source === 'manual' ? 'entered by hand' : ev.source === 'auto' ? 'automatic' : 'no data yet';
  return html`<div class="set-preview stack sm" aria-live="polite">
    <div class="row between"><span class="eyebrow">Preview · today</span><${Pill} tone=${STATUS_TONE[ev.status]}>${statusLabel(ev)}</${Pill}></div>
    <div class="small dim">${ev.status === 'na' ? (draftAppliesToday(draft, today) ? 'Nothing due today.' : 'Does not apply today.')
      : `${ev.display && ev.display !== '—' ? `Value ${shown(ev.display)}` : 'No value yet'} · ${src}${targetPhrase(ev.target, draft.kind) ? ` · target ${targetPhrase(ev.target, draft.kind)}` : ''}`}</div>
    <div class="set-week" role="list" aria-label="Last 7 days with this definition">
      ${res.week.map(({ date, ev: e }) => html`<div role="listitem" class=${cx('set-week-day', e.status)} title=${`${fmtDate(date)}: ${statusLabel(e)}`}>
        <span class="xs muted">${DAY_LABELS[dayOfWeek(date)].slice(0, 2)}</span><i></i></div>`)}
      <span class="xs muted" style="align-self:center">Last 7 days with this definition</span>
    </div>
  </div>`;
}
const SINCE_ALWAYS = '2000-01-01';
const draftAppliesToday = (d, today) => Array.isArray(d.days) && d.days.includes(dayOfWeek(today)) && d.effectiveFrom <= today;
