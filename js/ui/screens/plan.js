// OWNER: UI-A (Day). #/plan[/<date>][?view=week] — scheduling with plan vs actual, recovery-aware
// drafts, templates and calendar load (day view); allocation and timing targets (week view).
import { html } from '../../vendor/preact-htm.js';
import { useApp, useWide, useNow } from '../ctx.js';
import { Page, Segmented, IconButton, Button } from '../kit.js';
import { routeDate, dateLabel, DateNav } from '../parts/date.js';
import { addDays, weekStart, isoWeek, fmtDate } from '../../core/util.js';
import { PlanDay } from './plan/day.js';
import { PlanWeek } from './plan/week.js';

const VIEWS = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }];

function WeekNav({ date, onGo }) {
  const app = useApp(); const today = app.today();
  const thisWeek = weekStart(date) === weekStart(today);
  return html`<span class="row" style="gap:2px">
    <${IconButton} icon="chevronLeft" label="Previous week" sm onClick=${() => onGo(addDays(date, -7))} />
    <span class="mono xs dim" style="padding:0 6px">${isoWeek(date).replace('-', ' ')}</span>
    <${IconButton} icon="chevronRight" label="Next week" sm onClick=${() => onGo(addDays(date, 7))} />
    ${thisWeek ? null : html`<${Button} size="sm" variant="ghost" onClick=${() => onGo(today)}>This week</${Button}>`}
  </span>`;
}

export default function Screen({ route }) {
  const app = useApp(); const wide = useWide();
  useNow();
  if (app.dv.asOf && app.dv.asOf() !== app.today()) app.dv.invalidate();
  const today = app.today();
  const date = routeDate(route, app);
  const view = route.query && route.query.view === 'week' ? 'week' : 'day';
  const go = (d, v = view) => app.nav((d === today ? '/plan' : '/plan/' + d) + (v === 'week' ? '?view=week' : ''));
  const ws = weekStart(date); const we = addDays(ws, 6);
  const sub = view === 'day' ? dateLabel(date, today)
    : `${fmtDate(ws, { dow: false })} – ${fmtDate(we, { dow: false, year: we.slice(0, 4) !== today.slice(0, 4) })}${ws <= today && today <= we ? ' · this week' : ''}`;
  const seg = html`<${Segmented} options=${VIEWS} value=${view} onValue=${(v) => go(date, v)} label="View" />`;
  const nav = view === 'day' ? html`<${DateNav} date=${date} base="/plan" />` : html`<${WeekNav} date=${date} onGo=${(d) => go(d, 'week')} />`;
  return html`<${Page} wide title="Plan" sub=${sub} actions=${wide ? html`<span class="row" style="gap:10px">${nav}${seg}</span>` : null}>
    ${wide ? null : html`<div class="day-toolbar">${nav}${seg}</div>`}
    ${view === 'day' ? html`<${PlanDay} date=${date} />` : html`<${PlanWeek} date=${date} onDay=${(d) => go(d, 'day')} />`}
  </${Page}>`;
}
