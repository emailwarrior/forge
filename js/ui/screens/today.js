// OWNER: UI-A (Day). #/today[/<date>] — live cockpit for today, the full record of a past day,
// and the plan (blocks, calendar, protocol items due) for a future day.
import { html } from '../../vendor/preact-htm.js';
import { useApp, useAnalytics, useWide, useNow } from '../ctx.js';
import { Page, Button } from '../kit.js';
import { QuoteCard } from '../parts/common.js';
import { routeDate, DateNav } from '../parts/date.js';
import { readiness } from '../../analytics/index.js';
import { fmtDate, relDay } from '../../core/util.js';
import { ReadinessCard } from './today/readiness.js';
import { QuickLog, AddToDay } from './today/quicklog.js';
import { ExecutionCard } from './today/execution.js';
import { TimelineCard } from './today/timeline.js';
import { NutritionCard, TrainingCard, BodyCard, CheckinCard, JournalCard, DueCard } from './today/cards.js';
import { openDraft } from './plan/sheets.js';

export default function Screen({ route }) {
  const app = useApp();
  const wide = useWide();
  useNow(); // minute tick: now marker, date rollover
  // The DataView memoizes "today" per store version; drop it when the local date rolls over.
  if (app.dv.asOf && app.dv.asOf() !== app.today()) app.dv.invalidate();
  const today = app.today();
  const date = routeDate(route, app);
  const mode = date === today ? 'today' : date < today ? 'past' : 'future';
  const r = useAnalytics(() => (mode === 'future' ? null : readiness(app.dv, date)), [date, mode]);

  const rel = relDay(date, today);
  const title = mode === 'today' ? 'Today' : fmtDate(date, { year: date.slice(0, 4) !== today.slice(0, 4) });
  const sub = mode === 'today' ? fmtDate(date)
    : mode === 'past' ? (rel === 'Yesterday' ? 'Yesterday · day report' : 'Day report')
    : (rel === 'Tomorrow' ? 'Tomorrow · planned' : 'Planned day');
  const nav = html`<${DateNav} date=${date} base="/today" />`;

  let left, right, mobile;
  if (mode === 'future') {
    const actions = html`<div class="row wrap day-plan-actions">
      <${Button} size="sm" icon="sparkle" onClick=${() => openDraft(app, date)}>Draft this day</${Button}>
      <${Button} size="sm" icon="plan" onClick=${() => app.nav('/plan/' + date)}>Open in Plan</${Button}>
    </div>`;
    const timeline = html`<${TimelineCard} date=${date} mode=${mode} />`;
    const due = html`<${DueCard} date=${date} />`;
    const quote = html`<${QuoteCard} date=${date} />`;
    left = [actions, timeline]; right = [due, quote]; mobile = [actions, timeline, due, quote];
  } else {
    const ready = html`<${ReadinessCard} date=${date} r=${r} isToday=${mode === 'today'} />`;
    const quick = mode === 'today' ? html`<${QuickLog} date=${date} />` : html`<${AddToDay} date=${date} />`;
    const exec = html`<${ExecutionCard} date=${date} />`;
    const timeline = html`<${TimelineCard} date=${date} mode=${mode} />`;
    const nutr = html`<${NutritionCard} date=${date} mode=${mode} />`;
    const train = html`<${TrainingCard} date=${date} mode=${mode} r=${r} />`;
    const body = html`<${BodyCard} date=${date} />`;
    const checkin = html`<${CheckinCard} date=${date} mode=${mode} />`;
    const quote = html`<${QuoteCard} date=${date} />`;
    const journal = html`<${JournalCard} date=${date} />`;
    left = [ready, exec, timeline];
    right = [quick, nutr, train, body, checkin, quote, journal];
    mobile = [ready, quick, exec, timeline, nutr, train, body, checkin, quote, journal];
  }

  return html`<${Page} wide title=${title} sub=${sub} actions=${wide ? nav : null}>
    ${wide ? null : html`<div class="day-toolbar">${nav}</div>`}
    ${wide
      ? html`<div class="day-cols"><div class="stack lg">${left}</div><div class="stack lg">${right}</div></div>`
      : mobile}
  </${Page}>`;
}
