// FORGE v3 schema: collections, shard paths, settings defaults, seed data.
// See docs/ARCHITECTURE.md §5–6. No personal data or personal defaults belong in this file.
import { slug } from './util.js';

export const SCHEMA = 3;

// period: 'none' | 'year' | 'month'; owners: which parties may write shards.
export const COLLECTIONS = {
  settings:       { period: 'none',  owners: ['app'] },
  standards:      { period: 'none',  owners: ['app'] },
  checks:         { period: 'year',  owners: ['app'] },
  days:           { period: 'year',  owners: ['app'] },
  journal:        { period: 'year',  owners: ['app'] },
  savedQuotes:    { period: 'none',  owners: ['app'] },
  exercises:      { period: 'none',  owners: ['app'] },
  templates:      { period: 'none',  owners: ['app'] },
  sessions:       { period: 'month', owners: ['app'] },
  meals:          { period: 'month', owners: ['app', 'server'] },
  foods:          { period: 'none',  owners: ['app'] },
  protocolItems:  { period: 'none',  owners: ['app'] },
  doses:          { period: 'year',  owners: ['app'] },
  body:           { period: 'year',  owners: ['app'] },
  health:         { period: 'year',  owners: ['app'] },
  labs:           { period: 'year',  owners: ['app'] },
  plan:           { period: 'month', owners: ['app'] },
  reviews:        { period: 'year',  owners: ['app', 'server'] },
  pushSubs:       { period: 'none',  owners: ['app'] },
  snapshots:      { period: 'none',  owners: ['app'] },
  whoopCycles:    { period: 'year',  owners: ['server'] },
  whoopRecovery:  { period: 'year',  owners: ['server'] },
  whoopSleep:     { period: 'year',  owners: ['server'] },
  whoopWorkouts:  { period: 'year',  owners: ['server'] },
  whoopBody:      { period: 'none',  owners: ['server'] },
  calendarEvents: { period: 'month', owners: ['server'] },
  calendarMap:    { period: 'none',  owners: ['server'] },
  pushLog:        { period: 'year',  owners: ['server'] },
  status:         { period: 'none',  owners: ['server'] },
  secrets:        { period: 'none',  owners: ['server'] },
};

export const DATA_ROOT = 'forge';
export const KEYRING_PATH = 'forge/keyring.json';
export const META_PATH = 'forge/meta.json';
export const SHARD_EXT = '.enc';

export function collectionDef(name) {
  const d = COLLECTIONS[name];
  if (!d) throw new Error('Unknown collection: ' + name);
  return d;
}

// Period key of a record for its collection ('' for single-file collections).
export function periodOf(name, rec) {
  const { period } = collectionDef(name);
  if (period === 'none') return '';
  const date = rec && typeof rec.date === 'string' ? rec.date : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return period === 'year' ? '0000' : '0000-00';
  return period === 'year' ? date.slice(0, 4) : date.slice(0, 7);
}

export function shardPath(name, owner, period) {
  const base = `${DATA_ROOT}/${owner}/${name}`;
  return (period ? `${base}/${period}` : base) + SHARD_EXT;
}

// Inverse of shardPath: returns { name, owner, period } or null for non-shard paths.
export function parseShardPath(path) {
  const m = /^forge\/(app|server)\/([A-Za-z]+)(?:\/(\d{4}(?:-\d{2})?))?\.enc$/.exec(path);
  if (!m || !COLLECTIONS[m[2]]) return null;
  return { owner: m[1], name: m[2], period: m[3] || '' };
}

export const MEDIA_ROOT = 'media';
export function mediaPath(kind, date, id, ext = 'enc') {
  const d = date || '0000-00-00';
  return `${MEDIA_ROOT}/${kind}/${d.slice(0, 4)}/${d.slice(5, 7)}/${id}.${ext}`;
}

/* ------------------------------------------------------------ settings */
export const SETTINGS_DEFAULTS = {
  profile: {
    name: '', heightIn: null, birthYear: null, sex: 'male', timezone: '', units: 'imperial',
    goalWeightLow: null, goalWeightHigh: null, goalRateLbWk: 0.3,
  },
  targets: {
    mode: 'adaptive', kcal: null, proteinG: null, proteinPerLb: 0.9, fatPct: 27, fiberG: 35,
    surplusKcal: 250, wake: '06:30', bedtime: '22:30', caffeineCutoff: '12:00', lastMealBy: '20:00',
    sleepTargetH: 8, deepWorkTargetH: 4, trainingWindow: { start: '16:00', end: '19:00' },
  },
  nutritionRules: { rules: [] },
  finance: { mult: 10, stake: 0, expense: 0 },
  integrations: {
    whoop: { clientId: '', connectedAt: null },
    gcal: { saEmail: '', readCalendars: [], forgeCalendarId: '', pushPlan: true, pushReminders: true },
    push: { vapidPublicKey: '' },
    ai: { model: 'claude-sonnet-5', fastModel: 'claude-haiku-4-5-20251001', effort: 'medium', webLookup: true, serverReviews: false },
  },
  notifications: {
    morningBrief: true, eveningCheckinAt: '21:30', weeklyReview: true, doseReminders: true,
    quietStart: '22:45', quietEnd: '06:00',
  },
  ui: { theme: 'system', startScreen: 'today' },
  security: { lockMode: 'device', autoLockMin: 0 },
};

export const STANDARD_CATEGORIES = ['Discipline', 'Body', 'Nutrition', 'Mind', 'Work', 'Recovery', 'Hygiene'];
export const PLAN_CATEGORIES = [
  { id: 'deep', label: 'Deep work' }, { id: 'meeting', label: 'Meetings' }, { id: 'admin', label: 'Admin' },
  { id: 'training', label: 'Training' }, { id: 'meal', label: 'Meals' }, { id: 'recovery', label: 'Recovery' },
  { id: 'learning', label: 'Learning' }, { id: 'personal', label: 'Personal' }, { id: 'commute', label: 'Commute' },
];
export const MUSCLES = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'quads', 'hamstrings', 'glutes', 'calves', 'core', 'traps', 'full'];
export const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'satFat', 'sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'vitC', 'vitD'];
export const NUTRIENT_UNITS = { kcal: 'kcal', protein: 'g', carbs: 'g', fat: 'g', fiber: 'g', sugar: 'g', satFat: 'g', sodium: 'mg', potassium: 'mg', calcium: 'mg', iron: 'mg', magnesium: 'mg', vitC: 'mg', vitD: 'IU' };

/* ---------------------------------------------------------------- seeds */
// Default daily standards for a brand-new vault (no v2 data). Generic, editable.
export function seedStandards() {
  const all = [0, 1, 2, 3, 4, 5, 6];
  const s = (id, name, category, kind, extra = {}) => ({
    id, name, category, kind, weight: 2, required: true, days: all, active: true, effectiveFrom: '1970-01-01', ...extra,
  });
  return [
    s('std-wake', 'Wake on time', 'Discipline', 'time', { target: { op: '<=', value: 'target' }, auto: 'whoop.wake', weight: 3, order: 1 }),
    s('std-plan', 'Execute the plan', 'Work', 'number', { target: { op: '>=', value: 90, unit: '%' }, auto: 'plan.adherence', weight: 3, order: 2 }),
    s('std-deep', 'Deep work', 'Work', 'number', { target: { op: '>=', value: 'target', unit: 'h' }, auto: 'day.deepWork', weight: 3, order: 3 }),
    s('std-train', 'Train', 'Body', 'check', { auto: 'training.session', weight: 3, order: 4, days: [0, 1, 2, 3, 4, 5] }),
    s('std-protein', 'Hit protein', 'Nutrition', 'number', { target: { op: '>=', value: 'target', unit: 'g' }, auto: 'nutrition.protein', order: 5 }),
    s('std-meals', 'Eat 3+ meals', 'Nutrition', 'number', { target: { op: '>=', value: 3 }, auto: 'nutrition.meals', order: 6 }),
    s('std-stack', 'Morning stack', 'Nutrition', 'check', { auto: 'protocol.stack:AM', order: 7 }),
    s('std-caffeine', 'Caffeine before cutoff', 'Recovery', 'avoid', { auto: 'day.caffeineCutoff', weight: 1, required: false, order: 8 }),
    s('std-read', 'Read', 'Mind', 'duration', { target: { op: '>=', value: 30, unit: 'min' }, weight: 2, order: 9 }),
  ];
}

// Exercise library (generic).
const EX = [
  ['Bench Press', 'chest', ['triceps', 'shoulders'], 'barbell'],
  ['Incline Bench Press', 'chest', ['shoulders', 'triceps'], 'barbell'],
  ['Dumbbell Bench Press', 'chest', ['triceps', 'shoulders'], 'dumbbell'],
  ['Incline Dumbbell Press', 'chest', ['shoulders', 'triceps'], 'dumbbell'],
  ['Cable Fly', 'chest', [], 'cable'],
  ['Machine Chest Press', 'chest', ['triceps'], 'machine'],
  ['Dips', 'chest', ['triceps', 'shoulders'], 'bodyweight', true],
  ['Push-up', 'chest', ['triceps'], 'bodyweight', true],
  ['Deadlift', 'back', ['hamstrings', 'glutes', 'traps'], 'barbell'],
  ['Pull-up', 'back', ['biceps'], 'bodyweight', true],
  ['Chin-up', 'back', ['biceps'], 'bodyweight', true],
  ['Lat Pulldown', 'back', ['biceps'], 'cable'],
  ['Barbell Row', 'back', ['biceps', 'traps'], 'barbell'],
  ['Dumbbell Row', 'back', ['biceps'], 'dumbbell'],
  ['Seated Cable Row', 'back', ['biceps'], 'cable'],
  ['T-Bar Row', 'back', ['biceps'], 'barbell'],
  ['Face Pull', 'shoulders', ['traps'], 'cable'],
  ['Overhead Press', 'shoulders', ['triceps'], 'barbell'],
  ['Dumbbell Shoulder Press', 'shoulders', ['triceps'], 'dumbbell'],
  ['Lateral Raise', 'shoulders', [], 'dumbbell'],
  ['Rear Delt Fly', 'shoulders', ['traps'], 'dumbbell'],
  ['Shrug', 'traps', [], 'dumbbell'],
  ['Back Squat', 'quads', ['glutes', 'hamstrings'], 'barbell'],
  ['Front Squat', 'quads', ['glutes', 'core'], 'barbell'],
  ['Leg Press', 'quads', ['glutes'], 'machine'],
  ['Hack Squat', 'quads', ['glutes'], 'machine'],
  ['Bulgarian Split Squat', 'quads', ['glutes'], 'dumbbell'],
  ['Walking Lunge', 'quads', ['glutes'], 'dumbbell'],
  ['Leg Extension', 'quads', [], 'machine'],
  ['Romanian Deadlift', 'hamstrings', ['glutes', 'back'], 'barbell'],
  ['Lying Leg Curl', 'hamstrings', [], 'machine'],
  ['Seated Leg Curl', 'hamstrings', [], 'machine'],
  ['Hip Thrust', 'glutes', ['hamstrings'], 'barbell'],
  ['Standing Calf Raise', 'calves', [], 'machine'],
  ['Seated Calf Raise', 'calves', [], 'machine'],
  ['Barbell Curl', 'biceps', ['forearms'], 'barbell'],
  ['Dumbbell Curl', 'biceps', ['forearms'], 'dumbbell'],
  ['Hammer Curl', 'biceps', ['forearms'], 'dumbbell'],
  ['Preacher Curl', 'biceps', [], 'machine'],
  ['Cable Curl', 'biceps', [], 'cable'],
  ['Triceps Pushdown', 'triceps', [], 'cable'],
  ['Overhead Triceps Extension', 'triceps', [], 'cable'],
  ['Skull Crusher', 'triceps', [], 'barbell'],
  ['Close-Grip Bench Press', 'triceps', ['chest'], 'barbell'],
  ['Hanging Leg Raise', 'core', [], 'bodyweight', true],
  ['Cable Crunch', 'core', [], 'cable'],
  ['Ab Wheel', 'core', [], 'bodyweight', true],
  ['Plank', 'core', [], 'bodyweight', true],
];
const CARDIO = ['Stationary Bike', 'Assault Bike', 'Treadmill Run', 'Incline Walk', 'Outdoor Run', 'Rower', 'Stair Climber', 'Elliptical', 'Swim'];

export function seedExercises() {
  const out = EX.map(([name, muscle, secondary, equipment, bw]) => ({
    id: 'ex-' + slug(name), name, muscle, secondary, equipment, type: 'strength', bodyweight: !!bw,
  }));
  for (const name of CARDIO) out.push({ id: 'ex-' + slug(name), name, muscle: 'full', secondary: [], equipment: 'cardio', type: 'cardio', bodyweight: false });
  return out;
}
