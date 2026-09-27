// One DailyRow per date with every feature analytics needs (docs/ANALYTICS_API.md).
// Conventions: the sleep on date D is the night that ENDED on the morning of D;
// times are minutes after local midnight of D (bedtimeMin: after midnight of D−1);
// next* fields come from D+1. Unknown values are null, never 0.
import { addDays, dateRange, hmToMin, isNum, round } from '../core/util.js';
import { mergeIntervals, dowOf as dayOfWeek } from './dataview.js';
import { dayExecution } from './execution.js';
import { trendAt } from './body.js';
import { daysSinceDose, doseMgOn, kindAdherenceOn } from './protocols.js';
import { isWorkingSet } from './strength.js';

const STRENGTH_SPORT = /weight|strength|power|functional|crossfit|bodybuild|calisthenic/i;
const CARDIO_SPORT = /run|cycl|bik|spin|row|swim|walk|hik|ellipt|stair|cardio|ski|hiit|box|jog|triathlon|soccer|basketball|tennis|hockey|climb|dance|jump/i;
const num = (v) => (isNum(v) ? v : null);

// WHOOP fields for the night that ended on the morning of `date` (cheap; used for next*).
function nightPart(dv, date) {
  return dv.memo('daily:night:' + date, () => {
    const rec = dv.recovery(date), sl = dv.sleep(date), clock = dv.sleepClock(date);
    return {
      recovery: num(rec && rec.recovery), hrv: num(rec && rec.hrv), rhr: num(rec && rec.rhr),
      spo2: num(rec && rec.spo2), skinTempC: num(rec && rec.skinTempC), respRate: num(sl && sl.respRate),
      calibrating: rec && typeof rec.calibrating === 'boolean' ? rec.calibrating : null,
      sleepMin: num(sl && sl.asleepMin), sleepNeedMin: num(sl && sl.needMin), sleepPerf: num(sl && sl.performance),
      sleepEff: num(sl && sl.efficiency), sleepConsistency: num(sl && sl.consistency),
      deepMin: num(sl && sl.deepMin), remMin: num(sl && sl.remMin), lightMin: num(sl && sl.lightMin), awakeMin: num(sl && sl.awakeMin),
      disturbances: num(sl && sl.disturbances), bedtimeMin: clock.bedMin, wakeMin: clock.wakeMin,
    };
  });
}

function trainingPart(dv, date) {
  const wos = dv.workouts(date), sessions = dv.sessions(date), cycle = dv.cycle(date);
  const tracked = !!cycle || wos.length > 0 || sessions.length > 0 || !!dv.day(date);
  const whoopIds = new Set(wos.map((w) => w.id));
  const intervals = []; let lastEnd = null, strength = false, cardio = false, strainMax = null;
  for (const w of wos) {
    const s = dv.minutesAfter(w.start, date, w.tz), e = dv.minutesAfter(w.end, date, w.tz);
    if (s != null && e != null && e > s) intervals.push([s, e]);
    if (e != null && (lastEnd == null || e > lastEnd)) lastEnd = e;
    if (isNum(w.strain) && (strainMax == null || w.strain > strainMax)) strainMax = w.strain;
    if (STRENGTH_SPORT.test(w.sport || '')) strength = true; else if (CARDIO_SPORT.test(w.sport || '')) cardio = true;
  }
  let sets = 0, volume = 0, sessionMin = null, unlinked = 0;
  for (const s of sessions) {
    const a = dv.minutesAfter(s.startAt, date), b = dv.minutesAfter(s.endAt, date);
    if (a != null && b != null && b > a) {
      sessionMin = (sessionMin || 0) + (b - a);
      if (!s.whoopWorkoutId || !whoopIds.has(s.whoopWorkoutId)) { intervals.push([a, b]); if (lastEnd == null || b > lastEnd) lastEnd = b; }
    }
    if (!s.whoopWorkoutId || !whoopIds.has(s.whoopWorkoutId)) unlinked++;
    for (const e of s.entries || []) for (const set of (e && e.sets) || []) {
      if (!isWorkingSet(set)) continue;
      sets++; volume += (isNum(set.w) ? set.w : 0) * (isNum(set.reps) ? set.reps : 0); strength = true;
    }
    if ((s.cardio || []).length) cardio = true;
  }
  const workoutMin = intervals.length ? mergeIntervals(intervals).reduce((t, [a, b]) => t + (b - a), 0) : (tracked ? 0 : null);
  return {
    dayStrain: num(cycle && cycle.strain),
    kcalBurned: num(cycle && (isNum(cycle.kcal) ? cycle.kcal : isNum(cycle.kj) ? Math.round(cycle.kj / 4.184) : null)) ?? healthKcal(dv.health(date)),
    steps: num(cycle && cycle.steps) ?? num(dv.health(date)?.steps),
    avgHr: num(cycle && cycle.avgHr),
    workoutCount: tracked ? wos.length + unlinked : null,
    workoutStrain: strainMax,
    workoutMin,
    lastWorkoutEndMin: lastEnd,
    trainedStrength: tracked ? strength : null,
    trainedCardio: tracked ? cardio : null,
    sessionSets: sessions.length ? sets : tracked ? 0 : null,
    sessionVolumeLb: sessions.length ? round(volume, 0) : tracked ? 0 : null,
    sessionMin: sessionMin != null ? round(sessionMin, 0) : sessions.length ? null : tracked ? 0 : null,
  };
}
function healthKcal(h) { return h && isNum(h.activeKcal) && isNum(h.restingKcal) ? Math.round(h.activeKcal + h.restingKcal) : null; }

// Everything for `date` except fields that need the following day.
function basePart(dv, date) {
  return dv.memo('daily:base:' + date, () => {
    const dow = dayOfWeek(date);
    const night = nightPart(dv, date);
    const train = trainingPart(dv, date);
    const it = dv.intake(date);
    const t = it.complete ? it.totals : null;
    const day = dv.day(date);
    let caffeine = hmToMin(day && day.caffeineLastAt);
    if (caffeine != null && caffeine < 240) caffeine += 1440;
    const load = dv.eventLoad(date);
    const plan = dv.planSummary(date);
    const exec = dayExecution(dv, date);
    const judged = date <= dv.asOf() && exec.required.total > 0;
    return {
      date, dow, isWeekend: dow >= 5,
      ...night,
      ...train,
      kcalIn: t ? t.kcal : null, proteinG: t ? t.protein : null, carbsG: t ? t.carbs : null, fatG: t ? t.fat : null,
      fiberG: t ? t.fiber : null, sodiumMg: t ? t.sodium : null,
      mealsCount: it.count || null, firstMealMin: it.firstMin, lastMealMin: it.lastMin,
      caffeineLastMin: caffeine, alcohol: num(day && day.alcohol),
      deepWorkH: dv.deepWorkH(date),
      energy: num(day && day.energy), mood: num(day && day.mood), stress: num(day && day.stress),
      appetite: num(day && day.appetite), soreness: num(day && day.soreness), dayRating: num(day && day.dayRating),
      meetingMin: load ? load.meetingMin : null, meetingCount: load ? load.count : null,
      afterHoursMeetingMin: load ? load.afterHoursMin : null, longestFreeBlockMin: load ? load.longestFreeBlockMin : null,
      planMin: plan.plannedMin, planDoneMin: plan.doneMin, planAdherence: plan.adherence,
      executionScore: exec.score, requiredDone: judged ? exec.required.done : null,
      requiredTotal: judged ? exec.required.total : null, perfect: exec.perfect,
      weightLb: dv.weightOn(date), weightTrendLb: trendAt(dv, date),
      peptideDoseMg: doseMgOn(dv, date, 'peptide'), daysSinceDose: daysSinceDose(dv, date, 'peptide'),
      supplementAdherence: kindAdherenceOn(dv, date, 'supplement'),
    };
  });
}

// Field order follows docs/ANALYTICS_API.md.
const FIELDS = ['date', 'dow', 'isWeekend', 'recovery', 'hrv', 'rhr', 'spo2', 'skinTempC', 'respRate', 'calibrating', 'sleepMin', 'sleepNeedMin', 'sleepPerf', 'sleepEff', 'sleepConsistency', 'deepMin', 'remMin', 'lightMin', 'awakeMin', 'disturbances', 'bedtimeMin', 'wakeMin', 'dayStrain', 'kcalBurned', 'steps', 'avgHr', 'workoutCount', 'workoutStrain', 'workoutMin', 'lastWorkoutEndMin', 'trainedStrength', 'trainedCardio', 'sessionSets', 'sessionVolumeLb', 'sessionMin', 'kcalIn', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sodiumMg', 'mealsCount', 'firstMealMin', 'lastMealMin', 'lastMealToBedMin', 'caffeineLastMin', 'alcohol', 'deepWorkH', 'energy', 'mood', 'stress', 'appetite', 'soreness', 'dayRating', 'meetingMin', 'meetingCount', 'afterHoursMeetingMin', 'longestFreeBlockMin', 'planMin', 'planDoneMin', 'planAdherence', 'executionScore', 'requiredDone', 'requiredTotal', 'perfect', 'weightLb', 'weightTrendLb', 'peptideDoseMg', 'daysSinceDose', 'supplementAdherence', 'nextSleepMin', 'nextRecovery', 'nextHrv', 'nextRhr', 'nextSleepPerf', 'nextEnergy'];
export const DAILY_FIELDS = FIELDS;

export function dailyRow(dv, date) {
  return dv.memo('daily:row:' + date, () => {
    const base = basePart(dv, date);
    const nextDate = addDays(date, 1);
    const next = nightPart(dv, nextDate);
    const nextDay = dv.day(nextDate);
    // Bedtime of the night starting on the evening of `date` is next.bedtimeMin (minutes after midnight of `date`).
    const gap = isNum(next.bedtimeMin) && isNum(base.lastMealMin) ? next.bedtimeMin - base.lastMealMin : null;
    const all = {
      ...base,
      lastMealToBedMin: gap != null && gap >= 0 ? gap : null,
      nextSleepMin: next.sleepMin, nextRecovery: next.recovery, nextHrv: next.hrv, nextRhr: next.rhr,
      nextSleepPerf: next.sleepPerf, nextEnergy: num(nextDay && nextDay.energy),
    };
    const row = {}; for (const f of FIELDS) row[f] = all[f] === undefined ? null : all[f];
    return row;
  });
}

// Rows for every date in [from, to] (inclusive). Treat the rows as read-only.
export function buildDaily(dv, from, to) {
  if (!from || !to || from > to) return [];
  return dv.memo(`daily:range:${from}:${to}`, () => dateRange(from, to).map((d) => dailyRow(dv, d))).slice();
}
