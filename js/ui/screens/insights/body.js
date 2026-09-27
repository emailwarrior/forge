// Insights › Body: weigh-ins (points) with the EWMA trend and the goal band from the profile, the 28-day
// rate against the goal rate, TDEE (energy balance) with confidence, calorie/macro targets, the goal
// projection, and body fat / waist when logged. Every goal value comes from settings, never from code.
import { html } from '../../../vendor/preact-htm.js';
import { Card, KV, Pill, Button } from '../../kit.js';
import { buildDaily, trendSeries, rateLbPerWeek, goalProjection, estimateTdee, calorieTargets, bodySummary } from '../../../analytics/index.js';
import { addDays, dateRange, fmtNum, fmtDate, isNum, round, signed } from '../../../core/util.js';
import { nOf, fmtSigned, plural } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, StatGrid, SectionEmpty, SourceButton, SectionSkeleton } from '../../parts/insights-kit.js';
import { TrendChart } from '../../parts/insights-charts.js';

function compute(dv, p, today) {
  const rows = buildDaily(dv, p.from, p.to);
  const weights = dv.dailyWeights().filter((w) => w.date >= p.from && w.date <= p.to);
  const all = trendSeries(dv);
  const trend = all.filter((t) => t.date >= p.from && t.date <= p.to);
  const prof = dv.setting('profile');
  const proj = goalProjection(dv, today);
  const sum = bodySummary(dv, today);
  const tdee = estimateTdee(dv, today);
  const targets = calorieTargets(dv, today);
  // 28-day rate and TDEE estimate at weekly points through the range (+ today).
  const pts = dateRange(p.from, p.to).filter((d, i, a) => (a.length - 1 - i) % 7 === 0);
  const rate = pts.map((d) => ({ x: d, y: rateLbPerWeek(all.filter((s) => s.date <= d), 28) }));
  const tdeeSeries = pts.map((d) => { const e = estimateTdee(dv, addDays(d, 1)); return { x: d, y: e.tdee }; });
  const first = trend.find((t) => isNum(t.trendLb)), last = [...trend].reverse().find((t) => isNum(t.trendLb));
  const comp = dv.range('body', p.from, p.to).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const bf = new Map(), waist = new Map();
  for (const b of comp) { if (isNum(b.bodyFatPct) && !bf.has(b.date)) bf.set(b.date, b.bodyFatPct); if (isNum(b.waistIn) && !waist.has(b.date)) waist.set(b.date, b.waistIn); }
  for (const d of dateRange(p.from, p.to)) { const h = dv.health(d); if (h && isNum(h.bodyFatPct) && !bf.has(d)) bf.set(d, h.bodyFatPct); }
  const toPts = (m) => [...m.entries()].sort().map(([x, y]) => ({ x, y }));
  return {
    weights: weights.map((w) => ({ x: w.date, y: w.weightLb })), nWeigh: weights.length, trend: trend.map((t) => ({ x: t.date, y: t.trendLb })),
    change: first && last ? round(last.trendLb - first.trendLb, 1) : null, first, last,
    prof, proj, sum, tdee, targets, rate, tdeeSeries, bf: toPts(bf), waist: toPts(waist), rowsN: nOf(rows, 'weightTrendLb'),
  };
}

const ci = (c) => (c === 'high' ? 'good' : c === 'medium' ? 'warn' : c === 'low' ? 'bad' : null);

export default function Body({ app, today, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period, today), [period.from, period.to, today]);
  if (!d) return html`<${SectionSkeleton} />`;
  const { proj, tdee, targets: tg } = d;
  const hasGoal = isNum(proj.goalLow) || isNum(proj.goalHigh);
  if (!d.nWeigh && !isNum(proj.currentTrendLb)) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="scale" title="No weigh-ins in this range"
      text="Body weight comes from weigh-ins (Apple Health weight also counts). Morning weigh-ins after the bathroom give the cleanest trend."
      points=${['Daily weigh-ins with a smoothed trend that ignores water swings', 'Rate of gain per week against your goal rate', 'Measured TDEE once 14 days of meals and 10 weigh-ins exist', hasGoal ? 'ETA into your goal range' : 'Set a goal range in Settings → Profile for an ETA']}
      sources=${['weighins', 'health', ...(hasGoal ? [] : ['goal'])]} /></div>`;
  }
  const ys = [...d.weights, ...d.trend].map((p) => p.y).filter(isNum);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const fit = isNum(proj.goalLow) && proj.goalLow - hi <= Math.max(3, (hi - lo) * 0.6) && (!isNum(proj.goalHigh) || lo - proj.goalHigh <= Math.max(3, (hi - lo) * 0.6));
  const goalBand = hasGoal ? { lo: isNum(proj.goalLow) ? proj.goalLow : -Infinity, hi: isNum(proj.goalHigh) ? proj.goalHigh : Infinity, label: `Goal ${fmtNum(proj.goalLow)}–${fmtNum(proj.goalHigh)} lb`, fit } : null;
  const rateTxt = isNum(proj.ratePerWeek) ? `${signed(proj.ratePerWeek, 2)} lb/wk` : 'not enough weigh-ins for a rate';
  const goalRate = isNum(proj.goalRate) ? `${signed(proj.goalRate, 2)} lb/wk` : null;
  const eta = proj.etaDate ? fmtDate(proj.etaDate, { dow: false, year: true }) : null;
  const status = proj.onTrack === true ? { tone: 'good', text: proj.weeksToGoal === 0 ? 'In range' : 'On track' } : proj.onTrack === false ? { tone: 'warn', text: 'Behind pace' } : null;
  return html`<div class="stack" data-ms=${ms}>
    <${StatGrid} items=${[
      { label: 'Trend weight', value: isNum(proj.currentTrendLb) ? fmtNum(proj.currentTrendLb, 1) : '—', unit: 'lb', sub: isNum(d.change) ? `${signed(d.change, 1)} lb over ${period.days}d` : null },
      { label: 'Rate (28 days)', value: isNum(proj.ratePerWeek) ? signed(proj.ratePerWeek, 2) : '—', unit: 'lb/wk', sub: goalRate ? `Goal ${goalRate}` : 'No goal rate set' },
      { label: 'TDEE (measured)', value: isNum(tdee.tdee) ? fmtNum(tdee.tdee) : '—', unit: 'kcal', sub: tdee.tdee ? `${tdee.confidence} confidence · ${tdee.n} logged days` : tdee.note },
      { label: hasGoal ? 'ETA to goal range' : 'Goal range', value: eta ? fmtDate(proj.etaDate, { dow: false, year: proj.etaDate.slice(0, 4) !== today.slice(0, 4) }) : proj.weeksToGoal === 0 ? 'In range' : '—', sub: hasGoal ? proj.note : 'Set it in Settings → Profile' },
    ]} />
    <div class="ins-grid two">
      <${ChartCard} title="Body weight" unit="lb" n=${d.nWeigh} nUnit="weigh-ins" class="span-2" source="weighins" empty=${!d.nWeigh && !d.trend.length}
        takeaway=${`Trend ${fmtNum(proj.currentTrendLb, 1)} lb${isNum(d.change) ? `, ${signed(d.change, 1)} lb over ${plural(period.days, 'day')}` : ''}; ${rateTxt}${goalRate ? ` vs ${goalRate} goal` : ''}.${hasGoal ? ' ' + proj.note : ''}`}
        action=${status ? html`<${Pill} tone=${status.tone}>${status.text}</${Pill}>` : null}>
        <${TrendChart} height=${220} series=${[{ key: 'w', label: 'Weigh-ins', points: d.weights, style: 'dots' }, { key: 't', label: 'Trend (EWMA)', points: d.trend }]}
          band=${goalBand} yFormat=${(v) => fmtNum(v, v % 1 ? 1 : 0)} tipFormat=${(v) => fmtNum(v, 1) + ' lb'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title="Rate of change" unit="lb per week (28-day)" n=${d.rate.filter((x) => isNum(x.y)).length} nUnit="weeks" source="weighins" empty=${!d.rate.some((x) => isNum(x.y))}
        emptyText="A rate needs at least 7 weigh-ins within 28 days."
        takeaway=${`${rateTxt}${goalRate ? ` against a ${goalRate} goal` : ''}${proj.onTrack === true && proj.weeksToGoal !== 0 ? ' — on track (≥ 75% of goal pace)' : proj.onTrack === false ? ' — below 75% of goal pace' : ''}.`}>
        <${TrendChart} series=${[{ key: 'r', label: '28-day rate', points: d.rate, style: 'line+dots' }]} zero target=${isNum(proj.goalRate) ? { y: proj.goalRate, label: `Goal ${signed(proj.goalRate, 2)}` } : null}
          yFormat=${(v) => fmtSigned(v, 2)} tipFormat=${(v) => fmtSigned(v, 2) + ' lb/wk'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title="TDEE" unit="kcal/day · energy balance" n=${tdee.n} nUnit="logged days"
        action=${tdee.confidence ? html`<${Pill} tone=${ci(tdee.confidence)}>${tdee.confidence} confidence</${Pill}>` : null}
        takeaway=${tdee.tdee ? `≈ ${fmtNum(tdee.tdee)} kcal/day: avg intake ${fmtNum(tdee.intakeAvg)} kcal over ${tdee.n} logged days minus a trend of ${signed(tdee.trendDeltaLb, 2)} lb × 3,500 kcal/lb (${tdee.weighIns} weigh-ins). An estimate.` : `Not enough data yet — ${String(tdee.note || '').replace(/^Needs/, 'needs')}`}
        note=${tdee.tdee ? 'Accuracy depends on logging every meal; missed meals bias TDEE low.' : null}>
        ${d.tdeeSeries.filter((x) => isNum(x.y)).length >= 2
          ? html`<${TrendChart} height=${150} series=${[{ key: 't', label: 'TDEE', points: d.tdeeSeries, style: 'line+dots' }]} yFormat=${(v) => fmtNum(v)} tipFormat=${(v) => fmtNum(v) + ' kcal'} xDomain=${[period.from, period.to]} />`
          : tdee.tdee ? html`<div class="xs muted">A trend line appears once there are two weekly estimates.</div>`
          : html`<div class="row wrap" style="gap:8px"><${SourceButton} source="meals" /><${SourceButton} source="weighins" /></div>`}
      </${ChartCard}>
      <${Card} title="Calorie and macro targets" meta=${tg.basis ? tg.basis : null} action=${html`<${Button} size="sm" variant="ghost" onClick=${() => app.nav('/settings/targets')}>Edit</${Button}>`}>
        <div class="stack sm">
          <${KV} items=${[
            ['Calories', isNum(tg.kcal) ? fmtNum(tg.kcal) + ' kcal' : '—'],
            ['Protein', isNum(tg.proteinG) ? fmtNum(tg.proteinG) + ' g' : '—'],
            ['Fat', isNum(tg.fatG) ? fmtNum(tg.fatG) + ' g' : '—'],
            ['Carbs', isNum(tg.carbsG) ? fmtNum(tg.carbsG) + ' g' : '—'],
            ['Fiber', isNum(tg.fiberG) ? fmtNum(tg.fiberG) + ' g' : '—'],
            tg.basis !== 'manual' && isNum(tg.surplus) ? ['Surplus', signed(tg.surplus) + ' kcal'] : null,
          ]} />
          <div class="xs muted">${tg.rationale}</div>
        </div>
      </${Card}>
      <${Card} title="Goal projection" action=${hasGoal ? (status ? html`<${Pill} tone=${status.tone}>${status.text}</${Pill}>` : null) : html`<${SourceButton} source="goal" variant="ghost" />`}>
        <${KV} items=${[
          ['Trend weight', isNum(proj.currentTrendLb) ? fmtNum(proj.currentTrendLb, 1) + ' lb' : '—'],
          ['Goal range', hasGoal ? `${fmtNum(proj.goalLow)}–${fmtNum(proj.goalHigh)} lb` : 'Not set'],
          ['Rate vs goal', `${isNum(proj.ratePerWeek) ? signed(proj.ratePerWeek, 2) : '—'} vs ${goalRate || '—'}`],
          ['Weeks to goal', isNum(proj.weeksToGoal) ? fmtNum(proj.weeksToGoal, 1) : '—'],
          ['ETA', eta || (proj.weeksToGoal === 0 ? 'In range' : '—')],
        ]} />
        <div class="xs muted" style="margin-top:8px">${proj.note}</div>
      </${Card}>
      ${d.bf.length ? html`<${ChartCard} title="Body fat" unit="%" n=${d.bf.length} nUnit="measurements"
        takeaway=${`Latest ${fmtNum(d.bf[d.bf.length - 1].y, 1)}%${d.bf.length > 1 ? ` (${fmtSigned(d.bf[d.bf.length - 1].y - d.bf[0].y, 1)} pts since ${fmtDate(d.bf[0].x, { dow: false })})` : ''}. Scale and tape methods vary ±2–3 pts; compare like with like.`}>
        <${TrendChart} height=${150} series=${[{ key: 'bf', label: 'Body fat', points: d.bf, style: 'line+dots' }]} tipFormat=${(v) => fmtNum(v, 1) + '%'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>` : null}
      ${d.waist.length ? html`<${ChartCard} title="Waist" unit="in" n=${d.waist.length} nUnit="measurements"
        takeaway=${`Latest ${fmtNum(d.waist[d.waist.length - 1].y, 1)} in${d.waist.length > 1 ? ` (${fmtSigned(d.waist[d.waist.length - 1].y - d.waist[0].y, 1)} in since ${fmtDate(d.waist[0].x, { dow: false })})` : ''}. Read it next to the weight trend to separate lean from fat gain.`}>
        <${TrendChart} height=${150} series=${[{ key: 'w', label: 'Waist', points: d.waist, style: 'line+dots' }]} tipFormat=${(v) => fmtNum(v, 1) + ' in'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>` : null}
      ${!d.bf.length && !d.waist.length ? html`<${ChartCard} title="Body composition" unit="% · in" empty source="weighins"
        emptyText="No body fat or waist measurements in this range. Add them to a weigh-in to see whether the gain is lean." />` : null}
    </div>
  </div>`;
}
