// Insights › Nutrition: calories and protein per day against the day's target, hit rates, macro split,
// protein per meal against the research per-meal reference, meal timing, micronutrients against general
// references, and AI nutrition review scores. Only complete past days count (every meal analyzed).
import { html } from '../../../vendor/preact-htm.js';
import { BarChart } from '../../charts.js';
import { buildDaily, calorieTargets, nutritionAdherence, microSummary, timingTargets, trendAt, mean, median } from '../../../analytics/index.js';
import { hmToMin, fmtNum, fmtDur, fmtTime, fmtDate, isNum, round, signed, LB_PER_KG } from '../../../core/util.js';
import { before, avgOf, nOf, deltaInfo, bucketMode, bucketRows, histogram, seriesOf, clockTicks, fmtClockAxis, shareOf, plural } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, StatGrid, SectionEmpty, SplitBar, MeterRows, SectionSkeleton } from '../../parts/insights-kit.js';
import { TrendChart, GroupBars } from '../../parts/insights-charts.js';

function compute(dv, p, today) {
  const rows = buildDaily(dv, p.from, p.to);
  const past = before(rows, today);
  const done = past.filter((r) => isNum(r.kcalIn));
  const mode = bucketMode(p.days);
  const tg = done.map((r) => calorieTargets(dv, r.date));
  const kcalT = mean(tg.map((t) => t.kcal)), protT = mean(tg.map((t) => t.proteinG));
  const carbT = mean(tg.map((t) => t.carbsG)), fatT = mean(tg.map((t) => t.fatG));
  const adh = nutritionAdherence(dv, p.from, p.to);
  const adhPrev = p.prevFrom ? nutritionAdherence(dv, p.prevFrom, p.prevTo) : null;
  const avgP = avgOf(done, 'proteinG'), avgC = avgOf(done, 'carbsG'), avgF = avgOf(done, 'fatG'), avgFiber = avgOf(done, 'fiberG');
  // Protein per analyzed meal on complete past days.
  const perMeal = [];
  for (const r of done) for (const m of dv.intake(r.date).meals) if (m.totals && isNum(m.totals.protein)) perMeal.push(m.totals.protein);
  const trend = trendAt(dv, today);
  const kg = isNum(trend) ? trend / LB_PER_KG : null;
  const t = dv.setting('targets');
  const timing = timingTargets(dv, p.from, p.to).find((x) => x.key === 'lastMeal');
  const windowMin = done.map((r) => (isNum(r.firstMealMin) && isNum(r.lastMealMin) ? r.lastMealMin - r.firstMealMin : null));
  const reviews = dv.store.all('reviews').filter((r) => r.kind === 'nutrition' && r.date >= p.from && r.date <= p.to && r.content && isNum(r.content.score))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    rows, past, done, mode, kcalT, protT, carbT, fatT, adh, adhPrev,
    kcalBars: bucketRows(past, 'kcalIn', { mode, fmt: (v) => fmtNum(v) + ' kcal' }),
    protBars: bucketRows(past, 'proteinG', { mode, fmt: (v) => fmtNum(v) + ' g' }),
    macros: { p: avgP, c: avgC, f: avgF, fiber: avgFiber, fiberT: t.fiberG, fatPct: t.fatPct },
    perMeal, perMealHist: histogram(perMeal, [0, 20, 30, 40, 50, 60, Infinity]), kg,
    // Long ranges: weekly averages keep the timing chart readable.
    first: mode === 'day' ? seriesOf(past, 'firstMealMin') : bucketRows(past, 'firstMealMin', { mode }).map((x) => ({ x: x.x, y: x.y })),
    last: mode === 'day' ? seriesOf(past, 'lastMealMin') : bucketRows(past, 'lastMealMin', { mode }).map((x) => ({ x: x.x, y: x.y })),
    lastBy: hmToMin(t.lastMealBy), timing,
    firstAvg: avgOf(past, 'firstMealMin'), lastAvg: avgOf(past, 'lastMealMin'), windowAvg: mean(windowMin), toBed: avgOf(past, 'lastMealToBedMin'),
    micro: microSummary(dv, p.from, p.to), reviews, logged: nOf(past, 'mealsCount'), today: dv.intake(today),
  };
}

export default function Nutrition({ app, today, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period, today), [period.from, period.to, period.prevFrom, today]);
  if (!d) return html`<${SectionSkeleton} />`;
  if (!d.done.length) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="fuel" title=${d.logged ? 'No complete meal days in this range yet' : 'No meals in this range'}
      text=${d.logged ? `${plural(d.logged, 'day')} with meals, but none fully analyzed yet. A day counts once every meal on it has an estimate.` : 'Photograph every meal; the AI estimate turns each photo into calories, protein, macros and micronutrients.'}
      points=${['Calories and protein per day against your targets', 'Protein per meal against the research per-meal amount', 'Meal timing and the gap to bedtime', 'Micronutrients against general reference intakes']}
      sources=${['meals']} /></div>`;
  }
  const { adh, macros: m } = d;
  const vs = period.prevDays ? `vs prior ${period.prevDays}d` : '';
  const kAvg = adh.avgKcal, pAvg = adh.avgProtein;
  const macroKcal = [m.p * 4, m.c * 4, m.f * 9];
  const mk = macroKcal.reduce((a, b) => a + (isNum(b) ? b : 0), 0);
  const pct = (v) => (mk ? Math.round((v / mk) * 100) : 0);
  const perMealRef = isNum(d.kg) ? round(d.kg * 0.4) : null;
  const perKg = isNum(d.kg) && isNum(pAvg) ? pAvg / d.kg : null;
  const medMeal = median(d.perMeal);
  const aboveRef = isNum(perMealRef) ? shareOf(d.perMeal, (v) => v >= perMealRef) : null;
  const unit = d.mode === 'week' ? 'per day (weekly avg)' : 'per day';
  const toneMicro = (x) => (x.pct == null ? null : x.limit ? (x.pct <= 100 ? 'good' : 'warn') : x.pct >= 100 ? 'good' : x.pct >= 70 ? 'warn' : 'bad');
  const latestReview = d.reviews[d.reviews.length - 1];
  return html`<div class="stack" data-ms=${ms}>
    <${StatGrid} items=${[
      { label: 'Calories avg', value: fmtNum(kAvg), unit: 'kcal', delta: deltaInfo(kAvg, d.adhPrev && d.adhPrev.avgKcal, { label: vs, neutral: true }), sub: isNum(adh.avgVsTarget) ? `${signed(adh.avgVsTarget)} kcal/day vs target` : null },
      { label: 'Protein avg', value: fmtNum(pAvg), unit: 'g', delta: deltaInfo(pAvg, d.adhPrev && d.adhPrev.avgProtein, { suffix: ' g', label: vs }), sub: isNum(perKg) ? `${fmtNum(perKg, 1)} g/kg of trend weight` : null },
      { label: 'Calories on target', value: isNum(adh.kcalHitRate) ? fmtNum(adh.kcalHitRate) : '—', unit: '%', sub: `${adh.kcalHits}/${adh.days} days within ±10%` },
      { label: 'Protein target hit', value: isNum(adh.proteinHitRate) ? fmtNum(adh.proteinHitRate) : '—', unit: '%', delta: deltaInfo(adh.proteinHitRate, d.adhPrev && d.adhPrev.proteinHitRate, { suffix: ' pts', label: vs }), sub: `${adh.proteinHits}/${adh.days} days ≥ 95%` },
    ]} />
    <div class="ins-grid two">
      <${ChartCard} title="Calories vs target" unit=${'kcal ' + unit} n=${d.done.length} source="meals"
        takeaway=${`Avg ${fmtNum(kAvg)} kcal vs ${fmtNum(d.kcalT)} target (${signed(adh.avgVsTarget)}/day); within ±10% on ${adh.kcalHits} of ${plural(adh.days, 'day')}.`}
        note=${d.today.count ? `Today (${plural(d.today.count, 'meal')} so far) is excluded until the day is over.` : null}>
        <${BarChart} data=${d.kcalBars} target=${isNum(d.kcalT) ? { y: Math.round(d.kcalT), label: `Target ${fmtNum(d.kcalT)}` } : null} yFormat=${(v) => fmtNum(v)} height=${170} />
      </${ChartCard}>
      <${ChartCard} title="Protein vs target" unit=${'g ' + unit} n=${d.done.length} source="meals"
        takeaway=${`Avg ${fmtNum(pAvg)} g vs ${fmtNum(d.protT)} g target; ≥ 95% of target on ${adh.proteinHits} of ${plural(adh.days, 'day')}.${isNum(perKg) ? ` That is ${fmtNum(perKg, 1)} g/kg; research on muscle gain plateaus around 1.6 g/kg/day (Morton 2018).` : ''}`}>
        <${BarChart} data=${d.protBars} target=${isNum(d.protT) ? { y: Math.round(d.protT), label: `Target ${fmtNum(d.protT)} g` } : null} yFormat=${(v) => fmtNum(v)} height=${170} color="var(--s2)" />
      </${ChartCard}>
      <${ChartCard} title="Macro split" unit="share of calories" n=${d.done.length} source="meals"
        takeaway=${`Protein ${pct(macroKcal[0])}%, carbs ${pct(macroKcal[1])}%, fat ${pct(macroKcal[2])}% of calories${isNum(m.fatPct) ? ` (fat target ${m.fatPct}%)` : ''}; fiber ${fmtNum(m.fiber)} g/day${isNum(m.fiberT) ? ` vs ${m.fiberT} g` : ''}.`}>
        <${SplitBar} parts=${[
          { label: 'Protein', value: macroKcal[0], text: `${fmtNum(m.p)} g` },
          { label: 'Carbs', value: macroKcal[1], text: `${fmtNum(m.c)} g` },
          { label: 'Fat', value: macroKcal[2], text: `${fmtNum(m.f)} g` },
        ]} />
        <div class="xs muted" style="margin-top:6px">Average per day vs the day's target (marker)</div>
        <${MeterRows} rows=${[
          ['Protein', m.p, d.protT], ['Carbs', m.c, d.carbT], ['Fat', m.f, d.fatT], ['Fiber', m.fiber, m.fiberT],
        ].map(([label, v, tgt]) => ({ label, value: v, max: Math.max(v || 0, tgt || 0) * 1.15 || 1, marker: isNum(tgt) ? tgt : null,
          text: `${fmtNum(v)} / ${isNum(tgt) ? fmtNum(tgt) : '—'} g`, sub: isNum(tgt) && isNum(v) ? `${Math.round((v / tgt) * 100)}% of target` : null }))} />
      </${ChartCard}>
      <${ChartCard} title="Protein per meal" unit="meals by grams of protein (g)" n=${d.perMeal.length} nUnit="meals" source="meals"
        takeaway=${`Median ${fmtNum(medMeal)} g per meal${isNum(perMealRef) ? `; ${aboveRef}% of meals reach ~0.4 g/kg (${perMealRef} g at your trend weight), the per-meal amount research links to maximal muscle protein synthesis (Schoenfeld & Aragon 2018)` : ''}.`}>
        <${GroupBars} groups=${d.perMealHist.map((b) => ({ label: b.label, value: b.n, sub: d.perMeal.length ? Math.round((b.n / d.perMeal.length) * 100) + '%' : null, lo: b.lo, hi: b.hi }))}
          fmt=${(v) => fmtNum(v)} height=${150} highlight=${(g) => isNum(perMealRef) && g.lo <= perMealRef && perMealRef < g.hi} />
        ${isNum(perMealRef) ? html`<div class="xs muted">Orange bucket holds the ~0.4 g/kg reference (${perMealRef} g). Bars: meals; below: share of meals.</div>` : null}
      </${ChartCard}>
      <${ChartCard} title="Meal timing" unit=${d.mode === 'week' ? 'clock time (weekly avg)' : 'clock time'} n=${nOf(d.past, 'lastMealMin')} source="meals"
        takeaway=${`First meal ${fmtTime(d.firstAvg)}, last ${fmtTime(d.lastAvg)} on average (eating window ${fmtDur(d.windowAvg)})${d.timing && d.timing.hitRate != null ? `; last meal by ${fmtTime(d.lastBy)} on ${d.timing.hitRate}% of days` : ''}${isNum(d.toBed) ? `; ${fmtDur(d.toBed)} before bed` : ''}.`}>
        <${TrendChart} series=${[{ key: 'f', label: 'First meal', points: d.first, style: 'line+dots' }, { key: 'l', label: 'Last meal', points: d.last, style: 'line+dots' }]}
          target=${isNum(d.lastBy) ? { y: d.lastBy, label: `Last by ${fmtTime(d.lastBy)}` } : null} yTicks=${(lo, hi) => clockTicks(lo, hi, 5)} yFormat=${fmtClockAxis} tipFormat=${fmtTime}
          xDomain=${[period.from, period.to]} endLabels=${false} />
      </${ChartCard}>
      <${ChartCard} title="Micronutrients" unit="avg per day vs reference" n=${d.micro[0] ? d.micro[0].days : 0} source="meals"
        takeaway=${(() => { const low = d.micro.filter((x) => !x.limit && x.pct != null && x.pct < 70).map((x) => x.label); const over = d.micro.filter((x) => x.limit && x.pct > 100).map((x) => x.label); return [low.length ? `Below 70% of reference: ${low.join(', ')}` : 'All tracked micronutrients at ≥ 70% of reference', over.length ? `${over.join(', ')} above the upper limit` : null].filter(Boolean).join('; ') + '.'; })()}
        note="General adult reference intakes, not personalized; sodium is an upper limit. Micronutrients from photo estimates are rough — supplements are not included.">
        <${MeterRows} rows=${d.micro.map((x) => ({ label: x.label, sub: `ref ${fmtNum(x.reference)} ${x.unit}${x.limit ? ' (limit)' : ''}`, value: x.pct, max: 150, marker: 100, tone: toneMicro(x), text: `${fmtNum(x.avg, x.key === 'iron' ? 1 : 0)} ${x.unit}` }))} />
      </${ChartCard}>
      <${ChartCard} title="Nutrition review scores" unit="0–100 (AI)" n=${d.reviews.length} nUnit="reviews" class="span-2" source="reviews" empty=${!d.reviews.length}
        emptyText="No daily nutrition reviews in this range. Reviews are generated from Fuel (or by automation overnight)."
        takeaway=${latestReview ? `Avg ${fmtNum(mean(d.reviews.map((r) => r.content.score)))} over ${plural(d.reviews.length, 'review')}. Latest (${fmtDate(latestReview.date, { dow: false })}, ${latestReview.content.score}): ${latestReview.content.headline || ''}` : null}>
        <${TrendChart} series=${[{ key: 's', label: 'Score', points: d.reviews.map((r) => ({ x: r.date, y: r.content.score })), style: 'line+dots' }]} yMin=${0} yMax=${100} xDomain=${[period.from, period.to]} minPoints=${1} />
      </${ChartCard}>
    </div>
  </div>`;
}
