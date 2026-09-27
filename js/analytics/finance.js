// Net worth from monthly snapshots plus an equity estimate from business gross.
// All parameters come from settings.finance (zero until the user sets them).
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : isNum(Number(v)) && v !== '' && v != null ? Number(v) : null);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

// Equity value = max(0, (gross − expense) × 12 × mult × stake/100). null when gross is unknown.
export function equityFor(gross, finance = {}) {
  const g = num(gross); if (g == null) return null;
  const expense = num(finance.expense) ?? 0, mult = num(finance.mult) ?? 0, stake = num(finance.stake) ?? 0;
  return Math.max(0, (g - expense) * 12 * mult * (stake / 100));
}

// { total, equity, assets, liabilities, byCategory } — byCategory sums item values by
// category with liabilities negative (their contribution to net worth).
export function netWorth(snapshot, finance = {}) {
  if (!snapshot) return { total: null, equity: null, assets: null, liabilities: null, byCategory: {} };
  let assets = 0, liabilities = 0; const byCategory = {};
  for (const it of snapshot.items || []) {
    const v = num(it && it.value); if (v == null) continue;
    const signed = it.type === 'liability' ? -Math.abs(v) : v;
    if (it.type === 'liability') liabilities += Math.abs(v); else assets += v;
    const cat = it.category || (it.type === 'liability' ? 'debt' : 'other');
    byCategory[cat] = r2((byCategory[cat] || 0) + signed);
  }
  const equity = equityFor(snapshot.gross, finance);
  return { total: r2(assets - liabilities + (equity || 0)), equity: r2(equity), assets: r2(assets), liabilities: r2(liabilities), byCategory };
}

export function netWorthSeries(dv) {
  const fin = dv.setting('finance');
  return dv.snapshots().filter((s) => s && s.month).map((s) => {
    const nw = netWorth(s, fin);
    return { month: s.month, total: nw.total, equity: nw.equity, assets: nw.assets, liabilities: nw.liabilities };
  });
}

// Latest and previous month with the change in total net worth.
export function financeSummary(dv) {
  const fin = dv.setting('finance');
  const snaps = dv.snapshots().filter((s) => s && s.month);
  const series = netWorthSeries(dv);
  const mk = (s) => (s ? { month: s.month, gross: num(s.gross), ...netWorth(s, fin) } : null);
  const latest = mk(snaps[snaps.length - 1]);
  const previous = mk(snaps[snaps.length - 2]);
  const delta = latest && previous && isNum(latest.total) && isNum(previous.total) ? r2(latest.total - previous.total) : null;
  return { latest, previous, delta, series };
}
