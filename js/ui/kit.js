// FORGE UI kit. Every screen builds from these. Props are documented inline.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { ICONS } from './icon-paths.js';
import { useApp } from './ctx.js';
import { GlobalActions } from './chrome.js';

const cx = (...a) => a.filter(Boolean).join(' ');
export { cx, html };

/** <Icon name="train" size={20} /> — names in js/ui/icon-paths.js */
export function Icon({ name, size = 20, class: cls, style, strokeWidth = 1.75, title }) {
  const inner = ICONS[name] || ICONS.info;
  return html`<svg class=${cls} style=${style} width=${size} height=${size} viewBox="0 0 24 24" fill=${name === 'starFill' ? 'currentColor' : 'none'}
    stroke="currentColor" stroke-width=${strokeWidth} stroke-linecap="round" stroke-linejoin="round" aria-hidden=${title ? undefined : 'true'}
    role=${title ? 'img' : undefined} aria-label=${title} dangerouslySetInnerHTML=${{ __html: inner }}></svg>`;
}

/** Page wrapper: { title, sub, actions (node), back (bool|path), wide, children } */
export function Page({ title, sub, actions, back, wide, children }) {
  const app = useApp();
  return html`<div class=${cx('page', wide && 'wide')}>
    <header class="head">
      <div class="row top" style="gap:6px;min-width:0">
        ${back ? html`<button class="icon-btn" aria-label="Back" onClick=${() => (typeof back === 'string' ? app.nav(back) : app.back())}><${Icon} name="chevronLeft" /></button>` : null}
        <div style="min-width:0"><h1>${title}</h1>${sub ? html`<div class="sub">${sub}</div>` : null}</div>
      </div>
      <div class="actions">${actions || null}<${GlobalActions} /></div>
    </header>
    <div class="stack lg">${children}</div>
  </div>`;
}

/** Section heading row: { title, meta, action, children } */
export function Section({ title, meta, action, children }) {
  return html`<section class="stack sm">
    ${title || meta || action ? html`<div class="section-title"><h2>${title}</h2><div class="row" style="gap:8px">${meta ? html`<span class="meta">${meta}</span>` : null}${action || null}</div></div>` : null}
    ${children}
  </section>`;
}

/** Card: { title, meta, action, tight, flush, inset, onClick, class, style, children } */
export function Card({ title, meta, action, tight, flush, inset, onClick, class: cls, style, children }) {
  const clickable = typeof onClick === 'function';
  return html`<div class=${cx('card', tight && 'tight', flush && 'flush', inset && 'inset', clickable && 'link', cls)} style=${style}
    onClick=${onClick} role=${clickable ? 'button' : undefined} tabIndex=${clickable ? 0 : undefined}
    onKeyDown=${clickable ? (e) => { if (e.key === 'Enter') onClick(e); } : undefined}>
    ${title || meta || action ? html`<div class="card-title" style=${flush ? 'padding:14px 14px 0' : ''}><h3>${title}</h3><div class="row" style="gap:8px">${meta ? html`<span class="meta">${meta}</span>` : null}${action || null}</div></div>` : null}
    ${children}
  </div>`;
}

/**
 * Stat tile: { label, value, unit, delta (string), tone ('good'|'bad'|null), sub, spark (node), lg, onClick }
 * `value` should already be formatted; pass '—' for unknown.
 */
export function Stat({ label, value, unit, delta, tone, sub, spark, lg, onClick }) {
  return html`<div class=${cx('stat', lg && 'lg')} onClick=${onClick} style=${onClick ? 'cursor:pointer' : ''}>
    <div class="label">${label}</div>
    <div class="value">${value ?? '—'}${unit && value != null && value !== '—' ? html`<small>${unit}</small>` : null}</div>
    ${delta ? html`<div class=${cx('delta', tone && 'ink-' + tone)}>${delta}</div>` : null}
    ${sub ? html`<div class="delta">${sub}</div>` : null}
    ${spark || null}
  </div>`;
}

/** Pill: { tone ('good'|'warn'|'bad'|'accent'|null), dot, children } */
export function Pill({ tone, dot, children, title }) {
  return html`<span class=${cx('pill', tone)} title=${title}>${dot ? html`<span class="dot"></span>` : null}${children}</span>`;
}

/** Button: { variant ('primary'|'ghost'|'danger'|default), size ('sm'|'lg'), icon, block, loading, ...native } */
export function Button({ variant, size, icon, block, loading, children, class: cls, disabled, ...rest }) {
  return html`<button class=${cx('btn', variant, size, block && 'block', cls)} disabled=${disabled || loading} ...${rest}>
    ${loading ? html`<span class="spinner"></span>` : icon ? html`<${Icon} name=${icon} />` : null}${children}
  </button>`;
}

/** IconButton: { icon, label (required, a11y), onClick, bordered, sm, ...native } */
export function IconButton({ icon, label, bordered, sm, class: cls, ...rest }) {
  return html`<button class=${cx('icon-btn', bordered && 'bordered', sm && 'sm', cls)} aria-label=${label} title=${label} ...${rest}><${Icon} name=${icon} /></button>`;
}

/** Field wrapper: { label, hint, error, children } */
export function Field({ label, hint, error, children, class: cls }) {
  return html`<label class=${cx('field', cls)}>${label ? html`<span class="label-text">${label}</span>` : null}${children}
    ${error ? html`<span class="error">${error}</span>` : hint ? html`<span class="hint">${hint}</span>` : null}</label>`;
}

/** Text input bound to value/onInput: { value, onValue(v), type, placeholder, mono, sm, ...native } */
export function Input({ value, onValue, mono, sm, class: cls, ...rest }) {
  return html`<input class=${cx('input', mono && 'mono', sm && 'sm', cls)} value=${value ?? ''} onInput=${(e) => onValue && onValue(e.currentTarget.value)} ...${rest} />`;
}

/** Number input: { value, onValue(number|null), step, min, max, suffix, placeholder } — returns null for empty. */
export function NumberInput({ value, onValue, suffix, step = 'any', class: cls, ...rest }) {
  const input = html`<input class=${cx('input mono', cls)} type="number" inputmode="decimal" step=${step} value=${value ?? ''}
    onInput=${(e) => { const t = e.currentTarget.value; onValue && onValue(t === '' ? null : Number(t)); }} ...${rest} />`;
  return suffix ? html`<div class="input-group">${input}<span class="suffix">${suffix}</span></div>` : input;
}

/** Time input 'HH:MM': { value, onValue } */
export function TimeInput({ value, onValue, ...rest }) {
  return html`<input class="input mono" type="time" value=${value || ''} onInput=${(e) => onValue && onValue(e.currentTarget.value)} ...${rest} />`;
}

/** Select: { value, onValue, options: [{value, label}] | [string] } */
export function Select({ value, onValue, options, class: cls, ...rest }) {
  return html`<select class=${cx('select', cls)} value=${value} onChange=${(e) => onValue && onValue(e.currentTarget.value)} ...${rest}>
    ${options.map((o) => (typeof o === 'string' ? html`<option value=${o}>${o}</option>` : html`<option value=${o.value}>${o.label}</option>`))}
  </select>`;
}

/** Textarea: { value, onValue, rows, placeholder } */
export function Textarea({ value, onValue, class: cls, ...rest }) {
  return html`<textarea class=${cx('textarea', cls)} value=${value ?? ''} onInput=${(e) => onValue && onValue(e.currentTarget.value)} ...${rest}></textarea>`;
}

/** Segmented control: { value, onValue, options: [{value, label}] | [string], block } */
export function Segmented({ value, onValue, options, block, label }) {
  return html`<div class=${cx('seg', block && 'block')} role="group" aria-label=${label}>
    ${options.map((o) => { const v = typeof o === 'string' ? o : o.value; const l = typeof o === 'string' ? o : o.label;
      return html`<button type="button" aria-pressed=${String(v === value)} onClick=${() => onValue && onValue(v)}>${l}</button>`; })}
  </div>`;
}

/** Toggle switch: { checked, onValue(bool), label } */
export function Toggle({ checked, onValue, label, disabled }) {
  return html`<button type="button" class="toggle" role="switch" aria-checked=${String(!!checked)} aria-label=${label} disabled=${disabled}
    onClick=${() => onValue && onValue(!checked)}></button>`;
}

/** Toggle row: { label, sub, checked, onValue } */
export function ToggleRow({ label, sub, checked, onValue, disabled }) {
  return html`<div class="row between" style="padding:6px 0"><div class="grow"><div class="strong small">${label}</div>${sub ? html`<div class="xs muted">${sub}</div>` : null}</div>
    <${Toggle} checked=${checked} onValue=${onValue} label=${label} disabled=${disabled} /></div>`;
}

/** Chips: { options: [{value,label}], value (array when multi), onValue, multi } */
export function Chips({ options, value, onValue, multi }) {
  const on = (v) => (multi ? (value || []).includes(v) : value === v);
  const click = (v) => { if (!onValue) return; if (!multi) return onValue(v); const s = new Set(value || []); s.has(v) ? s.delete(v) : s.add(v); onValue([...s]); };
  return html`<div class="chips">${options.map((o) => { const v = typeof o === 'string' ? o : o.value; const l = typeof o === 'string' ? o : o.label;
    return html`<button type="button" class="chip" aria-pressed=${String(on(v))} onClick=${() => click(v)}>${l}</button>`; })}</div>`;
}

/** 1–5 rating: { value, onValue, low, high } */
export function Scale5({ value, onValue, low, high }) {
  return html`<div class="stack xs"><div class="scale-row">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" aria-pressed=${String(value === n)} onClick=${() => onValue(value === n ? null : n)}>${n}</button>`)}</div>
    ${low || high ? html`<div class="row between xs muted"><span>${low}</span><span>${high}</span></div>` : null}</div>`;
}

/** Stepper: { value, onValue, step, min, max, dp } */
export function Stepper({ value, onValue, step = 1, min = -Infinity, max = Infinity, dp = 0 }) {
  const set = (v) => onValue(Math.min(max, Math.max(min, Math.round(v * 10 ** dp) / 10 ** dp)));
  return html`<div class="stepper"><button type="button" aria-label="Decrease" onClick=${() => set((value || 0) - step)}>−</button>
    <input inputmode="decimal" value=${value ?? ''} onInput=${(e) => { const t = e.currentTarget.value; if (t === '') onValue(null); else if (!isNaN(Number(t))) onValue(Number(t)); }} />
    <button type="button" aria-label="Increase" onClick=${() => set((value || 0) + step)}>+</button></div>`;
}

/** Check box: { state (true|false|null|'mixed'), onClick, missed, label } */
export function Check({ state, onClick, missed, label }) {
  const aria = state === 'mixed' ? 'mixed' : String(state === true);
  return html`<button type="button" class=${cx('check', missed && 'missed')} role="checkbox" aria-checked=${aria} aria-label=${label} onClick=${onClick}><${Icon} name="check" /></button>`;
}

/** List container + rows. ListRow: { lead (icon name | node), title, meta, trail (node), onClick } */
export function List({ children }) { return html`<div class="list">${children}</div>`; }
export function ListRow({ lead, title, meta, trail, onClick, children }) {
  return html`<div class=${cx('list-row', onClick && 'link')} onClick=${onClick} role=${onClick ? 'button' : undefined} tabIndex=${onClick ? 0 : undefined}>
    ${lead ? (typeof lead === 'string' ? html`<div class="lead"><${Icon} name=${lead} /></div>` : lead) : null}
    <div class="grow"><div class="title ellipsis">${title}</div>${meta ? html`<div class="meta">${meta}</div>` : null}${children}</div>
    ${trail ? html`<div class="trail">${trail}</div>` : onClick ? html`<${Icon} name="chevronRight" size=${16} class="muted" />` : null}
  </div>`;
}

/** Empty state: { title, children, action } */
export function Empty({ title, children, action }) {
  return html`<div class="empty">${title ? html`<div class="title">${title}</div>` : null}<div>${children}</div>${action ? html`<div style="margin-top:12px">${action}</div>` : null}</div>`;
}

/** Notice: { tone ('warn'|'bad'|'good'|null), icon, children } */
export function Notice({ tone, icon, children }) {
  const ic = icon || (tone === 'bad' ? 'alert' : tone === 'warn' ? 'alert' : tone === 'good' ? 'check' : 'info');
  return html`<div class=${cx('notice', tone)}><${Icon} name=${ic} /><div>${children}</div></div>`;
}

/** Meter: { value, max, tone ('good'|'warn'|'bad'|'accent'), label, valueText } */
export function Meter({ value, max = 100, tone, label, valueText }) {
  const pct = max > 0 && value != null ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const bar = html`<div class=${cx('meter', tone)}><i style=${`width:${pct}%`}></i></div>`;
  if (!label) return bar;
  return html`<div class="meter-row"><span class="dim ellipsis">${label}</span>${bar}<span class="v">${valueText}</span></div>`;
}

export function Spinner({ lg }) { return html`<span class=${cx('spinner', lg && 'lg')} role="status" aria-label="Loading"></span>`; }
export function Skeleton({ h = 16, w = '100%' }) { return html`<div class="skeleton" style=${`height:${h}px;width:${w}`}></div>`; }

/** Key/value list: { items: [[label, value]] } */
export function KV({ items }) {
  return html`<dl class="kv">${items.filter(Boolean).map(([k, v]) => html`<dt>${k}</dt><dd>${v ?? '—'}</dd>`)}</dl>`;
}

/** Status band pill for readiness/recovery: { band ('green'|'yellow'|'red'|null) } */
export function BandPill({ band, children }) {
  const tone = band === 'green' ? 'good' : band === 'yellow' ? 'warn' : band === 'red' ? 'bad' : null;
  const label = children || (band ? band[0].toUpperCase() + band.slice(1) : 'No data');
  return html`<${Pill} tone=${tone} dot>${label}</${Pill}>`;
}

/** Sheet body helpers (inside app.sheet(render)): SheetHead + SheetFoot */
export function SheetHead({ title, onClose, children }) {
  return html`<div class="sheet-head"><h2>${title}</h2><div class="row" style="gap:4px">${children}${onClose ? html`<${IconButton} icon="x" label="Close" onClick=${onClose} />` : null}</div></div>`;
}
export function SheetFoot({ children }) { return html`<div class="sheet-foot">${children}</div>`; }

/** File picker button: { accept, multiple, capture, onFiles(FileList->Array), children, variant, icon, size } */
export function FileButton({ accept, multiple, capture, onFiles, children, variant, icon, size, block, class: cls }) {
  const ref = useRef(null);
  return html`<span style=${block ? 'display:block' : 'display:inline-flex'}>
    <input ref=${ref} type="file" accept=${accept} multiple=${multiple} capture=${capture} style="display:none"
      onChange=${(e) => { const f = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; if (f.length) onFiles(f); }} />
    <${Button} variant=${variant} icon=${icon} size=${size} block=${block} class=${cls} onClick=${() => ref.current && ref.current.click()}>${children}</${Button}>
  </span>`;
}

/** Collapsible: { summary, open, children } */
export function Disclosure({ summary, open, children }) {
  return html`<details class="more" open=${open}><summary>${summary}</summary><div style="margin-top:10px">${children}</div></details>`;
}

/** Copyable code box: { value, label } */
export function CopyBox({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return undefined; const t = setTimeout(() => setDone(false), 1600); return () => clearTimeout(t); }, [done]);
  return html`<div class="stack sm"><div class="code-box">${value}</div>
    <${Button} size="sm" icon=${done ? 'check' : 'copy'} onClick=${async () => { try { await navigator.clipboard.writeText(value); setDone(true); } catch { /* ignore */ } }}>${done ? 'Copied' : label}</${Button}></div>`;
}
