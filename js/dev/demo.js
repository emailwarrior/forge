// Deterministic synthetic data for demo mode, UI smoke tests and analytics tests.
// Generic values only — nothing here describes the real user.
import { makeRecord } from '../core/merge.js';
import { shardPath, periodOf, seedStandards, seedExercises } from '../core/schema.js';
import { addDays, dayOfWeek, dateRange, minToHm, pad2, zonedToMs, isoWithOffset, hashId, round } from '../core/util.js';

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const FOODS = [
  { name: 'Eggs & toast', items: [['Eggs (3 large)', 150, 216, 19, 1, 15, 0], ['Sourdough toast (2 slices)', 100, 260, 9, 50, 2, 3]] },
  { name: 'Overnight oats', items: [['Rolled oats', 80, 300, 11, 54, 5, 8], ['Greek yogurt', 170, 150, 20, 9, 4, 0], ['Blueberries', 75, 43, 0.5, 11, 0.2, 2]] },
  { name: 'Protein shake', items: [['Whey protein (2 scoops)', 64, 240, 48, 6, 3, 1], ['Whole milk', 240, 150, 8, 12, 8, 0], ['Banana', 118, 105, 1.3, 27, 0.4, 3]] },
  { name: 'Chicken rice bowl', items: [['Grilled chicken breast', 200, 330, 62, 0, 7, 0], ['White rice', 250, 325, 6, 71, 0.7, 1], ['Avocado (half)', 70, 112, 1.4, 6, 10, 5]] },
  { name: 'Salmon & potatoes', items: [['Salmon fillet', 200, 412, 40, 0, 27, 0], ['Roasted potatoes', 250, 230, 5, 44, 5, 5], ['Broccoli', 150, 51, 4, 10, 0.6, 5]] },
  { name: 'Steak & rice', items: [['Sirloin steak', 250, 480, 68, 0, 22, 0], ['Jasmine rice', 250, 325, 6, 71, 0.7, 1], ['Green beans', 120, 37, 2, 8, 0.2, 3]] },
  { name: 'Burrito bowl', items: [['Chicken burrito bowl', 550, 780, 55, 80, 26, 14]] },
  { name: 'Greek yogurt & granola', items: [['Greek yogurt', 250, 220, 25, 13, 6, 0], ['Granola', 50, 225, 5, 32, 9, 3]] },
];
const TRAIN = {
  Push: [['ex-bench-press', 185, 6], ['ex-incline-dumbbell-press', 65, 10], ['ex-overhead-press', 115, 8], ['ex-lateral-raise', 25, 15], ['ex-triceps-pushdown', 60, 12]],
  Pull: [['ex-deadlift', 315, 5], ['ex-pull-up', 0, 10], ['ex-barbell-row', 175, 8], ['ex-face-pull', 50, 15], ['ex-dumbbell-curl', 35, 12]],
  Legs: [['ex-back-squat', 245, 6], ['ex-romanian-deadlift', 205, 10], ['ex-leg-press', 400, 12], ['ex-lying-leg-curl', 100, 12], ['ex-standing-calf-raise', 180, 15]],
};
const SPLIT = ['Push', 'Pull', 'Legs', 'Push', 'Pull', 'Legs', null]; // Mon..Sun

export function generateDemo({ today, days = 120, seed = 7, tz = 'America/New_York' } = {}) {
  const R = rng(seed); const n = (lo, hi) => lo + R() * (hi - lo); const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const shards = new Map(); const T0 = Date.parse(today + 'T00:00:00Z') - days * 86400000;
  const add = (coll, owner, fields, t = T0) => {
    const r = makeRecord(fields.id, fields, t); const path = shardPath(coll, owner, periodOf(coll, r));
    if (!shards.has(path)) shards.set(path, { r: {} }); shards.get(path).r[r.id] = r; return r;
  };
  const at = (date, hm) => isoWithOffset(zonedToMs(date, hm, tz), tz);
  const start = addDays(today, -(days - 1));

  add('settings', 'app', { id: 'profile', name: 'Demo', heightIn: 70, timezone: tz, goalWeightLow: 170, goalWeightHigh: 180, goalRateLbWk: 0.3, birthYear: 1994 });
  add('settings', 'app', { id: 'finance', mult: 10, stake: 20, expense: 5000 });
  add('settings', 'app', { id: 'integrations', whoop: { clientId: 'demo', connectedAt: at(start, '09:00') }, gcal: { saEmail: 'demo@example.iam.gserviceaccount.com', readCalendars: ['primary'], forgeCalendarId: 'forge', pushPlan: true, pushReminders: true } });
  add('settings', 'app', { id: 'nutritionRules', rules: [{ id: 'r1', text: 'Protein at every meal (40g+)', active: true }, { id: 'r2', text: 'Last meal 2.5h before bed', active: true }, { id: 'r3', text: 'No fried food on weekdays', active: true }] });
  for (const s of seedStandards()) add('standards', 'app', s);
  for (const e of seedExercises()) add('exercises', 'app', e);
  const prot = [
    { id: 'p-d3', name: 'Vitamin D3', kind: 'supplement', amount: 5000, unit: 'IU', schedule: { type: 'daily', stack: 'AM' } },
    { id: 'p-o3', name: 'Omega-3', kind: 'supplement', amount: 2, unit: 'g', schedule: { type: 'daily', stack: 'AM' } },
    { id: 'p-cr', name: 'Creatine', kind: 'supplement', amount: 5, unit: 'g', schedule: { type: 'daily', stack: 'AM' } },
    { id: 'p-mg', name: 'Magnesium glycinate', kind: 'supplement', amount: 400, unit: 'mg', schedule: { type: 'daily', stack: 'PM' } },
    { id: 'p-pep', name: 'Weekly peptide', kind: 'peptide', amount: 1, unit: 'mg', schedule: { type: 'days', days: [0, 3], stack: 'AM' }, weeklyTarget: { amount: 2, unit: 'mg' }, neutralLabel: 'Protocol' },
  ];
  for (const p of prot) add('protocolItems', 'app', { ...p, active: true, startedAt: start });
  for (const f of FOODS) add('foods', 'app', { id: 'f-' + hashId(f.name), name: f.name, items: f.items.map(toItem), totals: totalsOf(f.items.map(toItem)), uses: Math.floor(n(3, 30)) });

  let weightTrue = 158; const prog = {}; let prevStrain = 10;
  // Yesterday-evening behaviors shape the night that ends on the next morning.
  let prevEve = { alcohol: 0, lastMealMin: 1170, weekend: false };
  for (const date of dateRange(start, today)) {
    const dow = dayOfWeek(date); const isWeekend = dow >= 5; const split = SPLIT[dow]; const dayIdx = dateRange(start, date).length;
    const doseDay = dow === 0 || dow === 3; const dayAfterDose = dow === 1 || dow === 4;
    // ---------- this evening's behaviors (affect tomorrow's sleep/recovery)
    const eveWeekend = dow === 4 || dow === 5; // Fri/Sat nights
    const alcohol = eveWeekend && R() < 0.4 ? Math.ceil(n(1, 4)) : (R() < 0.05 ? 1 : 0);
    const lastMealMin = (eveWeekend ? 1260 : 1170) + n(-40, 80);
    const caffeineMin = n(480, 840);
    // ---------- sleep: the night that ENDED this morning (driven by yesterday evening)
    const bedMin = (prevEve.weekend ? 1395 : 1350) + n(-35, 45) + prevEve.alcohol * 10;
    const lateMeal = prevEve.lastMealMin > 1230;
    const asleep = Math.max(300, n(390, 500) - prevEve.alcohol * 18 - (lateMeal ? 15 : 0));
    const wakeMin = bedMin + asleep + n(15, 35) - 1440;
    const deep = asleep * n(0.17, 0.24), rem = asleep * n(0.2, 0.26), light = asleep - deep - rem;
    const need = 470 + (prevStrain > 15 ? 20 : 0);
    const sleepStart = bedMin >= 1440 ? at(date, minToHm(bedMin - 1440)) : at(addDays(date, -1), minToHm(bedMin));
    const sleepEnd = at(date, minToHm(wakeMin));
    const sleepId = 'sl-' + date;
    add('whoopSleep', 'server', { id: sleepId, date, cycleId: 'c-' + date, start: sleepStart, end: sleepEnd, tz: '-04:00', nap: false, scoreState: 'SCORED', inBedMin: round(asleep + 25), awakeMin: 25, lightMin: round(light), deepMin: round(deep), remMin: round(rem), asleepMin: round(asleep), cycles: 4 + Math.round(R() * 2), disturbances: Math.round(n(4, 14)), needMin: need, needBaselineMin: 450, needDebtMin: need - 450, needStrainMin: 0, needNapMin: 0, respRate: round(n(14.2, 15.8), 1), performance: Math.min(100, Math.round(asleep / need * 100)), consistency: Math.round(n(60, 92)), efficiency: round(n(88, 96), 1), bedtime: minToHm(bedMin), wake: minToHm(wakeMin) });
    let rec = 58 + (asleep - 420) * 0.22 - prevEve.alcohol * 9 - (lateMeal ? 6 : 0) - (prevStrain > 16 ? 7 : 0) + (dayAfterDose ? -4 : 0) + n(-12, 12);
    rec = Math.max(8, Math.min(98, Math.round(rec)));
    prevEve = { alcohol, lastMealMin, weekend: eveWeekend };
    add('whoopRecovery', 'server', { id: 'c-' + date, date, cycleId: 'c-' + date, sleepId, scoreState: 'SCORED', calibrating: dayIdx < 4, recovery: rec, rhr: Math.round(57 - (rec - 55) * 0.09 + n(-2, 2)), hrv: round(62 + (rec - 55) * 0.55 + n(-6, 6), 1), spo2: round(n(95, 98.5), 1), skinTempC: round(n(33.4, 34.4), 2) });
    // ---------- training
    let strain = n(6, 10); let trainingMin = 0;
    if (split && R() < 0.9) {
      const startMin = 1020 + n(-40, 50); const dur = n(55, 80); trainingMin = dur;
      const woStrain = n(9, 14); strain = n(12, 17);
      add('whoopWorkouts', 'server', { id: 'w-' + date, date, start: at(date, minToHm(startMin)), end: at(date, minToHm(startMin + dur)), tz: '-04:00', sport: 'Weightlifting', sportId: 45, scoreState: 'SCORED', strain: round(woStrain, 1), avgHr: Math.round(n(112, 132)), maxHr: Math.round(n(160, 178)), kj: round(n(1400, 2300)), kcal: round(n(330, 550)), percentRecorded: 100, distanceM: null, altGainM: null, zonesMin: [2, 20, 25, 12, 5, 1].map((z) => round(z * dur / 65)) });
      const entries = TRAIN[split].map(([exId, base, reps], i) => {
        const k = exId + split; prog[k] = prog[k] ?? base;
        if (R() < 0.12) prog[k] += exId.includes('deadlift') || exId.includes('squat') || exId.includes('leg-press') ? 10 : 5;
        const w = prog[k]; const nsets = i < 2 ? 4 : 3;
        return { id: 'e' + i, exerciseId: exId, sets: Array.from({ length: nsets }, (_, j) => ({ w, reps: Math.max(3, reps + Math.round(n(-2, 1)) - (j > 1 ? 1 : 0)), rpe: round(n(7, 9.5), 1), kind: 'work', done: true })) };
      });
      const cardio = dow === 2 || dow === 5 ? [{ id: 'c0', exerciseId: 'ex-stationary-bike', durationMin: 25, distanceMi: round(n(6, 8), 1), avgWatts: Math.round(150 + dayIdx * 0.25 + n(-10, 10)), avgHr: Math.round(n(128, 142)), maxHr: Math.round(n(150, 165)), kcal: Math.round(n(220, 300)), rpe: 6 }] : [];
      add('sessions', 'app', { id: 's-' + date, date, startAt: at(date, minToHm(startMin)), endAt: at(date, minToHm(startMin + dur)), name: split + ' day', entries, cardio, rpe: round(n(7, 9), 1), whoopWorkoutId: 'w-' + date });
    }
    add('whoopCycles', 'server', { id: 'c-' + date, date, start: sleepStart, end: null, tz: '-04:00', scoreState: 'SCORED', strain: round(strain, 1), kj: round(n(9500, 14000)), kcal: round(n(2300, 3350)), avgHr: Math.round(n(64, 78)), maxHr: Math.round(n(150, 180)), steps: Math.round(n(5500, 14000)) });
    prevStrain = strain;
    // ---------- meals
    const appetiteFactor = dayAfterDose ? 0.82 : doseDay ? 0.9 : 1;
    const slots = [['breakfast', 480 + n(-30, 45), pick([0, 1, 7])], ['lunch', 750 + n(-30, 45), pick([3, 6, 3])], ['dinner', lastMealMin, pick([4, 5, 3])]];
    if (split) slots.push(['shake', 1110 + n(-20, 40), 2]);
    if (R() < 0.35 * appetiteFactor) slots.push(['snack', 900 + n(-60, 60), 7]);
    for (const [slot, min, fi] of slots) {
      if (R() > appetiteFactor + 0.1 && slot !== 'dinner') continue;
      const f = FOODS[fi]; const scale = appetiteFactor * n(1.2, 1.55);
      const items = f.items.map(toItem).map((it) => scaleItem(it, scale));
      add('meals', 'app', { id: 'm-' + date + '-' + slot, date, at: at(date, minToHm(min)), slot, source: 'snap', note: '', items, totals: totalsOf(items), status: 'ready', ai: { model: 'demo', confidence: 'medium', assumptions: [], searched: false, costUsd: 0 } });
    }
    // ---------- body
    weightTrue += 0.3 / 7 * (appetiteFactor < 1 ? 0.6 : 1.25) + n(-0.02, 0.02);
    if (R() < 0.85) add('body', 'app', { id: 'b-' + date, date, at: at(date, minToHm(wakeMin + 15)), weightLb: round(weightTrue + n(-1.1, 1.1), 1), method: 'scale' });
    // ---------- doses
    for (const p of prot) {
      const due = p.schedule.type === 'daily' || (p.schedule.days || []).includes(dow);
      if (!due || R() < (p.kind === 'peptide' ? 0.02 : 0.1)) continue;
      add('doses', 'app', { id: 'd-' + date + '-' + p.id, itemId: p.id, date, at: at(date, p.schedule.stack === 'PM' ? '21:45' : '07:15'), amount: p.amount, unit: p.unit });
    }
    // ---------- day log
    add('days', 'app', { id: date, date, deepWorkH: isWeekend ? round(n(0, 2), 1) : round(Math.max(0.5, n(2, 5.5) + (rec - 55) * 0.02), 1), energy: Math.max(1, Math.min(5, Math.round(1 + rec / 25 + n(-0.7, 0.7)))), mood: Math.round(n(2.6, 4.9)), stress: Math.round(n(1.5, 4.2)), appetite: Math.max(1, Math.min(5, Math.round((dayAfterDose ? 2.2 : 3.6) + n(-0.8, 0.8)))), soreness: Math.round(n(1, 4)), alcohol, caffeineLastAt: minToHm(caffeineMin), dayRating: Math.round(n(5, 9.5)), checkinAt: at(date, '21:40') });
    if (R() < 0.7) add('checks', 'app', { id: `${date}:std-read`, date, standardId: 'std-read', value: Math.round(n(20, 45)), source: 'manual' });
    // ---------- plan + calendar
    if (!isWeekend) {
      const blocks = [['07:30', '09:30', 'Deep work: product', 'deep'], ['09:30', '10:00', 'Inbox & ops', 'admin'], ['12:00', '12:45', 'Lunch', 'meal'], ['13:00', '15:00', 'Deep work: growth', 'deep'], ['17:00', '18:15', split ? split + ' day' : 'Mobility', 'training'], ['21:30', '21:45', 'Evening check-in', 'personal']];
      blocks.forEach(([s, e, title, cat], i) => {
        const past = date < today; const roll = R();
        add('plan', 'app', { id: `pl-${date}-${i}`, date, start: s, end: e, title, category: cat, status: past ? (roll < 0.72 ? 'done' : roll < 0.84 ? 'partial' : 'skipped') : 'planned', calendar: true, reminder: cat === 'training' });
      });
      const meetings = Math.floor(n(1, 6));
      for (let k = 0; k < meetings; k++) {
        const sMin = pick([600, 630, 660, 690, 900, 930, 960]) + (k % 2) * 30; const dur = pick([30, 30, 45, 60]);
        add('calendarEvents', 'server', { id: `primary:ev-${date}-${k}`, date, start: at(date, minToHm(sMin)), end: at(date, minToHm(sMin + dur)), allDay: false, title: pick(['Ops sync', 'Client call', 'Recruiting review', 'Partner check-in', '1:1']), calendarId: 'primary', attendees: Math.floor(n(2, 7)), organizerSelf: R() < 0.4, status: 'confirmed', isForge: false });
      }
    }
  }
  // labs
  const panel = (id, date, shift) => add('labs', 'app', { id, collectedAt: date, date, lab: 'Demo Labs', source: 'manual', markers: LABS.map(([key, name, v, unit, lo, hi]) => ({ key, name, value: round(v * (1 + shift * (R() - 0.4)), 2), unit, refLow: lo, refHigh: hi, flag: null })) });
  panel('lab-1', addDays(today, -80), 0.12); panel('lab-2', addDays(today, -12), 0.08);
  add('journal', 'app', { id: 'j1', date: addDays(today, -20), at: at(addDays(today, -20), '22:05'), text: 'Sleep was much better after moving dinner earlier.', tags: [] });
  add('journal', 'app', { id: 'j2', date: addDays(today, -3), at: at(addDays(today, -3), '21:50'), text: 'Heavy squat day felt strong. Keep the 7:30 deep work block.', tags: [] });
  for (let m = 3; m >= 0; m--) {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - m, 1));
    const month = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
    add('snapshots', 'app', { id: month, month, gross: 20000 + (3 - m) * 2500, items: [{ name: 'Cash', type: 'asset', value: 12000 + (3 - m) * 1500, category: 'cash' }, { name: 'Brokerage', type: 'asset', value: 25000 + (3 - m) * 900, category: 'investments' }, { name: 'Car', type: 'asset', value: 18000, category: 'vehicle' }, { name: 'Car loan', type: 'liability', value: 9000 - (3 - m) * 400, category: 'debt' }] });
  }
  return shards;
}

const LABS = [
  ['apob', 'ApoB', 88, 'mg/dL', 0, 90], ['ldl', 'LDL-C', 104, 'mg/dL', 0, 100], ['hdl', 'HDL-C', 52, 'mg/dL', 40, 200],
  ['triglycerides', 'Triglycerides', 96, 'mg/dL', 0, 150], ['total_cholesterol', 'Total Cholesterol', 176, 'mg/dL', 0, 200],
  ['hba1c', 'HbA1c', 5.2, '%', 4, 5.7], ['glucose', 'Glucose', 88, 'mg/dL', 70, 99], ['hscrp', 'hs-CRP', 0.8, 'mg/L', 0, 1],
  ['testosterone_total', 'Testosterone, Total', 640, 'ng/dL', 264, 916], ['free_testosterone', 'Free Testosterone', 14.2, 'ng/dL', 8.7, 25.1],
  ['estradiol', 'Estradiol', 28, 'pg/mL', 8, 35], ['shbg', 'SHBG', 38, 'nmol/L', 16.5, 55.9], ['tsh', 'TSH', 1.9, 'uIU/mL', 0.45, 4.5],
  ['free_t3', 'Free T3', 3.2, 'pg/mL', 2, 4.4], ['vitamin_d', 'Vitamin D, 25-OH', 42, 'ng/mL', 30, 100], ['ferritin', 'Ferritin', 140, 'ng/mL', 30, 400],
  ['creatinine', 'Creatinine', 1.05, 'mg/dL', 0.76, 1.27], ['alt', 'ALT', 26, 'U/L', 0, 44], ['ast', 'AST', 24, 'U/L', 0, 40], ['cortisol', 'Cortisol (AM)', 14, 'ug/dL', 6.2, 19.4],
];

function toItem([name, grams, kcal, protein, carbs, fat, fiber]) {
  return { name, portion: grams + ' g', grams, kcal, protein, carbs, fat, fiber, sugar: round(carbs * 0.15, 1), satFat: round(fat * 0.3, 1), sodium: Math.round(kcal * 0.9), potassium: Math.round(kcal * 1.1), calcium: Math.round(kcal * 0.2), iron: round(kcal * 0.004, 1), magnesium: Math.round(kcal * 0.15), vitC: round(fiber * 3, 1), vitD: 0, confidence: 'medium', basis: 'estimate' };
}
function scaleItem(it, k) {
  const out = { ...it };
  for (const key of ['grams', 'kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'satFat', 'sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'vitC', 'vitD']) out[key] = round(it[key] * k, 1);
  return out;
}
export function totalsOf(items) {
  const t = {};
  for (const k of ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'satFat', 'sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'vitC', 'vitD']) t[k] = round(items.reduce((s, i) => s + (Number(i[k]) || 0), 0), 1);
  return t;
}

// Load demo shards into a store (owner 'app'); server shards load as authoritative.
export function loadDemo(store, opts) {
  const shards = generateDemo(opts);
  for (const [path, shard] of shards) store.loadShard(path, shard, { source: 'demo', dirty: false });
  return shards.size;
}
