// Settings → Targets: calorie mode with the live calorieTargets() result, macros, and timing
// targets with the last 28 days of actuals next to each one.
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics } from '../../ctx.js';
import { Field, NumberInput, TimeInput, Pill, Button } from '../../kit.js';
import { openWeighIn } from '../../actions/weight.js';
import { useSettingDraft, Block, Seg, FieldGroup } from '../../parts/settings-ui.js';
import { targetsErrors } from '../../parts/settings-util.js';
import { calorieTargets, timingTargets, buildDaily } from '../../../analytics/index.js';
import { addDays, fmtNum, fmtTime, fmtHours, mean, signed, isNum } from '../../../core/util.js';

const BASIS = { adaptive: ['Measured', 'good'], estimate: ['Estimate', 'warn'], manual: ['Manual', null] };

export default function TargetsSection() {
  const { value: t, set, errors } = useSettingDraft('targets', { validate: targetsErrors });
  return html`<div class="stack lg">
    <${CalorieBlock} t=${t} set=${set} errors=${errors} />
    <${MacroBlock} t=${t} set=${set} errors=${errors} />
    <${TimingBlock} t=${t} set=${set} errors=${errors} />
  </div>`;
}

function CalorieBlock({ t, set, errors }) {
  const app = useApp(); const today = app.today();
  const ct = useAnalytics(() => calorieTargets(app.dv, today), [today]);
  const info = ct && ct.tdeeInfo;
  const [basisLabel, basisTone] = BASIS[ct && ct.basis] || ['—', null];
  const manual = t.mode === 'manual';
  return html`<${Block} title="Calories and protein" desc="Adaptive mode measures your expenditure from logged meals and the weight trend, then adds the surplus your goal rate needs.">
    <${FieldGroup} label="Mode">
      <${Seg} value=${manual ? 'manual' : 'adaptive'} onValue=${(v) => set({ mode: v }, { now: true })} label="Calorie mode"
        options=${[{ value: 'adaptive', label: 'Adaptive' }, { value: 'manual', label: 'Manual' }]} />
    </${FieldGroup}>
    ${manual ? html`<div class="set-cols">
      <${Field} label="Calories" error=${errors.kcal} hint=${t.kcal == null ? 'Empty: falls back to adaptive.' : null}><${NumberInput} value=${t.kcal} onValue=${(v) => set({ kcal: v })} suffix="kcal" step="10" /></${Field}>
      <${Field} label="Protein" error=${errors.proteinG} hint=${t.proteinG == null ? 'Empty: g/lb × trend weight.' : null}><${NumberInput} value=${t.proteinG} onValue=${(v) => set({ proteinG: v })} suffix="g" step="5" /></${Field}>
    </div>` : null}
    <div class="card inset tight stack sm" aria-live="polite">
      <div class="row between"><span class="eyebrow">Today's target</span>${ct && ct.basis && ct.kcal != null ? html`<${Pill} tone=${basisTone}>${basisLabel}</${Pill}>` : null}</div>
      ${ct && ct.kcal != null ? html`<div class="set-macros">
          <div><b class="num">${fmtNum(ct.kcal)}</b><span>kcal</span></div>
          <div><b class="num">${ct.proteinG != null ? fmtNum(ct.proteinG) : '—'}</b><span>g protein</span></div>
          <div><b class="num">${ct.fatG != null ? fmtNum(ct.fatG) : '—'}</b><span>g fat</span></div>
          <div><b class="num">${ct.carbsG != null ? fmtNum(ct.carbsG) : '—'}</b><span>g carbs</span></div>
          <div><b class="num">${ct.fiberG != null ? fmtNum(ct.fiberG) : '—'}</b><span>g fiber</span></div>
        </div>` : null}
      <div class="small dim">${ct ? ct.rationale : '—'}</div>
      ${ct && ct.kcal == null ? html`<div class="set-actions">
        <${Button} size="sm" icon="scale" onClick=${() => app.nav('/settings/profile')}>Height and birth year</${Button}>
        <${Button} size="sm" icon="plus" onClick=${() => openWeighIn(app, {})}>Log a weigh-in</${Button}></div>` : null}
      ${info && info.method === 'insufficient' && !manual ? html`<div class="xs muted">Measured TDEE: ${info.note} (${info.n} logged day${info.n === 1 ? '' : 's'}, ${info.weighIns} weigh-in${info.weighIns === 1 ? '' : 's'} in the last ${info.window} days.)</div>` : null}
      ${info && info.method === 'energy-balance' ? html`<div class="xs muted">From intake ${fmtNum(info.intakeAvg)} kcal/day and a weight trend of ${signed(info.trendDeltaLb, 1)} lb over ${info.window} days (${info.weighIns} weigh-ins).${info.note ? ' ' + info.note : ''}</div>` : null}
    </div>
  </${Block}>`;
}

function MacroBlock({ t, set, errors }) {
  return html`<${Block} title="Macros" desc="Fat is a share of calories; carbs fill the rest.">
    <div class="set-cols">
      <${Field} label="Protein per lb" error=${errors.proteinPerLb} hint="× trend weight, rounded to 5 g"><${NumberInput} value=${t.proteinPerLb} onValue=${(v) => set({ proteinPerLb: v })} suffix="g/lb" step="0.05" /></${Field}>
      <${Field} label="Fat" error=${errors.fatPct} hint="Share of calories"><${NumberInput} value=${t.fatPct} onValue=${(v) => set({ fatPct: v })} suffix="%" step="1" /></${Field}>
      <${Field} label="Fiber" error=${errors.fiberG}><${NumberInput} value=${t.fiberG} onValue=${(v) => set({ fiberG: v })} suffix="g" step="1" /></${Field}>
      <${Field} label="Fallback surplus" error=${errors.surplusKcal} hint="Only used when Profile has no goal rate"><${NumberInput} value=${t.surplusKcal} onValue=${(v) => set({ surplusKcal: v })} suffix="kcal" step="25" /></${Field}>
    </div>
  </${Block}>`;
}

function TimingBlock({ t, set, errors }) {
  const app = useApp(); const today = app.today();
  const from = addDays(today, -28), to = addDays(today, -1);
  const timing = useAnalytics(() => timingTargets(app.dv, from, to), [from, to]);
  const avgs = useAnalytics(() => {
    const rows = buildDaily(app.dv, from, to);
    const sleep = rows.map((r) => r.sleepMin).filter(isNum); const deep = rows.map((r) => r.deepWorkH).filter(isNum);
    return { sleepH: sleep.length ? mean(sleep) / 60 : null, sleepN: sleep.length, deepH: deep.length ? mean(deep) : null, deepN: deep.length };
  }, [from, to]);
  const actual = (key) => {
    const r = timing && timing.find((x) => x.key === key);
    if (!r || !r.n) return 'No data in the last 28 days';
    return `28 days: avg ${fmtTime(r.avgActual)} · ${r.hitRate}% on time (${r.n} day${r.n === 1 ? '' : 's'})`;
  };
  const tw = t.trainingWindow || {};
  return html`<${Block} title="Timing" desc="Used by standards, readiness planning, reminders and notifications. The line under each target is what actually happened.">
    <div class="set-cols w2">
      <${Field} label="Wake by" hint=${actual('wake')}><${TimeInput} value=${t.wake} onValue=${(v) => v && set({ wake: v })} /></${Field}>
      <${Field} label="Bedtime" hint=${actual('bedtime')}><${TimeInput} value=${t.bedtime} onValue=${(v) => v && set({ bedtime: v })} /></${Field}>
      <${Field} label="Caffeine cutoff" hint=${actual('caffeine')}><${TimeInput} value=${t.caffeineCutoff} onValue=${(v) => v && set({ caffeineCutoff: v })} /></${Field}>
      <${Field} label="Last meal by" hint=${actual('lastMeal')}><${TimeInput} value=${t.lastMealBy} onValue=${(v) => v && set({ lastMealBy: v })} /></${Field}>
      <${Field} label="Sleep" error=${errors.sleepTargetH} hint=${avgs && avgs.sleepN ? `28 days: avg ${fmtHours(avgs.sleepH)} asleep (${avgs.sleepN} nights)` : 'Needs WHOOP sleep data'}>
        <${NumberInput} value=${t.sleepTargetH} onValue=${(v) => set({ sleepTargetH: v })} suffix="h" step="0.25" /></${Field}>
      <${Field} label="Deep work" error=${errors.deepWorkTargetH} hint=${avgs && avgs.deepN ? `28 days: avg ${fmtNum(avgs.deepH, 1)} h (${avgs.deepN} days)` : 'Logged in the evening check-in or plan'}>
        <${NumberInput} value=${t.deepWorkTargetH} onValue=${(v) => set({ deepWorkTargetH: v })} suffix="h" step="0.5" /></${Field}>
    </div>
    <${FieldGroup} label="Training window" hint="Your usual training time; also the default start for sessions logged on another day.">
      <div class="set-range"><${TimeInput} value=${tw.start} onValue=${(v) => v && set({ trainingWindow: { ...tw, start: v } })} aria-label="Training window start" />
        <span class="muted">to</span><${TimeInput} value=${tw.end} onValue=${(v) => v && set({ trainingWindow: { ...tw, end: v } })} aria-label="Training window end" /></div>
    </${FieldGroup}>
  </${Block}>`;
}
