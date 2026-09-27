// Lab panels: marker catalog, name normalization, series and flags.
// Flags use the report's own reference range (refLow/refHigh); no "optimal" ranges are invented.
import { mean } from './stats.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);
const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);

// key → { name, unit (typical US unit, informational), aliases[], category, lowerIsBetter (true|false|null) }
const M = (name, unit, category, lowerIsBetter, aliases) => ({ name, unit, category, lowerIsBetter, aliases });
export const MARKERS = {
  // Lipids
  apob: M('ApoB', 'mg/dL', 'lipids', true, ['apob', 'apo b', 'apolipoprotein b', 'apolipoprotein b100', 'apo b 100', 'apob100']),
  apoa1: M('ApoA1', 'mg/dL', 'lipids', false, ['apoa1', 'apo a1', 'apo a 1', 'apolipoprotein a1', 'apolipoprotein a 1', 'apolipoprotein a i']),
  lpa: M('Lp(a)', 'nmol/L', 'lipids', true, ['lp a', 'lpa', 'lipoprotein a', 'lipoprotein little a']),
  ldl: M('LDL-C', 'mg/dL', 'lipids', true, ['ldl', 'ldl c', 'ldlc', 'ldl cholesterol', 'ldl cholesterol calc', 'ldl calc', 'ldl chol', 'ldl chol calc nih', 'ldl cholesterol direct', 'ldl direct', 'low density lipoprotein', 'low density lipoprotein cholesterol']),
  ldl_p: M('LDL-P', 'nmol/L', 'lipids', true, ['ldl p', 'ldl particle number', 'ldl particles']),
  hdl: M('HDL-C', 'mg/dL', 'lipids', false, ['hdl', 'hdl c', 'hdlc', 'hdl cholesterol', 'hdl chol', 'high density lipoprotein', 'high density lipoprotein cholesterol']),
  non_hdl: M('Non-HDL-C', 'mg/dL', 'lipids', true, ['non hdl', 'non hdl c', 'non hdl cholesterol', 'nonhdl']),
  vldl: M('VLDL-C', 'mg/dL', 'lipids', true, ['vldl', 'vldl c', 'vldl cholesterol', 'vldl cholesterol cal']),
  triglycerides: M('Triglycerides', 'mg/dL', 'lipids', true, ['triglycerides', 'triglyceride', 'trig', 'trigs', 'tg']),
  total_cholesterol: M('Total Cholesterol', 'mg/dL', 'lipids', true, ['cholesterol', 'total cholesterol', 'cholesterol total', 'chol', 'tc']),
  chol_hdl_ratio: M('Cholesterol/HDL ratio', 'ratio', 'lipids', true, ['chol hdl ratio', 'cholesterol hdl ratio', 'total cholesterol hdl ratio', 'chol hdlc ratio', 'tc hdl ratio']),
  // Glucose / metabolic
  hba1c: M('HbA1c', '%', 'metabolic', true, ['hba1c', 'a1c', 'hemoglobin a1c', 'hgb a1c', 'glycated hemoglobin', 'glycohemoglobin', 'glycosylated hemoglobin']),
  glucose: M('Glucose', 'mg/dL', 'metabolic', true, ['glucose', 'fasting glucose', 'glucose fasting', 'blood glucose', 'fbg']),
  insulin: M('Insulin', 'uIU/mL', 'metabolic', true, ['insulin', 'fasting insulin', 'insulin fasting']),
  uric_acid: M('Uric acid', 'mg/dL', 'metabolic', null, ['uric acid', 'urate']),
  // Inflammation
  hscrp: M('hs-CRP', 'mg/L', 'inflammation', true, ['hscrp', 'hs crp', 'crp hs', 'crp high sensitivity', 'high sensitivity crp', 'c reactive protein cardiac', 'cardio crp', 'hs c reactive protein', 'high sensitivity c reactive protein']),
  crp: M('CRP', 'mg/L', 'inflammation', true, ['crp', 'c reactive protein']),
  homocysteine: M('Homocysteine', 'umol/L', 'inflammation', true, ['homocysteine', 'hcy']),
  // Hormones
  testosterone_total: M('Total Testosterone', 'ng/dL', 'hormones', null, ['testosterone', 'total testosterone', 'testosterone total', 'testosterone total lc ms', 'testosterone total ms', 'testosterone lc ms']),
  free_testosterone: M('Free Testosterone', 'pg/mL', 'hormones', null, ['free testosterone', 'testosterone free', 'free t', 'testosterone free direct', 'free testosterone direct', 'testosterone free calculated', 'free testosterone calculated', 'free testosterone calc']),
  bioavailable_testosterone: M('Bioavailable Testosterone', 'ng/dL', 'hormones', null, ['bioavailable testosterone', 'testosterone bioavailable']),
  estradiol: M('Estradiol', 'pg/mL', 'hormones', null, ['estradiol', 'e2', 'estradiol sensitive', 'estradiol ultrasensitive', 'estradiol lc ms']),
  shbg: M('SHBG', 'nmol/L', 'hormones', null, ['shbg', 'sex hormone binding globulin', 'sex hormone binding glob']),
  progesterone: M('Progesterone', 'ng/mL', 'hormones', null, ['progesterone']),
  lh: M('LH', 'mIU/mL', 'hormones', null, ['lh', 'luteinizing hormone']),
  fsh: M('FSH', 'mIU/mL', 'hormones', null, ['fsh', 'follicle stimulating hormone']),
  prolactin: M('Prolactin', 'ng/mL', 'hormones', null, ['prolactin', 'prl']),
  dhea_s: M('DHEA-S', 'ug/dL', 'hormones', null, ['dhea s', 'dheas', 'dhea sulfate', 'dhea so4', 'dhea sulphate', 'dehydroepiandrosterone sulfate']),
  cortisol: M('Cortisol', 'ug/dL', 'hormones', null, ['cortisol', 'cortisol am', 'am cortisol', 'cortisol total', 'cortisol morning']),
  igf1: M('IGF-1', 'ng/mL', 'hormones', null, ['igf 1', 'igf1', 'insulin like growth factor 1', 'insulin like growth factor i', 'somatomedin c']),
  dht: M('DHT', 'ng/dL', 'hormones', null, ['dht', 'dihydrotestosterone']),
  psa: M('PSA', 'ng/mL', 'hormones', true, ['psa', 'psa total', 'prostate specific antigen']),
  // Thyroid
  tsh: M('TSH', 'uIU/mL', 'thyroid', null, ['tsh', 'thyroid stimulating hormone', 'thyrotropin']),
  free_t3: M('Free T3', 'pg/mL', 'thyroid', null, ['free t3', 't3 free', 'ft3', 'free triiodothyronine', 'triiodothyronine free']),
  free_t4: M('Free T4', 'ng/dL', 'thyroid', null, ['free t4', 't4 free', 'ft4', 'free thyroxine', 'thyroxine free']),
  total_t3: M('Total T3', 'ng/dL', 'thyroid', null, ['t3', 't3 total', 'total t3', 'triiodothyronine', 'triiodothyronine total']),
  total_t4: M('Total T4', 'ug/dL', 'thyroid', null, ['t4', 't4 total', 'total t4', 'thyroxine', 'thyroxine total']),
  reverse_t3: M('Reverse T3', 'ng/dL', 'thyroid', null, ['reverse t3', 'rt3', 't3 reverse']),
  tpo_ab: M('TPO antibodies', 'IU/mL', 'thyroid', true, ['tpo antibodies', 'tpo ab', 'anti tpo', 'thyroid peroxidase antibodies']),
  // Vitamins & minerals
  vitamin_d: M('Vitamin D (25-OH)', 'ng/mL', 'vitamins', null, ['vitamin d', 'vit d', 'vitamin d 25 hydroxy', '25 oh vitamin d', '25 hydroxy vitamin d', '25 hydroxyvitamin d', 'vitamin d 25 oh', 'vitamin d 25 oh total', 'vit d 25 oh', '25 oh d', 'vitamin d total', 'calcidiol']),
  vitamin_d_125: M('Vitamin D (1,25-dihydroxy)', 'pg/mL', 'vitamins', null, ['1 25 dihydroxy vitamin d', 'vitamin d 1 25 dihydroxy', 'calcitriol', '1 25 oh 2 d']),
  b12: M('Vitamin B12', 'pg/mL', 'vitamins', null, ['vitamin b12', 'b12', 'vit b12', 'cobalamin', 'cyanocobalamin']),
  folate: M('Folate', 'ng/mL', 'vitamins', null, ['folate', 'folic acid', 'rbc folate']),
  ferritin: M('Ferritin', 'ng/mL', 'iron', null, ['ferritin']),
  iron: M('Iron', 'ug/dL', 'iron', null, ['iron', 'iron total', 'serum iron']),
  tibc: M('TIBC', 'ug/dL', 'iron', null, ['tibc', 'iron binding capacity', 'total iron binding capacity', 'iron binding capacity total']),
  transferrin_sat: M('Transferrin saturation', '%', 'iron', null, ['transferrin saturation', 'iron saturation', 'percent saturation', 'iron percent saturation', 'tsat', 'saturation']),
  magnesium: M('Magnesium', 'mg/dL', 'minerals', null, ['magnesium', 'mg']),
  magnesium_rbc: M('Magnesium (RBC)', 'mg/dL', 'minerals', null, ['magnesium rbc', 'rbc magnesium']),
  zinc: M('Zinc', 'ug/dL', 'minerals', null, ['zinc']),
  calcium: M('Calcium', 'mg/dL', 'electrolytes', null, ['calcium']),
  sodium: M('Sodium', 'mmol/L', 'electrolytes', null, ['sodium', 'na']),
  potassium: M('Potassium', 'mmol/L', 'electrolytes', null, ['potassium', 'k']),
  chloride: M('Chloride', 'mmol/L', 'electrolytes', null, ['chloride', 'cl']),
  co2: M('CO2', 'mmol/L', 'electrolytes', null, ['co2', 'carbon dioxide', 'carbon dioxide total', 'bicarbonate']),
  // Kidney
  creatinine: M('Creatinine', 'mg/dL', 'kidney', null, ['creatinine', 'creat']),
  egfr: M('eGFR', 'mL/min/1.73m2', 'kidney', false, ['egfr', 'estimated gfr', 'gfr estimated', 'egfr non afr american', 'egfr non african american', 'egfr if nonafricn am', 'egfr cr', 'egfr ckd epi']),
  egfr_aa: M('eGFR (African American)', 'mL/min/1.73m2', 'kidney', false, ['egfr african american', 'egfr afr american', 'egfr if africn am']),
  bun: M('BUN', 'mg/dL', 'kidney', null, ['bun', 'urea nitrogen', 'blood urea nitrogen', 'urea nitrogen bun']),
  bun_creatinine_ratio: M('BUN/Creatinine ratio', 'ratio', 'kidney', null, ['bun creatinine ratio', 'bun creat ratio']),
  cystatin_c: M('Cystatin C', 'mg/L', 'kidney', null, ['cystatin c']),
  // Liver
  alt: M('ALT', 'U/L', 'liver', null, ['alt', 'alt sgpt', 'sgpt', 'alanine aminotransferase', 'alanine transaminase']),
  ast: M('AST', 'U/L', 'liver', null, ['ast', 'ast sgot', 'sgot', 'aspartate aminotransferase', 'aspartate transaminase']),
  alp: M('Alkaline phosphatase', 'U/L', 'liver', null, ['alkaline phosphatase', 'alk phos', 'alp']),
  ggt: M('GGT', 'U/L', 'liver', null, ['ggt', 'gamma glutamyl transferase', 'gamma gt', 'ggtp']),
  bilirubin: M('Bilirubin (total)', 'mg/dL', 'liver', null, ['bilirubin', 'bilirubin total', 'total bilirubin']),
  albumin: M('Albumin', 'g/dL', 'liver', null, ['albumin']),
  total_protein: M('Total protein', 'g/dL', 'liver', null, ['total protein', 'protein total']),
  globulin: M('Globulin', 'g/dL', 'liver', null, ['globulin', 'globulin total']),
  // Blood count
  hemoglobin: M('Hemoglobin', 'g/dL', 'blood', null, ['hemoglobin', 'haemoglobin', 'hgb', 'hb']),
  hematocrit: M('Hematocrit', '%', 'blood', null, ['hematocrit', 'haematocrit', 'hct']),
  rbc: M('RBC', 'M/uL', 'blood', null, ['rbc', 'red blood cell count', 'red blood cells', 'erythrocytes']),
  wbc: M('WBC', 'K/uL', 'blood', null, ['wbc', 'white blood cell count', 'white blood cells', 'leukocytes']),
  platelets: M('Platelets', 'K/uL', 'blood', null, ['platelets', 'platelet count', 'plt']),
  mcv: M('MCV', 'fL', 'blood', null, ['mcv', 'mean corpuscular volume']),
  // Muscle
  ck: M('Creatine kinase', 'U/L', 'muscle', null, ['ck', 'cpk', 'creatine kinase', 'creatine kinase total']),
};

/* ------------------------------------------------------------ normalization */
const canon = (s) => String(s || '').toLowerCase().replace(/µ/g, 'u').replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (s) => canon(s).replace(/ /g, '');

const ALIAS = new Map();
for (const [key, def] of Object.entries(MARKERS)) {
  for (const a of [key.replace(/_/g, ' '), def.name, ...def.aliases]) { const c = compact(a); if (c && !ALIAS.has(c)) ALIAS.set(c, key); }
}
// Words that never change which marker a name refers to.
const NOISE = new Set(['serum', 'plasma', 'blood', 'whole', 'calc', 'calculated', 'direct', 'lc', 'ms', 'lcms', 'ia', 'eia', 'ria', 'ecl', 'ecli', 'nih', 'level', 'levels', 'test', 'quant', 'quantitative', 'sensitive', 'ultrasensitive', 'random', 'fasting', 'am', 'morning', 'measured', 'result', 'value', 'conc', 'concentration', 's', 'p', 'b', 'bld', 'ser']);

// Ordered, specific-first fallback rules on the canonical (space-separated) name.
const RULES = [
  [/\b1 25\b|dihydroxy|calcitriol/, (s) => (/vit|\bd\b/.test(s) || /calcitriol/.test(s) ? 'vitamin_d_125' : null)],
  [/\b25 ?(oh|hydroxy)|vit(amin)? ?d\b|\bvitd\b/, () => 'vitamin_d'],
  [/ratio/, (s) => (/chol|\btc\b/.test(s) && /hdl/.test(s) ? 'chol_hdl_ratio' : /bun|urea/.test(s) && /creat/.test(s) ? 'bun_creatinine_ratio' : null)],
  [/\bnon ?hdl/, () => 'non_hdl'],
  [/\bvldl/, () => 'vldl'],
  [/\bldl\b.*\b(p|particle|particles|number)\b/, () => 'ldl_p'],
  [/\bldl/, () => 'ldl'],
  [/\bhdl/, () => 'hdl'],
  [/apo(lipoprotein)? ?a ?(1|i)\b/, () => 'apoa1'],
  [/apo(lipoprotein)? ?b/, () => 'apob'],
  [/\blp ?\(?a\b|lipoprotein ?a\b|lipoprotein little a/, () => 'lpa'],
  [/\ba1c\b|hba1c|glyc(at|osyl)ed h(a)?emoglobin|glycohemoglobin/, () => 'hba1c'],
  [/\bcrp\b|hscrp|c reactive/, (s) => (/\bhs\b|hscrp|high sens|cardiac|cardio|ultra/.test(s) ? 'hscrp' : 'crp')],
  [/testosterone|\btestost/, (s) => (/bioavail/.test(s) ? 'bioavailable_testosterone' : /free/.test(s) ? 'free_testosterone' : /dihydro/.test(s) ? 'dht' : 'testosterone_total')],
  [/dhea/, (s) => (/sulf|sulph|\bs\b|so4|dheas/.test(s) ? 'dhea_s' : null)],
  [/uptake/, () => null],
  [/reverse t3|\brt3\b/, () => 'reverse_t3'],
  [/\bt3\b|\bft3\b|triiodothyronine/, (s) => (/free|\bft3\b/.test(s) ? 'free_t3' : 'total_t3')],
  [/\bt4\b|\bft4\b|thyroxine/, (s) => (/free|\bft4\b/.test(s) ? 'free_t4' : 'total_t4')],
  [/\btsh\b|thyroid stim/, () => 'tsh'],
  [/\btpo\b|peroxidase/, () => 'tpo_ab'],
  [/sex hormone|\bshbg\b/, () => 'shbg'],
  [/estradiol|\be2\b/, () => 'estradiol'],
  [/progesterone/, () => 'progesterone'],
  [/prolactin/, () => 'prolactin'],
  [/luteinizing|\blh\b/, () => 'lh'],
  [/follicle|\bfsh\b/, () => 'fsh'],
  [/insulin like|\bigf ?1\b|somatomedin/, () => 'igf1'],
  [/insulin/, () => 'insulin'],
  [/cortisol/, () => 'cortisol'],
  [/\bpsa\b|prostate/, () => 'psa'],
  [/\bb ?12\b|cobalamin/, () => 'b12'],
  [/folate|folic/, () => 'folate'],
  [/ferritin/, () => 'ferritin'],
  [/iron binding|\btibc\b/, () => 'tibc'],
  [/saturation|\btsat\b/, () => 'transferrin_sat'],
  [/\biron\b/, () => 'iron'],
  [/magnesium/, (s) => (/\brbc\b|red/.test(s) ? 'magnesium_rbc' : 'magnesium')],
  [/egfr|\bgfr\b/, (s) => (/(afr|african|black)/.test(s) && !/non ?af/.test(s) ? 'egfr_aa' : 'egfr')],
  [/cystatin/, () => 'cystatin_c'],
  [/creatinine/, (s) => (/clearance/.test(s) ? null : 'creatinine')],
  [/creatine kinase|\bcpk\b|\bck\b/, () => 'ck'],
  [/\bbun\b|urea nitrogen/, () => 'bun'],
  [/\balt\b|sgpt|alanine/, () => 'alt'],
  [/\bast\b|sgot|aspartate/, () => 'ast'],
  [/alk(aline)? phos|\balp\b/, () => 'alp'],
  [/\bggt|gamma glutamyl|gamma gt/, () => 'ggt'],
  [/bilirubin/, (s) => (/direct|indirect|conjugated/.test(s) ? null : 'bilirubin')],
  [/total protein|protein total/, () => 'total_protein'],
  [/microalbumin/, () => null],
  [/albumin/, (s) => (/ratio|globulin/.test(s) ? null : 'albumin')],
  [/globulin/, () => 'globulin'],
  [/glucose/, () => 'glucose'],
  [/triglycer/, () => 'triglycerides'],
  [/cholesterol/, () => 'total_cholesterol'],
  [/homocysteine/, () => 'homocysteine'],
  [/uric/, () => 'uric_acid'],
  [/hematocrit|haematocrit|\bhct\b/, () => 'hematocrit'],
  [/h(a)?emoglobin|\bhgb\b/, () => 'hemoglobin'],
  [/platelet/, () => 'platelets'],
  [/white blood|\bwbc\b|leukocyte/, () => 'wbc'],
  [/red blood|\brbc\b|erythrocyte/, () => 'rbc'],
  [/\bmcv\b|corpuscular volume/, () => 'mcv'],
  [/zinc/, () => 'zinc'],
  [/calcium/, () => 'calcium'],
  [/sodium/, () => 'sodium'],
  [/potassium/, () => 'potassium'],
  [/chloride/, () => 'chloride'],
  [/carbon dioxide|\bco2\b|bicarb/, () => 'co2'],
  [/\bdht\b/, () => 'dht'],
];

const normCache = new Map();
// Report marker name → catalog key (or null). Case/punctuation-insensitive.
export function normalizeMarkerName(name) {
  if (name == null) return null;
  const raw = String(name);
  if (normCache.has(raw)) return normCache.get(raw);
  let key = ALIAS.get(compact(raw)) || null;
  const c = canon(raw);
  if (!key) {
    const stripped = c.split(' ').filter((t) => t && !NOISE.has(t)).join(' ');
    key = ALIAS.get(stripped.replace(/ /g, '')) || null;
  }
  if (!key) {
    for (const [re, pick] of RULES) { if (re.test(c)) { key = pick(c); break; } }
  }
  if (normCache.size > 5000) normCache.clear();
  normCache.set(raw, key);
  return key;
}

/* --------------------------------------------------------------- values */
// Numeric value of a report value ("<0.5" → 0.5 with qualifier '<'); null if not numeric.
export function parseValue(v) {
  if (isNum(v)) return { value: v, qualifier: null };
  if (typeof v !== 'string') return { value: null, qualifier: null };
  const m = /^\s*([<>]=?|≤|≥)?\s*(-?\d+(?:[.,]\d+)?)/.exec(v);
  if (!m) return { value: null, qualifier: null };
  return { value: Number(m[2].replace(',', '.')), qualifier: m[1] || null };
}
const numOrNull = (v) => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && isNum(Number(v)) ? Number(v) : null);

// 'high' | 'low' | 'abnormal' | null from the report's range; the report's own flag when no range.
export function markerFlag(marker) {
  const { value } = parseValue(marker && marker.value);
  const lo = numOrNull(marker && marker.refLow), hi = numOrNull(marker && marker.refHigh);
  if (value != null && (lo != null || hi != null)) {
    if (lo != null && value < lo) return 'low';
    if (hi != null && value > hi) return 'high';
    return null;
  }
  const f = String((marker && marker.flag) || '').trim().toLowerCase();
  if (/^(h|hh|high|above|abnormal high|critical high)/.test(f)) return 'high';
  if (/^(l|ll|low|below|abnormal low|critical low)/.test(f)) return 'low';
  // Qualitative results without a numeric range ("Positive", "Reactive") flagged by the report.
  if (/^(a|abnormal|abn|\*|critical|positive|reactive|detected)$/.test(f)) return 'abnormal';
  return null;
}

// Catalog key for a stored marker (its own key when catalogued, else normalized name).
export function markerKey(marker) {
  if (!marker) return null;
  if (marker.key && MARKERS[marker.key]) return marker.key;
  return normalizeMarkerName(marker.name) || normalizeMarkerName(marker.key) || marker.key || null;
}
const panelDate = (p) => (p.collectedAt || p.date || '').slice(0, 10) || null;

export function markerSeries(dv, key) {
  const out = [];
  for (const panel of dv.labs()) {
    const m = (panel.markers || []).find((x) => markerKey(x) === key);
    if (!m) continue;
    const { value, qualifier } = parseValue(m.value);
    out.push({ date: panelDate(panel), value, unit: m.unit ?? null, flag: markerFlag(m), refLow: numOrNull(m.refLow), refHigh: numOrNull(m.refHigh), qualifier, panelId: panel.id });
  }
  return out.sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : 1));
}

// Out-of-range markers of one panel.
export function panelFlags(panel) {
  const out = [];
  for (const m of (panel && panel.markers) || []) {
    const flag = markerFlag(m); if (!flag) continue;
    const key = markerKey(m);
    out.push({ key, name: m.name || MARKERS[key]?.name || key, value: parseValue(m.value).value, unit: m.unit ?? null, refLow: numOrNull(m.refLow), refHigh: numOrNull(m.refHigh), flag });
  }
  return out;
}

export function labSummary(dv) {
  const panels = dv.labs();
  if (!panels.length) return { latest: null, flagged: [], changes: [], markers: [] };
  const latestPanel = panels[panels.length - 1];
  const flagged = panelFlags(latestPanel);
  const latest = { id: latestPanel.id, date: panelDate(latestPanel), lab: latestPanel.lab ?? null, markerCount: (latestPanel.markers || []).length, flaggedCount: flagged.length };
  const keys = new Map();
  for (const p of panels) for (const m of p.markers || []) { const k = markerKey(m); if (k && !keys.has(k)) keys.set(k, m.name); }
  const markers = [...keys.entries()].map(([key, name]) => {
    const series = markerSeries(dv, key);
    const last = series[series.length - 1] || null;
    return { key, name: MARKERS[key]?.name || name || key, category: MARKERS[key]?.category || 'other', lowerIsBetter: MARKERS[key]?.lowerIsBetter ?? null, latest: last, series };
  });
  const changes = [];
  for (const mk of markers) {
    const s = mk.series.filter((p) => p.value != null);
    const to = s[s.length - 1]; const from = s[s.length - 2];
    if (!to || !from || to.date !== latest.date) continue;
    changes.push({ key: mk.key, name: mk.name, from: from.value, to: to.value, fromDate: from.date, pct: from.value ? r1(((to.value - from.value) / Math.abs(from.value)) * 100) : null });
  }
  changes.sort((a, b) => Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0));
  return { latest, flagged, changes, markers };
}

// Marker values before vs after a protocol item started (start = startedAt or first dose).
export function protocolBeforeAfter(dv, key, itemId) {
  const item = dv.store.getAny ? dv.store.getAny('protocolItems', itemId) : dv.store.get('protocolItems', itemId);
  const doses = ((dv.dosesByItem().get(itemId)) || []).filter((d) => !d.skipped && d.date).map((d) => d.date).sort();
  const start = (item && item.startedAt ? String(item.startedAt).slice(0, 10) : null) || doses[0] || null;
  const end = item && item.endedAt ? String(item.endedAt).slice(0, 10) : null;
  const empty = { before: { mean: null, n: 0 }, after: { mean: null, n: 0 }, delta: null, pct: null, start };
  if (!start) return empty;
  const series = markerSeries(dv, key).filter((p) => p.value != null && p.date);
  const before = series.filter((p) => p.date < start).map((p) => p.value);
  const after = series.filter((p) => p.date >= start && (!end || p.date <= end)).map((p) => p.value);
  const b = mean(before), a = mean(after);
  return {
    before: { mean: r3(b), n: before.length }, after: { mean: r3(a), n: after.length },
    delta: b != null && a != null ? r3(a - b) : null,
    pct: b != null && a != null && b !== 0 ? r1(((a - b) / Math.abs(b)) * 100) : null,
    start,
  };
}
