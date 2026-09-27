// Today → Timeline: one chronological list for the date — sleep, plan blocks (with status),
// calendar events, meals, sessions, WHOOP workouts, doses, weigh-ins and journal entries —
// with a "now" marker on today.
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics, useNow } from '../../ctx.js';
import { Card, Button, Icon, Spinner, cx } from '../../kit.js';
import { EncryptedImage } from '../../parts/media.js';
import { StatusControl, setBlockStatus, catLabel } from '../../parts/day-ui.js';
import { buildTimeline, nowIndex, mealTitle, slotLabel, sessionSummary, fmtSpan, fmtMinutes, fmtAmount } from '../../parts/day-model.js';
import { openBlock } from '../../actions/plan.js';
import { openMeal } from '../../actions/meal.js';
import { openDoseLog } from '../../actions/stack.js';
import { openWeighIn } from '../../actions/weight.js';
import { openJournalEntry } from '../../actions/journal.js';
import { prs } from '../../../analytics/index.js';
import { addDays, fmtTime, fmtDur, fmtNum, localParts, isNum } from '../../../core/util.js';

const ICON = { sleep: 'moon', nap: 'moon', bed: 'bed', block: 'plan', event: 'calendar', meal: 'fuel', session: 'train', workout: 'activity', doses: 'pill', weigh: 'scale', journal: 'book' };
const CAT = { sleep: 'cat-recovery', nap: 'cat-recovery', bed: 'cat-recovery', event: 'cat-event', meal: 'cat-meal', session: 'cat-training', workout: 'cat-training', doses: 'day-cat-record', weigh: 'day-cat-record', journal: 'day-cat-record' };


export function TimelineCard({ date, mode }) {
  const app = useApp(); const dv = app.dv; const tz = dv.tz;
  const nowMs = useNow();
  const model = useAnalytics(() => {
    const entries = buildTimeline({
      date, tz, sleep: dv.sleep(date), naps: dv.naps(date), nextSleep: dv.sleep(addDays(date, 1)),
      plan: dv.plan(date), events: dv.events(date), meals: dv.meals(date), sessions: dv.sessions(date),
      workouts: dv.workouts(date), doses: dv.doses(date), body: dv.body(date), journal: dv.journal(date),
    });
    const items = new Map(dv.protocolItems({ includeInactive: true }).map((i) => [i.id, i]));
    const prByDay = prs(dv).filter((p) => p.date === date).length;
    return { entries, items, prByDay };
  }, [date]);
  if (!model) return null;
  const { entries } = model;
  const judged = mode !== 'future';
  const nowMin = mode === 'today' ? localParts(nowMs, tz).min : null;
  const at = nowMin == null ? -1 : nowIndex(entries, nowMin);
  const add = html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${() => openBlock(app, { date })}>Block</${Button}>`;
  const count = entries.length;
  return html`<${Card} title=${mode === 'future' ? 'Plan & calendar' : 'Timeline'} meta=${count ? `${count} ${count === 1 ? 'entry' : 'entries'}` : null} action=${add}>
    ${count ? html`<div class="timeline day-tl">
      ${entries.map((e, i) => html`${i === at ? html`<${NowMarker} min=${nowMin} />` : null}<${Entry} key=${e.key} e=${e} date=${date} judged=${judged} model=${model} />`)}
      ${at === entries.length ? html`<${NowMarker} min=${nowMin} />` : null}
    </div>` : html`<div class="day-empty-inline">
      <div class="small dim">${mode === 'future' ? 'Nothing planned for this day yet.' : mode === 'past' ? 'Nothing was recorded on this day.' : 'Nothing recorded yet.'} Sleep, plan blocks, meetings, meals, training, doses and weigh-ins appear here in time order.</div>
      <div class="row wrap" style="gap:8px;margin-top:10px">
        <${Button} size="sm" icon="plus" onClick=${() => openBlock(app, { date })}>Add block</${Button}>
        <${Button} size="sm" variant="ghost" onClick=${() => app.nav(date === app.today() ? '/plan' : '/plan/' + date)}>Open plan</${Button}>
      </div>
    </div>`}
  </${Card}>`;
}

function NowMarker({ min }) {
  return html`<div class="day-now" role="separator" aria-label=${'Now ' + fmtTime(min)}><span>${fmtTime(min)}</span></div>`;
}

function timeLabel(e) {
  if (e.allDay) return 'All day';
  if (e.min == null) return '—';
  return fmtTime(e.min);
}

function Entry({ e, date, judged, model }) {
  const app = useApp();
  let body; let onClick = null; let cls = CAT[e.kind] || '';
  const r = e.rec;
  switch (e.kind) {
    case 'sleep': {
      const asleep = r.asleepMin;
      const pct = isNum(asleep) && isNum(r.needMin) && r.needMin > 0 ? Math.round((asleep / r.needMin) * 100) : null;
      body = html`<div class="t">Sleep${isNum(asleep) ? html` <span class="tnum">${fmtDur(asleep)}</span>` : null}</div>
        <div class="m">${fmtTime(e.startMin)} → ${fmtTime(e.endMin)}${pct != null ? ` · ${pct}% of ${fmtDur(r.needMin)} need` : ''}${isNum(r.disturbances) ? ` · ${r.disturbances} disturbances` : ''}</div>`;
      onClick = () => app.nav('/insights/sleep');
      break;
    }
    case 'nap': body = html`<div class="t">Nap</div><div class="m">${fmtSpan(e.min, e.endMin)}${isNum(r.asleepMin) ? ` · ${fmtDur(r.asleepMin)} asleep` : ''}</div>`; break;
    case 'bed':
      body = html`<div class="t">Lights out</div><div class="m">Next night${isNum(r.asleepMin) ? ` · ${fmtDur(r.asleepMin)} asleep` : ''}${isNum(r.performance) ? ` · ${fmtNum(r.performance, 0)}% of need` : ''}</div>`;
      onClick = () => app.nav('/today/' + addDays(date, 1));
      break;
    case 'block': {
      const st = r.status || 'planned';
      cls = cx('cat-' + (r.category || 'personal'), 'day-block', 'bs-' + st);
      body = html`<div class="row top between" style="gap:8px">
          <div class="grow" style="min-width:0"><div class="t ellipsis">${r.title || catLabel(r.category)}</div>
            <div class="m">${fmtSpan(e.min, e.endMin)} · ${fmtMinutes(e.endMin - e.min)} · ${catLabel(r.category)}${isNum(r.actualMin) ? ` · actual ${fmtMinutes(r.actualMin)}` : ''}${r.calendar === false ? ' · not on calendar' : ''}</div></div>
          ${judged ? html`<${StatusControl} status=${st} onValue=${(v) => setBlockStatus(app, r.id, v)} label=${'Status of ' + (r.title || 'block')} />` : null}
        </div>`;
      onClick = () => openBlock(app, { id: r.id });
      break;
    }
    case 'event':
      cls = cx('cat-event', e.declined && 'day-declined');
      body = html`<div class="t ellipsis">${r.title || 'Busy'}</div><div class="m">${e.allDay ? 'All day' : fmtSpan(e.min, e.endMin)}${isNum(r.attendees) && r.attendees > 1 ? ` · ${r.attendees} people` : ''}${e.declined ? ' · declined' : r.status === 'tentative' ? ' · tentative' : ''}</div>`;
      break;
    case 'meal': {
      const t = r.totals || {};
      const status = r.status || (isNum(t.kcal) ? 'ready' : 'pending');
      const photo = r.photo && r.photo.path ? r.photo : null;
      const detail = status === 'analyzing' ? html`<span class="row" style="gap:6px"><${Spinner} /> Analyzing…</span>`
        : status === 'error' ? html`<span class="ink-bad">Analysis failed — tap to retry</span>`
        : status === 'pending' && !isNum(t.kcal) ? 'Waiting for analysis'
        : html`<span class="tnum">${fmtNum(t.kcal)} kcal · ${fmtNum(t.protein)} g protein</span>${r.ai && r.ai.confidence === 'low' ? html` · <span class="ink-warn">low confidence</span>` : ''}`;
      const title = mealTitle(r); const slot = slotLabel(r.slot);
      body = html`<div class="row" style="gap:10px">
        ${photo ? html`<${EncryptedImage} path=${photo.path} mediaType=${photo.mediaType || 'image/jpeg'} class="thumb day-thumb" alt=${title} icon="fuel" />` : null}
        <div class="grow" style="min-width:0"><div class="t ellipsis">${title}</div>
          <div class="m">${slot && slot !== title ? slot + ' · ' : ''}${detail}</div></div></div>`;
      onClick = () => openMeal(app, r.id);
      break;
    }
    case 'session': {
      const s = sessionSummary(r, date, app.dv.tz); const w = e.workout;
      const bits = [s.sets ? `${s.sets} sets` : null, s.volume ? `${fmtNum(s.volume)} lb` : null, s.cardioMin ? `${fmtNum(s.cardioMin)} min cardio` : null,
        s.durationMin ? fmtMinutes(s.durationMin) : s.open ? 'in progress' : null, w && isNum(w.strain) ? `strain ${fmtNum(w.strain, 1)}` : null, w && isNum(w.avgHr) ? `${w.avgHr} bpm avg` : null].filter(Boolean);
      body = html`<div class="t ellipsis">${r.name || 'Workout'}${model.prByDay ? html` <span class="tag">${model.prByDay} PR${model.prByDay > 1 ? 's' : ''}</span>` : null}</div><div class="m">${bits.join(' · ') || 'No sets yet'}</div>`;
      onClick = () => app.nav('/train/session/' + r.id);
      break;
    }
    case 'workout': {
      const dur = isNum(e.min) && isNum(e.endMin) ? e.endMin - e.min : null;
      body = html`<div class="t">${r.sport || 'Workout'} <span class="tag">WHOOP</span></div><div class="m">${[dur ? fmtMinutes(dur) : null, isNum(r.strain) ? `strain ${fmtNum(r.strain, 1)}` : null, isNum(r.avgHr) ? `${r.avgHr} bpm avg` : null, isNum(r.kcal) ? `${fmtNum(r.kcal)} kcal` : null].filter(Boolean).join(' · ')}</div>`;
      break;
    }
    case 'doses': {
      const stacks = [...new Set(e.doses.map((d) => { const it = model.items.get(d.itemId); return it && it.schedule && it.schedule.stack ? String(it.schedule.stack) : ''; }))];
      const title = stacks.length === 1 && stacks[0] ? `${stacks[0]} stack` : e.doses.length > 1 ? 'Protocol' : ((model.items.get(e.doses[0].itemId) || {}).name || 'Dose');
      body = html`<div class="t">${title}</div><div class="day-doses">${e.doses.map((d) => {
        const it = model.items.get(d.itemId) || {};
        const amt = isNum(d.amount) ? d.amount : it.amount; const unit = d.unit || it.unit || '';
        return html`<button type="button" key=${d.id} class=${cx('day-dose', d.skipped && 'skipped')} onClick=${(ev) => { ev.stopPropagation(); openDoseLog(app, { date, id: d.id, itemId: d.itemId }); }}>
          ${it.name || 'Item'}${isNum(amt) ? html` <span class="tnum dim">${fmtAmount(amt)} ${unit}</span>` : null}${d.skipped ? ' · skipped' : ''}</button>`;
      })}</div>`;
      break;
    }
    case 'weigh':
      body = html`<div class="t"><span class="tnum">${fmtNum(r.weightLb, 1)}</span> lb</div><div class="m">${['Weigh-in', r.method && r.method !== 'scale' ? r.method : null, isNum(r.bodyFatPct) ? `${fmtNum(r.bodyFatPct, 1)}% body fat` : null, isNum(r.waistIn) ? `waist ${fmtNum(r.waistIn, 1)} in` : null].filter(Boolean).join(' · ')}</div>`;
      onClick = () => openWeighIn(app, { id: r.id });
      break;
    case 'journal':
      body = html`<div class="t day-clamp2">${r.text || 'Note'}</div>${r.tags && r.tags.length ? html`<div class="m">${r.tags.map((t) => '#' + t).join(' ')}</div>` : null}`;
      onClick = () => openJournalEntry(app, { date, id: r.id });
      break;
    default: body = null;
  }
  return html`<div class=${cx('tl-item', 'k-' + e.kind)}>
    <div class="tl-time">${timeLabel(e)}</div>
    <div class="tl-rail"><i></i></div>
    <div class="tl-body">
      <div class=${cx('tl-card', cls, onClick && 'day-link')} onClick=${onClick || undefined} role=${onClick ? 'button' : undefined} tabIndex=${onClick ? 0 : undefined}
        onKeyDown=${onClick ? (ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) onClick(); } : undefined}>
        <div class="day-tl-row"><span class="day-tl-ic"><${Icon} name=${ICON[e.kind] || 'info'} size=${15} /></span><div class="grow" style="min-width:0">${body}</div></div>
      </div>
    </div>
  </div>`;
}
