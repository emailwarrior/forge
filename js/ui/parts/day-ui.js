// Day area shared UI (Today + Plan): plan-block status control, category swatches,
// 1–10 rating, strain gauge, small labelled values. Styles live in css/day.css.
import { html } from '../../vendor/preact-htm.js';
import { Icon, cx } from '../kit.js';
import { PLAN_CATEGORIES } from '../../core/schema.js';
import { isNum, fmtNum } from '../../core/util.js';

export const CATEGORY_OPTIONS = PLAN_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));
const CAT_LABEL = Object.fromEntries(PLAN_CATEGORIES.map((c) => [c.id, c.label]));
export const catLabel = (id) => CAT_LABEL[id] || 'Other';

/** Small category color square: { category } (colors from css/day.css `.dc-*`). */
export function CatSwatch({ category, title }) {
  return html`<i class=${cx('day-swatch', 'dc-' + (category || 'personal'))} title=${title || catLabel(category)} aria-hidden="true"></i>`;
}

const STATUS_OPTS = [
  { value: 'done', label: 'Done', icon: 'check' },
  { value: 'partial', label: 'Partial', icon: 'minus' },
  { value: 'skipped', label: 'Skip', icon: 'x' },
];
/**
 * Done / Partial / Skip for a plan block: { status, onValue(next) }. Tapping the active
 * option returns the block to 'planned'.
 */
export function StatusControl({ status, onValue, label = 'Block status' }) {
  return html`<div class="day-status" role="group" aria-label=${label} onClick=${(e) => e.stopPropagation()}>
    ${STATUS_OPTS.map((o) => html`<button type="button" class=${'st-' + o.value} aria-pressed=${String(status === o.value)}
      title=${o.value === 'skipped' ? 'Skipped' : o.label} onClick=${() => onValue(status === o.value ? 'planned' : o.value)}>
      <${Icon} name=${o.icon} size=${13} strokeWidth=${2.4} /><span>${o.label}</span></button>`)}
  </div>`;
}

/** Writes a block status (the control already resolves the toggle). */
export function setBlockStatus(app, id, status) {
  app.store.update('plan', id, { status });
}

/** 1–10 rating: { value, onValue } — tap the selected value again to clear. */
export function Scale10({ value, onValue, low, high }) {
  return html`<div class="stack xs"><div class="scale-row day-scale10">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => html`<button type="button"
    aria-pressed=${String(value === n)} onClick=${() => onValue(value === n ? null : n)}>${n}</button>`)}</div>
    ${low || high ? html`<div class="row between xs muted"><span>${low}</span><span>${high}</span></div>` : null}</div>`;
}

/**
 * WHOOP strain (0–21) against a target range: { value, target: [lo, hi] }.
 * Track with the target band shaded and a marker for the day's strain.
 */
export function StrainGauge({ value, target }) {
  const P = (v) => Math.max(0, Math.min(100, (v / 21) * 100));
  const [lo, hi] = Array.isArray(target) ? target : [null, null];
  const within = isNum(value) && isNum(lo) && isNum(hi) ? value >= lo && value <= hi : null;
  return html`<div class="day-strain" role="img" aria-label=${`Strain ${isNum(value) ? fmtNum(value, 1) : 'unknown'}${isNum(lo) ? `, target ${lo}–${hi}` : ''}`}>
    <div class="track">
      ${isNum(lo) && isNum(hi) ? html`<div class="band" style=${`left:${P(lo)}%;width:${P(hi) - P(lo)}%`}></div>` : null}
      ${isNum(value) ? html`<div class=${cx('mk', within === true && 'in')} style=${`left:${P(value)}%`}></div>` : null}
    </div>
    <div class="scale mono"><span>0</span><span>7</span><span>14</span><span>21</span></div>
  </div>`;
}

/**
 * Field-like wrapper that is NOT a <label> (for button groups such as Chips/Scale5, where a
 * label would forward clicks on its text to the first button): { label, hint, aside, children }
 */
export function Group({ label, hint, aside, children, class: cls }) {
  return html`<div class=${cx('field day-group', cls)}>
    ${label || aside ? html`<div class="row between"><span class="label-text">${label}</span>${aside || null}</div>` : null}
    ${children}${hint ? html`<span class="hint">${hint}</span>` : null}</div>`;
}

/** Label over value, compact: { label, value, unit, sub, tone } */
export function Metric({ label, value, unit, sub, tone, title }) {
  const has = value != null && value !== '—' && value !== '';
  return html`<div class="day-metric" title=${title}>
    <div class="l">${label}</div>
    <div class="v">${has ? value : '—'}${has && unit ? html`<small>${unit}</small>` : null}</div>
    ${sub ? html`<div class=${cx('s', tone && 'ink-' + tone)}>${sub}</div>` : null}
  </div>`;
}
