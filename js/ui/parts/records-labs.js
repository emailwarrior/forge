// Labs UI logic (pure): review rows ⇄ stored markers, keys, flags, grouping, change vs previous,
// display text, upload limits. Flags come from the report's own range (analytics markerFlag).
// Tests: tests/ui/records-labs.test.mjs.
import { MARKERS, normalizeMarkerName, markerFlag, markerKey } from '../../analytics/labs.js';
import { isNum, slug } from '../../core/util.js';
import { fmtQty, parseNum } from './records-util.js';

export const LAB_CATEGORIES = [
  ['lipids', 'Lipids'], ['metabolic', 'Metabolic'], ['inflammation', 'Inflammation'], ['hormones', 'Hormones'],
  ['thyroid', 'Thyroid'], ['vitamins', 'Vitamins'], ['iron', 'Iron'], ['minerals', 'Minerals'], ['electrolytes', 'Electrolytes'],
  ['kidney', 'Kidney'], ['liver', 'Liver'], ['blood', 'Blood count'], ['muscle', 'Muscle'], ['other', 'Other'],
];
export const categoryName = (id) => (LAB_CATEGORIES.find((c) => c[0] === id) || [null, 'Other'])[1];
export const FLAGS = [{ value: '', label: '—' }, { value: 'high', label: 'High' }, { value: 'low', label: 'Low' }, { value: 'abnormal', label: 'Abnormal' }];
export const flagLabel = (f) => (f === 'high' ? 'High' : f === 'low' ? 'Low' : f === 'abnormal' ? 'Abnormal' : '');
export const sourceLabel = (s) => ({ upload: 'Upload', manual: 'Manual', v2: 'Imported' }[s] || (s ? String(s)[0].toUpperCase() + String(s).slice(1) : 'Manual'));
export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // raw; base64 adds a third and the API caps requests at 32 MB

const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Stored key for a report name: the catalog key via normalizeMarkerName, else a stable slug of the name
 * (unmapped markers are shown plainly but still trend across panels), else null.
 */
export function keyForName(name) {
  return normalizeMarkerName(name) || slug(name) || null;
}
export const isCatalogKey = (k) => !!(k && MARKERS[k]);
export const catalogName = (k) => (isCatalogKey(k) ? MARKERS[k].name : null);

let rowSeq = 0;
/** Editable review row. `value` is text (keeps "<0.5", "Negative"); ranges are numbers. */
export function newRow(fields = {}) {
  return { rid: 'r' + (++rowSeq), name: '', value: '', unit: '', refLow: null, refHigh: null, flag: '', flagTouched: false, note: null, ...fields };
}
/** Flag implied by the value vs the printed range ('' when in range or unknown). */
export function autoFlag(row) {
  const n = parseNum(String(row.value ?? ''));
  return markerFlag({ value: n != null ? n : row.value, refLow: row.refLow, refHigh: row.refHigh, flag: '' }) || '';
}
/** Displayed flag of a stored marker: range-based (analytics markerFlag), else the report's own flag incl. 'abnormal'. */
export function flagOf(m) {
  if (!m) return null;
  const f = markerFlag(m);
  if (f) return f;
  return String(m.flag || '').trim().toLowerCase() === 'abnormal' ? 'abnormal' : null;
}
/** Out-of-range / abnormal markers of a panel: [{ key, name, flag }]. */
export function flaggedMarkers(panel) {
  return ((panel && panel.markers) || []).map((m) => ({ key: markerKey(m), name: m.name || m.key, flag: flagOf(m) })).filter((x) => x.flag);
}
/** Flag to store: the one picked by hand, else the automatic one. */
export const rowFlag = (row) => (row.flagTouched ? row.flag || null : autoFlag(row) || null);

const displayValue = (v) => (isNum(v) ? String(v) : v == null ? '' : String(v));
const withAuto = (row) => ({ ...row, flagTouched: !!row.flag && row.flag !== autoFlag(row) });

/** Review rows from an extractLabs() result (qualitative results keep the printed text). */
export function rowsFromExtraction(res) {
  return ((res && res.markers) || []).map((m) => withAuto(newRow({
    name: m.name || '', value: isNum(m.value) ? String(m.value) : m.valueText || '', unit: m.unit || '',
    refLow: isNum(m.refLow) ? m.refLow : null, refHigh: isNum(m.refHigh) ? m.refHigh : null,
    flag: m.flag || '', note: m.note || null,
  })));
}
/** Review rows from a stored panel (edit mode). */
export function rowsFromPanel(panel) {
  return ((panel && panel.markers) || []).map((m) => withAuto(newRow({
    name: m.name || catalogName(m.key) || m.key || '', value: displayValue(m.value), unit: m.unit || '',
    refLow: isNum(m.refLow) ? m.refLow : null, refHigh: isNum(m.refHigh) ? m.refHigh : null,
    flag: m.flag || '', note: m.note || null,
  })));
}

/** Stored marker for a review row; null for a blank row. Plain numbers are stored as numbers. */
export function rowToMarker(row) {
  const name = String(row.name || '').trim();
  const raw = String(row.value ?? '').trim();
  if (!name && !raw) return null;
  const num = parseNum(raw);
  return {
    key: keyForName(name), name: name || 'Unnamed result', value: num != null ? num : raw || null,
    unit: String(row.unit || '').trim() || null,
    refLow: isNum(row.refLow) ? row.refLow : null, refHigh: isNum(row.refHigh) ? row.refHigh : null,
    flag: rowFlag(row), note: row.note || null,
  };
}
/** → { markers, missing: [rid] } — rows with a name but no value (or a value but no name) are reported. */
export function reviewMarkers(rows) {
  const markers = []; const missing = [];
  for (const r of rows || []) {
    const name = String(r.name || '').trim(); const val = String(r.value ?? '').trim();
    if (!name && !val) continue;
    if (!name || !val) missing.push(r.rid);
    const m = rowToMarker(r); if (m) markers.push(m);
  }
  return { markers, missing };
}

/** Markers grouped by catalog category (report order within each group); unmapped ones under Other. */
export function groupMarkers(markers) {
  const groups = new Map(LAB_CATEGORIES.map(([id, label]) => [id, { id, label, markers: [] }]));
  for (const m of markers || []) {
    if (!m) continue;
    const key = markerKey(m);
    const cat = (isCatalogKey(key) && MARKERS[key].category) || 'other';
    (groups.get(cat) || groups.get('other')).markers.push({ ...m, key });
  }
  return [...groups.values()].filter((g) => g.markers.length);
}

/** Reference range text: "30–100", "≤ 150", "≥ 40", '' when none. */
export function refText(lo, hi) {
  const a = isNum(lo) ? fmtQty(lo) : null, b = isNum(hi) ? fmtQty(hi) : null;
  if (a != null && b != null) return `${a}–${b}`;
  if (b != null) return `≤ ${b}`;
  if (a != null) return `≥ ${a}`;
  return '';
}
/** Value text: number (≤ 3 decimals) or the reported text; '—' when missing. */
export function valueText(v) { return isNum(v) ? fmtQty(v) : v == null || v === '' ? '—' : String(v); }

/** Change vs the previous numeric result of the same marker, from markerSeries(): { prev, prevDate, delta, pct } | null */
export function changeVsPrevious(series, panelId) {
  const list = series || [];
  const i = list.findIndex((p) => p.panelId === panelId);
  if (i < 0 || !isNum(list[i].value)) return null;
  for (let j = i - 1; j >= 0; j--) {
    const p = list[j];
    if (!isNum(p.value)) continue;
    return { prev: p.value, prevDate: p.date, delta: r3(list[i].value - p.value), pct: p.value ? r1(((list[i].value - p.value) / Math.abs(p.value)) * 100) : null };
  }
  return null;
}

/** Upload file kind: 'pdf' | 'image' | null (type first, then extension). */
export function fileKind(file) {
  const t = String((file && file.type) || '').toLowerCase(); const n = String((file && file.name) || '').toLowerCase();
  if (t === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
  if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/.test(n)) return 'image';
  return null;
}

/** Protocol items as sent to interpretLabs: a neutralLabel hides both name and kind (same rule as contextPack). */
export function protocolsForAi(items) {
  return (items || []).filter(Boolean).map((p) => {
    const base = { amount: p.amount, unit: p.unit, schedule: p.schedule, active: p.active, startedAt: p.startedAt, endedAt: p.endedAt };
    return p.neutralLabel ? { name: p.neutralLabel, ...base } : { name: p.name, kind: p.kind, ...base };
  });
}

/** Pill tone for an interpretation status. */
export const statusTone = (s) => (s === 'normal' ? 'good' : s === 'borderline' ? 'warn' : s === 'high' || s === 'low' || s === 'abnormal' ? 'bad' : null);
