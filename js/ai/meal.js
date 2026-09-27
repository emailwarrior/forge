// FORGE AI layer: meal photo / text → itemized nutrition (FoodItem[] + Nutrients totals).
// One call with web_search (if ai.webLookup) + strict record_meal, tool_choice auto. If the reply has no
// usable record_meal call, a second call replays a text transcript with thinking disabled and forces
// the tool. Totals are always summed here from the items, never taken from the model.
import { callClaude, findToolUse, modelCaps, DEFAULT_MODEL } from './claude.js';
import { AIError } from './errors.js';
import { addUsage, roundUsd } from './pricing.js';
import { RECORD_MEAL_TOOL, webSearchTool, CONFIDENCE, FOOD_BASIS } from './schemas.js';
import { mealSystemPrompt, MEAL_FALLBACK_INSTRUCTION, clip, fmtN, hhmm, textList } from './prompts.js';
import { NUTRIENT_KEYS, NUTRIENT_UNITS } from '../core/schema.js';

/** Decimal places used when rounding each nutrient (items and totals). */
export const NUTRIENT_DP = Object.freeze({
  kcal: 0, protein: 1, carbs: 1, fat: 1, fiber: 1, sugar: 1, satFat: 1,
  sodium: 0, potassium: 0, calcium: 0, iron: 1, magnesium: 0, vitC: 1, vitD: 0,
});
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGES = 6;
const MEAL_MAX_TOKENS = 12000;     // room for adaptive thinking + a large itemized tool call
const FALLBACK_MAX_TOKENS = 8000;  // thinking disabled: all of it goes to the tool call
const WEB_MAX_USES = 3;

const roundTo = (v, dp) => { const f = 10 ** dp; return Math.round(v * f) / f; };
function nonNeg(v, dp) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) && n > 0 ? roundTo(n, dp) : 0;
}
function normEnum(v, allowed, def) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return allowed.includes(s) ? s : def;
}

/* --------------------------------------------------------------- public */

/**
 * analyzeMeal(ai, { image:{data, mediaType}, images?, note, answers?:[{q,a}], at, date, rules, recentFoods,
 *                   profile:{weightLb, goal}, model?, webSearch?, signal?, onProgress? })
 * → { items, totals, confidence, title, assumptions, followUp, searched, sources, reference, model,
 *     costUsd, costEstimated, usage, fallback }
 */
export async function analyzeMeal(ai, input = {}) {
  const images = collectImages(input);
  if (!images.length) throw new AIError('bad-request', 'Add a photo to analyze.');
  const web = !!(ai && ai.webLookup) && input.webSearch !== false;
  const content = [
    ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
    { type: 'text', text: mealUserText(input, { photo: true, web, count: images.length }) },
  ];
  return runMealAnalysis(ai, input, content, web);
}

/**
 * analyzeMealText(ai, { text, note?, answers?, at, date, rules, recentFoods, profile, model?, webSearch?, signal?, onProgress? })
 * Text-only quick add. Web search only when ai.webLookup and a brand/restaurant is named
 * (mentionsBrand), unless `webSearch` overrides the detection.
 */
export async function analyzeMealText(ai, input = {}) {
  const text = clip(input.text, 2000);
  if (!text) throw new AIError('bad-request', 'Describe what you ate.');
  const named = mentionsBrand(text + '\n' + (input.note || ''));
  const web = !!(ai && ai.webLookup) && (input.webSearch != null ? !!input.webSearch : named);
  const content = [{ type: 'text', text: mealUserText({ ...input, text }, { photo: false, web }) }];
  return runMealAnalysis(ai, input, content, web);
}

/** Sum FoodItems into Nutrients (rounded per NUTRIENT_DP). */
export function mealTotals(items) {
  const t = {};
  for (const k of NUTRIENT_KEYS) {
    let s = 0;
    for (const it of items || []) { const v = Number(it && it[k]); if (isFinite(v)) s += v; }
    t[k] = roundTo(s, NUTRIENT_DP[k]);
  }
  return t;
}

/** Sanitize one FoodItem: trimmed strings, enums lowercased, nutrients non-negative and rounded. null if unusable. */
export function normalizeFoodItem(it) {
  if (!it || typeof it !== 'object') return null;
  const name = clip(it.name, 120);
  if (!name) return null;
  const out = {
    name,
    portion: clip(it.portion, 120),
    grams: nonNeg(it.grams, 0),
    confidence: normEnum(it.confidence, CONFIDENCE, 'medium'),
    basis: normEnum(it.basis, FOOD_BASIS, 'estimate'),
  };
  for (const k of NUTRIENT_KEYS) out[k] = nonNeg(it[k], NUTRIENT_DP[k]);
  return out;
}

/** Rescale a FoodItem to a new gram weight (nutrients proportional). Returns a new object. */
export function scaleFoodItem(item, grams) {
  if (!item) return item;
  const g = Number(grams);
  if (!isFinite(g) || g < 0) return { ...item };
  const base = Number(item.grams);
  const out = { ...item, grams: roundTo(g, 0) };
  if (base > 0) {
    const f = g / base;
    for (const k of NUTRIENT_KEYS) { const v = Number(item[k]); if (isFinite(v)) out[k] = roundTo(v * f, NUTRIENT_DP[k]); }
    out.portion = `${Math.round(g)} g`;
  }
  return out;
}

const BRANDS = [
  "mcdonald's", 'mcdonalds', 'starbucks', 'chipotle', 'chick-fil-a', 'chick fil a', 'chickfila', 'subway', 'taco bell', "wendy's", 'wendys',
  'burger king', 'panera', 'sweetgreen', 'cava', 'five guys', 'in-n-out', 'in n out', 'shake shack', "domino's", 'dominos', 'pizza hut',
  "papa john's", 'papa johns', 'dunkin', 'panda express', "jersey mike's", 'jersey mikes', "jimmy john's", 'wingstop', "raising cane's",
  'raising canes', 'popeyes', 'kfc', "culver's", 'whataburger', 'sonic', "arby's", 'dairy queen', 'qdoba', "moe's", 'noodles & company',
  'olive garden', "applebee's", "chili's", 'texas roadhouse', 'outback', 'cheesecake factory', "p.f. chang's", "pf chang's",
  'buffalo wild wings', 'jack in the box', "carl's jr", "hardee's", 'del taco', 'el pollo loco', 'tropical smoothie', 'smoothie king',
  'jamba', 'crumbl', 'costco', "trader joe's", 'trader joes', 'kirkland', 'whole foods', 'quest bar', 'quest protein', 'fairlife',
  'core power', 'chobani', 'oikos', "siggi's", 'rxbar', 'clif bar', 'clif', 'kind bar', 'premier protein', 'optimum nutrition',
  'gold standard whey', 'celsius', 'red bull', 'monster energy', 'dutch bros', 'tim hortons', 'pret a manger', 'blaze pizza', 'mod pizza',
  'firehouse subs', 'potbelly', "zaxby's", 'bojangles', "marco's pizza", 'little caesars', 'kodiak', "dave's killer bread", 'oreo',
  'doritos', 'cheerios', "ben & jerry's", 'halo top', 'cheetos', "lay's", 'pringles', "kellogg's", 'quaker', 'nature valley', 'larabar',
  'barebells', 'built bar', 'magic spoon', 'muscle milk', 'orgain', 'huel', 'soylent', 'gatorade', 'powerade', 'bodyarmor', 'body armor',
  'prime hydration', 'liquid iv', 'coca-cola', 'coca cola', 'diet coke', 'coke zero', 'pepsi', 'sprite', 'dr pepper', 'mountain dew',
  'la croix', 'lacroix', 'poppi', 'olipop', 'snickers', "reese's", 'kit kat', "hershey's", 'twix', 'skittles', "m&m's", 'jollibee',
  "nando's", 'greggs', 'wawa', 'sheetz', "buc-ee's", '7-eleven', 'great value', "member's mark", 'good & gather', 'factor meals',
  'hellofresh', 'trifecta', 'ghost protein', 'ghost energy', 'isopure', 'dymatize', 'myprotein', 'legendary foods', 'pure protein',
];
const POSSESSIVE_SKIP = new Set([
  "it's", "that's", "what's", "there's", "here's", "let's", "he's", "she's", "who's", "where's", "today's", "yesterday's",
  "tonight's", "mom's", "dad's", "grandma's", "grandpa's", "wife's", "husband's", "friend's",
]);
const BRAND_RE = new RegExp('(?:^|[^a-z0-9])(' + BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=$|[^a-z0-9])', 'i');

/**
 * Heuristic: does free text name a brand, restaurant or packaged product? Used to decide whether a
 * text quick-add may use web search. Errs toward true (a false positive only costs a tool definition).
 */
export function mentionsBrand(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const s = raw.replace(/[‘’]/g, "'");
  if (/[®™]/.test(s)) return true;
  if (BRAND_RE.test(s.toLowerCase())) return true;
  if (/(?:\bfrom|\bat|@)\s+(?:the\s+)?[A-Z][\w'&.-]*/.test(s)) return true; // "bowl from Chipotle", "@ Sweetgreen"
  for (const m of s.matchAll(/\b([A-Z][a-z]+'s)\b/g)) if (!POSSESSIVE_SKIP.has(m[1].toLowerCase())) return true; // "Wendy's"
  if (/\b(brand|restaurant|menu item|fast food|drive[- ]thru|takeout|take-out|protein bar|protein shake|frozen meal|meal kit|meal prep service)\b/i.test(s)) return true;
  return false;
}

/* ------------------------------------------------------------- internals */

function collectImages(input) {
  const list = [];
  if (input.image) list.push(input.image);
  if (Array.isArray(input.images)) list.push(...input.images);
  const out = [];
  for (const im of list) {
    if (!im || typeof im !== 'object' || typeof im.data !== 'string' || !im.data) continue;
    let data = im.data, type = im.mediaType || im.media_type || '';
    const m = /^data:([^;,]+);base64,/.exec(data);
    if (m) { type = type || m[1]; data = data.slice(m[0].length); }
    type = String(type || 'image/jpeg').toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!IMAGE_TYPES.includes(type)) throw new AIError('bad-request', `Unsupported image type "${type}". Use JPEG, PNG, GIF or WebP.`);
    if (out.some((x) => x.data === data)) continue;
    out.push({ data, mediaType: type });
  }
  if (out.length > MAX_IMAGES) throw new AIError('bad-request', `Too many photos (max ${MAX_IMAGES}).`);
  return out;
}

async function runMealAnalysis(ai, input, userContent, web) {
  const model = input.model || (ai && ai.model) || DEFAULT_MODEL;
  const system = mealSystemPrompt();
  const common = { system, signal: input.signal, onProgress: input.onProgress };
  const first = await callClaude(ai, {
    ...common, model,
    messages: [{ role: 'user', content: userContent }],
    tools: web ? [webSearchTool(WEB_MAX_USES), RECORD_MEAL_TOOL] : [RECORD_MEAL_TOOL],
    toolChoice: { type: 'auto' },
    maxTokens: MEAL_MAX_TOKENS,
  });
  const calls = [first];
  let call = usableMealCall(first);
  if (!call) {
    // Fallback: replay the reply as text (thinking and server-tool blocks flattened), then force the tool.
    const fbModel = modelCaps(model).forcedToolChoice ? model : DEFAULT_MODEL;
    const transcript = transcriptText(first.content);
    const instruction = { type: 'text', text: MEAL_FALLBACK_INSTRUCTION };
    const messages = transcript
      ? [{ role: 'user', content: userContent }, { role: 'assistant', content: [{ type: 'text', text: transcript }] }, { role: 'user', content: [instruction] }]
      : [{ role: 'user', content: [...userContent, instruction] }];
    const second = await callClaude(ai, {
      ...common, model: fbModel, messages,
      tools: [RECORD_MEAL_TOOL],
      toolChoice: { type: 'tool', name: RECORD_MEAL_TOOL.name },
      thinking: { type: 'disabled' },
      maxTokens: FALLBACK_MAX_TOKENS,
    });
    calls.push(second);
    call = usableMealCall(second);
    if (!call) throw new AIError('parse', 'Claude did not return a usable meal estimate. Try again, or add a note.', { requestId: second.requestId });
  }
  return buildMealResult(call.input, calls, input);
}

function usableMealCall(res) {
  if (!res || res.stopReason === 'max_tokens' || res.stopReason === 'model_context_window_exceeded') return null;
  const c = findToolUse(res.content, RECORD_MEAL_TOOL.name);
  return c && c.input && typeof c.input === 'object' && Array.isArray(c.input.items) ? c : null;
}

function transcriptText(content) {
  let out = '';
  const line = (s) => { out += (out && !out.endsWith('\n') ? '\n' : '') + s + '\n'; };
  for (const b of content || []) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      out += b.text;
      if (Array.isArray(b.citations)) {
        for (const c of b.citations) {
          if (!c || !(c.cited_text || c.url)) continue;
          out += ` [source: ${clip(c.title || c.url || 'web', 120)}${c.url ? ' <' + c.url + '>' : ''}${c.cited_text ? ' — "' + clip(c.cited_text, 300) + '"' : ''}]`;
        }
      }
    } else if (b.type === 'server_tool_use' && b.input && b.input.query) {
      line(`[web search: "${clip(b.input.query, 200)}"]`);
    } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      const r = b.content.filter((x) => x && x.url).slice(0, 5).map((x) => `${clip(x.title || x.url, 120)} <${x.url}>`);
      if (r.length) line('[search results: ' + r.join('; ') + ']');
    }
  }
  return clip(out.trim(), 12000);
}

function webInfo(content, usage) {
  const requests = Number(usage && usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  let queried = false;
  const cited = [], results = [];
  for (const b of content || []) {
    if (!b) continue;
    if (b.type === 'server_tool_use' && b.name === 'web_search') queried = true;
    else if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c && c.url) cited.push({ title: clip(c.title || c.url, 160), url: String(c.url) });
    } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r && r.type === 'web_search_result' && r.url) results.push({ title: clip(r.title || r.url, 160), url: String(r.url) });
    }
  }
  const dedupe = (list) => { const seen = new Set(); return list.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))); };
  const sources = cited.length ? dedupe(cited).slice(0, 6) : dedupe(results).slice(0, 4);
  return { searched: requests > 0 || queried, sources };
}

const RANK = { low: 0, medium: 1, high: 2 };
function overallConfidence(modelValue, items) {
  if (!items.length) return 'low';
  let c = normEnum(modelValue, CONFIDENCE, null);
  const kcal = items.reduce((s, i) => s + i.kcal, 0);
  if (kcal > 0) {
    const w = items.reduce((s, i) => s + RANK[i.confidence] * i.kcal, 0) / kcal;
    const cap = CONFIDENCE[Math.round(w)];
    if (!c || RANK[c] > RANK[cap]) c = cap; // never more confident than the calorie-weighted items
  }
  return c || (items.length ? 'medium' : 'low');
}

function buildMealResult(raw, calls, input) {
  const content = [];
  for (const c of calls) content.push(...(c.content || []));
  const usage = calls.reduce((u, c) => addUsage(u, c.usage), null) || {};
  const { searched, sources } = webInfo(content, usage);
  const savedAvailable = foodContext(input.recentFoods).saved.length > 0;
  const items = [];
  for (const it of raw.items) {
    const clean = normalizeFoodItem(it);
    if (!clean) continue;
    if (clean.basis === 'web' && !searched) clean.basis = 'estimate';   // no search happened: not a web value
    if (clean.basis === 'saved' && !savedAvailable) clean.basis = 'estimate';
    items.push(clean);
  }
  let reference = clip(raw.portionReference, 160);
  if (/^(none|n\/?a|no reference|unknown|-)\.?$/i.test(reference)) reference = '';
  const assumptions = textList(raw.assumptions, { max: 8, len: 240 });
  if (reference && !assumptions.some((a) => a.toLowerCase().includes(reference.toLowerCase()))) assumptions.unshift('Scale reference: ' + reference);
  let followUp = clip(raw.followUp, 240);
  if (!followUp || /^(none|n\/?a|null|no|-)\.?$/i.test(followUp)) followUp = null;
  const title = clip(raw.title, 60) || (items.length ? items.slice(0, 3).map((i) => i.name).join(', ').slice(0, 60) : '');
  return {
    items,
    totals: mealTotals(items),
    confidence: overallConfidence(raw.confidence, items),
    title,
    assumptions,
    followUp,
    searched,
    sources,
    reference: reference || null,
    model: calls[0].model,
    costUsd: roundUsd(calls.reduce((s, c) => s + (c.costUsd || 0), 0)),
    costEstimated: calls.some((c) => c.costEstimated),
    usage,
    fallback: calls.length > 1,
  };
}

/* ----------------------------------------------------------- user prompt */

function mealUserText(input, { photo, web, count = 1 }) {
  const L = [];
  if (photo) {
    L.push(count > 1
      ? `Estimate the nutrition of the meal shown in these ${count} photos. They show the same meal (possibly with its packaging or label); do not double count.`
      : 'Estimate the nutrition of the meal in this photo.');
  } else {
    L.push('Estimate the nutrition of this food, described by the user (ground truth):', `"${input.text}"`);
    L.push('There is no photo: use the stated amounts; if an amount is missing assume one typical serving and say so in assumptions.');
  }
  const note = clip(input.note, 1000);
  if (note) L.push('', `User note (ground truth; overrides the ${photo ? 'photo' : 'defaults'}): "${note}"`);
  const answers = cleanAnswers(input.answers);
  if (answers.length) {
    L.push('', 'Clarifications from the user (ground truth; do not ask about these again):');
    for (const a of answers) L.push(`- Q: ${a.q} A: ${a.a}`);
  }
  const when = describeWhen(input.at, input.date);
  if (when) L.push('', 'Eaten: ' + when);
  const rules = textList(input.rules, { max: 15, len: 200 });
  if (rules.length) {
    L.push('', "The user's nutrition rules and habits (context only: use any that describe how food is prepared or portioned; do not judge the meal):");
    for (const r of rules) L.push('- ' + r);
  }
  const foods = foodContext(input.recentFoods);
  if (foods.saved.length) {
    const units = NUTRIENT_KEYS.filter((k) => k !== 'kcal').map((k) => `${k} ${NUTRIENT_UNITS[k]}`).join(', ');
    L.push('', `The user's saved foods (use basis "saved" and scale these values when the ${photo ? 'photo' : 'description'} clearly matches; units: ${units}):`);
    for (const f of foods.saved) L.push(savedFoodLine(f));
  }
  if (foods.names.length) L.push('', 'Foods this user logs often (reuse a name when it clearly matches): ' + foods.names.join('; '));
  const profile = profileLine(input.profile);
  if (profile) L.push('', profile);
  L.push('', web
    ? 'Web search: available. Use it only for branded, packaged or restaurant items, per the rules.'
    : 'Web search: not available. Use your own knowledge and never use basis "web".');
  L.push('', 'Call record_meal once with the complete itemized estimate.');
  return L.join('\n');
}

function cleanAnswers(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    const q = clip(a.q != null ? a.q : a.question, 240);
    const ans = clip(a.a != null ? a.a : a.answer, 400);
    if (ans) out.push({ q: q || '(question)', a: ans });
  }
  return out.slice(0, 6);
}

function describeWhen(at, date) {
  let d = '', t = '';
  if (typeof at === 'number' && isFinite(at)) {
    const x = new Date(at);
    d = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    t = `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
  } else if (typeof at === 'string' && at) {
    if (/^\d{4}-\d{2}-\d{2}/.test(at)) d = at.slice(0, 10);
    t = hhmm(at);
  }
  if (!d && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) d = date;
  if (!d && !t) return '';
  let slot = '';
  if (t) {
    const h = Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60;
    slot = h < 4 ? 'late night' : h < 10.5 ? 'breakfast time' : h < 14.5 ? 'lunch time' : h < 17 ? 'afternoon' : h < 21.5 ? 'dinner time' : 'late evening';
  }
  return [d, t].filter(Boolean).join(' ') + (slot ? ` (${slot})` : '');
}

function foodContext(recentFoods) {
  const names = [], saved = [];
  for (const f of Array.isArray(recentFoods) ? recentFoods : []) {
    if (typeof f === 'string') { const s = clip(f, 80); if (s && !names.includes(s)) names.push(s); continue; }
    if (!f || typeof f !== 'object' || !f.name) continue;
    const t = f.totals && typeof f.totals === 'object' ? f.totals : f;
    if (Number(t.kcal) > 0) saved.push(f);
    else { const s = clip(f.name, 80); if (s && !names.includes(s)) names.push(s); }
  }
  return { names: names.slice(0, 40), saved: saved.slice(0, 20) };
}

function savedFoodLine(f) {
  const t = f.totals && typeof f.totals === 'object' ? f.totals : f;
  const grams = Number(f.grams) > 0 ? Number(f.grams)
    : Array.isArray(f.items) ? f.items.reduce((s, i) => s + (Number(i && i.grams) || 0), 0) : 0;
  const portion = f.portion ? clip(f.portion, 60) : grams ? `${Math.round(grams)} g` : '1 serving';
  const parts = Array.isArray(f.items) && f.items.length > 1 ? ` [${f.items.map((i) => i && i.name).filter(Boolean).slice(0, 6).join(', ')}]` : '';
  const vals = NUTRIENT_KEYS.map((k) => `${k} ${fmtN(Number(t[k]) || 0, 1)}`).join(', ');
  return `- ${clip(f.name, 80)} — ${portion}${parts}: ${vals}`;
}

function profileLine(p) {
  if (!p || typeof p !== 'object') return '';
  const bits = [];
  if (Number(p.weightLb) > 0) bits.push(`body weight ${fmtN(Number(p.weightLb), 1)} lb`);
  if (p.goal) bits.push(`goal: ${clip(p.goal, 120)}`);
  return bits.length ? `User context: ${bits.join('; ')}.` : '';
}
