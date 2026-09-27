// Insights › Strength: e1RM of the top lifts (≤ 4 series, pick lifts, lb or % change), a progression
// table (status, slope %/week, n), weekly hard sets per muscle vs a general reference, total volume,
// and the PR timeline.
import { html, useState } from '../../../vendor/preact-htm.js';
import { Card, Pill, Button, Segmented, Chips, Disclosure } from '../../kit.js';
import { BarChart } from '../../charts.js';
import { buildDaily, exerciseHistory, progression, weeklyMuscleVolume, prs, mean, median } from '../../../analytics/index.js';
import { addDays, diffDays, weekStart, fmtNum, fmtDate, fmtCompact, isNum, round, signed } from '../../../core/util.js';
import { bucketRows, bestIn, medianChange, pctChange, deltaInfo, lastCompleteWeek, plural, fmtSigned } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, StatGrid, SectionEmpty, MeterRows, SectionSkeleton } from '../../parts/insights-kit.js';
import { TrendChart } from '../../parts/insights-charts.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const STATUS = { progressing: 'good', plateau: null, regressing: 'bad', insufficient: null };

function compute(dv, p, today) {
  const ex = dv.exercises();
  const sessions = dv.range('sessions', p.from, p.to);
  const freq = new Map();
  for (const s of sessions) for (const id of new Set((s.entries || []).map((e) => e && e.exerciseId).filter(Boolean))) freq.set(id, (freq.get(id) || 0) + 1);
  const weeks = Math.max(4, Math.min(26, Math.round(p.days / 7)));
  const lifts = [...freq.entries()].filter(([id]) => (ex.get(id)?.type || 'strength') === 'strength').sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id, n]) => {
    // Bodyweight lifts are tracked by reps: an e1RM of the added load alone (body mass excluded) would read
    // as a huge % jump whenever weight is added. progression() then regresses best reps.
    const bw = !!ex.get(id)?.bodyweight;
    const hist = exerciseHistory(dv, id).filter((h) => h.date <= p.to).map((h) => (bw ? { ...h, e1rm: null } : h));
    const inRange = hist.filter((h) => h.date >= p.from);
    const useE = inRange.some((h) => isNum(h.e1rm));
    const key = useE ? 'e1rm' : 'maxReps';
    const best = bestIn(hist, p.from, p.to, key);
    const prev = p.prevFrom ? bestIn(hist, p.prevFrom, p.prevTo, key) : null;
    const prog = progression(hist, { weeks });
    const last = inRange[inRange.length - 1];
    return {
      id, name: ex.get(id)?.name || id, muscle: ex.get(id)?.muscle || null, n, metric: useE ? 'e1rm' : 'reps', best, prev, change: pctChange(best, prev),
      status: prog.status, slope: prog.slopePctPerWeek, progN: prog.n, last,
      points: inRange.map((h) => ({ x: h.date, y: useE ? h.e1rm : h.maxReps })),
    };
  });
  const rows = buildDaily(dv, p.from, p.to);
  const volume = bucketRows(rows, 'sessionVolumeLb', { mode: 'week', agg: 'sum', fmt: (v) => fmtNum(v) + ' lb' });
  const sets = bucketRows(rows, 'sessionSets', { mode: 'week', agg: 'sum' });

  // Hard sets per muscle: average over the complete Monday weeks inside the range.
  // (No complete week in range yet → this week so far.)
  const lastWeek = lastCompleteWeek(today);
  const firstWeek = weekStart(p.from) === p.from ? p.from : addDays(weekStart(p.from), 7);
  const partialWeek = firstWeek > lastWeek;
  const vol = partialWeek ? weeklyMuscleVolume(dv, p.from, p.to) : weeklyMuscleVolume(dv, firstWeek, addDays(lastWeek, 6));
  const nWeeks = partialWeek ? 1 : diffDays(firstWeek, lastWeek) / 7 + 1;
  const refWeek = partialWeek ? weekStart(p.to) : lastWeek;
  const muscles = new Map();
  for (const v of vol) { const m = muscles.get(v.muscle) || { muscle: v.muscle, sets: 0, last: 0 }; m.sets += v.hardSets; if (v.week === refWeek) m.last = v.hardSets; muscles.set(v.muscle, m); }
  const perMuscle = [...muscles.values()].map((m) => ({ ...m, avg: round(m.sets / nWeeks, 1) })).sort((a, b) => b.avg - a.avg);

  const prList = prs(dv, { since: p.from }).filter((x) => x.date <= p.to).reverse();
  const loaded = lifts.filter((l) => l.metric === 'e1rm');
  const mc = medianChange(loaded.map((l) => ({ cur: l.best, prev: l.prev })));
  const weeksWithSets = sets.filter((b) => b.y > 0);
  return {
    lifts, loaded, sessions: sessions.length, volume, sets, perMuscle, nWeeks, partialWeek, prList, mc,
    setsPerWeek: weeksWithSets.length ? mean(sets.filter((b) => b.days === 7).map((b) => b.y)) ?? mean(weeksWithSets.map((b) => b.y)) : null,
    volPerWeek: mean(volume.filter((b) => b.days === 7 && isNum(b.y)).map((b) => b.y)),
    sessionsPrev: p.prevFrom ? dv.range('sessions', p.prevFrom, p.prevTo).length : null,
  };
}

export default function Strength({ app, today, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period, today), [period.from, period.to, period.prevFrom, today]);
  const [pick, setPick] = useState(null);
  const [scale, setScale] = useState(null);
  const [allPrs, setAllPrs] = useState(false);
  if (!d) return html`<${SectionSkeleton} />`;
  if (!d.sessions) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="train" title="No workouts in this range"
      text="Strength analytics come from logged sets (exercise, weight, reps). Log every working set; warm-ups can be marked as such."
      points=${['Estimated 1-rep max (e1RM) per lift over time', 'Progressing / plateau / regressing per lift with %/week', 'Weekly hard sets per muscle and total volume', 'A dated PR timeline']}
      sources=${['sessions']} /></div>`;
  }
  const options = d.loaded.map((l) => ({ value: l.id, label: l.name }));
  const chosen = (pick || d.loaded.slice(0, 4).map((l) => l.id)).filter((id) => d.loaded.some((l) => l.id === id));
  const sel = d.loaded.filter((l) => chosen.includes(l.id));
  const bests = sel.map((l) => l.best).filter(isNum);
  const autoScale = bests.length > 1 && Math.max(...bests) / Math.min(...bests) > 2.2 ? 'pct' : 'lb';
  const sc = scale || autoScale;
  const series = sel.map((l) => {
    const base = l.points.find((x) => isNum(x.y));
    return { key: l.id, label: l.name, style: 'line+dots', points: sc === 'pct' && base ? l.points.map((x) => ({ x: x.x, y: isNum(x.y) ? round((x.y / base.y - 1) * 100, 1) : null })) : l.points };
  });
  const change = sel.map((l) => { const f = l.points.find((x) => isNum(x.y)), z = [...l.points].reverse().find((x) => isNum(x.y)); return f && z && f !== z ? { name: l.name, pct: pctChange(z.y, f.y) } : null; }).filter(Boolean);
  const bestMover = change.sort((a, b) => b.pct - a.pct)[0];
  const togglePick = (ids) => setPick(ids.length > 4 ? ids.slice(-4) : ids.length ? ids : chosen);
  const vs = period.prevDays ? ` vs prior ${period.prevDays}d` : '';
  const prShown = allPrs ? d.prList : d.prList.slice(0, 12);
  const ex = app.dv.exercises();
  const progCounts = { progressing: 0, plateau: 0, regressing: 0 };
  for (const l of d.lifts) if (progCounts[l.status] != null) progCounts[l.status]++;
  const volWeeks = d.volume.filter((b) => isNum(b.y) && b.y > 0);
  const last4 = volWeeks.slice(-4).map((b) => b.y), prev4 = volWeeks.slice(-8, -4).map((b) => b.y);
  const volCh = last4.length === 4 && prev4.length === 4 ? pctChange(mean(last4), mean(prev4)) : null;

  return html`<div class="stack" data-ms=${ms}>
    <${StatGrid} items=${[
      { label: 'Sessions', value: fmtNum(d.sessions), sub: `${fmtNum(d.sessions / (period.days / 7), 1)} per week`,
        delta: isNum(d.sessionsPrev) && period.prevDays ? deltaInfo(d.sessions / (period.days / 7), d.sessionsPrev / (period.prevDays / 7), { dp: 1, suffix: '/wk', label: vs.trim() }) : null },
      { label: 'Hard sets / week', value: isNum(d.setsPerWeek) ? fmtNum(d.setsPerWeek) : '—', sub: isNum(d.volPerWeek) ? `${fmtCompact(d.volPerWeek)} lb volume / week` : null },
      { label: 'PRs', value: fmtNum(d.prList.length), sub: d.prList.length ? `Latest ${fmtDate(d.prList[0].date, { dow: false })}` : 'None in range' },
      { label: 'Median e1RM change', value: isNum(d.mc.median) ? signed(d.mc.median, 1) : '—', unit: isNum(d.mc.median) ? '%' : '', delta: isNum(d.mc.median) ? { text: `${plural(d.mc.n, 'lift')}${vs}`, tone: d.mc.median > 0 ? 'good' : d.mc.median < 0 ? 'bad' : null } : null, sub: isNum(d.mc.median) ? null : 'Needs a prior period' },
    ]} />
    <${ChartCard} title="Estimated 1RM" unit=${sc === 'pct' ? '% change from first session in range' : 'lb (Epley, sets of 1–12 reps)'} n=${sel.reduce((s, l) => s + l.points.length, 0)} nUnit="sessions"
      empty=${!d.loaded.length} source="sessions" emptyText="No loaded lifts in this range (bodyweight work is tracked by reps in the table)."
      action=${html`<${Segmented} label="Scale" value=${sc} onValue=${setScale} options=${[{ value: 'lb', label: 'lb' }, { value: 'pct', label: '%' }]} />`}
      takeaway=${bestMover ? `${change.map((c) => `${c.name} ${fmtSigned(c.pct, 1)}%`).join(' · ')} from the first to the last session in range.` : 'Log a lift at least twice to see its change.'}>
      <${TrendChart} height=${220} series=${series} zero=${sc === 'pct'} yFormat=${sc === 'pct' ? (v) => fmtSigned(v) + '%' : (v) => fmtNum(v)} tipFormat=${sc === 'pct' ? (v) => fmtSigned(v, 1) + '%' : (v) => fmtNum(v, 1) + ' lb'} xDomain=${[period.from, period.to]} endLabels=${false} />
      ${options.length > 1 ? html`<${Disclosure} summary=${`Lifts shown: ${sel.map((l) => l.name).join(', ')} · change (up to 4)`}><${Chips} multi options=${options} value=${chosen} onValue=${togglePick} /></${Disclosure}>` : null}
    </${ChartCard}>
    <${Card} title="Progression" meta=${`${plural(d.lifts.length, 'lift')} · last ${Math.max(4, Math.min(26, Math.round(period.days / 7)))} weeks`}>
      <p class="ins-take">${progCounts.progressing} progressing, ${progCounts.plateau} on a plateau, ${progCounts.regressing} regressing (±0.5 %/week thresholds; needs ≥ 3 sessions over ≥ 14 days).</p>
      <div class="table-wrap"><table class="data ins-table">
        <thead><tr><th>Lift</th><th class="num hide-xs">Best</th><th class="num hide-xs">${vs ? 'Change' : ''}</th><th class="num">%/wk</th><th>Status</th><th class="num hide-xs">n</th></tr></thead>
        <tbody>${d.lifts.map((l) => html`<tr>
          <td class="name" title=${l.name}><div class="ellipsis">${l.name}</div><div class="xs muted only-xs">${isNum(l.best) ? (l.metric === 'e1rm' ? fmtNum(l.best, 1) + ' lb' : fmtNum(l.best) + ' reps') : '—'} · ${plural(l.n, 'session')}</div></td>
          <td class="num hide-xs">${isNum(l.best) ? (l.metric === 'e1rm' ? fmtNum(l.best, 1) : fmtNum(l.best) + ' reps') : '—'}</td>
          <td class="num hide-xs">${isNum(l.change) ? html`<span class=${l.change > 0 ? 'pos' : l.change < 0 ? 'neg' : ''}>${fmtSigned(l.change, 1)}%</span>` : '—'}</td>
          <td class="num">${isNum(l.slope) ? fmtSigned(l.slope, 2) : '—'}</td>
          <td><${Pill} tone=${STATUS[l.status]}>${l.status === 'insufficient' ? 'Too few' : cap(l.status)}</${Pill}></td>
          <td class="num hide-xs">${l.n}</td></tr>`)}</tbody>
      </table></div>
    </${Card}>
    <div class="ins-grid two">
      <${ChartCard} title="Hard sets per muscle" unit="sets per week" n=${d.nWeeks} nUnit="weeks" empty=${!d.perMuscle.length} source="sessions"
        takeaway=${d.perMuscle.length ? `${d.partialWeek ? 'This week so far (no complete week in range yet)' : `Avg over ${plural(d.nWeeks, 'complete week')}`}; secondary muscles count half a set. ${d.perMuscle.filter((m) => m.avg < 10).length} of ${d.perMuscle.length} muscles are under 10 sets/week.` : null}
        note="General hypertrophy reference: roughly 10–20 hard sets per muscle per week (marker at 10); individual response varies.">
        <${MeterRows} rows=${d.perMuscle.map((m) => ({ label: cap(m.muscle), sub: d.partialWeek ? null : `last week ${fmtNum(m.last, 1)}`, value: m.avg, max: Math.max(24, ...d.perMuscle.map((x) => x.avg)), marker: 10, text: fmtNum(m.avg, 1) }))} />
      </${ChartCard}>
      <${ChartCard} title="Total volume" unit="lb per week" n=${volWeeks.length} nUnit="weeks" empty=${!volWeeks.length} source="sessions"
        takeaway=${volWeeks.length ? `Avg ${fmtCompact(d.volPerWeek ?? mean(volWeeks.map((b) => b.y)))} lb per full week${isNum(volCh) ? `; last 4 weeks ${fmtSigned(volCh, 1)}% vs the 4 before` : ''}. Median ${fmtNum(median(d.sets.filter((b) => b.y > 0).map((b) => b.y)))} hard sets per week.` : null}>
        <${BarChart} data=${d.volume} yFormat=${(v) => fmtCompact(v)} height=${170} />
      </${ChartCard}>
    </div>
    <${Card} title="PR timeline" meta=${d.prList.length ? plural(d.prList.length, 'PR') : null}>
      ${d.prList.length ? html`<div class="ins-list">${prShown.map((x) => html`<div class="ins-row" style="padding:8px 0">
          <span class="mono xs muted" style="width:52px;flex:0 0 auto">${fmtDate(x.date, { dow: false })}</span>
          <div class="grow" style="min-width:0"><div class="small ellipsis">${ex.get(x.exerciseId)?.name || x.exerciseId}</div><div class="xs muted">${x.type === 'e1rm' ? 'Estimated 1RM' : x.type === 'weight' ? 'Top weight' : 'Reps'}</div></div>
          <span class="mono small" style="text-align:right;white-space:nowrap">${fmtNum(x.prev, 1)} → <b>${fmtNum(x.value, 1)}</b>${x.type === 'reps' ? '' : ' lb'}</span>
        </div>`)}</div>
        ${d.prList.length > 12 ? html`<${Button} size="sm" variant="ghost" onClick=${() => setAllPrs(!allPrs)}>${allPrs ? 'Show fewer' : `Show all ${d.prList.length}`}</${Button}>` : null}`
        : html`<div class="small dim">No PRs in this range. The first session of a lift sets its baseline.</div>`}
    </${Card}>
  </div>`;
}
