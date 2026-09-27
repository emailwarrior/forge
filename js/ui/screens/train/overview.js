// #/train — this week, strength trends, PRs, cardio, session history, templates, library.
import { html, useState, useEffect } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useWide } from '../../ctx.js';
import { Page, Section, Card, Stat, Button, Segmented, List, ListRow, Empty, Pill, Icon, cx } from '../../kit.js';
import { LineChart, BarChart, Sparkline } from '../../charts.js';
import { strengthSummary, exerciseHistory, cardioHistory } from '../../../analytics/index.js';
import { MUSCLES } from '../../../core/schema.js';
import { addDays, weekStart, fmtDate, fmtDur, fmtNum, isNum, relDay, signed, dayOfWeek, round, mean } from '../../../core/util.js';
import { startWorkout, openCardioLog } from '../../actions/workout.js';
import { weekSummary, sessionStats, fmtLb } from '../../parts/train-logic.js';
import { recentOpenSession, prCountBySession, linkedWorkout, autoLinkRecent } from '../../parts/train-data.js';
import { finishSession, editTemplate } from '../../parts/train-sheets.js';
import { Elapsed, StatusPill, MuscleBars, exName } from '../../parts/train-ui.js';
import { TemplatesCard, LibraryCard } from './library.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Overview() {
  const app = useApp(); useVersion(['sessions', 'templates', 'exercises', 'whoopWorkouts']);
  const wide = useWide();
  const today = app.today();
  const data = useAnalytics(() => {
    const dv = app.dv; const from = weekStart(today); const to = addDays(from, 6);
    return {
      from, to,
      cur: weekSummary(dv.range('sessions', from, to)),
      prev: weekSummary(dv.range('sessions', addDays(from, -7), addDays(from, -1))),
      summary: strengthSummary(dv, today),
      count: dv.allSessions().length,
    };
  }, [today]);
  const open = recentOpenSession(app.dv, today);
  const whoopN = app.store.all('whoopWorkouts').length;
  useEffect(() => { try { autoLinkRecent(app); } catch (e) { console.warn('[train] whoop link', e); } }, [whoopN]);
  if (!data) return html`<${Page} title="Train"><${Empty} title="Could not compute training data">Reload the app; if this persists, check the console.</${Empty}></${Page}>`;
  const empty = data.count === 0;
  const start = () => startWorkout(app, {});
  const cardio = () => openCardioLog(app, {});
  const actions = html`<span class="hide-sm row" style="gap:8px"><${Button} icon="bike" onClick=${cardio}>Log cardio</${Button}><${Button} variant="primary" icon="plus" onClick=${start}>Start workout</${Button}></span>`;
  const sub = empty ? 'Sessions, sets, cardio and templates' : `This week: ${plural(data.cur.sessions, 'session')} · ${plural(data.cur.workingSets, 'working set')}`;

  const top = html`${open ? html`<${OpenBanner} session=${open} today=${today} />` : null}
    <div class="tr-actions only-sm"><${Button} variant="primary" size="lg" icon="plus" onClick=${start}>Start workout</${Button}><${Button} size="lg" icon="bike" onClick=${cardio}>Log cardio</${Button}></div>`;

  if (empty) {
    const left = html`<${GettingStarted} />`;
    const right = html`<${TemplatesCard} />`;
    return html`<${Page} title="Train" sub=${sub} actions=${actions} wide>
      ${top}
      ${wide ? html`<div class="tr-cols"><div class="stack lg">${left}${right}</div><div class="stack lg"><${LibraryCard} /></div></div>`
        : html`${left}${right}<${LibraryCard} />`}
    </${Page}>`;
  }
  const week = html`<${WeekCard} data=${data} today=${today} />`;
  const lifts = html`<${TopLifts} summary=${data.summary} />`;
  const prs = html`<${RecentPrs} summary=${data.summary} today=${today} />`;
  const cardioCard = html`<${CardioCard} today=${today} />`;
  const history = html`<${History} wide=${wide} today=${today} />`;
  return html`<${Page} title="Train" sub=${sub} actions=${actions} wide>
    ${top}
    ${wide ? html`<div class="tr-cols">
        <div class="stack lg">${week}${history}<${TemplatesCard} /><${LibraryCard} /></div>
        <div class="stack lg">${lifts}${prs}${cardioCard}</div>
      </div>`
      : html`${week}${lifts}${prs}${cardioCard}${history}<${TemplatesCard} /><${LibraryCard} />`}
  </${Page}>`;
}

const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;
const nb = (t) => String(t).replace(/ /g, '\u00a0'); // keep "14,715 lb" / "1h 09m" together when meta lines wrap

/* ---------------------------------------------------------- open banner */
function OpenBanner({ session: s, today }) {
  const app = useApp();
  const st = sessionStats(s);
  const stale = s.date !== today;
  const go = () => app.nav('/train/session/' + s.id);
  return html`<div class="tr-banner" role="status">
    <span class="tr-banner-dot"></span>
    <div class="grow" style="min-width:0">
      <div class="strong ellipsis">${s.name || 'Workout'} · ${stale ? 'unfinished since ' + relDay(s.date, today).toLowerCase() : 'in progress'}</div>
      <div class="xs muted">${stale ? fmtDate(s.date) : html`<span class="mono"><${Elapsed} startAt=${s.startAt} /></span> elapsed`} · ${plural(st.workingSets, 'set')} done${st.cardioCount ? ` · ${st.cardioCount} cardio ${st.cardioCount === 1 ? 'entry' : 'entries'}` : ''}</div>
    </div>
    ${stale ? html`<${Button} size="sm" onClick=${async () => { const r = await finishSession(app, s.id); if (r === 'keep') go(); }}>Finish</${Button}>` : null}
    <${Button} size="sm" variant="primary" onClick=${go}>${stale ? 'Open' : 'Resume'}</${Button}>
  </div>`;
}

/* ------------------------------------------------------ getting started */
function GettingStarted() {
  const app = useApp();
  const newTemplate = async () => { const r = await editTemplate(app); if (r && r.start) startWorkout(app, { templateId: r.id }); };
  const steps = [
    ['layers', 'Save your split as templates', 'One per training day (e.g. Push, Pull, Legs): exercises, set counts, rep and RPE targets.', html`<${Button} size="sm" onClick=${newTemplate}>New template</${Button}>`],
    ['list', 'Log every set', 'Weight, reps and optional RPE, one tap to complete. The logger pre-fills weights from last time, flags PRs and runs the rest timer.', html`<${Button} size="sm" onClick=${() => startWorkout(app, {})}>Start workout</${Button}>`],
    ['bike', 'Log cardio with power and heart rate', 'Average watts ÷ average heart rate gives an efficiency trend (W per bpm) for the bike.', html`<${Button} size="sm" onClick=${() => openCardioLog(app, {})}>Log cardio</${Button}>`],
  ];
  return html`<${Section} title="Getting started">
    <${Card}><div class="stack">
      ${steps.map(([icon, title, text, action], i) => html`<div class="tr-step-row">
        <span class="tr-step-n">${i + 1}</span>
        <div class="grow" style="min-width:0"><div class="strong small">${title}</div><div class="xs muted">${text}</div></div>
        <span class="hide-sm">${action}</span>
      </div>`)}
      <div class="divider"></div>
      <div class="xs muted">This screen fills in as you train: weekly hard sets per muscle, estimated 1RM trends for your main lifts, PRs, cardio power and efficiency, and a session history linked to WHOOP strain.</div>
    </div></${Card}>
  </${Section}>`;
}

/* ------------------------------------------------------------ this week */
function WeekCard({ data, today }) {
  const { cur, prev, from, to, summary } = data;
  const rows = (summary.weeklySets || []).filter((r) => r.hardSets > 0 || r.avg4 > 0)
    .sort((a, b) => MUSCLES.indexOf(a.muscle) - MUSCLES.indexOf(b.muscle));
  const dayN = dayOfWeek(today) + 1;
  const same = (b) => (b ? `Last week ${fmtNum(b)}` : `Day ${dayN} of 7`);
  return html`<${Section} title="This week" meta=${`${fmtDate(from, { dow: false })} – ${fmtDate(to, { dow: false })}`}>
    <${Card}>
      <div class="grid four">
        <${Stat} label="Sessions" value=${fmtNum(cur.sessions)} sub=${same(prev.sessions)} />
        <${Stat} label="Working sets" value=${fmtNum(cur.workingSets)} sub=${same(prev.workingSets)} />
        <${Stat} label="Volume" value=${fmtLb(cur.volumeLb, false)} unit="lb" sub=${prev.volumeLb ? 'Last week ' + fmtLb(prev.volumeLb, false) : ''} />
        <${Stat} label="Cardio" value=${fmtNum(cur.cardioMin)} unit="min" sub=${prev.cardioMin ? `Last week ${fmtNum(prev.cardioMin)} min` : ''} />
      </div>
      <div class="divider" style="margin:14px 0 12px"></div>
      <div class="row between" style="margin-bottom:8px"><span class="small strong dim">Hard sets per muscle</span><span class="xs muted mono">week / 4-wk avg</span></div>
      ${rows.length ? html`<${MuscleBars} rows=${rows} />` : html`<div class="small muted">No hard sets in the last five weeks.</div>`}
      <div class="xs muted tr-legend">
        <span><i class="tr-key fill"></i>This week</span><span><i class="tr-key tick"></i>4-week average</span><span><i class="tr-key band"></i>10–20 sets</span>
      </div>
      <div class="xs muted" style="margin-top:6px">10–20 hard sets per muscle per week is a common hypertrophy guideline, not a rule. Secondary muscles count half a set.</div>
    </${Card}>
  </${Section}>`;
}

/* ------------------------------------------------------------ top lifts */
function TopLifts({ summary }) {
  const app = useApp();
  const lifts = useAnalytics(() => (summary.topLifts || []).map((l) => {
    const h = exerciseHistory(app.dv, l.exerciseId).slice(-12);
    return { ...l, spark: h.map((x) => (l.metric === 'reps' ? x.maxReps : x.e1rm)) };
  }), [summary]) || [];
  return html`<${Section} title="Main lifts" meta="Best e1RM, last 28 days · change vs prior 28">
    ${lifts.length ? html`<div class="card flush"><div class="tr-lifts">${lifts.map((l) => html`<button type="button" class="tr-lift" onClick=${() => app.nav('/train/exercise/' + l.exerciseId)}>
        <div class="tr-lift-name strong ellipsis">${l.name}</div>
        <div class="tr-lift-v mono strong">${l.metric === 'reps' ? `${fmtNum(l.best)} reps` : fmtLb(l.e1rm)}</div>
        <div class="tr-lift-meta"><${StatusPill} status=${l.status} /><span class="xs muted ellipsis">${fmtNum(l.sessions)}× in 8 wk</span></div>
        <div class="tr-lift-spark"><${Sparkline} values=${l.spark} width=${72} height=${24} color="var(--s1)" /></div>
        <div class=${cx('tr-lift-d xs mono', isNum(l.change28Pct) ? (l.change28Pct > 0 ? 'pos' : l.change28Pct < 0 ? 'neg' : 'muted') : 'muted')}>${isNum(l.change28Pct) ? signed(l.change28Pct, 1) + '%' : '—'}</div>
      </button>`)}</div></div>
      <div class="xs muted">e1RM = estimated one-rep max (Epley) from your best working set. Status is the 8-week trend (±0.5% per week); it needs 3 sessions over 2+ weeks.</div>`
      : html`<${Empty} title="No strength work in the last 8 weeks">Your most-trained lifts appear here with their e1RM trend.</${Empty}>`}
  </${Section}>`;
}

/* ------------------------------------------------------------ recent PRs */
const prText = (p) => (p.type === 'e1rm' ? `e1RM ${fmtLb(p.value)} (prev ${fmtLb(p.prev, false)})` : p.type === 'weight' ? `Heaviest ${fmtLb(p.value)} (prev ${fmtLb(p.prev, false)})` : `${p.value} reps (prev ${p.prev})`);
function RecentPrs({ summary, today }) {
  const app = useApp(); const ex = app.dv.exercises();
  const list = summary.recentPrs || [];
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, 5);
  return html`<${Section} title="Recent PRs" meta="Last 28 days">
    ${list.length ? html`<div class="card flush"><${List}>${shown.map((p) => html`<${ListRow} key=${p.date + p.exerciseId + p.type}
        title=${exName(ex.get(p.exerciseId), p.exerciseId)} meta=${prText(p)}
        trail=${html`<span class="xs muted">${relDay(p.date, today)}</span>`}
        onClick=${() => app.nav(p.sessionId ? '/train/session/' + p.sessionId : '/train/exercise/' + p.exerciseId)} />`)}
      </${List}></div>
      ${list.length > 5 ? html`<${Button} variant="ghost" size="sm" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${list.length}`}</${Button}>` : null}`
      : html`<div class="card tight small muted">No PRs in the last 28 days. A PR is a new best e1RM or heaviest weight for a lift (reps for bodyweight work); each lift's first session sets its baseline.</div>`}
  </${Section}>`;
}

/* ---------------------------------------------------------------- cardio */
function CardioCard({ today }) {
  const app = useApp();
  const [metric, setMetric] = useState('watts');
  const d = useAnalytics(() => {
    const hist = cardioHistory(app.dv);
    if (!hist.length) return { hist };
    const counts = new Map(); for (const h of hist) if (h.exerciseId) counts.set(h.exerciseId, (counts.get(h.exerciseId) || 0) + 1);
    const topId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const mine = hist.filter((h) => h.exerciseId === topId);
    const byDate = new Map();
    for (const h of mine) { const cur = byDate.get(h.date) || { date: h.date, watts: [], eff: [], dur: 0 }; if (isNum(h.avgWatts)) cur.watts.push(h.avgWatts); if (isNum(h.efficiency)) cur.eff.push(h.efficiency); cur.dur += h.durationMin || 0; byDate.set(h.date, cur); }
    const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-40).map((x) => ({ date: x.date, watts: x.watts.length ? mean(x.watts) : null, eff: x.eff.length ? mean(x.eff) : null, dur: x.dur }));
    const since = addDays(today, -27), prior = addDays(today, -55);
    const avg = (from, to, k) => { const v = mine.filter((h) => h.date >= from && h.date <= to).map((h) => h[k]).filter(isNum); return v.length ? mean(v) : null; };
    return {
      hist, topId, days, n: mine.length,
      w28: avg(since, today, 'avgWatts'), wPrev: avg(prior, addDays(since, -1), 'avgWatts'),
      e28: avg(since, today, 'efficiency'), ePrev: avg(prior, addDays(since, -1), 'efficiency'),
      min28: hist.filter((h) => h.date >= since).reduce((s, h) => s + (h.durationMin || 0), 0),
      recent: hist.slice(-5).reverse(),
    };
  }, [today]);
  if (!d) return null;
  if (!d.hist.length) {
    return html`<${Section} title="Cardio"><${Empty} title="No cardio logged yet" action=${html`<${Button} icon="bike" onClick=${() => openCardioLog(app, {})}>Log cardio</${Button}>`}>
      Log duration, average watts and heart rate for each ride. Power trends and efficiency (W per bpm) appear after a few sessions.</${Empty}></${Section}>`;
  }
  const ex = app.dv.exercises(); const name = exName(ex.get(d.topId), d.topId);
  const pct = (a, b) => (isNum(a) && isNum(b) && b > 0 ? signed(((a - b) / b) * 100, 1) + '% vs prior' : 'no prior data');
  const series = metric === 'eff'
    ? [{ key: 'eff', label: 'W per bpm', points: d.days.map((x) => ({ x: x.date, y: isNum(x.eff) ? round(x.eff, 3) : null })) }]
    : [{ key: 'w', label: 'Avg power (W)', points: d.days.map((x) => ({ x: x.date, y: isNum(x.watts) ? round(x.watts, 0) : null })) }];
  return html`<${Section} title="Cardio" meta=${`${name} · ${plural(d.n, 'session')}`}>
    <${Card}>
      <div class="grid three">
        <${Stat} label="Avg power, 28 d" value=${isNum(d.w28) ? fmtNum(d.w28) : '—'} unit="W" sub=${pct(d.w28, d.wPrev)} />
        <${Stat} label="Efficiency, 28 d" value=${isNum(d.e28) ? fmtNum(d.e28, 2) : '—'} unit="W/bpm" sub=${pct(d.e28, d.ePrev)} />
        <${Stat} label="Cardio, 28 d" value=${fmtNum(d.min28)} unit="min" sub="All exercises" />
      </div>
      <div class="tr-chart-head"><span class="small strong dim ellipsis">${name}</span>
        <${Segmented} value=${metric} onValue=${setMetric} label="Cardio metric" options=${[{ value: 'watts', label: 'Power' }, { value: 'eff', label: 'Efficiency' }, { value: 'dur', label: 'Duration' }]} /></div>
      ${metric === 'dur'
        ? html`<${BarChart} data=${d.days.map((x) => ({ x: x.date, y: x.dur }))} height=${150} yFormat=${(v) => fmtNum(v) + ''} color="var(--s3)" />`
        : html`<${LineChart} series=${series} height=${160} yFormat=${metric === 'eff' ? (v) => fmtNum(v, 2) : (v) => fmtNum(v)} />`}
      <div class="xs muted" style="margin-top:4px">${metric === 'eff' ? 'Average power ÷ average heart rate. Higher = more output per heartbeat (aerobic fitness).' : metric === 'dur' ? 'Minutes per day.' : 'Average watts per ride.'}</div>
    </${Card}>
    <div class="card flush"><div class="table-wrap"><table class="data tr-ctable">
      <thead><tr><th>Recent</th><th class="num">Min</th><th class="num hide-sm">Mi</th><th class="num">W</th><th class="num">HR</th><th class="num hide-sm">kcal</th><th class="num">W/bpm</th></tr></thead>
      <tbody>${d.recent.map((h, i) => html`<tr key=${h.sessionId + i} class="tr-row-link" tabIndex="0" onClick=${() => app.nav('/train/session/' + h.sessionId)} onKeyDown=${(e) => { if (e.key === 'Enter') app.nav('/train/session/' + h.sessionId); }}>
        <td><span class="mono">${fmtDate(h.date, { dow: false })}</span>${h.exerciseId !== d.topId ? html`<div class="xs muted">${exName(ex.get(h.exerciseId), h.exerciseId)}</div>` : null}</td>
        <td class="num">${isNum(h.durationMin) ? fmtNum(h.durationMin) : '—'}</td>
        <td class="num hide-sm">${isNum(h.distanceMi) ? fmtNum(h.distanceMi, 1) : '—'}</td>
        <td class="num">${isNum(h.avgWatts) ? fmtNum(h.avgWatts) : '—'}</td>
        <td class="num">${isNum(h.avgHr) ? fmtNum(h.avgHr) : '—'}</td>
        <td class="num hide-sm">${isNum(h.kcal) ? fmtNum(h.kcal) : '—'}</td>
        <td class="num">${isNum(h.efficiency) ? fmtNum(h.efficiency, 2) : '—'}</td>
      </tr>`)}</tbody></table></div></div>
  </${Section}>`;
}

/* --------------------------------------------------------------- history */
function History({ wide, today }) {
  const app = useApp();
  const [n, setN] = useState(8);
  const rows = useAnalytics(() => {
    const prc = prCountBySession(app.dv);
    return app.dv.allSessions().slice().reverse().map((s) => ({ s, st: sessionStats(s), prs: prc.get(s), w: linkedWorkout(app, s) }));
  }, []) || [];
  const shown = rows.slice(0, n);
  const go = (s) => app.nav('/train/session/' + s.id);
  const more = rows.length > n ? html`<${Button} variant="ghost" block onClick=${() => setN(n + 12)}>Show more (${rows.length - n} older)</${Button}>` : null;
  const metaOf = ({ s, st }) => [
    st.durationMin != null ? fmtDur(st.durationMin) : s.endAt ? null : 'in progress',
    st.workingSets ? plural(st.workingSets, 'set') : null,
    st.volumeLb ? fmtLb(st.volumeLb) : null,
    st.cardioCount ? `${fmtNum(st.cardioMin)} min cardio` : null,
    isNum(s.rpe) ? 'RPE ' + s.rpe : null,
  ].filter(Boolean).map(nb).join(' · ');
  return html`<${Section} title="Session history" meta=${plural(rows.length, 'session')}>
    ${wide ? html`<div class="card flush"><div class="table-wrap"><table class="data tr-hist">
        <thead><tr><th>Date</th><th>Session</th><th class="num">Time</th><th class="num">Sets</th><th class="num">Volume</th><th class="num">Cardio</th><th class="num">PRs</th><th class="num">Strain</th></tr></thead>
        <tbody>${shown.map(({ s, st, prs, w }) => html`<tr key=${s.id} class="tr-row-link" onClick=${() => go(s)} tabIndex="0" onKeyDown=${(e) => { if (e.key === 'Enter') go(s); }}>
          <td><span class="mono">${fmtDate(s.date, { dow: false })}</span> <span class="muted xs">${DOW[dayOfWeek(s.date)]}</span></td>
          <td class="tr-hist-name"><span class="ellipsis">${s.name || 'Workout'}</span>${s.endAt ? null : html` <${Pill} tone="accent">Open</${Pill}>`}</td>
          <td class="num">${st.durationMin != null ? fmtDur(st.durationMin) : '—'}</td>
          <td class="num">${st.workingSets || '—'}</td>
          <td class="num">${st.volumeLb ? fmtLb(st.volumeLb, false) : '—'}</td>
          <td class="num">${st.cardioCount ? fmtNum(st.cardioMin) + ' min' : '—'}</td>
          <td class="num">${prs ? html`<span class="tr-pr">${prs}</span>` : '—'}</td>
          <td class="num">${w && isNum(w.strain) ? fmtNum(w.strain, 1) : '—'}</td>
        </tr>`)}</tbody></table></div></div>`
      : html`<div class="card flush"><${List}>${shown.map((r) => html`<${ListRow} key=${r.s.id}
          lead=${html`<div class="tr-date"><span>${MONTHS[Number(r.s.date.slice(5, 7)) - 1]}</span><b>${Number(r.s.date.slice(8))}</b></div>`}
          title=${html`${r.s.name || 'Workout'}${r.s.endAt ? null : html` <${Pill} tone="accent">Open</${Pill}>`}`}
          meta=${DOW[dayOfWeek(r.s.date)] + ' · ' + (metaOf(r) || 'no sets logged')}
          trail=${r.prs || (r.w && isNum(r.w.strain)) ? html`<div class="tr-hist-trail">${r.prs ? html`<span class="tr-pr">${r.prs} PR</span>` : null}${r.w && isNum(r.w.strain) ? html`<span class="xs muted mono">Strain ${fmtNum(r.w.strain, 1)}</span>` : null}</div>` : null}
          onClick=${() => go(r.s)} />`)}</${List}></div>`}
    ${more}
  </${Section}>`;
}
