// Today → snapshot cards: nutrition, training, body, check-in (with timing vs targets), journal,
// and the protocol items due on a future date.
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useSetting } from '../../ctx.js';
import { Card, Button, Meter, Icon, List, ListRow, cx } from '../../kit.js';
import { LineChart } from '../../charts.js';
import { Metric, StrainGauge } from '../../parts/day-ui.js';
import { dayTiming, sessionSummary, fmtSpan, fmtMinutes, fmtSigned, fmtAmount } from '../../parts/day-model.js';
import { openMealCapture } from '../../actions/meal.js';
import { startWorkout, openCardioLog } from '../../actions/workout.js';
import { openWeighIn } from '../../actions/weight.js';
import { openCheckin, CHECKIN_SCALES } from '../../actions/checkin.js';
import { openJournalEntry } from '../../actions/journal.js';
import { dayNutrition, bodySummary, prs, dueItems, isWorkingSet } from '../../../analytics/index.js';
import { addDays, fmtNum, fmtTime, fmtDate, relDay, hmToMin, localParts, isNum } from '../../../core/util.js';

const fmtG = (v) => (isNum(v) ? fmtNum(v, 0) : '—');

/* ------------------------------------------------------------ nutrition */
export function NutritionCard({ date, mode }) {
  const app = useApp();
  const n = useAnalytics(() => ({ ...dayNutrition(app.dv, date), anyAi: app.dv.meals(date).some((m) => m.ai && m.ai.model) }), [date]);
  if (!n) return null;
  const t = n.targets || {};
  const kcal = n.totals.kcal, prot = n.totals.protein;
  const past = mode === 'past';
  const open = html`<${Button} size="sm" variant="ghost" onClick=${() => app.nav('/fuel/' + date)}>Fuel <${Icon} name="chevronRight" size=${14} /></${Button}>`;
  const targetLine = isNum(t.kcal) ? `${fmtNum(t.kcal)} kcal · ${fmtG(t.proteinG)} g protein` : null;
  const basis = t.basis === 'manual' ? 'Manual target from settings.' : t.rationale;
  if (!n.mealCount) {
    return html`<${Card} title="Nutrition" action=${open}>
      <div class="day-empty-row">
        <div class="day-empty-ic"><${Icon} name="camera" /></div>
        <div class="grow stack xs">
          <div class="strong">${mode === 'today' ? 'No meals logged yet' : 'No meals logged for this day'}</div>
          <div class="small dim">Photograph each meal; FORGE estimates calories, protein and micronutrients against your targets.</div>
          ${targetLine ? html`<div class="xs muted">Target ${targetLine}</div>` : html`<div class="xs muted">${basis}</div>`}
        </div>
      </div>
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <${Button} size="sm" variant=${mode === 'today' ? 'primary' : null} icon="camera" onClick=${() => openMealCapture(app, { date, mode: mode === 'today' ? 'camera' : undefined })}>${mode === 'today' ? 'Log a meal' : 'Add meal'}</${Button}>
        ${!isNum(t.kcal) ? html`<${Button} size="sm" variant="ghost" onClick=${() => app.nav('/settings/profile')}>Profile settings</${Button}>` : null}
      </div>
    </${Card}>`;
  }
  const within = isNum(kcal) && isNum(t.kcal) ? Math.abs(kcal - t.kcal) <= 0.1 * t.kcal : null;
  const kTone = !isNum(kcal) || !isNum(t.kcal) ? 'accent' : past && n.complete ? (within ? 'good' : 'warn') : kcal > t.kcal * 1.1 ? 'warn' : within ? 'good' : 'accent';
  const pTone = !isNum(prot) || !isNum(t.proteinG) ? 'accent' : prot >= 0.95 * t.proteinG ? 'good' : past && n.complete ? 'warn' : 'accent';
  const ofT = (v, tgt, unit) => (isNum(tgt) ? `${fmtG(v)} / ${fmtNum(tgt)} ${unit}` : `${fmtG(v)} ${unit}`);
  const rk = n.remaining.kcal, rp = n.remaining.proteinG;
  const left = mode === 'today' && isNum(rk) ? [rk >= 0 ? `${fmtNum(rk)} kcal left` : `${fmtNum(-rk)} kcal over`, isNum(rp) ? (rp > 0 ? `${fmtNum(rp)} g protein left` : 'protein target met') : null].filter(Boolean).join(' · ') : null;
  const macro = (label, v, tgt) => html`<div><div class="l">${label}</div><div class="v mono">${fmtG(v)}${isNum(tgt) ? html`<small> / ${fmtNum(tgt)} g</small>` : html`<small> g</small>`}</div></div>`;
  return html`<${Card} title="Nutrition" meta=${`${n.mealCount} meal${n.mealCount === 1 ? '' : 's'}${n.pending ? ` · ${n.pending} pending` : ''}`} action=${open}>
    <div class="stack sm day-nutr">
      <${Meter} label="Calories" value=${kcal} max=${t.kcal || kcal || 1} tone=${kTone} valueText=${ofT(kcal, t.kcal, 'kcal')} />
      <${Meter} label="Protein" value=${prot} max=${t.proteinG || prot || 1} tone=${pTone} valueText=${ofT(prot, t.proteinG, 'g')} />
    </div>
    <div class="day-macros">${macro('Carbs', n.totals.carbs, t.carbsG)}${macro('Fat', n.totals.fat, t.fatG)}${macro('Fiber', n.totals.fiber, t.fiberG)}</div>
    <div class="small dim" style="margin-top:10px">${n.firstMealAt ? (n.mealCount > 1 ? `Eating window ${fmtSpan(hmToMin(n.firstMealAt), hmToMin(n.lastMealAt))}` : `Meal at ${fmtTime(n.firstMealAt)}`) : 'Meal times not recorded'}${left ? ' · ' + left : ''}</div>
    ${n.flags.length ? html`<div class="day-flags">${n.flags.map((f) => html`<div class=${cx('f', f.level)}><${Icon} name=${f.level === 'warn' ? 'alert' : 'info'} size=${14} /><span>${f.text}</span></div>`)}</div>` : null}
    <div class="xs muted" style="margin-top:10px">${basis}${n.anyAi ? `${basis ? ' ' : ''}Meal values are AI estimates.` : ''}</div>
  </${Card}>`;
}

/* ------------------------------------------------------------- training */
function liftLines(s, ex) {
  return (s.entries || []).map((e) => {
    const sets = ((e && e.sets) || []).filter(isWorkingSet);
    if (!sets.length) return null;
    const name = (ex.get(e.exerciseId) || {}).name || e.exerciseId || 'Exercise';
    const top = sets.reduce((a, b) => ((b.w || 0) > (a.w || 0) || ((b.w || 0) === (a.w || 0) && (b.reps || 0) > (a.reps || 0)) ? b : a));
    const load = isNum(top.w) && top.w > 0 ? `${fmtNum(top.w, top.w % 1 ? 1 : 0)} lb` : 'BW';
    const uniform = sets.every((x) => x.w === top.w && x.reps === top.reps);
    return { key: e.id || name, name, text: uniform ? `${sets.length} × ${top.reps ?? '—'} @ ${load}` : `${sets.length} sets · top ${load} × ${top.reps ?? '—'}` };
  }).filter(Boolean);
}
function cardioLines(s, ex) {
  return (s.cardio || []).filter(Boolean).map((c, i) => ({
    key: c.id || 'c' + i, name: (ex.get(c.exerciseId) || {}).name || 'Cardio',
    text: [isNum(c.durationMin) ? `${fmtNum(c.durationMin)} min` : null, isNum(c.distanceMi) ? `${fmtNum(c.distanceMi, 1)} mi` : null, isNum(c.avgWatts) ? `${fmtNum(c.avgWatts)} W` : null, isNum(c.avgHr) ? `${c.avgHr} bpm` : null, isNum(c.kcal) ? `${fmtNum(c.kcal)} kcal` : null].filter(Boolean).join(' · '),
  }));
}
const PR_LABEL = { e1rm: 'e1RM', weight: 'top weight', reps: 'reps' };

export function TrainingCard({ date, mode, r }) {
  const app = useApp();
  const m = useAnalytics(() => {
    const dv = app.dv; const ex = dv.exercises();
    const sessions = dv.sessions(date).map((s) => ({ s, sum: sessionSummary(s, date, dv.tz), lifts: liftLines(s, ex), cardio: cardioLines(s, ex) }));
    const linked = new Set(sessions.map((x) => x.s.whoopWorkoutId).filter(Boolean));
    const workouts = dv.workouts(date).filter((w) => !linked.has(w.id));
    const cyc = dv.cycle(date);
    const dayPrs = prs(dv).filter((p) => p.date === date).map((p) => ({ ...p, name: (ex.get(p.exerciseId) || {}).name || p.exerciseId }));
    const planned = dv.plan(date).filter((b) => b.category === 'training');
    const woById = new Map(dv.workouts(date).map((w) => [w.id, w]));
    return { sessions, workouts, woById, strain: cyc && isNum(cyc.strain) ? cyc.strain : null, prs: dayPrs, planned };
  }, [date]);
  if (!m) return null;
  const scored = r && r.status !== 'no-data';
  const t = r && r.training;
  const action = html`<${Button} size="sm" variant="ghost" onClick=${() => app.nav('/train')}>Train <${Icon} name="chevronRight" size=${14} /></${Button}>`;
  const nothing = !m.sessions.length && !m.workouts.length;
  return html`<${Card} title="Training" meta=${m.sessions.length ? `${m.sessions.length} session${m.sessions.length > 1 ? 's' : ''}` : null} action=${action}>
    ${isNum(m.strain) ? html`<div class="day-strain-row">
      <div class="row between" style="gap:8px"><span class="small"><span class="dim">Day strain</span> <b class="mono">${fmtNum(m.strain, 1)}</b></span>
        ${scored && t ? html`<span class="xs muted">target ${t.strainTarget.join('–')} · ${t.label}</span>` : null}</div>
      <${StrainGauge} value=${m.strain} target=${scored && t ? t.strainTarget : null} />
    </div>` : null}
    ${m.sessions.map(({ s, sum, lifts, cardio }) => {
      const w = s.whoopWorkoutId ? m.woById.get(s.whoopWorkoutId) : null;
      const head = [sum.startMin != null ? fmtSpan(sum.startMin, sum.endMin) : null, sum.durationMin ? fmtMinutes(sum.durationMin) : sum.open ? 'in progress' : null, sum.sets ? `${sum.sets} working sets` : null, sum.volume ? `${fmtNum(sum.volume)} lb` : null, w && isNum(w.strain) ? `strain ${fmtNum(w.strain, 1)}` : null, w && isNum(w.avgHr) ? `${w.avgHr} bpm avg` : null].filter(Boolean).join(' · ');
      return html`<div key=${s.id} class="day-session" role="button" tabIndex="0" onClick=${() => app.nav('/train/session/' + s.id)}
        onKeyDown=${(e) => { if (e.key === 'Enter') app.nav('/train/session/' + s.id); }}>
        <div class="row between" style="gap:8px"><span class="strong ellipsis">${s.name || 'Workout'}</span><${Icon} name="chevronRight" size=${16} class="muted" /></div>
        <div class="xs muted">${head}</div>
        ${lifts.length || cardio.length ? html`<div class="day-lifts">${[...lifts, ...cardio].map((l) => html`<div key=${l.key}><span class="ellipsis">${l.name}</span><span class="mono">${l.text}</span></div>`)}</div>` : null}
      </div>`;
    })}
    ${m.workouts.map((w) => html`<div key=${w.id} class="day-session static">
      <div class="row" style="gap:8px"><span class="strong">${w.sport || 'Workout'}</span><span class="tag">WHOOP</span></div>
      <div class="xs muted">${[isNum(w.strain) ? `strain ${fmtNum(w.strain, 1)}` : null, isNum(w.avgHr) ? `${w.avgHr} bpm avg` : null, isNum(w.maxHr) ? `${w.maxHr} max` : null, isNum(w.kcal) ? `${fmtNum(w.kcal)} kcal` : null].filter(Boolean).join(' · ')}</div>
    </div>`)}
    ${m.prs.length ? html`<div class="day-prs">${m.prs.map((p) => html`<div><span class="tag">PR</span> <span class="small">${p.name}</span> <span class="mono small">${PR_LABEL[p.type]} ${fmtNum(p.value, p.value % 1 ? 1 : 0)}${p.type === 'reps' ? '' : ' lb'}</span> <span class="xs muted">prev ${fmtNum(p.prev, p.prev % 1 ? 1 : 0)}</span></div>`)}</div>` : null}
    ${nothing ? html`<div class="stack xs" style=${isNum(m.strain) ? 'margin-top:12px' : ''}>
      ${m.planned.length ? html`<div class="small">Planned: <b>${m.planned[0].title || 'Training'}</b> <span class="muted">· ${fmtSpan(hmToMin(m.planned[0].start), hmToMin(m.planned[0].end))}</span></div>` : html`<div class="small dim">${mode === 'future' ? 'No training planned.' : 'No training logged.'}</div>`}
      ${scored && t && t.mode === 'recover' ? html`<div class="xs muted">${t.detail}</div>` : null}
      ${mode !== 'future' ? html`<div class="row wrap" style="gap:8px;margin-top:8px">
        <${Button} size="sm" variant=${mode === 'today' ? 'primary' : null} icon="train" onClick=${() => startWorkout(app, { date })}>Start workout</${Button}>
        <${Button} size="sm" icon="bike" onClick=${() => openCardioLog(app, { date })}>Log cardio</${Button}>
      </div>` : null}
    </div>` : null}
  </${Card}>`;
}

/* ----------------------------------------------------------------- body */
export function BodyCard({ date }) {
  const app = useApp();
  const profile = useSetting('profile');
  const b = useAnalytics(() => bodySummary(app.dv, date), [date]);
  if (!b) return null;
  const today = app.today();
  const action = html`<${Button} size="sm" variant="ghost" icon="scale" onClick=${() => openWeighIn(app, { date })}>Weigh in</${Button}>`;
  if (!isNum(b.weight)) {
    return html`<${Card} title="Body" action=${action}>
      <div class="day-empty-row">
        <div class="day-empty-ic"><${Icon} name="scale" /></div>
        <div class="grow stack xs">
          <div class="strong">No weigh-ins yet</div>
          <div class="small dim">Weigh in each morning before eating. The trend smooths daily noise; a weekly rate needs 7 weigh-ins.</div>
          ${isNum(profile.goalWeightLow) ? html`<div class="xs muted">Goal ${fmtNum(profile.goalWeightLow)}–${fmtNum(profile.goalWeightHigh)} lb</div>` : null}
        </div>
      </div>
    </${Card}>`;
  }
  const p = b.projection || {};
  const series = (b.series || []).slice(-42);
  const lastAt = (() => { const w = app.dv.body(b.weightDate).find((x) => isNum(x.weightLb)); return w && w.at ? localParts(w.at, app.dv.tz).hm : null; })();
  const goal = isNum(p.goalLow) || isNum(p.goalHigh);
  const ys = series.map((x) => x.trendLb).filter(isNum);
  return html`<${Card} title="Body" action=${action}>
    <div class="day-metrics first">
      <${Metric} label="Weight" value=${fmtNum(b.weight, 1)} unit="lb" sub=${b.weightDate === date && lastAt ? fmtTime(lastAt) : relDay(b.weightDate, today)} />
      <${Metric} label="Trend" value=${isNum(b.trend) ? fmtNum(b.trend, 1) : null} unit="lb" sub=${isNum(b.change7) ? `${fmtSigned(b.change7, 1)} lb in 7 d` : null} />
      <${Metric} label="28-day change" value=${isNum(b.change28) ? fmtSigned(b.change28, 1) : null} unit="lb" />
      <${Metric} label="Rate" value=${isNum(b.rate28) ? fmtSigned(b.rate28, 2) : null} unit="lb/wk"
        sub=${isNum(p.goalRate) && isNum(b.rate28) ? `goal ${fmtSigned(p.goalRate, 2)}` : isNum(b.rate28) ? null : 'needs 7 weigh-ins'}
        tone=${p.onTrack === true ? 'good' : p.onTrack === false ? 'warn' : null} />
    </div>
    ${ys.length >= 2 ? html`<div style="margin-top:12px"><${LineChart} height=${128} yFormat=${(v) => fmtNum(v, 1)}
      yMin=${Math.floor(Math.min(...ys))} yMax=${Math.ceil(Math.max(...ys))}
      series=${[{ key: 'trend', label: 'Trend', points: series.map((x) => ({ x: x.date, y: x.trendLb })) }]} /></div>` : null}
    <div class="small dim" style="margin-top:8px">${goal
      ? html`Goal ${fmtNum(p.goalLow)}–${fmtNum(p.goalHigh)} lb · ${p.note}${p.etaDate ? html` <span class="muted">ETA ${fmtDate(p.etaDate, { year: p.etaDate.slice(0, 4) !== today.slice(0, 4) })}</span>` : null}${p.onTrack === true ? html` <span class="tag">on pace</span>` : p.onTrack === false ? html` <span class="tag ink-warn">behind pace</span>` : null}`
      : html`No goal range set. <button type="button" class="day-linkbtn" onClick=${() => app.nav('/settings/profile')}>Set one in Profile</button>`}</div>
  </${Card}>`;
}

/* ------------------------------------------------------------- check-in */
export function CheckinCard({ date, mode }) {
  const app = useApp(); useVersion(['days']);
  const d = app.store.get('days', date);
  const targets = useSetting('targets');
  const timing = useAnalytics(() => {
    const dv = app.dv; const day = dv.day(date);
    return dayTiming({
      wakeMin: dv.sleepClock(date).wakeMin, caffeineMin: hmToMin(day && day.caffeineLastAt),
      lastMealMin: dv.intake(date).lastMin, bedMin: dv.sleepClock(addDays(date, 1)).bedMin,
    }, dv.setting('targets'));
  }, [date]);
  const tz = app.dv.tz;
  const action = html`<${Button} size="sm" variant="ghost" icon=${d ? 'edit' : 'plus'} onClick=${() => openCheckin(app, { date })}>${d ? 'Edit' : 'Check in'}</${Button}>`;
  const scale = (k) => (d && isNum(d[k]) ? d[k] : null);
  const kv = d ? [
    ['Caffeine', isNum(d.caffeineMg) ? `${fmtNum(d.caffeineMg)} mg` : null],
    ['Alcohol', isNum(d.alcohol) ? `${fmtNum(d.alcohol)} drink${d.alcohol === 1 ? '' : 's'}` : null],
    ['Deep work', isNum(d.deepWorkH) ? `${fmtNum(d.deepWorkH, d.deepWorkH % 1 ? 1 : 0)} h` : null],
    ['Sunlight', isNum(d.sunlightMin) ? `${fmtNum(d.sunlightMin)} min` : null],
    ['Day rating', isNum(d.dayRating) ? `${d.dayRating} / 10` : null],
  ].filter(([, v]) => v != null) : [];
  return html`<${Card} title="Check-in" meta=${d && d.checkinAt ? `saved ${fmtTime(localParts(d.checkinAt, tz).hm)}` : null} action=${action}>
    ${d ? html`
      <div class="day-scales">${CHECKIN_SCALES.map((s) => html`<div key=${s.key}><div class="l">${s.label}</div><div class="v mono">${scale(s.key) ?? '—'}${scale(s.key) != null ? html`<small>/5</small>` : null}</div></div>`)}</div>
      ${kv.length ? html`<dl class="kv" style="margin-top:12px">${kv.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : null}
      ${['wins', 'misses', 'note'].filter((k) => d[k]).map((k) => html`<div class="day-note"><span class="eyebrow">${k === 'wins' ? 'Wins' : k === 'misses' ? 'Misses' : 'Note'}</span><p>${d[k]}</p></div>`)}`
    : html`<div class="small dim">${mode === 'today' ? 'Rate energy, mood, stress and focus, and log caffeine, alcohol, deep work and the day’s wins and misses. The evening is the best time.' : 'No check-in was logged for this day.'}</div>`}
    <div class="eyebrow" style="margin:14px 0 6px">Timing vs targets</div>
    <div class="day-timing">${(timing || []).map((row) => {
      const tgt = row.target != null ? fmtTime(row.target) : '—';
      return html`<div key=${row.key} class="r">
        <span class="k"><span>${row.label}</span><span class="g xs muted">target ${tgt}</span></span>
        <span class="a mono">${row.actual != null ? fmtTime(row.actual) : '—'}</span>
        <span class=${cx('d xs', row.hit === true && 'ink-good', row.hit === false && 'ink-bad', row.hit == null && 'muted')}>${row.hit == null ? (row.key === 'bedtime' && mode === 'today' ? 'tonight' : '—') : row.delta === 0 ? 'on time' : row.delta < 0 ? `${fmtMinutes(-row.delta)} early` : `${fmtMinutes(row.delta)} late`}</span>
      </div>`;
    })}</div>
    ${!targets.wake && !targets.bedtime ? html`<div class="xs muted">Set timing targets in Settings → Targets.</div>` : null}
  </${Card}>`;
}

/* -------------------------------------------------------------- journal */
export function JournalCard({ date }) {
  const app = useApp(); useVersion(['journal']);
  const entries = app.dv.journal(date);
  const tz = app.dv.tz;
  const add = html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${() => openJournalEntry(app, { date })}>Note</${Button}>`;
  return html`<${Card} title="Journal" meta=${entries.length ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : null} action=${add} flush=${entries.length > 0}>
    ${entries.length ? html`<${List}>${entries.map((j) => html`<${ListRow} key=${j.id} title=${html`<span class="day-clamp2" style="white-space:normal">${j.text || 'Note'}</span>`}
      meta=${[j.at ? fmtTime(localParts(j.at, tz).hm) : null, (j.tags || []).map((t) => '#' + t).join(' ') || null].filter(Boolean).join(' · ')}
      onClick=${() => openJournalEntry(app, { date, id: j.id })} />`)}</${List}>`
      : html`<div class="small dim">No notes for this day. Capture decisions, context and anything the numbers do not show.</div>`}
  </${Card}>`;
}

/* ------------------------------------------------- protocol due (future) */
export function DueCard({ date }) {
  const app = useApp();
  const due = useAnalytics(() => dueItems(app.dv, date).filter((x) => x.due), [date]);
  if (!due) return null;
  return html`<${Card} title="Protocol due" meta=${due.length ? `${due.length} item${due.length === 1 ? '' : 's'}` : null} flush=${due.length > 0}>
    ${due.length ? html`<${List}>${due.map(({ item }) => html`<${ListRow} key=${item.id} lead="pill" title=${item.name || 'Item'}
      meta=${[isNum(item.amount) ? `${fmtAmount(item.amount)} ${item.unit || ''}`.trim() : null, item.schedule && item.schedule.stack ? `${item.schedule.stack} stack` : null, item.kind].filter(Boolean).join(' · ')} />`)}</${List}>`
      : html`<div class="small dim">No protocol items are scheduled for this day.</div>`}
  </${Card}>`;
}
