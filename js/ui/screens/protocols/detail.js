// Protocol item detail (#/protocols/<id>): adherence, last/next, weekly totals vs target, adherence calendar,
// dose history, injection-site history, item details. FORGE records; it never suggests dose changes.
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useWide } from '../../ctx.js';
import { Page, Card, Button, IconButton, Empty, Stat, KV, List, ListRow, Pill, cx } from '../../kit.js';
import { BarChart } from '../../charts.js';
import { protocolAdherence, doseCycle, nextDue, isDue, takenOn } from '../../../analytics/index.js';
import { addDays, weekStart, dateRange, relDay, fmtDate, fmtTime, isNum, dowName, dayOfWeek } from '../../../core/util.js';
import { openDoseLog } from '../../actions/stack.js';
import { openItemEditor } from './editor.js';
import {
  amountText, scheduleText, kindLabel, formLabel, lastTakenDose, lastSite, nextSite, siteHistory, weekTotal, convertAmount,
} from '../../parts/records-protocols.js';
import { fmtQty, localHm, plural } from '../../parts/records-util.js';
import { RecordsOnlyNote, AdherenceCalendar, AdherenceLegend, shortDay } from '../../parts/records-ui.js';

export default function ItemDetail({ id }) {
  const app = useApp(); useVersion(['protocolItems', 'doses']);
  const item = app.store.get('protocolItems', id);
  if (!item) {
    return html`<${Page} title="Protocol item" back="/protocols">
      <${Empty} title="This item no longer exists" action=${html`<${Button} onClick=${() => app.nav('/protocols')}>Back to Protocols</${Button}>`}>It may have been deleted on this or another device.</${Empty}>
    </${Page}>`;
  }
  return html`<${Detail} item=${item} />`;
}

function Detail({ item }) {
  const app = useApp(); const wide = useWide();
  const today = app.today(); const tz = app.dv.tz; const id = item.id;
  const doses = app.dv.dosesByItem().get(id) || [];
  const adh = useAnalytics(() => protocolAdherence(app.dv, addDays(today, -29), today).find((x) => x.item.id === id) || null, [id, today]);
  const cycle = useAnalytics(() => doseCycle(app.dv, id), [id, today]);
  const next = useAnalytics(() => nextDue(app.dv, item, today), [id, today]);
  const cal = useAnalytics(() => {
    const from = addDays(weekStart(today), -7 * 12);
    return dateRange(from, today).map((d) => {
      const due = isDue(app.dv, item, d); const taken = takenOn(app.dv, id, d);
      return { date: d, state: taken ? (due ? 'taken' : 'extra') : due ? (d === today ? 'due' : 'missed') : 'none' };
    });
  }, [id, today]) || [];
  const wt = item.weeklyTarget && isNum(item.weeklyTarget.amount) ? item.weeklyTarget : null;
  const wUnit = wt ? wt.unit || item.unit : item.unit;
  const week = weekTotal(doses, { itemId: id, date: today, unit: wUnit, fallbackUnit: item.unit, fallbackAmount: item.amount });
  const last = lastTakenDose(doses);
  const lastHm = last ? localHm(last.at, tz) : null;
  const asNeeded = (item.schedule && item.schedule.type) === 'asneeded';
  const showSites = item.form === 'injection' || doses.some((d) => d.site);
  const targetInItemUnit = wt ? convertAmount(wt.amount, wt.unit || item.unit, item.unit) : null;
  // Weekly totals from the week the item started (or was first taken), not a fixed 90-day window of empty weeks.
  const firstDose = doses.find((x) => !x.skipped && x.date);
  const since = [item.startedAt ? String(item.startedAt).slice(0, 10) : null, firstDose ? firstDose.date : null].filter(Boolean).sort()[0] || null;
  const weeks = ((cycle && cycle.weeklyTotals) || []).filter((w) => !since || w.week >= weekStart(since));
  const edit = async () => { const r = await openItemEditor(app, { id }); if (r === 'deleted') app.nav('/protocols'); };

  const sub = [kindLabel(item.kind), [amountText(item.amount, item.unit), item.form ? formLabel(item.form).toLowerCase() : null].filter(Boolean).join(' '), scheduleText(item.schedule), item.active === false ? 'Inactive' : null].filter(Boolean).join(' · ');
  const missed = cal.filter((d) => d.state === 'missed').length;
  const takenDays = cal.filter((d) => d.state === 'taken' || d.state === 'extra').length;
  const logBtn = html`<${Button} size=${wide ? 'sm' : undefined} block=${!wide} variant="primary" icon="plus" onClick=${() => openDoseLog(app, { itemId: id })}>Log dose</${Button}>`;
  const dayWord = (d) => (d && d !== today && Math.abs(Date.parse(d) - Date.parse(today)) > 86400000 ? dowName(dayOfWeek(d)) : null);

  return html`<${Page} title=${item.name} sub=${sub} back="/protocols" wide
    actions=${html`<${IconButton} icon="edit" label="Edit item" bordered onClick=${edit} />${wide ? logBtn : null}`}>
    ${wide ? null : logBtn}
    <div class="grid four">
      <div class="card tight"><${Stat} label="30-day adherence" value=${adh && adh.rate != null ? Math.round(adh.rate) : '—'} unit="%"
        sub=${adh ? (asNeeded ? `Taken on ${plural(adh.taken, 'day')}` : adh.scheduled ? `${adh.taken} of ${adh.scheduled} scheduled` : 'Nothing scheduled yet') : null} /></div>
      <div class="card tight"><${Stat} label="Last taken" value=${last ? shortDay(last.date, today) : '—'}
        sub=${last ? [dayWord(last.date), lastHm ? fmtTime(lastHm) : null, amountText(isNum(last.amount) ? last.amount : item.amount, last.unit || item.unit), last.site].filter(Boolean).join(' · ') : 'No doses logged'} /></div>
      <div class="card tight"><${Stat} label="Next due" value=${asNeeded ? 'As needed' : next ? shortDay(next, today) : '—'}
        sub=${asNeeded ? null : next === today ? 'Not logged yet' : next ? dayWord(next) || fmtDate(next) : item.active === false ? 'Inactive' : 'Nothing scheduled'} /></div>
      <div class="card tight"><${Stat} label=${wt ? 'This week vs target' : 'This week'} value=${fmtQty(week.total)} unit=${wt ? `/ ${fmtQty(wt.amount)} ${wUnit || ''}` : wUnit || ''}
        sub=${`${plural(week.count, 'dose')} since ${fmtDate(week.from, { dow: false })}`} /></div>
    </div>

    <div class="grid two rec-collapse">
      <${Card} title="Weekly total" meta=${wt ? `Target ${fmtQty(wt.amount)} ${wUnit || ''}` : wUnit ? `In ${wUnit}` : null}>
        <${BarChart} data=${weeks.some((w) => w.amount > 0) ? weeks.map((w) => ({ x: w.week, y: w.amount, label: `Week of ${fmtDate(w.week, { dow: false })}` })) : []}
          target=${isNum(targetInItemUnit) ? { y: targetInItemUnit, label: 'Target' } : null} yFormat=${(v) => fmtQty(v)} height=${170}
          emptyText="Weekly totals appear after the first logged dose" />
        <div class="xs muted" style="margin-top:6px">Monday–Sunday weeks, last 90 days, taken doses only${item.unit ? ` (${item.unit})` : ''}.</div>
      </${Card}>
      <${Card} title="Adherence · 13 weeks" meta=${asNeeded ? `${plural(takenDays, 'day')} taken` : `${takenDays} taken · ${missed} missed`}>
        <${AdherenceCalendar} days=${cal} />
        <${AdherenceLegend} />
      </${Card}>
    </div>

    <div class="rec-split wide-right">
      <${DoseHistory} item=${item} doses=${doses} wide=${wide} />
      <div class="stack">
        ${showSites ? html`<${Sites} doses=${doses} today=${today} />` : null}
        <${Card} title="Details">
          <${KV} items=${[
            ['Kind', kindLabel(item.kind)],
            ['Dose', amountText(item.amount, item.unit) || '—'],
            ['Form', item.form ? formLabel(item.form) : '—'],
            ['Schedule', scheduleText(item.schedule)],
            wt ? ['Weekly target', `${fmtQty(wt.amount)} ${wt.unit || item.unit || ''}`] : null,
            ['Neutral label', item.neutralLabel || '—'],
            ['Started', item.startedAt ? fmtDate(String(item.startedAt).slice(0, 10), { year: true }) : '—'],
            item.endedAt ? ['Ended', fmtDate(String(item.endedAt).slice(0, 10), { year: true })] : null,
          ]} />
          ${item.note ? html`<p class="small dim rec-prewrap" style="margin-top:12px">${item.note}</p>` : null}
        </${Card}>
        <${Button} variant="ghost" icon="insights" onClick=${() => app.nav('/insights/protocols')}>Dose-cycle analysis in Insights</${Button}>
      </div>
    </div>
    <${RecordsOnlyNote} />
  </${Page}>`;
}

function DoseHistory({ item, doses, wide }) {
  const app = useApp(); const tz = app.dv.tz; const today = app.today();
  const [all, setAll] = useState(false);
  const list = doses.slice().reverse();
  const limit = wide ? 12 : 8;
  const shown = all ? list : list.slice(0, limit);
  const anySite = doses.some((d) => d.site);
  const anyNote = doses.some((d) => d.note);
  const open = (d) => openDoseLog(app, { id: d.id });
  const amt = (d) => amountText(isNum(d.amount) ? d.amount : item.amount, d.unit || item.unit) || '—';
  const more = list.length > limit ? html`<div class="rec-card-foot"><${Button} size="sm" variant="ghost" onClick=${() => setAll(!all)}>${all ? 'Show recent' : `Show all ${list.length}`}</${Button}></div>` : null;
  if (!list.length) {
    return html`<${Card} title="Dose history"><div class="dim small">No doses logged yet. Use “Log dose”, the stack on Today, or the Today panel in Protocols.</div></${Card}>`;
  }
  if (wide) {
    return html`<${Card} title="Dose history" meta=${plural(list.length, 'dose')} flush>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Time</th><th class="num">Amount</th>${anySite ? html`<th>Site</th>` : null}<th>Status</th>${anyNote ? html`<th>Note</th>` : null}</tr></thead>
        <tbody>${shown.map((d) => { const hm = localHm(d.at, tz); return html`<tr class="link" onClick=${() => open(d)}>
          <td>${relDay(d.date, today)}</td><td class="dim">${hm ? fmtTime(hm) : '—'}</td><td class="num">${amt(d)}</td>
          ${anySite ? html`<td class="dim">${d.site || '—'}</td>` : null}
          <td>${d.skipped ? html`<${Pill} tone="warn">Skipped</${Pill}>` : html`<span class="dim">Taken</span>`}</td>
          ${anyNote ? html`<td class="dim ellipsis rec-note-cell">${d.note || ''}</td>` : null}</tr>`; })}</tbody>
      </table></div>${more}
    </${Card}>`;
  }
  return html`<${Card} title="Dose history" meta=${plural(list.length, 'dose')} flush>
    <${List}>${shown.map((d) => { const hm = localHm(d.at, tz); return html`<${ListRow} onClick=${() => open(d)}
      title=${`${relDay(d.date, today)}${hm ? ' · ' + fmtTime(hm) : ''}`}
      meta=${[amt(d), d.site, d.note].filter(Boolean).join(' · ')}
      trail=${d.skipped ? html`<${Pill} tone="warn">Skipped</${Pill}>` : null} />`; })}</${List}>${more}
  </${Card}>`;
}

function Sites({ doses, today }) {
  const hist = siteHistory(doses, { since: addDays(today, -89) });
  const next = nextSite(lastSite(doses));
  return html`<${Card} title="Injection sites · 90 days" meta=${`Next: ${next}`}>
    <div class="rec-sites">${hist.map((h) => html`<div class=${cx('rec-site', h.site === next && 'next')}>
      <div class="small strong">${h.site}</div>
      <div class="xs muted"><span class="mono">${h.count}</span> · ${h.last ? relDay(h.last, today) : 'not used'}</div></div>`)}</div>
  </${Card}>`;
}
