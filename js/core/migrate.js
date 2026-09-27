// v2 (single forge-data.json) -> v3 records. Deterministic ids: re-running is idempotent,
// and migrated records carry the v2 save time so any later v3 edit wins the merge.
import { shardPath, periodOf } from './schema.js';
import { hashId, ymd, isoWithOffset } from './util.js';

const FALLBACK_TIME = Date.UTC(2026, 0, 1);

const CONVERSIONS = [
  { re: /wake\s*up/i, apply: (s, name) => { const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(name); let hm = '06:30'; if (m) { let h = Number(m[1]); if (m[3] && m[3].toLowerCase() === 'pm' && h < 12) h += 12; hm = String(h).padStart(2, '0') + ':' + m[2]; } return { ...s, kind: 'time', target: { op: '<=', value: hm }, auto: 'whoop.wake' }; } },
  { re: /(\d+)\s*%\s*daily\s*productivity/i, apply: (s, name) => ({ ...s, kind: 'number', target: { op: '>=', value: Number(/(\d+)\s*%/.exec(name)[1]), unit: '%' }, auto: 'plan.adherence' }) },
  { re: /^\s*gym\s*$/i, apply: (s) => ({ ...s, auto: 'training.session' }) },
  { re: /(\d+)\s*meals/i, apply: (s, name) => ({ ...s, kind: 'number', target: { op: '>=', value: Number(/(\d+)\s*meals/i.exec(name)[1]) }, auto: 'nutrition.meals' }) },
  { re: /protein\s*shake/i, apply: (s) => ({ ...s, auto: 'nutrition.item:shake' }) },
  { re: /vitamins?/i, apply: (s) => ({ ...s, auto: 'protocol.stack:AM' }) },
  { re: /read\s*(\d+)\s*min/i, apply: (s, name) => ({ ...s, kind: 'duration', target: { op: '>=', value: Number(/read\s*(\d+)/i.exec(name)[1]), unit: 'min' } }) },
  { re: /no\s*caffeine\s*after/i, apply: (s) => ({ ...s, kind: 'avoid', auto: 'day.caffeineCutoff' }) },
];

function rec(id, fields, t) {
  const r = { id, _c: t, _u: t };
  for (const k of Object.keys(fields)) if (fields[k] !== undefined) r[k] = fields[k];
  return r;
}

function financeCategory(name, type) {
  const n = String(name || '').toLowerCase();
  if (type === 'liability' || /loan|debt|credit card|mortgage/.test(n)) return 'debt';
  if (/btc|bitcoin|eth|crypto|sol\b/.test(n)) return 'crypto';
  if (/stock|brokerage|robinhood|fidelity|schwab|etf|401k|ira|roth|invest/.test(n)) return 'investments';
  if (/cash|checking|savings|bank/.test(n)) return 'cash';
  if (/car|truck|vehicle/.test(n)) return 'vehicle';
  if (/house|home|property|real estate/.test(n)) return 'real-estate';
  return 'other';
}

export function isV2Data(obj) {
  return !!(obj && typeof obj === 'object' && Array.isArray(obj.tasks) && obj.log && typeof obj.log === 'object');
}

// Build v3 shard payloads from v2 data: returns { shards: Map(path -> {r}), summary }.
export function buildV2Migration(v2, { tz } = {}) {
  if (!isV2Data(v2)) throw new Error('Not FORGE v2 data');
  const t = Number(v2.updatedAt) || FALLBACK_TIME;
  const shards = new Map();
  const add = (coll, r) => {
    const path = shardPath(coll, 'app', periodOf(coll, r));
    if (!shards.has(path)) shards.set(path, { r: {} });
    shards.get(path).r[r.id] = r;
  };
  const summary = { standards: 0, checks: 0, snapshots: 0, savedQuotes: 0, journal: 0, skipped: [] };

  const keep = new Set();
  v2.tasks.forEach((task, i) => {
    let s = {
      name: task.name, category: task.cat || 'Discipline', kind: task.type === 'avoid' ? 'avoid' : 'check',
      weight: Number(task.w) || 1, required: !!task.req, days: Array.isArray(task.days) ? task.days : [0, 1, 2, 3, 4, 5, 6],
      active: task.active !== false, effectiveFrom: task.effectiveFrom || '1970-01-01', order: i + 1, legacyId: task.id,
    };
    const conv = CONVERSIONS.find((c) => c.re.test(task.name || ''));
    if (conv) s = conv.apply(s, task.name || '');
    add('standards', rec('v2-' + task.id, s, t));
    keep.add(task.id); summary.standards++;
  });

  for (const [date, entries] of Object.entries(v2.log || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !entries) continue;
    for (const [taskId, val] of Object.entries(entries)) {
      if (!val || !keep.has(taskId)) continue;
      add('checks', rec(`${date}:v2-${taskId}`, { date, standardId: 'v2-' + taskId, value: true, source: 'manual' }, t));
      summary.checks++;
    }
  }

  for (const snap of v2.snapshots || []) {
    if (!snap || !/^\d{4}-\d{2}$/.test(snap.month || '')) continue;
    const items = (snap.items || []).map((it) => ({ name: it.name, type: it.type === 'liability' ? 'liability' : 'asset', value: Number(it.value) || 0, category: financeCategory(it.name, it.type) }));
    add('snapshots', rec(snap.month, { month: snap.month, gross: Number(snap.gross) || 0, items }, t));
    summary.snapshots++;
  }

  if (v2.settings) {
    const f = {};
    for (const k of ['mult', 'stake', 'expense']) if (v2.settings[k] != null && isFinite(v2.settings[k])) f[k] = Number(v2.settings[k]);
    if (Object.keys(f).length) add('settings', rec('finance', f, t));
  }

  for (const q of v2.saved || []) {
    if (!q || !q.text) continue;
    add('savedQuotes', rec(hashId(q.text + '|' + (q.who || '')), { text: q.text, who: q.who || '', savedAt: Number(q.ts) || t }, t));
    summary.savedQuotes++;
  }

  for (const n of v2.notes || []) {
    if (!n || !n.text) continue;
    const ts = Number(n.ts) || t;
    add('journal', rec('v2-' + (n.id || hashId(n.text + ts)), { date: ymd(new Date(ts)), at: isoWithOffset(ts, tz), text: n.text, tags: ['v2'] }, ts));
    summary.journal++;
  }

  return { shards, summary, v2UpdatedAt: t };
}

// Apply a migration to a store (owner 'app'); shards are marked dirty so they get pushed.
export function applyMigration(store, migration) {
  for (const [path, shard] of migration.shards) store.loadShard(path, shard, { source: 'migration', dirty: true });
  migration.summary.retiredSeeds = retireDuplicateSeeds(store);
  return migration.summary;
}

// After a v2 import, seeded standards (ids 'std-…') that duplicate an imported one — same auto
// source, or same leading word for manual standards ("Read" vs "Read 30 min") — are deactivated
// (not deleted; they can be re-enabled in Settings → Standards). Returns the retired names.
export function retireDuplicateSeeds(store) {
  const all = store.all('standards');
  const lead = (s) => String(s.name || '').toLowerCase().match(/[a-z]+/)?.[0] || '';
  const imported = all.filter((s) => String(s.id).startsWith('v2-') && s.active !== false);
  const autos = new Set(imported.map((s) => s.auto).filter(Boolean));
  const words = new Set(imported.filter((s) => !s.auto).map(lead).filter((w) => w.length > 2));
  const retired = [];
  for (const s of all) {
    if (!String(s.id).startsWith('std-') || s.active === false) continue;
    if ((s.auto && autos.has(s.auto)) || (!s.auto && words.has(lead(s)))) { store.update('standards', s.id, { active: false }); retired.push(s.name); }
  }
  return retired;
}
