// Insights › Overview: goal KPIs vs the previous period, the strongest patterns, and data coverage.
import { html } from '../../../vendor/preact-htm.js';
import { Card, Pill, Button, Icon } from '../../kit.js';
import {
  buildDaily, goalProjection, strengthSummary, exerciseHistory, cardioHistory, nutritionAdherence,
  findDrivers, dataSufficiency, streaks, mean,
} from '../../../analytics/index.js';
import { addDays, fmtNum, fmtDur, fmtDate, isNum, round, signed } from '../../../core/util.js';
import { before, avgOf, nOf, deltaInfo, bestIn, medianChange, strengthIndex, pctChange, plural, driverSentence, fmtQ } from '../../parts/insights-logic.js';
import { useInsight, Kpi, SectionEmpty, SourceButton, AssocNote, SectionSkeleton } from '../../parts/insights-kit.js';

// Drivers need ≥ 21 paired days: the overview looks at 90 days (or the range when longer), from the first
// log at the earliest. The plain 90-day result is shared with weekly stats / the AI context pack (same key).
function driverFrom(p, today, dataStart) {
  let from = p.days > 90 ? p.from : addDays(today, -89);
  if (dataStart && dataStart > from) from = dataStart > today ? today : dataStart;
  return from;
}
function drivers(dv, from, today) {
  if (from === addDays(today, -89)) return dv.memo('corr:drivers90:' + today, () => findDrivers(buildDaily(dv, from, today)));
  return findDrivers(buildDaily(dv, from, today));
}

function compute(dv, p, today, dataStart) {
  const rows = buildDaily(dv, p.from, p.to);
  const prev = p.prevFrom ? buildDaily(dv, p.prevFrom, p.prevTo) : [];
  const done = before(rows, today);
  const vs = `vs prior ${p.prevDays}d`;

  // Weight: trend, change over the period, 28-day rate vs goal rate, ETA into the goal range.
  const proj = goalProjection(dv, today);
  const trendVals = rows.map((r) => r.weightTrendLb);
  const firstT = trendVals.find(isNum), lastT = [...trendVals].reverse().find(isNum);
  const change = isNum(firstT) && isNum(lastT) ? round(lastT - firstT, 1) : null;
  const below = isNum(proj.goalLow) && isNum(lastT) && lastT < proj.goalLow;
  const above = isNum(proj.goalHigh) && isNum(lastT) && lastT > proj.goalHigh;
  const wantUp = below ? true : above ? false : null;
  const weight = {
    value: isNum(proj.currentTrendLb) ? proj.currentTrendLb : lastT, change, n: nOf(rows, 'weightLb'),
    delta: isNum(change) ? { text: `${signed(change, 1)} lb over ${p.days}d`, tone: wantUp == null || change === 0 ? null : (change > 0) === wantUp ? 'good' : 'bad' } : null,
    proj, values: trendVals,
  };

  // Strength: median % change of the top lifts' best e1RM, this period vs the previous one.
  const ss = strengthSummary(dv, today);
  const lifts = ss.topLifts.filter((l) => l.metric === 'e1rm');
  const hists = lifts.map((l) => exerciseHistory(dv, l.exerciseId).filter((h) => h.date <= today));
  const items = hists.map((h, i) => ({ name: lifts[i].name, cur: bestIn(h, p.from, p.to), prev: p.prevFrom ? bestIn(h, p.prevFrom, p.prevTo) : null }));
  const mc = medianChange(items);
  const top = items.map((x) => ({ ...x, pct: pctChange(x.cur, x.prev) })).filter((x) => isNum(x.pct)).sort((a, b) => b.pct - a.pct)[0] || null;
  const sessions = dv.range('sessions', p.from, p.to).length;
  const strength = { median: mc.median, n: mc.n, lifts: lifts.length, top, sessions, values: strengthIndex(hists, p.from, p.to).map((x) => x.y) };

  // Endurance: the most-logged cardio exercise — avg watts and efficiency (W/bpm) vs the previous period.
  const cardio = cardioHistory(dv).filter((c) => c.date <= today);
  const inP = cardio.filter((c) => c.date >= p.from && c.date <= p.to);
  const counts = new Map(); for (const c of inP) counts.set(c.exerciseId, (counts.get(c.exerciseId) || 0) + 1);
  const mainId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const mainEx = mainId ? dv.exercises().get(mainId) : null;
  const cur = inP.filter((c) => c.exerciseId === mainId);
  const prevC = p.prevFrom ? cardio.filter((c) => c.exerciseId === mainId && c.date >= p.prevFrom && c.date <= p.prevTo) : [];
  const w = mean(cur.map((c) => c.avgWatts)), wPrev = mean(prevC.map((c) => c.avgWatts));
  const eff = mean(cur.map((c) => c.efficiency)), effPrev = mean(prevC.map((c) => c.efficiency));
  const endurance = { name: mainEx ? mainEx.name : null, watts: w, n: cur.length, total: inP.length, delta: deltaInfo(w, wPrev, { pct: true, dp: 1, label: vs }), eff, effPct: pctChange(eff, effPrev), values: cur.map((c) => c.avgWatts) };

  // Recovery and sleep (WHOOP).
  const rec = avgOf(rows, 'recovery');
  const recovery = {
    avg: rec, n: nOf(rows, 'recovery'), delta: deltaInfo(rec, avgOf(prev, 'recovery'), { suffix: ' pts', label: vs }),
    green: rows.filter((r) => r.recovery >= 67).length, red: rows.filter((r) => isNum(r.recovery) && r.recovery <= 33).length, values: rows.map((r) => r.recovery),
  };
  const sl = avgOf(rows, 'sleepMin'), need = avgOf(rows, 'sleepNeedMin');
  const sleepD = deltaInfo(sl, avgOf(prev, 'sleepMin'));
  const sleep = { avg: sl, need, n: nOf(rows, 'sleepMin'), delta: sleepD ? { ...sleepD, text: `${sleepD.value >= 0 ? '+' : '−'}${fmtDur(Math.abs(sleepD.value))} ${vs}` } : null, values: rows.map((r) => r.sleepMin) };

  // Nutrition (complete past days only).
  const na = nutritionAdherence(dv, p.from, p.to);
  const naPrev = p.prevFrom ? nutritionAdherence(dv, p.prevFrom, p.prevTo) : null;
  const protein = { rate: na.proteinHitRate, days: na.days, hits: na.proteinHits, avg: na.avgProtein, vsTarget: na.avgProteinVsTarget, delta: deltaInfo(na.proteinHitRate, naPrev && naPrev.proteinHitRate, { suffix: ' pts', label: vs }), values: done.map((r) => r.proteinG) };

  // Plan and execution (complete days).
  const plan = { avg: avgOf(done, 'planAdherence'), n: nOf(done, 'planAdherence'), delta: deltaInfo(avgOf(done, 'planAdherence'), avgOf(prev, 'planAdherence'), { suffix: ' pts', label: vs }), values: done.map((r) => r.planAdherence) };
  const ex = avgOf(done, 'executionScore');
  const execution = { avg: ex, n: nOf(done, 'executionScore'), perfect: done.filter((r) => r.perfect === true).length, streak: streaks(dv, today), delta: deltaInfo(ex, avgOf(prev, 'executionScore'), { suffix: ' pts', label: vs }), values: done.map((r) => r.executionScore) };

  // Patterns + sufficiency + coverage.
  const dFrom = driverFrom(p, today, dataStart);
  const dRows = buildDaily(dv, dFrom, today);
  const found = drivers(dv, dFrom, today);
  const suff = dataSufficiency(dRows);
  const coverage = {
    whoop: nOf(rows, (r) => (isNum(r.recovery) || isNum(r.sleepMin) ? 1 : null)),
    meals: nOf(rows, 'mealsCount'),
    weighins: nOf(rows, 'weightLb'),
    sessions: sessions + dv.range('whoopWorkouts', p.from, p.to).filter((wk) => !dv.range('sessions', wk.date, wk.date).some((s) => s.whoopWorkoutId === wk.id)).length,
    checkins: nOf(rows, (r) => (isNum(r.energy) || isNum(r.dayRating) || isNum(r.mood) ? 1 : null)),
    plan: nOf(rows, 'planMin'),
    calendar: dv.hasCalendar() ? nOf(rows, 'meetingMin') : null,
    doses: dv.range('doses', p.from, p.to).filter((d) => !d.skipped).length,
    labs: dv.labs().length,
  };
  return { weight, strength, endurance, recovery, sleep, protein, plan, execution, drivers: diverse(found, 3), driverCount: found.length, driverDays: dRows.length, suff, coverage };
}

// Strongest patterns first, one per behavior before a behavior repeats.
function diverse(list, n) {
  const out = []; const seen = new Set();
  for (const d of list) if (out.length < n && !seen.has(d.behavior)) { seen.add(d.behavior); out.push(d); }
  for (const d of list) if (out.length < n && !out.includes(d)) out.push(d);
  return out;
}

export default function Overview({ app, today, period, dataStart, query }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period, today, dataStart), [period.from, period.to, period.prevFrom, today, dataStart]);
  if (!d) return html`<${SectionSkeleton} />`;
  const nav = (s) => app.nav('/insights/' + s + (query && query.r ? '?r=' + query.r : ''));
  const { weight: w, strength: s, endurance: e, recovery: r, sleep: sl, protein: pr, plan: pl, execution: ex } = d;
  const pRate = w.proj;

  const weightSub = !isNum(w.value) ? 'Log weigh-ins to see a trend'
    : !isNum(pRate.goalLow) && !isNum(pRate.goalHigh) ? 'Set a goal range in Settings → Profile'
    : pRate.onTrack === true && pRate.weeksToGoal === 0 ? `In goal range ${fmtNum(pRate.goalLow)}–${fmtNum(pRate.goalHigh)} lb`
    : `${isNum(pRate.ratePerWeek) ? signed(pRate.ratePerWeek, 2) + ' lb/wk' : 'Rate pending'} vs ${isNum(pRate.goalRate) ? signed(pRate.goalRate, 2) : '—'} goal${pRate.etaDate ? ' · ETA ' + fmtDate(pRate.etaDate, { dow: false, year: pRate.etaDate.slice(0, 4) !== today.slice(0, 4) }) : ''}`;

  const tiles = html`<div class="ins-kpis">
    <${Kpi} label="Weight trend" value=${isNum(w.value) ? fmtNum(w.value, 1) : null} unit="lb" delta=${w.delta} sub=${weightSub} values=${w.values} onClick=${() => nav('body')} empty="No weigh-ins in range" />
    <${Kpi} label="Strength (e1RM)" value=${isNum(s.median) ? signed(s.median, 1) + '%' : null}
      delta=${isNum(s.median) ? { text: `${plural(s.n, 'lift')} vs prior ${period.prevDays}d`, tone: s.median > 0 ? 'good' : s.median < 0 ? 'bad' : null } : null}
      empty=${s.sessions ? 'Needs a prior period of sessions' : 'No sessions in range'}
      sub=${s.top ? `Median change · best ${s.top.name} ${signed(s.top.pct, 1)}%` : s.sessions ? `${plural(s.sessions, 'session')} in range` : 'Log sessions to track e1RM'} values=${s.values} onClick=${() => nav('strength')} />
    <${Kpi} label="Endurance · power" value=${isNum(e.watts) ? fmtNum(e.watts) : null} unit="W avg" delta=${e.delta}
      empty=${e.n ? 'No prior period' : 'No cardio in range'}
      sub=${e.name ? `${e.name}${isNum(e.eff) ? ` · ${fmtNum(e.eff, 2)} W/bpm${isNum(e.effPct) ? ` (${signed(e.effPct, 1)}%)` : ''}` : ''}` : 'Log cardio with watts and heart rate'} values=${e.values} onClick=${() => nav('cardio')} />
    <${Kpi} label="Recovery" value=${isNum(r.avg) ? fmtNum(r.avg) : null} unit="% avg" delta=${r.delta} empty=${r.n ? 'No prior period' : 'No WHOOP data'}
      sub=${r.n ? `${r.green} green · ${r.red} red of ${plural(r.n, 'day')}` : 'Filled by WHOOP'} values=${r.values} onClick=${() => nav('recovery')} />
    <${Kpi} label="Sleep" value=${isNum(sl.avg) ? fmtDur(sl.avg) : null} unit="avg" delta=${sl.delta} empty=${sl.n ? 'No prior period' : 'No WHOOP sleep'}
      sub=${isNum(sl.avg) && isNum(sl.need) ? `${fmtDur(Math.abs(sl.need - sl.avg))} ${sl.need > sl.avg ? 'below' : 'above'} need (${fmtDur(sl.need)})` : 'Filled by WHOOP'} values=${sl.values} onClick=${() => nav('sleep')} />
    <${Kpi} label="Protein target hit" value=${isNum(pr.rate) ? fmtNum(pr.rate) : null} unit="% of days" delta=${pr.delta} empty=${pr.days ? 'No prior period' : 'No complete meal days'}
      sub=${pr.days ? `Avg ${fmtNum(pr.avg)} g · ${pr.hits}/${pr.days} days${isNum(pr.vsTarget) ? ` · ${signed(pr.vsTarget)} g vs target` : ''}` : 'Log every meal of a day to count it'} values=${pr.values} onClick=${() => nav('nutrition')} />
    <${Kpi} label="Plan adherence" value=${isNum(pl.avg) ? fmtNum(pl.avg) : null} unit="% avg" delta=${pl.delta} empty=${pl.n ? 'No prior period' : 'No planned days'}
      sub=${pl.n ? `${plural(pl.n, 'planned day')}` : 'Plan blocks and mark them done'} values=${pl.values} onClick=${() => nav('schedule')} />
    <${Kpi} label="Execution score" value=${isNum(ex.avg) ? fmtNum(ex.avg) : null} unit="avg" delta=${ex.delta} empty=${ex.n ? 'No prior period' : 'No scored days'}
      sub=${ex.n ? (ex.streak.current ? `Perfect days in a row: ${ex.streak.current}` : `${plural(ex.perfect, 'perfect day')} · longest run ${ex.streak.longest}`) : 'Daily standards on Today'} values=${ex.values} onClick=${() => nav('weekly')} />
  </div>`;

  return html`<div class="stack" data-ms=${ms}>
    ${!dataStart ? html`<${SectionEmpty} icon="insights" title="Insights build from your logs"
      text="Nothing is logged yet. Each view fills from one or two sources — start with the ones below; trends appear after a few days and patterns after 21 paired days."
      points=${['Meals (photos) → calories, protein, timing', 'Weigh-ins → trend, rate vs goal, TDEE', 'Workouts → e1RM progression, volume, PRs', 'WHOOP → recovery, HRV, sleep; drivers after 3 weeks']}
      sources=${['meals', 'weighins', 'sessions', 'whoop']} />` : tiles}
    <div class="ins-grid two">
      <${DriversCard} d=${d} nav=${nav} today=${today} />
      <${CoverageCard} c=${d.coverage} days=${period.days} />
    </div>
  </div>`;
}

function DriversCard({ d, nav, today }) {
  const ready = d.suff.pairedDays >= d.suff.minN;
  return html`<${Card} title="What moves your numbers" meta=${`${d.driverDays} days`}>
    ${!ready ? html`<div class="stack sm">
        <div class="small">Correlations unlock after ${d.suff.minN} paired days${d.suff.readyAt ? html` — about <b>${fmtDate(d.suff.readyAt, { dow: false, year: d.suff.readyAt.slice(0, 4) !== today.slice(0, 4) })}</b>` : ''}.</div>
        <div class="xs muted">${d.suff.pairedDays} of ${d.suff.minN} so far. A paired day has a logged behavior (meals, caffeine, bedtime, strain, meetings…) and the next morning's recovery or sleep.</div>
      </div>`
      : d.drivers.length ? html`<div class="ins-list">${d.drivers.map((x) => html`<div class="ins-row" style="align-items:flex-start">
          <span class="ins-dot" style=${`margin-top:7px;background:${x.direction === 'helps' ? 'var(--good)' : 'var(--bad)'}`}></span>
          <div class="grow stack xs"><div class="ins-sentence">${driverSentence(x)}</div>
            <div class="ins-tags"><${Pill}>${x.strength}</${Pill}><span class="tag">n=${x.n}</span><span class="tag">${fmtQ(x.q)}</span></div></div></div>`)}
        </div>${d.driverCount > 3 ? html`<div class="xs muted" style="margin-top:6px">${d.driverCount - 3} more in Drivers.</div>` : null}`
      : html`<div class="small dim">No pattern passed the multiple-testing correction yet (${d.suff.pairedDays} paired days). More varied days make weaker effects detectable.</div>`}
    <div class="row between" style="margin-top:10px;gap:8px"><${AssocNote} />
      <${Button} size="sm" variant="ghost" onClick=${() => nav('drivers')}>All patterns<${Icon} name="chevronRight" size=${14} /></${Button}></div>
  </${Card}>`;
}

const COVER = [
  ['whoop', 'WHOOP recovery / sleep', 'days'],
  ['meals', 'Meals logged', 'days'],
  ['weighins', 'Weigh-ins', 'days'],
  ['sessions', 'Workouts', 'sessions'],
  ['checkins', 'Check-ins', 'days'],
  ['plan', 'Planned days', 'days'],
  ['calendar', 'Calendar', 'days'],
  ['doses', 'Doses logged', 'doses'],
  ['labs', 'Lab panels', 'total'],
];
function CoverageCard({ c, days }) {
  return html`<${Card} title="Data coverage" meta=${`${days} days`}>
    <div class="ins-list">${COVER.map(([key, label, unit]) => {
      const v = c[key];
      const missing = v == null || v === 0;
      const text = key === 'calendar' && v == null ? 'Not connected' : unit === 'days' ? `${fmtNum(v)} / ${days} days` : unit === 'total' ? plural(v, 'panel') : `${fmtNum(v)} ${unit}`;
      return html`<div class="ins-row" style="padding:7px 0">
        <span class="ins-dot" style=${`background:${missing ? 'var(--line-2)' : 'var(--good)'}`}></span>
        <div class="grow small">${label}</div>
        ${missing ? html`<${SourceButton} source=${key === 'calendar' ? 'calendar' : key} variant="ghost" />` : html`<span class="mono xs dim">${text}</span>`}
      </div>`;
    })}</div>
  </${Card}>`;
}
