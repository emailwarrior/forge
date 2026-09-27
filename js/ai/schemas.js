// FORGE AI layer: tool definitions and JSON schemas for structured outputs / strict tool use.
// Constraints honored (Claude structured outputs): additionalProperties:false on every object, every
// property required (unknown strings are "" and negligible nutrients 0, so there are no optional
// properties), no union types, no numeric/string bounds or patterns.
import { NUTRIENT_KEYS, NUTRIENT_UNITS } from '../core/schema.js';

export const CONFIDENCE = Object.freeze(['low', 'medium', 'high']);
export const FOOD_BASIS = Object.freeze(['estimate', 'label', 'web', 'saved']);
export const LAB_STATUSES = Object.freeze(['normal', 'borderline', 'high', 'low', 'abnormal', 'unknown']);

const NUTRIENT_LABELS = {
  kcal: 'Energy', protein: 'Protein', carbs: 'Carbohydrate', fat: 'Total fat', fiber: 'Dietary fiber', sugar: 'Total sugars',
  satFat: 'Saturated fat', sodium: 'Sodium', potassium: 'Potassium', calcium: 'Calcium', iron: 'Iron', magnesium: 'Magnesium',
  vitC: 'Vitamin C', vitD: 'Vitamin D',
};

const str = (description) => ({ type: 'string', description });
const strList = (description) => ({ type: 'array', description, items: { type: 'string' } });
const obj = (properties, description) => {
  const o = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
  if (description) o.description = description;
  return o;
};

/* ------------------------------------------------------------------ meals */

const itemProps = {
  name: str('Food name, specific and plain (e.g. "Grilled chicken breast", "Cooking oil (est.)").'),
  portion: str('Portion in household terms with the reference used, e.g. "1.5 cups", "palm-sized fillet", "1 bottle (500 mL)".'),
  grams: { type: 'number', description: 'Edible weight as served, in grams (drinks: mL ≈ g).' },
  basis: { type: 'string', enum: [...FOOD_BASIS], description: 'label = visible nutrition label; web = web result found in this conversation; saved = user saved food; estimate = everything else.' },
  confidence: { type: 'string', enum: [...CONFIDENCE] },
};
for (const k of NUTRIENT_KEYS) {
  itemProps[k] = { type: 'number', description: `${NUTRIENT_LABELS[k]} (${NUTRIENT_UNITS[k]}) for this portion; 0 if negligible.` };
}

export const RECORD_MEAL_TOOL = Object.freeze({
  name: 'record_meal',
  description: 'Record the itemized nutrition estimate for this meal. Call exactly once, with every item and all nutrient fields.',
  strict: true,
  input_schema: obj({
    title: str('Short neutral meal name, at most 6 words; "" if no food.'),
    portionReference: str('The visible scale reference used for portions (e.g. "10.5 in dinner plate"), or "" if none.'),
    assumptions: strList('Up to 6 short statements of the choices that move the numbers most.'),
    items: { type: 'array', description: 'One entry per distinct food or drink, including hidden oils and sauces.', items: obj(itemProps) },
    confidence: { type: 'string', enum: [...CONFIDENCE], description: 'Overall confidence; not higher than the items that supply most calories.' },
    followUp: str('One short question when a single fact would change total calories by more than 15%; otherwise "".'),
  }),
});

/** Anthropic web search server tool (basic version, no dynamic filtering). */
export function webSearchTool(maxUses = 3) {
  return { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses };
}

/* ------------------------------------------------------------------- labs */

export const LAB_EXTRACT_SCHEMA = Object.freeze(obj({
  collectedAt: str('Specimen collection date as YYYY-MM-DD, or "".'),
  lab: str('Laboratory name as printed, or "".'),
  markers: {
    type: 'array',
    description: 'Every reported result, in report order.',
    items: obj({
      name: str('Test name exactly as printed.'),
      valueText: str('Result exactly as printed including comparators, e.g. "<0.5", "5.2", "Negative".'),
      unit: str('Unit exactly as printed, or "".'),
      rangeText: str('Reference range exactly as printed, or "".'),
      flag: str('Abnormal flag exactly as printed (e.g. "H", "L", "A"), or "".'),
      section: str('Panel heading the result appears under, or "".'),
    }),
  },
  notes: strList('Extraction notes: unreadable parts, uncertain values, fasting status, specimen issues.'),
}));

export const LAB_INTERPRET_SCHEMA = Object.freeze(obj({
  summary: str('2–4 sentences, overall picture first.'),
  items: {
    type: 'array',
    items: obj({
      key: str('Marker key as given in the input, or "".'),
      name: str('Marker name as given in the input.'),
      status: { type: 'string', enum: [...LAB_STATUSES] },
      text: str('1–3 sentences of explanation.'),
    }),
  },
  askDoctor: strList('Specific questions for a physician.'),
}));

/* ---------------------------------------------------------------- reviews */

export const NUTRITION_REVIEW_SCHEMA = Object.freeze(obj({
  score: { type: 'integer', description: '0–100 per the rubric.' },
  headline: str('One sentence verdict.'),
  wins: strList('Up to 3.'),
  gaps: strList('Up to 3.'),
  tomorrow: strList('Up to 3 concrete food-level actions.'),
  flags: strList('Data-quality problems or values worth attention; empty if none.'),
}));

export const WEEKLY_REVIEW_SCHEMA = Object.freeze(obj({
  headline: str('One sentence verdict on the week.'),
  summary: str('3–5 sentences.'),
  whatWorked: strList('Up to 4.'),
  whatDidnt: strList('Up to 4.'),
  focus: obj({
    title: str('At most 6 words.'),
    why: str('1–2 sentences citing the data.'),
    how: strList('2–4 concrete actions.'),
  }),
}));

/* ------------------------------------------------------ constraint checker */

const FORBIDDEN = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'];

/**
 * Check a JSON schema against the structured-output limits.
 * → { optional: number, unions: number, problems: [string] }
 */
export function schemaReport(schema) {
  const report = { optional: 0, unions: 0, problems: [] };
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') return;
    for (const k of FORBIDDEN) if (k in s) report.problems.push(`${path}: unsupported keyword "${k}"`);
    if (Array.isArray(s.type) || s.anyOf || s.oneOf) report.unions++;
    const isObject = s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'));
    if (isObject) {
      if (s.additionalProperties !== false) report.problems.push(`${path}: additionalProperties must be false`);
      const props = s.properties || {};
      const req = new Set(s.required || []);
      for (const k of Object.keys(props)) if (!req.has(k)) report.optional++;
      for (const r of req) if (!(r in props)) report.problems.push(`${path}: required "${r}" is not a property`);
      for (const [k, v] of Object.entries(props)) walk(v, `${path}.${k}`);
    }
    if (s.items) walk(s.items, `${path}[]`);
    for (const alt of [...(s.anyOf || []), ...(s.oneOf || [])]) walk(alt, `${path}|`);
  };
  walk(schema, '$');
  return report;
}
