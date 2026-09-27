// Statistics primitives. Pure and dependency-free.
// Every function ignores null/NaN values (pairwise for paired x/y inputs) and
// returns null — never 0 — when a quantity cannot be computed.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (arr) => (arr || []).filter(isNum);

// Paired, finite (x, y) values from two parallel arrays.
export function pairs(xs, ys) {
  const x = [], y = [];
  const n = Math.min(xs?.length || 0, ys?.length || 0);
  for (let i = 0; i < n; i++) if (isNum(xs[i]) && isNum(ys[i])) { x.push(xs[i]); y.push(ys[i]); }
  return [x, y];
}

/* ------------------------------------------------------------ descriptive */
export function sum(arr) { let s = 0; for (const v of nums(arr)) s += v; return s; }
export function mean(arr) {
  const a = nums(arr); if (!a.length) return null;
  let s = 0; for (const v of a) s += v; return s / a.length;
}
export function variance(arr) {
  const a = nums(arr); if (a.length < 2) return null;
  const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2;
  return s / (a.length - 1);
}
// Sample standard deviation (n − 1).
export function sd(arr) { const v = variance(arr); return v == null ? null : Math.sqrt(v); }
// Linear-interpolated quantile (R type 7 / numpy default).
export function quantile(arr, q) {
  const a = nums(arr).sort((x, y) => x - y);
  if (!a.length || !isNum(q)) return null;
  const pos = (a.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
export function median(arr) { return quantile(arr, 0.5); }
export function zscore(x, m, s) { return isNum(x) && isNum(m) && isNum(s) && s > 1e-12 ? (x - m) / s : null; }

// Exponentially weighted moving average; null inputs carry the previous value
// (leading nulls stay null).
export function ewma(values, alpha) {
  const out = []; let prev = null;
  for (const v of values || []) {
    if (isNum(v)) prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

// out[i] = fn(finite values among values[i-window+1 .. i]); null when none.
export function rolling(values, window, fn = mean) {
  const arr = values || []; const out = [];
  for (let i = 0; i < arr.length; i++) {
    const w = nums(arr.slice(Math.max(0, i - window + 1), i + 1));
    out.push(w.length ? fn(w) : null);
  }
  return out;
}

/* ------------------------------------------------------ regression / corr */
export function linreg(xs, ys) {
  const [x, y] = pairs(xs, ys); const n = x.length;
  if (n < 2) return { slope: null, intercept: null, r2: null, n };
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx === 0) return { slope: null, intercept: null, r2: null, n };
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? null : (sxy * sxy) / (sxx * syy), n };
}

export function pearson(xs, ys) {
  const [x, y] = pairs(xs, ys); const n = x.length;
  if (n < 3) return null;
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

// 1-based ranks; ties get the average rank.
export function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

// Spearman's rho = Pearson on average ranks (ties handled).
export function spearman(xs, ys) {
  const [x, y] = pairs(xs, ys);
  if (x.length < 3) return null;
  return pearson(ranks(x), ranks(y));
}

// Two-sided p-value of a correlation coefficient via the t approximation (df = n − 2).
export function corrP(r, n) {
  if (!isNum(r) || !isNum(n) || n < 3) return null;
  if (Math.abs(r) >= 1) return 0;
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return tTwoSided(t, n - 2);
}

// Fisher z confidence interval for a correlation.
export function fisherCI(r, n, level = 0.95) {
  if (!isNum(r) || !isNum(n) || n <= 3 || Math.abs(r) >= 1) return null;
  const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3);
  const zc = normalQuantile(1 - (1 - level) / 2);
  return [Math.tanh(z - zc * se), Math.tanh(z + zc * se)];
}

/* ------------------------------------------------------------- tests */
// Welch's unequal-variance t-test. diff = mean(a) − mean(b); p two-sided.
export function welch(a, b) {
  const x = nums(a), y = nums(b);
  const na = x.length, nb = y.length;
  if (na < 2 || nb < 2) return { diff: na && nb ? mean(x) - mean(y) : null, t: null, df: null, p: null };
  const diff = mean(x) - mean(y);
  const va = variance(x) / na, vb = variance(y) / nb;
  const se2 = va + vb;
  if (se2 === 0) return { diff, t: diff === 0 ? 0 : Math.sign(diff) * Infinity, df: na + nb - 2, p: diff === 0 ? 1 : 0 };
  const t = diff / Math.sqrt(se2);
  const df = (se2 * se2) / ((va * va) / (na - 1) + (vb * vb) / (nb - 1));
  return { diff, t, df, p: tTwoSided(t, df) };
}

// Cohen's d with pooled SD (a − b).
export function cohensD(a, b) {
  const x = nums(a), y = nums(b);
  if (x.length < 2 || y.length < 2) return null;
  const sp = Math.sqrt(((x.length - 1) * variance(x) + (y.length - 1) * variance(y)) / (x.length + y.length - 2));
  return sp > 0 ? (mean(x) - mean(y)) / sp : null;
}

// Mann–Whitney U (u = U statistic of sample a). Two-sided p from the normal
// approximation with tie correction and continuity correction.
export function mannWhitney(a, b) {
  const x = nums(a), y = nums(b);
  const n1 = x.length, n2 = y.length;
  if (!n1 || !n2) return { u: null, p: null };
  const all = x.concat(y); const r = ranks(all); const n = n1 + n2;
  let r1 = 0; for (let i = 0; i < n1; i++) r1 += r[i];
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  // Tie correction term Σ(t³ − t).
  const counts = new Map(); for (const v of all) counts.set(v, (counts.get(v) || 0) + 1);
  let tie = 0; for (const t of counts.values()) tie += t * t * t - t;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * ((n + 1) - tie / (n * (n - 1))));
  if (!(sigma > 0)) return { u: u1, p: 1 };
  const u = Math.max(u1, n1 * n2 - u1);
  const z = (u - mu - 0.5) / sigma;
  return { u: u1, p: Math.min(1, 2 * (1 - normalCdf(z))) };
}

// Benjamini–Hochberg q-values, returned in the original order (nulls stay null).
export function benjaminiHochberg(pvals) {
  const out = (pvals || []).map(() => null);
  const idx = []; (pvals || []).forEach((p, i) => { if (isNum(p)) idx.push(i); });
  const m = idx.length; if (!m) return out;
  idx.sort((i, j) => pvals[i] - pvals[j]);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const i = idx[k];
    prev = Math.min(prev, (pvals[i] * m) / (k + 1));
    out[i] = Math.min(1, prev);
  }
  return out;
}

/* ---------------------------------------------------- distributions */
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

export function lnGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lnGamma(1 - z);
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

const FPMIN = 1e-300, EPS = 1e-15, MAXIT = 500;

// Continued fraction for the incomplete beta function (modified Lentz; Numerical Recipes betacf).
function betacf(x, a, b) {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a, b).
export function incompleteBeta(x, a, b) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const lbt = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

// Two-sided tail probability P(|T| ≥ |t|) for Student's t with df degrees of freedom.
export function tTwoSided(t, df) {
  if (!isNum(df) || df <= 0) return null;
  if (t === Infinity || t === -Infinity) return 0;
  if (!isNum(t)) return null;
  return Math.min(1, incompleteBeta(df / (df + t * t), df / 2, 0.5));
}

// Student t CDF via the regularized incomplete beta function.
export function tCdf(t, df) {
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  if (!isNum(t) || !isNum(df) || df <= 0) return null;
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

// Regularized lower incomplete gamma P(a, x): series or continued fraction.
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a, del = 1 / a, s = del;
    for (let n = 0; n < MAXIT; n++) { ap += 1; del *= x / ap; s += del; if (Math.abs(del) < Math.abs(s) * EPS) break; }
    return s * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  return 1 - gammaQcf(a, x);
}
function gammaQcf(a, x) {
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < MAXIT; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}
function erfc(x) {
  if (x < 0) return 2 - erfc(-x);
  const x2 = x * x;
  return x2 < 1.5 ? 1 - gammaP(0.5, x2) : gammaQcf(0.5, x2);
}

export function normalCdf(z) {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  if (!isNum(z)) return null;
  return 0.5 * erfc(-z / Math.SQRT2);
}

// Inverse standard normal CDF (Acklam's rational approximation + one Halley step).
export function normalQuantile(p) {
  if (!isNum(p) || p <= 0 || p >= 1) return p === 0 ? -Infinity : p === 1 ? Infinity : null;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5, r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
