import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../js/analytics/stats.js';

const close = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

test('stats: descriptive helpers ignore null/NaN and return null when empty', () => {
  assert.equal(S.mean([1, null, 3, NaN, undefined]), 2);
  assert.equal(S.mean([]), null);
  assert.equal(S.mean([null]), null);
  assert.equal(S.median([5, 1, 3, 2]), 2.5);
  close(S.sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395, 1e-12, 'sample sd');
  assert.equal(S.sd([4]), null);
  assert.equal(S.quantile([1, 2, 3, 4, 10], 0.25), 2);
  close(S.quantile([1, 2, 3, 4, 10], 0.9), 7.6, 1e-12);
  assert.equal(S.zscore(12, 10, 2), 1);
  assert.equal(S.zscore(12, 10, 0), null);
  assert.equal(S.zscore(null, 10, 2), null);
});

test('stats: ewma carries through nulls, rolling uses available values', () => {
  assert.deepEqual(S.ewma([null, 10, null, 20], 0.5), [null, 10, 10, 15]);
  assert.deepEqual(S.rolling([1, null, 3, 5], 2), [1, 1, 3, 4]);
  assert.deepEqual(S.rolling([null, null], 3), [null, null]);
});

test('stats: linreg / pearson match reference values and pair out nulls', () => {
  const r = S.linreg([1, 2, 3, 4, 5], [2.1, 3.9, 6.2, 7.8, 10.1]);
  close(r.slope, 1.99, 1e-12); close(r.intercept, 0.05, 1e-12); close(r.r2, 0.997305328900977, 1e-12); assert.equal(r.n, 5);
  const withNulls = S.linreg([1, 2, null, 3, 4, 5, 6], [2.1, 3.9, 99, 6.2, 7.8, 10.1, null]);
  close(withNulls.slope, 1.99, 1e-12); assert.equal(withNulls.n, 5);
  assert.deepEqual(S.linreg([1], [2]), { slope: null, intercept: null, r2: null, n: 1 });
  close(S.pearson([1, 2, 2, 3, 4, 5, 5, 5, 6], [2, 1, 3, 3, 5, 4, 6, 6, 9]), 0.8838834764831843, 1e-12);
  assert.equal(S.pearson([1, 1, 1], [1, 2, 3]), null); // zero variance
});

test('stats: Spearman handles ties with average ranks (scipy reference)', () => {
  const x = [1, 2, 2, 3, 4, 5, 5, 5, 6], y = [2, 1, 3, 3, 5, 4, 6, 6, 9];
  assert.deepEqual(S.ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  const rho = S.spearman(x, y);
  close(rho, 0.9142388742738977, 1e-12, 'rho');
  close(S.corrP(rho, 9), 0.0005588246009131111, 1e-12, 'p');
});

test('stats: Welch t-test matches the textbook example (scipy reference)', () => {
  const a = [27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4];
  const b = [27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4];
  const w = S.welch(a, b);
  close(w.t, -2.455356398286006, 1e-10, 't'); close(w.df, 24.988529290231416, 1e-9, 'df'); close(w.p, 0.021378001462866992, 1e-12, 'p');
  close(w.diff, S.mean(a) - S.mean(b), 1e-12);
  const w2 = S.welch([17.2, 20.9, 22.6, 18.1, 21.7, 21.4, 23.5, 24.2, 14.7, 21.8], [21.5, 22.8, 21.0, 23.0, 21.6, 23.6, 22.5, 20.7, 23.4, 21.8, 20.7, 21.7, 21.5, 22.5, 23.6, 21.5, 22.5, 23.5, 21.5, 21.8]);
  close(w2.t, -1.5654335235985037, 1e-10); close(w2.df, 9.904741248650831, 1e-9); close(w2.p, 0.14884169660532817, 1e-10);
  assert.deepEqual(S.welch([1], [2, 3]), { diff: -1.5, t: null, df: null, p: null });
});

test('stats: t and normal CDFs are accurate (incomplete beta / gamma)', () => {
  close(S.tCdf(2.0, 5), 0.9490302605850708, 1e-12);
  close(S.tCdf(-1.3, 12.5), 0.10853100531714449, 1e-12);
  close(S.tCdf(0.5, 1), 0.6475836176504333, 1e-12);
  close(S.tCdf(3.5, 100), 0.9996517861413219, 1e-12);
  close(S.tCdf(0, 7), 0.5, 1e-15);
  close(S.normalCdf(1.96), 0.9750021048517795, 1e-12);
  close(S.normalCdf(-3.1), 0.0009676032132183563, 1e-14);
  close(S.normalCdf(-9), 1.1285884059538e-19, 1e-30);
  close(S.normalQuantile(0.975), 1.959963984540054, 1e-9);
  assert.equal(S.tCdf(null, 5), null);
});

test('stats: Mann–Whitney U with tie + continuity correction (scipy reference)', () => {
  const r = S.mannWhitney([1, 2, 2, 3, 5, 7, 8], [3, 4, 4, 6, 8, 9, 10, 11]);
  assert.equal(r.u, 12);
  close(r.p, 0.07182633114157258, 1e-12);
  assert.deepEqual(S.mannWhitney([], [1]), { u: null, p: null });
});

test('stats: Benjamini–Hochberg returns q-values in the original order', () => {
  const q = S.benjaminiHochberg([0.01, 0.04, 0.03, 0.005, 0.5, 0.2]);
  [0.03, 0.06, 0.06, 0.03, 0.5, 0.24].forEach((v, i) => close(q[i], v, 1e-12, `q[${i}]`));
  assert.deepEqual(S.benjaminiHochberg([0.02, null, 0.04]), [0.04, null, 0.04]);
  assert.deepEqual(S.benjaminiHochberg([]), []);
  // monotone and capped at 1
  const q2 = S.benjaminiHochberg([0.9, 0.8, 0.95]);
  assert.ok(q2.every((v) => v <= 1));
});

test('stats: Fisher CI and Cohen d', () => {
  const [lo, hi] = S.fisherCI(0.5, 30);
  close(lo, 0.17043136511180015, 1e-9); close(hi, 0.7289585563883555, 1e-9);
  assert.equal(S.fisherCI(0.5, 3), null);
  close(S.cohensD([1, 2, 3], [4, 5, 6]), -3, 1e-12);
});
