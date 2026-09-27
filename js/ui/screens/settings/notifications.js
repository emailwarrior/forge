// Settings → Notifications: which push notifications the hourly server run sends, quiet hours,
// delivery requirements, and what was sent recently (pushLog).
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useNow } from '../../ctx.js';
import { Button, ToggleRow, TimeInput, Pill } from '../../kit.js';
import { Block, StatusLine, useSettingDraft, useAutomationInstalled, FieldGroup } from '../../parts/settings-ui.js';
import { pushState, relTime } from '../../parts/settings-status.js';
import { SETTINGS_DEFAULTS } from '../../../core/schema.js';
import { fmtTime, fmtDur, hmToMin } from '../../../core/util.js';

const KIND_LABEL = { brief: 'Morning brief', checkin: 'Evening check-in', weekly: 'Weekly review', dose: 'Protocol reminder' };

export default function NotificationsSection() {
  const app = useApp(); useVersion(['pushSubs', 'status', 'pushLog']);
  const now = useNow(60000);
  const { value: n, set } = useSettingDraft('notifications');
  const installed = useAutomationInstalled();
  const push = pushState(app.store.all('pushSubs'), app.store.get('status', 'push'));
  const [lastCheckin, setLastCheckin] = useState(n.eveningCheckinAt || SETTINGS_DEFAULTS.notifications.eveningCheckinAt);
  const qs = hmToMin(n.quietStart), qe = hmToMin(n.quietEnd);
  const quietLen = qs == null || qe == null || qs === qe ? null : (qe - qs + 1440) % 1440;
  const log = app.store.all('pushLog').filter((x) => x.sentAt).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt))).slice(0, 6);
  return html`<div class="stack lg">
    <${Block} title="Delivery" desc="Notifications come from the hourly server run, so one can arrive up to an hour after its time.">
      <${StatusLine} tone=${push.devices ? 'good' : 'warn'}>${push.devices ? `${push.text}: ${(push.names || []).join(', ')}` : 'No device has notifications turned on'}</${StatusLine}>
      <${StatusLine} tone=${app.demo ? null : installed ? 'good' : 'warn'}>${app.demo ? 'Server automation: not available in demo' : installed ? 'Server automation installed' : 'Server automation not installed'}</${StatusLine}>
      ${!push.devices || (!installed && !app.demo) ? html`<div class="set-actions">
        ${!push.devices ? html`<${Button} size="sm" icon="bell" onClick=${() => app.nav('/settings/integrations')}>Enable on a device</${Button}>` : null}
        ${!installed && !app.demo ? html`<${Button} size="sm" icon="zap" onClick=${() => app.nav('/settings/automation')}>Set up automation</${Button}>` : null}
      </div>` : null}
    </${Block}>

    <${Block} title="What to send">
      <div class="stack xs set-toggles">
        <${ToggleRow} label="Morning brief" sub="Readiness and the day’s focus, once WHOOP has scored your recovery (between 5 and 11 AM)."
          checked=${!!n.morningBrief} onValue=${(v) => set({ morningBrief: v }, { now: true })} />
        <div class="divider"></div>
        <${ToggleRow} label="Evening check-in" sub="If the day has no check-in yet: from this time until quiet hours."
          checked=${!!n.eveningCheckinAt} onValue=${(v) => { if (!v) setLastCheckin(n.eveningCheckinAt || lastCheckin); set({ eveningCheckinAt: v ? lastCheckin : null }, { now: true }); }} />
        ${n.eveningCheckinAt ? html`<div class="set-indent"><${FieldGroup} label="Send from">
          <${TimeInput} value=${n.eveningCheckinAt} onValue=${(v) => { if (v) { setLastCheckin(v); set({ eveningCheckinAt: v }); } }} aria-label="Evening check-in time" /></${FieldGroup}></div>` : null}
        <div class="divider"></div>
        <${ToggleRow} label="Weekly review" sub="Sunday from 6 PM, when the week is ready to review." checked=${!!n.weeklyReview} onValue=${(v) => set({ weeklyReview: v }, { now: true })} />
        <div class="divider"></div>
        <${ToggleRow} label="Protocol reminders" sub="Peptides and medications due today with no dose logged by noon (or an hour after their scheduled time). The text says “Protocol reminder”, never the name."
          checked=${!!n.doseReminders} onValue=${(v) => set({ doseReminders: v }, { now: true })} />
      </div>
    </${Block}>

    <${Block} title="Quiet hours" desc="Nothing is sent in this window. Clear either time to turn quiet hours off.">
      <div class="set-range">
        <${TimeInput} value=${n.quietStart} onValue=${(v) => set({ quietStart: v || null })} aria-label="Quiet hours start" />
        <span class="muted">to</span>
        <${TimeInput} value=${n.quietEnd} onValue=${(v) => set({ quietEnd: v || null })} aria-label="Quiet hours end" />
      </div>
      <div class="xs muted">${quietLen == null ? 'No quiet hours.' : `Quiet from ${fmtTime(n.quietStart)} to ${fmtTime(n.quietEnd)} (${fmtDur(quietLen)}).`}</div>
    </${Block}>

    <${Block} title="Recently sent">
      ${log.length ? html`<div class="card flush"><div class="list">${log.map((x) => html`<div class="list-row" key=${x.id}>
          <div class="grow"><div class="title">${KIND_LABEL[x.kind] || x.kind}</div><div class="meta">${x.title || ''}</div></div>
          <div class="trail"><div class="xs muted">${relTime(x.sentAt, now)}</div>${x.ok === false ? html`<${Pill} tone="bad">Failed</${Pill}>` : null}</div></div>`)}</div></div>`
        : html`<div class="xs muted">Nothing sent yet.</div>`}
    </${Block}>
  </div>`;
}
