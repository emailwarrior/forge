// Settings → Standards: pure logic (auto-source catalog, validation, normalization, ordering).
// No DOM, no store writes — safe in Node tests. See docs/ARCHITECTURE.md §5 (standards) and §8 (auto sources).
import { STANDARD_CATEGORIES } from '../../core/schema.js';

export const KINDS = [
  { value: 'check', label: 'Check', hint: 'Done or not done.' },
  { value: 'avoid', label: 'Avoid', hint: 'Done when it did not happen.' },
  { value: 'number', label: 'Number', hint: 'A count or amount against a target.' },
  { value: 'time', label: 'Time', hint: 'A clock time against a target, e.g. wake by 6:30 AM.' },
  { value: 'duration', label: 'Duration', hint: 'Minutes or hours against a target.' },
];
export const KIND_IDS = KINDS.map((k) => k.value);
const ALL_KINDS = KIND_IDS;
export const OPS = [
  { value: '>=', label: 'at least' },
  { value: '<=', label: 'at most' },
  { value: '=', label: 'exactly' },
];
export const TIME_OPS = [
  { value: '<=', label: 'at or before' },
  { value: '>=', label: 'at or after' },
];
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Auto sources (ARCHITECTURE §8). `param`: 'text' | 'stack' | 'item' (value after the colon).
 * `kinds`: standard kinds that make sense with the source (first = default).
 * `unit`: the unit the source reports (fixed for number/duration targets).
 * `sentinel`: settings value the target may reference with value 'target'.
 */
export const AUTO_SOURCES = [
  { id: '', label: 'None — logged by hand', short: 'Manual', group: 'Manual', kinds: ALL_KINDS },
  { id: 'whoop.wake', label: 'Wake time', short: 'WHOOP wake', group: 'WHOOP', kinds: ['time'], sentinel: { key: 'wake', label: 'wake target' } },
  { id: 'whoop.sleep', label: 'Hours asleep', short: 'WHOOP sleep', group: 'WHOOP', kinds: ['number', 'duration'], unit: 'h', sentinel: { key: 'sleepTargetH', label: 'sleep target' } },
  { id: 'plan.adherence', label: 'Plan adherence (% of planned minutes done)', short: 'Plan adherence', group: 'Plan', kinds: ['number'], unit: '%' },
  { id: 'day.deepWork', label: 'Deep work hours', short: 'Deep work log', group: 'Plan', kinds: ['number', 'duration'], unit: 'h', sentinel: { key: 'deepWorkTargetH', label: 'deep work target' } },
  { id: 'training.session', label: 'Training session or WHOOP workout', short: 'Session or workout', group: 'Training', kinds: ['check', 'avoid'] },
  { id: 'nutrition.meals', label: 'Meals logged (count)', short: 'Meals logged', group: 'Nutrition', kinds: ['number', 'check'] },
  { id: 'nutrition.protein', label: 'Protein eaten (g)', short: 'Protein eaten', group: 'Nutrition', kinds: ['number'], unit: 'g', sentinel: { key: 'proteinG', label: 'protein target' } },
  { id: 'nutrition.kcal', label: 'Calories eaten (kcal)', short: 'Calories eaten', group: 'Nutrition', kinds: ['number'], unit: 'kcal', sentinel: { key: 'kcal', label: 'calorie target' } },
  { id: 'nutrition.item', label: 'Food eaten (item name contains…)', group: 'Nutrition', kinds: ['check', 'avoid'], param: 'text' },
  { id: 'protocol.stack', label: 'Protocol stack fully logged', group: 'Protocols', kinds: ['check'], param: 'stack' },
  { id: 'protocol.item', label: 'Protocol item logged', group: 'Protocols', kinds: ['check'], param: 'item' },
  { id: 'day.caffeineCutoff', label: 'Last caffeine before the cutoff (day log)', short: 'Caffeine log', group: 'Day log', kinds: ['avoid', 'check'] },
];
const BY_ID = new Map(AUTO_SOURCES.map((s) => [s.id, s]));

/** 'nutrition.item:chicken' → { id: 'nutrition.item', arg: 'chicken', def }; unknown ids keep def null. */
export function parseAutoSource(auto) {
  const s = typeof auto === 'string' ? auto.trim() : '';
  if (!s) return { id: '', arg: '', def: BY_ID.get('') };
  const i = s.indexOf(':');
  const id = i < 0 ? s : s.slice(0, i);
  const arg = i < 0 ? '' : s.slice(i + 1);
  return { id, arg, def: BY_ID.get(id) || null };
}
/** Inverse of parseAutoSource: '' for none; 'id:arg' for parameterized sources. */
export function buildAutoSource(id, arg = '') {
  if (!id) return '';
  const def = BY_ID.get(id);
  if (def && def.param) return `${id}:${String(arg ?? '').trim()}`;
  return id;
}
export const sourceDef = (id) => BY_ID.get(id || '') || null;
export const supportsSentinel = (auto) => !!(parseAutoSource(auto).def || {}).sentinel;
export const kindsFor = (auto) => { const d = parseAutoSource(auto).def; return d ? d.kinds : ALL_KINDS; };
export const needsTarget = (kind) => kind === 'number' || kind === 'time' || kind === 'duration';

/** Human label for an auto source, e.g. 'Food eaten: chicken', 'Stack logged: AM' ({ short } for list rows). */
export function sourceLabel(auto, { items = [], short = false } = {}) {
  const { id, arg, def } = parseAutoSource(auto);
  if (!id) return 'Manual';
  if (!def) return auto;
  if (id === 'nutrition.item') return `Food eaten: ${arg || '…'}`;
  if (id === 'protocol.stack') return `Stack logged: ${arg || '…'}`;
  if (id === 'protocol.item') {
    const it = items.find((x) => x && x.id === arg);
    return `Item logged: ${it ? it.name : arg ? 'removed item' : '…'}`;
  }
  return short && def.short ? def.short : def.label;
}

/** Days summary: 'Every day', 'Weekdays', 'Weekends', 'Mon–Sat', 'Mon, Wed, Fri', 'Never'. */
export function daysLabel(days) {
  if (!Array.isArray(days)) return 'Every day';
  const d = [...new Set(days.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b);
  if (!d.length) return 'Never';
  if (d.length === 7) return 'Every day';
  const key = d.join('');
  if (key === '01234') return 'Weekdays';
  if (key === '56') return 'Weekends';
  const contiguous = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  if (contiguous && d.length >= 3) return `${DAY_LABELS[d[0]]}–${DAY_LABELS[d[d.length - 1]]}`;
  return d.map((x) => DAY_LABELS[x]).join(', ');
}

const isHm = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Default fields for a new standard (effectiveFrom = today so past days are not re-scored). */
export function newStandard({ today, order = 1, category } = {}) {
  return {
    name: '', category: category || STANDARD_CATEGORIES[0], kind: 'check', target: null, weight: 2, required: false,
    days: [...ALL_DAYS], active: true, effectiveFrom: today, order, auto: '',
  };
}

/**
 * Editable draft from a stored record: every field present and typed; unknown data kept
 * (e.g. a v2 category outside STANDARD_CATEGORIES) so the editor never silently changes it.
 */
export function draftFrom(rec) {
  const r = rec || {};
  const kind = KIND_IDS.includes(r.kind) ? r.kind : 'check';
  const t = r.target && typeof r.target === 'object' ? r.target : null;
  return {
    id: r.id, name: typeof r.name === 'string' ? r.name : '', category: r.category || STANDARD_CATEGORIES[0], kind,
    target: t ? { op: t.op || (kind === 'time' ? '<=' : '>='), value: t.value ?? null, unit: t.unit ?? null } : null,
    weight: isNum(r.weight) ? r.weight : 2, required: !!r.required, days: Array.isArray(r.days) ? [...r.days] : [...ALL_DAYS],
    active: r.active !== false, effectiveFrom: typeof r.effectiveFrom === 'string' ? r.effectiveFrom : '1970-01-01',
    order: isNum(r.order) ? r.order : null, auto: typeof r.auto === 'string' ? r.auto : '',
  };
}

/**
 * Apply a change and keep the draft coherent: switching the source picks a compatible kind and
 * unit; switching kind resets an incompatible target. Returns a new draft.
 */
export function applyChange(draft, patch) {
  const d = { ...draft, ...patch };
  const srcChanged = 'auto' in patch && parseAutoSource(patch.auto).id !== parseAutoSource(draft.auto).id;
  if (srcChanged) {
    const { def } = parseAutoSource(d.auto);
    const kinds = def ? def.kinds : ALL_KINDS;
    if (!kinds.includes(d.kind)) d.kind = kinds[0];
  }
  if (srcChanged || ('kind' in patch && patch.kind !== draft.kind)) d.target = targetFor(d, d.kind !== draft.kind);
  return d;
}

// A target that fits the draft's kind and source (keeps a compatible existing one).
function targetFor(d, kindChanged = false) {
  if (!needsTarget(d.kind)) return null;
  const { def } = parseAutoSource(d.auto);
  const prev = d.target || {};
  const cur = kindChanged ? { value: prev.value, unit: prev.unit } : prev; // a new kind starts from its default comparison
  if (d.kind === 'time') {
    const op = cur.op === '>=' ? '>=' : '<=';
    const value = isHm(cur.value) || (cur.value === 'target' && def && def.sentinel) ? cur.value : (def && def.sentinel ? 'target' : null);
    return { op, value, unit: null };
  }
  const keepValue = isNum(cur.value) || (cur.value === 'target' && def && def.sentinel);
  const value = keepValue ? cur.value : def && def.sentinel ? 'target' : null;
  return { op: ['>=', '<=', '='].includes(cur.op) ? cur.op : '>=', value, unit: unitFor(d.kind, def, value, cur.unit) };
}

// Target unit: a number target uses the source's unit; a duration is minutes or hours (the
// engine converts), except a settings target, which is in the source's unit.
function unitFor(kind, def, value, curUnit) {
  if (kind === 'time' || kind === 'check' || kind === 'avoid') return null;
  if (def && def.unit && (kind === 'number' || value === 'target')) return def.unit;
  if (kind === 'duration') return curUnit === 'h' || curUnit === 'min' ? curUnit : def && def.unit === 'h' ? 'h' : 'min';
  return typeof curUnit === 'string' && curUnit.trim() ? curUnit.trim() : null;
}

/** Set the target value (number, 'HH:MM' or 'target'), keeping the unit coherent. */
export function withTargetValue(d, value) {
  const def = parseAutoSource(d.auto).def;
  const cur = d.target || { op: d.kind === 'time' ? '<=' : '>=' };
  return { ...d, target: { ...cur, value, unit: unitFor(d.kind, def, value, cur.unit) } };
}

/**
 * Validate a draft → { ok, errors: {field: message}, warnings: [message] }.
 * Fields: name, category, kind, target, auto, days, weight, effectiveFrom.
 */
export function validateStandard(d, { categories = STANDARD_CATEGORIES, protocolItems = null } = {}) {
  const errors = {}; const warnings = [];
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  if (!name) errors.name = 'Give the standard a name.';
  else if (name.length > 80) errors.name = 'Keep the name under 80 characters.';
  if (!d.category || (typeof d.category !== 'string')) errors.category = 'Pick a category.';
  else if (!categories.includes(d.category)) warnings.push(`Category “${d.category}” is not one of the standard categories.`);
  if (!KIND_IDS.includes(d.kind)) errors.kind = 'Pick a kind.';
  const { id: srcId, arg, def } = parseAutoSource(d.auto);
  if (srcId && !def) errors.auto = 'Unknown auto source.';
  else if (def) {
    if (!def.kinds.includes(d.kind)) errors.kind = `“${def.label}” works with: ${def.kinds.join(', ')}.`;
    if (def.param === 'text' && !arg.trim()) errors.auto = 'Enter the food text to look for.';
    if (def.param === 'stack' && !arg.trim()) errors.auto = 'Pick a stack.';
    if (def.param === 'item') {
      if (!arg) errors.auto = 'Pick a protocol item.';
      else if (Array.isArray(protocolItems) && !protocolItems.some((x) => x && x.id === arg)) errors.auto = 'That protocol item no longer exists.';
    }
  }
  if (needsTarget(d.kind)) {
    const t = d.target;
    if (!t) errors.target = 'Set a target.';
    else if (t.value === 'target') {
      if (!(def && def.sentinel)) errors.target = 'Only sources with a settings target can use it.';
    } else if (d.kind === 'time') {
      if (!isHm(t.value)) errors.target = 'Enter a time.';
      else if (!['<=', '>='].includes(t.op)) errors.target = 'Pick “at or before” or “at or after”.';
    } else {
      if (!isNum(t.value)) errors.target = 'Enter a number.';
      else if (t.value < 0) errors.target = 'The target cannot be negative.';
      if (!['>=', '<=', '='].includes(t.op)) errors.target = 'Pick a comparison.';
      if (d.kind === 'duration' && !['min', 'h'].includes(t.unit)) errors.target = 'Pick minutes or hours.';
      const unit = def && def.unit && d.kind === 'number' ? def.unit : t.unit;
      if (unit === '%' && isNum(t.value) && t.value > 100 && t.op !== '<=') warnings.push('A percentage above 100% can never be reached.');
    }
    if (t && d.kind === 'time' && t.value === 'target' && !['<=', '>='].includes(t.op)) errors.target = 'Pick “at or before” or “at or after”.';
  }
  const days = Array.isArray(d.days) ? d.days : null;
  if (!days || days.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) errors.days = 'Pick the days it applies.';
  else if (!days.length) warnings.push('No days selected: the standard never applies.');
  if (!Number.isInteger(d.weight) || d.weight < 1 || d.weight > 3) errors.weight = 'Weight is 1, 2 or 3.';
  if (typeof d.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.effectiveFrom)) errors.effectiveFrom = 'Pick a start date.';
  if (d.required && d.active === false) warnings.push('Inactive standards are ignored, even when required.');
  return { ok: Object.keys(errors).length === 0, errors, warnings };
}

/** Record fields to store for a valid draft (trimmed; target null for check/avoid). */
export function toRecord(d) {
  const kind = d.kind;
  const { id: srcId, def } = parseAutoSource(d.auto);
  let target = null;
  if (needsTarget(kind) && d.target) {
    const t = d.target;
    target = { op: t.op, value: t.value };
    const unit = unitFor(kind, def, t.value, t.unit);
    if (unit) target.unit = unit;
  }
  return {
    name: d.name.trim(), category: d.category, kind, target, weight: d.weight, required: !!d.required,
    days: [...new Set(d.days)].sort((a, b) => a - b), active: d.active !== false, effectiveFrom: d.effectiveFrom,
    order: d.order, auto: srcId ? buildAutoSource(srcId, parseAutoSource(d.auto).arg) : '',
  };
}

/** Changed fields between a stored record and new fields (so a save writes only what changed). */
export function changedFields(rec, fields) {
  const norm = (v) => JSON.stringify(v === undefined || v === '' ? null : v);
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (norm(rec ? rec[k] : undefined) !== norm(v)) out[k] = v;
  return out;
}

/** Sorted by `order` (missing last), then name — the order Today shows. */
export function sortStandards(list) {
  return [...(list || [])].sort((a, b) => ((a.order ?? 1e9) - (b.order ?? 1e9)) || String(a.name || '').localeCompare(String(b.name || '')));
}

/**
 * Move `id` one step up (dir −1) or down (+1) within `list` (already in display order) and
 * renumber 1..n. Returns [{id, order}] for records whose order changed (empty when at an edge).
 */
export function reorder(list, id, dir) {
  const arr = [...list];
  const i = arr.findIndex((s) => s.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return [];
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return arr.map((s, k) => ({ id: s.id, order: k + 1, prev: s.order })).filter((x) => x.order !== x.prev).map(({ id: sid, order }) => ({ id: sid, order }));
}

/** Next order value for a new standard. */
export function nextOrder(list) {
  let m = 0; for (const s of list || []) if (isNum(s.order) && s.order > m) m = s.order;
  return m + 1;
}

/** Stack names used by protocol items (for protocol.stack:<stack>), sorted, case-insensitively unique. */
export function stacksOf(items) {
  const seen = new Map();
  for (const it of items || []) {
    const s = it && it.schedule && typeof it.schedule.stack === 'string' ? it.schedule.stack.trim() : '';
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Short target text: '≥ 90%', '≤ 6:30 AM target', '≥ 30 min', '≥ protein target'. */
export function targetText(d, fmtTime = (hm) => hm) {
  const t = d && d.target; if (!t || !needsTarget(d.kind)) return '';
  const def = parseAutoSource(d.auto).def;
  const op = t.op === '<=' ? (d.kind === 'time' ? 'by' : '≤') : t.op === '=' ? '=' : (d.kind === 'time' ? 'after' : '≥');
  if (t.value === 'target') return `${op} ${def && def.sentinel ? def.sentinel.label : 'target'}`;
  if (d.kind === 'time') return isHm(t.value) ? `${op} ${fmtTime(t.value)}` : '';
  if (!isNum(t.value)) return '';
  const unit = unitFor(d.kind, def, t.value, t.unit);
  const u = !unit ? '' : unit === '%' ? '%' : ` ${unit}`;
  return `${op} ${t.value}${u}`;
}
