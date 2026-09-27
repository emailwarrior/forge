// Nutrition: nutrient sums, day view vs targets, adherence and micronutrient averages.
import { NUTRIENT_KEYS, NUTRIENT_UNITS } from '../core/schema.js';
import { addDays, dateRange, hmToMin, minToHm, isNum, round, fmtTime, fmtDur } from '../core/util.js';
import { formatNumber as fmtNum } from './dataview.js';
import { calorieTargets } from './body.js';
import { mean } from './stats.js';

// Sum nutrients of FoodItems or meals (a meal contributes its totals, else its items).
// A key is null when no element has a number for it.
export function sumNutrients(itemsOrMeals) {
  const out = {}; for (const k of NUTRIENT_KEYS) out[k] = null;
  const add = (src) => { for (const k of NUTRIENT_KEYS) if (src && isNum(src[k])) out[k] = (out[k] || 0) + src[k]; };
  for (const x of itemsOrMeals || []) {
    if (!x) continue;
    if (x.totals && typeof x.totals === 'object') add(x.totals);
    else if (Array.isArray(x.items)) for (const it of x.items) add(it);
    else add(x);
  }
  for (const k of NUTRIENT_KEYS) if (out[k] != null) out[k] = round(out[k], 1);
  return out;
}

export function dayNutrition(dv, date) {
  return dv.memo('nutr:day:' + date, () => {
    const it = dv.intake(date);
    const targets = calorieTargets(dv, date);
    const today = dv.asOf();
    const totals = it.totals;
    const kcal = it.analyzed ? totals.kcal : null, protein = it.analyzed ? totals.protein : null;
    const bed = dv.sleepClock(addDays(date, 1)).bedMin; // night after `date`, minutes after its midnight
    const lastMealToBedMin = isNum(bed) && isNum(it.lastMin) && bed - it.lastMin >= 0 ? bed - it.lastMin : null;
    const flags = [];
    if (it.failed) flags.push({ level: 'warn', text: `${it.failed} meal${it.failed > 1 ? 's' : ''} failed analysis — re-run or enter manually.` });
    const waiting = it.waiting || 0; const analyzing = it.pending - it.failed - waiting;
    if (analyzing > 0) flags.push({ level: 'info', text: `${analyzing} meal${analyzing > 1 ? 's are' : ' is'} still analyzing — totals are partial.` });
    if (waiting > 0) flags.push({ level: 'info', text: `${waiting} meal${waiting > 1 ? 's are' : ' is'} waiting for analysis — totals are partial.` });
    if (it.lowConfidence) flags.push({ level: 'info', text: `${it.lowConfidence} estimate${it.lowConfidence > 1 ? 's are' : ' is'} low-confidence.` });
    const lastBy = hmToMin(dv.setting('targets').lastMealBy);
    if (isNum(lastBy) && isNum(it.lastMin) && it.lastMin > lastBy) flags.push({ level: 'info', text: `Last meal at ${fmtTime(it.lastMin)}, after the ${fmtTime(lastBy)} target.` });
    if (date < today && it.complete) {
      if (isNum(targets.kcal) && kcal < targets.kcal * 0.9) flags.push({ level: 'warn', text: `Intake ${fmtNum(kcal)} kcal — ${Math.round((1 - kcal / targets.kcal) * 100)}% under the ${fmtNum(targets.kcal)} target.` });
      else if (isNum(targets.kcal) && kcal > targets.kcal * 1.15) flags.push({ level: 'info', text: `Intake ${fmtNum(kcal)} kcal — ${Math.round((kcal / targets.kcal - 1) * 100)}% over target.` });
      if (isNum(targets.proteinG) && protein < targets.proteinG * 0.95) flags.push({ level: 'warn', text: `Protein ${fmtNum(protein)} g of the ${fmtNum(targets.proteinG)} g target.` });
    }
    if (isNum(lastMealToBedMin) && lastMealToBedMin < 120) flags.push({ level: 'info', text: `Last meal ${fmtDur(lastMealToBedMin)} before bed.` });
    return {
      date, totals, mealCount: it.count, complete: it.complete, pending: it.pending, targets,
      remaining: {
        kcal: isNum(targets.kcal) ? round(targets.kcal - (kcal || 0), 0) : null,
        proteinG: isNum(targets.proteinG) ? round(targets.proteinG - (protein || 0), 0) : null,
      },
      pct: {
        kcal: isNum(targets.kcal) && targets.kcal > 0 && isNum(kcal) ? round((kcal / targets.kcal) * 100, 0) : null,
        protein: isNum(targets.proteinG) && targets.proteinG > 0 && isNum(protein) ? round((protein / targets.proteinG) * 100, 0) : null,
      },
      proteinPerMeal: it.meals.map((m) => ({ mealId: m.id, at: m.min != null ? minToHm(m.min) : null, slot: m.slot, protein: m.totals && isNum(m.totals.protein) ? round(m.totals.protein, 1) : null })),
      firstMealAt: it.firstMin != null ? minToHm(it.firstMin) : null,
      lastMealAt: it.lastMin != null ? minToHm(it.lastMin) : null,
      lastMealToBedMin,
      flags,
    };
  });
}

// Over complete past days in [from, to]: kcal hit = within ±10% of target, protein hit = ≥ 95%.
// Rates are percentages (0–100); avgVsTarget = mean (intake − target) in kcal/day.
export function adherence(dv, from, to) {
  const today = dv.asOf();
  let days = 0, kHit = 0, kN = 0, pHit = 0, pN = 0; const kcals = [], prots = [], diffs = [], pdiffs = [];
  for (const d of dateRange(from, to)) {
    if (d >= today) break;
    const it = dv.intake(d); if (!it.complete) continue;
    days++;
    const t = calorieTargets(dv, d);
    const k = it.totals.kcal, p = it.totals.protein;
    if (isNum(k)) kcals.push(k);
    if (isNum(p)) prots.push(p);
    if (isNum(k) && isNum(t.kcal)) { kN++; if (Math.abs(k - t.kcal) <= 0.1 * t.kcal) kHit++; diffs.push(k - t.kcal); }
    if (isNum(p) && isNum(t.proteinG)) { pN++; if (p >= 0.95 * t.proteinG) pHit++; pdiffs.push(p - t.proteinG); }
  }
  return {
    days,
    kcalHitRate: kN ? round((kHit / kN) * 100, 0) : null,
    proteinHitRate: pN ? round((pHit / pN) * 100, 0) : null,
    avgKcal: round(mean(kcals), 0), avgProtein: round(mean(prots), 0),
    avgVsTarget: round(mean(diffs), 0), avgProteinVsTarget: round(mean(pdiffs), 0),
    kcalHits: kHit, proteinHits: pHit,
  };
}

// General reference intakes (not personalized): adult RDA/AI; sodium is an upper limit.
export const MICRO_REFERENCES = {
  male: { fiber: 38, sodium: 2300, potassium: 3400, calcium: 1000, iron: 8, magnesium: 420, vitC: 90, vitD: 600 },
  female: { fiber: 25, sodium: 2300, potassium: 2600, calcium: 1000, iron: 18, magnesium: 320, vitC: 75, vitD: 600 },
};
const MICRO_LABELS = { fiber: 'Fiber', sodium: 'Sodium', potassium: 'Potassium', calcium: 'Calcium', iron: 'Iron', magnesium: 'Magnesium', vitC: 'Vitamin C', vitD: 'Vitamin D' };

export function microSummary(dv, from, to) {
  const sex = dv.setting('profile').sex === 'female' ? 'female' : 'male';
  const ref = MICRO_REFERENCES[sex];
  const today = dv.asOf();
  const vals = Object.fromEntries(Object.keys(ref).map((k) => [k, []]));
  for (const d of dateRange(from, to)) {
    if (d >= today) break;
    const it = dv.intake(d); if (!it.complete) continue;
    for (const k of Object.keys(ref)) if (isNum(it.totals[k])) vals[k].push(it.totals[k]);
  }
  return Object.keys(ref).map((key) => {
    const avg = mean(vals[key]);
    return {
      key, label: MICRO_LABELS[key], avg: round(avg, key === 'iron' ? 1 : 0), unit: NUTRIENT_UNITS[key],
      reference: ref[key], limit: key === 'sodium',
      pct: isNum(avg) ? round((avg / ref[key]) * 100, 0) : null,
      days: vals[key].length,
      referenceNote: `General adult ${sex} reference${key === 'sodium' ? ' (upper limit — lower is better)' : ''}`,
    };
  });
}
