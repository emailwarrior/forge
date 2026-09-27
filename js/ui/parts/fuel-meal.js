// Fuel: meal detail sheet — photos, time/slot, title, items (grams scale nutrients; numbers editable), totals,
// follow-up answer → re-analysis, note → re-analysis, add items, assumptions/sources, save as food, delete.
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { useApp, useVersion } from '../ctx.js';
import { Icon, Button, IconButton, Field, Input, Textarea, Notice, Empty, Stat, KV, Disclosure, SheetFoot } from '../kit.js';
import { useAiTask, AiStatus, AiError, AiKeyNotice, CostNote } from './ai.js';
import { EncryptedImage, viewImage } from './media.js';
import { removeWithUndo } from './common.js';
import { analyzeMealText, scaleFoodItem } from '../../ai/meal.js';
import { NUTRIENT_UNITS } from '../../core/schema.js';
import { fmtNum, fmtDate, fmtTime, isNum, isYmd } from '../../core/util.js';
import {
  mealTitle, mealState, mealPhotos, mealClock, analyzable, hasEstimate, itemsTotals, quickItem, macroLine, atFor, slotLabel,
} from './fuel-logic.js';
import { enqueueAnalysis, cancelAnalysis, mealContext, dismissJob } from './fuel-queue.js';
import { useQueue, useSynced, JobStatus, ConfidencePill, TimeFields, TimeSourceHint, SlotChips, CommitNumber, CommitText, SOURCE_TEXT } from './fuel-ui.js';

export function openMeal(app, id) {
  return app.sheet(({ close }) => html`<${MealSheet} id=${id} close=${close} />`, { wide: true }).then(() => undefined);
}

const MICROS = [['sugar', 'Sugar'], ['satFat', 'Saturated fat'], ['sodium', 'Sodium'], ['potassium', 'Potassium'], ['calcium', 'Calcium'], ['iron', 'Iron'], ['magnesium', 'Magnesium'], ['vitC', 'Vitamin C'], ['vitD', 'Vitamin D']];
const BASIS_TEXT = { label: 'label', web: 'web', saved: 'saved food', estimate: 'est.' };
const nv = (t, k) => {
  if (!t || !isNum(t[k])) return '—';
  const v = t[k]; const fine = (k === 'iron' || NUTRIENT_UNITS[k] === 'g') && v > 0 && v < 10 && Math.round(v * 10) % 10;
  return fmtNum(v, fine ? 1 : 0);
};

function MealSheet({ id, close }) {
  const app = useApp(); useVersion(['meals', 'foods']); const jobOf = useQueue();
  const meal = app.store.get('meals', id);
  if (!meal) {
    return html`<div class="stack"><div class="sheet-head"><h2>Meal</h2><${IconButton} icon="x" label="Close" onClick=${() => close()} /></div>
      <${Empty} title="This meal no longer exists">It was deleted, possibly on another device.</${Empty}></div>`;
  }
  const tz = app.dv.tz; const today = app.today();
  const job = jobOf(id); const st = mealState(meal, job);
  const busy = st === 'analyzing' || st === 'queued';
  const photos = mealPhotos(meal); const kind = analyzable(meal);
  const clock = mealClock(meal, tz);
  const ai = app.ai();
  const update = (patch) => app.store.update('meals', id, patch);
  const reanalyze = () => { dismissJob(id); enqueueAnalysis(app, id); };
  const items = Array.isArray(meal.items) ? meal.items : [];
  const setItems = (next, extra = {}) => update({ items: next, totals: itemsTotals(next), ...(!hasEstimate(meal) && next.length ? { status: 'ready', error: null } : {}), ...extra });

  const removeItem = (i) => {
    const prev = { items: meal.items, totals: meal.totals };
    setItems(items.filter((_, j) => j !== i));
    app.toast(`Removed ${items[i].name}`, { action: { label: 'Undo', onClick: () => update(prev) } });
  };
  const saveFood = () => {
    if (!items.length) { app.toast('Nothing to save yet — the meal has no items.'); return; }
    const name = mealTitle(meal);
    const existing = app.store.all('foods').find((f) => String(f.name || '').toLowerCase() === name.toLowerCase());
    const totals = itemsTotals(items);
    if (existing) { app.store.update('foods', existing.id, { items, totals }); app.toast(`Updated saved food “${name}”`); }
    else { app.store.create('foods', { name, items, totals, uses: 0, favorite: false, lastUsedAt: null }); app.toast(`Saved “${name}” to foods`); }
  };
  const del = () => { cancelAnalysis(id); removeWithUndo(app, 'meals', id, 'Meal'); close(); };
  const aiInfo = meal.ai || null;

  return html`<div class="stack meal-sheet">
    <div class="sheet-head" style="margin-bottom:0">
      <${CommitText} value=${meal.title || ''} onCommit=${(title) => update({ title })} placeholder=${mealTitle({ ...meal, title: '' })} label="Meal title" class="meal-title-input" />
      <${IconButton} icon="x" label="Close" onClick=${() => close()} />
    </div>
    <div class="row wrap meal-meta-line">
      <span class="small dim">${isYmd(clock.date) ? fmtDate(clock.date) : '—'} · ${clock.hm ? fmtTime(clock.hm) : 'no time'}${meal.slot ? ' · ' + slotLabel(meal.slot) : ''}</span>
      ${meal.source ? html`<span class="tag">${SOURCE_TEXT[meal.source] || meal.source}</span>` : null}
      ${aiInfo && st === 'ready' ? html`<${ConfidencePill} confidence=${aiInfo.confidence} />` : null}
      ${meal.timeSource === 'file' ? html`<span class="pill warn">Check time</span>` : null}
    </div>
    <${JobStatus} meal=${meal} job=${job} />
    ${st === 'error' ? html`<${Notice} tone="bad"><div class="stack sm"><span>${meal.error || 'Analysis failed.'}</span>
      <div class="row" style="gap:8px">${ai ? html`<${Button} size="sm" onClick=${reanalyze}>Retry</${Button}>` : html`<${Button} size="sm" onClick=${() => app.nav('/settings/ai')}>Settings → AI</${Button}>`}
      <span class="xs muted">Or add items by hand below.</span></div></div></${Notice}>` : null}
    ${st === 'pending' || st === 'interrupted' ? (ai
      ? html`<${Notice} tone="warn"><div class="row between wrap" style="gap:8px"><span>${st === 'interrupted' ? 'The analysis was interrupted (the app closed).' : 'Waiting for analysis.'}</span><${Button} size="sm" onClick=${reanalyze}>Analyze now</${Button}></div></${Notice}>`
      : html`<${AiKeyNotice} what="the estimate for this meal (it waits with its photo)" />`) : null}
    ${job && job.status === 'error' && st === 'ready' ? html`<${AiError} error=${job.error} onRetry=${reanalyze} />` : null}

    <div class="meal-cols">
      <div class="mc-left">
        ${photos.length ? html`<div class="mc-photo stack sm">
          <${EncryptedImage} path=${photos[0].path} class="thumb lg meal-hero" alt="Meal photo" onClick=${() => viewImage(app, { path: photos[0].path, title: mealTitle(meal) })} />
          ${photos.length > 1 ? html`<div class="row wrap" style="gap:8px">${photos.slice(1).map((p, i) => html`<${EncryptedImage} key=${p.path} path=${p.path} class="thumb" alt=${'Photo ' + (i + 2)} onClick=${() => viewImage(app, { path: p.path, title: 'Photo ' + (i + 2) })} />`)}</div>` : null}
        </div>` : null}
        <div class="mc-when stack sm">
          <div class="eyebrow">When</div>
          <${TimeFields} date=${clock.date || meal.date} hm=${clock.hm} max=${today} check=${meal.timeSource === 'file'}
            onChange=${({ date, hm }) => update({ date, at: atFor(date, hm || '12:00', tz), timeSource: 'manual' })} />
          <div class="row between wrap" style="gap:6px"><${TimeSourceHint} timeSource=${meal.timeSource} check=${meal.timeSource === 'file'} />
            ${meal.timeSource === 'file' ? html`<${Button} size="sm" variant="ghost" icon="check" onClick=${() => update({ timeSource: 'manual' })}>Time is right</${Button}>` : null}</div>
          <${SlotChips} value=${meal.slot} onValue=${(slot) => update({ slot })} />
        </div>
        <${NoteBlock} meal=${meal} kind=${kind} busy=${busy} ai=${ai} onSave=${(note) => update({ note })} onReanalyze=${reanalyze} />
      </div>
      <div class="mc-right">
        <div class="mc-main stack">
          ${meal.followUp && !busy && hasEstimate(meal) ? html`<${FollowUp} meal=${meal} disabled=${!ai}
            onAnswer=${(a) => { update({ answers: [...(meal.answers || []), { q: meal.followUp, a }], followUp: null }); reanalyze(); }}
            onSkip=${() => update({ followUp: null })} />` : null}
          ${hasEstimate(meal) ? html`<${TotalsBlock} meal=${meal} />` : null}
          <${ItemsBlock} meal=${meal} items=${items} busy=${busy} onItems=${setItems} onRemove=${removeItem} />
          ${aiInfo && (aiInfo.assumptions || []).length ? html`<div class="stack xs"><div class="eyebrow">Assumptions</div>
            <ul class="plain-list small dim">${aiInfo.assumptions.map((a) => html`<li>${a}</li>`)}</ul></div>` : null}
          ${aiInfo && (aiInfo.sources || []).length ? html`<div class="stack xs"><div class="eyebrow">Sources</div>
            <ul class="plain-list small">${aiInfo.sources.filter((s) => s && /^https?:\/\//i.test(String(s.url || ''))).map((s) => html`<li><a class="src-link" href=${s.url} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${13} /> ${s.title || s.url}</a></li>`)}</ul></div>` : null}
          ${(meal.answers || []).length ? html`<div class="stack xs"><div class="eyebrow">Your answers</div>
            <ul class="plain-list small dim">${meal.answers.map((x) => html`<li><span class="muted">${x.q}</span> ${x.a}</li>`)}</ul></div>` : null}
        </div>
      </div>
    </div>

    <${SheetFoot}>
      <${Button} icon="save" disabled=${!items.length} onClick=${saveFood}>Save as food</${Button}>
      <${Button} variant="danger" icon="trash" onClick=${del}>Delete</${Button}>
    </${SheetFoot}>
    ${aiInfo ? html`<div class="row between wrap xs muted" style="gap:8px;margin-top:-6px">
      <span>AI estimate${aiInfo.searched ? ' · web search used' : ''}${aiInfo.fallback ? ' · fallback pass' : ''}${aiInfo.at ? ' · ' + (String(aiInfo.at).slice(0, 10) !== today ? fmtDate(String(aiInfo.at).slice(0, 10), { dow: false }) + ', ' : '') + fmtTime(String(aiInfo.at).slice(11, 16)) : ''}</span>
      <${CostNote} usd=${aiInfo.costUsd} model=${aiInfo.model} estimated=${aiInfo.costEstimated} /></div>` : null}
  </div>`;
}

/* ------------------------------------------------------------ follow-up */
function FollowUp({ meal, onAnswer, onSkip, disabled }) {
  const [a, setA] = useState('');
  const send = () => { const t = a.trim(); if (t) { onAnswer(t); setA(''); } };
  return html`<div class="followup stack sm">
    <div class="row top" style="gap:8px"><${Icon} name="message" size=${17} /><div class="grow strong small">${meal.followUp}</div></div>
    <div class="row" style="gap:6px">
      <input class="input sm grow" value=${a} placeholder="Short answer" aria-label="Answer" disabled=${disabled}
        onInput=${(e) => setA(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') send(); }} />
      <${Button} size="sm" variant="primary" disabled=${!a.trim() || disabled} onClick=${send}>Answer</${Button}>
      <${Button} size="sm" variant="ghost" onClick=${onSkip}>Skip</${Button}>
    </div>
    <div class="xs muted">${disabled ? 'Needs an API key to re-run the estimate.' : 'Re-runs the estimate with your answer.'}</div>
  </div>`;
}

/* --------------------------------------------------------------- totals */
function TotalsBlock({ meal }) {
  const t = meal.totals || {};
  const grams = (meal.items || []).reduce((s, i) => s + (isNum(i.grams) ? i.grams : 0), 0);
  return html`<div class="card tight stack sm">
    <div class="row between"><div><span class="meal-kcal-big tnum">${nv(t, 'kcal')}</span><span class="muted small"> kcal</span></div>
      <span class="xs muted">${[grams > 0 ? `${fmtNum(grams)} g of food` : null, meal.source === 'quick' ? 'entered by you' : meal.source === 'saved' ? 'from saved foods' : null].filter(Boolean).join(' · ')}</span></div>
    <div class="grid four macro-stats">
      <${Stat} label="Protein" value=${nv(t, 'protein')} unit="g" /><${Stat} label="Carbs" value=${nv(t, 'carbs')} unit="g" />
      <${Stat} label="Fat" value=${nv(t, 'fat')} unit="g" /><${Stat} label="Fiber" value=${nv(t, 'fiber')} unit="g" />
    </div>
    ${MICROS.some(([k]) => isNum(t[k])) ? html`<${Disclosure} summary=${html`<span class="disc-sum"><${Icon} name="chevronDown" size=${15} />Micronutrients, sugar, saturated fat</span>`}>
      <${KV} items=${MICROS.map(([k, l]) => [l, isNum(t[k]) ? `${nv(t, k)} ${NUTRIENT_UNITS[k]}` : '—'])} /></${Disclosure}>` : null}
  </div>`;
}

/* ---------------------------------------------------------------- items */
function ItemsBlock({ meal, items, busy, onItems, onRemove }) {
  const app = useApp();
  const scale = (i, g) => onItems(items.map((it, j) => (j === i ? scaleFoodItem(it, g) : it)));
  const patch = (i, p) => onItems(items.map((it, j) => (j === i ? { ...it, ...p } : it)));
  return html`<div class="stack sm">
    <div class="eyebrow">Items${items.length ? ` · ${items.length}` : ''}</div>
    ${items.length ? html`<div class="card flush"><div class="items">${items.map((it, i) => html`<${ItemRow} key=${i + ':' + it.name} item=${it} index=${i} disabled=${busy}
      onScale=${scale} onPatch=${patch} onRemove=${onRemove} />`)}</div></div>
      <div class="xs muted">Grams rescale an item. Tap a name to correct its numbers.</div>`
      : busy ? null : html`<div class="small muted">No items yet${analyzable(meal) ? ' — the estimate appears here after analysis' : ''}.</div>`}
    ${busy ? null : html`<${AddItem} meal=${meal} app=${app} onAdd=${(list) => onItems([...items, ...list])} />`}
  </div>`;
}

function ItemRow({ item, index, disabled, onScale, onPatch, onRemove }) {
  const [open, setOpen] = useState(false);
  const detail = [item.portion, BASIS_TEXT[item.basis], item.confidence === 'low' ? 'low confidence' : null].filter(Boolean).join(' · ');
  const num = (k, label, unit) => html`<label class="field"><span class="label-text">${label}</span>
    <${CommitNumber} value=${isNum(item[k]) ? item[k] : null} suffix=${unit} label=${label + ' of ' + item.name} disabled=${disabled} onCommit=${(v) => onPatch(index, { [k]: v == null ? 0 : v })} /></label>`;
  return html`<div class="fi">
    <div class="fi-row">
      <button type="button" class="fi-name" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>
        <span class="t">${item.name}</span>${detail ? html`<span class="s">${detail}</span>` : null}</button>
      ${isNum(item.grams) && item.grams > 0 ? html`<div class="fi-g"><${CommitNumber} value=${item.grams} step="1" label=${'Grams of ' + item.name} disabled=${disabled}
        onCommit=${(g) => { if (!(isNum(g) && g > 0)) return false; onScale(index, g); return true; }} /><span class="xs muted">g</span></div>` : null}
      <${IconButton} icon="x" sm label=${'Remove ' + item.name} disabled=${disabled} onClick=${() => onRemove(index)} />
    </div>
    <div class="fi-mac mono">${isNum(item.kcal) ? fmtNum(item.kcal) : '—'} kcal · ${macroLine(item)}</div>
    ${open ? html`<div class="fi-edit stack sm">
      <div class="grid two"><${Field} label="Name"><${CommitText} value=${item.name} label="Item name" disabled=${disabled} onCommit=${(v) => v && onPatch(index, { name: v })} /></${Field}>
        <${Field} label="Portion"><${CommitText} value=${item.portion || ''} label="Portion" disabled=${disabled} onCommit=${(v) => onPatch(index, { portion: v })} /></${Field}></div>
      <div class="grid three fi-nums">${num('kcal', 'kcal', '')}${num('protein', 'Protein', 'g')}${num('carbs', 'Carbs', 'g')}${num('fat', 'Fat', 'g')}${num('fiber', 'Fiber', 'g')}${num('sodium', 'Sodium', 'mg')}</div>
      <div class="xs muted">Exact numbers do not rescale anything else. Use grams to rescale the whole item.</div>
    </div>` : null}
  </div>`;
}

function AddItem({ meal, app, onAdd }) {
  const task = useAiTask();
  const [text, setText] = useState('');
  const [manual, setManual] = useState(false);
  const [m, setM] = useState({ name: '', grams: null, kcal: null, protein: null, carbs: null, fat: null });
  const ai = app.ai();
  const run = async () => {
    const t = text.trim(); if (!t) return;
    const res = await task.run(({ ai: cfg, signal, onProgress }) => analyzeMealText(cfg, { text: t, at: meal.at, date: meal.date, ...mealContext(app, meal.date), signal, onProgress }));
    if (!res) return;
    if (!res.items.length) { app.toast('No food found in that description.'); return; }
    onAdd(res.items); setText('');
    app.toast(`Added ${res.items.map((i) => i.name).join(', ')} · ${fmtNum(res.totals.kcal)} kcal`);
  };
  const addManual = () => {
    const it = quickItem(m); if (!it) return;
    if (isNum(m.grams) && m.grams > 0) { it.grams = Math.round(m.grams); it.portion = `${Math.round(m.grams)} g`; }
    if (!m.name.trim()) it.name = 'Item';
    onAdd([it]); setM({ name: '', grams: null, kcal: null, protein: null, carbs: null, fat: null }); setManual(false);
  };
  const setK = (k) => (e) => setM((x) => ({ ...x, [k]: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) }));
  return html`<div class="stack sm add-item">
    ${ai ? html`<div class="row" style="gap:6px">
      <input class="input sm grow" value=${text} placeholder="Add an item: 1 tbsp olive oil" aria-label="Describe an item to add" disabled=${task.busy}
        onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') run(); }} />
      <${Button} size="sm" disabled=${!text.trim() || task.busy} onClick=${run}>Add</${Button}>
    </div>` : null}
    <${AiStatus} task=${task} />
    <${AiError} error=${task.error} onRetry=${run} />
    ${manual ? html`<div class="card inset stack sm">
      <div class="grid two"><${Field} label="Name"><${Input} sm value=${m.name} onValue=${(v) => setM((x) => ({ ...x, name: v }))} placeholder="Olive oil" /></${Field}>
        <${Field} label="Grams (optional)"><input class="input sm mono" type="number" inputmode="decimal" min="0" value=${m.grams ?? ''} onInput=${setK('grams')} /></${Field}></div>
      <div class="grid four">${[['kcal', 'kcal'], ['protein', 'Protein g'], ['carbs', 'Carbs g'], ['fat', 'Fat g']].map(([k, l]) => html`<${Field} label=${l}>
        <input class="input sm mono" type="number" inputmode="decimal" min="0" step="any" value=${m[k] ?? ''} onInput=${setK(k)} aria-label=${l} /></${Field}>`)}</div>
      <div class="row end" style="gap:6px"><${Button} size="sm" variant="ghost" onClick=${() => setManual(false)}>Cancel</${Button}>
        <${Button} size="sm" variant="primary" disabled=${!quickItem(m)} onClick=${addManual}>Add item</${Button}></div>
    </div>` : html`<div><${Button} size="sm" variant="ghost" icon="plus" onClick=${() => setManual(true)}>Enter numbers</${Button}></div>`}
  </div>`;
}

/* ----------------------------------------------------------------- note */
function NoteBlock({ meal, kind, busy, ai, onSave, onReanalyze }) {
  const [v, setV] = useSynced(meal.note || '');
  const timer = useRef(null);
  const latest = useRef(null);
  latest.current = { v, note: meal.note || '', onSave };
  // Closing the sheet (Escape) inside the debounce window must not drop the edit.
  useEffect(() => () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    const { v: val, note, onSave: save } = latest.current;
    if ((val || '').trim() !== note.trim()) save((val || '').trim());
  }, []);
  const flush = (val = v) => { clearTimeout(timer.current); timer.current = null; if ((val || '').trim() !== (meal.note || '').trim()) onSave(val.trim()); };
  const onInput = (val) => { setV(val); clearTimeout(timer.current); timer.current = setTimeout(() => flush(val), 700); };
  const isText = kind === 'text';
  return html`<div class="mc-note stack sm">
    <${Field} label=${isText ? 'Description' : 'Note for the estimate'} hint=${isText ? 'Re-estimate after editing the description.' : 'What the photo can’t show: oil, sauce, portion, brand. Ground truth for the AI.'}>
      <${Textarea} rows="2" value=${v} onValue=${onInput} onBlur=${() => flush()} placeholder=${isText ? '2 eggs, 2 slices sourdough, 1 tbsp butter' : '1 tbsp olive oil; ate half the rice'} /></${Field}>
    ${kind && ai ? html`<div><${Button} size="sm" icon="repeat" disabled=${busy} onClick=${() => { flush(); onReanalyze(); }}>${isText ? 'Re-estimate' : hasEstimate(meal) ? 'Re-analyze with note' : 'Analyze'}</${Button}></div>` : null}
  </div>`;
}
