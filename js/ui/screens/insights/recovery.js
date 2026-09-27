// Insights › Recovery: recovery %, HRV and resting HR against a rolling 30-day baseline band (mean ± 1 SD),
// strain vs next-day recovery, the readiness training call per day, and respiratory rate / skin temperature
// deviations. Apple Health resting HR / HRV (SDNN) fill in when WHOOP is not connected.
import { html } from '../../../vendor/preact-htm.js';
import { StackedBars, Scatter } from '../../charts.js';
import { buildDaily, readiness, baselines, rolling, mean } from '../../../analytics/index.js';
import { addDays, weekStart, fmtNum, fmtDate, isNum, round } from '../../../core/util.js';
import { avgOf, nOf, deltaInfo, trailingBand, deviationSeries, seriesOf, pairSummary, plural, fmtSigned } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, StatGrid, SectionEmpty, SplitBar, SectionSkeleton } from '../../parts/insights-kit.js';
import { TrendChart } from '../../parts/insights-charts.js';

const MODES = [['push', 'Push'], ['build', 'Build'], ['maintain', 'Maintain'], ['recover', 'Recover']];

function metric(ext, rows, prev, key, { dp = 0, lowerIsBetter = false, suffix = '' } = {}, to) {
  const from = rows[0].date;
  const band = trailingBand(ext, key, { window: 30, minN: 7 }).filter((b) => b.x >= from);
  const off = ext.length - rows.length; // 7-day average over the extended window: no spike on day one
  const roll = rolling(ext.map((r) => r[key]), 7).slice(off);
  const avg = avgOf(rows, key);
  const last7 = mean(rows.slice(-7).map((r) => r[key]));
  const base = baselines(ext, addDays(to, -6), 30)[key]; // the 30 days before the last 7
  const z = isNum(last7) && isNum(base.mean) && base.sd > 0 && base.n >= 7 ? (last7 - base.mean) / base.sd : null;
  return {
    key, n: nOf(rows, key), avg, last7, base, z, band,
    daily: seriesOf(rows, key), roll: rows.map((r, i) => ({ x: r.date, y: isNum(roll[i]) ? round(roll[i], 1) : null })),
    delta: deltaInfo(avg, avgOf(prev, key), { dp, lowerIsBetter, suffix }),
  };
}

function compute(dv, p, today) {
  const ext = buildDaily(dv, addDays(p.from, -30), p.to);
  const rows = ext.filter((r) => r.date >= p.from);
  const prev = p.prevFrom ? buildDaily(dv, p.prevFrom, p.prevTo) : [];
  const rec = metric(ext, rows, prev, 'recovery', { suffix: ' pts' }, p.to);
  const hrv = metric(ext, rows, prev, 'hrv', { dp: 1, suffix: ' ms' }, p.to);
  const rhr = metric(ext, rows, prev, 'rhr', { dp: 1, lowerIsBetter: true, suffix: ' bpm' }, p.to);
  const bands = { green: 0, yellow: 0, red: 0 };
  for (const r of rows) if (isNum(r.recovery)) bands[r.recovery >= 67 ? 'green' : r.recovery >= 34 ? 'yellow' : 'red']++;
  const prevGreen = prev.filter((r) => isNum(r.recovery));

  // The readiness call of each morning (push / build / maintain / recover), counted per Monday week.
  const modes = { push: 0, build: 0, maintain: 0, recover: 0 }; const weeks = new Map();
  for (const r of rows) {
    if (![r.recovery, r.hrv, r.rhr, r.sleepMin].some(isNum)) continue;
    const rd = readiness(dv, r.date);
    if (rd.status === 'no-data') continue;
    const m = rd.training.mode; modes[m]++;
    const w = weekStart(r.date);
    if (!weeks.has(w)) weeks.set(w, { push: 0, build: 0, maintain: 0, recover: 0 });
    weeks.get(w)[m]++;
  }
  const strain = rows.filter((r) => isNum(r.dayStrain) && isNum(r.nextRecovery)).map((r) => ({ x: r.dayStrain, y: r.nextRecovery, label: fmtDate(r.date) }));
  const resp = deviationSeries(ext, 'respRate', { window: 30, minN: 7 }).filter((x) => x.x >= p.from);
  const skin = deviationSeries(ext, 'skinTempC', { window: 30, minN: 7 }).filter((x) => x.x >= p.from);
  const health = rows.map((r) => ({ date: r.date, h: dv.health(r.date) }));
  const hRhr = health.map(({ date, h }) => ({ x: date, y: h && isNum(h.restingHr) ? h.restingHr : null }));
  const hHrv = health.map(({ date, h }) => ({ x: date, y: h && isNum(h.hrvSdnn) ? h.hrvSdnn : null }));
  return {
    rec, hrv, rhr, bands, greenPct: rec.n ? Math.round((bands.green / rec.n) * 100) : null,
    greenDelta: deltaInfo(rec.n ? (bands.green / rec.n) * 100 : null, prevGreen.length ? (prevGreen.filter((r) => r.recovery >= 67).length / prevGreen.length) * 100 : null, { suffix: ' pts' }),
    modes, modeDays: Object.values(modes).reduce((a, b) => a + b, 0), modeWeeks: [...weeks.entries()].map(([x, parts]) => ({ x, parts })),
    strain, strainSum: pairSummary(strain, { step: 0.5 }),
    resp, respN: resp.filter((x) => isNum(x.y)).length, respLast: [...resp].reverse().find((x) => isNum(x.y)),
    skin, skinN: skin.filter((x) => isNum(x.y)).length, skinLast: [...skin].reverse().find((x) => isNum(x.y)),
    hRhr, hHrv, hN: hRhr.filter((x) => isNum(x.y)).length + hHrv.filter((x) => isNum(x.y)).length,
  };
}

const vsBase = (m, dp, unit) => (isNum(m.last7) && isNum(m.base.mean)
  ? ` Last 7 days ${fmtNum(m.last7, dp)}${unit} vs ${fmtNum(m.base.mean, dp)}${unit} the 30 days before${isNum(m.z) ? ` (${fmtSigned(m.z, 1)} SD)` : ''}.` : '');

export default function Recovery({ app, today, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period, today), [period.from, period.to, period.prevFrom]);
  if (!d) return html`<${SectionSkeleton} />`;
  const vs = period.prevDays ? `vs prior ${period.prevDays}d` : '';
  const { rec, hrv, rhr } = d;
  if (!rec.n && !hrv.n && !rhr.n && !d.hN) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="heart" title="No recovery data in this range"
      text="Recovery, HRV and resting heart rate come from WHOOP (Apple Health resting HR and HRV also work)."
      points=${['Daily recovery against your own 30-day baseline band', 'HRV and resting HR trends with 7-day averages', 'How day strain carries into next-morning recovery', 'Early illness signals: respiratory rate and skin temperature']}
      sources=${['whoop', 'health']} /></div>`;
  }
  const area = (m) => ({ points: m.band, label: '30-day baseline ±1 SD' });
  const twoSeries = (m, label) => [
    { key: 'd', label, points: m.daily, style: 'dots' },
    { key: 'r', label: '7-day avg', points: m.roll },
  ];
  const tot = d.bands.green + d.bands.yellow + d.bands.red;
  const ss = d.strainSum;
  return html`<div class="stack" data-ms=${ms}>
    <${StatGrid} items=${[
      { label: 'Recovery avg', value: isNum(rec.avg) ? fmtNum(rec.avg) : '—', unit: '%', delta: rec.delta && { ...rec.delta, text: rec.delta.text + ' ' + vs } },
      { label: 'HRV avg', value: isNum(hrv.avg) ? fmtNum(hrv.avg, 1) : '—', unit: 'ms', delta: hrv.delta && { ...hrv.delta, text: hrv.delta.text + ' ' + vs } },
      { label: 'Resting HR avg', value: isNum(rhr.avg) ? fmtNum(rhr.avg, 1) : '—', unit: 'bpm', delta: rhr.delta && { ...rhr.delta, text: rhr.delta.text + ' ' + vs } },
      { label: 'Green days', value: isNum(d.greenPct) ? fmtNum(d.greenPct) : '—', unit: '%', delta: d.greenDelta && { ...d.greenDelta, text: d.greenDelta.text + ' ' + vs }, sub: tot ? `${d.bands.green} of ${plural(tot, 'day')}` : null },
    ]} />
    <div class="ins-grid two">
      <${ChartCard} title="Recovery" unit="%" n=${rec.n} source="whoop" empty=${!rec.n} emptyText="No WHOOP recovery scores in this range."
        takeaway=${tot ? `Avg ${fmtNum(rec.avg)}% · ${d.bands.green} green, ${d.bands.yellow} yellow, ${d.bands.red} red days.${vsBase(rec, 0, '%')}` : null}>
        <${TrendChart} series=${twoSeries(rec, 'Daily')} area=${area(rec)} yMin=${0} yMax=${100} tipFormat=${(v) => fmtNum(v) + '%'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title="HRV" unit="ms (RMSSD)" n=${hrv.n} source="whoop" empty=${!hrv.n} emptyText="No WHOOP HRV in this range."
        takeaway=${hrv.n ? `Avg ${fmtNum(hrv.avg, 1)} ms.${vsBase(hrv, 1, ' ms')}` : null}>
        <${TrendChart} series=${twoSeries(hrv, 'Daily')} area=${area(hrv)} tipFormat=${(v) => fmtNum(v, 1) + ' ms'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title="Resting heart rate" unit="bpm" n=${rhr.n} source="whoop" empty=${!rhr.n} emptyText="No WHOOP resting HR in this range."
        takeaway=${rhr.n ? `Avg ${fmtNum(rhr.avg, 1)} bpm (lower is better).${vsBase(rhr, 1, ' bpm')}` : null}>
        <${TrendChart} series=${twoSeries(rhr, 'Daily')} area=${area(rhr)} tipFormat=${(v) => fmtNum(v, 1) + ' bpm'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>
      <${ChartCard} title="Day strain vs next-day recovery" unit="strain → %" n=${d.strain.length} source="whoop" empty=${d.strain.length < 3}
        emptyText="Needs at least 3 days with both strain and next-morning recovery."
        takeaway=${ss.split ? `After days with strain ≥ ${fmtNum(ss.threshold, 1)}: next-day recovery ${fmtNum(ss.split.hi.mean)}% vs ${fmtNum(ss.split.lo.mean)}% after lighter days (Spearman ρ ${fmtNum(ss.rho, 2)}).` : null}>
        <${Scatter} points=${d.strain} xLabel="Day strain" yLabel="Next-day recovery %" xFormat=${(v) => fmtNum(v, v % 1 ? 1 : 0)} yFormat=${(v) => fmtNum(v)} />
      </${ChartCard}>
      <${ChartCard} title="Readiness call" unit="days per week" n=${d.modeDays} source="whoop" empty=${!d.modeDays}
        takeaway=${d.modeDays ? `${MODES.map(([k, l]) => `${l} ${d.modes[k]}`).join(' · ')} — the morning training call from recovery, HRV, resting HR and sleep.` : null}>
        <${SplitBar} parts=${MODES.map(([k, l]) => ({ label: l, value: d.modes[k], text: `${Math.round((d.modes[k] / (d.modeDays || 1)) * 100)}%` }))} />
        ${d.modeWeeks.length >= 2 ? html`<${StackedBars} data=${d.modeWeeks} keys=${MODES.map(([key, label]) => ({ key, label }))} height=${150} yFormat=${(v) => fmtNum(v)} />` : null}
      </${ChartCard}>
      ${d.respN ? html`<${ChartCard} title="Respiratory rate vs baseline" unit="br/min" n=${d.respN}
        takeaway=${`Latest ${fmtSigned(d.respLast.y, 1)} br/min vs the 30-day baseline. A rise of ≥ 1.0 together with higher skin temperature or low HRV is flagged as a possible illness sign.`}>
        <${TrendChart} series=${[{ key: 'r', label: 'Deviation', points: d.resp }]} target=${{ y: 1, label: '+1.0 flag' }} zero yFormat=${(v) => fmtSigned(v, 1)} xDomain=${[period.from, period.to]} />
      </${ChartCard}>` : null}
      ${d.skinN ? html`<${ChartCard} title="Skin temperature vs baseline" unit="°C" n=${d.skinN}
        takeaway=${`Latest ${fmtSigned(d.skinLast.y, 2)} °C vs the 30-day baseline; ≥ +0.5 °C counts toward the illness flag.`}>
        <${TrendChart} series=${[{ key: 's', label: 'Deviation', points: d.skin }]} target=${{ y: 0.5, label: '+0.5 °C' }} zero yFormat=${(v) => fmtSigned(v, 1)} tipFormat=${(v) => fmtSigned(v, 2) + ' °C'} xDomain=${[period.from, period.to]} />
      </${ChartCard}>` : null}
      ${!rhr.n && !hrv.n && d.hN ? html`
        <${ChartCard} title="Resting heart rate · Apple Health" unit="bpm" n=${d.hRhr.filter((x) => isNum(x.y)).length} empty=${!d.hRhr.some((x) => isNum(x.y))} source="health"
          takeaway=${`Avg ${fmtNum(mean(d.hRhr.map((x) => x.y)), 1)} bpm from Apple Health (lower is better).`}>
          <${TrendChart} series=${[{ key: 'rhr', label: 'Resting HR', points: d.hRhr }]} tipFormat=${(v) => fmtNum(v) + ' bpm'} xDomain=${[period.from, period.to]} />
        </${ChartCard}>
        <${ChartCard} title="HRV · Apple Health" unit="ms (SDNN)" n=${d.hHrv.filter((x) => isNum(x.y)).length} empty=${!d.hHrv.some((x) => isNum(x.y))} source="health"
          takeaway=${`Avg ${fmtNum(mean(d.hHrv.map((x) => x.y)), 1)} ms. SDNN runs higher than WHOOP's RMSSD, so the two are not directly comparable.`}>
          <${TrendChart} series=${[{ key: 'hrv', label: 'HRV SDNN', points: d.hHrv }]} tipFormat=${(v) => fmtNum(v) + ' ms'} xDomain=${[period.from, period.to]} />
        </${ChartCard}>` : null}
    </div>
  </div>`;
}
