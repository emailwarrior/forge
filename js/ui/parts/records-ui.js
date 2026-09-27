// Records area shared UI pieces (Protocols, Labs, Finance, Journal sheets and screens).
import { html, useState } from '../../vendor/preact-htm.js';
import { Meter, Chips, cx } from '../kit.js';
import { fmtDate, dayOfWeek } from '../../core/util.js';
import { SITES } from './records-protocols.js';
import { fmtQty } from './records-util.js';

/**
 * Field-like wrapper for button groups (chips, segmented controls, lists of inputs): { label, hint, error }.
 * Unlike kit Field it is not a <label>, so tapping the label or hint never activates the first button inside.
 */
export function Group({ label, hint, error, children, class: cls }) {
  return html`<div class=${cx('field', cls)} role="group" aria-label=${label}>${label ? html`<span class="label-text">${label}</span>` : null}${children}
    ${error ? html`<span class="error">${error}</span>` : hint ? html`<span class="hint">${hint}</span>` : null}</div>`;
}

/** Native date input: { value 'YYYY-MM-DD'|null, onValue(v|null), min, max } */
export function DateInput({ value, onValue, class: cls, ...rest }) {
  return html`<input class=${cx('input mono', cls)} type="date" value=${value || ''}
    onInput=${(e) => onValue && onValue(e.currentTarget.value || null)} ...${rest} />`;
}

/** Injection-site chips with the last used site: { value, onValue, last: {site, date}|null, next } */
export function SitePicker({ value, onValue, last, next }) {
  return html`<div class="stack xs">
    <${Chips} options=${SITES.map((s) => ({ value: s, label: s }))} value=${value} onValue=${(v) => onValue(v === value ? '' : v)} />
    <div class="xs muted">${last && last.site ? `Last: ${last.site} · ${fmtDate(last.date, { dow: false })}` : 'No site recorded yet'}${next ? ` · next in rotation: ${next}` : ''}</div>
  </div>`;
}

/**
 * Week total vs target: { from, to, sofar, after (with this dose, or null), target (number|null), unit, unconverted }
 * "This week (Sep 21–27)  1 / 2 mg" + meter; "With this dose: 2 mg".
 */
export function WeekTotal({ from, to, sofar, after, target, unit, unconverted = 0 }) {
  const shown = after != null ? after : sofar;
  const range = `${fmtDate(from, { dow: false })}–${from.slice(0, 7) === to.slice(0, 7) ? Number(to.slice(8)) : fmtDate(to, { dow: false })}`;
  const u = unit ? ` ${unit}` : '';
  const over = target != null && shown > target + 1e-9;
  return html`<div class="rec-week stack xs">
    <div class="row between"><span class="xs muted">This week (${range})</span>
      <span class="mono small">${fmtQty(sofar)}${target != null ? ` / ${fmtQty(target)}` : ''}${u}</span></div>
    ${target != null ? html`<${Meter} value=${shown} max=${target} tone=${over ? 'warn' : 'accent'} />` : null}
    ${after != null && after !== sofar ? html`<div class="xs dim">With this dose: <span class="mono">${fmtQty(after)}${target != null ? ` / ${fmtQty(target)}` : ''}${u}</span>${over ? ' · above the weekly target' : ''}</div>` : null}
    ${unconverted ? html`<div class="xs muted">${unconverted} dose${unconverted === 1 ? '' : 's'} in another unit not included.</div>` : null}
  </div>`;
}

const CAL_LABEL = { taken: 'Taken', missed: 'Missed', due: 'Due today', extra: 'Taken (not scheduled)', none: 'Not scheduled' };
/**
 * Adherence calendar: one column per Mon-start week, Monday on top.
 * days: [{ date, state: 'taken'|'missed'|'due'|'extra'|'none' }] (chronological).
 */
export function AdherenceCalendar({ days = [] }) {
  const [tip, setTip] = useState(null);
  if (!days.length) return null;
  const cells = [...Array(dayOfWeek(days[0].date)).fill(null), ...days];
  return html`<div class="rec-cal" onPointerLeave=${() => setTip(null)}>
    <div class="rec-cal-days xs muted" aria-hidden="true"><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span><span>S</span></div>
    <div class="rec-cal-grid" role="img" aria-label=${`${days.filter((d) => d.state === 'taken' || d.state === 'extra').length} days taken, ${days.filter((d) => d.state === 'missed').length} missed`}>
      ${cells.map((d) => (d ? html`<i class=${'s-' + d.state} title=${`${fmtDate(d.date)} · ${CAL_LABEL[d.state]}`}
        onPointerEnter=${() => setTip(d)} onPointerDown=${() => setTip(d)}></i>` : html`<i class="pad"></i>`))}
    </div>
    <div class="xs muted rec-cal-tip">${tip ? `${fmtDate(tip.date)} · ${CAL_LABEL[tip.state]}` : 'Tap a day for details'}</div>
  </div>`;
}
export function AdherenceLegend() {
  return html`<div class="rec-cal-legend xs muted"><span><i class="s-taken"></i>Taken</span><span><i class="s-missed"></i>Missed</span><span><i class="s-none"></i>Not scheduled</span></div>`;
}

/** Day label that fits a stat tile: Today / Yesterday / Tomorrow / "Sep 28". */
export function shortDay(date, today) {
  if (!date) return '—';
  if (date === today) return 'Today';
  const [a, b] = [Date.parse(date + 'T00:00:00Z'), Date.parse(today + 'T00:00:00Z')];
  const d = Math.round((a - b) / 86400000);
  if (d === -1) return 'Yesterday';
  if (d === 1) return 'Tomorrow';
  return fmtDate(date, { dow: false, year: date.slice(0, 4) !== today.slice(0, 4) });
}

/** One quiet guardrail line used on protocol views. */
export function RecordsOnlyNote() {
  return html`<p class="xs muted center rec-quiet">FORGE records what is taken; it never suggests dose changes.</p>`;
}
