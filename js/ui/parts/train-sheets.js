// Train area sheets. Each sheet is a component (rendered by SheetHost); the openers wrap app.sheet().
import { html, useState, useMemo } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useWide } from '../ctx.js';
import {
  Button, IconButton, Field, Input, Select, Textarea, Segmented, Toggle, Chips, List, ListRow, Empty, Notice, SheetHead, SheetFoot, Icon, Pill,
} from '../kit.js';
import { removeWithUndo } from './common.js';
import { MUSCLES } from '../../core/schema.js';
import { uid, nowIso, isoWithOffset, addDays, fmtDate, fmtDur, fmtNum, isNum, round, signed, relDay } from '../../core/util.js';
import {
  filterExercises, rankExercises, sessionStats, sessionRecords, isPr, fmtLb, templateFromSession, completeSet, fmtW,
  entriesFromTemplate, entriesFromSession,
} from './train-logic.js';
import {
  exerciseList, repeatCandidates, recentOpenSession, openSessionOn, defaultCardioExercise, createSession, autoLinkWorkout, linkedWorkout,
  findWorkoutFor, bestsFor, usageCount, hmOf, instantAt, startInstant, lastPerfFn, newEntryId,
} from './train-data.js';
import { cap, exName, exMeta, EQUIPMENT, TYPES, NumCell, Metric } from './train-ui.js';

/** Field-styled group for button controls (a <label> would forward taps on its text to the first button). */
function Group({ label, hint, children }) {
  return html`<div class="field" role="group" aria-label=${label}><span class="label-text">${label}</span>${children}${hint ? html`<span class="hint">${hint}</span>` : null}</div>`;
}

/* ================================================================ openers */
/** Exercise picker → exercise id | undefined. opts: { type: 'cardio' | undefined (strength + mobility), title } */
export const pickExercise = (app, opts = {}) => app.sheet(({ close }) => html`<${ExercisePicker} close=${close} type=${opts.type} title=${opts.title} />`);
/** Create/edit an exercise → id | 'deleted' | undefined. */
export const editExercise = (app, opts = {}) => app.sheet(({ close }) => html`<${ExerciseEditor} close=${close} id=${opts.id} name=${opts.name} type=${opts.type} />`);
/** Create/edit a workout template → { id, start } | 'deleted' | undefined. opts: { id, fromSession } */
export const editTemplate = (app, opts = {}) => app.sheet(({ close }) => html`<${TemplateEditor} close=${close} id=${opts.id} fromSession=${opts.fromSession} />`, { wide: true });
/** Start chooser → { kind: 'template'|'repeat'|'open', id } | { kind: 'empty' } | undefined. */
export const chooseStart = (app, opts = {}) => app.sheet(({ close }) => html`<${StartChooser} close=${close} date=${opts.date} />`);
/** Quick cardio entry → session id | undefined. */
export const cardioSheet = (app, opts = {}) => app.sheet(({ close }) => html`<${CardioSheet} close=${close} date=${opts.date} />`);
/** Finish form + summary → 'done' | 'keep' | undefined. opts: { summary: true } opens the summary directly. */
export const finishSession = (app, id, opts = {}) => app.sheet(({ close }) => html`<${FinishSheet} close=${close} id=${id} summary=${!!opts.summary} />`);
/** Session details (name, date, times, RPE, note, WHOOP link, resume, delete) → 'deleted' | 'saved' | undefined. */
export const sessionDetails = (app, id) => app.sheet(({ close }) => html`<${SessionDetails} close=${close} id=${id} />`);

/* ======================================================= exercise picker */
function ExercisePicker({ close, type, title }) {
  const app = useApp(); const v = useVersion(['exercises', 'sessions']); const wide = useWide();
  const [q, setQ] = useState(''); const [muscle, setMuscle] = useState('');
  const cardio = type === 'cardio';
  const all = useMemo(() => exerciseList(app.dv).filter((x) => (cardio ? x.type === 'cardio' : (x.type || 'strength') !== 'cardio')), [v, cardio]);
  const recent = useMemo(() => {
    const ids = new Set(all.map((x) => x.id)); const ex = app.dv.exercises();
    return rankExercises(app.dv.allSessions(), addDays(app.today(), -90)).filter((r) => ids.has(r.id)).slice(0, 8).map((r) => ({ ...ex.get(r.id), uses: r.count, last: r.last }));
  }, [v, all]);
  const results = filterExercises(all, { query: q, muscle });
  const term = q.trim();
  const exact = term && all.some((x) => String(x.name).toLowerCase() === term.toLowerCase());
  const create = async () => {
    const id = await editExercise(app, { name: term, type: cardio ? 'cardio' : 'strength' });
    if (id && id !== 'deleted') close(id);
  };
  const row = (x, meta) => html`<${ListRow} key=${x.id} title=${x.name} meta=${meta || exMeta(x)} onClick=${() => close(x.id)} />`;
  return html`<div class="stack">
    <${SheetHead} title=${title || (cardio ? 'Cardio exercise' : 'Add exercise')} onClose=${() => close()} />
    <div class="tr-search"><${Icon} name="search" size=${16} /><${Input} value=${q} onValue=${setQ} placeholder="Search exercises" aria-label="Search exercises" autofocus=${wide} /></div>
    ${cardio ? null : html`<div class="tr-chip-scroll"><${Chips} options=${MUSCLES.map((m) => ({ value: m, label: cap(m) }))} value=${muscle} onValue=${(m) => setMuscle(m === muscle ? '' : m)} /></div>`}
    ${!term && !muscle && recent.length ? html`<div class="stack xs"><div class="eyebrow">Recent</div>
      <div class="card flush"><${List}>${recent.map((x) => row(x, `${exMeta(x)} · ${x.uses}× · last ${fmtDate(x.last, { dow: false })}`))}</${List}></div></div>` : null}
    <div class="stack xs"><div class="eyebrow">${term || muscle ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'All exercises'}</div>
      ${results.length ? html`<div class="card flush"><${List}>${results.slice(0, 120).map((x) => row(x))}</${List}></div>`
        : html`<${Empty} title="No match">${term ? `Nothing in the library matches “${term}”.` : 'No exercises for this filter.'}</${Empty}>`}
    </div>
    ${term && !exact ? html`<${Button} icon="plus" block onClick=${create}>Create “${term}”</${Button}>`
      : html`<${Button} variant="ghost" icon="plus" block onClick=${async () => { const id = await editExercise(app, { type: cardio ? 'cardio' : 'strength' }); if (id && id !== 'deleted') close(id); }}>New exercise</${Button}>`}
  </div>`;
}

/* ======================================================= exercise editor */
function ExerciseEditor({ close, id, name, type }) {
  const app = useApp(); useVersion(['exercises']);
  const ex = id ? app.store.get('exercises', id) : null;
  const [f, setF] = useState(() => (ex
    ? { name: ex.name || '', type: ex.type || 'strength', muscle: ex.muscle || 'full', secondary: ex.secondary || [], equipment: ex.equipment || 'other', bodyweight: !!ex.bodyweight }
    : { name: name || '', type: type || 'strength', muscle: type === 'cardio' ? 'full' : 'chest', secondary: [], equipment: type === 'cardio' ? 'cardio' : 'barbell', bodyweight: false }));
  const [err, setErr] = useState('');
  const set = (p) => { setF((x) => ({ ...x, ...p })); setErr(''); };
  const cardio = f.type === 'cardio';
  const save = () => {
    const nm = f.name.trim().replace(/\s+/g, ' ');
    if (!nm) return setErr('Name the exercise.');
    const dup = [...app.dv.exercises().values()].find((x) => x.id !== id && String(x.name).toLowerCase() === nm.toLowerCase());
    if (dup) return setErr(`“${dup.name}” is already in the library.`);
    const fields = { name: nm, type: f.type, muscle: cardio ? 'full' : f.muscle, secondary: cardio ? [] : f.secondary.filter((m) => m !== f.muscle), equipment: f.equipment, bodyweight: cardio ? false : !!f.bodyweight };
    let newId = id;
    if (ex) app.store.update('exercises', id, fields); else newId = app.store.create('exercises', fields).id;
    app.toast(ex ? 'Exercise updated' : `${nm} added to the library`);
    close(newId);
  };
  const del = async () => {
    const n = usageCount(app.dv, id);
    const ok = await app.confirm({ title: `Delete ${ex.name}?`, message: n ? `It is used in ${n} session${n === 1 ? '' : 's'}. Those sets stay in your history but show as “Unknown exercise”.` : 'It is not used in any session.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    removeWithUndo(app, 'exercises', id, 'Exercise');
    close('deleted');
  };
  return html`<div class="stack">
    <${SheetHead} title=${ex ? 'Edit exercise' : 'New exercise'} onClose=${() => close()} />
    <${Field} label="Name" error=${err}><${Input} value=${f.name} onValue=${(v) => set({ name: v })} placeholder="e.g. Pendlay Row" /></${Field}>
    <${Group} label="Type"><${Segmented} block value=${f.type} options=${TYPES} label="Exercise type" onValue=${(t) => set({ type: t, ...(t === 'cardio' ? { equipment: 'cardio', muscle: 'full' } : f.type === 'cardio' ? { equipment: 'other', muscle: 'chest' } : {}) })} /></${Group}>
    ${cardio ? html`<div class="xs muted">Cardio entries log duration, distance, average watts and heart rate.</div>` : html`
      <div class="grid two">
        <${Field} label="Primary muscle"><${Select} value=${f.muscle} onValue=${(m) => set({ muscle: m })} options=${MUSCLES.map((m) => ({ value: m, label: cap(m) }))} /></${Field}>
        <${Field} label="Equipment"><${Select} value=${f.equipment} onValue=${(e) => set({ equipment: e, ...(e === 'bodyweight' ? { bodyweight: true } : {}) })} options=${EQUIPMENT.filter((e) => e !== 'cardio').map((e) => ({ value: e, label: cap(e) }))} /></${Field}>
      </div>
      <${Group} label="Secondary muscles" hint="Count as half a set each in weekly volume."><${Chips} multi options=${MUSCLES.filter((m) => m !== f.muscle).map((m) => ({ value: m, label: cap(m) }))} value=${f.secondary} onValue=${(v) => set({ secondary: v })} /></${Group}>
      <div class="row between" style="padding:4px 0"><div class="grow"><div class="strong small">Bodyweight</div><div class="xs muted">Log added weight; empty or 0 means bodyweight only.</div></div>
        <${Toggle} checked=${f.bodyweight} onValue=${(b) => set({ bodyweight: b })} label="Bodyweight exercise" /></div>`}
    <${SheetFoot}>
      ${ex ? html`<${Button} variant="danger" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>${ex ? 'Save' : 'Add exercise'}</${Button}>
    </${SheetFoot}>
  </div>`;
}

/* ======================================================= template editor */
function TemplateEditor({ close, id, fromSession }) {
  const app = useApp(); useVersion(['templates', 'exercises']);
  const tpl = id ? app.store.get('templates', id) : null;
  const src = !tpl && fromSession ? app.store.get('sessions', fromSession) : null;
  const [name, setName] = useState(() => (tpl ? tpl.name || '' : src ? src.name || '' : ''));
  const [items, setItems] = useState(() => (tpl ? tpl.exercises || [] : src ? templateFromSession(src) : []).map((x) => ({ ...x, key: uid(6) })));
  const [err, setErr] = useState('');
  const ex = app.dv.exercises();
  const upd = (i, p) => setItems((l) => l.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const move = (i, d) => setItems((l) => { const a = l.slice(); const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const add = async () => { const exId = await pickExercise(app, { title: 'Add to template' }); if (exId) { setItems((l) => [...l, { key: uid(6), exerciseId: exId, sets: 3, reps: null, rpe: null }]); setErr(''); } };
  const save = (start) => {
    const nm = name.trim();
    if (!nm) return setErr('Name the template (e.g. Push A).');
    if (!items.length) return setErr('Add at least one exercise.');
    const exercises = items.map(({ exerciseId, sets, reps, rpe }) => ({ exerciseId, sets: Math.max(1, Math.round(sets || 1)), reps: isNum(reps) ? reps : null, rpe: isNum(rpe) ? rpe : null }));
    let tid = id;
    if (tpl) app.store.update('templates', id, { name: nm, exercises }); else tid = app.store.create('templates', { kind: 'workout', name: nm, exercises }).id;
    app.toast(tpl ? 'Template saved' : `Template “${nm}” created`);
    close({ id: tid, start: !!start });
  };
  const del = async () => {
    const ok = await app.confirm({ title: `Delete “${tpl.name}”?`, message: 'Past sessions started from it are kept.', confirmLabel: 'Delete', danger: true });
    if (ok) { removeWithUndo(app, 'templates', id, 'Template'); close('deleted'); }
  };
  const total = items.reduce((s, x) => s + (x.sets || 0), 0);
  return html`<div class="stack">
    <${SheetHead} title=${tpl ? 'Edit template' : 'New template'} onClose=${() => close()} />
    <${Field} label="Name" error=${err && !name.trim() ? err : ''}><${Input} value=${name} onValue=${(v) => { setName(v); setErr(''); }} placeholder="e.g. Push A" /></${Field}>
    <div class="row between"><div class="eyebrow">Exercises</div><span class="xs muted">${items.length} exercise${items.length === 1 ? '' : 's'} · ${total} set${total === 1 ? '' : 's'}</span></div>
    ${items.length ? html`<div class="stack sm">${items.map((it, i) => html`<div class="tr-tpl-item" key=${it.key}>
        <div class="row" style="gap:4px">
          <div class="grow" style="min-width:0"><div class="strong small ellipsis">${exName(ex.get(it.exerciseId), it.exerciseId)}</div><div class="xs muted">${exMeta(ex.get(it.exerciseId))}</div></div>
          <${IconButton} icon="chevronUp" label="Move up" sm disabled=${i === 0} onClick=${() => move(i, -1)} />
          <${IconButton} icon="chevronDown" label="Move down" sm disabled=${i === items.length - 1} onClick=${() => move(i, 1)} />
          <${IconButton} icon="x" label="Remove" sm onClick=${() => setItems((l) => l.filter((_, k) => k !== i))} />
        </div>
        <div class="tr-tpl-fields">
          <div class="tr-mini"><span>Sets</span><${MiniStep} value=${it.sets} min=${1} max=${20} label=${'Sets for ' + exName(ex.get(it.exerciseId), it.exerciseId)} onValue=${(n) => upd(i, { sets: n })} /></div>
          <div class="tr-mini"><span>Reps</span><${MiniStep} value=${it.reps} min=${1} max=${50} start=${8} label=${'Reps for ' + exName(ex.get(it.exerciseId), it.exerciseId)} onValue=${(n) => upd(i, { reps: n })} placeholder="—" /></div>
          <div class="tr-mini"><span>RPE</span><${NumCell} value=${it.rpe} onValue=${(n) => upd(i, { rpe: n == null ? null : Math.min(10, Math.max(1, n)) })} placeholder="—" label=${'Target RPE for ' + exName(ex.get(it.exerciseId), it.exerciseId)} class="tr-rpe" /></div>
        </div>
      </div>`)}</div>` : html`<${Empty} title="No exercises yet">Add the exercises of this workout in order. Sets, rep and RPE targets pre-fill the logger; weights come from your last session.</${Empty}>`}
    ${err && name.trim() ? html`<div class="xs ink-bad">${err}</div>` : null}
    <${Button} icon="plus" block onClick=${add}>Add exercise</${Button}>
    <${SheetFoot}>
      ${tpl ? html`<${Button} variant="danger" onClick=${del}>Delete</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      ${tpl ? html`<${Button} onClick=${() => save(true)}>Save & start</${Button}>` : null}
      <${Button} variant="primary" onClick=${() => save(false)}>Save</${Button}>
    </${SheetFoot}>
  </div>`;
}

/** Compact integer stepper for sheets: { value, onValue, min, max, placeholder } */
export function MiniStep({ value, onValue, min = 0, max = 999, placeholder, label = 'Value', start }) {
  const set = (n) => onValue(n == null ? null : Math.min(max, Math.max(min, Math.round(n))));
  const base = isNum(value) ? value : isNum(start) ? start : null;
  return html`<span class="tr-step">
    <button type="button" aria-label=${label + ' minus 1'} onClick=${() => set(base == null ? min : base - (isNum(value) ? 1 : 0))}>−</button>
    <${NumCell} value=${value} onValue=${(n) => set(n)} mode="numeric" placeholder=${placeholder} label=${label} />
    <button type="button" aria-label=${label + ' plus 1'} onClick=${() => set(base == null ? min : base + (isNum(value) ? 1 : 0))}>+</button>
  </span>`;
}

/* ========================================================= start chooser */
function StartChooser({ close, date }) {
  const app = useApp(); useVersion(['templates', 'sessions', 'exercises']);
  const today = app.today(); const d = date || today;
  const templates = app.dv.templates('workout').slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const lastUse = useMemo(() => { const m = new Map(); for (const s of app.dv.allSessions()) if (s.templateId) m.set(s.templateId, s.date); return m; }, [app.store.version]);
  const repeats = repeatCandidates(app.dv, 4);
  const open = d === today ? recentOpenSession(app.dv, today) : openSessionOn(app.dv, d);
  const ex = app.dv.exercises();
  const newTpl = async () => { const r = await editTemplate(app); if (r && r.id && r.start) close({ kind: 'template', id: r.id }); };
  return html`<div class="stack">
    <${SheetHead} title="Start workout" onClose=${() => close()} />
    ${d !== today ? html`<${Notice}>Logging for ${fmtDate(d)}.</${Notice}>` : null}
    ${open ? html`<${Notice} tone="warn"><div class="row between wrap" style="gap:8px"><span>Unfinished: <b>${open.name || 'Workout'}</b> (${relDay(open.date, today)}).</span>
      <${Button} size="sm" onClick=${() => close({ kind: 'open', id: open.id })}>Open it</${Button}></div></${Notice}>` : null}
    <div class="stack xs"><div class="row between"><span class="eyebrow">Templates</span><button class="btn ghost sm" type="button" onClick=${newTpl}><${Icon} name="plus" />New</button></div>
      ${templates.length ? html`<div class="card flush"><${List}>${templates.map((t) => {
        const n = (t.exercises || []).length; const sets = (t.exercises || []).reduce((s, x) => s + (x.sets || 0), 0);
        const names = (t.exercises || []).slice(0, 3).map((x) => exName(ex.get(x.exerciseId), x.exerciseId)).join(', ');
        return html`<${ListRow} key=${t.id} lead="layers" title=${t.name} meta=${`${n} exercise${n === 1 ? '' : 's'} · ${sets} sets${lastUse.get(t.id) ? ' · last ' + fmtDate(lastUse.get(t.id), { dow: false }) : ''}`} onClick=${() => close({ kind: 'template', id: t.id })}>
          ${names ? html`<div class="xs muted ellipsis">${names}${n > 3 ? ', …' : ''}</div>` : null}</${ListRow}>`;
      })}</${List}></div>`
        : html`<div class="notice"><${Icon} name="layers" /><div>Templates hold your split (e.g. Push / Pull / Legs): exercises, set counts and rep targets. Sessions started from one pre-fill weights from last time.</div></div>`}
    </div>
    ${repeats.length ? html`<div class="stack xs"><span class="eyebrow">Repeat a recent session</span><div class="card flush"><${List}>${repeats.map((s) => {
      const st = sessionStats(s);
      return html`<${ListRow} key=${s.id} lead="repeat" title=${'Repeat ' + (s.name || 'workout')} meta=${`${relDay(s.date, today)} · ${st.exercises} exercise${st.exercises === 1 ? '' : 's'} · ${st.workingSets} sets`} onClick=${() => close({ kind: 'repeat', id: s.id })} />`;
    })}</${List}></div></div>` : null}
    <${SheetFoot}><${Button} onClick=${() => close()}>Cancel</${Button}><${Button} variant="primary" icon="plus" onClick=${() => close({ kind: 'empty' })}>Empty session</${Button}></${SheetFoot}>
  </div>`;
}

/* ============================================================ cardio log */
const CARDIO_FIELDS = [
  ['durationMin', 'Duration', 'min', 'numeric'], ['distanceMi', 'Distance', 'mi', 'decimal'], ['avgWatts', 'Avg power', 'W', 'numeric'],
  ['avgHr', 'Avg HR', 'bpm', 'numeric'], ['maxHr', 'Max HR', 'bpm', 'numeric'], ['kcal', 'Energy', 'kcal', 'numeric'],
];
export { CARDIO_FIELDS };

function CardioSheet({ close, date }) {
  const app = useApp(); useVersion(['sessions', 'exercises']);
  const today = app.today(); const d = date || today;
  const open = openSessionOn(app.dv, d);
  const [exId, setExId] = useState(() => defaultCardioExercise(app.dv));
  const [f, setF] = useState({ durationMin: null, distanceMi: null, avgWatts: null, avgHr: null, maxHr: null, kcal: null, rpe: null });
  const [hm, setHm] = useState(null); // null = follow "now − duration"
  const [err, setErr] = useState('');
  const ex = app.dv.exercises(); const cardioList = exerciseList(app.dv, 'cardio');
  const autoHm = hmOf(app.dv, isoWithOffset(Date.now() - (f.durationMin || 0) * 60000, app.dv.tz));
  const startHm = hm || (d === today ? autoHm : ((app.store.setting('targets').trainingWindow || {}).start || '12:00'));
  const last = useMemo(() => {
    const all = app.dv.allSessions();
    for (let i = all.length - 1; i >= 0; i--) { const c = (all[i].cardio || []).filter((x) => x && x.exerciseId === exId); if (c.length) return { date: all[i].date, c: c[c.length - 1] }; }
    return null;
  }, [exId, app.store.version]);
  const pick = async () => { const id = await pickExercise(app, { type: 'cardio', title: 'Cardio exercise' }); if (id) setExId(id); };
  const set = (p) => { setF((x) => ({ ...x, ...p })); setErr(''); };
  const eff = isNum(f.avgWatts) && isNum(f.avgHr) && f.avgHr > 0 ? round(f.avgWatts / f.avgHr, 2) : null;
  const save = () => {
    if (!exId || !ex.get(exId)) return setErr('Choose a cardio exercise.');
    if (!isNum(f.durationMin) || f.durationMin <= 0) return setErr('Enter the duration in minutes.');
    if (isNum(f.avgHr) && isNum(f.maxHr) && f.maxHr < f.avgHr) return setErr('Max HR is below average HR.');
    const entry = { id: 'c' + uid(8), exerciseId: exId, durationMin: f.durationMin, distanceMi: f.distanceMi, avgWatts: f.avgWatts, avgHr: f.avgHr, maxHr: f.maxHr, kcal: f.kcal, rpe: f.rpe };
    const name = ex.get(exId).name;
    let sid;
    if (open) {
      sid = open.id;
      app.store.update('sessions', sid, { cardio: [...(open.cardio || []), entry] });
      app.toast(`${name} · ${fmtNum(f.durationMin)} min added to ${open.name || 'the open session'}`, { action: { label: 'Undo', onClick: () => { const s = app.store.get('sessions', sid); if (s) app.store.update('sessions', sid, { cardio: (s.cardio || []).filter((c) => c && c.id !== entry.id) }); } } });
    } else {
      const startAt = instantAt(app.dv, d, startHm);
      const endAt = isoWithOffset(Date.parse(startAt) + f.durationMin * 60000, app.dv.tz);
      sid = createSession(app, { date: d, name, startAt, endAt, cardio: [entry], rpe: f.rpe });
      autoLinkWorkout(app, sid);
      app.toast(`${name} · ${fmtNum(f.durationMin)} min logged`, { action: { label: 'Undo', onClick: () => app.store.remove('sessions', sid) } });
    }
    close(sid);
  };
  return html`<div class="stack">
    <${SheetHead} title="Log cardio" onClose=${() => close()} />
    ${open ? html`<div class="xs muted">Adds to <b class="dim">${open.name || 'Workout'}</b> (in progress).</div>` : d !== today ? html`<div class="xs muted">For ${fmtDate(d)}.</div>` : null}
    <${Group} label="Exercise">
      ${cardioList.length ? html`<div class="row" style="gap:8px"><${Select} aria-label="Cardio exercise" value=${exId || ''} onValue=${setExId} options=${[...(exId ? [] : [{ value: '', label: 'Choose…' }]), ...cardioList.map((x) => ({ value: x.id, label: x.name }))]} />
        <${IconButton} icon="search" label="Find or create" bordered onClick=${pick} /></div>`
        : html`<${Button} icon="plus" onClick=${pick}>Add a cardio exercise</${Button}>`}
    </${Group}>
    ${last ? html`<div class="xs muted mono">Last · ${fmtDate(last.date, { dow: false })}: ${cardioLine(last.c)}</div>` : null}
    <div class="grid three tr-cardio-grid">
      ${CARDIO_FIELDS.map(([k, label, unit, mode]) => html`<label class="field"><span class="label-text">${label}${k === 'durationMin' ? ' *' : ''}</span>
        <div class="input-group"><${NumCell} class="input mono" value=${f[k]} onValue=${(v) => set({ [k]: v })} mode=${mode} label=${label} placeholder=${last && isNum(last.c[k]) ? fmtW(last.c[k]) : ''} /><span class="suffix">${unit}</span></div></label>`)}
    </div>
    <div class="grid two">
      <${Field} label="RPE (1–10)"><div class="input-group"><${NumCell} class="input mono" value=${f.rpe} onValue=${(v) => set({ rpe: v == null ? null : Math.min(10, Math.max(1, v)) })} label="RPE" placeholder=${last && isNum(last.c.rpe) ? fmtW(last.c.rpe) : ''} /><span class="suffix">/10</span></div></${Field}>
      ${open ? html`<div></div>` : html`<${Field} label="Start time"><input class="input mono" type="time" value=${startHm} onInput=${(e) => setHm(e.currentTarget.value || null)} /></${Field}>`}
    </div>
    ${eff != null ? html`<div class="xs muted">Efficiency ${fmtNum(eff, 2)} W per bpm (avg power ÷ avg heart rate).</div>` : null}
    ${err ? html`<div class="xs ink-bad">${err}</div>` : null}
    <${SheetFoot}><${Button} onClick=${() => close()}>Cancel</${Button}><${Button} variant="primary" onClick=${save}>Save</${Button}></${SheetFoot}>
  </div>`;
}
/** '25 min · 7.2 mi · 165 W · HR 136/158 · 250 kcal' */
export function cardioLine(c) {
  if (!c) return '';
  return [isNum(c.durationMin) ? fmtNum(c.durationMin) + ' min' : null, isNum(c.distanceMi) ? fmtNum(c.distanceMi, 1) + ' mi' : null,
    isNum(c.avgWatts) ? fmtNum(c.avgWatts) + ' W' : null, isNum(c.avgHr) ? 'HR ' + fmtNum(c.avgHr) + (isNum(c.maxHr) ? '/' + fmtNum(c.maxHr) : '') : null,
    isNum(c.kcal) ? fmtNum(c.kcal) + ' kcal' : null].filter(Boolean).map((x) => x.replace(/ /g, '\u00a0')).join(' · ') || 'No metrics';
}

/* ======================================================== finish + summary */
function FinishSheet({ close, id, summary }) {
  const app = useApp(); useVersion(['sessions', 'whoopWorkouts', 'exercises']);
  const s = app.store.get('sessions', id);
  const today = app.today();
  const [step, setStep] = useState(summary || (s && s.endAt) ? 'summary' : 'form');
  const defaultEnd = s && s.date !== today && s.startAt ? hmOf(app.dv, isoWithOffset(Date.parse(s.startAt) + 60 * 60000, app.dv.tz)) : null;
  const [endHm, setEndHm] = useState(defaultEnd);
  const [rpe, setRpe] = useState(s ? s.rpe ?? null : null);
  const [note, setNote] = useState(s ? s.note || '' : '');
  const [err, setErr] = useState('');
  if (!s) return html`<div class="stack"><${SheetHead} title="Session" onClose=${() => close()} /><${Empty} title="Session not found">It may have been deleted.</${Empty}></div>`;
  const ex = app.dv.exercises();
  const st = sessionStats(s);
  const pendingIdx = [];
  (s.entries || []).forEach((e, i) => (e.sets || []).forEach((x, j) => { if (x && x.done === false) pendingIdx.push([i, j]); }));
  const fixPending = (mode) => {
    const entries = (s.entries || []).map((e) => {
      const bw = !!(ex.get(e.exerciseId) || {}).bodyweight;
      const sets = (e.sets || []).map((x) => (x && x.done === false && mode === 'done' ? (completeSet(x, null, bw).set || x) : x)).filter((x) => !(mode === 'remove' && x && x.done === false));
      return { ...e, sets };
    }).filter((e) => mode !== 'remove' || (e.sets || []).length);
    app.store.update('sessions', id, { entries });
  };
  const finish = () => {
    const endAt = endHm ? instantAt(app.dv, s.date, endHm, s.startAt) : nowIso(app.dv.tz);
    if (!(Date.parse(endAt) > Date.parse(s.startAt))) return setErr('The end time must be after the start.');
    app.store.update('sessions', id, { endAt, rpe, note: note.trim() });
    autoLinkWorkout(app, id);
    setStep('summary');
  };
  if (step === 'form') {
    const started = Date.parse(s.startAt); const hoursAgo = isFinite(started) ? (Date.now() - started) / 3600000 : 0;
    const fillable = pendingIdx.filter(([i, j]) => { const e = s.entries[i]; return completeSet(e.sets[j], null, !!(ex.get(e.exerciseId) || {}).bodyweight).set; }).length;
    return html`<div class="stack">
      <${SheetHead} title="Finish workout" onClose=${() => close()} />
      <div class="grid three tr-metrics">
        <${Metric} label="Working sets" value=${fmtNum(st.workingSets)} />
        <${Metric} label="Volume" value=${fmtLb(st.volumeLb, false)} unit="lb" />
        <${Metric} label="Exercises" value=${fmtNum(st.exercises + st.cardioCount)} />
      </div>
      ${pendingIdx.length ? html`<${Notice} tone="warn"><div class="stack sm"><span>${pendingIdx.length} set${pendingIdx.length === 1 ? ' is' : 's are'} not marked done and ${pendingIdx.length === 1 ? 'does' : 'do'} not count.</span>
        <div class="row wrap" style="gap:8px">${fillable ? html`<${Button} size="sm" onClick=${() => fixPending('done')}>Mark ${fillable} as done</${Button}>` : null}
          <${Button} size="sm" onClick=${() => fixPending('remove')}>Remove them</${Button}></div></div></${Notice}>` : null}
      <${Group} label="Session RPE" hint="How hard was the whole session? 1 = very easy, 10 = maximal.">
        <div class="stack xs"><div class="scale-row">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" aria-pressed=${String(rpe === n)} onClick=${() => setRpe(rpe === n ? null : n)}>${n}</button>`)}</div>
          <div class="scale-row">${[6, 7, 8, 9, 10].map((n) => html`<button type="button" aria-pressed=${String(rpe === n)} onClick=${() => setRpe(rpe === n ? null : n)}>${n}</button>`)}</div></div>
      </${Group}>
      <${Group} label="End time" hint=${endHm ? '' : hoursAgo > 3 ? `Started ${Math.round(hoursAgo)} h ago — set the time you actually finished.` : 'Leave as now, or set the time you finished.'}>
        <div class="row" style="gap:8px"><input class="input mono" type="time" value=${endHm || hmOf(app.dv, nowIso(app.dv.tz))} onInput=${(e) => { setEndHm(e.currentTarget.value || null); setErr(''); }} style="max-width:160px" />
          ${endHm && s.date === today ? html`<${Button} size="sm" variant="ghost" onClick=${() => setEndHm(null)}>Now</${Button}>` : null}</div>
      </${Group}>
      <${Field} label="Note"><${Textarea} rows="3" value=${note} onValue=${setNote} placeholder="How it went, pain, equipment, what to change next time" /></${Field}>
      ${err ? html`<div class="xs ink-bad">${err}</div>` : null}
      <${SheetFoot}><${Button} onClick=${() => close()}>Cancel</${Button}><${Button} variant="primary" icon="check" onClick=${finish}>Finish</${Button}></${SheetFoot}>
    </div>`;
  }
  return html`<${SessionSummary} session=${s} close=${close} />`;
}

/** Previous session with the same template or name (for comparisons). */
function previousLike(dv, s) {
  const all = dv.allSessions(); const nm = String(s.name || '').trim().toLowerCase();
  let best = null;
  for (const x of all) {
    if (x.id === s.id || !(x.date < s.date || (x.date === s.date && (x.startAt || '') < (s.startAt || '')))) continue;
    if ((s.templateId && x.templateId === s.templateId) || (nm && String(x.name || '').trim().toLowerCase() === nm)) best = x;
  }
  return best;
}

function recordText(r) {
  if (r.type === 'e1rm') return `e1RM ${fmtLb(r.value)} (prev ${fmtLb(r.prev, false)})`;
  if (r.type === 'weight') return `Heaviest ${fmtLb(r.value)} (prev ${fmtLb(r.prev, false)})`;
  if (r.type === 'reps') return `${r.value} reps (prev ${r.prev})`;
  return `${fmtLb(r.value)} × ${r.reps} (prev ${fmtLb(r.prev, false)} for ${r.reps}+)`;
}
export { recordText };

function SessionSummary({ session: s, close }) {
  const app = useApp();
  const ex = app.dv.exercises();
  const st = sessionStats(s);
  const recs = useMemo(() => sessionRecords(s, bestsFor(app.dv, s)), [s]);
  const prsList = recs.filter(isPr); const extra = recs.filter((r) => !isPr(r));
  const prev = useMemo(() => previousLike(app.dv, s), [s]);
  const pst = prev ? sessionStats(prev) : null;
  const w = linkedWorkout(app, s);
  const whoopOn = !!(app.store.setting('integrations').whoop || {}).connectedAt || app.store.all('whoopWorkouts').length > 0;
  const pct = (a, b) => (isNum(a) && isNum(b) && b > 0 ? signed(((a - b) / b) * 100, 1) + '%' : null);
  return html`<div class="stack">
    <${SheetHead} title=${s.name || 'Workout'} onClose=${() => close()} />
    <div class="xs muted">${fmtDate(s.date)} · ${timeRange(app.dv, s.startAt, s.endAt)}${isNum(s.rpe) ? ' · RPE ' + s.rpe : ''}</div>
    <div class="grid four tr-metrics">
      <${Metric} label="Duration" value=${st.durationMin != null ? fmtDur(st.durationMin) : '—'} />
      <${Metric} label="Working sets" value=${fmtNum(st.workingSets)} sub=${pst ? signed(st.workingSets - pst.workingSets) + ' vs last' : null} />
      <${Metric} label="Volume" value=${fmtLb(st.volumeLb, false)} unit="lb" sub=${pst && pct(st.volumeLb, pst.volumeLb) ? pct(st.volumeLb, pst.volumeLb) + ' vs last' : null} />
      <${Metric} label=${st.cardioCount ? 'Cardio' : 'Exercises'} value=${st.cardioCount ? fmtNum(st.cardioMin) : fmtNum(st.exercises)} unit=${st.cardioCount ? 'min' : ''} />
    </div>
    ${prev ? html`<div class="xs muted">Compared with ${prev.name || 'the previous session'} on ${fmtDate(prev.date)}.</div>` : null}
    <div class="stack xs"><span class="eyebrow">Records</span>
      ${prsList.length || extra.length ? html`<div class="card flush"><${List}>
        ${prsList.map((r) => html`<${ListRow} title=${exName(ex.get(r.exerciseId), r.exerciseId)} meta=${recordText(r)} trail=${html`<${Pill} tone="accent">PR</${Pill}>`} />`)}
        ${extra.map((r) => html`<${ListRow} title=${exName(ex.get(r.exerciseId), r.exerciseId)} meta=${recordText(r)} trail=${html`<${Pill}>Rep best</${Pill}>`} />`)}
      </${List}></div>` : html`<div class="small muted">No PRs this session${st.workingSets ? ' — records compare each lift with all earlier sessions.' : '.'}</div>`}
    </div>
    <div class="stack xs"><span class="eyebrow">WHOOP</span>
      ${w ? html`<div class="grid four tr-metrics">
          <${Metric} label="Strain" value=${isNum(w.strain) ? fmtNum(w.strain, 1) : '—'} />
          <${Metric} label="Avg HR" value=${isNum(w.avgHr) ? fmtNum(w.avgHr) : '—'} unit="bpm" />
          <${Metric} label="Max HR" value=${isNum(w.maxHr) ? fmtNum(w.maxHr) : '—'} unit="bpm" />
          <${Metric} label="Energy" value=${isNum(w.kcal) ? fmtNum(w.kcal) : '—'} unit="kcal" />
        </div>`
        : whoopOn ? html`<div class="small muted">No WHOOP workout overlaps this session yet. It links automatically once WHOOP syncs (or from Details).</div>`
          : html`<div class="small muted">Connect WHOOP in Settings → Integrations to add strain and heart rate to sessions.</div>`}
    </div>
    <${SheetFoot}><${Button} onClick=${() => close('keep')}>View session</${Button}><${Button} variant="primary" onClick=${() => close('done')}>Done</${Button}></${SheetFoot}>
  </div>`;
}
const fmtClock = (dv, iso) => { const hm = hmOf(dv, iso); if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM'); };
/** '5:10–6:19 PM', '11:40 PM–12:35 AM', or '5:10 PM' while open. */
function timeRange(dv, a, b) {
  const x = fmtClock(dv, a); if (!b) return x;
  const y = fmtClock(dv, b);
  return x.slice(-2) === y.slice(-2) ? x.slice(0, -3) + '–' + y : x + '–' + y;
}
export { fmtClock, timeRange };

/* ======================================================= session details */
function SessionDetails({ close, id }) {
  const app = useApp(); useVersion(['sessions', 'whoopWorkouts']);
  const s = app.store.get('sessions', id);
  const today = app.today();
  const [f, setF] = useState(() => (s ? { name: s.name || '', date: s.date, start: hmOf(app.dv, s.startAt), end: s.endAt ? hmOf(app.dv, s.endAt) : '', rpe: s.rpe ?? null, note: s.note || '', whoop: s.whoopWorkoutId || '' } : null));
  const [err, setErr] = useState('');
  if (!s || !f) return html`<div class="stack"><${SheetHead} title="Session" onClose=${() => close()} /><${Empty} title="Session not found">It may have been deleted.</${Empty}></div>`;
  const set = (p) => { setF((x) => ({ ...x, ...p })); setErr(''); };
  const workouts = [...app.dv.workouts(f.date), ...app.dv.workouts(addDays(f.date, 1))];
  const suggestion = !s.whoopWorkoutId && s.endAt ? findWorkoutFor(app, s) : null;
  const save = () => {
    if (!f.date || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return setErr('Pick a date.');
    if (!f.start) return setErr('Set a start time.');
    const startAt = instantAt(app.dv, f.date, f.start);
    const endAt = f.end ? instantAt(app.dv, f.date, f.end, startAt) : null;
    if (s.endAt && !f.end) return setErr('Set an end time (or use Resume to reopen the session).');
    if (endAt && Date.parse(endAt) - Date.parse(startAt) > 16 * 3600000) return setErr('The end time must be after the start.');
    const patch = {};
    const nm = f.name.trim() || 'Workout';
    if (nm !== (s.name || '')) patch.name = nm;
    if (f.date !== s.date) patch.date = f.date;
    const startChanged = f.date !== s.date || f.start !== hmOf(app.dv, s.startAt);
    if (startChanged) patch.startAt = startAt;
    if (endAt && (startChanged || f.end !== hmOf(app.dv, s.endAt))) patch.endAt = endAt;
    if ((f.rpe ?? null) !== (s.rpe ?? null)) patch.rpe = f.rpe;
    if (f.note.trim() !== (s.note || '')) patch.note = f.note.trim();
    if ((f.whoop || null) !== (s.whoopWorkoutId || null)) patch.whoopWorkoutId = f.whoop || false; // false = keep unlinked
    if (Object.keys(patch).length) { app.store.update('sessions', id, patch); app.toast('Session updated'); }
    close('saved');
  };
  const resume = () => { app.store.update('sessions', id, { endAt: null }); app.toast('Session reopened'); close('resumed'); };
  const del = async () => {
    const ok = await app.confirm({ title: 'Delete this session?', message: `${s.name || 'Workout'} on ${fmtDate(s.date)} and all its sets.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    removeWithUndo(app, 'sessions', id, 'Session');
    close('deleted');
  };
  const wLabel = (w) => `${fmtClock(app.dv, w.start)}–${fmtClock(app.dv, w.end)} · ${w.sport || 'Workout'}${isNum(w.strain) ? ' · strain ' + fmtNum(w.strain, 1) : ''}`;
  return html`<div class="stack">
    <${SheetHead} title="Session details" onClose=${() => close()} />
    <${Field} label="Name"><${Input} value=${f.name} onValue=${(v) => set({ name: v })} placeholder="Workout" /></${Field}>
    <div class="grid three tr-detail-times">
      <${Field} label="Date"><input class="input mono" type="date" value=${f.date} max=${today} onInput=${(e) => set({ date: e.currentTarget.value })} /></${Field}>
      <${Field} label="Start"><input class="input mono" type="time" value=${f.start} onInput=${(e) => set({ start: e.currentTarget.value })} /></${Field}>
      <${Field} label="End"><input class="input mono" type="time" value=${f.end} disabled=${!s.endAt} onInput=${(e) => set({ end: e.currentTarget.value })} /></${Field}>
    </div>
    ${!s.endAt ? html`<div class="xs muted">In progress — the end time is set when you finish.</div>` : null}
    <${Field} label="Session RPE (1–10)"><div class="input-group" style="max-width:180px"><${NumCell} class="input mono" value=${f.rpe} onValue=${(v) => set({ rpe: v == null ? null : Math.min(10, Math.max(1, Math.round(v))) })} label="Session RPE" /><span class="suffix">/10</span></div></${Field}>
    <${Field} label="Note"><${Textarea} rows="3" value=${f.note} onValue=${(v) => set({ note: v })} /></${Field}>
    <${Field} label="WHOOP workout" hint=${workouts.length ? (suggestion && !f.whoop ? 'One overlaps this session — select it to link strain and heart rate.' : '') : 'No WHOOP workouts on this date.'}>
      <${Select} value=${f.whoop} onValue=${(v) => set({ whoop: v })} disabled=${!workouts.length && !f.whoop}
        options=${[{ value: '', label: 'Not linked' }, ...workouts.map((w) => ({ value: w.id, label: wLabel(w) + (suggestion && suggestion.id === w.id ? ' (overlaps)' : '') })), ...(f.whoop && !workouts.some((w) => w.id === f.whoop) ? [{ value: f.whoop, label: 'Linked workout' }] : [])]} />
    </${Field}>
    ${err ? html`<div class="xs ink-bad">${err}</div>` : null}
    <div class="row wrap" style="gap:8px">
      ${s.endAt && s.date >= addDays(today, -1) ? html`<${Button} size="sm" icon="play" onClick=${resume}>Resume session</${Button}>` : null}
      <${Button} size="sm" variant="danger" icon="trash" onClick=${del}>Delete session</${Button}>
    </div>
    <${SheetFoot}><${Button} onClick=${() => close()}>Cancel</${Button}><${Button} variant="primary" onClick=${save}>Save</${Button}></${SheetFoot}>
  </div>`;
}

/* =================================================== session creation flow */
/** Create a session from a start choice; returns the id. Used by startWorkout. */
export function createFromChoice(app, choice, date) {
  const d = date || app.today();
  const last = lastPerfFn(app.dv, d, { beforeAt: new Date().toISOString() }); // includes an earlier session today
  if (choice.kind === 'template') {
    const tpl = app.store.get('templates', choice.id);
    if (!tpl) return null;
    return createSession(app, { date: d, name: tpl.name, templateId: tpl.id, entries: entriesFromTemplate(tpl, last, newEntryId) });
  }
  if (choice.kind === 'repeat') {
    const src = app.store.get('sessions', choice.id);
    if (!src) return null;
    const cardio = (src.cardio || []).filter((c) => c && c.exerciseId).map((c) => ({ id: 'c' + uid(8), exerciseId: c.exerciseId, durationMin: null, distanceMi: null, avgWatts: null, avgHr: null, maxHr: null, kcal: null, rpe: null }));
    return createSession(app, { date: d, name: src.name, templateId: src.templateId || null, entries: entriesFromSession(src, last, newEntryId), cardio });
  }
  return createSession(app, { date: d, name: 'Workout', startAt: startInstant(app, d) });
}
