import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayOfWeek } from '../../js/core/util.js';
import { findDrivers, dataSufficiency, BEHAVIORS, OUTCOMES } from '../../js/analytics/correlations.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (R) => { let u = 0; while (!u) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); };
const U = (R, lo, hi) => lo + R() * (hi - lo);

// Synthetic DailyRows where every behavior and outcome is independent noise.
function noiseRows(n, R, start = '2026-01-05') {
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(start, i); const dow = dayOfWeek(date);
    return {
      date, dow, isWeekend: dow >= 5,
      lastMealToBedMin: U(R, 60, 300), lastMealMin: U(R, 1080, 1320), caffeineLastMin: U(R, 480, 900), alcohol: R() < 0.3 ? 2 : 0,
      bedtimeMin: U(R, 1320, 1500), workoutCount: 1, lastWorkoutEndMin: U(R, 900, 1260), dayStrain: U(R, 6, 18),
      kcalIn: 3000 + 300 * gauss(R), proteinG: 180 + 20 * gauss(R), carbsG: 350 + 50 * gauss(R), deepWorkH: U(R, 0, 6),
      meetingMin: U(R, 0, 240), afterHoursMeetingMin: R() < 0.25 ? U(R, 15, 60) : 0, daysSinceDose: i % 7, sleepMin: 450 + 40 * gauss(R),
      nextRecovery: 55 + 15 * gauss(R), nextHrv: 60 + 8 * gauss(R), nextRhr: 55 + 3 * gauss(R), nextSleepMin: 450 + 40 * gauss(R),
      nextSleepPerf: 85 + 8 * gauss(R), nextEnergy: 1 + Math.floor(R() * 5), executionScore: 70 + 15 * gauss(R),
    };
  });
}
const find = (drivers, b, o) => drivers.find((d) => d.behavior === b && d.outcome === o);

test('correlations: catalogs cover the documented behaviors and outcomes', () => {
  const b = BEHAVIORS.map((x) => x.key);
  for (const k of ['lastMealToBedMin', 'lastMealMin', 'caffeineLastMin', 'alcohol', 'bedtimeMin', 'lateWorkout', 'dayStrain', 'kcalIn', 'proteinG', 'carbsG', 'deepWorkH', 'meetingMin', 'afterHoursMeetingMin', 'daysSinceDose', 'sleepMin']) assert.ok(b.includes(k), k);
  assert.deepEqual(OUTCOMES.map((o) => o.key), ['nextRecovery', 'nextHrv', 'nextRhr', 'nextSleepMin', 'nextSleepPerf', 'nextEnergy', 'deepWorkH', 'executionScore']);
  assert.equal(OUTCOMES.find((o) => o.key === 'nextRhr').lowerIsBetter, true);
  // trivial pairs are never tested
  assert.ok(!BEHAVIORS.find((x) => x.key === 'sleepMin').outcomes.includes('nextSleepMin'));
});

test('correlations: detects planted effects with correct direction and phrasing', () => {
  const R = rng(42);
  const rows = noiseRows(90, R);
  for (const r of rows) {
    r.nextHrv = 60 + 6 * gauss(R) - (r.alcohol > 0 ? 10 : 0);                        // binary, hurts
    r.nextRecovery = 50 + 0.08 * (r.lastMealToBedMin - 180) + 8 * gauss(R);          // continuous, helps
    r.nextRhr = 55 + 0.012 * (r.caffeineLastMin - 690) + 1.5 * gauss(R);             // later caffeine → higher RHR (lower is better)
  }
  const drivers = findDrivers(rows);
  const alc = find(drivers, 'alcohol', 'nextHrv');
  assert.ok(alc, 'alcohol → HRV found');
  assert.equal(alc.method, 'welch'); assert.equal(alc.direction, 'hurts'); assert.equal(alc.strength, 'strong');
  assert.ok(alc.effect < -6 && alc.effect > -14, String(alc.effect));
  assert.match(alc.sentence, /^Days with alcohol are associated with −\d+ ms HRV next morning \(n=\d+, q[=<][\d.]+\)\.$/);
  const meal = find(drivers, 'lastMealToBedMin', 'nextRecovery');
  assert.ok(meal, 'meal timing → recovery found');
  assert.equal(meal.method, 'spearman'); assert.equal(meal.direction, 'helps'); assert.ok(meal.rho > 0.35);
  assert.match(meal.sentence, /^Nights with your last meal ≥[\d.]+h before bed are associated with \+\d+ pts recovery next morning \(n=\d+, q[=<][\d.]+\)\.$/);
  const caf = find(drivers, 'caffeineLastMin', 'nextRhr');
  assert.ok(caf && caf.direction === 'hurts' && caf.effect > 0, 'higher RHR is worse');
  for (const d of drivers) {
    assert.ok(d.q <= 0.1 && d.p <= d.q + 1e-12);
    assert.match(d.sentence, /are associated with/); assert.doesNotMatch(d.sentence, /\b(causes?|because|leads? to)\b/i);
    assert.ok(['weak', 'moderate', 'strong'].includes(d.strength));
  }
  const tiers = drivers.map((d) => ({ strong: 3, moderate: 2, weak: 1 }[d.strength]));
  assert.deepEqual(tiers, [...tiers].sort((a, b) => b - a), 'sorted by strength');
});

test('correlations: pure noise rarely yields findings at q ≤ 0.1', () => {
  let seedsWithFindings = 0;
  for (let seed = 1; seed <= 20; seed++) if (findDrivers(noiseRows(90, rng(seed))).length) seedsWithFindings++;
  assert.ok(seedsWithFindings <= 4, `${seedsWithFindings}/20 noise seeds produced findings`);
});

test('correlations: night-aligned behaviors pair the right night with the outcome', () => {
  const R = rng(7);
  const rows = noiseRows(90, R);
  // nextRecovery(D) is driven by the bedtime of the night D→D+1, i.e. rows[i+1].bedtimeMin.
  for (let i = 0; i < rows.length - 1; i++) rows[i].nextRecovery = 60 - 0.15 * (rows[i + 1].bedtimeMin - 1410) + 5 * gauss(R);
  rows[rows.length - 1].nextRecovery = null;
  const d = find(findDrivers(rows), 'bedtimeMin', 'nextRecovery');
  assert.ok(d && d.direction === 'hurts', 'later bedtime → lower recovery the next morning');
  assert.match(d.sentence, /^Nights with bedtime (at or )?after \d+:\d\d [AP]M are associated with −\d+ pts recovery next morning/);
});

test('correlations: weekday/weekend confounds are stratified out', () => {
  const R = rng(11);
  const rows = noiseRows(120, R);
  for (const r of rows) { // meetings and deep work both only happen on weekdays, independently
    r.meetingMin = r.isWeekend ? 0 : 60 + 120 * R();
    r.deepWorkH = r.isWeekend ? 0.5 * R() : 2 + 3 * R();
  }
  assert.ok(find(findDrivers(rows, { stratify: false }), 'meetingMin', 'deepWorkH'), 'naive test is fooled');
  assert.equal(find(findDrivers(rows), 'meetingMin', 'deepWorkH'), undefined);
});

test('correlations: minimum sample sizes are enforced', () => {
  const R = rng(3);
  const small = noiseRows(15, R);
  for (const r of small) r.nextHrv = 60 - (r.alcohol ? 20 : 0) + gauss(R);
  assert.deepEqual(findDrivers(small), [], 'fewer than 21 paired days');
  const rare = noiseRows(90, rng(5));
  rare.forEach((r, i) => { r.alcohol = i < 5 ? 3 : 0; r.nextHrv = 60 - (r.alcohol ? 25 : 0) + gauss(R); });
  assert.equal(find(findDrivers(rare), 'alcohol', 'nextHrv'), undefined, 'binary needs ≥ 7 days per group');
});

test('correlations: dataSufficiency', () => {
  const rows = noiseRows(10, rng(9));
  const s = dataSufficiency(rows);
  assert.equal(s.days, 10); assert.equal(s.pairedDays, 10);
  assert.equal(s.readyAt, addDays(rows[9].date, 11));
  assert.match(s.message, /10 of 21/);
  const ready = dataSufficiency(noiseRows(40, rng(9)));
  assert.equal(ready.pairedDays, 40); assert.equal(ready.readyAt, addDays('2026-01-05', 20));
  assert.deepEqual(dataSufficiency([]), { days: 0, pairedDays: 0, readyAt: null, minN: 21, message: '0 of 21 paired days logged — patterns unlock after 21 more days of logs.' });
});
