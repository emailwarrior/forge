// Every public analytics function runs on demo data and returns the documented shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../js/core/store.js';
import { addDays, hmToMin } from '../../js/core/util.js';
import { loadDemo } from '../../js/dev/demo.js';
import * as A from '../../js/analytics/index.js';

const TODAY = '2026-09-26';
const store = createStore({ owner: 'app' });
loadDemo(store, { today: TODAY });
const dv = A.makeDataView(store, { today: TODAY });
const FROM = addDays(TODAY, -29);
const has = (obj, keys, label = '') => { assert.ok(obj && typeof obj === 'object', `${label} is an object`); for (const k of keys) assert.ok(k in obj, `${label} missing ${k}`); };
const each = (arr, keys, label) => { assert.ok(Array.isArray(arr), `${label} is an array`); for (const x of arr) has(x, keys, label); };

test('integration: daily rows and readiness', () => {
  const rows = A.buildDaily(dv, addDays(TODAY, -119), TODAY);
  assert.equal(rows.length, 120);
  for (const r of rows) assert.deepEqual(Object.keys(r), A.DAILY_FIELDS);
  assert.deepEqual(A.dailyRow(dv, TODAY), rows[rows.length - 1]);
  const r = A.readiness(dv, TODAY);
  has(r, ['date', 'status', 'band', 'score', 'metrics', 'drivers', 'training', 'focus', 'flags', 'summary'], 'readiness');
  has(r.metrics, ['recovery', 'hrv', 'hrvBase', 'hrvZ', 'rhr', 'rhrBase', 'rhrZ', 'sleepMin', 'sleepNeedMin', 'sleepDebtMin', 'sleepPerf', 'respRate', 'respDelta', 'skinTempDelta'], 'metrics');
  each(r.drivers, ['key', 'label', 'value', 'text', 'impact', 'weight'], 'driver');
  has(r.training, ['mode', 'label', 'detail', 'strainTarget'], 'training');
  has(r.focus, ['start', 'end', 'note'], 'focus');
  each(r.flags, ['level', 'text'], 'flag');
  assert.equal(r.status, 'ok'); assert.ok(['green', 'yellow', 'red'].includes(r.band));
  const b = A.baselines(rows, TODAY);
  for (const k of ['hrv', 'rhr', 'sleepMin', 'recovery', 'respRate', 'skinTempC']) has(b[k], ['mean', 'sd', 'n'], 'baseline ' + k);
});

test('integration: execution', () => {
  const std = dv.standards()[0];
  has(A.evaluateStandard(dv, std, TODAY), ['standard', 'applicable', 'value', 'display', 'done', 'source', 'target'], 'evaluateStandard');
  const d = A.dayExecution(dv, addDays(TODAY, -1));
  has(d, ['date', 'score', 'items', 'required', 'perfect', 'pending'], 'dayExecution');
  has(d.required, ['done', 'total'], 'required');
  assert.ok(d.score >= 0 && d.score <= 100);
  has(A.streaks(dv, TODAY), ['current', 'longest', 'lastPerfect'], 'streaks');
  each(A.adherenceByStandard(dv, FROM, TODAY), ['standard', 'applicableDays', 'doneDays', 'rate'], 'adherenceByStandard');
});

test('integration: body', () => {
  const series = A.weightTrend(dv.weighIns());
  each(series, ['date', 'weightLb', 'trendLb'], 'weightTrend');
  assert.equal(typeof A.rateLbPerWeek(series), 'number');
  has(A.estimateTdee(dv, TODAY), ['tdee', 'method', 'n', 'intakeAvg', 'trendDeltaLb', 'confidence'], 'estimateTdee');
  const t = A.calorieTargets(dv, TODAY);
  has(t, ['kcal', 'proteinG', 'fatG', 'carbsG', 'fiberG', 'basis', 'tdee', 'rationale'], 'calorieTargets');
  assert.equal(t.basis, 'adaptive'); assert.ok(t.kcal > 1500 && t.kcal < 6000);
  has(A.goalProjection(dv), ['currentTrendLb', 'goalLow', 'goalHigh', 'ratePerWeek', 'etaDate', 'weeksToGoal', 'onTrack', 'note'], 'goalProjection');
  has(A.bodySummary(dv, TODAY), ['weight', 'trend', 'change7', 'change28', 'rate28', 'tdee', 'targets', 'projection', 'series'], 'bodySummary');
});

test('integration: strength', () => {
  assert.equal(A.e1rm(100, 10), 133.3);
  each(A.exerciseHistory(dv, 'ex-bench-press'), ['date', 'sessionId', 'bestSet', 'e1rm', 'volume', 'sets', 'topW'], 'exerciseHistory');
  has(A.lastPerformance(dv, 'ex-bench-press', TODAY), ['date', 'sets'], 'lastPerformance');
  each(A.prs(dv, { since: FROM }), ['date', 'exerciseId', 'type', 'value', 'prev'], 'prs');
  each(A.weeklyMuscleVolume(dv, FROM, TODAY), ['week', 'muscle', 'hardSets', 'volumeLb'], 'weeklyMuscleVolume');
  has(A.progression(A.exerciseHistory(dv, 'ex-deadlift')), ['slopePctPerWeek', 'status', 'n'], 'progression');
  const s = A.strengthSummary(dv, TODAY);
  has(s, ['topLifts', 'recentPrs', 'weeklySets', 'sessions28'], 'strengthSummary');
  each(s.topLifts, ['exerciseId', 'name', 'e1rm', 'change28Pct', 'status'], 'topLift');
  each(A.cardioHistory(dv), ['date', 'exerciseId', 'durationMin', 'avgWatts', 'avgHr', 'efficiency', 'distanceMi', 'kcal'], 'cardioHistory');
});

test('integration: nutrition and protocols', () => {
  has(A.sumNutrients(dv.meals(TODAY)), ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium', 'vitD'], 'sumNutrients');
  const n = A.dayNutrition(dv, addDays(TODAY, -1));
  has(n, ['totals', 'mealCount', 'targets', 'remaining', 'pct', 'proteinPerMeal', 'firstMealAt', 'lastMealAt', 'lastMealToBedMin', 'flags'], 'dayNutrition');
  has(n.remaining, ['kcal', 'proteinG'], 'remaining'); has(n.pct, ['kcal', 'protein'], 'pct');
  each(n.proteinPerMeal, ['mealId', 'at', 'protein'], 'proteinPerMeal');
  has(A.nutritionAdherence(dv, FROM, TODAY), ['days', 'kcalHitRate', 'proteinHitRate', 'avgKcal', 'avgProtein', 'avgVsTarget'], 'nutrition adherence');
  each(A.microSummary(dv, FROM, TODAY), ['key', 'label', 'avg', 'unit', 'reference', 'pct'], 'microSummary');
  each(A.dueItems(dv, TODAY), ['item', 'due', 'doses'], 'dueItems');
  has(A.stackStatus(dv, TODAY, 'AM'), ['stack', 'items', 'complete'], 'stackStatus');
  each(A.protocolAdherence(dv, FROM, TODAY), ['item', 'scheduled', 'taken', 'rate'], 'protocol adherence');
  assert.match(A.nextDue(dv, 'p-pep', TODAY), /^\d{4}-\d{2}-\d{2}$/);
  const c = A.doseCycle(dv, 'p-pep', { from: FROM, to: TODAY });
  has(c, ['byDay', 'weeklyTotals', 'lastDose', 'nextDue', 'n'], 'doseCycle');
  each(c.byDay, ['daysSince', 'n', 'appetite', 'kcalIn', 'proteinG', 'hrv', 'rhr', 'recovery', 'sleepMin'], 'byDay');
  each(c.weeklyTotals, ['week', 'amount', 'unit'], 'weeklyTotals');
  assert.equal(A.nutrition.adherence, A.nutritionAdherence); assert.equal(A.protocols.adherence, A.protocolAdherence);
});

test('integration: labs, schedule, correlations, weekly, finance, context', () => {
  for (const [k, m] of Object.entries(A.MARKERS)) has(m, ['name', 'unit', 'aliases', 'category', 'lowerIsBetter'], 'marker ' + k);
  assert.equal(A.normalizeMarkerName('Vitamin D, 25-Hydroxy'), 'vitamin_d');
  each(A.markerSeries(dv, 'ldl'), ['date', 'value', 'unit', 'flag', 'refLow', 'refHigh'], 'markerSeries');
  const labs = A.labSummary(dv);
  has(labs, ['latest', 'flagged', 'changes', 'markers'], 'labSummary');
  each(labs.changes, ['key', 'name', 'from', 'to', 'pct'], 'changes');
  each(labs.markers, ['key', 'name', 'category', 'latest', 'series'], 'markers');
  assert.ok(Array.isArray(A.panelFlags(dv.labs()[0])));
  has(A.protocolBeforeAfter(dv, 'vitamin_d', 'p-d3'), ['before', 'after', 'delta'], 'protocolBeforeAfter');

  has(A.planVsActual(dv, addDays(TODAY, -1)), ['blocks', 'plannedMin', 'doneMin', 'adherence', 'byCategory'], 'planVsActual');
  each(A.timeAllocation(dv, FROM, TODAY), ['category', 'plannedMin', 'doneMin'], 'timeAllocation');
  has(A.calendarLoad(dv, addDays(TODAY, -1)), ['meetingMin', 'count', 'afterHoursMin', 'backToBack', 'longestFreeBlockMin', 'fragmentation', 'firstStart', 'lastEnd'], 'calendarLoad');
  each(A.timingTargets(dv, FROM, TODAY), ['key', 'label', 'target', 'avgActual', 'hitRate', 'n'], 'timingTargets');
  const plan = A.suggestDay(dv, addDays(TODAY, 2));
  has(plan, ['blocks', 'notes'], 'suggestDay');
  each(plan.blocks, ['start', 'end', 'title', 'category', 'reason'], 'suggested block');
  const busy = dv.eventBlocks(addDays(TODAY, 2));
  for (const b of plan.blocks) for (const e of busy) assert.ok(hmToMin(b.end) <= e.start || hmToMin(b.start) >= e.end, `${b.title} overlaps ${e.title}`);

  const rows = A.buildDaily(dv, addDays(TODAY, -119), TODAY);
  assert.ok(A.BEHAVIORS.length >= 15 && A.OUTCOMES.length === 8);
  const drivers = A.findDrivers(rows);
  each(drivers, ['behavior', 'outcome', 'method', 'effect', 'effectText', 'n', 'p', 'q', 'direction', 'strength', 'sentence'], 'driver');
  assert.ok(drivers.length > 0, 'demo data has planted associations');
  has(A.dataSufficiency(rows), ['days', 'pairedDays', 'readyAt', 'message'], 'dataSufficiency');

  const w = A.weekStats(dv, addDays(TODAY, -7));
  has(w, ['week', 'from', 'to', 'daysLogged', 'averages', 'deltas', 'best', 'worst', 'perfectDays', 'training', 'weightChange', 'adherence', 'highlights', 'focusCandidates'], 'weekStats');
  has(w.training, ['sessions', 'sets', 'prs'], 'weekStats.training'); has(w.adherence, ['protein', 'kcal', 'stack'], 'weekStats.adherence');
  each(w.focusCandidates, ['key', 'text', 'reason'], 'focusCandidate');

  assert.equal(A.equityFor(20000, { mult: 10, stake: 20, expense: 5000 }), 360000);
  has(A.netWorth(dv.snapshots()[0], dv.settings('finance')), ['total', 'equity', 'assets', 'liabilities', 'byCategory'], 'netWorth');
  each(A.netWorthSeries(dv), ['month', 'total', 'equity', 'assets', 'liabilities'], 'netWorthSeries');
  has(A.financeSummary(dv), ['latest', 'previous', 'delta', 'series'], 'financeSummary');

  const md = A.contextPack(dv, TODAY);
  assert.equal(typeof md, 'string'); assert.ok(md.length > 1000);
});

test('integration: analytics never write to the store; memoized results refresh on change', () => {
  const v = store.version;
  A.contextPack(dv, TODAY); A.weekStats(dv, TODAY); A.suggestDay(dv, TODAY);
  assert.equal(store.version, v); assert.deepEqual(store.dirty(), []);
  const before = A.dailyRow(dv, TODAY).mealsCount;
  store.create('meals', { date: TODAY, at: `${TODAY}T15:00:00-04:00`, status: 'ready', totals: { kcal: 100, protein: 5 } });
  assert.equal(A.dailyRow(dv, TODAY).mealsCount, before + 1);
});

test('integration: analytics sources stay pure (no DOM, network or wall-clock today)', () => {
  const dir = new URL('../../js/analytics/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '');
    for (const re of [/\bdocument\.[A-Za-z_$]/, /\bwindow\.[A-Za-z_$]/, /\bfetch\(/, /XMLHttpRequest/, /localStorage/, /Date\.now\(/, /new Date\(\)/]) assert.doesNotMatch(src, re, `${f} uses ${re}`);
  }
});

test('integration: a brand-new empty vault never throws and reports unknowns as null', () => {
  const empty = A.makeDataView(createStore({ owner: 'app' }), { today: TODAY, tz: 'UTC' });
  const from = addDays(TODAY, -6);
  const rows = A.buildDaily(empty, from, TODAY);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.recovery === null && r.kcalIn === null && r.executionScore === null));
  const r = A.readiness(empty); assert.equal(r.status, 'no-data'); assert.equal(r.band, null);
  assert.deepEqual(A.dayExecution(empty, TODAY).items, []);
  assert.deepEqual(A.streaks(empty), { current: 0, longest: 0, lastPerfect: null });
  assert.equal(A.estimateTdee(empty, TODAY).tdee, null);
  assert.equal(A.calorieTargets(empty, TODAY).kcal, null);
  assert.equal(A.goalProjection(empty).currentTrendLb, null);
  assert.equal(A.bodySummary(empty).weight, null);
  assert.deepEqual(A.strengthSummary(empty).topLifts, []);
  assert.equal(A.dayNutrition(empty, TODAY).totals.kcal, null);
  assert.equal(A.nutritionAdherence(empty, from, TODAY).days, 0);
  assert.deepEqual(A.dueItems(empty, TODAY), []);
  assert.deepEqual(A.protocolAdherence(empty, from, TODAY), []);
  assert.equal(A.doseCycle(empty, 'missing').n, 0);
  assert.equal(A.labSummary(empty).latest, null);
  assert.equal(A.planVsActual(empty, TODAY).adherence, null);
  assert.equal(A.calendarLoad(empty, TODAY).meetingMin, null);
  assert.ok(A.timingTargets(empty, from, TODAY).every((t) => t.avgActual === null && t.hitRate === null));
  assert.equal(A.suggestDay(empty, TODAY).basis, null);
  assert.deepEqual(A.findDrivers(rows), []);
  assert.equal(A.dataSufficiency(rows).pairedDays, 0);
  const w = A.weekStats(empty, TODAY); assert.equal(w.daysLogged, 0); assert.equal(w.averages.recovery, null);
  assert.equal(A.financeSummary(empty).latest, null);
  assert.match(A.contextPack(empty), /# FORGE context/);
});
