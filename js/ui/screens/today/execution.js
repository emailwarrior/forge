// Today → Execution: day score, required done/total, pending, perfect-day streak, and every
// applicable standard with its auto/manual value vs target. Manual checks override auto values;
// clearing one (store.remove('checks', id)) returns the standard to its auto source.
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useSetting } from '../../ctx.js';
import { Card, Check, Button, SheetHead, SheetFoot, Field, NumberInput, TimeInput, Empty, Icon, cx } from '../../kit.js';
import { targetText } from '../../parts/day-model.js';
import { dayExecution, streaks, evaluateStandard, autoValue } from '../../../analytics/index.js';
import { fmtNum, fmtTime, fmtDate, isNum } from '../../../core/util.js';

const VALUE_KINDS = new Set(['number', 'duration', 'time']);
const checkId = (date, sid) => `${date}:${sid}`;

/** Remove a manual check (back to the auto source, or unlogged) with Undo. */
function clearCheck(app, date, standard) {
  const id = checkId(date, standard.id);
  app.store.remove('checks', id);
  app.toast(standard.auto ? `${standard.name}: back to auto` : `${standard.name}: cleared`, { action: { label: 'Undo', onClick: () => app.store.restore('checks', id) } });
}

function valueText(it) {
  const kind = it.standard.kind || 'check';
  if (it.status === 'na') return 'Nothing due';
  if (it.status === 'future') return '—';
  if (it.status === 'pending') {
    if (it.value == null || it.value === false) return 'Pending';
    if (isNum(it.value)) return it.display + ' so far';
  }
  if (kind === 'time' && typeof it.value === 'string') return fmtTime(it.value);
  return it.display;
}

function targetLine(it, targets) {
  const s = it.standard;
  if (s.auto === 'day.caffeineCutoff' && targets.caffeineCutoff) return `before ${fmtTime(targets.caffeineCutoff)}`;
  if (it.target && it.target.value == null) {
    // Targets resolved from body weight (protein, kcal) stay empty until the first weigh-in.
    return /^nutrition\.(protein|kcal)$/.test(s.auto || '') ? 'target needs a weigh-in' : 'no target set';
  }
  const t = targetText(it.target, s.kind);
  return t ? `target ${t}` : s.kind === 'avoid' ? 'avoid' : '';
}

export function ExecutionCard({ date }) {
  const app = useApp();
  const targets = useSetting('targets');
  const ex = useAnalytics(() => dayExecution(app.dv, date), [date]);
  const st = useAnalytics(() => streaks(app.dv, date), [date]);
  const today = app.today();
  if (!ex) return null;
  const edit = html`<${Button} size="sm" variant="ghost" onClick=${() => app.nav('/settings/standards')}>Edit standards</${Button}>`;
  if (!ex.items.length) {
    return html`<${Card} title="Execution" action=${edit}><${Empty} title="No standards apply to this day">Standards are the daily non-negotiables FORGE scores — wake time, training, protein, deep work. Set them in Settings → Standards.</${Empty}></${Card}>`;
  }
  // Before the first record there is nothing to judge (auto sources would read as "missed").
  const first = app.dv.firstDate();
  if (date < today && (!first || date < first)) {
    return html`<${Card} title="Execution" action=${edit}><div class="small dim">Nothing was recorded on this day${first ? html` — records start on <button type="button" class="day-linkbtn" onClick=${() => app.nav('/today/' + first)}>${fmtDate(first, { year: first.slice(0, 4) !== date.slice(0, 4) })}</button>` : ''}. Standards are scored from the first day with data.</div></${Card}>`;
  }

  const toggle = (it) => {
    const id = checkId(date, it.standard.id);
    const cur = app.store.get('checks', id);
    const manual = cur && cur.source !== 'auto';
    const next = manual ? cur.value !== true : it.done !== true;
    // _d: null revives a check cleared earlier (upsert alone keeps a tombstone deleted).
    app.store.upsert('checks', id, { date, standardId: it.standard.id, value: next, source: 'manual', _d: null });
  };
  const reset = (it) => clearCheck(app, date, it.standard);
  const openValue = (it) => app.sheet(({ close }) => html`<${ExecValueSheet} date=${date} standardId=${it.standard.id} close=${close} />`);
  const onCheck = (it) => { if (it.status === 'na') return; if (VALUE_KINDS.has(it.standard.kind)) openValue(it); else toggle(it); };

  const known = ex.items.filter((i) => i.done != null).length;
  return html`<${Card} title="Execution" action=${edit}>
    <div class="day-kpis">
      <div><div class="l">Score</div><div class="v">${isNum(ex.score) ? fmtNum(ex.score, 0) : '—'}${isNum(ex.score) ? html`<small>/100</small>` : null}</div></div>
      <div><div class="l">Required</div><div class="v">${ex.required.done}<small>/${ex.required.total}</small></div></div>
      <div><div class="l">${date === today ? 'Pending' : 'Judged'}</div><div class="v">${date === today ? ex.pending : known}${date === today ? null : html`<small>/${ex.items.length}</small>`}</div></div>
    </div>
    <div class="xs muted" style="margin:2px 0 8px">Perfect days in a row: <span class="mono dim">${st ? st.current : 0}</span>${st && st.longest ? html` · longest <span class="mono dim">${st.longest}</span>` : null}${ex.perfect === true ? ' · this day was perfect' : ''}</div>
    <div class="day-stds">
      ${ex.items.map((it) => {
        const s = it.standard; const kind = s.kind || 'check';
        const valueKind = VALUE_KINDS.has(kind);
        const tl = targetLine(it, targets);
        return html`<div key=${s.id} class=${cx('day-std', 'st-' + it.status)}>
          <${Check} state=${it.done === true ? true : it.done === false ? false : null} missed=${it.status === 'missed'}
            label=${`${s.name}: ${valueKind ? 'enter value' : 'toggle'}`} onClick=${() => onCheck(it)} />
          <div class=${cx('grow body', valueKind && it.status !== 'na' && 'link')} onClick=${valueKind && it.status !== 'na' ? () => openValue(it) : undefined}>
            <div class="n ellipsis">${s.name}</div>
            ${tl || !s.required ? html`<div class="t xs muted">${[tl, s.required ? null : 'optional'].filter(Boolean).join(' · ')}</div>` : null}
          </div>
          <div class="trail">
            ${it.source === 'manual'
              ? html`<button type="button" class="tag day-tag-btn" title=${s.auto ? 'Manual override — tap to return to auto' : 'Manual entry — tap to clear'} aria-label=${s.auto ? `Return ${s.name} to auto` : `Clear ${s.name}`} onClick=${() => reset(it)}>manual <${Icon} name="x" size=${10} strokeWidth=${2.5} /></button>`
              : it.source === 'auto' ? html`<span class="tag" title=${'Auto source: ' + (s.auto || '')}>auto</span>` : null}
            <span class=${cx('val mono', it.status === 'missed' && 'ink-bad', it.status === 'done' && 'ink-good', (it.status === 'pending' || it.status === 'na') && 'muted')}>${valueText(it)}</span>
          </div>
        </div>`;
      })}
    </div>
  </${Card}>`;
}

/* Value entry for number / duration / time standards (manual override). */
function ExecValueSheet({ date, standardId, close }) {
  const app = useApp(); useVersion(['checks', 'standards']);
  const s = app.store.get('standards', standardId);
  const id = checkId(date, standardId);
  const check = app.store.get('checks', id);
  const manual = check && check.source !== 'auto' ? check : null;
  const it = s ? evaluateStandard(app.dv, s, date) : null;
  const auto = s && s.auto ? autoValue(app.dv, s.auto, date) : null;
  const kind = s ? s.kind : 'number';
  const unit = (it && it.target && it.target.unit) || (kind === 'duration' ? 'min' : '');
  const initial = manual ? manual.value : it && it.value != null && typeof it.value !== 'boolean' ? it.value : null;
  const [v, setV] = useState(kind === 'time' ? (typeof initial === 'string' ? initial : '') : isNum(initial) ? initial : null);
  const [error, setError] = useState(null);
  if (!s) return html`<div class="stack"><${SheetHead} title="Standard" onClose=${() => close()} /><${Empty}>This standard no longer exists.</${Empty}></div>`;

  const save = () => {
    if (kind === 'time') { if (!/^\d{2}:\d{2}$/.test(v || '')) return setError('Enter a time.'); }
    else if (!isNum(v) || v < 0) return setError('Enter a number (0 or more).');
    app.store.upsert('checks', id, { date, standardId, value: v, source: 'manual', _d: null });
    app.toast(`${s.name}: ${kind === 'time' ? fmtTime(v) : fmtNum(v, v % 1 ? 1 : 0) + (unit ? (unit === '%' ? '%' : ' ' + unit) : '')}`);
    close(true);
  };
  const clear = () => { clearCheck(app, date, s); close(true); };
  const autoText = auto == null ? null : auto.value == null ? 'no value yet' : typeof auto.value === 'boolean' ? (auto.value ? 'yes' : 'no')
    : kind === 'time' || typeof auto.value === 'string' ? fmtTime(auto.value) : fmtNum(auto.value, auto.value % 1 ? 1 : 0) + (auto.unit && auto.unit !== 'meals' ? (auto.unit === '%' ? '%' : ' ' + auto.unit) : '');
  return html`<div class="stack">
    <${SheetHead} title=${s.name} onClose=${() => close()} />
    <div class="small dim">${[it && it.target ? 'Target ' + targetText(it.target, kind) : null, s.auto ? `Auto value: ${autoText}` : 'Manual standard'].filter(Boolean).join(' · ')}</div>
    <${Field} label=${kind === 'time' ? 'Time' : 'Value'} error=${error}>
      ${kind === 'time'
        ? html`<${TimeInput} value=${v} onValue=${(x) => { setV(x); setError(null); }} aria-label="Time" />`
        : html`<${NumberInput} value=${v} onValue=${(x) => { setV(x); setError(null); }} suffix=${unit || null} step="any" min="0" class="day-big" aria-label="Value" onFocus=${(e) => e.currentTarget.select()} />`}
    </${Field}>
    ${s.auto ? html`<div class="xs muted">A manual value overrides the auto source for this day.</div>` : null}
    <${SheetFoot}>
      ${manual ? html`<${Button} onClick=${clear}>${s.auto ? 'Use auto value' : 'Clear'}</${Button}>` : html`<${Button} onClick=${() => close()}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save}>Save</${Button}>
    </${SheetFoot}>
  </div>`;
}
