import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slotForMinutes, slotForHm, slotLabel, resolveCaptureTime, atFor, mealClock, autoGroup, mergeIntoPrevious, splitOut, removePhotoFrom,
  itemsTotals, scaleItem, kcalFromMacros, quickItem, macroLine, mealPhotos, hasEstimate, analyzable, mealTitle, mealState, nextTitle,
  analysisPatch, sortFoods, searchFoods, proteinPerMealRef, goalText, bodyTrendText, trainingText, targetBasisText, intakeTone,
} from '../../js/ui/parts/fuel-logic.js';
import { zonedToMs } from '../../js/core/util.js';

const TZ = 'America/New_York';

test('fuel: slot from time of day', () => {
  assert.equal(slotForMinutes(7 * 60 + 30), 'breakfast');
  assert.equal(slotForMinutes(10 * 60 + 29), 'breakfast');
  assert.equal(slotForMinutes(10 * 60 + 30), 'lunch');
  assert.equal(slotForMinutes(14 * 60 + 29), 'lunch');
  assert.equal(slotForMinutes(15 * 60 + 30), 'snack');
  assert.equal(slotForMinutes(19 * 60), 'dinner');
  assert.equal(slotForMinutes(21 * 60 + 30), 'snack');
  assert.equal(slotForMinutes(1 * 60), 'snack');
  assert.equal(slotForMinutes(1440 + 8 * 60), 'breakfast', 'wraps past midnight');
  assert.equal(slotForMinutes(null), 'snack');
  assert.equal(slotForHm('12:40'), 'lunch');
  assert.equal(slotLabel('pre'), 'Pre-workout');
  assert.equal(slotLabel('nope'), '');
});

test('fuel: capture time resolution — camera, EXIF, file name, file date, manual', () => {
  const now = zonedToMs('2026-09-26', '13:05', TZ);
  assert.deepEqual(resolveCaptureTime({ mode: 'camera', takenAt: '2026-09-20T08:00:00', now, tz: TZ }), { date: '2026-09-26', hm: '13:05', timeSource: 'camera', check: false });
  assert.deepEqual(resolveCaptureTime({ mode: 'library', takenAt: '2026-09-26T08:14:55', takenAtSource: 'exif', lastModified: now, now, tz: TZ }), { date: '2026-09-26', hm: '08:14', timeSource: 'exif', check: false });
  assert.deepEqual(resolveCaptureTime({ mode: 'files', takenAt: '2026-09-25T19:02:00', takenAtSource: 'filename', now, tz: TZ }), { date: '2026-09-25', hm: '19:02', timeSource: 'filename', check: false });
  const lm = zonedToMs('2026-09-26', '12:31', TZ);
  assert.deepEqual(resolveCaptureTime({ mode: 'library', takenAt: null, lastModified: lm, now, tz: TZ }), { date: '2026-09-26', hm: '12:31', timeSource: 'file', check: true });
  assert.deepEqual(resolveCaptureTime({ mode: 'library', now, tz: TZ, fallbackDate: '2026-09-24' }), { date: '2026-09-24', hm: '13:05', timeSource: 'manual', check: true });
  const future = resolveCaptureTime({ mode: 'library', takenAt: '2026-09-26T18:00:00', takenAtSource: 'exif', now, tz: TZ });
  assert.equal(future.check, true, 'a future EXIF time is flagged');
  assert.equal(resolveCaptureTime({ mode: 'library', takenAt: 'garbage', lastModified: lm, now, tz: TZ }).timeSource, 'file');
});

test('fuel: at instants and meal clock round-trip', () => {
  const at = atFor('2026-09-26', '07:05', TZ);
  assert.equal(at, '2026-09-26T07:05:00-04:00');
  assert.deepEqual(mealClock({ at, date: '2026-09-26' }, TZ), { date: '2026-09-26', hm: '07:05', min: 425 });
  assert.equal(atFor('2026-01-10', '19:30', TZ), '2026-01-10T19:30:00-05:00', 'DST offset');
  assert.deepEqual(mealClock({ at: '2026-09-26T23:30:00Z', date: '2026-09-26' }, TZ), { date: '2026-09-26', hm: '19:30', min: 1170 }, 'Z converts to the zone');
  assert.equal(mealClock({ date: '2026-09-26' }, TZ).hm, null);
});

test('fuel: auto-grouping keeps plate + label together and never groups unreliable times', () => {
  const photos = [
    { date: '2026-09-26', hm: '12:31', reliable: true },
    { date: '2026-09-26', hm: '08:02', reliable: true },
    { date: '2026-09-26', hm: '12:33', reliable: true },
    { date: '2026-09-26', hm: '12:50', reliable: true },
    { date: '2026-09-26', hm: '19:00', reliable: false },
    { date: '2026-09-26', hm: '19:00', reliable: false },
  ];
  assert.deepEqual(autoGroup(photos), [[1], [0, 2], [3], [4], [5]]);
  assert.deepEqual(autoGroup(photos, 20), [[1], [0, 2, 3], [4], [5]]);
  assert.deepEqual(autoGroup([{ date: '2026-09-25', hm: '23:58', reliable: true }, { date: '2026-09-26', hm: '00:03', reliable: true }]), [[0, 1]], 'across midnight');
  assert.deepEqual(autoGroup([]), []);
});

test('fuel: merge, split and remove photos in the review groups', () => {
  const g = [
    { key: 'a', photos: ['p1'], date: '2026-09-26', hm: '12:31', timeSource: 'exif', check: false, slot: 'lunch', slotAuto: true, note: 'extra oil' },
    { key: 'b', photos: ['p2'], date: '2026-09-26', hm: '12:20', timeSource: 'file', check: true, slot: 'lunch', slotAuto: true, note: 'label' },
    { key: 'c', photos: ['p3'], date: '2026-09-26', hm: '19:00', timeSource: 'exif', check: false, slot: 'dinner', slotAuto: false, note: '' },
  ];
  const m = mergeIntoPrevious(g, 1);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].photos, ['p1', 'p2']);
  assert.equal(m[0].hm, '12:20', 'earliest time wins'); assert.equal(m[0].timeSource, 'file'); assert.equal(m[0].check, true);
  assert.equal(m[0].note, 'extra oil; label');
  assert.equal(m[0].key, 'a');
  assert.equal(mergeIntoPrevious(g, 0), g, 'nothing above the first meal');
  const s = splitOut(m, 0, 'p2', { date: '2026-09-26', hm: '12:20', timeSource: 'file', check: true }, 'd');
  assert.deepEqual(s.map((x) => x.photos), [['p1'], ['p2'], ['p3']]);
  assert.equal(s[1].key, 'd'); assert.equal(s[1].slot, 'lunch'); assert.equal(s[1].note, '');
  assert.equal(splitOut(g, 0, 'p1', null, 'x'), g, 'a single photo cannot be split');
  const r = removePhotoFrom(m, 'p1');
  assert.deepEqual(r.map((x) => x.photos), [['p2'], ['p3']]);
  assert.deepEqual(removePhotoFrom(r, 'p2').map((x) => x.key), ['c'], 'empty meal dropped');
});

test('fuel: item totals omit unknown nutrients; scaling by servings', () => {
  const items = [{ name: 'A', grams: 100, kcal: 200, protein: 20.04, fat: 5 }, { name: 'B', grams: 50, kcal: 101, protein: 3.33, sodium: 120.4 }];
  const t = itemsTotals(items);
  assert.deepEqual(t, { kcal: 301, protein: 23.4, fat: 5, sodium: 120 });
  assert.deepEqual(itemsTotals([]), {});
  const s = scaleItem({ name: 'Shake', portion: '400 ml', grams: 400, kcal: 250, protein: 40, carbs: 10.25, vitD: 100 }, 1.5);
  assert.equal(s.grams, 600); assert.equal(s.kcal, 375); assert.equal(s.protein, 60); assert.equal(s.carbs, 15.4); assert.equal(s.vitD, 150);
  assert.equal(s.portion, '1.5 × 400 ml');
  assert.equal(scaleItem({ name: 'x', grams: 10, kcal: 10 }, 1).portion, undefined, 'factor 1 keeps the portion');
  assert.equal(scaleItem({ name: 'x', kcal: 10 }, 2).portion, '2 × serving');
});

test('fuel: quick add builds one item from typed numbers', () => {
  assert.equal(kcalFromMacros({ protein: 30, carbs: 40, fat: 10 }), 370);
  assert.equal(kcalFromMacros({}), null);
  const q = quickItem({ name: '  Protein bar ', kcal: null, protein: 20, carbs: 22, fat: 8 });
  assert.deepEqual(q, { name: 'Protein bar', portion: '1 serving', grams: 0, confidence: 'medium', basis: 'estimate', kcal: 240, protein: 20, carbs: 22, fat: 8 });
  assert.equal(quickItem({ kcal: 500 }).name, 'Quick add');
  assert.equal(quickItem({ kcal: 500 }).protein, undefined);
  assert.equal(quickItem({}), null);
  assert.equal(macroLine({ protein: 52.2, carbs: 6.44, fat: 18 }), 'P 52 · C 6.4 · F 18');
  assert.equal(macroLine({ protein: null }), 'P — · C — · F —');
  assert.equal(macroLine({ protein: 6, carbs: 0.04, fat: 9.96 }), 'P 6 · C 0 · F 10', 'no trailing .0');
});

test('fuel: meal helpers — photos, estimate, analyzable, title, state', () => {
  const photo = { path: 'media/meals/2026/09/m1-0.enc', w: 800, h: 600 };
  assert.deepEqual(mealPhotos({ photo, photos: [] }), [photo]);
  assert.deepEqual(mealPhotos({ photo, photos: [photo, { path: 'x' }] }).length, 2);
  assert.deepEqual(mealPhotos({}), []);
  assert.equal(hasEstimate({ totals: { kcal: 0 } }), true);
  assert.equal(hasEstimate({ totals: {} }), false);
  assert.equal(analyzable({ photo }), 'photo');
  assert.equal(analyzable({ source: 'text', note: '2 eggs' }), 'text');
  assert.equal(analyzable({ source: 'quick', note: 'bar' }), null);
  assert.equal(analyzable({ source: 'saved' }), null);
  assert.equal(mealTitle({ title: ' Steak & rice ' }), 'Steak & rice');
  assert.equal(mealTitle({ items: [{ name: 'Eggs' }, { name: 'Toast' }] }), 'Eggs, Toast');
  assert.equal(mealTitle({ items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] }), 'A, B +2');
  assert.equal(mealTitle({ source: 'text', note: '2 eggs, 2 slices sourdough, 1 tbsp butter and a large coffee with milk' }).length <= 48, true);
  assert.equal(mealTitle({ slot: 'lunch', note: 'extra oil', photo }), 'Lunch', 'a photo hint is not a title');
  assert.equal(mealTitle({ slot: 'lunch' }), 'Lunch');
  assert.equal(mealTitle(null), 'Meal');
  assert.equal(mealState({ status: 'analyzing' }, { status: 'running' }), 'analyzing');
  assert.equal(mealState({ status: 'analyzing' }, { status: 'queued' }), 'queued');
  assert.equal(mealState({ status: 'analyzing' }, null), 'interrupted');
  assert.equal(mealState({ status: 'analyzing' }, { status: 'done' }), 'interrupted');
  assert.equal(mealState({ status: 'pending' }, null), 'pending');
  assert.equal(mealState({ status: 'error' }, null), 'error');
  assert.equal(mealState({ status: 'ready' }, null), 'ready');
  assert.equal(mealState({}, null), 'ready');
});

test('fuel: a user-edited title survives re-analysis; the AI title is refreshed', () => {
  assert.equal(nextTitle({ title: '', ai: null }, 'Chicken bowl'), 'Chicken bowl');
  assert.equal(nextTitle({ title: 'Chicken bowl', ai: { title: 'Chicken bowl' } }, 'Chicken rice bowl'), 'Chicken rice bowl');
  assert.equal(nextTitle({ title: "Mom's lasagna", ai: { title: 'Lasagna' } }, 'Lasagna and salad'), "Mom's lasagna");
  assert.equal(nextTitle({ title: 'Keep', ai: null }, ''), 'Keep');
  const p = analysisPatch({ title: '' }, { items: [{ name: 'A', kcal: 100 }], totals: { kcal: 100 }, title: 'A plate', followUp: null, model: 'm', confidence: 'high', assumptions: ['x'], searched: true, sources: [{ title: 't', url: 'https://x' }], costUsd: 0.02, fallback: false }, '2026-09-26T12:00:00-04:00');
  assert.equal(p.status, 'ready'); assert.equal(p.error, null); assert.equal(p.title, 'A plate');
  assert.deepEqual(p.ai, { model: 'm', confidence: 'high', assumptions: ['x'], searched: true, sources: [{ title: 't', url: 'https://x' }], costUsd: 0.02, costEstimated: false, at: '2026-09-26T12:00:00-04:00', fallback: false, title: 'A plate', reference: null });
});

test('fuel: saved foods sort (favorites, uses, recency) and search (name or item names)', () => {
  const foods = [
    { id: 1, name: 'Oats', uses: 3, lastUsedAt: '2026-09-20' },
    { id: 2, name: 'Shake', uses: 30, lastUsedAt: '2026-09-25', items: [{ name: 'Whey protein' }, { name: 'Banana' }] },
    { id: 3, name: 'Bowl', uses: 3, lastUsedAt: '2026-09-24', favorite: true },
    { id: 4, name: 'Apple', uses: 3, lastUsedAt: '2026-09-24' },
  ];
  assert.deepEqual(sortFoods(foods).map((f) => f.id), [3, 2, 4, 1]);
  assert.deepEqual(searchFoods(foods, 'whey').map((f) => f.id), [2]);
  assert.deepEqual(searchFoods(foods, 'shake banana').map((f) => f.id), [2]);
  assert.deepEqual(searchFoods(foods, '  ').length, 4);
  assert.deepEqual(searchFoods(foods, 'zzz'), []);
});

test('fuel: review context texts', () => {
  assert.equal(proteinPerMealRef(176.4), 32);
  assert.equal(proteinPerMealRef(null), null);
  const profile = { goalWeightLow: 170, goalWeightHigh: 180, goalRateLbWk: 0.3 };
  assert.equal(goalText(profile, 164), 'gain body weight toward 170–180 lb at about 0.3 lb/week');
  assert.equal(goalText(profile, 175), 'maintain body weight within 170–180 lb');
  assert.equal(goalText(profile, 186), 'reduce body weight toward 170–180 lb');
  assert.equal(goalText({}, 180), '');
  assert.equal(goalText({ goalWeightLow: 170 }, null), 'body weight at least 170 lb');
  assert.equal(bodyTrendText({ trend: 164.44, rate28: 0.28, change7: 0.1 }, profile), 'trend 164.4 lb; 28-day rate +0.28 lb/wk; 7-day change +0.1 lb; goal: gain body weight toward 170–180 lb at about 0.3 lb/week');
  assert.equal(bodyTrendText({}, {}), '');
  const sessions = [{ name: 'Push day', entries: [{ sets: [{ done: true }, { done: true }, { done: false }] }, { sets: [{}] }], cardio: [{ durationMin: 25 }] }];
  assert.equal(trainingText(sessions, { sessionVolumeLb: 14320, workoutMin: 62, dayStrain: 14.23, workoutStrain: 12.1, steps: 9876 }),
    'Push day (3 sets, 25 min cardio). volume 14,320 lb, 62 min training, WHOOP day strain 14.2, workout strain 12.1, 9,876 steps.');
  assert.equal(trainingText([], {}), 'No training logged.');
  assert.equal(trainingText([], { trainedCardio: true, dayStrain: 9 }), 'Workout tracked. WHOOP day strain 9.0.');
});

test('fuel: target basis text and meter tones', () => {
  assert.equal(targetBasisText({ kcal: 3250, basis: 'adaptive', tdee: 2950, surplus: 300, tdeeInfo: { confidence: 'medium' } }), 'Adaptive · TDEE 2,950 (medium confidence) + 300 kcal toward goal');
  assert.equal(targetBasisText({ kcal: 2950, basis: 'adaptive', tdee: 2950, surplus: 0, tdeeInfo: { confidence: 'high' } }), 'Adaptive · TDEE 2,950 (high confidence) at maintenance');
  assert.equal(targetBasisText({ kcal: 3000, basis: 'manual' }), 'Manual target from Settings');
  assert.equal(targetBasisText({ kcal: 2900, basis: 'estimate', tdee: 2650, surplus: 250 }), 'Estimate · TDEE ≈ 2,650 (Mifflin–St Jeor × 1.55) + 250 kcal toward goal');
  assert.equal(targetBasisText({ kcal: null }), '');
  assert.equal(intakeTone('kcal', 3000, 3000), 'good');
  assert.equal(intakeTone('kcal', 3600, 3000), 'warn');
  assert.equal(intakeTone('kcal', 1500, 3000), null, 'in progress: under is not a warning');
  assert.equal(intakeTone('kcal', 1500, 3000, { complete: true }), 'warn');
  assert.equal(intakeTone('protein', 190, 190), 'good');
  assert.equal(intakeTone('protein', 100, 190), null);
  assert.equal(intakeTone('fat', 130, 90), 'warn');
  assert.equal(intakeTone('carbs', 500, 300), null);
  assert.equal(intakeTone('kcal', 100, null), null);
});
