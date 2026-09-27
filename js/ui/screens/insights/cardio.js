// Insights › Cardio: per cardio exercise — average power, efficiency (W per bpm), duration and the session
// log; WHOOP workouts add strain and heart-rate zone minutes when connected.
import { html, useState } from '../../../vendor/preact-htm.js';
import { Card, Chips } from '../../kit.js';
import { BarChart, StackedBars } from '../../charts.js';
import { cardioHistory, mean, linreg } from '../../../analytics/index.js';
import { weekStart, fmtNum, fmtDur, fmtDate, isNum, round } from '../../../core/util.js';
import { deltaInfo, pctChange, fmtSigned, plural } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, StatGrid, SectionEmpty, SectionSkeleton, SourceButton } from '../../parts/insights-kit.js';
import { TrendChart } from '../../parts/insights-charts.js';
import { dayNum } from '../../../analytics/dataview.js';

// WHOOP zonesMin[0..5] = zone 0 (below 50% max HR) … zone 5; grouped into three bands (≤ 4 series).
const ZONES = [{ key: 'easy', label: 'Zone 1–2', idx: [1, 2] }, { key: 'mod', label: 'Zone 3', idx: [3] }, { key: 'hard', label: 'Zone 4–5', idx: [4, 5] }];

function compute(dv, p, today) {
  const ex = dv.exercises();
  const all = cardioHistory(dv).filter((c) => c.date <= today);
  const inP = all.filter((c) => c.date >= p.from && c.date <= p.to);
  const counts = new Map(); for (const c of inP) counts.set(c.exerciseId, (counts.get(c.exerciseId) || 0) + 1);
  const exercises = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n, name: ex.get(id)?.name || id || 'Cardio' }));
  const prev = p.prevFrom ? all.filter((c) => c.date >= p.prevFrom && c.date <= p.prevTo) : [];
  const wos = dv.range('whoopWorkouts', p.from, p.to).filter((w) => w.scoreState !== 'UNSCORABLE');
  const weeks = new Map();
  const sports = new Map();
  for (const w of wos) {
    const wk = weekStart(w.date);
    if (!weeks.has(wk)) weeks.set(wk, { easy: 0, mod: 0, hard: 0 });
    const z = Array.isArray(w.zonesMin) ? w.zonesMin : [];
    for (const g of ZONES) for (const i of g.idx) if (isNum(z[i])) weeks.get(wk)[g.key] += z[i];
    const s = sports.get(w.sport || 'Workout') || { sport: w.sport || 'Workout', n: 0, strain: [], min: [] };
    s.n++; if (isNum(w.strain)) s.strain.push(w.strain);
    const dur = (Date.parse(w.end) - Date.parse(w.start)) / 60000; if (isNum(dur) && dur > 0) s.min.push(dur);
    sports.set(s.sport, s);
  }
  const zoneTot = { easy: 0, mod: 0, hard: 0 }; for (const v of weeks.values()) for (const k of Object.keys(zoneTot)) zoneTot[k] += v[k];
  return {
    inP, prev, exercises, total: inP.length,
    zoneWeeks: [...weeks.entries()].sort().map(([x, parts]) => ({ x, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)])) })),
    zoneTot, nWeeksZ: weeks.size, wos: wos.length,
    sports: [...sports.values()].map((s) => ({ sport: s.sport, n: s.n, strain: mean(s.strain), min: mean(s.min) })).sort((a, b) => b.n - a.n),
  };
}

export default function Cardio({ app, today, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period, today), [period.from, period.to, period.prevFrom, today]);
  const [pick, setPick] = useState(null);
  if (!d) return html`<${SectionSkeleton} />`;
  if (!d.total && !d.wos) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="bike" title="No cardio in this range"
      text="Log cardio with duration, average watts and average heart rate (stationary bike, rower…). WHOOP adds strain and heart-rate zones."
      points=${['Average power per session and its trend', 'Efficiency: watts per heartbeat — more power at the same heart rate', 'Weekly minutes in heart-rate zones (WHOOP)']}
      sources=${['cardio', 'whoop']} /></div>`;
  }
  const id = pick && d.exercises.some((e) => e.id === pick) ? pick : d.exercises[0]?.id;
  const cur = d.inP.filter((c) => c.exerciseId === id).sort((a, b) => (a.date < b.date ? -1 : 1));
  const prev = d.prev.filter((c) => c.exerciseId === id);
  const name = d.exercises.find((e) => e.id === id)?.name || 'Cardio';
  const w = mean(cur.map((c) => c.avgWatts)), wPrev = mean(prev.map((c) => c.avgWatts));
  const eff = mean(cur.map((c) => c.efficiency)), effPrev = mean(prev.map((c) => c.efficiency));
  const dur = mean(cur.map((c) => c.durationMin));
  const totalMin = cur.reduce((s, c) => s + (isNum(c.durationMin) ? c.durationMin : 0), 0);
  const vs = period.prevDays ? `vs prior ${period.prevDays}d` : '';
  const wPts = cur.filter((c) => isNum(c.avgWatts));
  const fit = wPts.length >= 3 ? linreg(wPts.map((c) => dayNum(c.date)), wPts.map((c) => c.avgWatts)) : null;
  const perWeek = fit && isNum(fit.slope) ? fit.slope * 7 : null;
  const effPts = cur.filter((c) => isNum(c.efficiency));
  const firstE = effPts[0], lastE = effPts[effPts.length - 1];
  const z = d.zoneTot; const zSum = z.easy + z.mod + z.hard;
  return html`<div class="stack" data-ms=${ms}>
    ${d.exercises.length > 1 ? html`<${Chips} options=${d.exercises.map((e) => ({ value: e.id, label: `${e.name} · ${e.n}` }))} value=${id} onValue=${setPick} />` : null}
    ${d.total ? html`<${StatGrid} items=${[
      { label: `${name} sessions`, value: fmtNum(cur.length), sub: `${fmtNum(cur.length / (period.days / 7), 1)} per week · ${fmtDur(totalMin)} total` },
      { label: 'Avg power', value: isNum(w) ? fmtNum(w) : '—', unit: 'W', delta: deltaInfo(w, wPrev, { pct: true, dp: 1, label: vs }) },
      { label: 'Efficiency', value: isNum(eff) ? fmtNum(eff, 2) : '—', unit: 'W/bpm', delta: deltaInfo(eff, effPrev, { pct: true, dp: 1, label: vs }) },
      { label: 'Avg duration', value: isNum(dur) ? fmtDur(dur) : '—', sub: `${plural(d.total, 'cardio session')} in range` },
    ]} />` : null}
    <div class="ins-grid two">
    ${d.total ? html`
      <${ChartCard} title=${`Average power · ${name}`} unit="W" n=${wPts.length} nUnit="sessions" source="cardio" empty=${!wPts.length} emptyText="No sessions with average watts in this range."
        takeaway=${wPts.length ? `Avg ${fmtNum(w)} W${isNum(perWeek) ? `; trend ${fmtSigned(perWeek, 1)} W per week` : ''}; first → last ${fmtNum(wPts[0].avgWatts)} → ${fmtNum(wPts[wPts.length - 1].avgWatts)} W.` : null}>
        <${TrendChart} series=${[{ key: 'w', label: 'Avg watts', points: wPts.map((c) => ({ x: c.date, y: c.avgWatts })), style: 'line+dots' }]} tipFormat=${(v) => fmtNum(v) + ' W'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title=${`Efficiency · ${name}`} unit="W per bpm" n=${effPts.length} nUnit="sessions" source="cardio" empty=${!effPts.length} emptyText="Efficiency needs both average watts and average heart rate."
        takeaway=${effPts.length ? `Avg ${fmtNum(eff, 2)} W/bpm${effPts.length > 1 ? `; ${fmtNum(firstE.efficiency, 2)} → ${fmtNum(lastE.efficiency, 2)} (${fmtSigned(pctChange(lastE.efficiency, firstE.efficiency), 1)}%)` : ''}. More watts at the same heart rate is better aerobic fitness.` : null}>
        <${TrendChart} series=${[{ key: 'e', label: 'W/bpm', points: effPts.map((c) => ({ x: c.date, y: c.efficiency })), style: 'line+dots' }]} yFormat=${(v) => fmtNum(v, 2)} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title=${`Duration · ${name}`} unit="min per session" n=${cur.length} nUnit="sessions" source="cardio" empty=${!cur.length}
        takeaway=${cur.length ? `Avg ${fmtDur(dur)} per session, ${fmtDur(totalMin / Math.max(1, period.days / 7))} per week.` : null}>
        <${BarChart} data=${cur.map((c) => ({ x: c.date, y: c.durationMin, label: `${fmtDate(c.date)} · ${fmtDur(c.durationMin)}` }))} yFormat=${(v) => fmtNum(v)} height=${150} />
      </${ChartCard}>` : html`<${Card} title="Logged cardio"><div class="row between wrap" style="gap:8px"><span class="small dim">No cardio entries with watts or duration in this range — only WHOOP workouts.</span><${SourceButton} source="cardio" /></div></${Card}>`}
      <${ChartCard} title="Heart-rate zones" unit="min per week (WHOOP)" n=${d.wos} nUnit="workouts" source="whoop" empty=${!zSum}
        emptyText="No WHOOP workouts with heart-rate zones in this range."
        takeaway=${zSum ? `Zone 1–2 is ${Math.round((z.easy / zSum) * 100)}% of zone time: ${fmtNum(z.easy / Math.max(1, d.nWeeksZ))} min per week in zones 1–2 and ${fmtNum(z.hard / Math.max(1, d.nWeeksZ))} min in zones 4–5.` : null}>
        <${StackedBars} data=${d.zoneWeeks} keys=${ZONES.map((g) => ({ key: g.key, label: g.label }))} yFormat=${(v) => fmtNum(v)} height=${160} />
        ${d.sports.length ? html`<div class="ins-list" style="margin-top:4px">${d.sports.map((s) => html`<div class="ins-row" style="padding:7px 0">
            <div class="grow small">${s.sport}</div><span class="mono xs dim">${plural(s.n, 'workout')}</span>
            <span class="mono xs" style="min-width:86px;text-align:right">strain ${isNum(s.strain) ? fmtNum(s.strain, 1) : '—'}</span>
            <span class="mono xs dim hide-xs" style="min-width:60px;text-align:right">${isNum(s.min) ? fmtDur(s.min) : '—'}</span></div>`)}</div>` : null}
      </${ChartCard}>
    </div>
    ${cur.length ? html`
      <${Card} title=${`Session log · ${name}`} meta=${plural(cur.length, 'session')}>
        <div class="table-wrap"><table class="data ins-table">
          <thead><tr><th>Date</th><th class="num">Min</th><th class="num hide-xs">Miles</th><th class="num">W</th><th class="num">HR</th><th class="num">W/bpm</th></tr></thead>
          <tbody>${[...cur].reverse().slice(0, 14).map((c) => html`<tr><td>${fmtDate(c.date, { dow: false })}</td><td class="num">${fmtNum(c.durationMin)}</td>
            <td class="num hide-xs">${isNum(c.distanceMi) ? fmtNum(c.distanceMi, 1) : '—'}</td><td class="num">${isNum(c.avgWatts) ? fmtNum(c.avgWatts) : '—'}</td>
            <td class="num">${isNum(c.avgHr) ? fmtNum(c.avgHr) : '—'}</td><td class="num">${isNum(c.efficiency) ? fmtNum(c.efficiency, 2) : '—'}</td></tr>`)}</tbody>
        </table></div>
      </${Card}>` : null}
  </div>`;
}
