// SVG charts following the dataviz spec: 2px lines, hairline recessive grid, one y-axis,
// crosshair + tooltip on lines, per-mark tooltip on bars, legend for ≥2 series, text in ink tokens.
import { html, useState, useRef, useEffect, useMemo } from '../vendor/preact-htm.js';

const PAD = { l: 38, r: 44, t: 10, b: 22 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isNum = (v) => typeof v === 'number' && isFinite(v);
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

function useWidth(fallback = 320) {
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

export function niceTicks(min, max, count = 4) {
  if (!isNum(min) || !isNum(max)) return [0, 1];
  if (min === max) { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
  const span = max - min; const step0 = span / count; const mag = 10 ** Math.floor(Math.log10(step0));
  const err = step0 / mag; const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step; const hi = Math.ceil(max / step) * step;
  const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
export function fmtAxisDate(s) {
  if (typeof s !== 'string' || s.length < 10) return String(s);
  return MONTHS[Number(s.slice(5, 7)) - 1] + ' ' + Number(s.slice(8, 10));
}
const defaultFmt = (v) => (isNum(v) ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 10) / 10)) : '—');

function Tooltip({ x, y, width, children }) {
  if (x == null) return null;
  const left = Math.min(Math.max(x + 12, 4), width - 150);
  return html`<div class="tooltip" style=${`left:${left}px;top:${Math.max(0, y)}px`}>${children}</div>`;
}

export function Legend({ items, box }) {
  if (!items || items.length < 2) return null;
  return html`<div class="legend">${items.map((s) => html`<span><i class=${box ? 'box' : ''} style=${`background:${s.color}`}></i>${s.label}</span>`)}</div>`;
}

/**
 * LineChart
 * series: [{ key, label, color?, points: [{ x: 'YYYY-MM-DD'|number, y: number|null }], dashed? }]
 * opts: height, yFormat(v), xFormat(x), yMin, yMax, zero (include 0), band {lo, hi, label}, target {y, label}, area (bool), endLabels (default true when ≤4 series)
 */
export function LineChart({ series = [], height = 180, yFormat = defaultFmt, xFormat = fmtAxisDate, yMin, yMax, zero, band, target, area, endLabels, emptyText = 'Not enough data yet' }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const model = useMemo(() => {
    const colored = series.map((s, i) => ({ ...s, color: s.color || SERIES[i % SERIES.length] }));
    const xs = [...new Set(colored.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const ys = colored.flatMap((s) => s.points.map((p) => p.y)).filter(isNum);
    if (band) { if (isNum(band.lo)) ys.push(band.lo); if (isNum(band.hi)) ys.push(band.hi); }
    if (target && isNum(target.y)) ys.push(target.y);
    if (zero) ys.push(0);
    if (!ys.length || xs.length < 2) return null;
    const ticks = niceTicks(isNum(yMin) ? yMin : Math.min(...ys), isNum(yMax) ? yMax : Math.max(...ys));
    return { colored, xs, ticks, lo: ticks[0], hi: ticks[ticks.length - 1] };
  }, [series, band, target, zero, yMin, yMax]);
  if (!model) return html`<div ref=${ref} class="chart"><div class="empty" style="padding:18px">${emptyText}</div></div>`;
  const { colored, xs, ticks, lo, hi } = model;
  const showEnd = endLabels ?? colored.length <= 4;
  const pr = showEnd ? PAD.r : 12;
  const iw = Math.max(40, width - PAD.l - pr); const ih = height - PAD.t - PAD.b;
  const xi = new Map(xs.map((x, i) => [x, i]));
  const X = (x) => PAD.l + (xs.length === 1 ? iw / 2 : (xi.get(x) / (xs.length - 1)) * iw);
  const Y = (y) => PAD.t + ih - ((y - lo) / (hi - lo || 1)) * ih;
  const paths = colored.map((s) => {
    let d = ''; let areaD = ''; let run = [];
    const flush = () => { if (run.length > 1 && area) areaD += `M${run[0][0]},${Y(Math.max(lo, 0 > lo ? 0 : lo))}` + run.map(([x, y]) => `L${x},${y}`).join('') + `L${run[run.length - 1][0]},${Y(Math.max(lo, 0 > lo ? 0 : lo))}Z`; run = []; };
    for (const p of [...s.points].sort((a, b) => (a.x < b.x ? -1 : 1))) {
      if (!isNum(p.y)) { flush(); continue; }
      const px = X(p.x), py = Y(p.y);
      d += (run.length ? 'L' : 'M') + px.toFixed(1) + ',' + py.toFixed(1);
      run.push([px.toFixed(1), py.toFixed(1)]);
    }
    flush();
    const last = [...s.points].reverse().find((p) => isNum(p.y));
    return { s, d, areaD, last };
  });
  const tickEvery = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(iw / 70))));
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect(); const px = e.clientX - r.left;
    const idx = Math.round(((px - PAD.l) / iw) * (xs.length - 1));
    if (idx < 0 || idx >= xs.length) { setHover(null); return; }
    setHover({ idx, x: X(xs[idx]), y: e.clientY - r.top - 40 });
  };
  const hx = hover ? xs[hover.idx] : null;
  return html`<div ref=${ref} class="chart" onPointerMove=${onMove} onPointerLeave=${() => setHover(null)} onPointerDown=${onMove}>
    <svg width=${width} height=${height} role="img" aria-label=${colored.map((s) => s.label).join(', ')}>
      ${ticks.map((t) => html`<line class="grid-line" x1=${PAD.l} x2=${PAD.l + iw} y1=${Y(t)} y2=${Y(t)} /><text class="tick" x=${PAD.l - 6} y=${Y(t) + 3.5} text-anchor="end">${yFormat(t)}</text>`)}
      ${band && isNum(band.lo) && isNum(band.hi) ? html`<rect class="band" x=${PAD.l} width=${iw} y=${Y(Math.min(hi, band.hi))} height=${Math.max(0, Y(Math.max(lo, band.lo)) - Y(Math.min(hi, band.hi)))} />` : null}
      ${target && isNum(target.y) ? html`<line class="target" x1=${PAD.l} x2=${PAD.l + iw} y1=${Y(target.y)} y2=${Y(target.y)} /><text class="tick target-label" x=${PAD.l + iw} y=${Y(target.y) - 4} text-anchor="end">${target.label || ''}</text>` : null}
      ${xs.map((x, i) => (i % tickEvery === 0 || i === xs.length - 1) && (i === xs.length - 1 || xs.length - 1 - i >= tickEvery * 0.9) ? html`<text class="tick" x=${X(x)} y=${height - 5} text-anchor=${i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle'}>${xFormat(x)}</text>` : null)}
      ${paths.map(({ s, areaD }) => (areaD ? html`<path d=${areaD} class="area" style=${`fill:${s.color}`} />` : null))}
      ${paths.map(({ s, d }) => html`<path d=${d} class="series" style=${`stroke:${s.color}${s.dashed ? ';stroke-dasharray:4 4' : ''}`} />`)}
      ${paths.map(({ s, last }) => (last ? html`<circle class="dot" cx=${X(last.x)} cy=${Y(last.y)} r="4" style=${`fill:${s.color}`} />` : null))}
      ${showEnd ? paths.map(({ last }) => (last ? html`<text class="end-label" x=${X(last.x) + 8} y=${Y(last.y) + 4}>${yFormat(last.y)}</text>` : null)) : null}
      ${hover ? html`<line class="crosshair" x1=${hover.x} x2=${hover.x} y1=${PAD.t} y2=${PAD.t + ih} />` : null}
      ${hover ? colored.map((s) => { const p = s.points.find((q) => q.x === hx); return p && isNum(p.y) ? html`<circle class="dot" cx=${hover.x} cy=${Y(p.y)} r="4.5" style=${`fill:${s.color}`} />` : null; }) : null}
    </svg>
    ${hover ? html`<${Tooltip} x=${hover.x} y=${hover.y} width=${width}>
      <div class="tt-date">${typeof hx === 'string' ? fmtAxisDate(hx) : xFormat(hx)}</div>
      ${colored.map((s) => { const p = s.points.find((q) => q.x === hx); return html`<div class="tt-row"><span class="tt-key" style=${`background:${s.color}`}></span><b>${p && isNum(p.y) ? yFormat(p.y) : '—'}</b><span class="muted">${s.label}</span></div>`; })}
    </${Tooltip}>` : null}
    <${Legend} items=${colored} />
  </div>`;
}

/**
 * BarChart (columns)
 * data: [{ x, y, color?, label? }]; opts: height, yFormat, xFormat, target {y, label}, color
 */
export function BarChart({ data = [], height = 160, yFormat = defaultFmt, xFormat = fmtAxisDate, target, color = 'var(--s1)', zero = true, emptyText = 'Not enough data yet' }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const vals = data.map((d) => d.y).filter(isNum);
  if (!vals.length) return html`<div ref=${ref} class="chart"><div class="empty" style="padding:18px">${emptyText}</div></div>`;
  const ticks = niceTicks(zero ? Math.min(0, ...vals) : Math.min(...vals), Math.max(...vals, target && isNum(target.y) ? target.y : -Infinity));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const iw = Math.max(40, width - PAD.l - 12); const ih = height - PAD.t - PAD.b;
  const slot = iw / data.length; const bw = Math.min(24, Math.max(3, slot - 2));
  const Y = (y) => PAD.t + ih - ((y - lo) / (hi - lo || 1)) * ih;
  const base = Y(Math.max(lo, 0));
  const tickEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 64))));
  return html`<div ref=${ref} class="chart" onPointerLeave=${() => setHover(null)}>
    <svg width=${width} height=${height} role="img">
      ${ticks.map((t) => html`<line class="grid-line" x1=${PAD.l} x2=${PAD.l + iw} y1=${Y(t)} y2=${Y(t)} /><text class="tick" x=${PAD.l - 6} y=${Y(t) + 3.5} text-anchor="end">${yFormat(t)}</text>`)}
      ${data.map((d, i) => {
        if (!isNum(d.y)) return null;
        const cx = PAD.l + slot * i + slot / 2; const top = Y(Math.max(d.y, lo)); const h = Math.max(1, Math.abs(base - top));
        const y0 = d.y >= 0 ? top : base; const r = Math.min(4, bw / 2, h);
        const path = d.y >= 0
          ? `M${cx - bw / 2},${base}V${y0 + r}Q${cx - bw / 2},${y0} ${cx - bw / 2 + r},${y0}H${cx + bw / 2 - r}Q${cx + bw / 2},${y0} ${cx + bw / 2},${y0 + r}V${base}Z`
          : `M${cx - bw / 2},${base}V${base + h - r}Q${cx - bw / 2},${base + h} ${cx - bw / 2 + r},${base + h}H${cx + bw / 2 - r}Q${cx + bw / 2},${base + h} ${cx + bw / 2},${base + h - r}V${base}Z`;
        return html`<path class="bar" d=${path} style=${`fill:${d.color || color}`}
          onPointerEnter=${() => setHover({ i, x: cx, y: top - 44 })} onPointerDown=${() => setHover({ i, x: cx, y: top - 44 })} />`;
      })}
      <line class="axis-line" x1=${PAD.l} x2=${PAD.l + iw} y1=${base} y2=${base} />
      ${target && isNum(target.y) ? html`<line class="target" x1=${PAD.l} x2=${PAD.l + iw} y1=${Y(target.y)} y2=${Y(target.y)} /><text class="tick target-label" x=${PAD.l + iw} y=${Y(target.y) - 4} text-anchor="end">${target.label || ''}</text>` : null}
      ${data.map((d, i) => (i % tickEvery === 0 ? html`<text class="tick" x=${PAD.l + slot * i + slot / 2} y=${height - 5} text-anchor="middle">${xFormat(d.x)}</text>` : null))}
    </svg>
    ${hover ? html`<${Tooltip} x=${hover.x} y=${hover.y} width=${width}><div class="tt-date">${data[hover.i].label || xFormat(data[hover.i].x)}</div><div class="tt-row"><b>${yFormat(data[hover.i].y)}</b></div></${Tooltip}>` : null}
  </div>`;
}

/**
 * StackedBars — part-to-whole per x.
 * data: [{ x, parts: { key: value } }]; keys: [{ key, label, color }]
 */
export function StackedBars({ data = [], keys = [], height = 170, yFormat = defaultFmt, xFormat = fmtAxisDate }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const totals = data.map((d) => keys.reduce((s, k) => s + (isNum(d.parts[k.key]) ? d.parts[k.key] : 0), 0));
  if (!totals.some((t) => t > 0)) return html`<div ref=${ref} class="chart"><div class="empty" style="padding:18px">Not enough data yet</div></div>`;
  const ticks = niceTicks(0, Math.max(...totals)); const hi = ticks[ticks.length - 1];
  const iw = Math.max(40, width - PAD.l - 12); const ih = height - PAD.t - PAD.b;
  const slot = iw / data.length; const bw = Math.min(24, Math.max(4, slot - 2));
  const Y = (y) => PAD.t + ih - (y / (hi || 1)) * ih;
  const tickEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 64))));
  const colored = keys.map((k, i) => ({ ...k, color: k.color || SERIES[i % SERIES.length] }));
  return html`<div ref=${ref} class="chart" onPointerLeave=${() => setHover(null)}>
    <svg width=${width} height=${height}>
      ${ticks.map((t) => html`<line class="grid-line" x1=${PAD.l} x2=${PAD.l + iw} y1=${Y(t)} y2=${Y(t)} /><text class="tick" x=${PAD.l - 6} y=${Y(t) + 3.5} text-anchor="end">${yFormat(t)}</text>`)}
      ${data.map((d, i) => { let acc = 0; const cx = PAD.l + slot * i + slot / 2;
        return colored.map((k) => { const v = d.parts[k.key]; if (!isNum(v) || v <= 0) return null;
          const y1 = Y(acc + v), y0 = Y(acc); acc += v;
          return html`<rect class="bar" x=${cx - bw / 2} y=${y1 + 1} width=${bw} height=${Math.max(0, y0 - y1 - 2)} rx="2" style=${`fill:${k.color}`}
            onPointerEnter=${() => setHover({ i, x: cx, y: y1 - 50 })} onPointerDown=${() => setHover({ i, x: cx, y: y1 - 50 })} />`; }); })}
      ${data.map((d, i) => (i % tickEvery === 0 ? html`<text class="tick" x=${PAD.l + slot * i + slot / 2} y=${height - 5} text-anchor="middle">${xFormat(d.x)}</text>` : null))}
    </svg>
    ${hover ? html`<${Tooltip} x=${hover.x} y=${hover.y} width=${width}><div class="tt-date">${xFormat(data[hover.i].x)}</div>
      ${colored.map((k) => html`<div class="tt-row"><span class="tt-key" style=${`background:${k.color}`}></span><b>${yFormat(data[hover.i].parts[k.key] || 0)}</b><span class="muted">${k.label}</span></div>`)}</${Tooltip}>` : null}
    <${Legend} items=${colored} box />
  </div>`;
}

/** Sparkline: { values: number[] (nulls allowed), color, height, width } */
export function Sparkline({ values = [], color = 'var(--text-3)', height = 26, width = 96, highlightLast = true }) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => isNum(v));
  if (pts.length < 2) return html`<svg width=${width} height=${height}></svg>`;
  const lo = Math.min(...pts.map((p) => p[1])); const hi = Math.max(...pts.map((p) => p[1]));
  const X = (i) => 2 + (i / (values.length - 1)) * (width - 4); const Y = (v) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (height - 6);
  const d = pts.map(([i, v], k) => (k ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join('');
  const last = pts[pts.length - 1];
  return html`<svg width=${width} height=${height} aria-hidden="true" style="display:block;overflow:visible"><path d=${d} fill="none" stroke=${color} stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
    ${highlightLast ? html`<circle cx=${X(last[0])} cy=${Y(last[1])} r="2.6" fill="var(--accent)" />` : null}</svg>`;
}

/** Ring: { value (0–100|null), size, stroke, color, label, sub } */
export function Ring({ value, size = 112, stroke = 10, color = 'var(--s1)', label, sub }) {
  const r = (size - stroke) / 2; const c = 2 * Math.PI * r; const pct = isNum(value) ? Math.max(0, Math.min(100, value)) : 0;
  return html`<div class="ring-wrap" style=${`width:${size}px;height:${size}px`}>
    <svg width=${size} height=${size} style="transform:rotate(-90deg)">
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--surface-3)" stroke-width=${stroke} />
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke=${color} stroke-width=${stroke} stroke-linecap="round"
        stroke-dasharray=${c} stroke-dashoffset=${c - (c * pct) / 100} style="transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1)" />
    </svg>
    <div class="ring-label"><b>${label ?? (isNum(value) ? Math.round(value) : '—')}</b>${sub ? html`<span>${sub}</span>` : null}</div>
  </div>`;
}

/** Heatmap (calendar): { days: [{date, value 0–100|null}], color } — columns are weeks (Mon top). */
export function Heatmap({ days = [], color = 'var(--s1)', format = (v) => (isNum(v) ? Math.round(v) + '%' : 'No data') }) {
  const [tip, setTip] = useState(null);
  if (!days.length) return null;
  const first = days[0].date; const dow0 = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const cells = [...Array(dow0).fill(null), ...days];
  return html`<div style="position:relative">
    <div class="heat" onPointerLeave=${() => setTip(null)}>
      ${cells.map((d) => (d ? html`<i title=${d.date + ': ' + format(d.value)} style=${isNum(d.value) ? `background:${color};opacity:${0.18 + 0.82 * Math.max(0, Math.min(1, d.value / 100))}` : ''}
        onPointerEnter=${() => setTip(d)}></i>` : html`<i style="visibility:hidden"></i>`))}
    </div>
    <div class="xs muted" style="margin-top:6px;min-height:16px">${tip ? fmtAxisDate(tip.date) + ' · ' + format(tip.value) : 'Hover a day'}</div>
  </div>`;
}

/** Scatter: { points: [{x, y, label?}], xLabel, yLabel, xFormat, yFormat, trend } */
export function Scatter({ points = [], height = 200, xLabel = '', yLabel = '', xFormat = defaultFmt, yFormat = defaultFmt, color = 'var(--s1)', trend = true }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pts = points.filter((p) => isNum(p.x) && isNum(p.y));
  if (pts.length < 3) return html`<div ref=${ref} class="chart"><div class="empty" style="padding:18px">Not enough paired days yet</div></div>`;
  const xt = niceTicks(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)));
  const yt = niceTicks(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)));
  const iw = Math.max(40, width - PAD.l - 12); const ih = height - PAD.t - PAD.b - 12;
  const X = (x) => PAD.l + ((x - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * iw;
  const Y = (y) => PAD.t + ih - ((y - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * ih;
  let line = null;
  if (trend) {
    const n = pts.length; const mx = pts.reduce((s, p) => s + p.x, 0) / n; const my = pts.reduce((s, p) => s + p.y, 0) / n;
    const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0); const sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    if (sxx > 0) { const b = sxy / sxx; const a = my - b * mx; line = [xt[0], a + b * xt[0], xt[xt.length - 1], a + b * xt[xt.length - 1]]; }
  }
  return html`<div ref=${ref} class="chart" onPointerLeave=${() => setHover(null)}>
    <svg width=${width} height=${height}>
      ${yt.map((t) => html`<line class="grid-line" x1=${PAD.l} x2=${PAD.l + iw} y1=${Y(t)} y2=${Y(t)} /><text class="tick" x=${PAD.l - 6} y=${Y(t) + 3.5} text-anchor="end">${yFormat(t)}</text>`)}
      ${xt.map((t) => html`<text class="tick" x=${X(t)} y=${PAD.t + ih + 14} text-anchor="middle">${xFormat(t)}</text>`)}
      ${line ? html`<line x1=${X(line[0])} y1=${Y(line[1])} x2=${X(line[2])} y2=${Y(line[3])} stroke="var(--text-3)" stroke-width="1.5" />` : null}
      ${pts.map((p, i) => html`<g onPointerEnter=${() => setHover({ i, x: X(p.x), y: Y(p.y) - 46 })} onPointerDown=${() => setHover({ i, x: X(p.x), y: Y(p.y) - 46 })}>
        <circle cx=${X(p.x)} cy=${Y(p.y)} r="12" fill="transparent" /><circle class="dot" cx=${X(p.x)} cy=${Y(p.y)} r="4" style=${`fill:${color};fill-opacity:.85`} /></g>`)}
      <text class="tick" x=${PAD.l + iw} y=${height - 2} text-anchor="end">${xLabel}</text>
      <text class="tick" x=${PAD.l} y=${PAD.t - 2}>${yLabel}</text>
    </svg>
    ${hover ? html`<${Tooltip} x=${hover.x} y=${hover.y} width=${width}>${pts[hover.i].label ? html`<div class="tt-date">${pts[hover.i].label}</div>` : null}
      <div class="tt-row"><span class="muted">${xLabel || 'x'}</span><b>${xFormat(pts[hover.i].x)}</b></div><div class="tt-row"><span class="muted">${yLabel || 'y'}</span><b>${yFormat(pts[hover.i].y)}</b></div></${Tooltip}>` : null}
  </div>`;
}

/** RangeBar: marker position within a reference range. { value, lo, hi } */
export function RangeBar({ value, lo, hi }) {
  if (!isNum(value)) return html`<div class="range-bar"></div>`;
  const a = isNum(lo) ? lo : Math.min(value, isNum(hi) ? hi * 0.5 : value * 0.5);
  const b = isNum(hi) ? hi : Math.max(value, a * 2 || 1);
  const span = b - a || 1; const min = a - span * 0.35; const max = b + span * 0.35;
  const P = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return html`<div class="range-bar" title=${`${value} (range ${isNum(lo) ? lo : '–'}–${isNum(hi) ? hi : '–'})`}>
    <div class="ok" style=${`left:${P(a)}%;width:${P(b) - P(a)}%`}></div><div class="mk" style=${`left:${P(value)}%`}></div></div>`;
}
