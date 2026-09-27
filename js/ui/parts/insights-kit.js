// Insights (UI-D): shared building blocks — chart cards with takeaway + n + source-aware empty states,
// KPI tiles with sparklines, stat grids, split bars and meter rows. Visual language from kit.js/app.css.
import { html } from '../../vendor/preact-htm.js';
import { useApp, useAnalytics } from '../ctx.js';
import { Stat, Button, Icon, cx } from '../kit.js';
import { Sparkline, SERIES } from '../charts.js';
import { useBoxWidth } from './insights-charts.js';
import { fmtNum } from '../../core/util.js';
import { openMealCapture } from '../actions/meal.js';
import { startWorkout, openCardioLog } from '../actions/workout.js';
import { openWeighIn } from '../actions/weight.js';
import { openCheckin } from '../actions/checkin.js';
import { openDoseLog } from '../actions/stack.js';

/**
 * Memoized section computation (store version + deps) that also reports how long it took:
 * const { data, ms } = useInsight(() => compute(dv, from, to), [from, to]). data is null if it threw.
 */
export function useInsight(fn, deps = []) {
  const res = useAnalytics(() => {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const data = fn();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { data, ms: Math.round((t1 - t0) * 10) / 10 };
  }, deps);
  return res || { data: null, ms: null };
}

/** What fills each view, and the one action that starts filling it. */
export const SOURCES = {
  whoop: { name: 'WHOOP', action: 'Connect WHOOP', icon: 'watch', run: (app) => app.nav('/settings/integrations') },
  health: { name: 'Apple Health', action: 'Import Apple Health', icon: 'heart', run: (app) => app.nav('/import/health') },
  meals: { name: 'meal logs', action: 'Log a meal', icon: 'camera', run: (app) => openMealCapture(app, {}) },
  sessions: { name: 'workout logs', action: 'Start a workout', icon: 'train', run: (app) => startWorkout(app, {}) },
  cardio: { name: 'cardio logs', action: 'Log cardio', icon: 'bike', run: (app) => openCardioLog(app, {}) },
  weighins: { name: 'weigh-ins', action: 'Log a weigh-in', icon: 'scale', run: (app) => openWeighIn(app, {}) },
  checkins: { name: 'daily check-ins', action: 'Open check-in', icon: 'edit', run: (app) => openCheckin(app, {}) },
  plan: { name: 'plan blocks', action: 'Open Plan', icon: 'plan', run: (app) => app.nav('/plan') },
  calendar: { name: 'Google Calendar', action: 'Connect calendar', icon: 'calendar', run: (app) => app.nav('/settings/integrations') },
  protocols: { name: 'protocol items', action: 'Open Protocols', icon: 'pill', run: (app) => app.nav('/protocols') },
  doses: { name: 'dose logs', action: 'Log a dose', icon: 'pill', run: (app) => openDoseLog(app, {}) },
  labs: { name: 'lab panels', action: 'Open Labs', icon: 'labs', run: (app) => app.nav('/labs') },
  goal: { name: 'a goal weight range', action: 'Set goal', icon: 'target', run: (app) => app.nav('/settings/profile') },
  targets: { name: 'targets', action: 'Open targets', icon: 'target', run: (app) => app.nav('/settings/targets') },
  standards: { name: 'daily standards', action: 'Open Today', icon: 'today', run: (app) => app.nav('/today') },
  reviews: { name: 'nutrition reviews', action: 'Open Fuel', icon: 'fuel', run: (app) => app.nav('/fuel') },
};

/** Button that runs a source's action. */
export function SourceButton({ source, size = 'sm', variant, label }) {
  const app = useApp(); const s = SOURCES[source];
  if (!s) return null;
  return html`<${Button} size=${size} variant=${variant} icon=${s.icon} onClick=${() => s.run(app)}>${label || s.action}</${Button}>`;
}

/** Compact empty state inside a card: names the source that fills the view and offers its action. */
export function SourceEmpty({ source, text, children }) {
  const s = SOURCES[source];
  return html`<div class="ins-empty">
    <div class="grow"><div class="small">${text || `No data in this range.`}</div>
      ${s ? html`<div class="xs muted">Filled by ${s.name}.</div>` : null}${children || null}</div>
    ${s ? html`<${SourceButton} source=${source} />` : null}
  </div>`;
}

/**
 * Chart card: { title, unit, n, nUnit ('days'), takeaway, empty, source, emptyText, action, note, children }
 * Header shows title · unit and "n = 28 days"; the takeaway sits under it; empty → SourceEmpty.
 */
export function ChartCard({ title, unit, n, nUnit = 'days', takeaway, empty, source, emptyText, action, note, children, class: cls }) {
  const meta = n != null && !empty ? `n = ${fmtNum(n)} ${n === 1 ? nUnit.replace(/s$/, '') : nUnit}` : null;
  return html`<div class=${cx('card ins-card', cls)}>
    <div class="ins-card-head">
      <h3>${title}${unit ? html`<span class="ins-unit">${unit}</span>` : null}</h3>
      <div class="row" style="gap:8px">${meta ? html`<span class="meta mono">${meta}</span>` : null}${action || null}</div>
    </div>
    ${empty ? html`<${SourceEmpty} source=${source} text=${emptyText} />` : html`
      ${takeaway ? html`<p class="ins-take">${takeaway}</p>` : null}
      ${children}
      ${note ? html`<div class="ins-note">${note}</div>` : null}`}
  </div>`;
}

/** Section-level empty state (primary source missing): { icon, title, text, sources: [key], points: [string] } */
export function SectionEmpty({ icon = 'insights', title, text, sources = [], points = [], children }) {
  return html`<div class="card ins-section-empty">
    <div class="row top" style="gap:14px">
      <div class="ins-empty-icon"><${Icon} name=${icon} size=${22} /></div>
      <div class="grow stack sm">
        <div class="strong">${title}</div>
        ${text ? html`<div class="small dim">${text}</div>` : null}
        ${points.length ? html`<ul class="ins-points">${points.map((p) => html`<li>${p}</li>`)}</ul>` : null}
        ${children || null}
        ${sources.length ? html`<div class="row wrap" style="gap:8px;margin-top:4px">${sources.map((s, i) => html`<${SourceButton} source=${s} variant=${i === 0 ? 'primary' : undefined} />`)}</div>` : null}
      </div>
    </div>
  </div>`;
}

/** Sparkline that fills its container width. */
export function Spark({ values, height = 30, color }) {
  const [ref, w] = useBoxWidth(140);
  return html`<div ref=${ref} class="ins-spark">${(values || []).filter((v) => v != null).length >= 2 ? html`<${Sparkline} values=${values} width=${w} height=${height} color=${color || 'var(--text-3)'} />` : html`<div style=${`height:${height}px`}></div>`}</div>`;
}

/**
 * KPI tile: { label, value, unit, delta ({text, tone}|null), deltaNote, sub, values (sparkline), onClick, empty }
 */
export function Kpi({ label, value, unit, delta, deltaNote, sub, values, onClick, empty }) {
  return html`<div class=${cx('card ins-kpi', onClick && 'link')} onClick=${onClick} role=${onClick ? 'button' : undefined} tabIndex=${onClick ? 0 : undefined}
    onKeyDown=${onClick ? (e) => { if (e.key === 'Enter') onClick(e); } : undefined}>
    <div class="row between" style="gap:6px"><span class="ins-kpi-label">${label}</span>${onClick ? html`<${Icon} name="chevronRight" size=${14} class="muted" />` : null}</div>
    <div class="ins-kpi-value">${value ?? '—'}${unit && value != null && value !== '—' ? html`<small>${unit}</small>` : null}</div>
    <div class=${cx('ins-kpi-delta', delta && delta.tone && 'ink-' + delta.tone)}>${delta ? delta.text : html`<span class="muted">${empty || 'No prior period'}</span>`}${delta && deltaNote ? html`<span class="muted"> ${deltaNote}</span>` : null}</div>
    ${sub ? html`<div class="ins-kpi-sub">${sub}</div>` : null}
    <${Spark} values=${values} />
  </div>`;
}

/** Row of Stat tiles in one card: items [{ label, value, unit, delta ({text, tone}), sub }] */
export function StatGrid({ items, cols = 4 }) {
  const list = items.filter(Boolean);
  return html`<div class="card ins-stats"><div class=${cx('grid', cols === 3 ? 'three' : cols === 2 ? 'two' : 'four')}>
    ${list.map((s) => html`<${Stat} label=${s.label} value=${s.value} unit=${s.unit} delta=${s.delta ? s.delta.text : null} tone=${s.delta ? s.delta.tone : null} sub=${s.sub} />`)}
  </div></div>`;
}

/** Horizontal part-to-whole bar: parts [{ label, value, text }] (series colors in order). */
export function SplitBar({ parts }) {
  const total = parts.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0);
  if (!total) return null;
  return html`<div class="stack sm">
    <div class="ins-split">${parts.map((p, i) => (p.value > 0 ? html`<i style=${`width:${(p.value / total) * 100}%;background:${p.color || SERIES[i]}`} title=${p.label}></i>` : null))}</div>
    <div class="legend" style="margin-top:0">${parts.map((p, i) => html`<span><i class="box" style=${`background:${p.color || SERIES[i]}`}></i>${p.label} <b class="mono" style="font-weight:550">${p.text}</b></span>`)}</div>
  </div>`;
}

/** Meter rows with a flexible label column: rows [{ label, sub, value, max, tone, text, marker }] */
export function MeterRows({ rows }) {
  return html`<div class="ins-meters">${rows.map((r) => {
    const pct = r.max > 0 && r.value != null ? Math.max(0, Math.min(100, (r.value / r.max) * 100)) : 0;
    const mk = r.marker != null && r.max > 0 ? Math.max(0, Math.min(100, (r.marker / r.max) * 100)) : null;
    return html`<div class="ins-meter-row">
      <div class="ins-meter-label"><div class="ellipsis">${r.label}</div>${r.sub ? html`<div class="xs muted">${r.sub}</div>` : null}</div>
      <div class=${cx('meter', r.tone)} style="position:relative"><i style=${`width:${pct}%`}></i>${mk != null ? html`<b class="ins-meter-mark" style=${`left:${mk}%`}></b>` : null}</div>
      <div class="v mono">${r.text}</div>
    </div>`;
  })}</div>`;
}

/** Associations disclaimer used under pattern lists. */
export function AssocNote({ extra }) {
  return html`<div class="ins-note"><${Icon} name="info" size=${13} /> Associations in your own logs, not causes.${extra ? ' ' + extra : ''}</div>`;
}

/** Loading placeholder while a section module or computation loads. */
export function SectionSkeleton() {
  return html`<div class="stack"><div class="card"><div class="grid four">${[0, 1, 2, 3].map(() => html`<div class="stack xs"><div class="skeleton" style="height:12px;width:60%"></div><div class="skeleton" style="height:24px;width:80%"></div></div>`)}</div></div>
    <div class="card"><div class="skeleton" style="height:180px"></div></div></div>`;
}

