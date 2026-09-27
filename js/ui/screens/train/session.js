// #/train/session/<id> — the logger. One-handed, between sets: big targets, pre-filled values, one tap to
// complete a set (e1RM + PR flag + rest timer). Edits debounce (400 ms) and flush on unmount/hide.
import { html, useState, useRef, useEffect, useCallback, useMemo } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useWide } from '../../ctx.js';
import { Page, Button, IconButton, Icon, Empty, Textarea, List, ListRow, SheetHead, cx } from '../../kit.js';
import { lastPerformance } from '../../../analytics/index.js';
import { fmtDate, fmtNum, fmtDur, isNum, round, uid, relDay } from '../../../core/util.js';
import {
  e1rm, isWorkingSet, normKind, nextKind, kindLabel, setLabels, setText, setsLine, fmtW, fmtLb, bump, clampRpe, sessionStats,
  priorBests, recordFlags, sessionRecords, isPr, copySet, placeholderFor, completeSet, moveItem,
} from '../../parts/train-logic.js';
import { linkedWorkout, findWorkoutFor, autoLinkWorkout } from '../../parts/train-data.js';
import { pickExercise, finishSession, sessionDetails, editTemplate, timeRange, CARDIO_FIELDS, recordText } from '../../parts/train-sheets.js';
import { removeWithUndo } from '../../parts/common.js';
import { NumCell, startRest, Elapsed, exName, exMeta, Metric } from '../../parts/train-ui.js';

/* ------------------------------------------------------------ draft */
// Pending field values not yet written; the store stays the source of truth for everything else.
function useDraft(app, id) {
  const pending = useRef({}); const timer = useRef(null); const [, force] = useState(0);
  const flush = useCallback(() => {
    clearTimeout(timer.current); timer.current = null;
    const p = pending.current; if (!Object.keys(p).length) return;
    pending.current = {};
    if (app.store.get('sessions', id)) app.store.update('sessions', id, p);
  }, [id]);
  const get = (field, rec) => (field in pending.current ? pending.current[field] : rec ? rec[field] : undefined);
  const set = (field, next, now) => {
    const cur = get(field, app.store.get('sessions', id));
    const value = typeof next === 'function' ? next(cur) : next;
    pending.current = { ...pending.current, [field]: value };
    if (now) flush();
    else { clearTimeout(timer.current); timer.current = setTimeout(flush, 400); force((n) => n + 1); }
    return value;
  };
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide); window.addEventListener('pagehide', flush);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);
  return { get, set, flush };
}

/** Session name as the page title; tap to rename inline (Enter/blur saves, Escape cancels). */
function TitleEdit({ name, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  if (!editing) return html`<button type="button" class="tr-title" title="Rename" onClick=${() => { setVal(name); setEditing(true); }}>${name}</button>`;
  const done = (save) => { setEditing(false); const v = val.trim(); if (save && v && v !== name) onSave(v); };
  return html`<input class="tr-title-input" value=${val} aria-label="Session name" autofocus maxLength="60"
    ref=${(el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
    onInput=${(e) => setVal(e.currentTarget.value)} onBlur=${() => done(true)}
    onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setVal(name); setEditing(false); } }} />`;
}

/** First not-done set at/after (entryIndex, setIndex), scanning later entries too. */
function nextOpenSet(entries, fromEntry = 0, fromSet = -1) {
  for (let i = fromEntry; i < entries.length; i++) {
    const sets = entries[i].sets || [];
    for (let j = i === fromEntry ? fromSet + 1 : 0; j < sets.length; j++) if (sets[j] && sets[j].done === false) return { entryId: entries[i].id, idx: j };
  }
  return null;
}

export default function SessionView({ id }) {
  const app = useApp(); useVersion(['sessions', 'exercises', 'whoopWorkouts']);
  const wide = useWide();
  const draft = useDraft(app, id);
  const [focus, setFocus] = useState(null);
  const [lastDone, setLastDone] = useState(null);
  const [notes, setNotes] = useState(() => new Set());
  const rec = app.store.get('sessions', id);
  const entries = (rec && draft.get('entries', rec)) || [];
  const cardio = (rec && draft.get('cardio', rec)) || [];
  const idsKey = [...new Set(entries.map((e) => e.exerciseId))].join('|');
  const bests = useMemo(() => {
    if (!rec) return new Map();
    const all = app.dv.allSessions();
    return new Map(idsKey.split('|').filter(Boolean).map((x) => [x, priorBests(all, x, rec)]));
  }, [app.store.version, idsKey, rec && rec.date, rec && rec.startAt]);
  const lasts = useMemo(() => new Map(idsKey.split('|').filter(Boolean).map((x) => [x, rec ? lastPerformance(app.dv, x, rec.date, { beforeAt: rec.startAt, excludeSessionId: rec.id }) : null])), [app.store.version, idsKey, rec && rec.date]);
  const whoopN = app.store.all('whoopWorkouts').length;
  useEffect(() => { if (rec && rec.endAt && rec.whoopWorkoutId == null) autoLinkWorkout(app, id); }, [whoopN, rec && rec.endAt]);

  if (!rec) {
    return html`<${Page} title="Session" back="/train"><${Empty} title="Session not found" action=${html`<${Button} onClick=${() => app.nav('/train')}>Back to Train</${Button}>`}>
      It may have been deleted (Undo appears for a few seconds after a delete) or not synced to this device yet.</${Empty}></${Page}>`;
  }
  const exMap = app.dv.exercises();
  const open = !rec.endAt;
  const view = { ...rec, entries, cardio };
  const st = sessionStats(view);
  const flags = new Map();
  for (const x of idsKey.split('|').filter(Boolean)) for (const [k, v] of recordFlags(entries, x, bests.get(x))) flags.set(k, v);
  const prCount = sessionRecords(view, bests).filter(isPr).length;
  const active = focus && entries.some((e) => e.id === focus.entryId && e.sets && e.sets[focus.idx]) ? focus : open ? nextOpenSet(entries) : null;
  const w = linkedWorkout(app, rec);

  /* ------------------------------------------------------ writes */
  const setEntries = (fn, now) => draft.set('entries', fn, now);
  const mapSet = (entryId, idx, fn) => (list) => list.map((e) => (e.id !== entryId ? e : { ...e, sets: (e.sets || []).map((s, i) => (i === idx ? fn(s) : s)) }));
  const patchSet = (entryId, idx, patch, now) => setEntries(mapSet(entryId, idx, (s) => ({ ...s, ...patch })), now);
  const bw = (exId) => !!(exMap.get(exId) || {}).bodyweight;
  const suggest = (entry, idx) => placeholderFor(entry.sets, idx, (lasts.get(entry.exerciseId) || {}).sets);
  const nameOf = (exId) => exName(exMap.get(exId), exId);

  const toggleDone = (entry, idx) => {
    const s = entry.sets[idx];
    if (s.done !== false) { patchSet(entry.id, idx, { done: false }, true); setFocus({ entryId: entry.id, idx }); return; }
    const r = completeSet(s, suggest(entry, idx), bw(entry.exerciseId));
    if (r.error) { app.toast(r.error === 'reps' ? 'Enter the reps first.' : 'Enter the weight first.'); setFocus({ entryId: entry.id, idx }); return; }
    const next = setEntries(mapSet(entry.id, idx, () => r.set), true);
    const recs = ((recordFlags(next, entry.exerciseId, bests.get(entry.exerciseId)).get(entry.id) || [])[idx] || []).filter(isPr);
    if (recs.length) app.toast(`PR · ${nameOf(entry.exerciseId)}: ${recordText(recs[0])}`);
    if (open) startRest(nameOf(entry.exerciseId));
    const ei = next.findIndex((e) => e.id === entry.id);
    setFocus(nextOpenSet(next, ei, idx));
    setLastDone({ entryId: entry.id, idx });
  };
  const addSet = (entry) => {
    const sets = entry.sets || [];
    const ns = copySet(sets[sets.length - 1], suggest(entry, sets.length));
    setEntries((list) => list.map((e) => (e.id === entry.id ? { ...e, sets: [...(e.sets || []), ns] } : e)), true);
    setFocus({ entryId: entry.id, idx: sets.length });
  };
  const removeSet = (entry, idx) => {
    const removed = entry.sets[idx];
    setEntries((list) => list.map((e) => (e.id === entry.id ? { ...e, sets: e.sets.filter((_, i) => i !== idx) } : e)), true);
    setFocus(null);
    app.toast(`Set removed from ${nameOf(entry.exerciseId)}`, { action: { label: 'Undo', onClick: () => draft.set('entries', (list) => list.map((e) => (e.id === entry.id ? { ...e, sets: [...e.sets.slice(0, idx), removed, ...e.sets.slice(idx)] } : e)), true) } });
  };
  const removeEntry = (entry) => {
    const at = entries.findIndex((e) => e.id === entry.id);
    setEntries((list) => list.filter((e) => e.id !== entry.id), true);
    app.toast(`${nameOf(entry.exerciseId)} removed`, { action: { label: 'Undo', onClick: () => draft.set('entries', (list) => (list.some((e) => e.id === entry.id) ? list : [...list.slice(0, at), entry, ...list.slice(at)]), true) } });
  };
  const addExercise = async () => {
    draft.flush();
    const exId = await pickExercise(app);
    if (!exId) return;
    const last = lastPerformance(app.dv, exId, rec.date, { beforeAt: rec.startAt, excludeSessionId: rec.id });
    const sets = last && last.sets.length ? last.sets.map((s) => ({ w: isNum(s.w) ? s.w : null, reps: isNum(s.reps) ? s.reps : null, rpe: null, kind: normKind(s.kind), done: false })) : [copySet(null)];
    const entry = { id: 'e' + uid(8), exerciseId: exId, sets };
    setEntries((list) => [...list, entry], true);
    setFocus({ entryId: entry.id, idx: 0 });
  };
  const entryAction = async (entry, action) => {
    const i = entries.findIndex((e) => e.id === entry.id);
    if (action === 'up' || action === 'down') setEntries((list) => moveItem(list, list.findIndex((e) => e.id === entry.id), action === 'up' ? -1 : 1), true);
    else if (action === 'note') setNotes((s) => new Set([...s, entry.id]));
    else if (action === 'history') app.nav('/train/exercise/' + entry.exerciseId);
    else if (action === 'remove') removeEntry(entry);
    else if (action === 'replace') {
      const exId = await pickExercise(app, { title: 'Replace ' + nameOf(entry.exerciseId) });
      if (exId && exId !== entry.exerciseId) setEntries((list) => list.map((e) => (e.id === entry.id ? { ...e, exerciseId: exId } : e)), true);
    } else if (action === 'menu') {
      const a = await app.sheet(({ close }) => html`<${EntryMenu} close=${close} name=${nameOf(entry.exerciseId)} canUp=${i > 0} canDown=${i < entries.length - 1} hasNote=${!!entry.note} />`);
      if (a) entryAction(entry, a);
    }
  };
  const setCardio = (fn, now) => draft.set('cardio', fn, now);
  const addCardio = async () => {
    draft.flush();
    const exId = await pickExercise(app, { type: 'cardio', title: 'Add cardio' });
    if (!exId) return;
    setCardio((list) => [...(list || []), { id: 'c' + uid(8), exerciseId: exId, durationMin: null, distanceMi: null, avgWatts: null, avgHr: null, maxHr: null, kcal: null, rpe: null }], true);
  };
  const removeCardio = (c) => {
    const at = cardio.findIndex((x) => x.id === c.id);
    setCardio((list) => list.filter((x) => x.id !== c.id), true);
    app.toast(`${nameOf(c.exerciseId)} removed`, { action: { label: 'Undo', onClick: () => draft.set('cardio', (list) => [...list.slice(0, at), c, ...list.slice(at)], true) } });
  };
  const finish = async () => { draft.flush(); const r = await finishSession(app, id); if (r === 'done') app.nav('/train'); };
  const summary = async () => { draft.flush(); const r = await finishSession(app, id, { summary: true }); if (r === 'done') app.nav('/train'); };
  const details = async () => { draft.flush(); const r = await sessionDetails(app, id); if (r === 'deleted') app.nav('/train'); };
  const saveTemplate = async () => { draft.flush(); await editTemplate(app, { fromSession: id }); };
  const linkNow = () => { const lw = autoLinkWorkout(app, id, { force: true }); app.toast(lw ? 'Linked to the WHOOP workout' : 'No overlapping WHOOP workout found'); };
  const suggestion = !open && !w && rec.whoopWorkoutId !== false ? findWorkoutFor(app, rec) : null;
  const discard = () => { draft.flush(); removeWithUndo(app, 'sessions', id, 'Session'); app.nav('/train'); };

  /* ------------------------------------------------------ render */
  const today = app.today();
  const stale = open && Date.now() - Date.parse(rec.startAt) > 16 * 3600000;
  const sub = html`${relDay(rec.date, today)} · ${timeRange(app.dv, rec.startAt, rec.endAt)}${isNum(rec.rpe) ? ' · RPE\u00a0' + rec.rpe : ''}`;
  const headActions = html`<${IconButton} icon="edit" label="Session details" onClick=${details} />
    ${open ? html`<${Button} variant="primary" size="sm" icon="check" onClick=${finish}>Finish</${Button}>` : html`<${Button} size="sm" onClick=${summary}>Summary</${Button}>`}`;
  const metrics = html`<div class="tr-strip">
    <${Metric} label=${open ? 'Elapsed' : 'Duration'} value=${open ? (stale ? 'Not finished' : html`<${Elapsed} startAt=${rec.startAt} />`) : st.durationMin != null ? fmtDur(st.durationMin) : '—'} sub=${open && stale ? 'Set the end time in Finish' : null} />
    <${Metric} label="Working sets" value=${fmtNum(st.workingSets)} sub=${st.pendingSets ? `${st.pendingSets} to go` : null} />
    <${Metric} label="Volume" value=${fmtLb(st.volumeLb, false)} unit="lb" />
    <${Metric} label="PRs" value=${fmtNum(prCount)} tone=${prCount ? 'good' : null} />
  </div>`;
  const controls = html`<div class="row" style="gap:8px;margin-top:10px">
    <${Button} size="sm" variant="ghost" icon="edit" onClick=${details}>Details</${Button}>
    <span class="grow"></span>
    ${open ? html`<${Button} size="sm" variant="primary" icon="check" onClick=${finish}>Finish</${Button}>` : html`<${Button} size="sm" onClick=${summary}>Summary</${Button}>`}
  </div>`;
  const whoopLine = w ? html`<div class="tr-whoop"><${Icon} name="activity" size=${16} /><span class="grow">WHOOP · strain <b class="mono">${isNum(w.strain) ? fmtNum(w.strain, 1) : '—'}</b> · avg HR <b class="mono">${isNum(w.avgHr) ? fmtNum(w.avgHr) : '—'}</b> · max <b class="mono">${isNum(w.maxHr) ? fmtNum(w.maxHr) : '—'}</b>${isNum(w.kcal) ? html` · <b class="mono">${fmtNum(w.kcal)}</b> kcal` : null}</span></div>`
    : suggestion ? html`<div class="tr-whoop"><${Icon} name="activity" size=${16} /><span class="grow">A WHOOP workout overlaps this session.</span><${Button} size="sm" onClick=${linkNow}>Link</${Button}></div>` : null;
  const blocks = entries.map((e, i) => html`<${EntryBlock} key=${e.id} entry=${e} ex=${exMap.get(e.exerciseId)} last=${lasts.get(e.exerciseId)}
    flags=${flags.get(e.id) || []} activeIdx=${active && active.entryId === e.id ? active.idx : -1} noteOpen=${notes.has(e.id)}
    justDone=${lastDone && lastDone.entryId === e.id ? lastDone.idx : -1}
    onFocusSet=${(idx) => setFocus({ entryId: e.id, idx })}
    onDone=${(idx) => toggleDone(e, idx)} onKind=${(idx) => { patchSet(e.id, idx, { kind: nextKind(e.sets[idx].kind) }, true); setFocus({ entryId: e.id, idx }); }}
    onW=${(idx, v) => patchSet(e.id, idx, { w: v })} onReps=${(idx, v) => patchSet(e.id, idx, { reps: v })} onRpe=${(idx, v) => patchSet(e.id, idx, { rpe: clampRpe(v) })}
    onBumpW=${(idx, d) => setEntries(mapSet(e.id, idx, (s) => ({ ...s, w: bump(isNum(s.w) ? s.w : suggest(e, idx).w, d) })))}
    onBumpR=${(idx, d) => setEntries(mapSet(e.id, idx, (s) => ({ ...s, reps: bump(isNum(s.reps) ? s.reps : suggest(e, idx).reps, d) })))}
    onRemoveSet=${(idx) => removeSet(e, idx)} onAddSet=${() => addSet(e)} onNote=${(t) => setEntries((list) => list.map((x) => (x.id === e.id ? { ...x, note: t } : x)))}
    onAction=${(a) => entryAction(e, a)} suggest=${(idx) => suggest(e, idx)} />`);
  const cardioBlocks = cardio.map((c) => html`<${CardioBlock} key=${c.id} c=${c} ex=${exMap.get(c.exerciseId)}
    onChange=${(patch) => setCardio((list) => list.map((x) => (x.id === c.id ? { ...x, ...patch } : x)))} onRemove=${() => removeCardio(c)} />`);
  const empty = !entries.length && !cardio.length;
  const addRow = html`<div class="tr-add-row"><${Button} icon="plus" onClick=${addExercise}>Add exercise</${Button}><${Button} icon="bike" onClick=${addCardio}>Add cardio</${Button}></div>`;
  const hint = html`<div class="xs muted tr-hint">Tap a set number to switch kind: W warm-up (never counted), D drop set, F to failure (both count as hard sets). Only sets marked done count.</div>`;
  const main = html`<div class="stack">
    ${empty ? html`<${Empty} title="No exercises yet" action=${html`<${Button} size="sm" variant="ghost" icon="trash" onClick=${discard}>Discard session</${Button}>`}>Add the first exercise; its sets pre-fill from your last session. Starting from a template fills the whole workout.</${Empty}>` : null}
    ${blocks}${cardioBlocks}${addRow}
    ${open && !wide && !empty ? html`<${Button} variant="primary" size="lg" block icon="check" onClick=${finish}>Finish workout</${Button}>` : null}
    ${!wide && entries.length ? html`<div class="row wrap" style="gap:8px"><${Button} size="sm" variant="ghost" icon="layers" onClick=${saveTemplate}>Save as template</${Button}></div>` : null}
    ${!wide && entries.length ? hint : null}
  </div>`;
  const title = html`<${TitleEdit} name=${rec.name || 'Workout'} onSave=${(v) => { app.store.update('sessions', id, { name: v }); app.toast('Renamed to ' + v); }} />`;
  return html`<${Page} title=${title} sub=${sub} back="/train" wide actions=${wide ? headActions : null}>
    ${wide ? html`<div class="tr-session">
        <div>${main}</div>
        <aside class="tr-side stack">
          <div class="card stack">${metrics}${whoopLine}
            ${open ? html`<${Button} variant="primary" size="lg" block icon="check" onClick=${finish}>Finish workout</${Button}>` : html`<${Button} block onClick=${summary}>Session summary</${Button}>`}
            <div class="row wrap" style="gap:8px"><${Button} size="sm" variant="ghost" icon="edit" onClick=${details}>Details</${Button}>
              ${entries.length ? html`<${Button} size="sm" variant="ghost" icon="layers" onClick=${saveTemplate}>Save as template</${Button}>` : null}</div>
          </div>
          ${rec.note ? html`<div class="card tight small"><div class="eyebrow" style="margin-bottom:4px">Note</div><div class="dim" style="white-space:pre-wrap">${rec.note}</div></div>` : null}
          ${entries.length ? hint : null}
        </aside>
      </div>`
      : html`<div class="card tight">${metrics}${whoopLine ? html`<div style="margin-top:10px">${whoopLine}</div>` : null}${controls}</div>
        ${rec.note ? html`<div class="card tight small"><span class="eyebrow">Note</span><div class="dim" style="white-space:pre-wrap;margin-top:4px">${rec.note}</div></div>` : null}
        ${main}`}
  </${Page}>`;
}

/* ------------------------------------------------------------ exercise block */
function EntryBlock({ entry, ex, last, flags, activeIdx, justDone, noteOpen, onFocusSet, onDone, onKind, onW, onReps, onRpe, onBumpW, onBumpR, onRemoveSet, onAddSet, onNote, onAction, suggest }) {
  const bwx = !!(ex && ex.bodyweight);
  const sets = entry.sets || [];
  const labels = setLabels(sets);
  const t = entry.target;
  const lastSets = last && last.sets ? last.sets : null;
  const lastLine = lastSets && lastSets.length ? `Last · ${fmtDate(last.date, { dow: false })}: ${setsLine(lastSets, bwx)}` : 'No earlier sessions — this one sets the baseline';
  const work = sets.filter((x) => x && isWorkingSet(x));
  const bestE = bwx ? null : work.reduce((b, x) => { const v = e1rm(x.w, x.reps); return v != null && (b == null || v > b) ? v : b; }, null);
  const vol = work.reduce((a, x) => a + (isNum(x.w) ? x.w : 0) * (isNum(x.reps) ? x.reps : 0), 0);
  const reps = work.reduce((a, x) => a + (isNum(x.reps) ? x.reps : 0), 0);
  const logged = work.length ? [`${work.length} working set${work.length === 1 ? '' : 's'}`, bwx ? `${reps} reps` : vol ? fmtLb(vol) : null, bestE != null ? 'best e1RM ' + fmtLb(bestE) : null]
    .filter(Boolean).map((x) => x.replace(/ (?=\S+$)/, '\u00a0')).join(' · ') : null;
  return html`<div class="card tr-block">
    <div class="tr-block-head">
      <button type="button" class="tr-block-title" onClick=${() => onAction('history')} title="History and records">
        <div class="strong ellipsis">${exName(ex, entry.exerciseId)}</div>
        <div class="xs muted ellipsis">${exMeta(ex)}${t ? ` · target ${t.sets} × ${t.reps ?? '—'}${isNum(t.rpe) ? ' @ RPE ' + t.rpe : ''}` : ''}</div>
      </button>
      <${IconButton} icon="dots" label="Exercise options" onClick=${() => onAction('menu')} />
    </div>
    <div class="tr-last"><span class="mono">${lastLine}</span>${logged ? html`<br /><span class="tr-today">Logged: ${logged}</span>` : null}</div>
    <div class="tr-sets" role="group" aria-label=${exName(ex, entry.exerciseId) + ' sets'}>
      <div class="tr-set tr-set-h" aria-hidden="true"><span>Set</span><span class="hide-sm">Last</span><span>${bwx ? '+lb' : 'lb'}</span><span>Reps</span><span>RPE</span><span class="hide-sm right">e1RM</span><span class="center">Done</span></div>
      ${sets.map((s, i) => {
        if (!s) return null;
        const done = s.done !== false; const kind = normKind(s.kind);
        const sg = suggest(i);
        const recs = flags[i] || []; const pr = recs.filter(isPr); const rb = recs.find((r) => r.type === 'repBest');
        const est = done && isWorkingSet(s) && !bwx ? e1rm(s.w, s.reps) : null;
        const caption = done && (pr.length || rb || (justDone === i && est != null));
        const n = labels[i]; const lbl = `Set ${n}`;
        const focusMe = () => onFocusSet(i);
        return html`<div key=${i} class=${cx('tr-set', done && 'done', activeIdx === i && 'active', kind !== 'work' && 'k-' + kind)}>
          <button type="button" class="tr-kind" onClick=${() => onKind(i)} aria-label=${`${lbl}: ${kindLabel(kind)}. Tap to change`} title=${kindLabel(kind)}>${n}</button>
          <span class="tr-prev hide-sm mono">${lastSets && lastSets[i] ? setText(lastSets[i], bwx) : '—'}</span>
          <${NumCell} class="tr-w" value=${s.w} onValue=${(v) => onW(i, v)} onFocus=${focusMe} label=${`${lbl} weight, pounds`} placeholder=${bwx ? (isNum(sg.w) && sg.w > 0 ? fmtW(sg.w) : 'BW') : fmtW(sg.w)} />
          <${NumCell} class="tr-r" value=${s.reps} mode="numeric" onValue=${(v) => onReps(i, v)} onFocus=${focusMe} label=${`${lbl} reps`} placeholder=${fmtW(sg.reps)} />
          <${NumCell} class="tr-rpe" value=${s.rpe} onValue=${(v) => onRpe(i, v)} onFocus=${focusMe} label=${`${lbl} RPE`} placeholder=${t && isNum(t.rpe) ? fmtW(t.rpe) : ''} />
          <span class="tr-e1 hide-sm mono">${est != null ? fmtLb(est, false) : ''}</span>
          <button type="button" class="tr-done" role="checkbox" aria-checked=${String(done)} aria-label=${`${lbl} done`} onClick=${() => onDone(i)}><${Icon} name="check" /></button>
        </div>
        ${caption ? html`<div class=${cx('tr-set-meta', !pr.length && !rb && 'only-sm')} key=${'m' + i}>
          ${est != null ? html`<span class="mono only-sm">e1RM ${fmtLb(est)}</span>` : null}
          ${pr.length ? html`<span class="tr-pr" title=${pr.map(recordText).join('; ')}>PR</span><span class="xs dim ellipsis">${pr.map((r) => (r.type === 'e1rm' ? 'e1RM' : r.type === 'weight' ? 'heaviest' : 'reps')).join(' + ')}, prev ${r0(pr[0])}</span>`
            : rb ? html`<span class="tr-rb" title=${recordText(rb)}>Rep best</span><span class="xs dim">prev ${fmtLb(rb.prev, false)} for ${rb.reps}+</span>` : null}
        </div>` : null}
        ${activeIdx === i ? html`<div class="tr-adj" key=${'a' + i}>
          <span class="tr-adj-g"><button type="button" onClick=${() => onBumpW(i, -5)} aria-label="Weight minus 5">−5</button><span>${bwx ? '+lb' : 'lb'}</span><button type="button" onClick=${() => onBumpW(i, 5)} aria-label="Weight plus 5">+5</button></span>
          <span class="tr-adj-g"><button type="button" onClick=${() => onBumpR(i, -1)} aria-label="Reps minus 1">−1</button><span>reps</span><button type="button" onClick=${() => onBumpR(i, 1)} aria-label="Reps plus 1">+1</button></span>
          <${IconButton} icon="trash" label=${`Remove ${lbl.toLowerCase()}`} onClick=${() => onRemoveSet(i)} />
        </div>` : null}`;
      })}
    </div>
    ${noteOpen || entry.note ? html`<${Textarea} class="tr-note" rows="2" value=${entry.note || ''} onValue=${onNote} placeholder="Note for this exercise (setup, pain, cues)" />` : null}
    <div class="row" style="gap:8px">
      <${Button} size="sm" icon="plus" onClick=${onAddSet}>Add set</${Button}>
      ${!noteOpen && !entry.note ? html`<${Button} size="sm" variant="ghost" onClick=${() => onAction('note')}>Note</${Button}>` : null}
    </div>
  </div>`;
}
const r0 = (r) => (r.type === 'reps' ? `${r.prev} reps` : fmtLb(r.prev));

/* ------------------------------------------------------------ cardio block */
function CardioBlock({ c, ex, onChange, onRemove }) {
  const eff = isNum(c.avgWatts) && isNum(c.avgHr) && c.avgHr > 0 ? round(c.avgWatts / c.avgHr, 2) : null;
  return html`<div class="card tr-block">
    <div class="tr-block-head">
      <div class="tr-block-title" style="cursor:default"><div class="strong ellipsis"><${Icon} name="bike" size=${15} /> ${exName(ex, c.exerciseId)}</div><div class="xs muted">Cardio${eff != null ? ` · ${fmtNum(eff, 2)} W per bpm` : ''}</div></div>
      <${IconButton} icon="x" label="Remove cardio entry" onClick=${onRemove} />
    </div>
    <div class="grid three tr-cardio-grid">
      ${[...CARDIO_FIELDS, ['rpe', 'RPE', '/10', 'decimal']].map(([k, label, unit, mode]) => html`<label class="field"><span class="label-text">${label}</span>
        <div class="input-group"><${NumCell} class="input mono" value=${c[k]} mode=${mode} label=${label} onValue=${(v) => onChange({ [k]: k === 'rpe' ? clampRpe(v) : v })} /><span class="suffix">${unit}</span></div></label>`)}
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- menu */
function EntryMenu({ close, name, canUp, canDown, hasNote }) {
  return html`<div class="stack">
    <${SheetHead} title=${name} onClose=${() => close()} />
    <div class="card flush"><${List}>
      ${canUp ? html`<${ListRow} lead="chevronUp" title="Move up" onClick=${() => close('up')} />` : null}
      ${canDown ? html`<${ListRow} lead="chevronDown" title="Move down" onClick=${() => close('down')} />` : null}
      <${ListRow} lead="edit" title=${hasNote ? 'Edit note' : 'Add note'} onClick=${() => close('note')} />
      <${ListRow} lead="repeat" title="Replace exercise" meta="Keeps the sets you logged" onClick=${() => close('replace')} />
      <${ListRow} lead="insights" title="History and records" onClick=${() => close('history')} />
      <${ListRow} lead="trash" title="Remove from session" meta="Undo is available for a few seconds" onClick=${() => close('remove')} />
    </${List}></div>
  </div>`;
}
