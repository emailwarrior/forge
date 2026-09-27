// Finance UI logic (pure): categories, month helpers, snapshot drafts/payloads, equity formula text,
// table rows. Net worth math itself comes from js/analytics/finance.js (never re-implemented here).
// Tests: tests/ui/records-finance.test.mjs.
import { isNum, fmtMoney, pad2 } from '../../core/util.js';
import { equityFor } from '../../analytics/finance.js';
import { fmtQty } from './records-util.js';

export const CATEGORIES = [
  { id: 'cash', label: 'Cash' }, { id: 'investments', label: 'Investments' }, { id: 'retirement', label: 'Retirement' },
  { id: 'real-estate', label: 'Real estate' }, { id: 'vehicle', label: 'Vehicle' }, { id: 'business', label: 'Business' },
  { id: 'crypto', label: 'Crypto' }, { id: 'debt', label: 'Debt' }, { id: 'other', label: 'Other' },
];
export function categoryLabel(id) {
  const c = CATEGORIES.find((x) => x.id === id);
  if (c) return c.label;
  const s = String(id || 'other').replace(/[-_]+/g, ' ');
  return s[0].toUpperCase() + s.slice(1);
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const isMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
/** '2026-09' → "Sep 2026" (short: "Sep ’26"). */
export function monthLabel(month, { short = false } = {}) {
  if (!isMonth(month)) return String(month ?? '—');
  const [y, m] = month.split('-').map(Number);
  return short ? `${MON[m - 1]} ’${String(y).slice(2)}` : `${MON[m - 1]} ${y}`;
}
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}
/** Selectable months, newest first: the current month back `count − 1` months. */
export function monthOptions(today, count = 36) {
  const cur = today.slice(0, 7);
  return Array.from({ length: count }, (_, i) => addMonths(cur, -i));
}

/** Latest snapshot strictly before `month` (snapshots in any order). */
export function previousSnapshot(snapshots, month) {
  let best = null;
  for (const s of snapshots || []) if (s && isMonth(s.month) && s.month < month && (!best || s.month > best.month)) best = s;
  return best;
}

/** Category guess from an item name (used until the category is picked by hand). */
export function guessCategory(name, type) {
  const n = String(name || '').toLowerCase();
  if (type === 'liability' || /loan|debt|credit card|mortgage|\bheloc\b/.test(n)) return 'debt';
  if (/401 ?k|\bira\b|roth|pension|retire|\btsp\b|403 ?b/.test(n)) return 'retirement';
  if (/btc|bitcoin|\beth\b|ethereum|crypto|coinbase|\bsol\b|ledger/.test(n)) return 'crypto';
  if (/stock|brokerage|robinhood|fidelity|schwab|vanguard|\betf\b|invest|index fund|treasur/.test(n)) return 'investments';
  if (/cash|checking|savings|bank|money market|\bhysa\b/.test(n)) return 'cash';
  if (/\bcar\b|truck|vehicle|motorcycle|\bboat\b/.test(n)) return 'vehicle';
  if (/house|home|property|real estate|condo|rental|\bland\b/.test(n)) return 'real-estate';
  if (/business|company|\bllc\b|equity in|shares in|inventory|receivable/.test(n)) return 'business';
  return 'other';
}

/** Copy of snapshot items for a new month (values carried over, ready to update). */
export function copyItems(items) {
  return (items || []).filter(Boolean).map((it) => ({
    name: String(it.name || ''), type: it.type === 'liability' ? 'liability' : 'asset',
    value: isNum(Number(it.value)) && it.value !== '' && it.value != null ? Number(it.value) : null,
    category: it.category || guessCategory(it.name, it.type),
  }));
}
/** Items for storage: drops empty rows, coerces values, defaults type/category. */
export function cleanItems(items) {
  return (items || []).filter((it) => it && (String(it.name || '').trim() || isNum(it.value))).map((it) => {
    const type = it.type === 'liability' ? 'liability' : 'asset';
    const name = String(it.name || '').trim() || (type === 'liability' ? 'Liability' : 'Asset');
    return { name, type, value: isNum(it.value) ? Math.abs(it.value) : 0, category: it.category || guessCategory(name, type) };
  });
}

export function emptySnapshot(month) { return { month, gross: null, items: [], note: '' }; }
export function draftFromSnapshot(s) {
  return { month: s.month, gross: isNum(Number(s.gross)) && s.gross != null && s.gross !== '' ? Number(s.gross) : null, items: copyItems(s.items), note: s.note || '' };
}
export function snapshotPayload(d) {
  return { month: d.month, gross: isNum(d.gross) ? d.gross : null, items: cleanItems(d.items), note: String(d.note || '').trim() || null };
}

/**
 * The equity model spelled out with the numbers plugged in:
 * "($27,500 − $5,000) × 12 × 10 × 20% = $540,000". equity null when gross is unknown.
 */
export function equityFormula(gross, finance = {}) {
  const expense = isNum(Number(finance.expense)) ? Number(finance.expense) : 0;
  const mult = isNum(Number(finance.mult)) ? Number(finance.mult) : 0;
  const stake = isNum(Number(finance.stake)) ? Number(finance.stake) : 0;
  const equity = equityFor(gross, finance);
  const g = isNum(gross) ? fmtMoney(gross) : 'gross';
  const text = `(${g} − ${fmtMoney(expense)}) × 12 × ${fmtQty(mult)} × ${fmtQty(stake)}%`;
  return { gross: isNum(gross) ? gross : null, expense, mult, stake, equity, text, result: isNum(equity) ? fmtMoney(equity) : null };
}

/** Category breakdown from netWorth().byCategory → [{ id, label, value }] by size (liabilities negative). */
export function categoryRows(byCategory) {
  return Object.entries(byCategory || {}).filter(([, v]) => isNum(v) && v !== 0)
    .map(([id, value]) => ({ id, label: categoryLabel(id), value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/** Table rows (newest first) from netWorthSeries() + snapshots: adds gross and the change vs the previous month. */
export function snapshotRows(series, snapshots) {
  const gross = new Map((snapshots || []).map((s) => [s.month, isNum(Number(s.gross)) && s.gross != null ? Number(s.gross) : null]));
  const rows = (series || []).map((r, i, a) => ({
    ...r, gross: gross.get(r.month) ?? null,
    delta: i > 0 && isNum(r.total) && isNum(a[i - 1].total) ? Math.round((r.total - a[i - 1].total) * 100) / 100 : null,
  }));
  return rows.reverse();
}
