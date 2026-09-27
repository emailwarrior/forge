// Marker trend card (Labs home): pick a marker → markerSeries LineChart with the reference band,
// value table, and before/after a protocol item (protocolBeforeAfter).
import { html, useState, useEffect } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics } from '../../ctx.js';
import { Card, Pill, Select, Field, cx } from '../../kit.js';
import { LineChart } from '../../charts.js';
import { protocolBeforeAfter } from '../../../analytics/index.js';
import { fmtDate, isNum } from '../../../core/util.js';
import { LAB_CATEGORIES, refText, valueText, flagLabel } from '../../parts/records-labs.js';
import { fmtQty } from '../../parts/records-util.js';

/** { summary: labSummary(dv), markerKey (from the route), onPick(key) } */
export function MarkerTrend({ summary, markerKey, onPick }) {
  const app = useApp();
  const markers = (summary && summary.markers) || [];
  const fallback = (summary && summary.flagged && summary.flagged[0] && summary.flagged[0].key) || (markers[0] && markers[0].key) || null;
  const [key, setKey] = useState(markerKey || fallback);
  useEffect(() => { if (markerKey) setKey(markerKey); }, [markerKey]);
  const mk = markers.find((m) => m.key === key) || markers.find((m) => m.key === fallback) || markers[0] || null;
  const [itemId, setItemId] = useState('');
  const items = app.store.all('protocolItems');
  const ba = useAnalytics(() => (itemId && mk ? protocolBeforeAfter(app.dv, mk.key, itemId) : null), [itemId, mk && mk.key]);
  if (!mk) return null;

  const pick = (k) => { setKey(k); if (onPick) onPick(k); };
  const series = mk.series || [];
  const last = series[series.length - 1] || null;
  const unit = (last && last.unit) || '';
  // A lower bound of 0 is no bound for concentrations: show a one-sided limit line so the axis follows the data.
  const lo = last && isNum(last.refLow) && last.refLow > 0 ? last.refLow : null;
  const hi = last && isNum(last.refHigh) ? last.refHigh : null;
  const band = lo != null && hi != null ? { lo, hi } : null;
  const target = !band && (hi != null || lo != null) ? { y: hi != null ? hi : lo, label: hi != null ? 'Upper limit' : 'Lower limit' } : null;
  const numeric = series.filter((p) => isNum(p.value));
  const groups = LAB_CATEGORIES.map(([id, label]) => ({ id, label, list: markers.filter((m) => (m.category || 'other') === id) })).filter((g) => g.list.length);
  const flaggedKeys = new Set(((summary && summary.flagged) || []).map((f) => f.key));
  const item = items.find((i) => i.id === itemId);

  return html`<${Card} title="Marker trend" meta=${plural(numeric.length)}>
    <div class="stack">
      <select class="select" value=${mk.key} onChange=${(e) => pick(e.currentTarget.value)} aria-label="Marker">
        ${groups.map((g) => html`<optgroup label=${g.label}>${g.list.map((m) => html`<option value=${m.key}>${m.name}${flaggedKeys.has(m.key) ? ' · flagged' : ''}</option>`)}</optgroup>`)}
      </select>
      ${numeric.length >= 2
        ? html`<${LineChart} series=${[{ key: mk.key, label: mk.name, points: numeric.map((p) => ({ x: p.date, y: p.value })) }]} band=${band} target=${target}
            height=${200} yFormat=${(v) => fmtQty(Math.round(v * 100) / 100)} />`
        : html`<div class="rec-one-result"><span class="mono lg-text strong">${last ? valueText(last.value) : '—'}</span> <span class="small muted">${unit}</span>
            <div class="xs muted">${numeric.length === 1 ? `One result so far (${fmtDate(numeric[0].date, { dow: false, year: true })}). The trend line appears after the next panel.` : 'No numeric results for this marker.'}</div></div>`}
      ${numeric.length >= 2 && (band || target) ? html`<div class="xs muted">${band ? 'Shaded band: reference range' : target.label + ' of the reference range'} of the latest result (${refText(last.refLow, last.refHigh)}${unit ? ' ' + unit : ''}).</div>` : null}
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th class="num">Value</th><th class="hide-sm">Range</th><th>Flag</th></tr></thead>
        <tbody>${series.slice().reverse().map((p) => html`<tr class="link" onClick=${() => app.nav('/labs/' + encodeURIComponent(p.panelId))}>
          <td>${fmtDate(p.date, { dow: false, year: String(p.date).slice(0, 4) !== app.today().slice(0, 4) })}</td>
          <td class="num">${p.qualifier ? p.qualifier + ' ' : ''}${valueText(p.value)} <span class="muted">${p.unit || ''}</span></td>
          <td class="dim mono xs hide-sm">${refText(p.refLow, p.refHigh) || '—'}</td>
          <td>${p.flag ? html`<${Pill} tone="bad">${flagLabel(p.flag)}</${Pill}>` : html`<span class="muted xs">In range</span>`}</td></tr>`)}</tbody>
      </table></div>
      ${items.length ? html`<div class="stack sm rec-ba">
        <${Field} label="Before / after a protocol item">
          <${Select} value=${itemId} onValue=${setItemId} options=${[{ value: '', label: 'Choose an item…' }, ...items.map((i) => ({ value: i.id, label: i.name + (i.active === false ? ' (inactive)' : '') }))]} />
        </${Field}>
        ${ba ? (ba.start
          ? (ba.before.n && ba.after.n
            ? html`<div class="rec-ba-row">
                <div><div class="xs muted">Before ${fmtDate(ba.start, { dow: false, year: true })} · n=${ba.before.n}</div><div class="mono strong">${fmtQty(ba.before.mean)} <span class="muted xs">${unit}</span></div></div>
                <div class="muted">→</div>
                <div><div class="xs muted">Since · n=${ba.after.n}</div><div class="mono strong">${fmtQty(ba.after.mean)} <span class="muted xs">${unit}</span></div></div>
                <div class=${cx('mono small', 'dim')}>${ba.pct != null ? (ba.pct > 0 ? '+' : '') + fmtQty(ba.pct) + '%' : ''}</div>
              </div>
              <div class="xs muted">Means of the results on each side of the start date. An association in your own data, not proof of cause.</div>`
            : html`<div class="xs muted">Needs at least one ${mk.name} result before and one after ${fmtDate(ba.start, { dow: false, year: true })}, when ${item ? item.name : 'the item'} started.</div>`)
          : html`<div class="xs muted">${item ? item.name : 'This item'} has no start date or logged doses yet.</div>`) : null}
      </div>` : null}
    </div>
  </${Card}>`;
}
const plural = (n) => `${n} result${n === 1 ? '' : 's'}`;
