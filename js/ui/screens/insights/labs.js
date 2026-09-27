// Insights › Labs: the latest panel's flagged markers, the largest changes vs each marker's previous value,
// every marker with its history (sparkline) and position in the report's reference range, and a before /
// after comparison for one marker around the start of one protocol item. Flags use the report's own ranges.
import { html, useState } from '../../../vendor/preact-htm.js';
import { Card, Pill, Button, Select, Field, Notice, Icon } from '../../kit.js';
import { Sparkline, RangeBar } from '../../charts.js';
import { labSummary, protocolBeforeAfter, MARKERS } from '../../../analytics/index.js';
import { fmtNum, fmtDate, isNum } from '../../../core/util.js';
import { fmtSigned, plural } from '../../parts/insights-logic.js';
import { useInsight, SectionEmpty, SectionSkeleton } from '../../parts/insights-kit.js';

const CAT = { lipids: 'Lipids', metabolic: 'Metabolic', inflammation: 'Inflammation', hormones: 'Hormones', thyroid: 'Thyroid', vitamins: 'Vitamins', iron: 'Iron', minerals: 'Minerals', electrolytes: 'Electrolytes', kidney: 'Kidney', liver: 'Liver', blood: 'Blood count', muscle: 'Muscle', other: 'Other' };
const val = (v, unit) => (isNum(v) ? `${fmtNum(v, Math.abs(v) < 10 && v % 1 ? 2 : v % 1 ? 1 : 0)}${unit ? ' ' + unit : ''}` : '—');
const range = (lo, hi) => (isNum(lo) && isNum(hi) ? `${fmtNum(lo, lo % 1 ? 2 : 0)}–${fmtNum(hi, hi % 1 ? 2 : 0)}` : isNum(hi) ? `≤ ${fmtNum(hi, hi % 1 ? 2 : 0)}` : isNum(lo) ? `≥ ${fmtNum(lo, lo % 1 ? 2 : 0)}` : 'no range');

function compute(dv) {
  const s = labSummary(dv);
  const items = dv.protocolItems({ includeInactive: true });
  const panels = dv.labs().length;
  return { ...s, items, panels };
}

export default function Labs({ app }) {
  const { data: d, ms } = useInsight(() => compute(app.dv), []);
  const [mk, setMk] = useState(null);
  const [it, setIt] = useState(null);
  if (!d) return html`<${SectionSkeleton} />`;
  if (!d.latest) {
    return html`<div class="stack" data-ms=${ms}><${SectionEmpty} icon="labs" title="No lab panels yet"
      text="Add a blood panel in Labs (PDF or photo). Markers are read from the report, keep the report's own reference ranges, and build a history per marker."
      points=${['Markers outside the report range, flagged for review with your physician', 'Largest changes since the previous panel', 'Each marker over time against its range', 'Before / after a protocol item started']}
      sources=${['labs']} /></div>`;
  }
  const byCat = new Map();
  for (const m of d.markers) { const c = m.category || 'other'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(m); }
  const key = mk && d.markers.some((m) => m.key === mk) ? mk : (d.flagged[0] && d.flagged[0].key) || (d.markers[0] && d.markers[0].key) || null;
  const cycleFirst = d.items.find((i) => i.kind === 'peptide' || i.kind === 'medication') || d.items[0];
  const itemId = it && d.items.some((i) => i.id === it) ? it : cycleFirst && cycleFirst.id;
  const ba = itemId && key ? app.dv.memo(`ins:ba:${key}:${itemId}`, () => protocolBeforeAfter(app.dv, key, itemId)) : null;
  const marker = d.markers.find((m) => m.key === key);
  const unit = marker && marker.latest ? marker.latest.unit : '';
  const item = d.items.find((i) => i.id === itemId);
  const dirClass = (k, pct) => { const lib = MARKERS[k]?.lowerIsBetter; if (lib == null || !isNum(pct) || pct === 0) return ''; return (pct < 0) === lib ? 'pos' : 'neg'; };
  return html`<div class="stack" data-ms=${ms}>
    <${Card} title="Latest panel" meta=${plural(d.panels, 'panel')} action=${html`<span class="row" style="gap:2px"><${Button} size="sm" variant="ghost" onClick=${() => app.nav('/labs')}>All panels</${Button}><${Button} size="sm" variant="ghost" onClick=${() => app.nav('/labs/' + d.latest.id)}>Open<${Icon} name="chevronRight" size=${14} /></${Button}></span>`}>
      <div class="row wrap" style="gap:18px">
        <div class="stat"><div class="label">Collected</div><div class="value" style="font-size:18px">${fmtDate(d.latest.date, { year: true })}</div></div>
        <div class="stat"><div class="label">Lab</div><div class="value" style="font-size:18px">${d.latest.lab || '—'}</div></div>
        <div class="stat"><div class="label">Markers</div><div class="value" style="font-size:18px">${d.latest.markerCount}</div></div>
        <div class="stat"><div class="label">Outside range</div><div class=${d.latest.flaggedCount ? 'value ink-warn' : 'value'} style="font-size:18px">${d.latest.flaggedCount}</div></div>
      </div>
    </${Card}>
    <div class="ins-grid two">
      <${Card} title="Outside the reference range" meta=${d.flagged.length ? plural(d.flagged.length, 'marker') : null}>
        ${d.flagged.length ? html`<div class="stack sm"><div class="ins-list">${d.flagged.map((f) => html`<div class="ins-row" style="padding:8px 0">
            <div class="grow"><div class="small strong">${f.name}</div><div class="xs muted">Range ${range(f.refLow, f.refHigh)}${f.unit ? ' ' + f.unit : ''}</div></div>
            <span class="mono small">${val(f.value, f.unit)}</span><${Pill} tone="warn">${f.flag === 'high' ? 'High' : f.flag === 'low' ? 'Low' : 'Abnormal'}</${Pill}></div>`)}</div>
            <div class="ins-note"><${Icon} name="info" size=${13} /> Review out-of-range results with your physician.</div></div>`
          : html`<div class="small dim">Every marker in the ${fmtDate(d.latest.date, { dow: false })} panel is inside the report's range.</div>`}
      </${Card}>
      <${Card} title="Largest changes" meta=${d.changes.length ? 'vs previous value' : null}>
        ${d.changes.length ? html`<div class="ins-list">${d.changes.slice(0, 6).map((c) => html`<div class="ins-row" style="padding:8px 0">
            <div class="grow"><div class="small">${c.name}</div><div class="xs muted">since ${fmtDate(c.fromDate, { dow: false })}</div></div>
            <span class="mono xs dim">${val(c.from)} → ${val(c.to)}</span>
            <span class=${'mono small ' + dirClass(c.key, c.pct)} style="min-width:58px;text-align:right">${isNum(c.pct) ? fmtSigned(c.pct, 1) + '%' : '—'}</span></div>`)}</div>`
          : html`<div class="small dim">Changes appear once a marker has been measured on two panels.</div>`}
      </${Card}>
    </div>
    <${Card} title="Before / after a protocol item">
      ${d.items.length && d.markers.length ? html`<div class="stack">
          <div class="grid two"><${Field} label="Marker"><${Select} value=${key} onValue=${setMk} options=${d.markers.map((m) => ({ value: m.key, label: m.name }))} /></${Field}>
            <${Field} label="Protocol item"><${Select} value=${itemId} onValue=${setIt} options=${d.items.map((i) => ({ value: i.id, label: i.name }))} /></${Field}></div>
          ${ba && ba.start ? html`<div class="ins-grid three">
              <div class="stat"><div class="label">Before ${fmtDate(ba.start, { dow: false, year: true })}</div><div class="value">${val(ba.before.mean, unit)}</div><div class="delta">${plural(ba.before.n, 'panel')}</div></div>
              <div class="stat"><div class="label">After</div><div class="value">${val(ba.after.mean, unit)}</div><div class="delta">${plural(ba.after.n, 'panel')}${item && item.endedAt ? ` until ${fmtDate(String(item.endedAt).slice(0, 10), { dow: false })}` : ''}</div></div>
              <div class="stat"><div class="label">Change</div><div class="value">${isNum(ba.delta) ? fmtSigned(ba.delta, 2) : '—'}</div><div class="delta">${isNum(ba.pct) ? fmtSigned(ba.pct, 1) + '%' : ba.before.n ? 'No panel after the start' : 'No panel before the start'}</div></div>
            </div>
            <div class="ins-note"><${Icon} name="info" size=${13} /> Compares panels collected before ${item ? item.name : 'the item'} started with panels after. With few panels this is anecdotal; other changes in the same period count too. Review with your physician.</div>`
            : html`<div class="small dim">${item ? item.name : 'This item'} has no start date or logged dose yet.</div>`}
        </div>`
        : html`<div class="small dim">${d.markers.length ? 'Add protocol items in Protocols to compare markers before and after they started.' : 'No recognized markers yet — open the panel in Labs to check the extracted names.'}</div>`}
    </${Card}>
    <div class="ins-grid two">${[...byCat.entries()].map(([cat, list]) => html`<${Card} title=${CAT[cat] || cat} meta=${plural(list.length, 'marker')}>
      <div class="ins-list">${list.map((m) => { const l = m.latest || {}; const vals = m.series.map((x) => x.value);
        return html`<div class="ins-row ins-marker" style="padding:9px 0">
          <div class="grow" style="min-width:0"><div class="small ellipsis">${m.name}${l.flag ? html` <span class="ink-warn xs strong">${l.flag === 'high' ? 'High' : l.flag === 'low' ? 'Low' : 'Abnormal'}</span>` : null}</div>
            <div class="xs muted">${range(l.refLow, l.refHigh)}${l.unit ? ' ' + l.unit : ''} · ${fmtDate(l.date, { dow: false })}</div></div>
          <div class="hide-xs" style="width:64px">${vals.filter(isNum).length >= 2 ? html`<${Sparkline} values=${vals} width=${64} height=${22} />` : null}</div>
          <div style="width:64px"><${RangeBar} value=${l.value} lo=${l.refLow} hi=${l.refHigh} /></div>
          <span class="mono small" style="min-width:78px;text-align:right">${val(l.value, l.unit)}</span>
        </div>`; })}</div>
    </${Card}>`)}</div>
    <${Notice} icon="info">Flags use each report's own reference range. FORGE records results and trends; interpretation and any change in treatment belong with your physician.</${Notice}>
  </div>`;
}
