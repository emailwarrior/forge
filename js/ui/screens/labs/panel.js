// Lab panel detail (#/labs/<id>): markers by category with range bars, flags and change vs previous,
// original files, AI interpretation (stored in the record), edit/delete.
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useWide } from '../../ctx.js';
import { Page, Card, Button, IconButton, Empty, Pill, Notice, Icon, cx } from '../../kit.js';
import { RangeBar } from '../../charts.js';
import { markerSeries, MARKERS } from '../../../analytics/index.js';
import { interpretLabs } from '../../../ai/index.js';
import { fmtDate, nowIso, isNum, hashId, stableStringify } from '../../../core/util.js';
import { useAiTask, AiStatus, AiError, CostNote, AiKeyNotice } from '../../parts/ai.js';
import { EncryptedImage, viewImage, usePhotoUrl } from '../../parts/media.js';
import { removeWithUndo } from '../../parts/common.js';
import { openLabSheet } from './add.js';
import {
  groupMarkers, refText, valueText, changeVsPrevious, flagLabel, sourceLabel, protocolsForAi, statusTone, isCatalogKey, flagOf, flaggedMarkers,
} from '../../parts/records-labs.js';
import { fmtQty, plural } from '../../parts/records-util.js';

export default function PanelDetail({ id }) {
  const app = useApp(); useVersion(['labs', 'protocolItems']);
  const panel = app.store.get('labs', id);
  if (!panel) {
    return html`<${Page} title="Lab panel" back="/labs">
      <${Empty} title="This panel no longer exists" action=${html`<${Button} onClick=${() => app.nav('/labs')}>Back to Labs</${Button}>`}>It may have been deleted on this or another device.</${Empty}>
    </${Page}>`;
  }
  return html`<${Panel} panel=${panel} />`;
}

function Panel({ panel }) {
  const app = useApp(); const wide = useWide();
  const date = String(panel.collectedAt || panel.date || '').slice(0, 10);
  const flags = flaggedMarkers(panel);
  const groups = groupMarkers(panel.markers);
  const series = useAnalytics(() => {
    const m = new Map();
    for (const g of groups) for (const mk of g.markers) if (mk.key && !m.has(mk.key)) m.set(mk.key, markerSeries(app.dv, mk.key));
    return m;
  }, [panel.id, (panel.markers || []).length]) || new Map();
  const files = panel.files && panel.files.length ? panel.files : panel.file ? [panel.file] : [];
  const edit = () => openLabSheet(app, { id: panel.id });
  const del = () => { removeWithUndo(app, 'labs', panel.id, 'Panel'); app.nav('/labs'); };
  const sub = [panel.lab, plural((panel.markers || []).length, 'result'), flags.length ? `${flags.length} flagged` : 'All in range', wide ? sourceLabel(panel.source) : null].filter(Boolean).join(' · ');

  return html`<${Page} title=${fmtDate(date, { year: true, dow: wide })} sub=${sub} back="/labs" wide
    actions=${html`<${IconButton} icon="edit" label="Edit panel" bordered onClick=${edit} />${wide ? html`<${IconButton} icon="trash" label="Delete panel" bordered onClick=${del} />` : null}`}>
    ${flags.length ? html`<${Notice} tone="warn"><b>${plural(flags.length, 'result')} flagged against the lab’s reference range:</b> ${flags.map((f) => `${f.name} (${f.flag})`).join(', ')}. Review ${flags.length === 1 ? 'it' : 'them'} with your physician.</${Notice}>` : null}
    <div class="rec-split wide-right">
      <div class="stack">
        ${groups.map((g) => html`<${Card} title=${g.label} meta=${plural(g.markers.length, 'result')} flush>
          <div class="rec-markers">${g.markers.map((m) => html`<${MarkerRow} m=${m} chg=${changeVsPrevious(series.get(m.key), panel.id)} wide=${wide} />`)}</div>
        </${Card}>`)}
        ${!groups.length ? html`<${Empty} title="No results in this panel">Edit the panel to add results.</${Empty}>` : null}
      </div>
      <div class="stack rec-sticky">
        <${Interpretation} panel=${panel} />
        ${files.length ? html`<${Card} title="Original report" meta=${plural(files.length, 'file')}>
          <div class="rec-orig">${files.map((f, i) => (String(f.mediaType || '').includes('pdf')
            ? html`<${PdfLink} file=${f} n=${i + 1} />`
            : html`<${EncryptedImage} path=${f.path} mediaType=${f.mediaType || 'image/jpeg'} class="thumb rec-orig-thumb" alt=${`Page ${i + 1}`} icon="file"
                onClick=${() => viewImage(app, { path: f.path, mediaType: f.mediaType || 'image/jpeg', title: `Report · page ${i + 1}` })} />`))}</div>
          <div class="xs muted" style="margin-top:8px">Stored encrypted in your vault.</div>
        </${Card}>` : null}
        ${panel.note ? html`<${Card} title="Note"><p class="small dim rec-prewrap">${panel.note}</p></${Card}>` : null}
        ${wide ? null : html`<${Button} variant="danger" icon="trash" onClick=${del}>Delete panel</${Button}>`}
      </div>
    </div>
  </${Page}>`;
}

function MarkerRow({ m, chg, wide }) {
  const app = useApp();
  const num = isNum(m.value);
  const shownFlag = flagOf(m);
  const catName = isCatalogKey(m.key) ? MARKERS[m.key].name : null;
  const alias = catName && catName.toLowerCase() !== String(m.name || '').toLowerCase() ? catName : null;
  const change = chg ? html`<span class="mono">${chg.delta > 0 ? '↑' : chg.delta < 0 ? '↓' : '→'} ${chg.pct != null ? fmtQty(Math.abs(chg.pct)) + '%' : fmtQty(Math.abs(chg.delta))}</span> <span class="muted">vs ${fmtDate(chg.prevDate, { dow: false })}</span>` : null;
  return html`<button type="button" class=${cx('rec-marker', shownFlag && 'flagged')} onClick=${() => m.key && app.nav('/labs?marker=' + encodeURIComponent(m.key))}
    title=${m.key ? 'Show trend' : ''}>
    <div class="rec-marker-name"><span class="small strong">${m.name || catName || m.key}</span>${alias ? html`<span class="xs muted">${alias}</span>` : null}</div>
    <div class="rec-marker-val"><span class="mono strong">${valueText(m.value)}</span> <span class="xs muted">${m.unit || ''}</span></div>
    <div class="rec-marker-range">${num && (isNum(m.refLow) || isNum(m.refHigh)) ? html`<${RangeBar} value=${m.value} lo=${m.refLow} hi=${m.refHigh} />` : html`<span></span>`}
      <span class="xs muted mono">${refText(m.refLow, m.refHigh) || 'No range'}</span></div>
    <div class="rec-marker-flag">${shownFlag ? html`<${Pill} tone="bad">${flagLabel(shownFlag)}</${Pill}>` : null}</div>
    <div class="rec-marker-chg xs">${change || (wide ? html`<span class="muted">First result</span>` : null)}</div>
    ${m.note ? html`<div class="rec-marker-note xs muted">${m.note}</div>` : null}
  </button>`;
}

function PdfLink({ file, n }) {
  const url = usePhotoUrl(file.path, 'application/pdf');
  const label = file.name || `Report ${n}.pdf`;
  if (url === undefined) return html`<span class="btn sm" aria-busy="true"><span class="spinner"></span>${label}</span>`;
  if (!url) return html`<span class="btn sm" aria-disabled="true" title="Not available on this device yet"><${Icon} name="file" />${label} · unavailable</span>`;
  return html`<a class="btn sm rec-pdf" href=${url} target="_blank" rel="noopener"><${Icon} name="file" /><span class="ellipsis">${label}</span><${Icon} name="external" /></a>`;
}

/** Fingerprint of the values an interpretation was based on (stale when the markers change). */
const markersHash = (markers) => hashId(stableStringify(markers || []));

function Interpretation({ panel }) {
  const app = useApp(); const task = useAiTask(); const tz = app.dv.tz;
  const it = panel.ai && panel.ai.interpretation;
  const stale = !!it && (it.markersHash ? it.markersHash !== markersHash(panel.markers) : !!(panel.editedAt && Date.parse(panel.editedAt) > Date.parse(it.at || 0)));
  const run = async () => {
    const history = app.dv.labs().filter((p) => p.id !== panel.id);
    const protocols = protocolsForAi(app.store.all('protocolItems'));
    const res = await task.run(({ ai, signal, onProgress }) => interpretLabs(ai, { panel, history, protocols, signal, onProgress }));
    if (!res) return;
    const cur = app.store.get('labs', panel.id);
    if (!cur) return;
    app.store.update('labs', panel.id, { ai: { ...(cur.ai || {}), interpretation: {
      summary: res.summary, items: res.items, askDoctor: res.askDoctor, model: res.model, costUsd: res.costUsd, costEstimated: !!res.costEstimated, at: nowIso(tz),
      markersHash: markersHash(panel.markers),
    } } });
    app.toast('Interpretation saved with the panel');
  };
  const hasKey = !!app.ai();
  return html`<${Card} title="Interpretation" meta="AI · educational">
    <div class="stack">
      ${it ? html`
        ${stale ? html`<${Notice} tone="warn">Values were edited after this interpretation. Re-run it to include the changes.</${Notice}>` : null}
        ${it.summary ? html`<p class="small rec-prewrap">${it.summary}</p>` : null}
        ${(it.items || []).length ? html`<div class="rec-interp">${it.items.map((x) => html`<div class="rec-interp-item">
          <div class="row between" style="gap:8px"><span class="small strong">${x.name}</span>${statusTone(x.status) || x.status === 'unknown' ? html`<${Pill} tone=${statusTone(x.status)}>${x.status[0].toUpperCase() + x.status.slice(1)}</${Pill}>` : null}</div>
          <div class="xs dim">${x.text}</div></div>`)}</div>` : null}
        ${(it.askDoctor || []).length ? html`<div class="stack xs"><div class="label-text">Questions for your physician</div>
          <ol class="small dim rec-ask">${it.askDoctor.map((q) => html`<li>${q}</li>`)}</ol></div>` : null}
        <div class="row between wrap" style="gap:8px"><span class="xs muted">${it.at ? 'Generated ' + fmtDate(String(it.at).slice(0, 10), { dow: false }) : ''}</span><${CostNote} usd=${it.costUsd} model=${it.model} estimated=${it.costEstimated} /></div>
      ` : html`<p class="small dim">A plain-language explanation of each result, how it compares with your earlier panels, and questions to bring to your physician. Saved with the panel.</p>`}
      ${hasKey ? null : html`<${AiKeyNotice} what="lab interpretation" />`}
      <${AiStatus} task=${task} />
      <${AiError} error=${task.error} onRetry=${run} />
      ${hasKey && !task.busy ? html`<div><${Button} size="sm" variant=${it ? 'ghost' : 'primary'} icon="sparkle" onClick=${run}>${it ? 'Re-run interpretation' : 'Interpret results'}</${Button}></div>` : null}
      <div class="xs muted">Educational only, not medical advice. Review results with your physician.</div>
    </div>
  </${Card}>`;
}
