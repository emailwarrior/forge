// Protocols (#/protocols, #/protocols/<id>): today's stacks and due items, items by kind with adherence,
// last taken and next due; item detail with dose history, weekly totals, adherence calendar and sites.
import { html } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useWide } from '../ctx.js';
import { Page, Section, Card, Button, Check, Empty, List, ListRow, Pill, Disclosure, Icon, cx } from '../kit.js';
import { dueItems, protocolAdherence, nextDue } from '../../analytics/index.js';
import { addDays, relDay, fmtTime, isoWithOffset, isNum } from '../../core/util.js';
import { openStackLog, openDoseLog } from '../actions/stack.js';
import { openItemEditor } from './protocols/editor.js';
import ItemDetail from './protocols/detail.js';
import {
  KINDS, amountText, scheduleText, formLabel, todayGroups, stackTitle, lastTakenDose, lastSite, nextSite, weekTotal,
} from '../parts/records-protocols.js';
import { fmtQty, localHm, plural } from '../parts/records-util.js';
import { dateLabel } from '../parts/date.js';
import { RecordsOnlyNote } from '../parts/records-ui.js';

export default function Screen({ route }) {
  if (route.parts[1]) return html`<${ItemDetail} id=${route.parts[1]} />`;
  return html`<${ProtocolsHome} />`;
}

/** 30-day adherence per item id → { rate, taken, scheduled }. */
export function useAdherence30() {
  const app = useApp(); const today = app.today();
  return useAnalytics(() => new Map(protocolAdherence(app.dv, addDays(today, -29), today).map((x) => [x.item.id, x])), [today]) || new Map();
}

function ProtocolsHome() {
  const app = useApp(); useVersion(['protocolItems', 'doses']);
  const wide = useWide();
  const today = app.today();
  const all = app.store.all('protocolItems');
  const active = all.filter((i) => i.active !== false);
  const inactive = all.filter((i) => i.active === false);
  const adh = useAdherence30();
  const overall = (() => {
    let t = 0, s = 0;
    for (const x of adh.values()) if (x.item.active !== false && x.scheduled) { t += x.taken; s += x.scheduled; }
    return s ? Math.round((t / s) * 100) : null;
  })();
  const add = (kind) => openItemEditor(app, { kind });

  if (!all.length) {
    return html`<${Page} title="Protocols" sub="Supplements, peptides and medications">
      <${Empty} title="No protocol items yet" action=${html`<${Button} variant="primary" icon="plus" onClick=${() => add('supplement')}>Add first item</${Button}>`}>
        Set up each supplement, peptide or medication once: amount, unit, schedule and stack (AM, PM or your own).
        Then log a whole stack in one tap here or on Today, and FORGE tracks adherence, weekly totals and injection sites.
      </${Empty}>
      <div class="grid three rec-collapse-3">
        ${KINDS.map((k) => html`<button type="button" class="quick rec-quick" onClick=${() => add(k.value)}>
          <${Icon} name="plus" /><span class="stack xs"><span class="strong">Add ${k.label.toLowerCase()}</span><span class="sub">${k.value === 'supplement' ? 'Daily vitamins, creatine, magnesium' : k.value === 'peptide' ? 'Split doses toward a weekly total' : 'Prescribed, with a neutral label'}</span></span></button>`)}
      </div>
      <${RecordsOnlyNote} />
    </${Page}>`;
  }

  const sub = [plural(active.length, 'active item'), overall != null ? `30-day adherence ${overall}%` : null].filter(Boolean).join(' · ');
  return html`<${Page} title="Protocols" sub=${sub} wide
    actions=${html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => add('supplement')}>Add</${Button}>`}>
    <div class="rec-split">
      <${TodayPanel} date=${today} />
      <div class="stack lg">
        ${KINDS.map((k) => {
          const items = active.filter((i) => (i.kind || 'supplement') === k.value);
          if (!items.length) return null;
          return html`<${Section} title=${k.plural} meta=${plural(items.length, 'item')}>
            <${ItemsTable} items=${items} adh=${adh} wide=${wide} />
          </${Section}>`;
        })}
        ${!active.length ? html`<${Empty} title="No active items">All items are inactive. Reactivate one below or add a new item.</${Empty}>` : null}
        ${inactive.length ? html`<${Disclosure} summary=${`Inactive (${inactive.length})`}>
          <${ItemsTable} items=${inactive} adh=${adh} wide=${wide} inactive /></${Disclosure}>` : null}
      </div>
    </div>
    <${RecordsOnlyNote} />
  </${Page}>`;
}

/* ------------------------------------------------------------ today panel */
function TodayPanel({ date }) {
  const app = useApp(); const tz = app.dv.tz;
  const due = useAnalytics(() => dueItems(app.dv, date), [date]) || [];
  const groups = todayGroups(due.filter((x) => x.item.active !== false || x.taken));
  const totalDue = groups.reduce((s, g) => s + g.total, 0);
  const takenDue = groups.reduce((s, g) => s + g.taken, 0);

  const quickLog = (item) => {
    const doses = app.dv.dosesByItem().get(item.id) || [];
    const rec = app.store.create('doses', {
      itemId: item.id, date, at: isoWithOffset(Date.now(), tz), amount: isNum(item.amount) ? item.amount : null, unit: item.unit || null,
      ...(item.form === 'injection' ? { site: nextSite(lastSite(doses)) } : {}),
    });
    app.toast(`Logged ${item.name}${isNum(item.amount) ? ' · ' + amountText(item.amount, item.unit) : ''}`, { action: { label: 'Undo', onClick: () => app.store.remove('doses', rec.id) } });
  };
  const openRow = (row) => {
    const d = row.doses.find((x) => !x.skipped) || row.doses[0];
    openDoseLog(app, d ? { date, id: d.id } : { date, itemId: row.item.id });
  };

  return html`<${Card} title="Today" meta=${`${dateLabel(date, app.today()).replace(/^Today · /, '')}${totalDue ? ` · ${takenDue}/${totalDue} taken` : ''}`}
    action=${html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${() => openDoseLog(app, { date })}>Dose</${Button}>`} class="rec-today">
    ${!groups.length ? html`<div class="dim small">Nothing scheduled today. As-needed items can be logged with “Dose”.</div>` : html`<div class="stack">
      ${groups.map((g) => html`<div class="rec-stack">
        <div class="row between rec-stack-head">
          <div class="grow"><span class="strong small">${g.stack ? stackTitle(g.stack) : 'Not in a stack'}</span>
            ${g.total ? html`<span class="xs muted"> · ${g.taken}/${g.total}</span>` : null}</div>
          ${g.stack && g.total ? (g.taken >= g.total
            ? html`<${Pill} tone="good" dot>Done</${Pill}>`
            : html`<${Button} size="sm" onClick=${() => openStackLog(app, { date, stack: g.stack })}>Log stack</${Button}>`) : null}
        </div>
        ${g.rows.map((row) => {
          const t = row.taken ? localHm((row.doses.find((x) => !x.skipped) || {}).at, tz) : null;
          const skipped = !row.taken && row.doses.some((x) => x.skipped);
          const wt = row.item.weeklyTarget && isNum(row.item.weeklyTarget.amount) ? row.item.weeklyTarget : null;
          const week = wt ? weekTotal(app.dv.dosesByItem().get(row.item.id) || [], { itemId: row.item.id, date, unit: wt.unit || row.item.unit, fallbackUnit: row.item.unit, fallbackAmount: row.item.amount }) : null;
          const meta = [amountText(row.item.amount, row.item.unit), row.taken ? (t ? `Taken ${fmtTime(t)}` : 'Taken') : skipped ? 'Skipped' : row.due ? 'Due' : null,
            week ? `week ${fmtQty(week.total)}/${fmtQty(wt.amount)} ${wt.unit || row.item.unit || ''}`.trim() : null].filter(Boolean).join(' · ');
          return html`<div class=${cx('rec-dose-row', row.taken && 'done')}>
            <${Check} state=${row.taken} label=${(row.taken ? 'Edit ' : 'Log ') + row.item.name} onClick=${() => (row.taken ? openRow(row) : quickLog(row.item))} />
            <button type="button" class="grow rec-row-btn" onClick=${() => openRow(row)}>
              <span class="small strong ellipsis">${row.item.name}</span><span class="xs muted ellipsis">${meta}</span>
            </button>
          </div>`;
        })}
      </div>`)}
    </div>`}
  </${Card}>`;
}

/* ------------------------------------------------------------- item list */
function lastText(item, dosesByItem, today, tz) {
  const d = lastTakenDose(dosesByItem.get(item.id) || []);
  if (!d) return null;
  const hm = localHm(d.at, tz);
  return `${relDay(d.date, today)}${hm ? ' ' + fmtTime(hm) : ''}`;
}
function adhText(x) {
  if (!x) return '—';
  if (x.rate == null) return x.scheduled === 0 && x.taken ? plural(x.taken, 'day') : '—';
  return Math.round(x.rate) + '%';
}
const adhTone = (x) => (!x || x.rate == null ? '' : x.rate >= 90 ? 'ink-good' : x.rate >= 70 ? '' : 'ink-warn');

function ItemsTable({ items, adh, wide, inactive }) {
  const app = useApp(); const tz = app.dv.tz; const today = app.today();
  const byItem = app.dv.dosesByItem();
  const next = useAnalytics(() => new Map(items.map((i) => [i.id, i.active === false ? null : nextDue(app.dv, i, today)])), [items.map((i) => i.id).join(), today]) || new Map();
  const nextText = (i) => ((i.schedule && i.schedule.type) === 'asneeded' ? 'As needed' : next.get(i.id) ? relDay(next.get(i.id), today) : '—');
  const go = (i) => app.nav('/protocols/' + encodeURIComponent(i.id));
  if (wide) {
    return html`<div class="card flush"><div class="table-wrap"><table class="data rec-items">
      <colgroup><col style="width:23%" /><col style="width:12%" /><col style="width:18%" /><col style="width:9%" /><col style="width:22%" /><col style="width:16%" /></colgroup>
      <thead><tr><th>Item</th><th>Dose</th><th>Schedule</th><th class="num">30 days</th><th>Last taken</th><th>${inactive ? 'Ended' : 'Next due'}</th></tr></thead>
      <tbody>${items.map((i) => { const x = adh.get(i.id); return html`<tr class="link" onClick=${() => go(i)} tabIndex="0" onKeyDown=${(e) => { if (e.key === 'Enter') go(i); }}>
        <td><div class="strong">${i.name}</div>${i.neutralLabel ? html`<div class="xs muted">Shown outside as “${i.neutralLabel}”</div>` : null}</td>
        <td>${[amountText(i.amount, i.unit), i.form ? formLabel(i.form) : null].filter(Boolean).join(' · ') || '—'}</td>
        <td class="dim">${scheduleText(i.schedule)}</td>
        <td class=${cx('num', adhTone(x))} title=${x && x.scheduled ? `${x.taken} of ${x.scheduled} scheduled` : ''}>${adhText(x)}</td>
        <td class="dim nowrap">${lastText(i, byItem, today, tz) || '—'}</td>
        <td class="dim nowrap">${inactive ? (i.endedAt ? relDay(String(i.endedAt).slice(0, 10), today) : '—') : nextText(i)}</td>
      </tr>`; })}</tbody></table></div></div>`;
  }
  return html`<div class="card flush"><${List}>${items.map((i) => {
    const x = adh.get(i.id); const last = lastText(i, byItem, today, tz);
    return html`<${ListRow} onClick=${() => go(i)} title=${i.name}
      meta=${[[amountText(i.amount, i.unit), i.form ? formLabel(i.form).toLowerCase() : null].filter(Boolean).join(' '), scheduleText(i.schedule)].filter(Boolean).join(' · ')}
      trail=${html`<div class="rec-trail"><div class=${cx('mono small', adhTone(x))}>${adhText(x)}</div>
        <div class="xs muted">${inactive ? (i.endedAt ? 'Ended ' + relDay(String(i.endedAt).slice(0, 10), today) : 'Inactive') : last ? last : 'Not taken yet'}</div></div>`}>
      ${!inactive && next.get(i.id) && next.get(i.id) !== today && (i.schedule && i.schedule.type) !== 'daily' ? html`<div class="xs muted">Next: ${relDay(next.get(i.id), today)}</div>` : null}
    </${ListRow}>`;
  })}</${List}></div>`;
}
