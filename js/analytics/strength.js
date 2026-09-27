// Strength and cardio analytics over logged sessions.
// Working ("hard") sets = kind 'work' (or missing, or 'working'), 'drop' or 'failure', and done !== false;
// warm-ups never count. Weeks start Monday.
import { addDays, diffDays, weekStart, isNum, round } from '../core/util.js';
import { linreg, mean } from './stats.js';

// Epley estimated 1RM for 1–12 reps (a single is the weight itself); null otherwise.
export function e1rm(w, reps) {
  if (!isNum(w) || w <= 0 || !isNum(reps) || reps < 1 || reps > 12) return null;
  return reps === 1 ? w : round(w * (1 + reps / 30), 1);
}

const WORK_KINDS = new Set(['work', 'working', 'drop', 'failure']);
export const isWorkingSet = (s) => !!s && (s.kind == null || WORK_KINDS.has(s.kind)) && s.done !== false;
const setsOf = (entry) => (Array.isArray(entry && entry.sets) ? entry.sets : []);

// Per session: working sets of the exercise across all of its entries.
function sessionPerf(session, exerciseId) {
  const sets = [];
  for (const e of session.entries || []) if (e && e.exerciseId === exerciseId) for (const s of setsOf(e)) if (isWorkingSet(s)) sets.push(s);
  if (!sets.length) return null;
  let best = null, bestE = null, topW = null, volume = 0, maxReps = null;
  for (const s of sets) {
    const w = isNum(s.w) ? s.w : 0, reps = isNum(s.reps) ? s.reps : 0;
    volume += w * reps;
    if (topW == null || w > topW) topW = w;
    if (maxReps == null || reps > maxReps) maxReps = reps;
    const e = e1rm(w, reps);
    if (e != null && (bestE == null || e > bestE)) { bestE = e; best = { w, reps }; }
  }
  if (!best) { const s = sets.reduce((a, b) => ((b.reps || 0) > (a.reps || 0) ? b : a)); best = { w: isNum(s.w) ? s.w : 0, reps: s.reps ?? null }; }
  return { bestSet: best, e1rm: bestE, volume: round(volume, 1), sets: sets.length, topW, maxReps };
}

// Epley estimate from high-rep working sets (13–30 reps). Only used for trends of sessions with no
// 1–12-rep working set (e.g. lateral raises, calves); PRs stay on the 1–12-rep definition.
function highRepE1rm(session, exerciseId) {
  let best = null;
  for (const e of session.entries || []) if (e && e.exerciseId === exerciseId) for (const s of setsOf(e)) {
    if (!isWorkingSet(s) || !isNum(s.w) || s.w <= 0 || !isNum(s.reps) || s.reps <= 12 || s.reps > 30) continue;
    const v = round(s.w * (1 + s.reps / 30), 1); if (best == null || v > best) best = v;
  }
  return best;
}

// Chronological per-session history of one exercise. `e1rmBasis: 'high-rep'` marks an estimate
// from 13–30-rep sets (the session had no 1–12-rep working set).
export function exerciseHistory(dv, exerciseId) {
  return dv.memo('str:hist:' + exerciseId, () => {
    const out = [];
    for (const s of dv.allSessions()) {
      const p = sessionPerf(s, exerciseId);
      if (!p) continue;
      const row = { date: s.date, sessionId: s.id, ...p };
      if (row.e1rm == null) { const hr = highRepE1rm(s, exerciseId); if (hr != null) { row.e1rm = hr; row.e1rmBasis = 'high-rep'; } }
      out.push(row);
    }
    return out;
  });
}

// Most recent session before `beforeDate` containing the exercise, with its done sets.
// Same-day sessions count when they started before `beforeAt` (pass the current session's startAt
// and id so a second session on the same day sees the first one).
export function lastPerformance(dv, exerciseId, beforeDate, { beforeAt, excludeSessionId } = {}) {
  const all = dv.allSessions();
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if (excludeSessionId && s.id === excludeSessionId) continue;
    if (beforeDate && s.date > beforeDate) continue;
    if (beforeDate && s.date === beforeDate && !(beforeAt && s.startAt && Date.parse(s.startAt) < Date.parse(beforeAt))) continue;
    const sets = [];
    for (const e of s.entries || []) if (e && e.exerciseId === exerciseId) for (const x of setsOf(e)) if (x.done !== false) sets.push(x);
    if (sets.length) return { date: s.date, sessionId: s.id, sets };
  }
  return null;
}

// Chronological PRs (the first session of an exercise sets the baseline).
// 'e1rm' and 'weight' for loaded work; 'reps' for bodyweight work at 0 lb.
export function prs(dv, { since } = {}) {
  const all = dv.memo('str:prs', () => {
    const best = new Map(); const out = [];
    const bump = (s, exerciseId, type, value) => {
      if (!isNum(value) || value <= 0) return;
      const k = exerciseId + '|' + type; const prev = best.get(k);
      if (prev == null) { best.set(k, value); return; }
      if (value > prev) { out.push({ date: s.date, sessionId: s.id, exerciseId, type, value, prev }); best.set(k, value); }
    };
    for (const s of dv.allSessions()) {
      const ids = new Set((s.entries || []).map((e) => e && e.exerciseId).filter(Boolean));
      for (const id of ids) {
        const p = sessionPerf(s, id); if (!p) continue;
        if (p.topW > 0) { bump(s, id, 'e1rm', p.e1rm); bump(s, id, 'weight', p.topW); }
        else bump(s, id, 'reps', p.maxReps);
      }
    }
    return out;
  });
  return since ? all.filter((p) => p.date >= since) : all.slice();
}

// Hard sets and volume per Monday-week and muscle (primary 1 set, secondary 0.5).
export function weeklyMuscleVolume(dv, from, to) {
  const ex = dv.exercises(); const acc = new Map();
  const add = (week, muscle, sets, vol) => {
    if (!muscle) return;
    const k = week + '|' + muscle; const cur = acc.get(k) || { week, muscle, hardSets: 0, volumeLb: 0 };
    cur.hardSets += sets; cur.volumeLb += vol; acc.set(k, cur);
  };
  for (const s of dv.range('sessions', from, to)) {
    const week = weekStart(s.date);
    for (const e of s.entries || []) {
      const def = e && ex.get(e.exerciseId); if (!def) continue;
      for (const set of setsOf(e)) {
        if (!isWorkingSet(set)) continue;
        const vol = (isNum(set.w) ? set.w : 0) * (isNum(set.reps) ? set.reps : 0);
        add(week, def.muscle, 1, vol);
        for (const m of def.secondary || []) add(week, m, 0.5, vol * 0.5);
      }
    }
  }
  return [...acc.values()].map((x) => ({ ...x, volumeLb: round(x.volumeLb, 0) }))
    .sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : a.muscle < b.muscle ? -1 : 1));
}

// Trend of e1RM (or best reps for bodyweight work) over the last `weeks` weeks of history.
// ±0.5 %/week separates progressing / plateau / regressing.
export function progression(history, { weeks = 8 } = {}) {
  const h = (history || []).filter((x) => x && x.date);
  if (!h.length) return { slopePctPerWeek: null, status: 'insufficient', n: 0 };
  const lastDate = h[h.length - 1].date; const start = addDays(lastDate, -weeks * 7);
  const useE = h.some((x) => isNum(x.e1rm));
  const pts = h.filter((x) => x.date > start).map((x) => ({ x: diffDays(start, x.date), y: useE ? x.e1rm : x.maxReps ?? x.bestSet?.reps })).filter((p) => isNum(p.y));
  const n = pts.length;
  const span = n ? pts[n - 1].x - pts[0].x : 0;
  if (n < 3 || span < 14) return { slopePctPerWeek: null, status: 'insufficient', n };
  const { slope } = linreg(pts.map((p) => p.x), pts.map((p) => p.y));
  const m = mean(pts.map((p) => p.y));
  if (slope == null || !m) return { slopePctPerWeek: null, status: 'insufficient', n };
  const pct = round(((slope * 7) / m) * 100, 2);
  return { slopePctPerWeek: pct, status: pct >= 0.5 ? 'progressing' : pct <= -0.5 ? 'regressing' : 'plateau', n };
}

export function strengthSummary(dv, date = dv.asOf()) {
  return dv.memo('str:summary:' + date, () => {
    const ex = dv.exercises();
    const since56 = addDays(date, -55), since28 = addDays(date, -27), prior28 = addDays(date, -55);
    const recent = dv.range('sessions', since56, date);
    const freq = new Map();
    for (const s of recent) for (const id of new Set((s.entries || []).map((e) => e && e.exerciseId).filter(Boolean))) freq.set(id, (freq.get(id) || 0) + 1);
    const topLifts = [...freq.entries()]
      .filter(([id]) => (ex.get(id)?.type || 'strength') === 'strength')
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6)
      .map(([id]) => {
        const hist = exerciseHistory(dv, id).filter((x) => x.date <= date);
        const useE = hist.some((x) => isNum(x.e1rm));
        const val = (x) => (useE ? x.e1rm : x.maxReps);
        const cur = Math.max(...hist.filter((x) => x.date >= since28).map(val).filter(isNum), -Infinity);
        const prev = Math.max(...hist.filter((x) => x.date >= prior28 && x.date < since28).map(val).filter(isNum), -Infinity);
        const current = isFinite(cur) ? cur : null, previous = isFinite(prev) ? prev : null;
        return {
          exerciseId: id, name: ex.get(id)?.name || id, metric: useE ? 'e1rm' : 'reps',
          e1rm: useE ? current : null, best: current,
          change28Pct: current != null && previous ? round(((current - previous) / previous) * 100, 1) : null,
          status: progression(hist).status, sessions: freq.get(id),
        };
      });
    const week = weekStart(date);
    const vol = weeklyMuscleVolume(dv, addDays(week, -28), date);
    const cur = vol.filter((v) => v.week === week);
    const muscles = new Set(vol.map((v) => v.muscle));
    const weeklySets = [...muscles].map((m) => {
      const prior = [1, 2, 3, 4].map((k) => vol.find((v) => v.week === addDays(week, -7 * k) && v.muscle === m)?.hardSets || 0);
      return { muscle: m, hardSets: cur.find((v) => v.muscle === m)?.hardSets || 0, avg4: round(mean(prior), 1) };
    }).sort((a, b) => b.hardSets - a.hardSets || b.avg4 - a.avg4);
    return {
      topLifts,
      recentPrs: prs(dv, { since: since28 }).filter((p) => p.date <= date).reverse().slice(0, 10),
      weeklySets,
      sessions28: dv.range('sessions', since28, date).length,
    };
  });
}

// Cardio entries (optionally one exercise). efficiency = avg watts per avg bpm.
export function cardioHistory(dv, exerciseId) {
  const out = [];
  for (const s of dv.allSessions()) {
    for (const c of s.cardio || []) {
      if (!c || (exerciseId && c.exerciseId !== exerciseId)) continue;
      out.push({
        date: s.date, sessionId: s.id, exerciseId: c.exerciseId || null,
        durationMin: isNum(c.durationMin) ? c.durationMin : null, avgWatts: isNum(c.avgWatts) ? c.avgWatts : null, avgHr: isNum(c.avgHr) ? c.avgHr : null,
        efficiency: isNum(c.avgWatts) && isNum(c.avgHr) && c.avgHr > 0 ? round(c.avgWatts / c.avgHr, 3) : null,
        distanceMi: isNum(c.distanceMi) ? c.distanceMi : null, kcal: isNum(c.kcal) ? c.kcal : null,
      });
    }
  }
  return out;
}
