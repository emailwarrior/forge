// Fuel: pure helpers for meal capture, meal records and the nutrition screen (Node-testable; no DOM, no preact).
// Tests: tests/ui/fuel-logic.test.mjs
import { NUTRIENT_KEYS } from '../../core/schema.js';
import { NUTRIENT_DP } from '../../ai/meal.js';
import { isYmd, hmToMin, localParts, zonedToMs, isoWithOffset, isNum, round, fmtNum, diffDays, LB_PER_KG } from '../../core/util.js';
import { localClock } from '../../analytics/dataview.js';

const roundTo = (v, dp) => { const f = 10 ** dp; return Math.round(v * f) / f; };
const clip = (s, n) => { const t = String(s == null ? '' : s).trim().replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

/* ------------------------------------------------------------------ slots */
export const SLOTS = [
  { value: 'breakfast', label: 'Breakfast' }, { value: 'lunch', label: 'Lunch' }, { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' }, { value: 'shake', label: 'Shake' }, { value: 'pre', label: 'Pre-workout' }, { value: 'post', label: 'Post-workout' },
];
export const slotLabel = (slot) => (SLOTS.find((s) => s.value === slot) || {}).label || '';

/** Default slot for a local time (minutes after midnight): 04:00–10:30 breakfast, 10:30–14:30 lunch, 17:00–21:30 dinner, else snack. */
export function slotForMinutes(min) {
  if (!isNum(min)) return 'snack';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  if (m >= 240 && m < 630) return 'breakfast';
  if (m >= 630 && m < 870) return 'lunch';
  if (m >= 1020 && m < 1290) return 'dinner';
  return 'snack';
}
export const slotForHm = (hm) => slotForMinutes(hmToMin(hm));

/* ------------------------------------------------------------ time sources */
export const TIME_SOURCE_TEXT = {
  camera: 'Taken now', exif: 'Photo time', filename: 'From file name', file: 'File date — check the time', manual: 'Set manually',
};

/**
 * Local capture time of a photo (or a typed entry).
 * { mode, takenAt ('YYYY-MM-DDTHH:MM[:SS]' wall clock from preparePhoto), takenAtSource ('exif'|'filename'),
 *   lastModified (ms), now (ms), tz, fallbackDate } → { date, hm, timeSource, check }
 * camera → now; EXIF/filename → that wall clock; else the file's modification time (flagged "check");
 * else now on `fallbackDate` (flagged, the user must set it). A time more than 5 minutes in the future is flagged.
 */
export function resolveCaptureTime({ mode, takenAt, takenAtSource, lastModified, now = Date.now(), tz, fallbackDate } = {}) {
  const nowP = localParts(now, tz);
  let out;
  if (mode === 'camera') out = { date: nowP.ymd, hm: nowP.hm, timeSource: 'camera', check: false };
  else if (typeof takenAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(takenAt) && isYmd(takenAt.slice(0, 10))) {
    out = { date: takenAt.slice(0, 10), hm: takenAt.slice(11, 16), timeSource: takenAtSource === 'filename' ? 'filename' : 'exif', check: false };
  } else if (isNum(lastModified) && lastModified > 0) {
    const p = localParts(lastModified, tz);
    out = { date: p.ymd, hm: p.hm, timeSource: 'file', check: true };
  } else {
    out = { date: isYmd(fallbackDate) ? fallbackDate : nowP.ymd, hm: nowP.hm, timeSource: 'manual', check: true };
  }
  if (!out.check && out.timeSource !== 'camera' && zonedToMs(out.date, out.hm, tz) > now + 5 * 60000) out.check = true;
  return out;
}

/** ISO instant with offset for a local date + 'HH:MM' in `tz`. */
export function atFor(date, hm, tz) { return isoWithOffset(zonedToMs(date, hm || '12:00', tz), tz); }

/** Local { date, hm, min } of a meal's `at` (a numeric offset keeps its recorded wall clock, like analytics). */
export function mealClock(meal, tz) {
  const c = meal && typeof meal.at === 'string' ? localClock(meal.at, tz) : null;
  if (!c) return { date: meal && meal.date, hm: null, min: null };
  const hm = String(Math.floor(c.min / 60)).padStart(2, '0') + ':' + String(c.min % 60).padStart(2, '0');
  return { date: c.ymd, hm, min: c.min };
}

/* ---------------------------------------------------------------- grouping */
const absMin = (p) => diffDays('2000-01-01', p.date) * 1440 + (hmToMin(p.hm) || 0);

/**
 * Suggest meals for a batch of photos: [{ date, hm, reliable }] → [[index, …], …] in time order.
 * A reliable photo (EXIF / file name / camera) within `windowMin` minutes of the previous reliable photo
 * joins its meal (plate + label, or seconds apart); unreliable times always start their own meal.
 */
export function autoGroup(photos, windowMin = 10) {
  const order = photos.map((_, i) => i).sort((a, b) => absMin(photos[a]) - absMin(photos[b]) || a - b);
  const groups = [];
  let last = null;
  for (const i of order) {
    const p = photos[i];
    const t = absMin(p);
    if (p.reliable && last && last.reliable && t - last.t <= windowMin) groups[groups.length - 1].push(i);
    else groups.push([i]);
    last = { t, reliable: !!p.reliable };
  }
  return groups;
}

/**
 * Groups used by the capture review: [{ key, photos: [photoKey], date, hm, timeSource, check, slot, slotAuto, note }].
 * All operations return new arrays.
 */
export function mergeIntoPrevious(groups, gi) {
  if (gi <= 0 || gi >= groups.length) return groups;
  const a = groups[gi - 1], b = groups[gi];
  const earlier = absMin(b) < absMin(a) ? b : a;
  const note = [a.note, b.note].map((s) => (s || '').trim()).filter(Boolean).join('; ');
  const merged = { ...a, photos: [...a.photos, ...b.photos], date: earlier.date, hm: earlier.hm, timeSource: earlier.timeSource, check: a.check || b.check, note };
  if (a.slotAuto) merged.slot = slotForHm(merged.hm);
  return [...groups.slice(0, gi - 1), merged, ...groups.slice(gi + 1)];
}

/** Move one photo out of its meal into a new meal right after it. `time` = that photo's own {date, hm, timeSource, check}. */
export function splitOut(groups, gi, photoKey, time, newKey) {
  const g = groups[gi];
  if (!g || g.photos.length < 2 || !g.photos.includes(photoKey)) return groups;
  const rest = { ...g, photos: g.photos.filter((k) => k !== photoKey) };
  const t = time || g;
  const fresh = { key: newKey, photos: [photoKey], date: t.date, hm: t.hm, timeSource: t.timeSource, check: !!t.check, slot: slotForHm(t.hm), slotAuto: true, note: '' };
  return [...groups.slice(0, gi), rest, fresh, ...groups.slice(gi + 1)];
}

/** Drop a photo; a meal left without photos is dropped too. */
export function removePhotoFrom(groups, photoKey) {
  return groups.map((g) => (g.photos.includes(photoKey) ? { ...g, photos: g.photos.filter((k) => k !== photoKey) } : g)).filter((g) => g.photos.length);
}

/* --------------------------------------------------------------- nutrients */
/** Sum FoodItems per nutrient (rounded like the AI layer). Keys no item carries are omitted, so a quick add never invents zeros. */
export function itemsTotals(items) {
  const t = {};
  for (const k of NUTRIENT_KEYS) {
    let s = 0, any = false;
    for (const it of items || []) { const v = it && it[k]; if (typeof v === 'number' && isFinite(v)) { s += v; any = true; } }
    if (any) t[k] = roundTo(s, NUTRIENT_DP[k]);
  }
  return t;
}

/** Multiply an item's grams and nutrients by `factor` (e.g. servings of a saved food). */
export function scaleItem(item, factor) {
  const f = Number(factor);
  if (!item || !isFinite(f) || f < 0) return item ? { ...item } : item;
  const out = { ...item };
  if (isNum(item.grams)) out.grams = Math.round(item.grams * f);
  for (const k of NUTRIENT_KEYS) if (isNum(item[k])) out[k] = roundTo(item[k] * f, NUTRIENT_DP[k]);
  if (f !== 1) out.portion = `${fmtFactor(f)} × ${item.portion || (isNum(item.grams) && item.grams ? item.grams + ' g' : 'serving')}`;
  return out;
}
export const fmtFactor = (f) => String(Math.round(f * 100) / 100);

/** kcal implied by macros (4/4/9); null when no macro is given. */
export function kcalFromMacros({ protein, carbs, fat } = {}) {
  if (![protein, carbs, fat].some(isNum)) return null;
  return Math.round((protein || 0) * 4 + (carbs || 0) * 4 + (fat || 0) * 9);
}

/** Quick add → one FoodItem with only the numbers the user typed (kcal falls back to the macros). null when nothing usable. */
export function quickItem({ name, kcal, protein, carbs, fat, fiber } = {}) {
  const k = isNum(kcal) && kcal >= 0 ? kcal : kcalFromMacros({ protein, carbs, fat });
  if (!isNum(k)) return null;
  const item = { name: clip(name, 80) || 'Quick add', portion: '1 serving', grams: 0, confidence: 'medium', basis: 'estimate', kcal: Math.round(k) };
  for (const [key, v] of [['protein', protein], ['carbs', carbs], ['fat', fat], ['fiber', fiber]]) if (isNum(v) && v >= 0) item[key] = roundTo(v, 1);
  return item;
}

/** "P 52 · C 60 · F 18" (grams). */
export function macroLine(t) {
  if (!t) return '';
  return `P ${fmtG(t.protein)} · C ${fmtG(t.carbs)} · F ${fmtG(t.fat)}`;
}
/** Grams for display: whole numbers, one decimal only below 10 g when it matters (6.4, not 6.0). */
const fmtG = (v) => (isNum(v) ? fmtNum(v, v > 0 && v < 10 && Math.round(v * 10) % 10 ? 1 : 0) : '—');
export const fmtGrams = (v) => (isNum(v) ? fmtG(v) + ' g' : '—');

/* ------------------------------------------------------------------ meals */
export function mealPhotos(meal) {
  if (!meal) return [];
  if (Array.isArray(meal.photos) && meal.photos.length) return meal.photos.filter((p) => p && p.path);
  return meal.photo && meal.photo.path ? [meal.photo] : [];
}
export const hasEstimate = (meal) => !!(meal && meal.totals && isNum(meal.totals.kcal));

/** What can be (re-)analyzed: 'photo' | 'text' | null. */
export function analyzable(meal) {
  if (mealPhotos(meal).length) return 'photo';
  if (meal && meal.note && String(meal.note).trim() && (meal.source === 'text' || !meal.source)) return 'text';
  return null;
}

/** Display title: stored title, else the first items, else the description, else the slot. */
export function mealTitle(meal) {
  if (!meal) return 'Meal';
  if (meal.title && String(meal.title).trim()) return String(meal.title).trim();
  const items = Array.isArray(meal.items) ? meal.items.filter((i) => i && i.name) : [];
  if (items.length) return items.length > 2 ? `${items[0].name}, ${items[1].name} +${items.length - 2}` : items.map((i) => i.name).join(', ');
  if (analyzable(meal) === 'text') return clip(meal.note, 48);
  return slotLabel(meal.slot) || 'Meal';
}

/**
 * UI state of a meal given its queue job (null when not queued):
 * 'analyzing' | 'queued' | 'interrupted' (stored as analyzing but nothing is running) | 'pending' | 'error' | 'ready'.
 */
export function mealState(meal, job) {
  if (job && job.status === 'running') return 'analyzing';
  if (job && job.status === 'queued') return 'queued';
  if (!meal) return 'ready';
  if (meal.status === 'analyzing') return 'interrupted';
  if (meal.status === 'pending') return 'pending';
  if (meal.status === 'error') return 'error';
  return 'ready';
}

/** Title to keep after a new analysis: a title the user edited survives; an AI or empty title is replaced. */
export function nextTitle(meal, aiTitle) {
  const cur = meal && meal.title ? String(meal.title).trim() : '';
  const prevAi = meal && meal.ai && meal.ai.title ? String(meal.ai.title).trim() : '';
  if (cur && cur !== prevAi) return cur;
  return aiTitle || cur || '';
}

/** Record patch from an analyzeMeal/analyzeMealText result. */
export function analysisPatch(meal, res, at) {
  return {
    items: res.items || [], totals: res.totals || itemsTotals(res.items), title: nextTitle(meal, res.title), followUp: res.followUp || null,
    ai: {
      model: res.model || null, confidence: res.confidence || null, assumptions: res.assumptions || [], searched: !!res.searched,
      sources: res.sources || [], costUsd: isNum(res.costUsd) ? res.costUsd : null, costEstimated: !!res.costEstimated,
      at, fallback: !!res.fallback, title: res.title || '', reference: res.reference || null,
    },
    status: 'ready', error: null,
  };
}

/* ------------------------------------------------------------------ foods */
/** Favorites first, then most used, then most recently used, then name. */
export function sortFoods(foods) {
  return [...(foods || [])].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)
    || (Number(b.uses) || 0) - (Number(a.uses) || 0)
    || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || ''))
    || String(a.name || '').localeCompare(String(b.name || '')));
}
/** Every word of the query must appear in the food's name or one of its item names. */
export function searchFoods(foods, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return foods;
  return foods.filter((f) => {
    const hay = [f.name, ...(Array.isArray(f.items) ? f.items.map((i) => i && i.name) : [])].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/* ---------------------------------------------------------------- context */
/** Per-meal protein reference: 0.4 g/kg body weight per meal (muscle-protein-synthesis research, e.g. Schoenfeld & Aragon 2018). */
export function proteinPerMealRef(weightLb) {
  return isNum(weightLb) && weightLb > 0 ? Math.round((weightLb / LB_PER_KG) * 0.4) : null;
}

/** Short goal text for the AI from the profile goal range/rate and the current trend weight; '' when no goal is set. */
export function goalText(profile, weightLb) {
  const p = profile || {};
  const lo = isNum(p.goalWeightLow) ? p.goalWeightLow : null, hi = isNum(p.goalWeightHigh) ? p.goalWeightHigh : null;
  if (lo == null && hi == null) return '';
  const range = lo != null && hi != null ? `${lo}–${hi} lb` : lo != null ? `at least ${lo} lb` : `at most ${hi} lb`;
  const rate = isNum(p.goalRateLbWk) && p.goalRateLbWk > 0 ? ` at about ${p.goalRateLbWk} lb/week` : '';
  if (isNum(weightLb) && lo != null && weightLb < lo) return `gain body weight toward ${range}${rate}`;
  if (isNum(weightLb) && hi != null && weightLb > hi) return `reduce body weight toward ${range}`;
  if (isNum(weightLb)) return `maintain body weight within ${range}`;
  return `body weight ${range}${rate}`;
}

/** "Trend 164.2 lb · 28-day rate +0.25 lb/wk · goal 170–180 lb" from bodySummary() and the profile. */
export function bodyTrendText(summary, profile) {
  const s = summary || {}; const p = profile || {};
  const bits = [];
  if (isNum(s.trend)) bits.push(`trend ${fmtNum(s.trend, 1)} lb`);
  else if (isNum(s.weight)) bits.push(`last weigh-in ${fmtNum(s.weight, 1)} lb`);
  if (isNum(s.rate28)) bits.push(`28-day rate ${s.rate28 > 0 ? '+' : ''}${fmtNum(s.rate28, 2)} lb/wk`);
  if (isNum(s.change7)) bits.push(`7-day change ${s.change7 > 0 ? '+' : ''}${fmtNum(s.change7, 1)} lb`);
  const g = goalText(p, isNum(s.trend) ? s.trend : s.weight);
  if (g) bits.push('goal: ' + g);
  return bits.join('; ');
}

/** Short text of the day's training for the nutrition review: sessions (from `sessions` records) + a DailyRow. */
export function trainingText(sessions, row) {
  const parts = [];
  for (const s of sessions || []) {
    const sets = (s.entries || []).reduce((n, e) => n + (e.sets || []).filter((x) => x && x.done !== false).length, 0);
    const cardio = (s.cardio || []).reduce((n, c) => n + (isNum(c.durationMin) ? c.durationMin : 0), 0);
    const bits = [];
    if (sets) bits.push(`${sets} sets`);
    if (cardio) bits.push(`${Math.round(cardio)} min cardio`);
    parts.push(`${s.name || 'Session'}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`);
  }
  const r = row || {};
  const extra = [];
  if (isNum(r.sessionVolumeLb) && r.sessionVolumeLb > 0) extra.push(`volume ${fmtNum(r.sessionVolumeLb)} lb`);
  if (isNum(r.workoutMin) && r.workoutMin > 0) extra.push(`${Math.round(r.workoutMin)} min training`);
  if (isNum(r.dayStrain)) extra.push(`WHOOP day strain ${fmtNum(r.dayStrain, 1)}`);
  if (isNum(r.workoutStrain)) extra.push(`workout strain ${fmtNum(r.workoutStrain, 1)}`);
  if (isNum(r.steps)) extra.push(`${fmtNum(r.steps)} steps`);
  const head = parts.length ? parts.join('; ') : (r.trainedStrength || r.trainedCardio) ? 'Workout tracked' : 'No training logged';
  return head + (extra.length ? '. ' + extra.join(', ') : '') + '.';
}

/** "Adaptive · TDEE 2,950 (medium confidence) + 300 kcal toward goal" from calorieTargets(). */
export function targetBasisText(t) {
  if (!t || !isNum(t.kcal)) return '';
  const surplus = isNum(t.surplus) ? t.surplus : null;
  const add = surplus == null ? '' : surplus > 0 ? ` + ${fmtNum(surplus)} kcal toward goal` : surplus < 0 ? ` − ${fmtNum(-surplus)} kcal` : ' at maintenance';
  if (t.basis === 'manual') return 'Manual target from Settings';
  if (t.basis === 'adaptive') {
    const conf = t.tdeeInfo && t.tdeeInfo.confidence ? ` (${t.tdeeInfo.confidence} confidence)` : '';
    return `Adaptive · TDEE ${fmtNum(t.tdee)}${conf}${add}`;
  }
  if (t.basis === 'estimate') return `Estimate · TDEE ≈ ${fmtNum(t.tdee)} (Mifflin–St Jeor × 1.55)${add}`;
  return '';
}

/** Tone for an intake meter: 'good' at/above target (kcal: within ±10%), 'warn' clearly over, null otherwise. */
export function intakeTone(key, value, target, { complete = false } = {}) {
  if (!isNum(value) || !isNum(target) || target <= 0) return null;
  const r = value / target;
  if (key === 'kcal') { if (r > 1.15) return 'warn'; if (r >= 0.9 && r <= 1.1) return 'good'; return complete && r < 0.9 ? 'warn' : null; }
  if (key === 'protein' || key === 'fiber') return r >= 0.95 ? 'good' : complete ? 'warn' : null;
  if (key === 'fat') return r > 1.3 ? 'warn' : null;
  return null;
}

/** Round a number for display in an input (grams whole, macros 0.1). */
export const roundFor = (key, v) => (isNum(v) ? round(v, key === 'grams' || key === 'kcal' ? 0 : 1) : null);
