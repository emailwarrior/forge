// Plan → day view: readiness + calendar load context, the visual schedule, plan vs actual with
// status controls, drafting / templates / copy actions and the Google Calendar sync note.
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics, useWide, useNow, useSetting, useVersion } from '../../ctx.js';
import { Card, Button, Notice, Icon, cx } from '../../kit.js';
import { openBlock } from '../../actions/plan.js';
import { Metric, CatSwatch, StatusControl, setBlockStatus, catLabel } from '../../parts/day-ui.js';
import { blockSpan, fmtSpan, fmtMinutes, fmtAgo } from '../../parts/day-model.js';
import { readiness, calendarLoad, planVsActual } from '../../../analytics/index.js';
import { hmToMin, localParts, isNum, fmtNum } from '../../../core/util.js';
import { DaySchedule } from './schedule.js';
import { openDraft, openTemplates, openCopyFrom } from './sheets.js';

const BAND_TONE = { green: 'good', yellow: 'warn', red: 'bad' };

export function PlanDay({ date }) {
  const app = useApp(); const wide = useWide(); const nowMs = useNow();
  const today = app.today();
  const mode = date === today ? 'today' : date < today ? 'past' : 'future';
  const d = useAnalytics(() => {
    const dv = app.dv;
    return {
      r: readiness(dv, date), load: calendarLoad(dv, date), pva: planVsActual(dv, date),
      blocks: dv.plan(date), events: dv.eventBlocks(date), allDay: dv.events(date).filter((e) => e.allDay && e.status !== 'declined'),
    };
  }, [date]);
  if (!d) return null;
  const nowMin = mode === 'today' ? localParts(nowMs, app.dv.tz).min : null;

  const context = html`<${ContextStrip} r=${d.r} load=${d.load} mode=${mode} />`;
  const actions = html`<div class="row wrap day-plan-actions">
    ${mode !== 'past' ? html`<${Button} size="sm" icon="sparkle" onClick=${() => openDraft(app, date)}>Draft my day</${Button}>` : null}
    <${Button} size="sm" icon="layers" onClick=${() => openTemplates(app, date)}>Templates</${Button}>
    <${Button} size="sm" icon="copy" onClick=${() => openCopyFrom(app, date)}>Copy from…</${Button}>
    <${Button} size="sm" variant="primary" icon="plus" onClick=${() => openBlock(app, { date })}>Block</${Button}>
  </div>`;
  const focus = mode !== 'past' && d.r && d.r.focus && d.r.focus.start ? d.r.focus : null;
  const schedule = html`<${Card} title="Schedule" meta=${[d.blocks.length ? `${d.blocks.length} block${d.blocks.length === 1 ? '' : 's'}` : null, d.events.length ? `${d.events.length} event${d.events.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || null}>
    ${d.allDay.length ? html`<div class="row wrap" style="gap:6px;margin-bottom:10px">${d.allDay.map((e) => html`<span key=${e.id} class="pill"><${Icon} name="calendar" size=${12} /> ${e.title || 'All day'}</span>`)}</div>` : null}
    <${DaySchedule} date=${date} blocks=${d.blocks} events=${d.events} nowMin=${nowMin} focus=${focus} />
    <div class="day-sched-legend xs muted">
      <span><i class="lg-blk"></i>Plan block</span><span><i class="lg-evt"></i>Calendar event</span>
      ${focus ? html`<span><i class="lg-focus"></i>Focus ${fmtSpan(hmToMin(focus.start), hmToMin(focus.end))}</span>` : null}
    </div>
    <div class="xs muted" style="margin-top:4px">Tap an empty slot to add a block; tap a block to edit it.</div>
  </${Card}>`;
  const pva = html`<${PlanVsActual} date=${date} pva=${d.pva} blocks=${d.blocks} mode=${mode} />`;
  const sync = html`<${SyncNote} />`;
  if (wide) {
    return html`${context}${actions}<div class="day-cols"><div class="stack lg">${schedule}</div><div class="stack lg">${pva}${sync}</div></div>`;
  }
  return html`${context}${actions}${schedule}${pva}${sync}`;
}

/* Readiness mode + calendar load for the day. */
function ContextStrip({ r, load, mode }) {
  const app = useApp();
  const t = r && r.training;
  const scored = r && r.status !== 'no-data';
  const whoop = !!(app.store.setting('integrations').whoop || {}).connectedAt || app.store.all('whoopRecovery').length > 0;
  const readinessCell = html`<${Metric} label="Readiness" value=${scored ? t.label : mode === 'future' ? 'Not yet' : '—'}
    tone=${scored ? BAND_TONE[r.band] : null}
    sub=${scored ? `strain ${t.strainTarget.join('–')}${isNum(r.score) ? ` · ${r.scoreSource === 'whoop' ? 'recovery' : 'score'} ${Math.round(r.score)}` : ''}` : !whoop ? 'WHOOP not connected' : mode === 'future' ? 'scored that morning' : 'no WHOOP data'} />`;
  if (!load.connected) {
    return html`<div class="card tight day-context">
      <div class="day-context-grid one">${readinessCell}</div>
      <${Notice}><div class="row between wrap" style="gap:8px"><span>Connect Google Calendar to see meeting load and plan around meetings.</span>
        <${Button} size="sm" onClick=${() => app.nav('/settings/integrations')}>Settings → Integrations</${Button}></div></${Notice}>
    </div>`;
  }
  const frag = isNum(load.fragmentation) ? Math.round(load.fragmentation * 100) : null;
  return html`<div class="card tight day-context"><div class="day-context-grid">
    ${readinessCell}
    <${Metric} label="Meetings" value=${fmtMinutes(load.meetingMin)}
      sub=${load.count ? `${load.count} event${load.count === 1 ? '' : 's'} · ${fmtSpan(hmToMin(load.firstStart), hmToMin(load.lastEnd))}` : 'none scheduled'} />
    <${Metric} label="Back-to-back" value=${String(load.backToBack ?? '—')} sub="≤ 5 min apart" tone=${load.backToBack >= 3 ? 'warn' : null} />
    <${Metric} label="Longest free" value=${fmtMinutes(load.longestFreeBlockMin)} sub="within 8 AM–6 PM" />
    <${Metric} label="Fragmented" value=${frag != null ? `${frag}%` : '—'} sub="of free time in < 60-min gaps" tone=${frag != null && frag >= 40 ? 'warn' : null} />
    <${Metric} label="After hours" value=${fmtMinutes(load.afterHoursMin)} sub="outside 8 AM–6 PM" tone=${load.afterHoursMin >= 60 ? 'warn' : null} />
  </div></div>`;
}

/* Planned vs done minutes, adherence, category bars and status controls per block. */
function PlanVsActual({ date, pva, blocks, mode }) {
  const app = useApp();
  const judged = mode !== 'future';
  if (!blocks.length) {
    return html`<${Card} title="Plan vs actual">
      <div class="small dim">No blocks planned for this day. ${mode === 'past' ? 'Copy or apply a plan to record what the day was for.' : '“Draft my day” builds a recovery-aware plan from your template or recent weeks; you can also apply a template or tap the schedule.'}</div>
    </${Card}>`;
  }
  const maxPlanned = Math.max(...pva.byCategory.map((c) => c.plannedMin || 0), 1);
  const adh = pva.adherence;
  return html`<${Card} title="Plan vs actual" meta=${judged ? (mode === 'today' ? 'so far today' : null) : 'planned'}>
    <div class="day-metrics first">
      <${Metric} label="Planned" value=${fmtMinutes(pva.plannedMin)} sub=${`${blocks.length} block${blocks.length === 1 ? '' : 's'}`} />
      <${Metric} label="Done" value=${judged ? fmtMinutes(pva.doneMin) : '—'} sub=${judged ? 'partial counts half' : 'after the day starts'} />
      <${Metric} label="Adherence" value=${isNum(adh) ? `${fmtNum(adh, 0)}%` : '—'} tone=${isNum(adh) ? (adh >= 90 ? 'good' : adh < 70 && mode === 'past' ? 'bad' : null) : null} sub=${isNum(adh) ? 'of planned minutes' : null} />
      <${Metric} label="Open" value=${String(blocks.filter((b) => (b.status || 'planned') === 'planned').length)} sub="not yet marked" />
    </div>
    <div class="day-cats">${pva.byCategory.map((c) => html`<div key=${c.category} class=${cx('day-cat', 'dc-' + c.category)}>
      <span class="nm"><${CatSwatch} category=${c.category} />${catLabel(c.category)}</span>
      <span class="bar"><span class="plan" style=${`width:${(c.plannedMin / maxPlanned) * 100}%`}><span class="done" style=${`width:${judged && c.doneMin != null && c.plannedMin ? Math.min(100, (c.doneMin / c.plannedMin) * 100) : 0}%`}></span></span></span>
      <span class="v mono">${judged && c.doneMin != null ? `${fmtMinutes(c.doneMin)} / ` : ''}${fmtMinutes(c.plannedMin)}</span>
    </div>`)}</div>
    <div class="day-pva-list">${blocks.map((b) => {
      const sp = blockSpan(b); const st = b.status || 'planned';
      return html`<div key=${b.id} class=${cx('day-pva', 'bs-' + st)}>
        <div class="grow link" style="min-width:0" onClick=${() => openBlock(app, { id: b.id })} role="button" tabIndex="0" onKeyDown=${(e) => { if (e.key === 'Enter') openBlock(app, { id: b.id }); }}>
          <div class="row" style="gap:8px"><${CatSwatch} category=${b.category} /><span class="t ellipsis">${b.title || catLabel(b.category)}</span></div>
          <div class="xs muted">${sp ? `${fmtSpan(sp.start, sp.end)} · ${fmtMinutes(sp.end - sp.start)}` : '—'}${isNum(b.actualMin) ? ` · actual ${fmtMinutes(b.actualMin)}` : ''}</div>
        </div>
        ${judged ? html`<${StatusControl} status=${st} onValue=${(v) => setBlockStatus(app, b.id, v)} label=${'Status of ' + (b.title || 'block')} />` : null}
      </div>`;
    })}</div>
  </${Card}>`;
}

/* Where blocks go: the FORGE Google calendar, pushed by automation. */
function SyncNote() {
  const app = useApp(); useVersion(['status']);
  const g = useSetting('integrations').gcal || {};
  const st = app.store.get('status', 'calendar');
  let text, link = false;
  if (!g.saEmail) { text = 'Connect Google Calendar to push blocks to your phone’s calendar and read meetings.'; link = true; }
  else if (!g.forgeCalendarId) { text = 'Choose a FORGE calendar to push blocks to Google Calendar.'; link = true; }
  else if (g.pushPlan === false) { text = 'Pushing plan blocks to Google Calendar is off.'; link = true; }
  else text = 'Blocks with Google Calendar on are pushed to your FORGE calendar by automation each hour (today − 1 to + 14 days; skipped blocks are removed).';
  return html`<div class="day-sync xs muted">
    <${Icon} name="calendar" size=${14} />
    <div class="grow">${text}
      ${st && st.lastOkAt ? html` Last calendar sync ${fmtAgo(st.lastOkAt)}.` : g.saEmail && g.forgeCalendarId ? html` ${app.demo ? 'Not available in demo.' : 'No calendar sync recorded yet.'}` : null}
      ${st && st.lastError ? html` <span class="ink-warn">Last run failed: ${st.lastError}</span>` : null}
      ${link ? html` <button type="button" class="day-linkbtn" onClick=${() => app.nav('/settings/integrations')}>Settings → Integrations</button>` : null}</div>
  </div>`;
}
