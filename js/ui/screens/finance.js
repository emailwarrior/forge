// Finance (#/finance): monthly net-worth snapshots + the company-equity model from settings.finance
// ((gross − overhead) × 12 × multiple × stake). Math lives in js/analytics/finance.js.
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useWide } from '../ctx.js';
import { Page, Card, Button, Empty, Stat, NumberInput, List, ListRow, Meter, cx } from '../kit.js';
import { LineChart } from '../charts.js';
import { financeSummary, netWorth } from '../../analytics/index.js';
import { fmtMoney, isNum } from '../../core/util.js';
import { openSnapshotEditor } from './finance/snapshot.js';
import { monthLabel, equityFormula, categoryRows, snapshotRows } from '../parts/records-finance.js';
import { plural } from '../parts/records-util.js';

const signedMoney = (n) => (isNum(n) ? (n > 0 ? '+' : n < 0 ? '−' : '') + fmtMoney(Math.abs(n)) : '—');

export default function Screen() {
  const app = useApp(); useVersion(['snapshots', 'settings']);
  const wide = useWide();
  const sum = useAnalytics(() => financeSummary(app.dv), []);
  const snaps = app.store.all('snapshots');
  const month = app.today().slice(0, 7);
  const hasThis = !!app.store.get('snapshots', month);
  const edit = (m) => openSnapshotEditor(app, { month: m });
  const action = html`<${Button} size="sm" variant="primary" icon=${hasThis ? 'edit' : 'plus'} onClick=${() => edit(month)}
    title=${hasThis ? `Update the ${monthLabel(month)} snapshot` : `Record the ${monthLabel(month)} snapshot`}>${hasThis ? 'Update' : 'Snapshot'}</${Button}>`;
  const fin = app.store.setting('finance');

  if (!snaps.length || !sum || !sum.latest) {
    return html`<${Page} title="Finance" sub="Net worth and company equity" wide actions=${action}>
      <div class="rec-split even">
        <${Empty} title="No monthly snapshots yet" action=${html`<${Button} variant="primary" icon="plus" onClick=${() => edit(month)}>Record ${monthLabel(month)}</${Button}>`}>
          Once a month, record the company’s gross revenue for the month and your balances: cash, investments, retirement, property, vehicles and debts.
          FORGE charts net worth month over month, including an estimate of your company equity from the equity model.
        </${Empty}>
        <${EquityModel} gross=${null} />
      </div>
    </${Page}>`;
  }

  const { latest, previous, delta, series } = sum;
  const rows = snapshotRows(series, snaps);
  const prevLabel = previous ? monthLabel(previous.month, { short: true }) : null;
  const chartSeries = [
    { key: 'total', label: 'Net worth', points: series.map((r) => ({ x: r.month, y: r.total })) },
    { key: 'equity', label: 'Company equity', points: series.map((r) => ({ x: r.month, y: r.equity })) },
    { key: 'ex', label: 'Excluding equity', points: series.map((r) => ({ x: r.month, y: isNum(r.assets) && isNum(r.liabilities) ? r.assets - r.liabilities : null })) },
  ];
  const d = (a, b) => (previous && isNum(a) && isNum(b) ? a - b : null);
  const tone = (v, invert) => (!isNum(v) || v === 0 ? null : (v > 0) !== !!invert ? 'good' : 'bad');
  const dl = (v) => (isNum(v) ? `${signedMoney(v)} vs ${prevLabel}` : null);

  return html`<${Page} title="Finance" sub=${`Latest ${monthLabel(latest.month)} · ${plural(snaps.length, 'snapshot')}`} wide actions=${action}>
    <div class="grid four">
      <div class="card tight"><${Stat} label=${`Net worth · ${monthLabel(latest.month, { short: true })}`} value=${fmtMoney(latest.total)} delta=${dl(delta)} tone=${tone(delta)} /></div>
      <div class="card tight"><${Stat} label="Equity (estimate)" value=${isNum(latest.equity) ? fmtMoney(latest.equity) : '—'}
        delta=${dl(d(latest.equity, previous && previous.equity))} tone=${tone(d(latest.equity, previous && previous.equity))}
        sub=${!Number(fin.stake) ? 'Set your stake in the equity model' : isNum(latest.gross) ? `From ${fmtMoney(latest.gross)} gross` : 'No gross recorded'} /></div>
      <div class="card tight"><${Stat} label="Assets" value=${fmtMoney(latest.assets)} delta=${dl(d(latest.assets, previous && previous.assets))} tone=${tone(d(latest.assets, previous && previous.assets))} /></div>
      <div class="card tight"><${Stat} label="Liabilities" value=${fmtMoney(latest.liabilities)} delta=${dl(d(latest.liabilities, previous && previous.liabilities))} tone=${tone(d(latest.liabilities, previous && previous.liabilities), true)} /></div>
    </div>

    <div class="rec-split wide-right">
      <${Card} title="Net worth by month">
        <${LineChart} series=${chartSeries} height=${220} yFormat=${(v) => fmtMoney(v, true)} xFormat=${(m) => monthLabel(m, { short: true })}
          emptyText="The trend appears once a second month is recorded" />
      </${Card}>
      <${EquityModel} gross=${latest.gross} month=${latest.month} />
    </div>

    <div class="rec-split wide-right">
      <${Card} title="Snapshots" meta=${plural(rows.length, 'month')} flush>
        ${wide ? html`<div class="table-wrap"><table class="data">
          <thead><tr><th>Month</th><th class="num">Gross</th><th class="num">Assets</th><th class="num">Liabilities</th><th class="num">Equity</th><th class="num">Net worth</th><th class="num">Change</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr class="link" onClick=${() => edit(r.month)}>
            <td class="strong">${monthLabel(r.month)}</td><td class="num">${isNum(r.gross) ? fmtMoney(r.gross) : '—'}</td>
            <td class="num">${fmtMoney(r.assets)}</td><td class="num">${fmtMoney(r.liabilities)}</td><td class="num">${isNum(r.equity) ? fmtMoney(r.equity) : '—'}</td>
            <td class="num strong">${fmtMoney(r.total)}</td><td class=${cx('num', isNum(r.delta) && (r.delta >= 0 ? 'pos' : 'neg'))}>${isNum(r.delta) ? signedMoney(r.delta) : '—'}</td></tr>`)}</tbody>
        </table></div>`
        : html`<${List}>${rows.map((r) => html`<${ListRow} onClick=${() => edit(r.month)} title=${monthLabel(r.month)}
            meta=${[isNum(r.gross) ? `Gross ${fmtMoney(r.gross, true)}` : null, `Assets ${fmtMoney(r.assets, true)}`, r.liabilities ? `Debt ${fmtMoney(r.liabilities, true)}` : null].filter(Boolean).join(' · ')}
            trail=${html`<div class="rec-trail"><div class="mono small">${fmtMoney(r.total)}</div><div class=${cx('xs mono', isNum(r.delta) ? (r.delta >= 0 ? 'pos' : 'neg') : 'muted')}>${isNum(r.delta) ? signedMoney(r.delta) : '—'}</div></div>`} />`)}</${List}>`}
      </${Card}>
      <${Breakdown} snapshot=${snaps.find((s) => s.month === latest.month)} />
    </div>
  </${Page}>`;
}

/* ---------------------------------------------------------- breakdown */
function Breakdown({ snapshot }) {
  const app = useApp();
  const nw = useAnalytics(() => netWorth(snapshot, app.dv.setting('finance')), [snapshot]);
  if (!snapshot || !nw) return null;
  const rows = categoryRows(nw.byCategory);
  if (isNum(nw.equity) && nw.equity > 0) rows.push({ id: '_equity', label: 'Equity (est.)', value: nw.equity });
  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return html`<${Card} title=${`Breakdown · ${monthLabel(snapshot.month, { short: true })}`} meta="Liabilities negative">
    ${rows.length ? html`<div class="stack sm">${rows.map((r) => html`<div class="rec-bar-row">
      <span class="dim ellipsis small">${r.label}</span>
      <${Meter} value=${Math.abs(r.value)} max=${max} tone=${r.value < 0 ? 'bad' : null} />
      <span class=${cx('mono small right', r.value < 0 && 'neg')}>${r.value < 0 ? '−' : ''}${fmtMoney(Math.abs(r.value), true)}</span></div>`)}
      <div class="divider"></div>
      <div class="row between small"><span class="strong">Net worth</span><span class="mono strong">${fmtMoney(nw.total)}</span></div></div>`
    : html`<div class="dim small">No balances recorded for this month.</div>`}
  </${Card}>`;
}

/* -------------------------------------------------------- equity model */
function EquityModel({ gross, month }) {
  const app = useApp();
  const fin = app.store.setting('finance');
  const [f, setF] = useState({ mult: fin.mult, stake: fin.stake, expense: fin.expense });
  // Debounced write (≈400 ms) that merges fields typed in quick succession and flushes on unmount.
  const pending = useRef(null); const timer = useRef(null);
  const flush = () => { clearTimeout(timer.current); timer.current = null; const p = pending.current; pending.current = null; if (p) app.store.updateSetting('finance', p); };
  useEffect(() => () => flush(), []);
  // Follow edits made elsewhere (another device) while no local edit is pending.
  useEffect(() => { if (!pending.current) setF((cur) => (cur.mult === fin.mult && cur.stake === fin.stake && cur.expense === fin.expense ? cur : { mult: fin.mult, stake: fin.stake, expense: fin.expense })); }, [fin.mult, fin.stake, fin.expense]);
  const set = (k) => (v) => {
    setF((x) => ({ ...x, [k]: v }));
    pending.current = { ...(pending.current || {}), [k]: isNum(v) ? v : 0 };
    clearTimeout(timer.current); timer.current = setTimeout(flush, 400);
  };
  const formula = equityFormula(isNum(gross) ? gross : null, { mult: f.mult ?? 0, stake: f.stake ?? 0, expense: f.expense ?? 0 });
  return html`<${Card} title="Equity model" meta="Estimate">
    <div class="stack">
      <div class="stack sm">
        <label class="rec-model-row"><span><span class="small strong">Valuation multiple</span><span class="xs muted">Applied to annual profit</span></span>
          <${NumberInput} value=${f.mult} onValue=${set('mult')} min="0" step="0.5" suffix="×" /></label>
        <label class="rec-model-row"><span><span class="small strong">Your stake</span><span class="xs muted">Ownership share</span></span>
          <${NumberInput} value=${f.stake} onValue=${set('stake')} min="0" max="100" step="0.5" suffix="%" /></label>
        <label class="rec-model-row"><span><span class="small strong">Monthly overhead</span><span class="xs muted">Non-salary costs</span></span>
          <${NumberInput} value=${f.expense} onValue=${set('expense')} min="0" step="100" suffix="$" /></label>
      </div>
      <div class="rec-formula">
        <div class="xs muted">(gross − overhead) × 12 × multiple × stake</div>
        <div class="mono small">${formula.text} = <b>${formula.result ?? '—'}</b></div>
      </div>
      <div class="xs muted">${month ? `Uses ${monthLabel(month)} gross. ` : ''}Gross revenue is recorded with each monthly snapshot; the estimate is never negative. Stored in your encrypted settings.</div>
    </div>
  </${Card}>`;
}
