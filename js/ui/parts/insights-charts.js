// Insights (UI-D): time-proportional trend chart. Same visual language as js/ui/charts.js (2 px lines,
// hairline grid, one y-axis, crosshair + tooltip, legend for ≥ 2 items), plus what Insights needs:
// dots-only series (raw weigh-ins), a varying band (rolling 30-day baseline), a reference band that
// does not stretch the axis (goal range far from the data), custom y ticks (clock times) and a
// left padding that fits long tick labels.
import { html, useState, useRef, useEffect, useMemo } from '../../vendor/preact-htm.js';
import { niceTicks, fmtAxisDate, SERIES } from '../charts.js';
import { dayNum } from '../../analytics/dataview.js';

const PAD = { r: 44, t: 12, b: 22 };
const isNum = (v) => typeof v === 'number' && isFinite(v);
const dateOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const defaultFmt = (v) => (isNum(v) ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 10) / 10)) : '—');

/** [ref, width] of an element (ResizeObserver). */
export function useBoxWidth(fallback = 320) {
  const ref = useRef(null); const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const set = () => setW(Math.max(120, Math.round(el.getBoundingClientRect().width)));
    set();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Tooltip({ x, y, width, children }) {
  if (x == null) return null;
  const left = Math.min(Math.max(x + 12, 4), width - 160);
  return html`<div class="tooltip" style=${`left:${left}px;top:${Math.max(0, y)}px`}>${children}</div>`;
}

/**
 * TrendChart
 * series: [{ key, label, color?, points: [{x: 'YYYY-MM-DD', y}], style: 'line'|'dots'|'line+dots', dashed? }]
 * area:   { points: [{x, lo, hi}], label }     varying band (e.g. 30-day baseline mean ± 1 SD)
 * band:   { lo, hi, label, fit = true }        constant band; fit:false keeps it from stretching the axis
 * target: { y, label }
 * opts: height, yFormat, tipFormat, yTicks(lo, hi) → ticks, yMin, yMax, zero, xDomain [from, to],
 *       endLabels (default: line series ≤ 2), emptyText, minPoints (default 2)
 */
export function TrendChart({ series = [], area, band, target, height = 190, yFormat = defaultFmt, tipFormat, yTicks, yMin, yMax, zero, xDomain, endLabels, emptyText = 'Not enough data yet', minPoints = 2 }) {
  const [ref, width] = useBoxWidth();
  const [hover, setHover] = useState(null);
  const tf = tipFormat || yFormat;
  const model = useMemo(() => {
    const colored = series.map((s, i) => ({ ...s, color: s.color || SERIES[i % SERIES.length], style: s.style || 'line' }));
    const pts = colored.flatMap((s) => s.points.filter((p) => isNum(p.y)));
    if (pts.length < minPoints) return null;
    const ys = pts.map((p) => p.y);
    for (const a of (area && area.points) || []) { if (isNum(a.lo)) ys.push(a.lo); if (isNum(a.hi)) ys.push(a.hi); }
    if (band && band.fit !== false) { if (isNum(band.lo)) ys.push(band.lo); if (isNum(band.hi)) ys.push(band.hi); }
    if (target && isNum(target.y)) ys.push(target.y);
    if (zero) ys.push(0);
    // yMin / yMax are always on the axis (e.g. 0–100 for percentages); data outside them still fits.
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (isNum(yMin)) lo = Math.min(lo, yMin);
    if (isNum(yMax)) hi = Math.max(hi, yMax);
    const ticks = yTicks ? yTicks(lo, hi) : niceTicks(lo, hi);
    const days = pts.map((p) => dayNum(p.x));
    let d0 = xDomain ? dayNum(xDomain[0]) : Math.min(...days), d1 = xDomain ? dayNum(xDomain[1]) : Math.max(...days);
    if (d1 <= d0) { d0 -= 1; d1 += 1; }
    const hoverDays = [...new Set(days)].sort((a, b) => a - b);
    const labelLen = Math.max(...ticks.map((t) => String(yFormat(t)).length));
    return { colored, ticks, lo: ticks[0], hi: ticks[ticks.length - 1], d0, d1, hoverDays, padL: Math.max(38, Math.round(10 + labelLen * 6.4)) };
  }, [series, area, band, target, zero, yMin, yMax, xDomain && xDomain[0], xDomain && xDomain[1]]);
  if (!model) return html`<div ref=${ref} class="chart"><div class="empty" style="padding:18px">${emptyText}</div></div>`;

  const { colored, ticks, lo, hi, d0, d1, hoverDays, padL } = model;
  const lines = colored.filter((s) => s.style !== 'dots');
  const showEnd = endLabels ?? (lines.length > 0 && lines.length <= 2);
  const pr = showEnd ? PAD.r : 12;
  const iw = Math.max(40, width - padL - pr); const ih = height - PAD.t - PAD.b;
  const X = (x) => padL + ((dayNum(x) - d0) / (d1 - d0)) * iw;
  const Xn = (n) => padL + ((n - d0) / (d1 - d0)) * iw;
  const Y = (y) => PAD.t + ih - ((y - lo) / (hi - lo || 1)) * ih;
  const clampY = (y) => Math.max(lo, Math.min(hi, y));

  const linePath = (s) => {
    let d = ''; let open = false;
    for (const p of [...s.points].sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0))) {
      if (!isNum(p.y)) { open = false; continue; }
      d += (open ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1); open = true;
    }
    return d;
  };
  let areaD = '';
  if (area && area.points) {
    let run = [];
    const flush = () => {
      if (run.length > 1) areaD += 'M' + run.map((p) => `${X(p.x).toFixed(1)},${Y(clampY(p.hi)).toFixed(1)}`).join('L') + 'L' + [...run].reverse().map((p) => `${X(p.x).toFixed(1)},${Y(clampY(p.lo)).toFixed(1)}`).join('L') + 'Z';
      run = [];
    };
    for (const p of [...area.points].sort((a, b) => (a.x < b.x ? -1 : 1))) { if (isNum(p.lo) && isNum(p.hi)) run.push(p); else flush(); }
    flush();
  }
  let bandRect = null, bandEdge = null;
  if (band && isNum(band.lo) && isNum(band.hi)) {
    const top = Math.min(hi, band.hi), bottom = Math.max(lo, band.lo);
    if (top > bottom) bandRect = { y: Y(top), h: Y(bottom) - Y(top) };
    else bandEdge = band.lo > hi ? 'above' : 'below';
  }
  const tickCount = Math.max(2, Math.min(6, Math.floor(iw / 72)));
  const xTicks = []; for (let k = 0; k <= tickCount; k++) xTicks.push(Math.round(d0 + ((d1 - d0) * k) / tickCount));
  const uniqX = [...new Set(xTicks)];

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect(); const px = e.clientX - r.left;
    if (px < padL - 8 || px > padL + iw + 8) { setHover(null); return; }
    const n = d0 + ((px - padL) / iw) * (d1 - d0);
    let best = null; for (const d of hoverDays) if (best == null || Math.abs(d - n) < Math.abs(best - n)) best = d;
    if (best == null) { setHover(null); return; }
    setHover({ day: best, date: dateOf(best), x: Xn(best), y: e.clientY - r.top - 44 });
  };
  const at = (s, date) => { const p = s.points.find((q) => q.x === date); return p && isNum(p.y) ? p.y : null; };
  const areaAt = hover && area && area.points ? area.points.find((p) => p.x === hover.date) : null;
  const legend = [...colored.map((s) => ({ label: s.label, color: s.color, box: s.style === 'dots' })),
    ...(area && area.label ? [{ label: area.label, band: true }] : []), ...(band && band.label && bandRect ? [{ label: band.label, band: true }] : [])];

  return html`<div ref=${ref} class="chart ins-trend" onPointerMove=${onMove} onPointerLeave=${() => setHover(null)} onPointerDown=${onMove}>
    <svg width=${width} height=${height} role="img" aria-label=${colored.map((s) => s.label).join(', ')}>
      ${ticks.map((t) => html`<line class="grid-line" x1=${padL} x2=${padL + iw} y1=${Y(t)} y2=${Y(t)} /><text class="tick" x=${padL - 6} y=${Y(t) + 3.5} text-anchor="end">${yFormat(t)}</text>`)}
      ${bandRect ? html`<rect class="band" x=${padL} width=${iw} y=${bandRect.y} height=${bandRect.h} />` : null}
      ${bandEdge ? html`<text class="tick" x=${padL + iw} y=${bandEdge === 'above' ? PAD.t - 2 : PAD.t + ih - 4} text-anchor="end">${band.label || 'Band'} ${bandEdge === 'above' ? 'above ↑' : 'below ↓'}</text>` : null}
      ${areaD ? html`<path class="band ins-area" d=${areaD} />` : null}
      ${target && isNum(target.y) && target.y >= lo && target.y <= hi ? html`<line class="target" x1=${padL} x2=${padL + iw} y1=${Y(target.y)} y2=${Y(target.y)} /><text class="tick" x=${padL + iw} y=${Y(target.y) - 4} text-anchor="end">${target.label || ''}</text>` : null}
      ${uniqX.map((n, i) => html`<text class="tick" x=${Xn(n)} y=${height - 5} text-anchor=${i === 0 ? 'start' : i === uniqX.length - 1 ? 'end' : 'middle'}>${fmtAxisDate(dateOf(n))}</text>`)}
      ${colored.filter((s) => s.style !== 'line').map((s) => s.points.filter((p) => isNum(p.y)).map((p) => html`<circle cx=${X(p.x)} cy=${Y(p.y)} r=${s.style === 'dots' ? 2.6 : 3} style=${`fill:${s.color};fill-opacity:${s.style === 'dots' ? 0.55 : 0.9}`} />`))}
      ${lines.map((s) => html`<path d=${linePath(s)} class="series" style=${`stroke:${s.color}${s.dashed ? ';stroke-dasharray:4 4' : ''}`} />`)}
      ${lines.map((s) => { const last = [...s.points].reverse().find((p) => isNum(p.y)); return last ? html`<circle class="dot" cx=${X(last.x)} cy=${Y(last.y)} r="4" style=${`fill:${s.color}`} />` : null; })}
      ${showEnd ? lines.map((s) => { const last = [...s.points].reverse().find((p) => isNum(p.y)); return last ? html`<text class="end-label" x=${X(last.x) + 8} y=${Y(last.y) + 4}>${yFormat(last.y)}</text>` : null; }) : null}
      ${hover ? html`<line class="crosshair" x1=${hover.x} x2=${hover.x} y1=${PAD.t} y2=${PAD.t + ih} />` : null}
      ${hover ? colored.map((s) => { const v = at(s, hover.date); return v != null ? html`<circle class="dot" cx=${hover.x} cy=${Y(v)} r="4.5" style=${`fill:${s.color}`} />` : null; }) : null}
    </svg>
    ${hover ? html`<${Tooltip} x=${hover.x} y=${hover.y} width=${width}>
      <div class="tt-date">${fmtAxisDate(hover.date)}</div>
      ${colored.map((s) => { const v = at(s, hover.date); return html`<div class="tt-row"><span class="tt-key" style=${`background:${s.color}`}></span><b>${v != null ? tf(v) : '—'}</b><span class="muted">${s.label}</span></div>`; })}
      ${areaAt && isNum(areaAt.lo) ? html`<div class="tt-row"><span class="tt-key" style="background:var(--text-3)"></span><b>${tf(areaAt.lo)}–${tf(areaAt.hi)}</b><span class="muted">${area.label || 'Baseline'}</span></div>` : null}
    </${Tooltip}>` : null}
    ${legend.length >= 2 ? html`<div class="legend">${legend.map((l) => html`<span><i class=${l.band ? 'box ins-band-key' : l.box ? 'box' : ''} style=${l.band ? '' : `background:${l.color}`}></i>${l.label}</span>`)}</div>` : null}
  </div>`;
}

/**
 * GroupBars — categorical bars for a handful of groups (days since dose, protein buckets): every label is
 * shown, the value sits on each bar and the group size under its label. Bars start at zero.
 * groups: [{ label, value, n, sub }]; fmt formats values; nLabel prefixes n ('n').
 */
export function GroupBars({ groups = [], height = 120, color = 'var(--s1)', fmt = defaultFmt, nLabel = 'n', emptyText = 'Not enough data yet', highlight }) {
  const [ref, width] = useBoxWidth();
  const vals = groups.map((g) => g.value).filter(isNum);
  if (!vals.length) return html`<div ref=${ref} class="chart"><div class="empty" style="padding:18px">${emptyText}</div></div>`;
  const max = Math.max(...vals) || 1;
  const padT = 16, padB = groups.some((g) => g.n != null || g.sub) ? 32 : 18;
  const ih = height - padT - padB;
  const slot = width / groups.length; const bw = Math.max(6, Math.min(44, slot * 0.58));
  const Y = (v) => padT + ih - (Math.max(0, v) / max) * ih;
  return html`<div ref=${ref} class="chart ins-groupbars">
    <svg width=${width} height=${height} role="img">
      <line class="axis-line" x1="0" x2=${width} y1=${padT + ih} y2=${padT + ih} />
      ${groups.map((g, i) => {
        const cx = slot * i + slot / 2;
        const has = isNum(g.value);
        const top = has ? Y(g.value) : padT + ih;
        const h = Math.max(has ? 1.5 : 0, padT + ih - top);
        return html`<g>
          ${has ? html`<rect class="bar" x=${cx - bw / 2} y=${top} width=${bw} height=${h} rx="3" style=${`fill:${highlight && highlight(g, i) ? 'var(--s2)' : color}`} />` : null}
          <text class="tick" x=${cx} y=${top - 4} text-anchor="middle" style="fill:var(--text-2)">${has ? fmt(g.value) : '—'}</text>
          <text class="tick" x=${cx} y=${padT + ih + 13} text-anchor="middle">${g.label}</text>
          ${g.n != null || g.sub ? html`<text class="tick" x=${cx} y=${padT + ih + 26} text-anchor="middle" style="opacity:.75">${g.sub || `${nLabel} ${g.n}`}</text>` : null}
        </g>`;
      })}
    </svg>
  </div>`;
}
