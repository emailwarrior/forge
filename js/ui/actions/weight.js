// OWNER: UI-A (Day). Contract (docs/UI_GUIDE.md §6).
// Weigh-in sheet → `body` record { date, at, weightLb, bodyFatPct, waistIn, method }.
import { html, useState, useMemo } from '../../vendor/preact-htm.js';
import { useApp, useVersion } from '../ctx.js';
import { SheetHead, SheetFoot, Field, NumberInput, TimeInput, Select, Button, Empty, Notice } from '../kit.js';
import { removeWithUndo } from '../parts/common.js';
import { changedFields, fmtSigned } from '../parts/day-model.js';
import { bodySummary } from '../../analytics/index.js';
import { isoWithOffset, zonedToMs, localParts, nowIso, isNum, round, fmtNum, fmtTime, relDay } from '../../core/util.js';

const METHODS = [{ value: 'scale', label: 'Scale' }, { value: 'tape', label: 'Tape' }, { value: 'dexa', label: 'DEXA' }, { value: 'inbody', label: 'InBody' }];
const KEYS = ['at', 'weightLb', 'bodyFatPct', 'waistIn', 'method'];

/** openWeighIn(app, { date, id }) → Promise<string|undefined> (body record id) */
export function openWeighIn(app, { date, id } = {}) {
  const rec = id ? app.store.get('body', id) : null;
  const d = (rec && rec.date) || date || app.today();
  return app.sheet(({ close }) => html`<${WeighInSheet} date=${d} id=${id || null} close=${close} />`);
}

function WeighInSheet({ date, id, close }) {
  const app = useApp(); useVersion(['body']);
  const { store, dv } = app; const tz = dv.tz; const today = app.today();
  const rec = id ? store.get('body', id) : null;
  const ctx = useMemo(() => {
    const all = dv.weighIns().filter((w) => w.id !== id);
    const before = all.filter((w) => w.date <= date);
    return { last: before[before.length - 1] || null, sameDay: all.filter((w) => w.date === date) };
  }, [date, id]);
  const initialHm = useMemo(() => (rec && rec.at ? localParts(rec.at, tz).hm : localParts(Date.now(), tz).hm), [id]);
  const [w, setW] = useState(rec ? rec.weightLb : ctx.last ? ctx.last.weightLb : null);
  const [bf, setBf] = useState(rec && isNum(rec.bodyFatPct) ? rec.bodyFatPct : null);
  const [waist, setWaist] = useState(rec && isNum(rec.waistIn) ? rec.waistIn : null);
  const [method, setMethod] = useState((rec && rec.method) || 'scale');
  const [time, setTime] = useState(initialHm);
  const [error, setError] = useState(null);

  if (id && !rec) {
    return html`<div class="stack"><${SheetHead} title="Weigh-in" onClose=${() => close()} /><${Empty} title="Not found">This weigh-in was deleted.</${Empty}></div>`;
  }
  const methods = rec && rec.method === 'health' ? [...METHODS, { value: 'health', label: 'Apple Health' }] : METHODS;

  const save = () => {
    if (!isNum(w) || w < 50 || w > 700) return setError('Enter your weight in lb (50–700).');
    if (bf != null && (!isNum(bf) || bf < 2 || bf > 70)) return setError('Body fat should be between 2 and 70 %.');
    if (waist != null && (!isNum(waist) || waist < 15 || waist > 80)) return setError('Waist should be between 15 and 80 in.');
    const hm = /^\d{2}:\d{2}$/.test(time || '') ? time : initialHm;
    let at;
    if (rec && rec.at && hm === initialHm) at = rec.at;
    else if (!rec && hm === initialHm && date === today) at = nowIso(tz);
    else at = isoWithOffset(zonedToMs(date, hm, tz), tz);
    const fields = { at, weightLb: round(w, 1), bodyFatPct: isNum(bf) ? round(bf, 1) : null, waistIn: isNum(waist) ? round(waist, 1) : null, method };
    let rid = id;
    if (rec) {
      const patch = changedFields(rec, fields, KEYS);
      if (Object.keys(patch).length) store.update('body', id, patch);
    } else {
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
      rid = store.create('body', { date, ...clean }).id;
    }
    const s = bodySummary(dv, date);
    const parts = [rec ? 'Weigh-in updated' : `${fmtNum(fields.weightLb, 1)} lb saved`];
    if (isNum(s.trend)) parts.push(`Trend ${fmtNum(s.trend, 1)} lb`, isNum(s.rate28) ? `${fmtSigned(s.rate28, 2)} lb/wk` : 'rate after 7 weigh-ins');
    app.toast(parts.join(' · '));
    close(rid);
  };
  const del = () => { removeWithUndo(app, 'body', id, 'Weigh-in'); close(); };

  const last = ctx.last;
  const others = ctx.sameDay.filter((x) => !rec || x.id !== rec.id);
  return html`<div class="stack">
    <${SheetHead} title=${rec ? 'Edit weigh-in' : 'Weigh-in'} onClose=${() => close()}>
      ${date !== today ? html`<span class="pill">${relDay(date, today)}</span>` : null}
    </${SheetHead}>
    ${last ? html`<div class="xs muted">Previous ${fmtNum(last.weightLb, 1)} lb · ${relDay(last.date, today)}${last.at ? ' ' + fmtTime(localParts(last.at, tz).hm) : ''}</div>` : null}
    <${Field} label="Weight" error=${error}>
      <${NumberInput} value=${w} onValue=${(v) => { setW(v); setError(null); }} suffix="lb" step="0.1" min="0" class="day-big"
        aria-label="Weight in pounds" onFocus=${(e) => e.currentTarget.select()} />
    </${Field}>
    <div class="grid two">
      <${Field} label="Time"><${TimeInput} value=${time} onValue=${setTime} aria-label="Time" /></${Field}>
      <${Field} label="Method"><${Select} options=${methods} value=${method} onValue=${setMethod} aria-label="Method" /></${Field}>
    </div>
    <div class="grid two">
      <${Field} label="Body fat (optional)"><${NumberInput} value=${bf} onValue=${(v) => { setBf(v); setError(null); }} suffix="%" step="0.1" aria-label="Body fat percent" /></${Field}>
      <${Field} label="Waist (optional)"><${NumberInput} value=${waist} onValue=${(v) => { setWaist(v); setError(null); }} suffix="in" step="0.1" aria-label="Waist in inches" /></${Field}>
    </div>
    ${others.length && !rec ? html`<${Notice}>Already logged ${fmtNum(others[0].weightLb, 1)} lb${others[0].at ? ' at ' + fmtTime(localParts(others[0].at, tz).hm) : ''} on this day. The first weigh-in of the day drives the trend.</${Notice}>` : null}
    <${SheetFoot}>
      ${rec ? html`<${Button} variant="danger" icon="trash" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>Save</${Button}>
    </${SheetFoot}>
  </div>`;
}
