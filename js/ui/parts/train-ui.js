// Train area shared UI: numeric cells, rest timer (module-level, survives navigation), elapsed clock,
// progression status, hard-sets-per-muscle bars, labels. Pure logic lives in train-logic.js.
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { Pill, Icon, cx } from '../kit.js';
import { parseNum, fmtW, clockText, restView } from './train-logic.js';

/* ----------------------------------------------------------------- labels */
export const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
export const exName = (ex, id) => (ex && ex.name) || (id ? 'Unknown exercise' : '—');
/** 'Chest · barbell' (+ ' · bodyweight' when relevant). */
export function exMeta(ex) {
  if (!ex) return '';
  const type = ex.type || 'strength';
  return [type === 'strength' ? cap(ex.muscle) : cap(type), ex.equipment && ex.equipment !== 'cardio' ? ex.equipment : null].filter(Boolean).join(' · ');
}
export const EQUIPMENT = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight', 'kettlebell', 'band', 'cardio', 'other'];
export const TYPES = [{ value: 'strength', label: 'Strength' }, { value: 'cardio', label: 'Cardio' }, { value: 'mobility', label: 'Mobility' }];

/* ------------------------------------------------------------ number cell */
/**
 * Numeric text cell for fast gym input: { value, onValue(number|null), placeholder, label, mode ('decimal'|'numeric'),
 * class, onFocus }. Keeps the raw text while focused ('185.' stays), commits parsed numbers as you type,
 * selects the content on focus so a new value can be typed straight over it.
 */
export function NumCell({ value, onValue, placeholder, label, mode = 'decimal', class: cls, onFocus, disabled }) {
  const [draft, setDraft] = useState(null);
  const shown = draft != null ? draft : fmtW(value);
  return html`<input class=${cx('tr-num', cls)} type="text" inputmode=${mode} autocomplete="off" autocorrect="off" spellcheck="false"
    enterkeyhint="done" aria-label=${label} placeholder=${placeholder ?? ''} value=${shown} disabled=${disabled}
    onFocus=${(e) => { setDraft(fmtW(value)); const el = e.currentTarget; setTimeout(() => { try { el.setSelectionRange(0, el.value.length); } catch { try { el.select(); } catch { /* ignore */ } } }, 0); if (onFocus) onFocus(e); }}
    onBlur=${() => setDraft(null)}
    onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    onInput=${(e) => { const t = e.currentTarget.value; setDraft(t); const n = parseNum(t); if (n != null || t.trim() === '') onValue(n); }} />`;
}

/* ------------------------------------------------------------- rest timer */
// One timer for the whole app session: module state, so it keeps running while you move between screens.
const rest = { timer: null, subs: new Set() };
const emitRest = () => { for (const f of [...rest.subs]) { try { f(); } catch (e) { console.warn(e); } } };
export const REST_DEFAULT_SEC = 120;
/** Start (or restart) the rest timer: startRest('Bench Press', 120). */
export function startRest(label, sec = REST_DEFAULT_SEC) {
  const now = Date.now();
  rest.timer = { label: label || '', durationMs: sec * 1000, endsAt: now + sec * 1000, alerted: false };
  emitRest();
}
export function addRest(sec) {
  const t = rest.timer; if (!t) return;
  const now = Date.now(); const remaining = t.endsAt - now;
  rest.timer = remaining > 0 ? { ...t, endsAt: t.endsAt + sec * 1000, durationMs: t.durationMs + sec * 1000 } : { ...t, endsAt: now + sec * 1000, durationMs: sec * 1000, alerted: false };
  emitRest();
}
export function stopRest() { rest.timer = null; emitRest(); }
export function restTimer() { return rest.timer; }
/** Current rest timer (re-renders on start/stop/change). */
export function useRest() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); rest.subs.add(f); return () => { rest.subs.delete(f); }; }, []);
  return rest.timer;
}

/** Sticky rest bar above the tab bar (fixed; renders a spacer so it never covers the page end). */
export function RestBar() {
  const t = useRest();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!t) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [t]);
  const v = t ? restView(t, now) : null;
  useEffect(() => {
    document.body.classList.toggle('tr-rest-on', !!t);
    return () => document.body.classList.remove('tr-rest-on');
  }, [!!t]);
  useEffect(() => {
    if (!t || !v || !v.done) return undefined;
    if (!t.alerted) { t.alerted = true; try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch { /* unsupported */ } }
    const h = setTimeout(() => { if (rest.timer === t) stopRest(); }, 10000);
    return () => clearTimeout(h);
  }, [t, v && v.done]);
  if (!t || !v) return null;
  return html`<div class="tr-rest-spacer" aria-hidden="true"></div>
    <div class=${cx('tr-rest', v.done && 'done')} role="timer" aria-live="off">
      <div class="tr-rest-fill" style=${`width:${(v.fraction * 100).toFixed(1)}%`}></div>
      <${Icon} name="timer" size=${18} />
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:8px"><span class="tr-rest-time mono">${v.done ? 'Rest done' : clockText(v.remainingMs + 999)}</span>
          <span class="xs muted ellipsis">${v.done ? clockText(t.durationMs) + ' rest' : t.label}</span></div>
      </div>
      <button class="btn sm" type="button" onClick=${() => addRest(30)}>+30 s</button>
      <button class="btn sm ghost" type="button" onClick=${stopRest}>${v.done ? 'Close' : 'Skip'}</button>
    </div>`;
}

/* -------------------------------------------------------- elapsed clock */
/** Live clock since startAt (1 s tick) or the fixed duration when endAt is set. Renders text. */
export function Elapsed({ startAt, endAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endAt]);
  const a = Date.parse(startAt);
  if (!isFinite(a)) return '—';
  return clockText((endAt ? Date.parse(endAt) : now) - a);
}

/* ------------------------------------------------------ status + bars */
const STATUS = { progressing: ['good', 'Progressing'], plateau: ['warn', 'Plateau'], regressing: ['bad', 'Regressing'], insufficient: [null, 'No trend yet'] };
/** Progression status pill (analytics progression().status). */
export function StatusPill({ status }) {
  const [tone, label] = STATUS[status] || STATUS.insufficient;
  return html`<${Pill} tone=${tone} title=${status === 'insufficient' ? 'Needs 3 sessions with an e1RM (1–12 reps) over 2+ weeks in the last 8' : 'Trend of the last 8 weeks (±0.5% per week)'}>${label}</${Pill}>`;
}

/**
 * Hard sets per muscle this week vs a shaded reference band (lo–hi) and the 4-week average (tick).
 * rows: [{muscle, hardSets, avg4}]
 */
export function MuscleBars({ rows, lo = 10, hi = 20 }) {
  const max = Math.max(hi + 4, ...rows.map((r) => Math.max(r.hardSets || 0, r.avg4 || 0) + 1));
  const P = (v) => Math.max(0, Math.min(100, (v / max) * 100));
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return html`<div class="tr-mbars">
    ${rows.map((r) => html`<div class="tr-mbar" title=${`${cap(r.muscle)}: ${fmt(r.hardSets || 0)} hard sets this week; 4-week average ${fmt(r.avg4 || 0)}`}>
      <span class="tr-mbar-l ellipsis">${cap(r.muscle)}</span>
      <span class="tr-track">
        <i class="tr-band" style=${`left:${P(lo)}%;width:${P(hi) - P(lo)}%`}></i>
        <i class="tr-fill" style=${`width:${P(r.hardSets || 0)}%`}></i>
        ${r.avg4 ? html`<i class="tr-tick" style=${`left:${P(r.avg4)}%`}></i>` : null}
      </span>
      <span class="tr-mbar-v mono">${fmt(r.hardSets || 0)}<span class="muted"> / ${fmt(r.avg4 || 0)}</span></span>
    </div>`)}
  </div>`;
}

/** Small uppercase label + value block used in dense summaries: { label, value, unit, sub } */
export function Metric({ label, value, unit, sub, tone }) {
  return html`<div class="tr-metric"><div class="tr-metric-l">${label}</div>
    <div class=${cx('tr-metric-v', tone && 'ink-' + tone)}>${value ?? '—'}${unit && value != null && value !== '—' ? html`<small>${unit}</small>` : null}</div>
    ${sub ? html`<div class="tr-metric-s">${sub}</div>` : null}</div>`;
}

/** Remember the last value of a ref-like callback across renders without re-subscribing. */
export function useLatest(value) { const r = useRef(value); r.current = value; return r; }
