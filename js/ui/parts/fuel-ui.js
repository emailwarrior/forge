// Fuel: shared UI pieces (meal thumbnails, status lines, time/slot fields, file picking, queue hook).
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { useApp } from '../ctx.js';
import { Icon, Pill, Button, Spinner, cx } from '../kit.js';
import { EncryptedImage } from './media.js';
import { phaseText } from './ai.js';
import { subscribeQueue, jobFor, cancelAnalysis, enqueueAnalysis, isActive } from './fuel-queue.js';
import { SLOTS, slotLabel, mealState, mealPhotos, mealTitle, mealClock, TIME_SOURCE_TEXT, macroLine } from './fuel-logic.js';
import { fmtNum, isNum, fmtTime } from '../../core/util.js';

/** Re-render on analysis-queue changes; returns jobFor(mealId). */
export function useQueue() {
  const [, set] = useState(0);
  useEffect(() => subscribeQueue((r) => set(r)), []);
  return jobFor;
}

/**
 * Open the system file picker synchronously (call it directly from a tap handler so iOS opens the camera/library)
 * → Promise<File[]> ([] when cancelled). Relies on the input's 'cancel' event (Safari 16.4+, Chrome 113+, Firefox 91+);
 * no focus-based fallback, because iOS fires 'change' only after converting the picked photos, which can take seconds.
 */
let pendingPick = null;
export function pickFiles({ accept = 'image/*', multiple = false, capture } = {}) {
  if (typeof document === 'undefined') return Promise.resolve([]);
  if (pendingPick) pendingPick([]); // an earlier picker whose browser never reported the cancel
  const input = document.createElement('input');
  input.type = 'file'; input.accept = accept; input.multiple = !!multiple;
  if (capture) input.setAttribute('capture', capture);
  input.style.cssText = 'position:fixed;left:-1000px;top:0;width:1px;height:1px;opacity:0';
  input.setAttribute('aria-hidden', 'true'); input.tabIndex = -1;
  document.body.appendChild(input);
  return new Promise((resolve) => {
    let settled = false;
    const done = (files) => {
      if (settled) return; settled = true;
      if (pendingPick === done) pendingPick = null;
      input.remove(); resolve(files);
    };
    pendingPick = done;
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}
export const PICKERS = {
  camera: { accept: 'image/*', capture: 'environment', multiple: false },
  library: { accept: 'image/*', multiple: true },
  files: { accept: 'image/*,.jpg,.jpeg,.png,.heic,.heif,.webp', multiple: true },
};

const SOURCE_ICON = { text: 'edit', saved: 'star', quick: 'zap', manual: 'edit' };
export const SOURCE_TEXT = { snap: 'Camera', library: 'Photo library', files: 'Files', text: 'Described', saved: 'Saved food', quick: 'Quick add', manual: 'Manual' };

/** Meal thumbnail: the stored photo, or an icon for text/saved/quick meals. { meal, lg, onClick } */
export function MealThumb({ meal, size = 56, onClick }) {
  const p = mealPhotos(meal)[0];
  const style = `width:${size}px;height:${size}px`;
  if (p) return html`<${EncryptedImage} path=${p.path} class="thumb" style=${style} alt=${'Photo of ' + (meal.title || 'meal')} onClick=${onClick} />`;
  return html`<div class="thumb photo-ph meal-ico" style=${style} aria-hidden="true"><${Icon} name=${SOURCE_ICON[meal && meal.source] || 'fuel'} /></div>`;
}

export function ConfidencePill({ confidence }) {
  if (!confidence) return null;
  const tone = confidence === 'high' ? 'good' : confidence === 'low' ? 'warn' : null;
  return html`<${Pill} tone=${tone}>${confidence[0].toUpperCase() + confidence.slice(1)} confidence</${Pill}>`;
}

/** One-line status for a meal in lists: { meal, job, withMacros } */
export function MealStatusLine({ meal, job }) {
  const app = useApp();
  const st = mealState(meal, job);
  const retry = (e) => { e.stopPropagation(); enqueueAnalysis(app, meal.id); };
  const needsKey = !app.ai();
  if (st === 'analyzing') return html`<span class="meal-st"><${Spinner} /><span class="ellipsis">${phaseText(job.phase, job.query)}</span></span>`;
  if (st === 'queued') return html`<span class="meal-st"><${Icon} name="clock" size=${14} />Queued for analysis</span>`;
  if (st === 'pending' || st === 'interrupted') return html`<span class="meal-st">
    <span class="ink-warn">${st === 'interrupted' ? 'Analysis interrupted' : 'Waiting for analysis'}</span>
    ${needsKey ? null : html`<button class="linkish" onClick=${retry}>Analyze</button>`}</span>`;
  if (st === 'error') return html`<span class="meal-st"><span class="ink-bad ellipsis" title=${meal.error || ''}>Analysis failed</span><button class="linkish" onClick=${retry}>Retry</button></span>`;
  return html`<span class="meal-st"><span class="mono ellipsis">${macroLine(meal.totals || {})}</span></span>`;
}

/** kcal for lists: number or an em dash while unknown. */
export function kcalText(meal) { return meal && meal.totals && isNum(meal.totals.kcal) ? fmtNum(meal.totals.kcal) : '—'; }

/** Status block inside the meal sheet (running job with cancel, queued, waiting, failed). */
export function JobStatus({ meal, job }) {
  const app = useApp();
  const st = mealState(meal, job);
  const [, tick] = useState(0);
  useEffect(() => { if (st !== 'analyzing') return undefined; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [st]);
  if (st === 'analyzing') {
    const secs = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
    return html`<div class="ai-status" role="status"><${Spinner} /><span class="grow ellipsis">${phaseText(job.phase, job.query)}</span>
      <span class="xs muted mono">${secs}s</span><${Button} size="sm" variant="ghost" onClick=${() => cancelAnalysis(meal.id)}>Cancel</${Button}></div>`;
  }
  if (st === 'queued') return html`<div class="ai-status" role="status"><${Icon} name="clock" size=${16} /><span class="grow">Queued — runs after the meal before it</span>
    <${Button} size="sm" variant="ghost" onClick=${() => cancelAnalysis(meal.id)}>Cancel</${Button}></div>`;
  return null;
}

/** Date + time inputs: { date, hm, max, onChange({date, hm}) } */
export function TimeFields({ date, hm, max, onChange, check }) {
  return html`<div class="fuel-when">
    <label class="field"><span class="label-text">Date</span>
      <input class=${cx('input mono', check && 'check-time')} type="date" value=${date} max=${max || undefined}
        onChange=${(e) => { const v = e.currentTarget.value; if (v) onChange({ date: v, hm }); }} /></label>
    <label class="field"><span class="label-text">Time</span>
      <input class=${cx('input mono', check && 'check-time')} type="time" value=${hm || ''}
        onChange=${(e) => { const v = e.currentTarget.value; if (v) onChange({ date, hm: v }); }} /></label>
  </div>`;
}

/** Time-source hint under a time field. */
export function TimeSourceHint({ timeSource, check }) {
  if (!timeSource) return null;
  return html`<div class=${cx('xs', check ? 'ink-warn' : 'muted')} style="display:flex;gap:6px;align-items:center">
    <${Icon} name=${check ? 'alert' : 'clock'} size=${13} />${check && timeSource === 'manual' ? 'No time found in the photo — set it' : TIME_SOURCE_TEXT[timeSource] || ''}</div>`;
}

/** Slot chips: { value, onValue } */
export function SlotChips({ value, onValue }) {
  return html`<div class="chips slot-chips" role="group" aria-label="Meal">${SLOTS.map((s) => html`<button type="button" class="chip" aria-pressed=${String(value === s.value)} onClick=${() => onValue(s.value)}>${s.label}</button>`)}</div>`;
}

/** Meal list row: thumb, time · slot, title, status/macros, kcal. { meal, job, tz, onOpen } */
export function MealRow({ meal, job, tz, onOpen }) {
  const c = mealClock(meal, tz);
  return html`<div class="meal-row" role="button" tabIndex="0" data-meal=${meal.id} onClick=${onOpen} onKeyDown=${(e) => { if (e.key === 'Enter') onOpen(); }}>
    <${MealThumb} meal=${meal} />
    <div class="meal-main">
      <div class="meal-meta"><span class="mono">${c.hm ? fmtTime(c.hm) : '—'}</span>${meal.slot ? html`<span>· ${slotLabel(meal.slot)}</span>` : null}
        ${meal.timeSource === 'file' ? html`<span class="ink-warn" title="Time taken from the file date — check it">· check time</span>` : null}
        ${meal.followUp && meal.status === 'ready' ? html`<span class="accent-ink" title=${meal.followUp}>· question</span>` : null}
        ${meal.ai && meal.ai.confidence === 'low' && meal.status === 'ready' ? html`<span class="ink-warn">· low confidence</span>` : null}</div>
      <div class="meal-title ellipsis">${mealTitle(meal)}</div>
      <${MealStatusLine} meal=${meal} job=${job} />
    </div>
    <div class="meal-kcal"><b class="mono">${kcalText(meal)}</b><span>kcal</span></div>
  </div>`;
}

/**
 * Local edit state that follows `value` only when it changes from outside (effects run after paint here, so a plain
 * [value] effect would also fire on mount and could overwrite what was typed in the first frame).
 */
export function useSynced(value, blank = '') {
  const [v, setV] = useState(value ?? blank);
  const prev = useRef(value);
  useEffect(() => { if (prev.current !== value) { prev.current = value; setV(value ?? blank); } }, [value]);
  return [v, setV];
}

/** Number input that commits on blur/Enter (no scaling while typing): { value, onCommit(number|null), suffix, step, min, label, disabled } */
export function CommitNumber({ value, onCommit, suffix, step = 'any', min = 0, label, disabled, placeholder, class: cls }) {
  const [v, setV] = useSynced(value);
  const commit = () => {
    const t = String(v).trim(); const n = t === '' ? null : Number(t);
    if (n !== null && !isFinite(n)) { setV(value ?? ''); return; }
    if (n !== (value ?? null) && onCommit(n) === false) setV(value ?? ''); // rejected: show the stored value again
  };
  const input = html`<input class=${cx('input sm mono', cls)} type="number" inputmode="decimal" step=${step} min=${min} value=${v} aria-label=${label} disabled=${disabled} placeholder=${placeholder}
    onInput=${(e) => setV(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />`;
  return suffix ? html`<div class="input-group sm">${input}<span class="suffix">${suffix}</span></div>` : input;
}

/** Text input that commits on blur/Enter: { value, onCommit(string), placeholder, label, disabled } */
export function CommitText({ value, onCommit, placeholder, label, disabled, class: cls }) {
  const [v, setV] = useSynced(value);
  const commit = () => { const t = String(v).trim(); if (t !== (value ?? '')) onCommit(t); };
  return html`<input class=${cx('input sm', cls)} value=${v} placeholder=${placeholder} aria-label=${label} disabled=${disabled}
    onInput=${(e) => setV(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />`;
}

export { slotLabel, isActive };
