// Train area data helpers: reads through the DataView, writes through the store. No UI.
import { lastPerformance, prs } from '../../analytics/index.js';
import { uid, nowIso, isoWithOffset, zonedToMs, localParts, addDays, isNum } from '../../core/util.js';
import { matchWorkout, priorBests, lastCardioExercise } from './train-logic.js';

/** Open (unfinished) session on a date, newest first. */
export function openSessionOn(dv, date) {
  const list = dv.sessions(date).filter((s) => !s.endAt);
  return list.length ? list[list.length - 1] : null;
}
/** Unfinished session from today or yesterday (the banner / resume target). */
export function recentOpenSession(dv, today) {
  return openSessionOn(dv, today) || openSessionOn(dv, addDays(today, -1));
}
/** (exerciseId) → last performance before `date` (or earlier that day when opts.beforeAt is given) ({date, sessionId, sets}|null). */
export const lastPerfFn = (dv, date, opts) => (exerciseId) => lastPerformance(dv, exerciseId, date, opts);

/** Start instant for a new session on `date`: now when date is today, else the same clock time on that date. */
export function startInstant(app, date) {
  const tz = app.dv.tz;
  if (!date || date === app.today()) return nowIso(tz);
  const hm = localParts(Date.now(), tz).hm;
  return isoWithOffset(zonedToMs(date, hm, tz), tz);
}

/** Create a session record; returns its id. */
export function createSession(app, { date, name, templateId, entries = [], cardio = [], startAt, endAt = null, rpe = null, note = '' }) {
  const d = date || app.today();
  const rec = app.store.create('sessions', {
    date: d, startAt: startAt || startInstant(app, d), endAt, name: name || 'Workout', templateId: templateId || null,
    entries, cardio, rpe, note, whoopWorkoutId: null,
  });
  return rec.id;
}
export const newEntryId = () => 'e' + uid(8);

/** WHOOP workout linked to a session (record or null). */
export function linkedWorkout(app, session) {
  return session && session.whoopWorkoutId ? app.store.get('whoopWorkouts', session.whoopWorkoutId) : null;
}
/** Best overlapping WHOOP workout for a finished session that is not linked to another session. */
export function findWorkoutFor(app, session) {
  if (!session || !session.startAt || !session.endAt) return null;
  const taken = new Set(app.dv.sessions(session.date).filter((s) => s.id !== session.id && s.whoopWorkoutId).map((s) => s.whoopWorkoutId));
  const days = [session.date, addDays(session.date, 1)];
  const workouts = days.flatMap((d) => app.dv.workouts(d));
  return matchWorkout(workouts, session.startAt, session.endAt, taken);
}
/**
 * Link the overlapping WHOOP workout when the session has none; returns the linked workout or null.
 * whoopWorkoutId: an id = linked, null/missing = not linked yet, false = the user chose "Not linked" (never auto-linked).
 */
export function autoLinkWorkout(app, id, { force = false } = {}) {
  const s = app.store.get('sessions', id);
  if (!s) return null;
  if (s.whoopWorkoutId) return linkedWorkout(app, s);
  if (s.whoopWorkoutId === false && !force) return null;
  const w = findWorkoutFor(app, s);
  if (w) app.store.update('sessions', id, { whoopWorkoutId: w.id });
  return w;
}
/** Link finished sessions of the last `days` days to overlapping WHOOP workouts (WHOOP data arrives later). */
export function autoLinkRecent(app, days = 14) {
  if (!app.store.all('whoopWorkouts').length) return 0;
  const today = app.today(); let n = 0;
  for (const s of app.dv.range('sessions', addDays(today, -days), today)) {
    if (s.whoopWorkoutId != null || !s.endAt) continue;
    const w = findWorkoutFor(app, s);
    if (w) { app.store.update('sessions', s.id, { whoopWorkoutId: w.id }); n++; }
  }
  return n;
}

/** Recent sessions with strength work, one per name (for "Repeat"), newest first. */
export function repeatCandidates(dv, limit = 4) {
  const out = []; const seen = new Set(); const all = dv.allSessions();
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const s = all[i];
    if (!(s.entries || []).some((e) => e && e.exerciseId)) continue;
    const key = String(s.name || '').trim().toLowerCase() || s.id;
    if (seen.has(key)) continue;
    seen.add(key); out.push(s);
  }
  return out;
}

/** Map(exerciseId → priorBests) for every exercise in a session. */
export function bestsFor(dv, session) {
  const all = dv.allSessions(); const m = new Map();
  for (const e of (session && session.entries) || []) if (e && e.exerciseId && !m.has(e.exerciseId)) m.set(e.exerciseId, priorBests(all, e.exerciseId, session));
  return m;
}

/** PR count per session id (analytics prs(); falls back to the date when an older analytics build has no sessionId). */
export function prCountBySession(dv) {
  return dv.memo('train:prCount', () => {
    const m = new Map(); const byDate = new Map();
    for (const p of prs(dv)) {
      if (p.sessionId) m.set(p.sessionId, (m.get(p.sessionId) || 0) + 1);
      else byDate.set(p.date, (byDate.get(p.date) || 0) + 1);
    }
    return { get: (s) => m.get(s.id) || (byDate.size ? byDate.get(s.date) || 0 : 0) };
  });
}

/** Exercises sorted by name, optionally of one type. */
export function exerciseList(dv, type) {
  return [...dv.exercises().values()].filter((x) => !type || (x.type || 'strength') === type).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
/** Default cardio exercise: the most recently used one, else the first cardio exercise by name. */
export function defaultCardioExercise(dv) {
  const ex = dv.exercises(); const last = lastCardioExercise(dv.allSessions());
  if (last && ex.has(last)) return last;
  const list = exerciseList(dv, 'cardio');
  return list.length ? list[0].id : null;
}
/** Number of sessions that reference an exercise (entries or cardio). */
export function usageCount(dv, exerciseId) {
  let n = 0;
  for (const s of dv.allSessions()) if ((s.entries || []).some((e) => e && e.exerciseId === exerciseId) || (s.cardio || []).some((c) => c && c.exerciseId === exerciseId)) n++;
  return n;
}
/** Minutes after local midnight of an instant in the profile zone. */
export const clockMin = (dv, iso) => { const c = dv.clock(iso); return c ? c.min : null; };
/** 'HH:MM' local time of an instant. */
export const hmOf = (dv, iso) => (iso ? localParts(iso, dv.tz).hm : '');
/** Instant for a local date + 'HH:MM' (next day when `after` is given and the time would not be later). */
export function instantAt(dv, date, hm, after) {
  let ms = zonedToMs(date, hm, dv.tz);
  if (after) { const a = Date.parse(after); if (isFinite(a) && ms <= a) ms = zonedToMs(addDays(date, 1), hm, dv.tz); }
  return isoWithOffset(ms, dv.tz);
}
export const num = (v) => (isNum(v) ? v : null);
