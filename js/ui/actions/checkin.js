// OWNER: UI-A (Day). Contract (docs/UI_GUIDE.md §6).
// Check-in sheet → the `days` record (id = date). Writes only changed fields and stamps checkinAt.
import { html, useState, useMemo } from '../../vendor/preact-htm.js';
import { useApp } from '../ctx.js';
import { SheetHead, SheetFoot, Field, NumberInput, TimeInput, Textarea, Scale5, Stepper, Button } from '../kit.js';
import { Group, Scale10 } from '../parts/day-ui.js';
import { changedFields } from '../parts/day-model.js';
import { nowIso, isNum, round, fmtTime, fmtNum, relDay, localParts } from '../../core/util.js';

export const CHECKIN_SCALES = [
  { key: 'energy', label: 'Energy', low: 'Drained', high: 'Energized' },
  { key: 'mood', label: 'Mood', low: 'Low', high: 'Great' },
  { key: 'stress', label: 'Stress', low: 'Calm', high: 'Very stressed' },
  { key: 'soreness', label: 'Soreness', low: 'None', high: 'Very sore' },
  { key: 'focus', label: 'Focus', low: 'Scattered', high: 'Locked in' },
  { key: 'appetite', label: 'Appetite', low: 'Low', high: 'Strong' },
];
const KEYS = [...CHECKIN_SCALES.map((s) => s.key), 'caffeineMg', 'caffeineLastAt', 'alcohol', 'deepWorkH', 'sunlightMin', 'dayRating', 'wins', 'misses', 'note'];
const LIMITS = { caffeineMg: [0, 2000, 'Caffeine'], alcohol: [0, 40, 'Alcohol'], deepWorkH: [0, 20, 'Deep work'], sunlightMin: [0, 1440, 'Sunlight'] };

/** openCheckin(app, { date }) → Promise<void> — edits the `days` record for the date */
export function openCheckin(app, { date } = {}) {
  const d = date || app.today();
  return app.sheet(({ close }) => html`<${CheckinSheet} date=${d} close=${close} />`, { wide: true });
}

function CheckinSheet({ date, close }) {
  const app = useApp(); const { store, dv } = app; const tz = dv.tz; const today = app.today();
  const orig = useMemo(() => store.get('days', date), [date]);
  const [f, setF] = useState(() => Object.fromEntries(KEYS.map((k) => [k, orig && orig[k] != null ? orig[k] : null])));
  const [error, setError] = useState(null);
  const set = (k) => (v) => { setError(null); setF((s) => ({ ...s, [k]: v })); };
  // Deep work credited by the plan (done = full, partial = half), once any deep block was marked.
  const planDeep = useMemo(() => {
    const deep = dv.planSummary(date).blocks.filter((b) => b.category === 'deep' && b.min != null);
    if (!deep.length || !deep.some((b) => b.status !== 'planned')) return null;
    return round(deep.reduce((s, b) => s + b.doneMin, 0) / 60, 1);
  }, [date]);

  const save = () => {
    for (const [k, [lo, hi, label]] of Object.entries(LIMITS)) {
      const v = f[k]; if (v != null && (!isNum(v) || v < lo || v > hi)) return setError(`${label} should be between ${lo} and ${fmtNum(hi)}.`);
    }
    const patch = changedFields(orig, f, KEYS);
    if (!orig) { patch.date = date; patch._d = null; } // a previously deleted day record is revived
    store.upsert('days', date, { ...patch, checkinAt: nowIso(tz) });
    app.toast(orig && orig.checkinAt ? 'Check-in updated' : 'Check-in saved');
    close();
  };

  const scaleVal = (k) => (isNum(f[k]) ? html`<span class="xs mono dim">${f[k]} / 5</span>` : html`<span class="xs muted">Not set</span>`);
  return html`<div class="stack">
    <${SheetHead} title="Check-in" onClose=${() => close()}>
      <span class="pill">${relDay(date, today)}</span>
    </${SheetHead}>
    ${orig && orig.checkinAt ? html`<div class="xs muted" style="margin-top:-8px">Last saved ${fmtTime(localParts(orig.checkinAt, tz).hm)}${localParts(orig.checkinAt, tz).ymd !== date ? ' · ' + relDay(localParts(orig.checkinAt, tz).ymd, today) : ''}</div>` : null}
    <div class="eyebrow">How the day went</div>
    <div class="day-grid2">
      ${CHECKIN_SCALES.map((s) => html`<${Group} label=${s.label} aside=${scaleVal(s.key)}>
        <${Scale5} value=${f[s.key]} onValue=${set(s.key)} low=${s.low} high=${s.high} /></${Group}>`)}
    </div>
    <${Group} label="Day rating" aside=${isNum(f.dayRating) ? html`<span class="xs mono dim">${f.dayRating} / 10</span>` : html`<span class="xs muted">Not set</span>`}>
      <${Scale10} value=${f.dayRating} onValue=${set('dayRating')} low="Poor" high="Excellent" />
    </${Group}>
    <div class="eyebrow" style="margin-top:6px">Inputs</div>
    <div class="day-grid2">
      <${Field} label="Last caffeine"><${TimeInput} value=${f.caffeineLastAt} onValue=${(v) => set('caffeineLastAt')(v || null)} aria-label="Last caffeine time" /></${Field}>
      <${Field} label="Caffeine total"><${NumberInput} value=${f.caffeineMg} onValue=${set('caffeineMg')} suffix="mg" step="1" min="0" aria-label="Caffeine in mg" /></${Field}>
      <${Group} label="Alcohol (drinks)"><${Stepper} value=${f.alcohol} onValue=${set('alcohol')} step=${1} min=${0} max=${40} /></${Group}>
      <${Group} label="Deep work (h)" hint=${planDeep != null ? html`<span>Plan credits ${fmtNum(planDeep, 1)} h${f.deepWorkH !== planDeep ? html` · <button type="button" class="day-linkbtn" onClick=${() => set('deepWorkH')(planDeep)}>Use</button>` : null}</span>` : null}>
        <${Stepper} value=${f.deepWorkH} onValue=${set('deepWorkH')} step=${0.5} min=${0} max=${20} dp=${1} />
      </${Group}>
      <${Field} label="Sunlight"><${NumberInput} value=${f.sunlightMin} onValue=${set('sunlightMin')} suffix="min" step="5" min="0" aria-label="Sunlight in minutes" /></${Field}>
    </div>
    <div class="eyebrow" style="margin-top:6px">Notes</div>
    <${Field} label="Wins"><${Textarea} rows="2" value=${f.wins} onValue=${set('wins')} placeholder="What went well" /></${Field}>
    <${Field} label="Misses"><${Textarea} rows="2" value=${f.misses} onValue=${set('misses')} placeholder="What slipped and why" /></${Field}>
    <${Field} label="Note"><${Textarea} rows="2" value=${f.note} onValue=${set('note')} placeholder="Anything else worth keeping" /></${Field}>
    ${error ? html`<div class="xs ink-bad" role="alert">${error}</div>` : null}
    <${SheetFoot}>
      <${Button} onClick=${() => close()}>Cancel</${Button}>
      <${Button} variant="primary" onClick=${save}>Save check-in</${Button}>
    </${SheetFoot}>
  </div>`;
}
