// Insights › Schedule: meeting load (hours, back-to-back, fragmentation, longest free block), plan
// adherence, time allocation by category, deep work vs target, timing targets, and meeting load vs
// next-day recovery / energy.
import { html, useState } from '../../../vendor/preact-htm.js';
import { Card, Segmented } from '../../kit.js';
import { BarChart, Scatter } from '../../charts.js';
import { buildDaily, calendarLoad, timeAllocation, timingTargets, resolveTarget, mean } from '../../../analytics/index.js';
import { fmtNum, fmtDur, fmtTime, fmtDate, dowName, isNum, round } from '../../../core/util.js';
import { PLAN_CATEGORIES } from '../../../core/schema.js';
import { before, avgOf, nOf, deltaInfo, bucketMode, bucketRows, pairSummary, shareOf, plural } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, StatGrid, SectionEmpty, MeterRows, SectionSkeleton } from '../../parts/insights-kit.js';
import { TrendChart } from '../../parts/insights-charts.js';

const CAT_LABEL = Object.fromEntries(PLAN_CATEGORIES.map((c) => [c.id, c.label]));
const hFmt = (v) => fmtNum(v, v % 1 ? 1 : 0) + 'h';

function compute(dv, p, today) {
  const rows = buildDaily(dv, p.from, p.to);
  const prev = p.prevFrom ? buildDaily(dv, p.prevFrom, p.prevTo) : [];
  const past = before(rows, today);
  const mode = bucketMode(p.days);
  const cal = dv.hasCalendar();
  const work = rows.filter((r) => !r.isWeekend);
  const loads = cal ? work.map((r) => calendarLoad(dv, r.date)) : [];
  const byDow = Array.from({ length: 7 }, () => []);
  for (const r of rows) if (isNum(r.meetingMin)) byDow[r.dow].push(r.meetingMin);
  const dowAvg = byDow.map((v) => mean(v));
  const heavy = dowAvg.reduce((best, v, i) => (isNum(v) && (best == null || v > dowAvg[best]) ? i : best), null);
  const std = dv.standards().find((s) => s.auto === 'plan.adherence');
  const planTarget = std ? resolveTarget(dv, std, today) : null;
  const t = dv.setting('targets');
  const deepStd = dv.standards().find((s) => s.auto === 'day.deepWork');
  const deepTarget = deepStd ? resolveTarget(dv, deepStd, today)?.value : t.deepWorkTargetH;
  const deepDays = past.filter((r) => !r.isWeekend && isNum(r.deepWorkH));
  return {
    rows, past, mode, cal,
    meetBars: bucketRows(rows, (r) => (isNum(r.meetingMin) ? round(r.meetingMin / 60, 2) : null), { mode, fmt: (v) => fmtDur(v * 60) }),
    meetWork: avgOf(work, 'meetingMin'), meetWorkPrev: avgOf(prev.filter((r) => !r.isWeekend), 'meetingMin'), meetN: nOf(rows, 'meetingMin'),
    dowAvg, heavy, afterHours: avgOf(work, 'afterHoursMeetingMin'),
    b2b: mean(loads.map((l) => l.backToBack)), frag: mean(loads.map((l) => l.fragmentation)), freeAvg: mean(loads.map((l) => l.longestFreeBlockMin)),
    free: loads.map((l) => ({ x: l.date, y: isNum(l.longestFreeBlockMin) ? round(l.longestFreeBlockMin / 60, 2) : null })),
    free90: shareOf(loads.map((l) => l.longestFreeBlockMin), (v) => v >= 90),
    planBars: bucketRows(past, 'planAdherence', { mode, fmt: (v) => fmtNum(v) + '%' }), planAvg: avgOf(past, 'planAdherence'), planN: nOf(past, 'planAdherence'),
    planPrev: avgOf(prev, 'planAdherence'), planTarget: planTarget && isNum(planTarget.value) ? planTarget.value : null,
    alloc: timeAllocation(dv, p.from, p.to),
    deepBars: bucketRows(past.filter((r) => !r.isWeekend), 'deepWorkH', { mode, fmt: (v) => fmtNum(v, 1) + ' h' }), deepAvg: avgOf(deepDays, 'deepWorkH'), deepN: deepDays.length, deepTarget,
    deepHit: isNum(deepTarget) ? deepDays.filter((r) => r.deepWorkH >= deepTarget).length : null,
    timing: timingTargets(dv, p.from, p.to),
    vsRec: rows.filter((r) => isNum(r.meetingMin) && isNum(r.nextRecovery) && !r.isWeekend).map((r) => ({ x: round(r.meetingMin / 60, 2), y: r.nextRecovery, label: fmtDate(r.date) })),
    vsEnergy: rows.filter((r) => isNum(r.meetingMin) && isNum(r.nextEnergy) && !r.isWeekend).map((r) => ({ x: round(r.meetingMin / 60, 2), y: r.nextEnergy, label: fmtDate(r.date) })),
  };
}

export default function Schedule({ app, today, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period, today), [period.from, period.to, period.prevFrom, today]);
  const [y, setY] = useState('rec');
  if (!d) return html`<${SectionSkeleton} />`;
  const nothing = !d.cal && !d.planN && !d.deepN && !d.timing.some((x) => x.n);
  if (nothing) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="calendar" title="No schedule data in this range"
      text="Meeting load comes from Google Calendar; plan adherence from plan blocks marked done; deep work from check-ins or done deep-work blocks."
      points=${['Meeting hours, back-to-back meetings and the longest free block per day', 'Plan adherence and where planned time goes', 'Deep work against your daily target', 'Wake, bedtime, caffeine and last-meal timing against targets']}
      sources=${['calendar', 'plan', 'checkins']} /></div>`;
  }
  const vs = period.prevDays ? `vs prior ${period.prevDays}d` : '';
  const pts = y === 'rec' ? d.vsRec : d.vsEnergy;
  const ps = pairSummary(pts, { step: 0.5 });
  const allocTot = d.alloc.reduce((s, a) => s + a.plannedMin, 0);
  const deep = d.alloc.find((a) => a.category === 'deep');
  const maxAlloc = Math.max(1, ...d.alloc.map((a) => a.plannedMin));
  return html`<div class="stack" data-ms=${ms}>
    <${StatGrid} items=${[
      { label: 'Meetings per weekday', value: d.cal && isNum(d.meetWork) ? fmtDur(d.meetWork) : '—', delta: d.cal ? deltaInfo(d.meetWork, d.meetWorkPrev, { lowerIsBetter: true, suffix: ' min', label: vs }) : null, sub: d.cal ? null : 'Calendar not connected' },
      { label: 'Back-to-back', value: isNum(d.b2b) ? fmtNum(d.b2b, 1) : '—', sub: d.cal ? 'per weekday (≤ 5 min gap)' : null },
      { label: 'Longest free block', value: isNum(d.freeAvg) ? fmtDur(d.freeAvg) : '—', sub: isNum(d.free90) ? `≥ 90 min on ${d.free90}% of weekdays` : null },
      { label: 'Plan adherence', value: isNum(d.planAvg) ? fmtNum(d.planAvg) : '—', unit: '%', delta: deltaInfo(d.planAvg, d.planPrev, { suffix: ' pts', label: vs }), sub: d.planN ? plural(d.planN, 'planned day') : 'No planned days' },
    ]} />
    <div class="ins-grid two">
      <${ChartCard} title="Meeting time" unit=${d.mode === 'week' ? 'hours per day (weekly avg)' : 'hours per day'} n=${d.meetN} source="calendar" empty=${!d.cal || !d.meetN}
        emptyText="Connect Google Calendar to measure meeting load."
        takeaway=${isNum(d.meetWork) ? `Avg ${fmtDur(d.meetWork)} of meetings per weekday${d.heavy != null ? `; heaviest on ${dowName(d.heavy)} (${fmtDur(d.dowAvg[d.heavy])})` : ''}${isNum(d.afterHours) && d.afterHours > 0 ? `; ${fmtDur(d.afterHours)} after hours` : ''}.` : null}>
        <${BarChart} data=${d.meetBars} yFormat=${hFmt} height=${160} />
      </${ChartCard}>
      <${ChartCard} title="Longest free block" unit="hours, 8 AM–6 PM on weekdays" n=${d.free.filter((x) => isNum(x.y)).length} source="calendar" empty=${!d.cal || !d.free.some((x) => isNum(x.y))}
        emptyText="Connect Google Calendar to see free blocks and fragmentation."
        takeaway=${isNum(d.freeAvg) ? `Avg ${fmtDur(d.freeAvg)}; a 90-minute focus block was free on ${d.free90}% of weekdays. Fragmentation ${fmtNum((d.frag || 0) * 100)}% (share of free time in gaps under 60 min).` : null}>
        <${TrendChart} series=${[{ key: 'f', label: 'Longest free block', points: d.free, style: 'line+dots' }]} target=${{ y: 1.5, label: '90 min' }} zero yFormat=${hFmt} tipFormat=${(v) => fmtDur(v * 60)} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title="Plan adherence" unit=${d.mode === 'week' ? '% of planned minutes done (weekly avg)' : '% of planned minutes done'} n=${d.planN} source="plan" empty=${!d.planN}
        emptyText="No past days with plan blocks in this range."
        takeaway=${d.planN ? `Avg ${fmtNum(d.planAvg)}%${isNum(d.planTarget) ? `; at or above the ${d.planTarget}% standard on ${d.past.filter((r) => isNum(r.planAdherence) && r.planAdherence >= d.planTarget).length} of ${plural(d.planN, 'day')}` : ''}. Done counts fully, partial counts half.` : null}>
        <${BarChart} data=${d.planBars} target=${isNum(d.planTarget) ? { y: d.planTarget, label: `${d.planTarget}%` } : null} yFormat=${(v) => fmtNum(v)} height=${160} />
      </${ChartCard}>
      <${ChartCard} title="Where planned time goes" unit="hours planned · done" n=${allocTot ? Math.round(allocTot / 60) : 0} nUnit="h planned" source="plan" empty=${!d.alloc.length}
        emptyText="No plan blocks in this range."
        takeaway=${deep && allocTot ? `Deep work is ${Math.round((deep.plannedMin / allocTot) * 100)}% of planned time; ${deep.doneMin != null && deep.plannedMin ? Math.round((deep.doneMin / deep.plannedMin) * 100) : 0}% of it done.` : d.alloc.length ? `${fmtDur(allocTot)} planned across ${plural(d.alloc.length, 'category', 'categories')}.` : null}>
        <${MeterRows} rows=${d.alloc.map((a) => ({ label: CAT_LABEL[a.category] || a.category, sub: a.plannedMin ? `${Math.round(((a.doneMin || 0) / a.plannedMin) * 100)}% done` : null, value: a.doneMin || 0, max: maxAlloc, marker: a.plannedMin, text: `${fmtNum((a.doneMin || 0) / 60, 1)} / ${fmtNum(a.plannedMin / 60, 1)} h` }))} />
      </${ChartCard}>
      <${ChartCard} title="Deep work" unit=${d.mode === 'week' ? 'hours per weekday (weekly avg)' : 'hours per weekday'} n=${d.deepN} source="checkins" empty=${!d.deepN}
        emptyText="Deep work comes from the check-in (hours) or from deep-work plan blocks marked done."
        takeaway=${d.deepN ? `Avg ${fmtNum(d.deepAvg, 1)} h per weekday${isNum(d.deepTarget) ? ` vs a ${fmtNum(d.deepTarget, 1)} h target; met on ${d.deepHit} of ${plural(d.deepN, 'weekday')}` : ''}.` : null}>
        <${BarChart} data=${d.deepBars} target=${isNum(d.deepTarget) ? { y: d.deepTarget, label: `Target ${fmtNum(d.deepTarget, 1)} h` } : null} yFormat=${hFmt} height=${160} />
      </${ChartCard}>
      <${Card} title="Timing targets" meta="from Settings → Targets">
        <${MeterRows} rows=${d.timing.map((x) => ({
          label: x.label, sub: x.n ? `avg ${fmtTime(x.avgActual)} · target ${fmtTime(x.target)}` : `target ${x.target != null ? fmtTime(x.target) : 'not set'} · no data`,
          value: x.hitRate ?? 0, max: 100, tone: x.hitRate == null ? null : x.hitRate >= 80 ? 'good' : x.hitRate >= 50 ? 'warn' : 'bad',
          text: x.hitRate != null ? `${x.hitRate}% · n ${x.n}` : '—',
        }))} />
        <div class="ins-note" style="margin-top:10px">Hit = at or before the target time. Wake and bedtime from WHOOP, caffeine from check-ins, last meal from meal logs.</div>
      </${Card}>
      <${ChartCard} title="Meetings vs next day" unit=${y === 'rec' ? 'hours → recovery %' : 'hours → energy (1–5)'} n=${pts.length} class="span-2" source="calendar" empty=${!d.cal}
        emptyText="Needs Google Calendar plus WHOOP recovery or check-in energy."
        action=${html`<${Segmented} label="Outcome" value=${y} onValue=${setY} options=${[{ value: 'rec', label: 'Recovery' }, { value: 'energy', label: 'Energy' }]} />`}
        takeaway=${ps.split ? `Weekdays with ≥ ${fmtDur(ps.threshold * 60)} of meetings: next-day ${y === 'rec' ? 'recovery' : 'energy'} ${fmtNum(ps.split.hi.mean, y === 'rec' ? 0 : 1)} vs ${fmtNum(ps.split.lo.mean, y === 'rec' ? 0 : 1)} after lighter days (ρ ${fmtNum(ps.rho, 2)}).` : pts.length < 3 ? 'Not enough paired days yet.' : null}>
        <${Scatter} points=${pts} xLabel="Meetings (h)" yLabel=${y === 'rec' ? 'Next-day recovery %' : 'Next-day energy'} xFormat=${hFmt} yFormat=${(v) => fmtNum(v, y === 'rec' ? 0 : 1)} />
      </${ChartCard}>
    </div>
  </div>`;
}
