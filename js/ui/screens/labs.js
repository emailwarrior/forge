// Labs (#/labs[?marker=<key>], #/labs/<id>): panel list, flags of the latest panel, marker trends,
// changes since the previous panel; upload (AI extraction) or manual entry of new panels.
import { html, useRef, useEffect } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useWide } from '../ctx.js';
import { Page, Card, Button, Empty, List, ListRow, Pill, Notice } from '../kit.js';
import { labSummary } from '../../analytics/index.js';
import { fmtDate } from '../../core/util.js';
import { AiKeyNotice } from '../parts/ai.js';
import { openLabSheet } from './labs/add.js';
import PanelDetail from './labs/panel.js';
import { MarkerTrend } from './labs/trends.js';
import { flaggedMarkers, sourceLabel } from '../parts/records-labs.js';
import { fmtQty, plural } from '../parts/records-util.js';

export default function Screen({ route }) {
  if (route.parts[1]) return html`<${PanelDetail} id=${route.parts[1]} />`;
  return html`<${LabsHome} marker=${route.query.marker || null} />`;
}

function LabsHome({ marker }) {
  const app = useApp(); useVersion(['labs', 'protocolItems']);
  const wide = useWide();
  const trendRef = useRef(null);
  const summary = useAnalytics(() => labSummary(app.dv), []);
  const panels = app.dv.labs().slice().reverse();
  const add = async (mode) => { const id = await openLabSheet(app, { mode }); if (id) app.nav('/labs/' + encodeURIComponent(id)); };
  useEffect(() => {
    if (!marker || wide || !trendRef.current) return undefined;
    const t = setTimeout(() => trendRef.current && trendRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    return () => clearTimeout(t);
  }, [marker]);

  if (!panels.length) {
    return html`<${Page} title="Labs" sub="Blood panels and marker trends" wide>
      <div class="rec-split even">
        <${Empty} title="No lab results yet" action=${html`<div class="row wrap" style="gap:8px;justify-content:center">
            <${Button} variant="primary" icon="upload" onClick=${() => add('upload')}>Upload report</${Button}>
            <${Button} icon="edit" onClick=${() => add('manual')}>Enter manually</${Button}></div>`}>
          When your blood test results arrive (for example the Rythm PDF), upload the PDF or screenshots of each page.
          AI reads every result, unit and reference range; you review and correct them before saving, and the original file is kept encrypted in your vault.
        </${Empty}>
        <${Card} title="What you get">
          <ul class="small dim rec-bullets">
            <li>Each result against the lab’s own reference range, grouped by category (lipids, hormones, thyroid, …).</li>
            <li>Change versus your previous panel and a trend line per marker.</li>
            <li>Before/after comparisons for a supplement, peptide or medication you log in Protocols.</li>
            <li>An optional plain-language interpretation with questions for your physician. Out-of-range results are always marked for physician review.</li>
          </ul>
          ${app.ai() ? null : html`<div style="margin-top:12px"><${AiKeyNotice} what="report extraction and interpretation (manual entry works without it)" /></div>`}
        </${Card}>
      </div>
    </${Page}>`;
  }

  const latest = panels[0];
  const flags = flaggedMarkers(latest);
  const changes = ((summary && summary.changes) || []).filter((c) => c.pct != null).slice(0, 6);
  const pick = (k) => app.nav('/labs?marker=' + encodeURIComponent(k));
  const changesCard = changes.length ? html`<${Card} title="Largest changes" meta="Latest vs previous" flush>
    <${List}>${changes.map((c) => html`<${ListRow} onClick=${() => pick(c.key)} title=${c.name}
      meta=${`${fmtQty(c.from)} → ${fmtQty(c.to)} · since ${fmtDate(c.fromDate, { dow: false })}`}
      trail=${html`<span class="mono small dim">${c.pct > 0 ? '+' : ''}${fmtQty(c.pct)}%</span>`} />`)}</${List}>
  </${Card}>` : null;
  return html`<${Page} title="Labs" sub=${`${plural(panels.length, 'panel')} · latest ${fmtDate(String(latest.collectedAt || latest.date).slice(0, 10), { dow: false, year: true })}`} wide
    actions=${html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => add('upload')}>Add</${Button}>`}>
    ${flags.length ? html`<${Notice} tone="warn"><div class="row between wrap" style="gap:8px"><span><b>Latest panel:</b> ${flags.map((f) => `${f.name} (${f.flag})`).join(', ')} outside the reference range. Review with your physician.</span>
      <${Button} size="sm" onClick=${() => app.nav('/labs/' + encodeURIComponent(latest.id))}>Open panel</${Button}></div></${Notice}>` : null}
    <div class="rec-split">
      <div class="stack">
        <${Card} title="Panels" meta=${plural(panels.length, 'panel')} flush>
          <${List}>${panels.map((p) => { const f = flaggedMarkers(p).length; return html`<${ListRow} onClick=${() => app.nav('/labs/' + encodeURIComponent(p.id))}
            title=${fmtDate(String(p.collectedAt || p.date).slice(0, 10), { year: true })}
            meta=${[p.lab, plural((p.markers || []).length, 'result'), sourceLabel(p.source)].filter(Boolean).join(' · ')}
            trail=${f ? html`<${Pill} tone="bad">${f} flagged</${Pill}>` : html`<span class="xs muted">In range</span>`} />`; })}</${List}>
        </${Card}>
        ${wide ? changesCard : null}
      </div>
      <div class="stack">
        <div ref=${trendRef} class="rec-anchor"><${MarkerTrend} summary=${summary} markerKey=${marker} onPick=${null} /></div>
        ${wide ? null : changesCard}
      </div>
    </div>
  </${Page}>`;
}
