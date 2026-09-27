// Train area pure logic: set math, PR detection, week aggregation, template instantiation,
// WHOOP matching and formatting. No DOM, no store access — tested in tests/ui/train-logic.test.mjs.
// Working ("hard") sets follow analytics' isWorkingSet so the logger counts exactly what analytics count.
import { e1rm, isWorkingSet } from '../../analytics/strength.js';
import { isNum, round, pad2, fmtNum } from '../../core/util.js';

export { e1rm, isWorkingSet };

/* ------------------------------------------------------------- set kinds */
// Stored kinds: 'work' (default), 'warmup', 'drop', 'failure'. Warm-ups never count;
// work, drop and failure sets count once they are done (done !== false).
export const KINDS = ['work', 'warmup', 'drop', 'failure'];
export const KIND_LABEL = { work: 'Working set', warmup: 'Warm-up', drop: 'Drop set', failure: 'To failure' };
const KIND_SHORT = { warmup: 'W', drop: 'D', failure: 'F' };

export const normKind = (k) => (k == null || k === '' || k === 'working' ? 'work' : String(k));
export const nextKind = (k) => KINDS[(KINDS.indexOf(normKind(k)) + 1) % KINDS.length];
export const kindLabel = (k) => KIND_LABEL[normKind(k)] || String(k);

/** Row labels: working sets are numbered 1..n, other kinds get a letter (W, D, F). */
export function setLabels(sets) {
  let n = 0;
  return (sets || []).map((s) => {
    const k = normKind(s && s.kind);
    return k === 'work' ? String(++n) : KIND_SHORT[k] || k.slice(0, 1).toUpperCase();
  });
}

/* --------------------------------------------------------------- numbers */
/** Text → number (accepts a decimal comma); null for empty or invalid input. */
export function parseNum(text) {
  if (text == null) return null;
  if (typeof text === 'number') return isFinite(text) ? text : null;
  const t = String(text).trim().replace(',', '.');
  if (!t || t === '.' || t === '-' || !/^-?\d*\.?\d*$/.test(t)) return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
}
/** Plain text for an input: 185 → '185', 187.5 → '187.5', null → ''. */
export const fmtW = (w) => (isNum(w) ? String(round(w, 2)) : '');
/** Pounds for display: 185 → '185 lb', 234.33 → '234.3 lb', 12450 → '12,450 lb'. */
export function fmtLb(v, unit = true) {
  if (!isNum(v)) return '—';
  const r = round(v, 1);
  return fmtNum(r, Number.isInteger(r) ? 0 : 1) + (unit ? ' lb' : '');
}
/** Step a value (±5 lb, ±1 rep), never below `min`. */
export function bump(value, delta, min = 0) {
  return Math.max(min, round((isNum(value) ? value : 0) + delta, 2));
}
export const clampRpe = (v) => (isNum(v) ? Math.min(10, Math.max(1, round(v * 2, 0) / 2)) : null);

/** '185×8', bodyweight: 'BW×12' or '+25×8'. */
export function setText(s, bodyweight = false) {
  if (!s) return '—';
  const w = isNum(s.w) ? s.w : null; const reps = isNum(s.reps) ? s.reps : null;
  const ws = bodyweight ? (w ? '+' + fmtW(w) : 'BW') : w != null ? fmtW(w) : '—';
  return reps != null ? `${ws}×${reps}` : ws;
}
/** Working sets as '185×8, 185×8, 185×7' (falls back to every set when none count). */
export function setsLine(sets, bodyweight = false) {
  const list = (sets || []).filter(Boolean);
  const work = list.filter(isWorkingSet);
  return (work.length ? work : list).map((s) => setText(s, bodyweight)).join(', ');
}

/* ----------------------------------------------------------------- time */
/** Elapsed clock: 0:07, 42:18, 1:05:12. */
export function clockText(ms) {
  const t = Math.max(0, Math.floor((isNum(ms) ? ms : 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
/** Session length in minutes (null while open or when times are missing). */
export function durationMin(s) {
  const a = Date.parse(s && s.startAt), b = Date.parse(s && s.endAt);
  return isFinite(a) && isFinite(b) && b > a ? Math.round((b - a) / 60000) : null;
}

/* ------------------------------------------------------- session stats */
const setsOf = (e) => (Array.isArray(e && e.sets) ? e.sets.filter(Boolean) : []);
const volOf = (s) => (isNum(s.w) ? s.w : 0) * (isNum(s.reps) ? s.reps : 0);

/** Counts for one session, consistent with analytics (working sets = isWorkingSet). */
export function sessionStats(s) {
  let workingSets = 0, volumeLb = 0, doneSets = 0, totalSets = 0, pendingSets = 0, exercises = 0;
  for (const e of (s && s.entries) || []) {
    const sets = setsOf(e);
    if (sets.some(isWorkingSet)) exercises++;
    for (const x of sets) {
      totalSets++;
      if (x.done === false) pendingSets++; else doneSets++;
      if (isWorkingSet(x)) { workingSets++; volumeLb += volOf(x); }
    }
  }
  let cardioMin = 0, cardioCount = 0;
  for (const c of (s && s.cardio) || []) { if (!c) continue; cardioCount++; if (isNum(c.durationMin)) cardioMin += c.durationMin; }
  return { workingSets, volumeLb: round(volumeLb, 0), doneSets, totalSets, pendingSets, exercises, cardioMin: round(cardioMin, 1), cardioCount, durationMin: durationMin(s) };
}

/** Totals over a list of sessions (e.g. one Monday–Sunday week). */
export function weekSummary(sessions) {
  const out = { sessions: 0, workingSets: 0, volumeLb: 0, cardioMin: 0, trainingMin: 0 };
  for (const s of sessions || []) {
    if (!s) continue;
    const st = sessionStats(s);
    out.sessions++; out.workingSets += st.workingSets; out.volumeLb += st.volumeLb; out.cardioMin += st.cardioMin;
    out.trainingMin += st.durationMin || 0;
  }
  out.cardioMin = round(out.cardioMin, 1);
  return out;
}

/* ------------------------------------------------------------------ PRs */
const before = (a, ref) => a.date < ref.date || (a.date === ref.date && (a.startAt || '') < (ref.startAt || ''));

// Session-level performance of one exercise — mirrors analytics (strength.js sessionPerf).
function perf(s, exerciseId) {
  let best = null, topW = null, maxReps = null, n = 0;
  for (const e of (s && s.entries) || []) {
    if (!e || e.exerciseId !== exerciseId) continue;
    for (const x of setsOf(e)) {
      if (!isWorkingSet(x)) continue;
      n++;
      const w = isNum(x.w) ? x.w : 0, reps = isNum(x.reps) ? x.reps : 0;
      if (topW == null || w > topW) topW = w;
      if (maxReps == null || reps > maxReps) maxReps = reps;
      const est = e1rm(w, reps);
      if (est != null && (best == null || est > best)) best = est;
    }
  }
  return n ? { e1rm: best, topW, maxReps } : null;
}

/**
 * Best marks for an exercise from sessions that happened before `ref` (another session).
 * → { sessions, e1rm, topW, maxReps0, repMax: { reps: best weight } }. Same rules as analytics prs():
 * working sets only; a session with loaded work updates e1RM/weight, a 0-lb-only session updates reps.
 */
export function priorBests(sessions, exerciseId, ref) {
  const b = { sessions: 0, e1rm: null, topW: null, maxReps0: null, repMax: {} };
  for (const s of sessions || []) {
    if (!s || (ref && (s.id === ref.id || !before(s, ref)))) continue;
    const p = perf(s, exerciseId); if (!p) continue;
    b.sessions++;
    if (p.topW > 0) {
      if (p.e1rm != null && (b.e1rm == null || p.e1rm > b.e1rm)) b.e1rm = p.e1rm;
      if (b.topW == null || p.topW > b.topW) b.topW = p.topW;
    } else if (p.maxReps > 0 && (b.maxReps0 == null || p.maxReps > b.maxReps0)) b.maxReps0 = p.maxReps;
    for (const e of s.entries || []) {
      if (!e || e.exerciseId !== exerciseId) continue;
      for (const x of setsOf(e)) if (isWorkingSet(x) && isNum(x.w) && x.w > 0 && isNum(x.reps) && x.reps > 0 && (b.repMax[x.reps] == null || x.w > b.repMax[x.reps])) b.repMax[x.reps] = x.w;
    }
  }
  return b;
}
function absorb(b, x) {
  const w = isNum(x.w) ? x.w : 0, reps = isNum(x.reps) ? x.reps : 0;
  if (w > 0) {
    const est = e1rm(w, reps);
    if (est != null && (b.e1rm == null || est > b.e1rm)) b.e1rm = est;
    if (b.topW == null || w > b.topW) b.topW = w;
    if (reps > 0 && (b.repMax[reps] == null || w > b.repMax[reps])) b.repMax[reps] = w;
  } else if (reps > 0 && (b.maxReps0 == null || reps > b.maxReps0)) b.maxReps0 = reps;
}
/** Heaviest weight lifted for at least `reps` reps (null when never). */
export function bestAtLeast(repMax, reps) {
  let best = null;
  for (const k of Object.keys(repMax || {})) if (Number(k) >= reps && (best == null || repMax[k] > best)) best = repMax[k];
  return best;
}
const copyBests = (b) => ({ ...b, repMax: { ...(b.repMax || {}) } });

/**
 * Records one completed set beats. PRs (types 'e1rm', 'weight' = heaviest ever, 'reps' = 0-lb reps)
 * match analytics prs(); 'repBest' (heaviest weight for ≥ these reps) is extra detail, not a PR.
 * No history (first session of an exercise) → [] (the baseline).
 */
export function setRecords(set, bests) {
  if (!set || !isWorkingSet(set) || !bests || !bests.sessions) return [];
  const w = isNum(set.w) ? set.w : 0, reps = isNum(set.reps) ? set.reps : 0;
  if (reps <= 0) return [];
  const out = [];
  if (w > 0) {
    const est = e1rm(w, reps);
    if (est != null && bests.e1rm != null && est > bests.e1rm) out.push({ type: 'e1rm', value: est, prev: bests.e1rm });
    if (bests.topW != null && w > bests.topW) out.push({ type: 'weight', value: w, prev: bests.topW, reps });
    else {
      const prevAt = bestAtLeast(bests.repMax, reps);
      if (prevAt != null && w > prevAt) out.push({ type: 'repBest', value: w, prev: prevAt, reps });
    }
  } else if (bests.maxReps0 != null && reps > bests.maxReps0) out.push({ type: 'reps', value: reps, prev: bests.maxReps0 });
  return out;
}
export const isPr = (r) => r.type === 'e1rm' || r.type === 'weight' || r.type === 'reps';

/**
 * Per-set records for every entry of `exerciseId` in session order (UI flags). A set only counts when it
 * beats prior sessions AND the earlier sets of this session. → Map(entryId → [records[] per set index]).
 */
export function recordFlags(entries, exerciseId, bests) {
  const run = copyBests(bests); const out = new Map();
  for (const e of entries || []) {
    if (!e || e.exerciseId !== exerciseId) continue;
    out.set(e.id, (Array.isArray(e.sets) ? e.sets : []).map((s) => {
      if (!s) return [];
      const r = setRecords(s, run); if (isWorkingSet(s)) absorb(run, s); return r;
    }));
  }
  return out;
}

/**
 * Session record summary. PRs are computed per session exactly like analytics prs() (session best e1RM /
 * heaviest weight vs prior sessions; reps for 0-lb-only sessions), so counts match everywhere; plus the best
 * 'repBest' per exercise. bestsById: Map(exerciseId → priorBests). → [{exerciseId, type, value, prev, reps?}].
 */
export function sessionRecords(session, bestsById) {
  const prs = [], extra = [];
  const ids = [...new Set(((session && session.entries) || []).map((e) => e && e.exerciseId).filter(Boolean))];
  for (const id of ids) {
    const bests = bestsById.get(id); if (!bests || !bests.sessions) continue;
    const p = perf(session, id); if (!p) continue;
    if (p.topW > 0) {
      if (p.e1rm != null && bests.e1rm != null && p.e1rm > bests.e1rm) prs.push({ exerciseId: id, type: 'e1rm', value: p.e1rm, prev: bests.e1rm });
      if (bests.topW != null && p.topW > bests.topW) prs.push({ exerciseId: id, type: 'weight', value: p.topW, prev: bests.topW });
    } else if (p.maxReps > 0 && bests.maxReps0 != null && p.maxReps > bests.maxReps0) prs.push({ exerciseId: id, type: 'reps', value: p.maxReps, prev: bests.maxReps0 });
    let rb = null;
    for (const list of recordFlags(session.entries, id, bests).values()) for (const recs of list) for (const r of recs) {
      if (r.type === 'repBest' && (!rb || r.value > rb.value || (r.value === rb.value && r.reps > rb.reps))) rb = r;
    }
    if (rb) extra.push({ exerciseId: id, type: 'repBest', value: rb.value, reps: rb.reps, prev: bestAtLeast(bests.repMax, rb.reps) });
  }
  return [...prs, ...extra];
}

/* ------------------------------------------------- set editing helpers */
/** New set for "Add set": copies weight, reps and kind of the previous set (or a fallback), not done. */
export function copySet(prev, fallback) {
  const src = prev || fallback || {};
  return { w: isNum(src.w) ? src.w : null, reps: isNum(src.reps) ? src.reps : null, rpe: null, kind: normKind(src.kind), done: false };
}
/** Suggested values for set `i`: the previous set of this entry, else the same set last time. */
export function placeholderFor(sets, i, lastSets) {
  const prev = i > 0 ? (sets || [])[i - 1] : null;
  if (prev && (isNum(prev.w) || isNum(prev.reps))) return { w: isNum(prev.w) ? prev.w : null, reps: isNum(prev.reps) ? prev.reps : null };
  const work = (lastSets || []).filter(isWorkingSet);
  const ref = work.length ? work[Math.min(i, work.length - 1)] : null;
  return ref ? { w: isNum(ref.w) ? ref.w : null, reps: isNum(ref.reps) ? ref.reps : null } : { w: null, reps: null };
}
/**
 * Mark a set done, filling empty weight/reps from the suggestion. Returns { set } or { error }
 * (reps are required; weight is required unless the exercise is bodyweight, where empty = 0).
 */
export function completeSet(set, suggestion, bodyweight = false) {
  const sg = suggestion || {};
  const reps = isNum(set.reps) ? set.reps : isNum(sg.reps) ? sg.reps : null;
  let w = isNum(set.w) ? set.w : isNum(sg.w) ? sg.w : null;
  if (w == null && bodyweight) w = 0;
  if (reps == null || reps <= 0) return { error: 'reps' };
  if (w == null) return { error: 'weight' };
  return { set: { ...set, w, reps, kind: normKind(set.kind), done: true } };
}
/** Move item i by dir (−1 / +1); returns a new array (unchanged copy when out of range). */
export function moveItem(arr, i, dir) {
  const a = (arr || []).slice(); const j = i + dir;
  if (i < 0 || i >= a.length || j < 0 || j >= a.length) return a;
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}

/* --------------------------------------------------- session creation */
const REPS_RE = /^\s*(\d+)/;
/** Reps target from a number or a range string ('8-10' → 8). */
export const repsTarget = (r) => (isNum(r) ? r : typeof r === 'string' && REPS_RE.test(r) ? Number(REPS_RE.exec(r)[1]) : null);

/**
 * One template exercise → a session entry: `sets` working sets with the template's reps target and
 * weights from the last performance (same working-set index, else its last working set).
 * The target is kept on the entry (`target`) so the logger can show it; RPE targets are not logged as actuals.
 */
export function entryFromPlan(item, last, id) {
  const n = Math.min(20, Math.max(1, Math.round(isNum(item.sets) ? item.sets : 3)));
  const reps = repsTarget(item.reps);
  const work = last && Array.isArray(last.sets) ? last.sets.filter(isWorkingSet) : [];
  const sets = [];
  for (let i = 0; i < n; i++) {
    const ref = work.length ? work[Math.min(i, work.length - 1)] : null;
    sets.push({ w: ref && isNum(ref.w) ? ref.w : null, reps: reps ?? (ref && isNum(ref.reps) ? ref.reps : null), rpe: null, kind: 'work', done: false });
  }
  const entry = { id, exerciseId: item.exerciseId, sets };
  if (reps != null || isNum(item.rpe)) entry.target = { sets: n, reps, rpe: isNum(item.rpe) ? item.rpe : null };
  return entry;
}
/** Template → entries. lastPerf(exerciseId) → {sets}|null; newId() → id. */
export function entriesFromTemplate(tpl, lastPerf, newId) {
  return ((tpl && tpl.exercises) || []).filter((x) => x && x.exerciseId).map((x) => entryFromPlan(x, lastPerf(x.exerciseId), newId()));
}
/** Repeat a session: same exercises; sets copied from each exercise's most recent performance, not done. */
export function entriesFromSession(session, lastPerf, newId) {
  return ((session && session.entries) || []).filter((e) => e && e.exerciseId).map((e) => {
    const last = lastPerf(e.exerciseId);
    const src = last && last.sets && last.sets.length ? last.sets : setsOf(e);
    return { id: newId(), exerciseId: e.exerciseId, sets: src.map((s) => ({ w: isNum(s.w) ? s.w : null, reps: isNum(s.reps) ? s.reps : null, rpe: null, kind: normKind(s.kind), done: false })) };
  });
}
/** Template exercises from a session (working-set count, most common reps). */
export function templateFromSession(session) {
  return ((session && session.entries) || []).filter((e) => e && e.exerciseId).map((e) => {
    const work = setsOf(e).filter((s) => normKind(s.kind) !== 'warmup');
    const counts = new Map();
    for (const s of work) if (isNum(s.reps)) counts.set(s.reps, (counts.get(s.reps) || 0) + 1);
    const reps = counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0] : null;
    return { exerciseId: e.exerciseId, sets: Math.max(1, work.length || setsOf(e).length || 3), reps, rpe: null };
  });
}

/* ------------------------------------------------------------------ WHOOP */
/**
 * WHOOP workout overlapping [startAt, endAt] the most (≥ 20% of the shorter interval), or null.
 * `exclude`: Set of workout ids already linked to other sessions.
 */
export function matchWorkout(workouts, startAt, endAt, exclude) {
  const s = Date.parse(startAt), e = Date.parse(endAt);
  if (!isFinite(s) || !isFinite(e) || e <= s) return null;
  let best = null, bestOv = 0;
  for (const w of workouts || []) {
    if (!w || (exclude && exclude.has(w.id))) continue;
    const ws = Date.parse(w.start), we = Date.parse(w.end);
    if (!isFinite(ws) || !isFinite(we) || we <= ws) continue;
    const ov = Math.min(e, we) - Math.max(s, ws);
    if (ov <= 0 || ov < 0.2 * Math.min(e - s, we - ws)) continue;
    if (ov > bestOv) { bestOv = ov; best = w; }
  }
  return best;
}

/* ------------------------------------------------------- library helpers */
/** Exercise usage over sessions (optionally since a date): [{id, count, last}] most used first. */
export function rankExercises(sessions, since) {
  const m = new Map();
  for (const s of sessions || []) {
    if (!s || (since && s.date < since)) continue;
    const ids = new Set([...(s.entries || []).map((e) => e && e.exerciseId), ...(s.cardio || []).map((c) => c && c.exerciseId)].filter(Boolean));
    for (const id of ids) { const cur = m.get(id) || { id, count: 0, last: '' }; cur.count++; if (s.date > cur.last) cur.last = s.date; m.set(id, cur); }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}
/** Library filter: every query word must appear in name, muscle, secondary or equipment. */
export function filterExercises(list, { query = '', muscle = '', type = '' } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (list || []).filter((x) => {
    if (!x) return false;
    if (type && (x.type || 'strength') !== type) return false;
    if (muscle && x.muscle !== muscle && !(x.secondary || []).includes(muscle)) return false;
    if (!words.length) return true;
    const hay = [x.name, x.muscle, x.equipment, ...(x.secondary || [])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
/** Most recently used cardio exercise id in chronological sessions (null when none). */
export function lastCardioExercise(sessions) {
  for (let i = (sessions || []).length - 1; i >= 0; i--) {
    const c = ((sessions[i] && sessions[i].cardio) || []).filter((x) => x && x.exerciseId);
    if (c.length) return c[c.length - 1].exerciseId;
  }
  return null;
}

/* ---------------------------------------------------- exercise records */
/**
 * Actual-set records of one exercise across sessions (working sets only):
 * heaviest (weight, then reps), bestE1rm, mostReps (reps, then weight) and repMax [{reps, w, date, sessionId}]
 * = heaviest weight lifted for at least that many reps (1–12, only rows that improve on a higher rep count).
 */
export function exerciseRecords(sessions, exerciseId) {
  let heaviest = null, bestE1rm = null, mostReps = null; const exact = new Map();
  for (const s of sessions || []) {
    for (const e of (s && s.entries) || []) {
      if (!e || e.exerciseId !== exerciseId) continue;
      for (const x of setsOf(e)) {
        if (!isWorkingSet(x) || !isNum(x.reps) || x.reps <= 0) continue;
        const w = isNum(x.w) ? x.w : 0; const rec = { w, reps: x.reps, date: s.date, sessionId: s.id };
        if (!heaviest || w > heaviest.w || (w === heaviest.w && x.reps > heaviest.reps)) heaviest = rec;
        const est = e1rm(w, x.reps);
        if (est != null && (!bestE1rm || est > bestE1rm.e1rm)) bestE1rm = { ...rec, e1rm: est };
        if (!mostReps || x.reps > mostReps.reps || (x.reps === mostReps.reps && w > mostReps.w)) mostReps = rec;
        if (w > 0 && x.reps <= 12) { const cur = exact.get(x.reps); if (!cur || w > cur.w) exact.set(x.reps, rec); }
      }
    }
  }
  const repMax = []; let floor = -Infinity;
  for (let r = 12; r >= 1; r--) { const cur = exact.get(r); if (cur && cur.w > floor) { repMax.push({ reps: r, ...cur }); floor = cur.w; } }
  return { heaviest, bestE1rm, mostReps, repMax: repMax.reverse() };
}

/* --------------------------------------------------------------- rest */
/** Rest timer view at `now`: { remainingMs, done, fraction (elapsed share 0–1) }. timer: {endsAt, durationMs}. */
export function restView(timer, now) {
  if (!timer || !isNum(timer.endsAt)) return null;
  const remainingMs = Math.max(0, timer.endsAt - now);
  const total = Math.max(1, timer.durationMs || 1);
  return { remainingMs, done: remainingMs <= 0, fraction: Math.min(1, Math.max(0, 1 - remainingMs / total)) };
}
