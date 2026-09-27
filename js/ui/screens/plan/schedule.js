// Plan → visual day schedule: an hour grid (05:00–24:00, extended to fit), plan blocks placed by
// time with overlapping items laid out in columns, calendar events as muted blocks, the readiness
// focus window as a strip, and a now line. Tap an empty slot to add a block; tap a block to edit.
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useWide } from '../../ctx.js';
import { Icon, cx } from '../../kit.js';
import { openBlock } from '../../actions/plan.js';
import { catLabel } from '../../parts/day-ui.js';
import { blockSpan, layoutColumns, scheduleRange, slotAt, fmtSpan, fmtMinutes } from '../../parts/day-model.js';
import { hmToMin, fmtTime } from '../../../core/util.js';

const MIN_VIS = 26; // minutes: shortest drawn height (columns use the real span)
const hourLabel = (h) => { const v = ((h % 24) + 24) % 24; return v === 0 ? '12 AM' : v === 12 ? '12 PM' : v < 12 ? `${v} AM` : `${v - 12} PM`; };
const STATUS_ICON = { done: 'check', partial: 'minus', skipped: 'x' };

export function DaySchedule({ date, blocks, events, nowMin, focus }) {
  const app = useApp(); const wide = useWide();
  const PX = wide ? 0.8 : 0.72; // px per minute (48 / 43 px per hour)
  const items = [
    ...blocks.map((b) => { const sp = blockSpan(b); return sp ? { kind: 'block', id: b.id, start: sp.start, end: Math.max(sp.end, sp.start + 1), realEnd: sp.end, rec: b } : null; }).filter(Boolean),
    ...events.map((e) => ({ kind: 'event', id: e.id, start: e.start, end: Math.max(e.end, e.start + 1), realEnd: e.end, rec: e })),
  ];
  const range = scheduleRange(items, { from: 300, to: 1440 });
  const laid = layoutColumns(items);
  const top = (m) => (m - range.from) * PX;
  const hours = []; for (let h = range.from / 60; h <= range.to / 60; h++) hours.push(h);
  const fs = focus && focus.start ? hmToMin(focus.start) : null; let fe = focus && focus.end ? hmToMin(focus.end) : null;
  if (fs != null && fe != null && fe <= fs) fe += 1440;

  const onLane = (e) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const min = range.from + (e.clientY - rect.top) / PX;
    openBlock(app, { date, ...slotAt(min, { from: range.from, to: Math.min(range.to, 1440) }) });
  };
  const onEvent = (it) => app.toast(`${it.rec.title || 'Busy'} · ${fmtSpan(it.start, it.realEnd)} · Google Calendar (read-only)`);

  return html`<div class="day-sched" style=${`height:${(range.to - range.from) * PX + 12}px`}>
    ${hours.map((h) => html`<div key=${'h' + h} class="hr" style=${`top:${top(h * 60)}px`}><span>${hourLabel(h)}</span></div>`)}
    <div class="lane" onClick=${onLane} title="Tap an empty slot to add a block" style=${`height:${(range.to - range.from) * PX}px`}>
      ${fs != null && fe != null ? html`<div class="focus" style=${`top:${top(fs)}px;height:${(fe - fs) * PX}px`} title=${`Focus window ${fmtSpan(fs, fe)}`}></div>` : null}
      ${laid.map((it) => {
        const h = (Math.max(it.end, it.start + MIN_VIS) - it.start) * PX; const short = h < 30;
        const style = `top:${top(it.start) + 1}px;height:${Math.max(12, h - 2)}px;left:calc(${(it.col / it.cols) * 100}% + 2px);width:calc(${100 / it.cols}% - 4px)`;
        if (it.kind === 'event') {
          const r = it.rec;
          return html`<div key=${'e' + it.id} class=${cx('evt', short && 'short')} style=${style} onClick=${(e) => { e.stopPropagation(); onEvent(it); }}
            title=${`${r.title || 'Busy'} · ${fmtSpan(it.start, it.realEnd)}`}>
            <span class="tt ellipsis">${r.title || 'Busy'}</span>${short ? null : html`<span class="tm">${fmtSpan(it.start, it.realEnd)}</span>`}
          </div>`;
        }
        const b = it.rec; const st = b.status || 'planned';
        return html`<button type="button" key=${'b' + it.id} class=${cx('blk', 'dc-' + (b.category || 'personal'), 'bs-' + st, short && 'short')} style=${style}
          onClick=${(e) => { e.stopPropagation(); openBlock(app, { id: b.id }); }} aria-label=${`${b.title || catLabel(b.category)}, ${fmtSpan(it.start, it.realEnd)}, ${st}`}>
          <span class="tt ellipsis">${STATUS_ICON[st] ? html`<${Icon} name=${STATUS_ICON[st]} size=${12} strokeWidth=${2.6} /> ` : null}${b.title || catLabel(b.category)}</span>
          ${short ? null : html`<span class="tm">${fmtSpan(it.start, it.realEnd)} · ${fmtMinutes(it.realEnd - it.start)}</span>`}
        </button>`;
      })}
      ${nowMin != null && nowMin >= range.from && nowMin <= range.to ? html`<div class="now" style=${`top:${top(nowMin)}px`}><span>${fmtTime(nowMin)}</span></div>` : null}
    </div>
  </div>`;
}
