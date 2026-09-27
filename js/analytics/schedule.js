// Planning: plan vs actual, time allocation, calendar load, timing targets and a
// recovery-aware draft of the day that never overlaps calendar events.
import { addDays, dateRange, hmToMin, minToHm, isNum, round, fmtTime, fmtDur, dowName } from '../core/util.js';
import { buildDaily } from './daily.js';
import { readiness } from './readiness.js';
import { mean } from './stats.js';
import { mergeIntervals, dowOf } from './dataview.js';

export function planVsActual(dv, date) {
  const p = dv.planSummary(date);
  return {
    date,
    blocks: p.blocks.map((b) => ({ id: b.id, start: b.start, end: b.end, title: b.title, category: b.category, status: b.status, min: b.min, doneMin: p.doneMin == null ? null : b.doneMin })),
    plannedMin: p.plannedMin, doneMin: p.doneMin, adherence: p.adherence, byCategory: p.byCategory,
  };
}

// Planned and done minutes per category over [from, to] (done only counts dates ≤ today).
export function timeAllocation(dv, from, to) {
  const acc = new Map();
  for (const d of dateRange(from, to)) {
    for (const c of dv.planSummary(d).byCategory) {
      const cur = acc.get(c.category) || { category: c.category, plannedMin: 0, doneMin: null };
      cur.plannedMin += c.plannedMin;
      if (c.doneMin != null) cur.doneMin = (cur.doneMin || 0) + c.doneMin;
      acc.set(c.category, cur);
    }
  }
  return [...acc.values()].sort((a, b) => b.plannedMin - a.plannedMin);
}

// Meeting load (all values null when no calendar is connected). fragmentation = share of free
// 08:00–18:00 time in gaps shorter than 60 min; backToBack = meetings starting ≤ 5 min after the previous one.
export function calendarLoad(dv, date) {
  const l = dv.eventLoad(date);
  if (!l) return { date, connected: false, meetingMin: null, count: null, afterHoursMin: null, backToBack: null, longestFreeBlockMin: null, fragmentation: null, firstStart: null, lastEnd: null, events: [] };
  return {
    date, connected: true, meetingMin: l.meetingMin, count: l.count, afterHoursMin: l.afterHoursMin, backToBack: l.backToBack,
    longestFreeBlockMin: l.longestFreeBlockMin, fragmentation: l.fragmentation, firstStart: l.firstStart, lastEnd: l.lastEnd,
    events: l.events.map((e) => ({ id: e.id, title: e.title, start: minToHm(e.start), end: minToHm(e.end) })),
  };
}

// Wake, bedtime, caffeine and last-meal timing vs settings targets. Times are minutes after
// midnight (bedtime continuous past midnight); hit = actual at or before the target.
export function timingTargets(dv, from, to) {
  const rows = buildDaily(dv, from, to);
  const t = dv.setting('targets');
  const defs = [
    { key: 'wake', label: 'Wake', target: t.wake, field: 'wakeMin' },
    { key: 'bedtime', label: 'Bedtime', target: t.bedtime, field: 'bedtimeMin', evening: true },
    { key: 'caffeine', label: 'Caffeine cutoff', target: t.caffeineCutoff, field: 'caffeineLastMin' },
    { key: 'lastMeal', label: 'Last meal', target: t.lastMealBy, field: 'lastMealMin' },
  ];
  return defs.map((d) => {
    let target = hmToMin(d.target);
    if (target != null && d.evening && target < 720) target += 1440;
    const vals = rows.map((r) => r[d.field]).filter(isNum);
    const avg = mean(vals);
    return {
      key: d.key, label: d.label, target, targetHm: target == null ? null : minToHm(target),
      avgActual: avg == null ? null : Math.round(avg), avgHm: avg == null ? null : minToHm(avg),
      hitRate: target == null || !vals.length ? null : round((vals.filter((v) => v <= target).length / vals.length) * 100, 0),
      n: vals.length,
    };
  });
}

/* ---------------------------------------------------------------- suggestDay */
const toBlock = (b) => {
  const s = hmToMin(b.start); let e = hmToMin(b.end);
  if (s == null || e == null) return null;
  if (e <= s) e += 1440;
  return { start: s, end: Math.min(e, 1440), title: b.title || '', category: b.category || 'personal' };
};

// The most recently edited 'day' template with blocks.
function templateBase(dv) {
  const t = dv.templates('day').filter((x) => Array.isArray(x.blocks) && x.blocks.length)
    .sort((a, b) => (b._u || b._c || 0) - (a._u || a._c || 0))[0];
  if (!t) return null;
  const blocks = t.blocks.map(toBlock).filter(Boolean).map((b) => ({ ...b, reason: `From your “${t.name || 'day'}” template.` }));
  return blocks.length ? { kind: 'template', blocks } : null;
}

// Blocks that appear in at least half of the last 4 same-weekday plans (last 12 weeks).
function historyBase(dv, date) {
  const days = [];
  for (let k = 1; k <= 12 && days.length < 4; k++) { const bl = dv.plan(addDays(date, -7 * k)); if (bl.length) days.push(bl); }
  if (!days.length) return null;
  const counts = new Map();
  for (const bl of days) {
    const seen = new Set();
    for (const raw of bl) {
      const b = toBlock(raw); if (!b) continue;
      const key = `${b.start}|${b.end}|${b.title}|${b.category}`;
      if (seen.has(key)) continue; seen.add(key);
      const c = counts.get(key) || { ...b, n: 0 }; c.n++; counts.set(key, c);
    }
  }
  const need = Math.ceil(days.length / 2);
  const chosen = [];
  for (const c of [...counts.values()].filter((x) => x.n >= need).sort((a, b) => b.n - a.n || a.start - b.start)) {
    if (!chosen.some((x) => c.start < x.end && x.start < c.end)) chosen.push(c);
  }
  const day = dowName(dowOf(date));
  const blocks = chosen.map(({ n, ...b }) => ({ ...b, reason: `Usual ${day} block (${n} of the last ${days.length} ${day}s).` }));
  return blocks.length ? { kind: 'history', blocks } : null;
}

// Parts of [s, e] not covered by busy intervals.
function subtract(s, e, busy) {
  const out = []; let cur = s;
  for (const [a, b] of busy) {
    if (b <= cur || a >= e) continue;
    if (a > cur) out.push([cur, a]);
    cur = Math.max(cur, b);
    if (cur >= e) break;
  }
  if (cur < e) out.push([cur, e]);
  return out;
}

export function suggestDay(dv, date) {
  const r = readiness(dv, date);
  const events = dv.eventBlocks(date);
  const busy = mergeIntervals(events.map((e) => [e.start, e.end]));
  const notes = [];
  const base = templateBase(dv) || historyBase(dv, date);
  if (!base) notes.push('No day template or recent plan history — add a day template to get a draft.');
  let blocks = base ? base.blocks.map((b) => ({ ...b })) : [];

  if (r.training.mode === 'recover') {
    blocks = blocks.map((b) => (b.category !== 'training' ? b : {
      ...b, title: 'Zone 2 / mobility', category: 'recovery', end: b.start + Math.max(30, Math.min(40, b.end - b.start)),
      reason: `${r.band === 'red' ? 'Low recovery' : 'Recovery signals'} — easy zone 2 or mobility (30–40 min) instead of a hard session.`,
    }));
  }

  const kept = [];
  for (const b of blocks) {
    const hits = events.filter((e) => b.start < e.end && e.start < b.end);
    if (!hits.length) { kept.push(b); continue; }
    const names = hits.map((e) => e.title || 'a meeting').slice(0, 2).join(' and ');
    const pieces = subtract(b.start, b.end, busy);
    const best = pieces.reduce((a, p) => (!a || p[1] - p[0] > a[1] - a[0] ? p : a), null);
    const orig = b.end - b.start;
    if (best && best[1] - best[0] >= Math.max(Math.min(30, orig), orig * 0.5)) {
      kept.push({ ...b, start: best[0], end: best[1], reason: `${b.reason} Shortened around ${names}.` });
    } else notes.push(`Dropped “${b.title}” (${fmtTime(b.start)}) — it overlaps ${names}.`);
  }

  const f = r.focus;
  if (f && f.start) {
    const fs = hmToMin(f.start); let fe = hmToMin(f.end); if (fe <= fs) fe += 1440;
    const overlapping = kept.filter((b) => b.start < fe && fs < b.end);
    if (!overlapping.length && !busy.some(([a, b]) => a < fe && fs < b)) {
      kept.push({ start: fs, end: fe, title: 'Deep work', category: 'deep', reason: `Readiness focus window — ${f.note.replace(/\.$/, '')}.` });
    } else {
      const deep = overlapping.find((b) => b.category === 'deep');
      if (deep) deep.reason = `${deep.reason} Lines up with your focus window.`;
    }
  }

  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  if (r.status !== 'no-data') notes.unshift(r.summary);
  if (events.length) notes.push(`${events.length} calendar event${events.length > 1 ? 's' : ''} (${fmtDur(busy.reduce((s, [a, b]) => s + (b - a), 0))}).`);
  return {
    date, basis: base ? base.kind : null, mode: r.training.mode,
    blocks: kept.map((b) => ({ start: minToHm(b.start), end: minToHm(b.end), title: b.title, category: b.category, reason: b.reason })),
    notes,
  };
}
