// Fuel: meal capture sheet — chooser, photo review (time, slot, note, grouping), describe, saved foods / quick add,
// and the per-meal analysis progress. Opened by openMealCapture() in js/ui/actions/meal.js.
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { useApp, useVersion } from '../ctx.js';
import { Icon, Button, IconButton, Field, Input, Textarea, Segmented, Notice, SheetHead, SheetFoot, Spinner, Empty, Stepper, Toggle, FileButton, cx } from '../kit.js';
import { AiKeyNotice } from './ai.js';
import { preparePhoto } from '../../ai/image.js';
import { uid, isNum, fmtNum, localParts, nowIso, fmtDate } from '../../core/util.js';
import {
  resolveCaptureTime, atFor, autoGroup, mergeIntoPrevious, splitOut, removePhotoFrom, slotForHm, itemsTotals, scaleItem,
  quickItem, kcalFromMacros, macroLine, sortFoods, searchFoods,
} from './fuel-logic.js';
import { enqueueAnalysis, rememberImages, isActive } from './fuel-queue.js';
import { useQueue, pickFiles, PICKERS, MealRow, TimeFields, TimeSourceHint, SlotChips } from './fuel-ui.js';
import { openMeal } from './fuel-meal.js';
import { removeWithUndo } from './common.js';

const SOURCE_OF = { camera: 'snap', library: 'library', files: 'files' };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** { date, mode, files, created (array collecting new meal ids), close } */
export function CaptureSheet({ date, mode, files, created, close }) {
  const [view, setView] = useState(files && files.length ? { step: 'photos', mode, files }
    : mode === 'text' ? { step: 'text' } : mode === 'saved' ? { step: 'saved' } : { step: 'choose' });
  const [ids, setIds] = useState([]);
  const record = (list) => { for (const id of list) if (!created.includes(id)) created.push(id); };
  const onCreated = (list) => { record(list); setIds(list); setView({ step: 'done' }); };
  const onLogged = (list) => { created.push(...list); close(list); };
  const back = mode ? null : () => setView({ step: 'choose' });
  if (view.step === 'photos') return html`<${PhotoReview} date=${date} mode=${view.mode} files=${view.files} record=${record} onCreated=${onCreated} close=${close} back=${back} />`;
  if (view.step === 'text') return html`<${TextCapture} date=${date} onCreated=${onCreated} close=${close} back=${back} />`;
  if (view.step === 'saved') return html`<${SavedCapture} date=${date} onLogged=${onLogged} close=${close} back=${back} />`;
  if (view.step === 'done') return html`<${Progress} ids=${ids} close=${close} />`;
  return html`<${Chooser} close=${close} setView=${setView} />`;
}

/* ---------------------------------------------------------------- chooser */
function Chooser({ close, setView }) {
  const pick = (m) => pickFiles(PICKERS[m]).then((fs) => { if (fs.length) setView({ step: 'photos', mode: m, files: fs }); });
  const opts = [
    { icon: 'camera', t: 'Snap a photo', s: 'Camera — the time is now', run: () => pick('camera') },
    { icon: 'image', t: 'Photos', s: 'Pick one or many from the library; times from the photos', run: () => pick('library') },
    { icon: 'folder', t: 'Files', s: 'iCloud Drive / Files, e.g. FORGE/Meals from a Shortcut; times from file names', run: () => pick('files') },
    { icon: 'edit', t: 'Describe', s: 'Type what you ate — amounts and brands help', run: () => setView({ step: 'text' }) },
    { icon: 'star', t: 'Saved foods or quick add', s: 'One tap for repeat meals, or enter the numbers', run: () => setView({ step: 'saved' }) },
  ];
  return html`<div class="stack">
    <${SheetHead} title="Log a meal" onClose=${() => close()} />
    <div class="cap-list">${opts.map((o) => html`<button type="button" class="cap-opt" onClick=${o.run}>
      <span class="lead"><${Icon} name=${o.icon} /></span><span class="grow"><span class="t">${o.t}</span><span class="s">${o.s}</span></span>
      <${Icon} name="chevronRight" size=${16} class="muted" /></button>`)}</div>
  </div>`;
}

/* ----------------------------------------------------------- photo review */
function PhotoReview({ date, mode, files, record, onCreated, close, back }) {
  const app = useApp(); const tz = app.dv.tz; const today = app.today();
  const [photos, setPhotos] = useState([]); // [{ key, name, status: loading|ready|error, error, prep, url, time }]
  const [groups, setGroups] = useState([]);
  const [busy, setBusy] = useState(0);
  const [saving, setSaving] = useState(false);
  const urls = useRef([]); const alive = useRef(true);
  useEffect(() => () => { alive.current = false; urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const addFiles = async (list, m = mode) => {
    const fresh = list.map((f) => ({ key: uid(8), name: f.name || 'Photo', file: f, status: 'loading', mode: m }));
    setPhotos((p) => [...p, ...fresh]); setBusy((b) => b + fresh.length);
    const ready = [];
    for (const ph of fresh) { // one at a time: decoding several 12 MP photos at once can exhaust memory on a phone
      let next;
      try {
        const prep = await preparePhoto(ph.file);
        const url = URL.createObjectURL(new Blob([prep.bytes], { type: 'image/jpeg' })); urls.current.push(url);
        const time = resolveCaptureTime({ mode: m, takenAt: prep.takenAt, takenAtSource: prep.takenAtSource, lastModified: ph.file.lastModified, now: Date.now(), tz, fallbackDate: date });
        next = { key: ph.key, name: ph.name, status: 'ready', prep, url, time, mode: m };
        ready.push(next);
      } catch (e) {
        console.warn('[fuel] photo', ph.name, e);
        next = { key: ph.key, name: ph.name, status: 'error', error: e, mode: m };
      }
      if (!alive.current) return;
      setPhotos((p) => p.map((x) => (x.key === ph.key ? next : x))); setBusy((b) => b - 1);
    }
    const idx = autoGroup(ready.map((p) => ({ date: p.time.date, hm: p.time.hm, reliable: !['file', 'manual'].includes(p.time.timeSource) })));
    const made = idx.map((ixs) => {
      const first = ready[ixs[0]].time;
      return { key: uid(8), photos: ixs.map((i) => ready[i].key), date: first.date, hm: first.hm, timeSource: first.timeSource, check: ixs.some((i) => ready[i].time.check), slot: slotForHm(first.hm), slotAuto: true, note: '' };
    });
    if (alive.current) setGroups((g) => [...g, ...made]);
  };
  useEffect(() => { addFiles(files); }, []);

  const byKey = new Map(photos.map((p) => [p.key, p]));
  const failed = photos.filter((p) => p.status === 'error');
  const loading = photos.filter((p) => p.status === 'loading');
  const setGroup = (key, patch) => setGroups((gs) => gs.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const ai = app.ai();
  const mealsN = groups.length;

  const save = async () => {
    setSaving(true);
    const ids = [];
    try {
      for (const g of groups) {
        const shots = g.photos.map((k) => byKey.get(k)).filter((p) => p && p.status === 'ready');
        if (!shots.length) continue;
        const id = uid();
        const stored = [];
        for (let i = 0; i < shots.length; i++) {
          const r = await app.session.putMedia('meals', g.date, `${id}-${i}`, shots[i].prep.bytes, 'image/jpeg');
          stored.push({ path: r.path, w: shots[i].prep.width, h: shots[i].prep.height });
        }
        app.store.create('meals', {
          id, date: g.date, at: atFor(g.date, g.hm, tz), timeSource: g.timeSource, slot: g.slot, source: SOURCE_OF[shots[0].mode] || 'library',
          note: (g.note || '').trim(), photo: stored[0], photos: stored, status: ai ? 'analyzing' : 'pending', answers: [], followUp: null,
        });
        if (ai) rememberImages(id, shots.map((s) => ({ data: s.prep.data, mediaType: 'image/jpeg' })));
        ids.push(id);
      }
    } catch (e) {
      console.warn('[fuel] save', e);
      app.toast('Could not save the photos: ' + (e.message || e), { tone: 'error' });
    }
    record(ids); // before the unmount check: closing the sheet mid-save still reports the meals
    if (ai) for (const id of ids) enqueueAnalysis(app, id);
    if (!alive.current) return;
    setSaving(false);
    if (ids.length) onCreated(ids);
  };

  const title = photos.length === 1 ? 'Review photo' : `Review ${photos.length} photos`;
  return html`<div class="stack capture">
    <${SheetHead} title=${title} onClose=${() => close()}>${back ? html`<${Button} size="sm" variant="ghost" onClick=${back}>Back</${Button}>` : null}</${SheetHead}>
    ${busy > 0 ? html`<div class="ai-status" role="status"><${Spinner} /><span class="grow">Preparing ${photos.length === 1 ? 'photo' : `photo ${Math.min(photos.length - loading.length + 1, photos.length)} of ${photos.length}`}…</span></div>` : null}
    ${failed.length ? html`<${Notice} tone="bad"><div class="stack xs"><b>${failed.length === 1 ? 'One file could not be read' : `${failed.length} files could not be read`}</b>
      ${failed.map((p) => html`<div class="small"><span class="mono">${p.name}</span> — ${(p.error && p.error.message) || 'unreadable file'}</div>`)}
      <div class="xs muted">HEIC photos need Safari on iPhone; elsewhere export them as JPEG.</div></div></${Notice}>` : null}
    ${!ai && groups.length ? html`<${Notice} icon="info">No Anthropic API key on this device: the meals are saved with their photos and analyzed once you add one in Settings → AI.</${Notice}>` : null}
    ${groups.length > 1 ? html`<div class="xs muted">${plural(groups.length, 'meal')} from ${plural(photos.length - failed.length, 'photo')}. Photos taken within 10 minutes form one meal (plate + label); merge or split below.</div>` : null}
    <div class="meal-groups">
      ${groups.map((g, gi) => html`<div class="card inset meal-group" key=${g.key}>
        <div class="row between" style="gap:6px">
          <div class="strong small">Meal ${gi + 1}${g.photos.length > 1 ? html`<span class="muted" style="font-weight:500"> · ${g.photos.length} photos</span>` : null}</div>
          <span class="row" style="gap:2px">
            ${gi > 0 ? html`<${Button} size="sm" variant="ghost" onClick=${() => setGroups((gs) => mergeIntoPrevious(gs, gi))} title="Same meal as the one above (e.g. plate + label)">Merge with meal ${gi}</${Button}>` : null}
            ${groups.length > 1 ? html`<${IconButton} icon="trash" sm label=${'Remove meal ' + (gi + 1)} onClick=${() => setGroups((gs) => gs.filter((x) => x.key !== g.key))} />` : null}
          </span>
        </div>
        <div class="shots">${g.photos.map((k, pi) => { const p = byKey.get(k); if (!p) return null; return html`<div class="shot" key=${k}>
          <img src=${p.url} alt=${p.name} />
          <button type="button" class="shot-x" aria-label=${'Remove ' + p.name} onClick=${() => setGroups((gs) => removePhotoFrom(gs, k))}><${Icon} name="x" size=${14} /></button>
          ${pi > 0 ? html`<button type="button" class="shot-split" onClick=${() => setGroups((gs) => splitOut(gs, gi, k, p.time, uid(8)))}>Split</button>` : null}
        </div>`; })}</div>
        <${TimeFields} date=${g.date} hm=${g.hm} max=${today} check=${g.check}
          onChange=${({ date: d, hm }) => setGroup(g.key, { date: d, hm, timeSource: 'manual', check: false, ...(g.slotAuto ? { slot: slotForHm(hm) } : {}) })} />
        <${TimeSourceHint} timeSource=${g.timeSource} check=${g.check} />
        <${SlotChips} value=${g.slot} onValue=${(slot) => setGroup(g.key, { slot, slotAuto: false })} />
        <${Input} value=${g.note} onValue=${(note) => setGroup(g.key, { note })} placeholder="Note: oil, sauce, portion, brand" aria-label=${'Note for meal ' + (gi + 1)} />
      </div>`)}
    </div>
    ${!busy && !groups.length ? html`<${Empty} title="No usable photos">Add photos again, or describe the meal instead.</${Empty}>` : null}
    <div class="row wrap" style="gap:8px">
      <${FileButton} accept=${PICKERS.library.accept} multiple onFiles=${(fs) => addFiles(fs, 'library')} variant="ghost" icon="plus" size="sm">Add photos</${FileButton}>
    </div>
    <${SheetFoot}>
      <${Button} onClick=${() => close()}>Cancel</${Button}>
      <${Button} variant="primary" loading=${saving} disabled=${!mealsN || busy > 0} onClick=${save}>
        ${ai ? (mealsN > 1 ? `Save & analyze ${mealsN} meals` : 'Save & analyze') : mealsN > 1 ? `Save ${mealsN} meals` : 'Save meal'}</${Button}>
    </${SheetFoot}>
  </div>`;
}

/* ---------------------------------------------------------------- shared */
function useWhen(date) {
  const app = useApp(); const tz = app.dv.tz; const today = app.today();
  const nowHm = localParts(Date.now(), tz).hm;
  const [when, setWhen] = useState({ date, hm: date === today ? nowHm : '12:00' });
  const [slot, setSlot] = useState(slotForHm(when.hm)); const [slotAuto, setSlotAuto] = useState(true);
  return {
    when, slot, tz, today,
    setWhen: (w) => { setWhen(w); if (slotAuto) setSlot(slotForHm(w.hm)); },
    setSlot: (s) => { setSlot(s); setSlotAuto(false); },
  };
}
function WhenFields({ w }) {
  return html`<div class="stack sm">
    <${TimeFields} date=${w.when.date} hm=${w.when.hm} max=${w.today} onChange=${w.setWhen} />
    <${SlotChips} value=${w.slot} onValue=${w.setSlot} />
  </div>`;
}

/* ---------------------------------------------------------------- describe */
function TextCapture({ date, onCreated, close, back }) {
  const app = useApp(); const w = useWhen(date);
  const [text, setText] = useState('');
  const ai = app.ai();
  const save = () => {
    const t = text.trim(); if (!t) return;
    const id = uid();
    app.store.create('meals', { id, date: w.when.date, at: atFor(w.when.date, w.when.hm, w.tz), timeSource: 'manual', slot: w.slot, source: 'text', note: t, status: ai ? 'analyzing' : 'pending', answers: [], followUp: null });
    if (ai) enqueueAnalysis(app, id);
    onCreated([id]);
  };
  return html`<div class="stack">
    <${SheetHead} title="Describe a meal" onClose=${() => close()}>${back ? html`<${Button} size="sm" variant="ghost" onClick=${back}>Back</${Button}>` : null}</${SheetHead}>
    <${Field} label="What did you eat?" hint="Amounts, brands and cooking method make the estimate precise.">
      <${Textarea} rows="3" value=${text} onValue=${setText} placeholder="2 eggs, 2 slices sourdough, 1 tbsp butter" autofocus /></${Field}>
    <${WhenFields} w=${w} />
    ${ai ? null : html`<${Notice}>Without an API key the description is saved and estimated later. To log numbers now, use Saved foods → Quick add.</${Notice}>`}
    <${SheetFoot}><${Button} onClick=${() => close()}>Cancel</${Button}>
      <${Button} variant="primary" disabled=${!text.trim()} onClick=${save}>${ai ? 'Save & estimate' : 'Save for later'}</${Button}></${SheetFoot}>
  </div>`;
}

/* ------------------------------------------------------ saved / quick add */
function foodItems(food, servings) {
  const base = Array.isArray(food.items) && food.items.length ? food.items
    : food.totals ? [{ name: food.name, portion: '1 serving', grams: 0, confidence: 'medium', basis: 'saved', ...food.totals }] : [];
  return base.map((it) => ({ ...scaleItem(it, servings), basis: 'saved' }));
}

function SavedCapture({ date, onLogged, close, back }) {
  const app = useApp(); useVersion(['foods']);
  const w = useWhen(date);
  const foods = sortFoods(app.store.all('foods'));
  const [tab, setTab] = useState(foods.length ? 'saved' : 'quick');
  const [q, setQ] = useState('');
  const [basket, setBasket] = useState([]); // [{ id, servings }]
  const [manage, setManage] = useState(false);
  const [quick, setQuick] = useState({ name: '', kcal: null, protein: null, carbs: null, fat: null, fiber: null, keep: false });
  const setQ2 = (k) => (v) => setQuick((x) => ({ ...x, [k]: v }));
  const shown = searchFoods(foods, q);
  const inBasket = (id) => basket.find((b) => b.id === id);
  const toggle = (id) => setBasket((b) => (b.find((x) => x.id === id) ? b.filter((x) => x.id !== id) : [...b, { id, servings: 1 }]));
  const chosen = basket.map((b) => ({ ...b, food: app.store.get('foods', b.id) })).filter((b) => b.food);
  const basketItems = chosen.flatMap((b) => foodItems(b.food, b.servings));
  const basketKcal = itemsTotals(basketItems).kcal;

  const createMeal = (fields) => {
    const id = uid();
    app.store.create('meals', { id, date: w.when.date, at: atFor(w.when.date, w.when.hm, w.tz), timeSource: 'manual', slot: w.slot, status: 'ready', answers: [], followUp: null, note: '', ...fields });
    const kcal = fields.totals && isNum(fields.totals.kcal) ? ` · ${fmtNum(fields.totals.kcal)} kcal` : '';
    app.toast(`Logged ${fields.title}${kcal}${w.when.date !== app.today() ? ' on ' + fmtDate(w.when.date) : ''}`, { action: { label: 'Undo', onClick: () => app.store.remove('meals', id) } });
    onLogged([id]);
  };
  const logSaved = () => {
    if (!chosen.length) return;
    const title = chosen.map((b) => b.food.name + (b.servings !== 1 ? ` ×${b.servings}` : '')).join(' + ');
    const when = nowIso(w.tz);
    for (const b of chosen) app.store.update('foods', b.id, { uses: (Number(b.food.uses) || 0) + 1, lastUsedAt: when });
    createMeal({ source: 'saved', title: title.slice(0, 80), items: basketItems, totals: itemsTotals(basketItems) });
  };
  const qItem = quickItem(quick);
  const logQuick = () => {
    if (!qItem) return;
    const totals = itemsTotals([qItem]);
    if (quick.keep) app.store.create('foods', { name: qItem.name, items: [{ ...qItem, basis: 'saved' }], totals, uses: 1, lastUsedAt: nowIso(w.tz), favorite: false });
    createMeal({ source: 'quick', title: qItem.name, items: [qItem], totals });
  };
  const macroKcal = kcalFromMacros(quick);

  return html`<div class="stack">
    <${SheetHead} title="Log a meal" onClose=${() => close()}>${back ? html`<${Button} size="sm" variant="ghost" onClick=${back}>Back</${Button}>` : null}</${SheetHead}>
    <${Segmented} block value=${tab} onValue=${setTab} options=${[{ value: 'saved', label: `Saved foods${foods.length ? ' · ' + foods.length : ''}` }, { value: 'quick', label: 'Quick add' }]} label="Log from" />
    ${tab === 'saved' ? html`
      ${foods.length ? html`<div class="row" style="gap:8px"><div class="search-box grow"><${Icon} name="search" size=${16} /><${Input} value=${q} onValue=${setQ} placeholder="Search saved foods" type="search" aria-label="Search saved foods" /></div>
        <${Button} size="sm" variant="ghost" aria-pressed=${String(manage)} onClick=${() => setManage(!manage)}>${manage ? 'Done' : 'Manage'}</${Button}></div>` : null}
      ${!foods.length ? html`<${Empty} title="No saved foods yet">Open any analyzed meal and tap <b>Save as food</b>. It then logs here in one tap, with its numbers.</${Empty}>`
        : !shown.length ? html`<div class="small muted" style="padding:6px 2px">No saved food matches “${q}”.</div>`
        : html`<div class="card flush"><div class="list food-list">${shown.slice(0, 60).map((f) => html`<div class=${cx('list-row link food-row', inBasket(f.id) && 'on')} key=${f.id} onClick=${() => (manage ? null : toggle(f.id))} role="button" aria-pressed=${String(!!inBasket(f.id))}>
            <button type="button" class=${cx('icon-btn sm', f.favorite && 'fav')} aria-label=${f.favorite ? 'Unfavorite ' + f.name : 'Favorite ' + f.name}
              onClick=${(e) => { e.stopPropagation(); app.store.update('foods', f.id, { favorite: !f.favorite }); }}><${Icon} name=${f.favorite ? 'starFill' : 'star'} /></button>
            <div class="grow"><div class="title ellipsis">${f.name}</div><div class="meta mono ellipsis">${macroLine(f.totals)}</div></div>
            <div class="trail row" style="gap:8px"><span class="mono small">${f.totals && isNum(f.totals.kcal) ? fmtNum(f.totals.kcal) : '—'}<span class="xs muted"> kcal</span></span>
              ${manage ? html`<${IconButton} icon="trash" sm label=${'Delete ' + f.name} onClick=${(e) => { e.stopPropagation(); setBasket((b) => b.filter((x) => x.id !== f.id)); removeWithUndo(app, 'foods', f.id, 'Saved food'); }} />`
                : html`<span class=${cx('pick', inBasket(f.id) && 'on')}><${Icon} name=${inBasket(f.id) ? 'check' : 'plus'} size=${16} /></span>`}</div>
          </div>`)}</div></div>`}
      ${chosen.length ? html`<div class="card inset stack sm">
        <div class="row between"><span class="strong small">This meal</span><span class="small"><b class="tnum">${fmtNum(basketKcal)}</b> kcal</span></div>
        <div class="xs muted mono">${macroLine(itemsTotals(basketItems))}</div>
        ${chosen.map((b) => html`<div class="row between basket-row" key=${b.id}><span class="grow ellipsis small">${b.food.name}</span>
          <${Stepper} value=${b.servings} step=${0.5} min=${0.25} max=${20} dp=${2} onValue=${(v) => setBasket((bs) => bs.map((x) => (x.id === b.id ? { ...x, servings: v || 1 } : x)))} />
          <${IconButton} icon="x" sm label=${'Remove ' + b.food.name} onClick=${() => toggle(b.id)} /></div>`)}
        <div class="xs muted">Servings multiply every item of the saved food.</div>
      </div>` : null}` : html`
      <div class="stack sm">
        <${Field} label="Name"><${Input} value=${quick.name} onValue=${setQ2('name')} placeholder="Protein bar" /></${Field}>
        <div class="grid two">
          ${[['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g'], ['fiber', 'Fiber (optional)', 'g']].map(([k, l, u]) => html`<${Field} label=${l}>
            <div class="input-group"><input class="input mono" type="number" inputmode="decimal" min="0" step="any" value=${quick[k] ?? ''} placeholder=${k === 'kcal' && isNum(macroKcal) ? String(macroKcal) : ''}
              onInput=${(e) => setQ2(k)(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))} aria-label=${l} /><span class="suffix">${u}</span></div></${Field}>`)}
        </div>
        ${!isNum(quick.kcal) && isNum(macroKcal) ? html`<div class="xs muted">Calories from macros: ${fmtNum(macroKcal)} kcal (4/4/9).</div>` : null}
        <div class="row between"><span class="small">Also save as a food for one-tap reuse</span><${Toggle} checked=${quick.keep} onValue=${setQ2('keep')} label="Save as food" /></div>
      </div>`}
    <${WhenFields} w=${w} />
    <${SheetFoot}><${Button} onClick=${() => close()}>Cancel</${Button}>
      ${tab === 'saved'
        ? html`<${Button} variant="primary" disabled=${!chosen.length} onClick=${logSaved}>${chosen.length ? `Log · ${fmtNum(basketKcal)} kcal` : 'Pick a food'}</${Button}>`
        : html`<${Button} variant="primary" disabled=${!qItem} onClick=${logQuick}>${qItem ? `Log · ${fmtNum(qItem.kcal)} kcal` : 'Enter kcal or macros'}</${Button}>`}
    </${SheetFoot}>
  </div>`;
}

/* --------------------------------------------------------------- progress */
function Progress({ ids, close }) {
  const app = useApp(); useVersion(['meals']); const jobOf = useQueue();
  const meals = ids.map((id) => app.store.get('meals', id)).filter(Boolean).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const running = meals.filter((m) => isActive(jobOf(m.id))).length;
  const ai = app.ai(); const n = meals.length;
  const title = !ai ? `Saved ${plural(n, 'meal')}` : running ? `Analyzing ${plural(n, 'meal')}` : n === 1 ? 'Meal saved' : `${plural(n, 'meal')} saved`;
  return html`<div class="stack">
    <${SheetHead} title=${title} onClose=${() => close(ids)} />
    ${!ai ? html`<${AiKeyNotice} what="meal analysis — these meals wait with their photos until then" />` : null}
    ${n ? html`<div class="card flush"><div class="list">${meals.map((m) => html`<${MealRow} key=${m.id} meal=${m} job=${jobOf(m.id)} tz=${app.dv.tz} onOpen=${() => openMeal(app, m.id)} />`)}</div></div>`
      : html`<${Empty} title="Nothing saved">The meals were removed.</${Empty}>`}
    ${running ? html`<div class="xs muted">You can close this — analysis continues in the background and the results appear on Fuel.</div>`
      : ai && n ? html`<div class="xs muted">Tap a meal to check items and portions, answer a question, or correct the time.</div>` : null}
    <${SheetFoot}><${Button} variant="primary" onClick=${() => close(ids)}>${running ? 'Close' : 'Done'}</${Button}></${SheetFoot}>
  </div>`;
}
