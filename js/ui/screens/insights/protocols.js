// Insights › Protocols: adherence per item, and for each peptide/medication on a weekly or weekday schedule
// the dose cycle (same-day metrics by days since the last dose, with n per group) and weekly totals vs the
// weekly target. Amounts are shown exactly as logged. This view never suggests dose changes.
import { html, useState } from '../../../vendor/preact-htm.js';
import { Section, Pill, Notice, Chips } from '../../kit.js';
import { BarChart } from '../../charts.js';
import { buildDaily, protocolAdherence, doseCycle } from '../../../analytics/index.js';
import { fmtNum, fmtDur, fmtDate, isNum } from '../../../core/util.js';
import { bucketMode, bucketRows, nOf, avgOf, plural } from '../../parts/insights-logic.js';
import { useInsight, ChartCard, SectionEmpty, MeterRows, SectionSkeleton, SourceButton } from '../../parts/insights-kit.js';
import { GroupBars } from '../../parts/insights-charts.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function scheduleText(it) {
  const s = it.schedule || {}; const days = Array.isArray(s.days) && s.days.length ? s.days.map((x) => DAYS[x]).join('/') : '';
  const when = !s.type || s.type === 'daily' ? 'Daily' : s.type === 'days' ? days || 'Set days' : s.type === 'weekly' ? (days ? `Weekly (${days})` : 'Weekly') : 'As needed';
  return when + (s.stack ? ` · ${s.stack} stack` : '');
}
const amountText = (a, u) => (isNum(a) ? `${fmtNum(a, a % 1 ? (a < 1 ? 3 : 2) : 0)}${u ? ' ' + u : ''}` : '—');

// Metrics of doseCycle().byDay, in display order: [key, title, unit, format, short label, compact format]
const CYCLE_METRICS = [
  ['appetite', 'Appetite', '1–5 check-in', (v) => fmtNum(v, 1), 'Appetite'],
  ['kcalIn', 'Calories eaten', 'kcal', (v) => fmtNum(v), 'Calories'],
  ['proteinG', 'Protein', 'g', (v) => fmtNum(v), 'Protein'],
  ['recovery', 'Recovery', '%', (v) => fmtNum(v), 'Recovery'],
  ['hrv', 'HRV', 'ms', (v) => fmtNum(v, 1), 'HRV'],
  ['rhr', 'Resting HR', 'bpm', (v) => fmtNum(v, 1), 'RHR'],
  ['sleepMin', 'Sleep', 'h', (v) => fmtDur(v), 'Sleep', (v) => fmtNum(v / 60, 1)],
];

function compute(dv, p) {
  const adh = protocolAdherence(dv, p.from, p.to);
  const items = dv.protocolItems({ includeInactive: true });
  const cycleItems = items.filter((i) => (i.kind === 'peptide' || i.kind === 'medication') && i.schedule && (i.schedule.type === 'weekly' || i.schedule.type === 'days'));
  const cycles = cycleItems.map((i) => ({ item: i, c: doseCycle(dv, i.id, { from: p.from, to: p.to }) })).filter((x) => x.c.lastDose || x.item.active !== false);
  const rows = buildDaily(dv, p.from, p.to);
  const mode = bucketMode(p.days);
  return {
    adh, items, cycles, suppBars: bucketRows(rows, 'supplementAdherence', { mode, fmt: (v) => fmtNum(v) + '%' }),
    suppAvg: avgOf(rows, 'supplementAdherence'), suppN: nOf(rows, 'supplementAdherence'),
    suppFull: rows.filter((r) => r.supplementAdherence === 100).length, mode,
    doses: dv.range('doses', p.from, p.to).filter((d) => !d.skipped).length,
  };
}

export default function Protocols({ app, period }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period), [period.from, period.to]);
  if (!d) return html`<${SectionSkeleton} />`;
  if (!d.items.length) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="pill" title="No protocol items yet"
      text="Add supplements, peptides and medications with their schedule in Protocols; log doses from Today or the stack buttons."
      points=${['Adherence per item against its schedule', 'Weekly totals against a weekly target', 'Same-day recovery, HRV, appetite and intake by days since a dose']}
      sources=${['protocols']} /></div>`;
  }
  const scheduled = d.adh.filter((x) => x.scheduled > 0 || x.taken > 0);
  return html`<div class="stack" data-ms=${ms}>
    <${Notice} icon="info">Associations, not medical advice. Discuss dosing only with your prescriber.</${Notice}>
    <div class="ins-grid two">
      <${ChartCard} title="Adherence by item" unit="% of scheduled doses" n=${d.doses} nUnit="doses" source="doses" empty=${!scheduled.length}
        emptyText="Nothing was scheduled or logged in this range."
        takeaway=${scheduled.length ? `${scheduled.filter((x) => x.rate === 100).length} of ${plural(scheduled.filter((x) => x.rate != null).length, 'scheduled item')} fully on schedule; ${fmtNum(d.doses)} doses logged.` : null}>
        <${MeterRows} rows=${scheduled.map((x) => ({
          label: x.item.name, sub: `${x.item.kind || 'item'} · ${amountText(x.item.amount, x.item.unit)} · ${scheduleText(x.item)}`,
          value: x.rate ?? 0, max: 100, tone: x.rate == null ? null : x.rate >= 90 ? 'good' : x.rate >= 70 ? 'warn' : 'bad',
          text: x.rate == null ? `${x.taken} taken` : `${x.taken}/${x.scheduled} · ${fmtNum(x.rate)}%`,
        }))} />
      </${ChartCard}>
      <${ChartCard} title="Supplement adherence" unit=${d.mode === 'week' ? '% of due doses (weekly avg)' : '% of due doses per day'} n=${d.suppN} source="doses" empty=${!d.suppN}
        emptyText="No supplements were due in this range."
        takeaway=${d.suppN ? `Avg ${fmtNum(d.suppAvg)}% of due supplement doses taken; every due dose taken on ${d.suppFull} of ${plural(d.suppN, 'day')}.` : null}>
        <${BarChart} data=${d.suppBars} target=${{ y: 100, label: '100%' }} yFormat=${(v) => fmtNum(v)} height=${160} />
      </${ChartCard}>
    </div>
    ${d.cycles.map(({ item, c }) => html`<${CycleCard} key=${item.id} item=${item} c=${c} />`)}
  </div>`;
}

function CycleCard({ item, c }) {
  const [metric, setMetric] = useState('recovery');
  const groups = c.byDay.filter((g) => g.n > 0);
  const wt = c.weeklyTotals;
  const target = wt.find((w) => isNum(w.target))?.target ?? null;
  const unit = c.weeklyTotals[0]?.unit || item.unit || '';
  const fullWeeks = wt.slice(0, -1); // the current week is still open
  const atTarget = isNum(target) ? fullWeeks.filter((w) => Math.abs(w.amount - target) < 1e-9).length : null;
  const last = c.lastDose;
  const available = CYCLE_METRICS.filter(([key]) => groups.filter((x) => isNum(x[key])).length >= 2);
  const cur = available.find(([key]) => key === metric) || available[0] || null;
  const summary = (key, fmt) => {
    const g = groups.filter((x) => isNum(x[key]));
    if (g.length < 2) return null;
    const hi = g.reduce((a, b) => (b[key] > a[key] ? b : a)), lo = g.reduce((a, b) => (b[key] < a[key] ? b : a));
    return `Highest on day ${hi.daysSince} (${fmt(hi[key])}), lowest on day ${lo.daysSince} (${fmt(lo[key])}); day 0 = dose day.`;
  };
  return html`<${Section} title=${`${item.name} · dose cycle`} meta=${`${item.kind}${item.neutralLabel ? ` · shown as “${item.neutralLabel}” outside the app` : ''}`}>
    <div class="stack">
      <div class="row wrap" style="gap:6px">
        <${Pill}>${scheduleText(item)}</${Pill}>
        <${Pill}>Last dose ${last ? `${fmtDate(last.date, { dow: false })} · ${amountText(last.amount, last.unit)}` : 'none logged'}</${Pill}>
        ${c.nextDue ? html`<${Pill}>Next due ${fmtDate(c.nextDue, { dow: false })}</${Pill}>` : null}
        ${!last ? html`<${SourceButton} source="doses" />` : null}
      </div>
      <div class="ins-grid two">
        <${ChartCard} title="Weekly total" unit=${`${unit} per week, as logged`} n=${wt.length} nUnit="weeks" empty=${!wt.some((w) => w.amount > 0)} source="doses"
          emptyText="No doses of this item logged in this range."
          takeaway=${isNum(target) ? `Target ${amountText(target, unit)} per week; met exactly in ${atTarget} of ${plural(fullWeeks.length, 'complete week')}. This week so far: ${amountText(wt[wt.length - 1]?.amount, unit)}.` : `Weekly totals as logged; no weekly target set for this item.`}>
          <${BarChart} data=${wt.map((w) => ({ x: w.week, y: w.amount, label: `Week of ${fmtDate(w.week, { dow: false })} · ${amountText(w.amount, unit)}` }))} target=${isNum(target) ? { y: target, label: `Target ${amountText(target, unit)}` } : null}
            yFormat=${(v) => fmtNum(v, v % 1 ? 1 : 0)} height=${170} />
        </${ChartCard}>
        <${ChartCard} title="By days since dose" unit=${cur ? `${cur[1]} · ${cur[2]}` : 'same-day averages'} n=${c.n} source="doses" empty=${!cur}
          emptyText=${`Needs days in at least two days-since-dose groups with data (${plural(c.n, 'day')} so far).`}
          takeaway=${cur ? summary(cur[0], cur[3]) : null}>
          <${Chips} options=${available.map(([key, title]) => ({ value: key, label: title }))} value=${cur && cur[0]} onValue=${setMetric} />
          ${cur ? html`<${GroupBars} groups=${groups.map((x) => ({ label: 'Day ' + x.daysSince, value: cur[0] === 'sleepMin' && isNum(x[cur[0]]) ? x[cur[0]] / 60 : x[cur[0]], n: x.n }))}
            fmt=${cur[0] === 'sleepMin' ? (v) => fmtDur(v * 60) : cur[3]} height=${140} />` : null}
        </${ChartCard}>
      </div>
      ${available.length ? html`<div class="card">
        <div class="table-wrap"><table class="data ins-table ins-matrix">
          <thead><tr><th>Same-day avg</th>${groups.map((g) => html`<th class="num">Day ${g.daysSince}<div class="xs muted" style="font-weight:400">n ${g.n}</div></th>`)}</tr></thead>
          <tbody>${available.map(([key, , u, fmt, short, compact]) => html`<tr class=${cur && key === cur[0] ? 'on' : ''} onClick=${() => setMetric(key)}>
            <td>${short} <span class="xs muted">${u === '1–5 check-in' ? '1–5' : u}</span></td>${groups.map((g) => html`<td class="num">${isNum(g[key]) ? (compact || fmt)(g[key]) : '—'}</td>`)}</tr>`)}</tbody>
        </table></div>
      </div>` : null}
      <div class="ins-note">Associations, not medical advice. Discuss dosing only with your prescriber.</div>
    </div>
  </${Section}>`;
}
