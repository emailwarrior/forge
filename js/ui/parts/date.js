// Date navigation shared by per-day screens (#/today/<date>, #/plan/<date>, #/fuel/<date>).
import { html } from '../../vendor/preact-htm.js';
import { useApp } from '../ctx.js';
import { IconButton, Button } from '../kit.js';
import { addDays, isYmd, fmtDate, relDay } from '../../core/util.js';

/** Date for a per-day screen: route.arg when it is a valid 'YYYY-MM-DD', else today. */
export function routeDate(route, app) {
  return route && isYmd(route.arg) ? route.arg : app.today();
}

/** Page subtitle for a date: "Today · Sat, Sep 26" / "Tue, Sep 22, 2026". */
export function dateLabel(date, today) {
  const rel = relDay(date, today);
  const full = fmtDate(date, { year: date.slice(0, 4) !== today.slice(0, 4) });
  return rel === 'Today' || rel === 'Yesterday' || rel === 'Tomorrow' ? `${rel} · ${full}` : full;
}

/**
 * DateNav: { date, base ('/today'), max (latest allowed date; default: none), compact }
 * Prev/next arrows, a native date picker, and a Today shortcut. Navigates to `${base}/${date}` (today → base).
 */
export function DateNav({ date, base, max, compact }) {
  const app = useApp(); const today = app.today();
  const go = (d) => app.nav(d === today ? base : `${base}/${d}`);
  const next = addDays(date, 1); const canNext = !max || next <= max;
  return html`<span class="row" style="gap:2px">
    <${IconButton} icon="chevronLeft" label="Previous day" sm onClick=${() => go(addDays(date, -1))} />
    ${compact ? null : html`<label class="btn ghost sm" style="position:relative" title="Pick a date">
      <span class="mono xs">${date === today ? 'Today' : date.slice(5).replace('-', '/')}</span>
      <input type="date" value=${date} max=${max || undefined} aria-label="Pick a date"
        style="position:absolute;inset:0;opacity:0;cursor:pointer" onChange=${(e) => { const v = e.currentTarget.value; if (isYmd(v)) go(v); }} /></label>`}
    <${IconButton} icon="chevronRight" label="Next day" sm disabled=${!canNext} onClick=${() => canNext && go(next)} />
    ${date !== today ? html`<${Button} size="sm" variant="ghost" onClick=${() => go(today)}>Today</${Button}>` : null}
  </span>`;
}
