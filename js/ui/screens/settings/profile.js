// Settings → Profile: body measurements, sex (nutrition references), goal weight + rate, time zone, units.
import { html, useState, useEffect, useMemo } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics, useNow } from '../../ctx.js';
import { Field, Input, NumberInput, Notice, Button } from '../../kit.js';
import { useSettingDraft, Block, Seg, FieldGroup } from '../../parts/settings-ui.js';
import { splitHeight, joinHeight, profileErrors, timeZoneGroups, isValidZone, zoneOffsetLabel } from '../../parts/settings-util.js';
import { goalProjection, calorieTargets } from '../../../analytics/index.js';
import { deviceTz, fmtNum, fmtDate, fmtTime, localParts, signed, isNum } from '../../../core/util.js';

const thisYear = () => new Date().getFullYear();

export default function ProfileSection() {
  const { value: p, set, errors } = useSettingDraft('profile', { validate: (v) => profileErrors(v, { year: thisYear() }) });
  return html`<div class="stack lg">
    <${BodyBlock} p=${p} set=${set} errors=${errors} />
    <${GoalBlock} p=${p} set=${set} errors=${errors} />
    <${ZoneBlock} p=${p} set=${set} />
  </div>`;
}

function BodyBlock({ p, set, errors }) {
  const init = splitHeight(p.heightIn);
  const [h, setH] = useState(init);
  const [hErr, setHErr] = useState({});
  // Follow external changes (another device) while the fields are not being edited.
  useEffect(() => { const cur = joinHeight(h.ft, h.inch); if (cur !== (p.heightIn ?? null)) setH(splitHeight(p.heightIn)); }, [p.heightIn]);
  const onHeight = (patch) => {
    const next = { ...h, ...patch }; setH(next);
    const e = profileErrors({ ft: next.ft, inch: next.inch }, { year: thisYear() });
    setHErr(e);
    if (!e.heightFt && !e.heightIn) set({ heightIn: joinHeight(next.ft, next.inch) });
  };
  const age = isNum(p.birthYear) ? thisYear() - p.birthYear : null;
  return html`<${Block} title="Body" desc="Used for the resting-energy estimate until FORGE can measure your expenditure from meals and weigh-ins.">
    <div class="set-cols">
      <${Field} label="Name" hint="Optional; shown only in the app" class="span2"><${Input} value=${p.name} onValue=${(v) => set({ name: v })} autocomplete="off" maxlength="60" /></${Field}>
      <${FieldGroup} label="Height" error=${hErr.heightFt || hErr.heightIn} class="span2">
        <div class="set-pair">
          <${NumberInput} value=${h.ft} onValue=${(v) => onHeight({ ft: v })} suffix="ft" step="1" min="3" max="8" aria-label="Height, feet" />
          <${NumberInput} value=${h.inch} onValue=${(v) => onHeight({ inch: v })} suffix="in" step="0.5" min="0" max="11.5" aria-label="Height, inches" />
        </div>
      </${FieldGroup}>
      <${Field} label="Birth year" error=${errors.birthYear} hint=${age != null && !errors.birthYear ? `Age ${age} this year` : null}>
        <${NumberInput} value=${p.birthYear} onValue=${(v) => set({ birthYear: v })} step="1" placeholder="e.g. 1990" /></${Field}>
      <${FieldGroup} label="Sex" hint="Sets reference intakes and the BMR constant">
        <${Seg} value=${p.sex} onValue=${(v) => set({ sex: v }, { now: true })} options=${[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }]} label="Sex" />
      </${FieldGroup}>
    </div>
  </${Block}>`;
}

function GoalBlock({ p, set, errors }) {
  const app = useApp(); const today = app.today();
  const proj = useAnalytics(() => goalProjection(app.dv, today), [today]);
  const ct = useAnalytics(() => calorieTargets(app.dv, today), [today]);
  const lines = [];
  if (proj && isNum(proj.currentTrendLb)) lines.push(`Trend weight ${fmtNum(proj.currentTrendLb, 1)} lb`);
  if (proj && isNum(proj.ratePerWeek)) lines.push(`28-day rate ${signed(proj.ratePerWeek, 2)} lb/wk`);
  const eta = proj && proj.etaDate && proj.weeksToGoal > 0 ? ` At this rate the range is reached around ${fmtDate(proj.etaDate, { year: true, dow: false })}.` : '';
  return html`<${Block} title="Goal weight" desc="Adaptive calorie targets aim for this range at this rate; once the trend is inside it, the surplus drops to zero.">
    <div class="set-cols">
      <${Field} label="Low" error=${errors.goalWeightLow}><${NumberInput} value=${p.goalWeightLow} onValue=${(v) => set({ goalWeightLow: v })} suffix="lb" step="1" /></${Field}>
      <${Field} label="High" error=${errors.goalWeightHigh}><${NumberInput} value=${p.goalWeightHigh} onValue=${(v) => set({ goalWeightHigh: v })} suffix="lb" step="1" /></${Field}>
      <${Field} label="Rate" error=${errors.goalRateLbWk}><${NumberInput} value=${p.goalRateLbWk} onValue=${(v) => set({ goalRateLbWk: v })} suffix="lb/wk" step="0.05" /></${Field}>
    </div>
    <div class="set-facts">
      ${proj && isNum(proj.currentTrendLb)
        ? html`<div class="small">${lines.join(' · ')}</div><div class="xs muted">${proj.note}${eta}</div>`
        : html`<div class="small muted">No weigh-ins yet. Log one from Today (Weigh in) and the trend, rate and projection appear here.</div>`}
      ${ct && ct.surplus != null && ct.basis !== 'manual' ? html`<div class="xs muted">Daily surplus used by adaptive targets today: ${signed(ct.surplus)} kcal${isNum(p.goalRateLbWk) && p.goalRateLbWk > 0 ? ` (rate × 3,500 ÷ 7, limited to 100–700)` : ''}.</div>` : null}
    </div>
  </${Block}>`;
}

function ZoneBlock({ p, set }) {
  const app = useApp(); const now = useNow(30000);
  const device = deviceTz();
  const groups = useMemo(() => timeZoneGroups({ extra: [device, p.timezone] }), [device, p.timezone]);
  const zone = p.timezone || '';
  const active = app.dv.tz;
  const pendingReload = zone && isValidZone(zone) && zone !== active;
  const localNow = zone && isValidZone(zone) ? `Local time there: ${fmtTime(localParts(now, zone).hm)}` : 'Not set: the server falls back to UTC.';
  return html`<${Block} title="Time zone and units" desc="Every local-time decision uses this zone: which date a night of sleep belongs to, reminders, notifications and the server jobs.">
    <div class="set-cols w2">
      <${Field} label="Time zone" hint=${localNow}>
        <select class="select" value=${zone} onChange=${(e) => set({ timezone: e.currentTarget.value }, { now: true })} aria-label="Time zone">
          ${zone ? null : html`<option value="" disabled>Choose a time zone</option>`}
          ${groups.map((g) => html`<optgroup label=${g.group}>${g.zones.map((z) => html`<option value=${z.value}>${z.label}</option>`)}</optgroup>`)}
        </select>
      </${Field}>
      <${FieldGroup} label="Units" hint="Metric display is not available yet; data is stored in pounds and inches.">
        <${Seg} value=${p.units === 'metric' ? 'metric' : 'imperial'} onValue=${(v) => set({ units: v }, { now: true })}
          options=${[{ value: 'imperial', label: 'Imperial (lb, in)' }, { value: 'metric', label: 'Metric', disabled: true, title: 'Not yet available' }]} label="Units" />
      </${FieldGroup}>
    </div>
    ${zone !== device ? html`<div class="row wrap" style="gap:8px"><span class="xs muted">This device is set to ${device} (${zoneOffsetLabel(device)}).</span>
      <${Button} size="sm" onClick=${() => set({ timezone: device }, { now: true })}>Use ${device}</${Button}></div>` : null}
    ${pendingReload ? html`<${Notice} tone="warn"><div class="row between wrap" style="gap:8px"><span>The app is still computing in ${active}. The new zone applies after FORGE reloads${app.demo ? ' (demo data resets on reload)' : ''}.</span>
      ${app.demo ? null : html`<${Button} size="sm" onClick=${() => location.reload()}>Reload now</${Button}>`}</div></${Notice}>` : null}
  </${Block}>`;
}
