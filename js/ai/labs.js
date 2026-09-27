// FORGE AI layer: lab reports. extractLabs transcribes PDFs/photos verbatim via structured output;
// values, reference ranges and flags are parsed here in code (deterministic). interpretLabs gives an
// educational explanation; every out-of-range value is guaranteed to be surfaced for physician review.
import { callClaudeJson } from './claude.js';
import { AIError } from './errors.js';
import { LAB_EXTRACT_SCHEMA, LAB_INTERPRET_SCHEMA, LAB_STATUSES } from './schemas.js';
import { labsExtractSystemPrompt, labsInterpretSystemPrompt, clip, fmtN, textList } from './prompts.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILES = 20;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const toNum = (v) => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);

/* ------------------------------------------------------------ extraction */

/**
 * extractLabs(ai, { files:[{data (base64), mediaType}], note, model?, signal?, onProgress? })
 * → { collectedAt, lab, markers:[{ name, value, unit, refLow, refHigh, flag, note, valueText, rangeText, section }],
 *     notes, model, costUsd, costEstimated, usage }
 */
export async function extractLabs(ai, { files, note, model, signal, onProgress } = {}) {
  const blocks = fileBlocks(files);
  if (!blocks.length) throw new AIError('bad-request', 'Add a lab report (PDF or photo).');
  const n = blocks.length;
  const text = [
    `Extract every lab result from the attached report (${n} file${n > 1 ? 's' : ''}; they belong to the same report unless dates differ).`,
    note ? `User note: "${clip(note, 500)}"` : '',
    'Return only the JSON object.',
  ].filter(Boolean).join('\n');
  const { data, res } = await callClaudeJson(ai, {
    model: model || (ai && ai.model),
    system: labsExtractSystemPrompt(),
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text }] }],
    outputFormat: { type: 'json_schema', schema: LAB_EXTRACT_SCHEMA },
    thinking: { type: 'disabled' }, // transcription: faster, and every output token goes to the JSON
    maxTokens: 16000,
    signal, onProgress,
  });
  const markers = [];
  const seen = new Set();
  for (const raw of Array.isArray(data.markers) ? data.markers : []) {
    const m = normalizeExtractedMarker(raw);
    if (!m) continue;
    const id = `${m.name.toLowerCase()}|${m.valueText}|${m.unit.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    markers.push(m);
  }
  return {
    collectedAt: normalizeLabDate(data.collectedAt),
    lab: clip(data.lab, 120) || null,
    markers,
    notes: textList(data.notes, { max: 20, len: 300 }),
    model: res.model,
    costUsd: res.costUsd,
    costEstimated: res.costEstimated,
    usage: res.usage,
  };
}

function fileBlocks(files) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (list.length > MAX_FILES) throw new AIError('bad-request', `Too many files (max ${MAX_FILES}).`);
  const blocks = [];
  for (const f of list) {
    if (!f || typeof f.data !== 'string' || !f.data) continue;
    let data = f.data;
    let type = String(f.mediaType || f.media_type || '').toLowerCase();
    const m = /^data:([^;,]+);base64,/.exec(data);
    if (m) { type = type || m[1].toLowerCase(); data = data.slice(m[0].length); }
    if (type === 'image/jpg') type = 'image/jpeg';
    if (type === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    else if (IMAGE_TYPES.includes(type)) blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data } });
    else throw new AIError('bad-request', `Unsupported file type "${type || 'unknown'}". Use PDF, JPEG, PNG, GIF or WebP.`);
  }
  return blocks;
}

function normalizeExtractedMarker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clip(raw.name, 160);
  const valueText = clip(raw.valueText != null ? raw.valueText : raw.value, 80);
  if (!name || !valueText) return null;
  const unit = clip(raw.unit, 40);
  const rangeText = clip(raw.rangeText != null ? raw.rangeText : raw.range, 160);
  const v = parseLabValue(valueText);
  const r = parseRefRange(rangeText);
  const f = normalizeLabFlag(raw.flag);
  const flag = f.flag || computedFlag(v.value, v.comparator, r.low, r.high);
  const notes = [v.note, f.critical ? 'Marked critical on the report.' : ''].filter(Boolean);
  return {
    name, value: v.value, unit, refLow: r.low, refHigh: r.high, flag,
    note: notes.length ? notes.join(' ') : null,
    valueText, rangeText, section: clip(raw.section, 120) || null,
  };
}

/* ------------------------------------------------------- value parsing */

const NUM_RE = '[-+]?(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?|[.,]\\d+)';

function normalizeComparators(s) {
  return s
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(/\bless than or equal to\b/gi, '<=').replace(/\bgreater than or equal to\b/gi, '>=')
    .replace(/\bless than\b/gi, '<').replace(/\bgreater than\b/gi, '>')
    .replace(/<\s*(?:or\s*)?=\s*/gi, '<=').replace(/>\s*(?:or\s*)?=\s*/gi, '>=');
}
function toNumber(txt) {
  let t = String(txt).replace(/^\+/, '');
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) t = t.replace(/,/g, ''); // thousands separators
  else t = t.replace(',', '.'); // decimal comma
  const n = Number(t);
  return isFinite(n) ? n : null;
}

/**
 * Parse a printed lab result. "<0.5" → { value: 0.5, comparator: '<', note }, "1,234" → 1234,
 * "5.2 H" → 5.2, qualitative ("Negative", "1:80") → { value: null, note }.
 */
export function parseLabValue(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { value: null, comparator: null, note: null };
  const s = normalizeComparators(text.replace(/−/g, '-'));
  if (/^\d+\s*:\s*\d+/.test(s)) return { value: null, comparator: null, note: `Reported as "${text}" (ratio/titer).` };
  const m = new RegExp('^(<=|>=|<|>)?\\s*(' + NUM_RE + ')(?![\\d:])').exec(s);
  if (!m) return { value: null, comparator: null, note: `Reported as "${text}".` };
  const value = toNumber(m[2]);
  if (value == null) return { value: null, comparator: null, note: `Reported as "${text}".` };
  const comparator = m[1] || null;
  if (!comparator) return { value, comparator: null, note: null };
  const tail = { '<': 'actual value is lower', '<=': 'actual value is at or below this', '>': 'actual value is higher', '>=': 'actual value is at or above this' }[comparator];
  return { value, comparator, note: `Reported as "${text}"; stored as ${value} (${tail}).` };
}

/**
 * Parse a printed reference range into bounds (null when open or unknown).
 * "30-100" → {30, 100}; "<150" / "< OR = 150" / "150 or less" → {null, 150}; ">39" → {39, null};
 * "0.45–4.50" → {0.45, 4.5}; "Negative" → {null, null}.
 */
export function parseRefRange(raw) {
  const out = { low: null, high: null };
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return out;
  let s = normalizeComparators(text).replace(/[‐-―−]/g, '-');
  for (let i = 0; i < 3 && /(\d),(\d{3})(?!\d)/.test(s); i++) s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  if (/\d\s*:\s*\d/.test(s)) return out; // titers
  const N = '(-?\\d*\\.?\\d+)';
  const candidates = [];
  const find = (re, fn) => { const m = re.exec(s); if (m) candidates.push({ index: m.index, fn: () => fn(m) }); };
  find(new RegExp(N + '\\s*(?:-|to)\\s*' + N, 'i'), (m) => { out.low = Number(m[1]); out.high = Number(m[2]); });
  find(new RegExp('<=?\\s*' + N), (m) => { out.high = Number(m[1]); });
  find(new RegExp('>=?\\s*' + N), (m) => { out.low = Number(m[1]); });
  find(new RegExp('\\bup to\\s*' + N, 'i'), (m) => { out.high = Number(m[1]); });
  find(new RegExp(N + '\\s*(?:or less|or lower|or below|and below|and under|max(?:imum)?)\\b', 'i'), (m) => { out.high = Number(m[1]); });
  find(new RegExp(N + '\\s*(?:or more|or greater|or higher|or above|and above|and over|min(?:imum)?)\\b', 'i'), (m) => { out.low = Number(m[1]); });
  if (!candidates.length) return out;
  candidates.sort((a, b) => a.index - b.index); // earliest wins; ties keep the between-range (pushed first)
  candidates[0].fn();
  if (!isNum(out.low)) out.low = null;
  if (!isNum(out.high)) out.high = null;
  if (out.low != null && out.high != null && out.low > out.high) { const t = out.low; out.low = out.high; out.high = t; }
  return out;
}

/** Printed flag → { flag: 'high'|'low'|'abnormal'|null, critical }. */
export function normalizeLabFlag(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[()[\]]/g, '').trim();
  if (!s || /^(N|NL|NORMAL|WNL|NONE|NA|N\/A|-|OK)$/.test(s)) return { flag: null, critical: false };
  const critical = /CRIT|PANIC|^HH$|^LL$|\*\*|!/.test(s);
  if (/^(HH|H|HI|HIGH|CH|>)/.test(s) || /CRIT(ICAL)?\s*H/.test(s) || /\bHIGH\b/.test(s)) return { flag: 'high', critical };
  if (/^(LL|L|LO|LOW|CL|<)/.test(s) || /CRIT(ICAL)?\s*L/.test(s) || /\bLOW\b/.test(s)) return { flag: 'low', critical };
  return { flag: 'abnormal', critical };
}

function computedFlag(value, cmp, low, high) {
  if (!isNum(value)) return null; // qualitative results rely on the printed flag only
  if (cmp === '<') return isNum(low) && value <= low ? 'low' : null;
  if (cmp === '<=') return isNum(low) && value < low ? 'low' : null;
  if (cmp === '>') return isNum(high) && value >= high ? 'high' : null;
  if (cmp === '>=') return isNum(high) && value > high ? 'high' : null;
  if (isNum(high) && value > high) return 'high';
  if (isNum(low) && value < low) return 'low';
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Printed date → 'YYYY-MM-DD' or null. Accepts ISO, US M/D/Y(Y), "Sep 26, 2026", "26 Sep 2026". */
export function normalizeLabDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const mk = (y, mo, d) => {
    if (!(y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1)) return null;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > dim) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const month = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return mk(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(s))) {
    let y = +m[3];
    if (y < 100) y += y + 2000 <= new Date().getFullYear() + 1 ? 2000 : 1900;
    return mk(y, +m[1], +m[2]); // US order (month first)
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s))) return mk(+m[3], month(m[1]), +m[2]);
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s))) return mk(+m[3], month(m[2]), +m[1]);
  return null;
}

/** Out-of-range status of a stored marker ({value, refLow, refHigh, flag}) → 'high'|'low'|'abnormal'|null. */
export function markerOutOfRange(m) {
  if (!m || typeof m !== 'object') return null;
  const f = String(m.flag || '').trim().toLowerCase();
  if (f === 'high' || f === 'low' || f === 'abnormal') return f;
  if (f) { const p = normalizeLabFlag(f).flag; if (p) return p; }
  const v = toNum(m.value), lo = toNum(m.refLow), hi = toNum(m.refHigh);
  if (v == null) return null;
  if (hi != null && v > hi) return 'high';
  if (lo != null && v < lo) return 'low';
  return null;
}

/* -------------------------------------------------------- interpretation */

/**
 * interpretLabs(ai, { panel:{collectedAt, lab, markers[]}, history:[panel], protocols:[protocolItem], note?, model?, signal?, onProgress? })
 * → { summary, items:[{ key, name, status, text }], askDoctor:[string], model, costUsd, costEstimated, usage }
 */
export async function interpretLabs(ai, { panel, history = [], protocols = [], note, model, signal, onProgress } = {}) {
  const markers = (panel && Array.isArray(panel.markers) ? panel.markers : []).filter((m) => m && (m.name || m.key));
  if (!markers.length) throw new AIError('bad-request', 'This panel has no results to interpret.');
  const flagged = [];
  for (const m of markers) { const status = markerOutOfRange(m); if (status) flagged.push({ m, status }); }

  const L = [];
  L.push(`Panel: collected ${panel.collectedAt || panel.date || 'unknown date'}${panel.lab ? ' · ' + clip(panel.lab, 80) : ''}`);
  L.push('Results (name [key]: value unit | reference range | flag | note):');
  for (const m of markers) L.push(`- ${markerLabel(m)}: ${valueStr(m)} | ${rangeStr(m)} | ${m.flag || '—'}${m.note ? ' | ' + clip(m.note, 160) : ''}`);
  L.push('', flagged.length
    ? 'Outside the printed reference range (each must appear in items and in askDoctor): ' + flagged.map((f) => `${f.m.name || f.m.key} (${f.status})`).join(', ')
    : 'No value is outside its printed reference range.');
  const hist = historyLines(panel, markers, history);
  if (hist.length) L.push('', 'Earlier results (newest first):', ...hist);
  const prot = protocolLines(protocols);
  if (prot.length) L.push('', 'Protocol items (context only; never advise on them or their doses):', ...prot);
  if (note) L.push('', `User note: "${clip(note, 500)}"`);

  const { data, res } = await callClaudeJson(ai, {
    model: model || (ai && ai.model),
    system: labsInterpretSystemPrompt(),
    messages: [{ role: 'user', content: L.join('\n') }],
    outputFormat: { type: 'json_schema', schema: LAB_INTERPRET_SCHEMA },
    maxTokens: 12000,
    signal, onProgress,
  });

  const items = [];
  for (const it of Array.isArray(data.items) ? data.items : []) {
    if (!it || typeof it !== 'object') continue;
    const name = clip(it.name, 160), text = clip(it.text, 900);
    if (!name || !text) continue;
    const match = markers.find((m) => sameMarker(m, { key: it.key, name }));
    items.push({ key: clip(it.key, 60) || (match && match.key) || '', name, status: normStatus(it.status), text });
  }
  // Guarantee: every out-of-range value is present with its printed-range status.
  for (const { m, status } of flagged) {
    const hit = items.find((i) => sameMarker(m, i));
    if (hit) { if (hit.status !== status && hit.status !== 'abnormal') hit.status = status; continue; }
    items.unshift({
      key: m.key || '', name: m.name || m.key, status,
      text: `${valueStr(m)} is outside the lab's reference range (${rangeStr(m)}). Review it with your physician.`,
    });
  }
  const askDoctor = textList(data.askDoctor, { max: 12, len: 300 });
  const missing = flagged.filter(({ m }) => !askDoctor.some((q) => mentions(q, m)));
  if (missing.length) askDoctor.push(`Review the out-of-range results with your physician: ${missing.map(({ m, status }) => `${m.name || m.key} (${status})`).join(', ')}.`);
  return {
    summary: clip(data.summary, 1500),
    items, askDoctor,
    model: res.model, costUsd: res.costUsd, costEstimated: res.costEstimated, usage: res.usage,
  };
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Does free text name this marker? Whole-word match on its name, key, or name before a comma/parenthesis.
function mentions(textIn, m) {
  const hay = ` ${words(textIn)} `;
  const needles = [m.name, m.key && String(m.key).replace(/_/g, ' '), String(m.name || '').split(/[,(]/)[0]].map(words).filter((s) => s.length >= 2);
  return needles.some((n) => hay.includes(` ${n} `));
}
function sameMarker(a, b) {
  if (a.key && b.key) return String(a.key).toLowerCase() === String(b.key).toLowerCase();
  return !!normName(a.name) && normName(a.name) === normName(b.name);
}
function normStatus(s) {
  const v = String(s || '').trim().toLowerCase();
  return LAB_STATUSES.includes(v) ? v : 'unknown';
}
const markerLabel = (m) => `${clip(m.name || m.key, 120)}${m.key ? ` [${m.key}]` : ''}`;
function valueStr(m) {
  const v = toNum(m.value);
  const shown = v != null ? fmtN(v, 3) : clip(m.valueText, 40) || 'no value';
  return `${shown}${m.unit ? ' ' + m.unit : ''}`;
}
function rangeStr(m) {
  const lo = toNum(m.refLow), hi = toNum(m.refHigh);
  if (lo != null && hi != null) return `${fmtN(lo, 3)}–${fmtN(hi, 3)}`;
  if (hi != null) return `≤ ${fmtN(hi, 3)}`;
  if (lo != null) return `≥ ${fmtN(lo, 3)}`;
  return clip(m.rangeText, 60) || 'no range printed';
}

function historyLines(panel, markers, history) {
  const current = String((panel && (panel.collectedAt || panel.date)) || '').slice(0, 10);
  const panels = (Array.isArray(history) ? history : [])
    .filter((p) => p && p !== panel && Array.isArray(p.markers) && !(panel.id && p.id === panel.id))
    .map((p) => ({ date: String(p.collectedAt || p.date || '').slice(0, 10), markers: p.markers }))
    .filter((p) => p.date && p.date !== current)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const lines = [];
  for (const m of markers) {
    const prev = [];
    for (const p of panels) {
      const pm = p.markers.find((x) => x && sameMarker(m, x));
      const v = pm ? toNum(pm.value) : null;
      if (v != null) prev.push(`${p.date} ${fmtN(v, 3)}${pm.unit ? ' ' + pm.unit : ''}`);
      if (prev.length >= 4) break;
    }
    if (prev.length) lines.push(`- ${clip(m.name || m.key, 120)}: ${prev.join('; ')}`);
  }
  return lines.slice(0, 80);
}

function protocolLines(protocols) {
  return (Array.isArray(protocols) ? protocols : [])
    .filter((p) => p && (p.name || p.neutralLabel))
    .slice(0, 30)
    .map((p) => {
      const name = clip(p.name || p.neutralLabel, 80);
      const amount = p.amount != null && p.amount !== '' ? `${p.amount}${p.unit ? ' ' + p.unit : ''}` : '';
      const sched = p.schedule && p.schedule.type ? String(p.schedule.type) : '';
      const status = p.active === false
        ? `stopped${p.endedAt ? ' ' + String(p.endedAt).slice(0, 10) : ''}`
        : `active${p.startedAt ? ' since ' + String(p.startedAt).slice(0, 10) : ''}`;
      return `- ${name}${p.kind ? ` (${p.kind})` : ''}${amount ? ': ' + amount : ''}${sched ? ', ' + sched : ''}; ${status}`;
    });
}
