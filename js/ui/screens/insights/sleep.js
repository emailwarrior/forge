// Insights › Sleep: asleep vs need, stages, bedtime / wake consistency against the settings targets,
// performance / efficiency / consistency, disturbances, and two behavior checks (last meal → bed vs deep
// sleep, last caffeine vs that night's sleep). The sleep on date D is the night that ended on D's morning.
import { html } from '../../../vendor/preact-htm.js';
import { BarChart, StackedBars, Scatter } from '../../charts.js';
import { buildDaily, timingTargets, sd } from '../../../analytics/index.js';
import { addDays, hmToMin, fmtNum, fmtDur, fmtDate, fmtTime, isNum, round } from '../../../core/util.js';
import { avgOf, nOf, valuesOf, deltaInfo, bucketMode, bucketRows, bucketParts, seriesOf, pairSummary, clockTicks, fmtClockAxis, plural } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, StatGrid, SectionEmpty, SectionSkeleton } from '../../parts/insights-kit.js';
import { TrendChart } from '../../parts/insights-charts.js';

const h1 = (min) => (isNum(min) ? round(min / 60, 2) : null);
const hAxis = (v) => fmtNum(v, v % 1 ? 1 : 0) + 'h';

function compute(dv, p) {
  const rows = buildDaily(dv, p.from, p.to);
  const prev = p.prevFrom ? buildDaily(dv, p.prevFrom, p.prevTo) : [];
  const t = dv.setting('targets');
  const mode = bucketMode(p.days);
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const n = nOf(rows, 'sleepMin');
  const avg = avgOf(rows, 'sleepMin'), need = avgOf(rows, 'sleepNeedMin');
  const paired = rows.filter((r) => isNum(r.sleepMin) && isNum(r.sleepNeedMin));
  const metNeed = paired.filter((r) => r.sleepMin >= r.sleepNeedMin * 0.95).length;
  const bars = bucketRows(rows, (r) => h1(r.sleepMin), { mode, fmt: (v) => fmtDur(v * 60) });

  const stageKeys = ['deepMin', 'remMin', 'lightMin', 'awakeMin'];
  const stages = bucketParts(rows, stageKeys, { mode }).map((b) => ({ x: b.x, parts: Object.fromEntries(stageKeys.map((k) => [k, h1(b.parts[k])])) }));
  const stageAvg = Object.fromEntries(stageKeys.map((k) => [k, avgOf(rows, k)]));
  const stageN = nOf(rows, 'deepMin');

  const timing = timingTargets(dv, p.from, p.to);
  const bedT = timing.find((x) => x.key === 'bedtime'), wakeT = timing.find((x) => x.key === 'wake');
  const bedSd = sd(valuesOf(rows, 'bedtimeMin')), wakeSd = sd(valuesOf(rows, 'wakeMin'));

  const quality = ['sleepPerf', 'sleepEff', 'sleepConsistency'].map((k) => ({ key: k, avg: avgOf(rows, k), n: nOf(rows, k), points: mode === 'day' ? seriesOf(rows, k) : bucketRows(rows, k, { mode }).map((b) => ({ x: b.x, y: b.y })) }));
  const dist = bucketRows(rows, 'disturbances', { mode, fmt: (v) => fmtNum(v, 1) });

  // Last meal → bed on day D pairs with deep sleep of the night that ends on D+1.
  const mealDeep = rows.map((r) => { const nx = byDate.get(addDays(r.date, 1)); return nx && isNum(r.lastMealToBedMin) && isNum(nx.deepMin) ? { x: round(r.lastMealToBedMin / 60, 2), y: nx.deepMin, label: fmtDate(r.date) } : null; }).filter(Boolean);
  const caf = rows.filter((r) => isNum(r.caffeineLastMin) && isNum(r.nextSleepMin)).map((r) => ({ x: round(r.caffeineLastMin / 60, 2), y: round(r.nextSleepMin / 60, 2), label: fmtDate(r.date) }));
  return {
    n, avg, need, metNeed, paired: paired.length, bars, stages, stageAvg, stageN,
    delta: deltaInfo(avg, avgOf(prev, 'sleepMin')), bedT, wakeT, bedSd, wakeSd,
    bed: seriesOf(rows, 'bedtimeMin'), wake: seriesOf(rows, 'wakeMin'),
    bedTarget: (() => { let m = hmToMin(t.bedtime); if (isNum(m) && m < 720) m += 1440; return m; })(), wakeTarget: hmToMin(t.wake), sleepTargetH: t.sleepTargetH,
    quality, dist, distAvg: avgOf(rows, 'disturbances'), distN: nOf(rows, 'disturbances'),
    mealDeep, mealDeepSum: pairSummary(mealDeep, { step: 0.25 }), caf, cafSum: pairSummary(caf, { step: 0.5 }), mode,
  };
}

export default function Sleep({ app, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period), [period.from, period.to, period.prevFrom]);
  if (!d) return html`<${SectionSkeleton} />`;
  if (!d.n) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="moon" title="No sleep data in this range"
      text="Sleep duration, need, stages and bed/wake times come from WHOOP."
      points=${['Hours asleep against WHOOP sleep need', 'Deep / REM / light stages per night', 'Bedtime and wake consistency against your targets', 'How meal timing and caffeine line up with your sleep']}
      sources=${['whoop']} /></div>`;
  }
  const vs = period.prevDays ? ` vs prior ${period.prevDays}d` : '';
  const gap = isNum(d.need) ? d.need - d.avg : null;
  const targetLine = isNum(d.need) ? { y: round(d.need / 60, 2), label: `Need ${fmtDur(d.need)}` } : isNum(d.sleepTargetH) ? { y: d.sleepTargetH, label: `Target ${fmtNum(d.sleepTargetH, 1)}h` } : null;
  const sa = d.stageAvg; const asleepAvg = [sa.deepMin, sa.remMin, sa.lightMin].every(isNum) ? sa.deepMin + sa.remMin + sa.lightMin : null;
  const pctOf = (v) => (isNum(v) && asleepAvg ? Math.round((v / asleepAvg) * 100) : null);
  const q = Object.fromEntries(d.quality.map((x) => [x.key, x]));
  const md = d.mealDeepSum, cs = d.cafSum;
  const clockChart = (series, target, label) => html`<${TrendChart} series=${[{ key: 'd', label: 'Night', points: series, style: 'line+dots' }]}
    target=${isNum(target) ? { y: target, label: `Target ${fmtTime(target)}` } : null} yTicks=${(lo, hi) => clockTicks(lo, hi)} yFormat=${fmtClockAxis} tipFormat=${fmtTime} xDomain=${[period.from, period.to]} endLabels=${false} />`;
  return html`<div class="stack" data-ms=${ms}>
    <${StatGrid} items=${[
      { label: 'Asleep avg', value: fmtDur(d.avg), delta: d.delta && { ...d.delta, text: `${d.delta.value >= 0 ? '+' : '−'}${fmtDur(Math.abs(d.delta.value))}${vs}` } },
      { label: 'Vs need', value: isNum(gap) ? (gap > 0 ? '−' : '+') + fmtDur(Math.abs(gap)) : '—', sub: isNum(d.need) ? `Need avg ${fmtDur(d.need)} · met ${d.metNeed}/${d.paired} nights` : 'No WHOOP need' },
      { label: 'Bedtime avg', value: d.bedT && d.bedT.avgActual != null ? fmtTime(d.bedT.avgActual) : '—', sub: d.bedT && d.bedT.hitRate != null ? `By ${fmtTime(d.bedT.target)} on ${d.bedT.hitRate}% · ±${fmtNum(d.bedSd)} min` : null },
      { label: 'Wake avg', value: d.wakeT && d.wakeT.avgActual != null ? fmtTime(d.wakeT.avgActual) : '—', sub: d.wakeT && d.wakeT.hitRate != null ? `By ${fmtTime(d.wakeT.target)} on ${d.wakeT.hitRate}% · ±${fmtNum(d.wakeSd)} min` : null },
    ]} />
    <div class="ins-grid two">
      <${ChartCard} title="Asleep vs need" unit=${d.mode === 'week' ? 'hours per night (weekly avg)' : 'hours per night'} n=${d.n} source="whoop"
        takeaway=${`Avg ${fmtDur(d.avg)} asleep${isNum(gap) ? `, ${fmtDur(Math.abs(gap))} ${gap > 0 ? 'below' : 'above'} need (${fmtDur(d.need)})` : ''}; ≥ 95% of need on ${d.metNeed} of ${plural(d.paired, 'night')}.`}>
        <${BarChart} data=${d.bars} target=${targetLine} yFormat=${hAxis} height=${170} />
      </${ChartCard}>
      <${ChartCard} title="Sleep stages" unit=${d.mode === 'week' ? 'hours per night (weekly avg)' : 'hours per night'} n=${d.stageN} source="whoop" empty=${!d.stageN}
        takeaway=${d.stageN ? `Deep ${fmtDur(sa.deepMin)} (${pctOf(sa.deepMin)}%), REM ${fmtDur(sa.remMin)} (${pctOf(sa.remMin)}%), light ${fmtDur(sa.lightMin)} per night; ${fmtDur(sa.awakeMin)} awake in bed.` : null}>
        <${StackedBars} data=${d.stages} keys=${[{ key: 'deepMin', label: 'Deep' }, { key: 'remMin', label: 'REM' }, { key: 'lightMin', label: 'Light' }, { key: 'awakeMin', label: 'Awake' }]} yFormat=${hAxis} height=${170} />
      </${ChartCard}>
      <${ChartCard} title="Bedtime" unit="clock time" n=${d.bedT ? d.bedT.n : 0} source="whoop" empty=${!(d.bedT && d.bedT.n)}
        takeaway=${d.bedT && d.bedT.n ? `Avg ${fmtTime(d.bedT.avgActual)}, varying ±${fmtNum(d.bedSd)} min night to night; at or before the ${fmtTime(d.bedT.target)} target on ${d.bedT.hitRate}% of nights.` : null}>
        ${clockChart(d.bed, d.bedTarget)}
      </${ChartCard}>
      <${ChartCard} title="Wake time" unit="clock time" n=${d.wakeT ? d.wakeT.n : 0} source="whoop" empty=${!(d.wakeT && d.wakeT.n)}
        takeaway=${d.wakeT && d.wakeT.n ? `Avg ${fmtTime(d.wakeT.avgActual)}, varying ±${fmtNum(d.wakeSd)} min; at or before the ${fmtTime(d.wakeT.target)} target on ${d.wakeT.hitRate}% of mornings.` : null}>
        ${clockChart(d.wake, d.wakeTarget)}
      </${ChartCard}>
      <${ChartCard} title="Performance, efficiency, consistency" unit="%" n=${q.sleepPerf.n} source="whoop" empty=${!q.sleepPerf.n && !q.sleepEff.n}
        takeaway=${`Performance ${fmtNum(q.sleepPerf.avg)}% (sleep vs need), efficiency ${fmtNum(q.sleepEff.avg, 1)}% (asleep vs in bed), consistency ${fmtNum(q.sleepConsistency.avg)}% (regular timing).`}>
        <${TrendChart} series=${[{ key: 'p', label: 'Performance', points: q.sleepPerf.points }, { key: 'e', label: 'Efficiency', points: q.sleepEff.points }, { key: 'c', label: 'Consistency', points: q.sleepConsistency.points }]}
          yMax=${100} tipFormat=${(v) => fmtNum(v, 1) + '%'} xDomain=${[period.from, period.to]} endLabels=${false} />
      </${ChartCard}>
      <${ChartCard} title="Disturbances" unit="per night" n=${d.distN} source="whoop" empty=${!d.distN}
        takeaway=${d.distN ? `Avg ${fmtNum(d.distAvg, 1)} disturbances per night.` : null}>
        <${BarChart} data=${d.dist} yFormat=${(v) => fmtNum(v)} height=${150} />
      </${ChartCard}>
      <${ChartCard} title="Last meal → bed vs deep sleep" unit="h → min" n=${d.mealDeep.length} source="meals" empty=${d.mealDeep.length < 3}
        emptyText="Needs meal times on days followed by a WHOOP-scored night."
        takeaway=${md.split ? `Nights with ≥ ${fmtDur(md.threshold * 60)} between the last meal and bed: ${fmtDur(md.split.hi.mean)} deep vs ${fmtDur(md.split.lo.mean)} after later meals (ρ ${fmtNum(md.rho, 2)}).` : null}>
        <${Scatter} points=${d.mealDeep} xLabel="Last meal → bed (h)" yLabel="Deep sleep (min)" xFormat=${hAxis} yFormat=${(v) => fmtNum(v)} />
      </${ChartCard}>
      <${ChartCard} title="Last caffeine vs sleep" unit="clock time → hours" n=${d.caf.length} source="checkins" empty=${d.caf.length < 3}
        emptyText="Needs the last-caffeine time in daily check-ins on days followed by a WHOOP-scored night."
        takeaway=${cs.split ? `Days with the last caffeine at or after ${fmtTime(cs.threshold * 60)}: ${fmtDur(cs.split.hi.mean * 60)} asleep that night vs ${fmtDur(cs.split.lo.mean * 60)} on earlier days (ρ ${fmtNum(cs.rho, 2)}).` : null}>
        <${Scatter} points=${d.caf} xLabel="Last caffeine" yLabel="Asleep that night (h)" xFormat=${(v) => fmtClockAxis(v * 60)} yFormat=${hAxis} />
      </${ChartCard}>
    </div>
    <div class="ins-note">Scatter lines are least-squares fits; ρ is the rank correlation across the days shown. Associations only — see Drivers for patterns that pass a significance test.</div>
  </div>`;
}
