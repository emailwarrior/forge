// Insights › Drivers ("What moves my numbers"): findDrivers() over the range, grouped by outcome with
// filter chips; each pattern shows its sentence, effect, n, q-value and strength, and opens the paired
// daily values behind it (scatter for continuous behaviors, two-group comparison for yes/no behaviors).
import { html, useState } from '../../../vendor/preact-htm.js';
import { Card, Pill, Chips, Icon } from '../../kit.js';
import { Scatter } from '../../charts.js';
import { buildDaily, findDrivers, dataSufficiency, BEHAVIORS, OUTCOMES } from '../../../analytics/index.js';
import { fmtNum, fmtDur, fmtDate, isNum, round } from '../../../core/util.js';
import { driverPairs, driverSentence, fmtQ, fmtClockAxis, fmtSigned, plural } from '../../parts/insights-logic.js';
import { useInsight, SectionEmpty, AssocNote, SectionSkeleton } from '../../parts/insights-kit.js';

const hrs = (v) => fmtNum(v, v % 1 ? 1 : 0) + 'h';
const clock = { x: (v) => v / 60, fmt: (h) => fmtClockAxis(h * 60), label: 'clock time' };
// How to plot a behavior on the x axis: x(v) transforms the raw value; fmt formats the transformed value.
const BX = {
  lastMealToBedMin: { x: (v) => v / 60, fmt: hrs, label: 'last meal → bed (h)' },
  lastMealMin: { ...clock, label: 'last meal time' },
  caffeineLastMin: { ...clock, label: 'last caffeine' },
  bedtimeMin: { ...clock, label: 'bedtime' },
  dayStrain: { x: (v) => v, fmt: (v) => fmtNum(v, 1), label: 'day strain' },
  kcalIn: { x: (v) => v, fmt: (v) => fmtNum(v), label: 'kcal eaten' },
  proteinG: { x: (v) => v, fmt: (v) => fmtNum(v) + ' g', label: 'protein (g)' },
  carbsG: { x: (v) => v, fmt: (v) => fmtNum(v) + ' g', label: 'carbs (g)' },
  deepWorkH: { x: (v) => v, fmt: hrs, label: 'deep work (h)' },
  meetingMin: { x: (v) => v / 60, fmt: hrs, label: 'meetings (h)' },
  afterHoursMeetingMin: { x: (v) => v, fmt: (v) => fmtNum(v) + 'm', label: 'after-hours meetings (min)' },
  daysSinceDose: { x: (v) => v, fmt: (v) => 'D' + fmtNum(v), label: 'days since dose' },
  sleepMin: { x: (v) => v / 60, fmt: hrs, label: 'sleep (h)' },
};
// Outcome values: y(v) transforms, fmt formats (tooltips and group means).
const OY = {
  nextRecovery: { y: (v) => v, fmt: (v) => fmtNum(v) + '%' },
  nextHrv: { y: (v) => v, fmt: (v) => fmtNum(v, 1) + ' ms' },
  nextRhr: { y: (v) => v, fmt: (v) => fmtNum(v, 1) + ' bpm' },
  nextSleepMin: { y: (v) => v / 60, fmt: (h) => fmtDur(h * 60) },
  nextSleepPerf: { y: (v) => v, fmt: (v) => fmtNum(v) + '%' },
  nextEnergy: { y: (v) => v, fmt: (v) => fmtNum(v, 1) },
  deepWorkH: { y: (v) => v, fmt: (v) => fmtNum(v, 1) + ' h' },
  executionScore: { y: (v) => v, fmt: (v) => fmtNum(v) },
};
const OUT_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.key, o.label]));
const WHEN = { morning: 'next morning', night: 'that night', nextDay: 'next day', sameDay: 'same day' };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function compute(dv, p) {
  const rows = buildDaily(dv, p.from, p.to);
  const drivers = findDrivers(rows);
  return { rows, drivers, suff: dataSufficiency(rows) };
}

export default function Drivers({ app, period, today }) {
  const { data: d, ms } = useInsight(() => compute(app.dv, period), [period.from, period.to]);
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  if (!d) return html`<${SectionSkeleton} />`;
  const s = d.suff;
  const ready = s.pairedDays >= s.minN;
  const outcomes = [...new Set(d.drivers.map((x) => x.outcome))];
  const list = filter === 'all' ? d.drivers : d.drivers.filter((x) => x.outcome === filter);
  const keyOf = (x) => x.behavior + ':' + x.outcome;
  if (!ready) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="zap" title=${`${s.pairedDays} of ${s.minN} paired days`}
      text=${`Patterns unlock after ${s.minN} paired days${s.readyAt ? ` — about ${fmtDate(s.readyAt, { dow: false, year: s.readyAt.slice(0, 4) !== today.slice(0, 4) })}` : ''}${period.nominal < 90 ? '; a 90-day or longer range also helps' : ''}. A paired day has a logged behavior and the next morning's recovery or sleep.`}
      points=${['Behaviors: meal timing, caffeine, alcohol, bedtime, strain, calories, protein, meetings, days since a dose', 'Outcomes: next-morning recovery, HRV and resting HR, sleep, next-day energy, deep work, execution score', 'Only patterns that survive a multiple-testing correction are shown']}
      sources=${['whoop', 'meals', 'checkins']} /></div>`;
  }
  return html`<div class="stack" data-ms=${ms}>
    <${Card} title="What moves your numbers" meta=${`${s.pairedDays} paired days`}>
      <p class="ins-take">${d.drivers.length ? `${plural(d.drivers.length, 'pattern')} passed the correction in the last ${plural(period.days, 'day')}: ${d.drivers.filter((x) => x.direction === 'helps').length} help, ${d.drivers.filter((x) => x.direction === 'hurts').length} hurt.` : `No behavior–outcome pair passed the multiple-testing correction over ${plural(period.days, 'day')}. Weak effects need more varied days to show.`}</p>
      ${outcomes.length > 1 ? html`<${Chips} options=${[{ value: 'all', label: `All · ${d.drivers.length}` }, ...outcomes.map((o) => ({ value: o, label: `${cap(OUT_LABEL[o] || o)} · ${d.drivers.filter((x) => x.outcome === o).length}` }))]} value=${filter} onValue=${(v) => { setFilter(v); setOpen(null); }} />` : null}
      ${filter === 'all' && outcomes.length > 1
        ? outcomes.map((o) => html`<div class="ins-h" style="margin-top:12px">${cap(OUT_LABEL[o] || o)} <span class="ins-sub" style="font-weight:400">· ${WHEN[(OUTCOMES.find((z) => z.key === o) || {}).when] || ''}</span></div>
            <div class="ins-list">${d.drivers.filter((x) => x.outcome === o).map((x) => html`<${DriverRow} x=${x} rows=${d.rows} open=${open === keyOf(x)} onToggle=${() => setOpen(open === keyOf(x) ? null : keyOf(x))} />`)}</div>`)
        : html`<div class="ins-list" style="margin-top:6px">${list.map((x) => html`<${DriverRow} x=${x} rows=${d.rows} open=${open === keyOf(x)} onToggle=${() => setOpen(open === keyOf(x) ? null : keyOf(x))} />`)}</div>`}
    </${Card}>
    <${AssocNote} extra=${'Each pattern is tested within weekdays and weekends separately (so weekly habits do not pose as drivers), needs at least 21 paired days, and passed a Benjamini–Hochberg correction across every behavior–outcome pair tested (q ≤ 0.10). Effects compare the high and low halves of the behavior (or with vs without) in outcome units.'} />
  </div>`;
}

function DriverRow({ x, rows, open, onToggle }) {
  const tone = x.direction === 'helps' ? 'good' : 'bad';
  const stat = x.method === 'welch' ? `d = ${fmtSigned(x.d, 2)}` : `ρ = ${fmtSigned(x.rho, 2)}`;
  return html`<div class="ins-driver">
    <button type="button" class="ins-driver-btn" aria-expanded=${String(open)} onClick=${onToggle}>
      <${Icon} name="chevronRight" size=${16} />
      <div class="grow stack xs">
        <div class="ins-sentence">${driverSentence(x)}</div>
        <div class="ins-tags"><${Pill} tone=${tone} dot>${x.direction === 'helps' ? 'Helps' : 'Hurts'}</${Pill}><${Pill}>${x.strength}</${Pill}>
          <span class="tag">n=${x.n}</span><span class="tag">${fmtQ(x.q)}</span><span class="tag">${stat}</span></div>
      </div>
    </button>
    ${open ? html`<${DriverDetail} x=${x} rows=${rows} />` : null}
  </div>`;
}

function DriverDetail({ x, rows }) {
  const pairs = driverPairs(x, rows, { behaviors: BEHAVIORS, outcomes: OUTCOMES });
  const o = OY[x.outcome] || { y: (v) => v, fmt: (v) => fmtNum(v, 1) };
  const outcome = OUTCOMES.find((z) => z.key === x.outcome);
  const when = outcome ? WHEN[outcome.when] : '';
  const oLabel = `${OUT_LABEL[x.outcome] || x.outcome}${when ? ' · ' + when : ''}`;
  const g = x.groups || {};
  if (x.method === 'welch') {
    const b = BEHAVIORS.find((z) => z.key === x.behavior);
    const yes = b ? b.subject() : 'With';
    const max = Math.max(Math.abs(g.hi?.mean || 0), Math.abs(g.lo?.mean || 0)) || 1;
    return html`<div class="ins-detail">
      <div class="xs muted">${oLabel}: average on days with vs without, n days per group</div>
      <div class="ins-compare">
        <span class="small">${yes.replace(/^Days with /, 'With ').replace(/^Days /, '')}</span><div class="bar" style=${`width:${(Math.abs(g.hi?.mean || 0) / max) * 100}%`}></div><span class="mono small">${o.fmt(o.y(g.hi?.mean))} <span class="muted">n=${g.hi?.n}</span></span>
        <span class="small">Without</span><div class="bar alt" style=${`width:${(Math.abs(g.lo?.mean || 0) / max) * 100}%`}></div><span class="mono small">${o.fmt(o.y(g.lo?.mean))} <span class="muted">n=${g.lo?.n}</span></span>
      </div>
      <div class="xs muted">Difference ${x.effectText}; group sizes differ because not every day has the behavior logged.</div>
    </div>`;
  }
  const bx = BX[x.behavior] || { x: (v) => v, fmt: (v) => fmtNum(v, 1), label: x.behavior };
  const pts = pairs.filter((p) => isNum(p.x)).map((p) => ({ x: round(bx.x(p.x), 3), y: round(o.y(p.y), 3), label: fmtDate(p.date, { dow: false }) }));
  const th = x.threshold ? bx.fmt(bx.x(x.threshold.value)) : null;
  return html`<div class="ins-detail">
    <${Scatter} points=${pts} height=${190} xLabel=${bx.label} yLabel=${OUT_LABEL[x.outcome] || ''} xFormat=${bx.fmt} yFormat=${(v) => o.fmt(v)} />
    ${th ? html`<div class="xs muted">${x.threshold.op} ${th}: ${o.fmt(o.y(g.hi?.mean))} (n=${g.hi?.n}) · below: ${o.fmt(o.y(g.lo?.mean))} (n=${g.lo?.n}) — ${oLabel}. Each dot is one day.</div>` : null}
  </div>`;
}
