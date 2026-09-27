// #/train/exercise/<id> — strength: e1RM and top-set trend, volume per session, progression, records, recent sessions.
// Cardio: average power, efficiency (W per bpm) and duration trends, records, recent entries.
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useWide } from '../../ctx.js';
import { Page, Section, Card, Stat, Button, IconButton, List, ListRow, Empty, KV } from '../../kit.js';
import { LineChart, BarChart } from '../../charts.js';
import { exerciseHistory, progression, cardioHistory } from '../../../analytics/index.js';
import { addDays, fmtDate, fmtNum, isNum, relDay, signed, mean, round } from '../../../core/util.js';
import { startWorkout, openCardioLog } from '../../actions/workout.js';
import { exerciseRecords, setsLine, fmtLb, isWorkingSet, e1rm } from '../../parts/train-logic.js';
import { editExercise, cardioLine } from '../../parts/train-sheets.js';
import { StatusPill, exMeta } from '../../parts/train-ui.js';

export default function ExerciseView({ id }) {
  const app = useApp(); useVersion(['sessions', 'exercises']);
  const wide = useWide();
  const ex = app.store.get('exercises', id);
  const today = app.today();
  const used = useAnalytics(() => app.dv.allSessions().some((s) => (s.entries || []).some((e) => e && e.exerciseId === id) || (s.cardio || []).some((c) => c && c.exerciseId === id)), [id]);
  if (!ex && !used) {
    return html`<${Page} title="Exercise" back="/train"><${Empty} title="Exercise not found" action=${html`<${Button} onClick=${() => app.nav('/train/exercises')}>Exercise library</${Button}>`}>It may have been deleted from the library.</${Empty}></${Page}>`;
  }
  const type = (ex && ex.type) || 'strength';
  const edit = async () => { const r = await editExercise(app, { id }); if (r === 'deleted') app.nav('/train/exercises'); };
  const sub = ex ? [exMeta(ex), (ex.secondary || []).length ? 'also ' + ex.secondary.join(', ') : null, ex.bodyweight && ex.equipment !== 'bodyweight' ? 'bodyweight' : null].filter(Boolean).join(' · ') : 'Removed from the library';
  return html`<${Page} title=${ex ? ex.name : 'Unknown exercise'} sub=${sub} back="/train" wide
    actions=${ex ? (wide ? html`<${Button} size="sm" icon="edit" onClick=${edit}>Edit</${Button}>` : html`<${IconButton} icon="edit" label="Edit exercise" onClick=${edit} />`) : null}>
    ${type === 'cardio' ? html`<${CardioDetail} id=${id} today=${today} />` : html`<${StrengthDetail} id=${id} ex=${ex} today=${today} />`}
  </${Page}>`;
}

const lastText = (date, today) => { const r = relDay(date, today); return 'Last ' + (r === 'Today' || r === 'Yesterday' ? r.toLowerCase() : r); };
const pctText = (a, b) => (isNum(a) && isNum(b) && b > 0 ? signed(((a - b) / b) * 100, 1) + '% vs prior 28 d' : 'no prior 28 d');

/* ------------------------------------------------------------------ strength */
function StrengthDetail({ id, ex, today }) {
  const app = useApp(); const wide = useWide();
  const d = useAnalytics(() => {
    const hist = exerciseHistory(app.dv, id);
    if (!hist.length) return { hist };
    const useE = hist.some((x) => isNum(x.e1rm));
    const val = (x) => (useE ? x.e1rm : x.maxReps);
    const byDate = new Map();
    for (const h of hist) {
      const c = byDate.get(h.date) || { date: h.date, e1rm: null, topW: null, maxReps: null, volume: 0 };
      if (isNum(h.e1rm) && (c.e1rm == null || h.e1rm > c.e1rm)) c.e1rm = h.e1rm;
      if (isNum(h.topW) && (c.topW == null || h.topW > c.topW)) c.topW = h.topW;
      if (isNum(h.maxReps) && (c.maxReps == null || h.maxReps > c.maxReps)) c.maxReps = h.maxReps;
      c.volume += h.volume || 0; byDate.set(h.date, c);
    }
    const days = [...byDate.values()].slice(-60);
    const since = addDays(today, -27), prior = addDays(today, -55);
    const maxOf = (list) => { const v = list.map(val).filter(isNum); return v.length ? Math.max(...v) : null; };
    const best = hist.reduce((b, x) => (isNum(val(x)) && (!b || val(x) > val(b)) ? x : b), null);
    const byId = new Map(app.dv.allSessions().map((s) => [s.id, s]));
    const recent = hist.slice(-10).reverse().map((h) => {
      const s = byId.get(h.sessionId); const sets = [];
      for (const e of (s && s.entries) || []) if (e && e.exerciseId === id) for (const x of e.sets || []) if (x && x.done !== false) sets.push(x);
      return { ...h, name: s ? s.name : '', sets };
    });
    return {
      hist, useE, days, best, recent, prog: progression(hist), recs: exerciseRecords(app.dv.allSessions(), id),
      cur: maxOf(hist.filter((x) => x.date >= since)), prev: maxOf(hist.filter((x) => x.date >= prior && x.date < since)),
    };
  }, [id, today]);
  if (!d) return null;
  if (!d.hist.length) {
    return html`<${Empty} title="No sets logged yet" action=${html`<${Button} variant="primary" icon="plus" onClick=${() => startWorkout(app, {})}>Start workout</${Button}>`}>
      Once you log working sets, this page shows the estimated 1RM trend, volume per session, the 8-week progression and your records.</${Empty}>`;
  }
  const bw = !!(ex && ex.bodyweight);
  const { useE, days, best, prog, recs, recent } = d;
  const last = d.hist[d.hist.length - 1];
  const unitV = (v) => (useE ? fmtLb(v) : `${fmtNum(v)} reps`);
  const trend = useE
    ? [{ key: 'e', label: 'e1RM', points: days.map((x) => ({ x: x.date, y: x.e1rm })) }, { key: 't', label: 'Top set', points: days.map((x) => ({ x: x.date, y: x.topW })) }]
    : [{ key: 'r', label: 'Most reps in a set', points: days.map((x) => ({ x: x.date, y: x.maxReps })) }];
  const stats = html`<div class="grid four">
    <${Stat} label=${useE ? (bw ? 'Best e1RM, added load' : 'Best e1RM') : 'Most reps'} value=${best ? (useE ? fmtLb(best.e1rm, false) : fmtNum(best.maxReps)) : '—'} unit=${useE ? 'lb' : 'reps'}
      sub=${best ? `${fmtDate(best.date, { dow: false })} · ${setsLine([{ ...best.bestSet, kind: 'work' }], bw)}` : ''} />
    <${Stat} label="Best, last 28 d" value=${isNum(d.cur) ? (useE ? fmtLb(d.cur, false) : fmtNum(d.cur)) : '—'} unit=${useE ? 'lb' : 'reps'} sub=${pctText(d.cur, d.prev)} />
    <${Stat} label="Trend, 8 wk" value=${isNum(prog.slopePctPerWeek) ? signed(prog.slopePctPerWeek, 2) : '—'} unit=${isNum(prog.slopePctPerWeek) ? '%/wk' : ''} spark=${html`<div style="margin-top:4px"><${StatusPill} status=${prog.status} /></div>`} />
    <${Stat} label="Sessions" value=${fmtNum(d.hist.length)} sub=${lastText(last.date, today)} />
  </div>`;
  const charts = html`<${Card} title=${useE ? (bw ? 'e1RM and top set, added load' : 'Estimated 1RM and top set') : 'Reps'} meta=${`${days.length} session day${days.length === 1 ? '' : 's'}`}>
      <${LineChart} series=${trend} height=${200} yFormat=${(v) => fmtNum(v)} />
      <div class="xs muted" style="margin-top:4px">${useE ? (bw ? 'Bodyweight exercise: weights are the added load, so e1RM (Epley, 1–12 reps) is estimated on the added load only.' : 'e1RM = Epley estimate from the best working set (1–12 reps). Top set = heaviest working weight.') : 'Bodyweight work: progress is tracked as reps.'}</div>
    </${Card}>
    <${Card} title=${bw ? 'Added-load volume per session' : 'Volume per session'} meta="Working sets, weight × reps">
      <${BarChart} data=${days.slice(-30).map((x) => ({ x: x.date, y: round(x.volume, 0) }))} height=${150} yFormat=${(v) => fmtNum(v)} color="var(--s3)" />
    </${Card}>`;
  const records = html`<${Section} title="Records">
    <${Card}><${KV} items=${[
      recs.heaviest ? ['Heaviest set', `${fmtLb(recs.heaviest.w)} × ${recs.heaviest.reps} · ${fmtDate(recs.heaviest.date, { dow: false })}`] : null,
      recs.bestE1rm ? ['Best e1RM set', `${fmtLb(recs.bestE1rm.w)} × ${recs.bestE1rm.reps} = ${fmtLb(recs.bestE1rm.e1rm)} · ${fmtDate(recs.bestE1rm.date, { dow: false })}`] : null,
      recs.mostReps ? ['Most reps', `${bw && !recs.mostReps.w ? 'BW' : fmtLb(recs.mostReps.w)} × ${recs.mostReps.reps} · ${fmtDate(recs.mostReps.date, { dow: false })}`] : null,
    ]} />
    ${recs.repMax.length ? html`<div class="table-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>Weight</th><th class="num">Most reps</th><th class="num">e1RM</th><th class="num">Date</th></tr></thead>
      <tbody>${recs.repMax.slice().reverse().map((r) => html`<tr key=${r.reps}><td class="mono">${fmtLb(r.w)}</td><td class="num">${r.reps}</td><td class="num">${fmtLb(e1rm(r.w, r.reps))}</td><td class="num">${fmtDate(r.date, { dow: false })}</td></tr>`)}</tbody></table></div>
      <div class="xs muted" style="margin-top:6px">Most reps done at each weight or heavier (working sets, 1–12 reps). Beat a row to set a rep record.</div>` : null}
    </${Card}></${Section}>`;
  const recentList = html`<${Section} title="Recent sessions"><div class="card flush"><${List}>${recent.map((h) => html`<${ListRow} key=${h.sessionId}
      title=${html`<span class="mono">${setsLine(h.sets, bw) || '—'}</span>`}
      meta=${`${fmtDate(h.date, { dow: false })}${h.name ? ' · ' + h.name : ''} · ${fmtNum(h.sets.filter(isWorkingSet).length)} sets · ${bw ? fmtNum(h.sets.filter(isWorkingSet).reduce((a, x) => a + (x.reps || 0), 0)) + ' reps' : fmtLb(h.volume)}${isNum(h.e1rm) && !bw ? ' · e1RM ' + fmtLb(h.e1rm, false) : ''}`}
      onClick=${() => app.nav('/train/session/' + h.sessionId)} />`)}</${List}></div></${Section}>`;
  return wide
    ? html`${stats}<div class="tr-cols"><div class="stack lg">${charts}</div><div class="stack lg">${records}${recentList}</div></div>`
    : html`${stats}${charts}${records}${recentList}`;
}

/* -------------------------------------------------------------------- cardio */
function CardioDetail({ id, today }) {
  const app = useApp(); const wide = useWide();
  const d = useAnalytics(() => {
    const hist = cardioHistory(app.dv, id);
    if (!hist.length) return { hist };
    const byDate = new Map();
    for (const h of hist) {
      const c = byDate.get(h.date) || { date: h.date, w: [], e: [], dur: 0 };
      if (isNum(h.avgWatts)) c.w.push(h.avgWatts); if (isNum(h.efficiency)) c.e.push(h.efficiency); c.dur += h.durationMin || 0; byDate.set(h.date, c);
    }
    const days = [...byDate.values()].slice(-60).map((x) => ({ date: x.date, w: x.w.length ? round(mean(x.w), 0) : null, e: x.e.length ? round(mean(x.e), 3) : null, dur: x.dur }));
    const since = addDays(today, -27), prior = addDays(today, -55);
    const avg = (from, to, k) => { const v = hist.filter((h) => h.date >= from && h.date <= to).map((h) => h[k]).filter(isNum); return v.length ? mean(v) : null; };
    const top = (k) => hist.reduce((b, x) => (isNum(x[k]) && (!b || x[k] > b[k]) ? x : b), null);
    return {
      hist, days, w28: avg(since, today, 'avgWatts'), wPrev: avg(prior, addDays(since, -1), 'avgWatts'), e28: avg(since, today, 'efficiency'), ePrev: avg(prior, addDays(since, -1), 'efficiency'),
      min28: hist.filter((h) => h.date >= since).reduce((s, h) => s + (h.durationMin || 0), 0),
      bestW: top('avgWatts'), bestE: top('efficiency'), longest: top('durationMin'), farthest: top('distanceMi'), recent: hist.slice(-12).reverse(),
    };
  }, [id, today]);
  if (!d) return null;
  if (!d.hist.length) {
    return html`<${Empty} title="No entries yet" action=${html`<${Button} variant="primary" icon="bike" onClick=${() => openCardioLog(app, {})}>Log cardio</${Button}>`}>
      Log duration, average watts and heart rate; power and efficiency (W per bpm) trends appear here.</${Empty}>`;
  }
  const stats = html`<div class="grid four">
    <${Stat} label="Avg power, 28 d" value=${isNum(d.w28) ? fmtNum(d.w28) : '—'} unit="W" sub=${pctText(d.w28, d.wPrev)} />
    <${Stat} label="Efficiency, 28 d" value=${isNum(d.e28) ? fmtNum(d.e28, 2) : '—'} unit="W/bpm" sub=${pctText(d.e28, d.ePrev)} />
    <${Stat} label="Minutes, 28 d" value=${fmtNum(d.min28)} unit="min" />
    <${Stat} label="Sessions" value=${fmtNum(d.hist.length)} sub=${lastText(d.hist[d.hist.length - 1].date, today)} />
  </div>`;
  const hasW = d.days.some((x) => isNum(x.w)); const hasE = d.days.some((x) => isNum(x.e));
  const charts = html`
    <${Card} title="Average power" meta="W per session day">${hasW ? html`<${LineChart} series=${[{ key: 'w', label: 'Avg power (W)', points: d.days.map((x) => ({ x: x.date, y: x.w })) }]} height=${170} yFormat=${(v) => fmtNum(v)} />` : html`<div class="small muted">Add average watts to entries to see this trend.</div>`}</${Card}>
    <${Card} title="Efficiency" meta="Avg power ÷ avg heart rate">${hasE ? html`<${LineChart} series=${[{ key: 'e', label: 'W per bpm', points: d.days.map((x) => ({ x: x.date, y: x.e })) }]} height=${170} yFormat=${(v) => fmtNum(v, 2)} />
      <div class="xs muted" style="margin-top:4px">More power at the same heart rate = better aerobic fitness. Compare rides of similar duration.</div>` : html`<div class="small muted">Needs both average watts and average heart rate.</div>`}</${Card}>
    <${Card} title="Duration" meta="Minutes per day"><${BarChart} data=${d.days.slice(-30).map((x) => ({ x: x.date, y: x.dur }))} height=${130} yFormat=${(v) => fmtNum(v)} color="var(--s3)" /></${Card}>`;
  const recs = html`<${Section} title="Records"><${Card}><${KV} items=${[
    d.bestW ? ['Highest avg power', `${fmtNum(d.bestW.avgWatts)} W · ${fmtNum(d.bestW.durationMin)} min · ${fmtDate(d.bestW.date, { dow: false })}`] : null,
    d.bestE ? ['Best efficiency', `${fmtNum(d.bestE.efficiency, 2)} W/bpm · ${fmtDate(d.bestE.date, { dow: false })}`] : null,
    d.longest ? ['Longest', `${fmtNum(d.longest.durationMin)} min · ${fmtDate(d.longest.date, { dow: false })}`] : null,
    d.farthest ? ['Farthest', `${fmtNum(d.farthest.distanceMi, 1)} mi · ${fmtDate(d.farthest.date, { dow: false })}`] : null,
  ]} /></${Card}></${Section}>`;
  const recent = html`<${Section} title="Recent entries"><div class="card flush"><${List}>${d.recent.map((h, i) => html`<${ListRow} key=${h.sessionId + i}
    title=${fmtDate(h.date)} meta=${cardioLine(h) + (isNum(h.efficiency) ? ` · ${fmtNum(h.efficiency, 2)} W/bpm` : '')} onClick=${() => app.nav('/train/session/' + h.sessionId)} />`)}</${List}></div></${Section}>`;
  return wide
    ? html`${stats}<div class="tr-cols"><div class="stack lg">${charts}</div><div class="stack lg">${recs}${recent}</div></div>`
    : html`${stats}${charts}${recs}${recent}`;
}
