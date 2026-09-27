// Plan → week view (Mon–Sun): per-day planned vs done minutes, meeting hours and adherence,
// time allocation by category, timing targets vs actual, and "copy last week's plan".
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics, useWide } from '../../ctx.js';
import { Card, Button, Meter, cx } from '../../kit.js';
import { Metric, CatSwatch, catLabel } from '../../parts/day-ui.js';
import { weekRows, weekCopyPlan, fmtMinutes } from '../../parts/day-model.js';
import { timeAllocation, timingTargets } from '../../../analytics/index.js';
import { addDays, dateRange, weekStart, dayOfWeek, dowName, fmtTime, fmtNum, isNum } from '../../../core/util.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const adhTone = (a, past) => (!isNum(a) ? null : a >= 90 ? 'good' : a < 70 && past ? 'bad' : 'warn');

export function PlanWeek({ date, onDay }) {
  const app = useApp(); const wide = useWide();
  const today = app.today();
  const ws = weekStart(date); const we = addDays(ws, 6);
  const w = useAnalytics(() => weekRows(app.dv, ws), [ws]);
  const alloc = useAnalytics(() => timeAllocation(app.dv, ws, we), [ws]);
  const timing = useAnalytics(() => timingTargets(app.dv, ws, we), [ws]);
  if (!w) return null;
  const t = w.totals;
  const canCopy = we >= today;

  const copyLastWeek = async () => {
    const r = weekCopyPlan(dateRange(ws, we), (d) => app.dv.plan(d), { from: today });
    if (!r.add.length) {
      app.toast(r.skippedDays.length ? 'Days that had a plan last week already have blocks this week' : 'Last week has no plan to copy into the remaining days');
      return;
    }
    const days = r.copiedDays.map((d) => dowName(dayOfWeek(d))).join(', ');
    const ok = await app.confirm({
      title: 'Copy last week’s plan?',
      message: `${plural(r.add.length, 'block')} into ${days}.${r.skippedDays.length ? ` ${plural(r.skippedDays.length, 'day')} that already have blocks ${r.skippedDays.length === 1 ? 'is' : 'are'} skipped.` : ''}${r.pastDays.length ? ' Past days are not changed.' : ''}`,
      confirmLabel: `Copy ${plural(r.add.length, 'block')}`,
    });
    if (!ok) return;
    const ids = r.add.map((f) => app.store.create('plan', f).id);
    app.toast(`Copied ${plural(ids.length, 'block')} into ${plural(r.copiedDays.length, 'day')}`, { action: { label: 'Undo', onClick: () => { for (const id of ids) app.store.remove('plan', id); } } });
  };

  const summary = html`<div class="card tight day-context"><div class="day-context-grid four">
    <${Metric} label="Planned" value=${fmtMinutes(t.plannedMin)} sub=${`${plural(t.days, 'day')} with a plan`} />
    <${Metric} label="Done" value=${fmtMinutes(t.doneMin)} sub=${t.judgedDays ? `over ${plural(t.judgedDays, 'day')} so far` : 'nothing to judge yet'} />
    <${Metric} label="Adherence" value=${isNum(t.adherence) ? `${fmtNum(t.adherence, 0)}%` : '—'} tone=${adhTone(t.adherence, we < today)} sub="done ÷ planned minutes" />
    <${Metric} label="Meetings" value=${t.meetingMin != null ? fmtMinutes(t.meetingMin) : '—'} sub=${t.meetingMin != null ? plural(t.meetingCount || 0, 'event') : 'calendar not connected'} />
  </div></div>`;

  const days = wide
    ? html`<div class="day-week">${w.rows.map((r) => html`<button type="button" key=${r.date} class=${cx('day-wcell', r.date === today && 'today', !r.blocks && 'empty')} onClick=${() => onDay(r.date)}>
        <div class="d"><span>${dowName(dayOfWeek(r.date))}</span><b>${Number(r.date.slice(8))}</b></div>
        <div class="big">${isNum(r.adherence) ? `${fmtNum(r.adherence, 0)}%` : r.blocks ? '—' : ''}</div>
        ${r.blocks ? html`<${Meter} value=${r.adherence ?? 0} tone=${adhTone(r.adherence, r.date < today) || 'accent'} />` : null}
        <div class="kv2"><span>Planned</span><b>${r.plannedMin ? fmtMinutes(r.plannedMin) : '—'}</b></div>
        <div class="kv2"><span>Done</span><b>${r.doneMin != null ? fmtMinutes(r.doneMin) : '—'}</b></div>
        <div class="kv2"><span>Meetings</span><b>${r.meetingMin != null ? fmtMinutes(r.meetingMin) : '—'}</b></div>
        ${r.byCategory.length ? html`<div class="mix">${r.byCategory.map((c) => html`<i key=${c.category} class=${'dc-' + c.category} style=${`flex:${c.plannedMin}`} title=${`${catLabel(c.category)} ${fmtMinutes(c.plannedMin)}`}></i>`)}</div>` : html`<div class="xs muted">No plan</div>`}
      </button>`)}</div>`
    : html`<div class="card flush"><div class="list">${w.rows.map((r) => html`<div key=${r.date} class=${cx('list-row link day-wrow', r.date === today && 'today')} role="button" tabIndex="0" onClick=${() => onDay(r.date)}
        onKeyDown=${(e) => { if (e.key === 'Enter') onDay(r.date); }}>
        <div class="dd"><span class="xs muted">${dowName(dayOfWeek(r.date))}</span><b>${Number(r.date.slice(8))}</b></div>
        <div class="grow" style="min-width:0">
          <div class="small">${r.blocks ? html`${r.doneMin != null ? html`<b>${fmtMinutes(r.doneMin)}</b> of ` : null}${fmtMinutes(r.plannedMin)} planned` : html`<span class="muted">No plan</span>`}</div>
          <div class="xs muted">${r.meetingMin != null ? `Meetings ${fmtMinutes(r.meetingMin)}${r.meetingCount ? ` (${r.meetingCount})` : ''}` : 'Calendar not connected'}</div>
          ${r.byCategory.length ? html`<div class="mix">${r.byCategory.map((c) => html`<i key=${c.category} class=${'dc-' + c.category} style=${`flex:${c.plannedMin}`}></i>`)}</div>` : null}
        </div>
        <div class=${cx('adh mono', r.adherence != null && 'ink-' + adhTone(r.adherence, r.date < today))}>${isNum(r.adherence) ? `${fmtNum(r.adherence, 0)}%` : ''}</div>
      </div>`)}</div></div>`;

  const maxAlloc = Math.max(1, ...(alloc || []).map((a) => a.plannedMin));
  const allocation = html`<${Card} title="Time allocation" meta="done / planned">
    ${alloc && alloc.length ? html`<div class="day-cats">${alloc.map((c) => html`<div key=${c.category} class=${cx('day-cat', 'dc-' + c.category)}>
      <span class="nm"><${CatSwatch} category=${c.category} />${catLabel(c.category)}</span>
      <span class="bar"><span class="plan" style=${`width:${(c.plannedMin / maxAlloc) * 100}%`}><span class="done" style=${`width:${c.doneMin != null && c.plannedMin ? Math.min(100, (c.doneMin / c.plannedMin) * 100) : 0}%`}></span></span></span>
      <span class="v mono">${c.doneMin != null ? `${fmtMinutes(c.doneMin)} / ` : ''}${fmtMinutes(c.plannedMin)}</span>
    </div>`)}</div>` : html`<div class="small dim">No blocks planned this week. Open a day to draft it from readiness and your template, apply a template, or copy a previous day.</div>`}
  </${Card}>`;

  const hitCls = (row) => (isNum(row.hitRate) ? (row.hitRate >= 80 ? 'ink-good' : row.hitRate < 50 ? 'ink-bad' : null) : null);
  const timingCard = html`<${Card} title="Timing targets" meta="this week">
    ${wide ? null : html`<div class="day-timing">${(timing || []).map((row) => html`<div key=${row.key} class="r">
      <span class="k"><span>${row.label}</span><span class="g xs muted">avg ${row.avgActual != null ? fmtTime(row.avgActual) : '—'} · goal ${row.target != null ? fmtTime(row.target) : '—'} · ${row.n} day${row.n === 1 ? '' : 's'}</span></span>
      <span></span>
      <span class=${cx('d small', hitCls(row))}>${isNum(row.hitRate) ? `${fmtNum(row.hitRate, 0)}% hit` : '—'}</span>
    </div>`)}</div>`}
    ${wide ? html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Target</th><th class="num">Goal</th><th class="num">Average</th><th class="num">Hit rate</th><th class="num">Days</th></tr></thead>
      <tbody>${(timing || []).map((row) => html`<tr key=${row.key}>
        <td>${row.label}</td>
        <td class="num">${row.target != null ? fmtTime(row.target) : '—'}</td>
        <td class="num">${row.avgActual != null ? fmtTime(row.avgActual) : '—'}</td>
        <td class=${cx('num', hitCls(row))}>${isNum(row.hitRate) ? `${fmtNum(row.hitRate, 0)}%` : '—'}</td>
        <td class="num">${row.n}</td>
      </tr>`)}</tbody>
    </table></div>` : null}
    <div class="xs muted" style="margin-top:8px">Hit = at or before the target. Wake and bedtime come from WHOOP, caffeine from check-ins, last meal from meal times. Targets live in Settings → Targets.</div>
  </${Card}>`;

  const copy = canCopy ? html`<div class="row wrap between" style="gap:8px">
    <span class="xs muted">Fills this week’s remaining empty days with last week’s blocks.</span>
    <${Button} size="sm" icon="copy" onClick=${copyLastWeek}>Copy last week’s plan</${Button}>
  </div>` : null;

  if (wide) return html`${summary}${days}<div class="day-cols"><div class="stack lg">${allocation}</div><div class="stack lg">${timingCard}${copy}</div></div>`;
  return html`${summary}${copy}${days}${allocation}${timingCard}`;
}
