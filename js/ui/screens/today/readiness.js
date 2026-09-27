// Today → Readiness: score + band, training mode with its strain target, HRV / RHR / sleep vs the
// 30-day baseline, drivers, focus window, flags, and the morning brief (stored in reviews
// `brief:<date>`, generated once for today when readiness is scored and an AI key is set).
import { html, useEffect } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useWide } from '../../ctx.js';
import { Card, BandPill, Button, Notice, Icon, cx } from '../../kit.js';
import { Ring } from '../../charts.js';
import { useAiTask, AiStatus, AiError, CostNote } from '../../parts/ai.js';
import { Metric } from '../../parts/day-ui.js';
import { fmtAgo, fmtSpan, fmtSigned } from '../../parts/day-model.js';
import { calorieTargets } from '../../../analytics/index.js';
import { morningBrief } from '../../../ai/index.js';
import { fmtDur, fmtNum, isNum, nowIso, hmToMin } from '../../../core/util.js';

const BAND_COLOR = { green: 'var(--good)', yellow: 'var(--warn)', red: 'var(--bad)' };
// Module-level guards: one generation per date at a time; no automatic retry after a failure.
const inflight = new Set();
const autoFailed = new Set();

const toneOfZ = (z, lowerIsBetter = false) => { if (!isNum(z)) return null; const g = lowerIsBetter ? -z : z; return g >= 0.5 ? 'good' : g <= -0.5 ? 'bad' : null; };

export function ReadinessCard({ date, r, isToday }) {
  const app = useApp(); useVersion(['whoopRecovery', 'whoopSleep', 'status', 'settings']);
  const wide = useWide();
  if (!r) return null;
  if (r.status === 'no-data') return html`<${ReadinessEmpty} r=${r} isToday=${isToday} />`;
  const m = r.metrics; const t = r.training;
  const [lo, hi] = t.strainTarget || [];
  const ratio = isNum(m.sleepMin) && isNum(m.sleepNeedMin) && m.sleepNeedMin > 0 ? m.sleepMin / m.sleepNeedMin : null;
  const calibrating = r.status === 'calibrating';
  const flags = (r.flags || []).filter((f) => f.level !== 'info' || calibrating);
  const base = calibrating ? 'early baseline' : 'baseline';
  return html`<${Card} title="Readiness" meta=${r.scoreSource === 'whoop' ? 'WHOOP recovery' : r.scoreSource === 'composite' ? 'HRV · RHR · sleep composite' : null}
    action=${html`<${BandPill} band=${r.band}>${r.band ? null : calibrating ? 'Calibrating' : null}</${BandPill}>`}>
    <div class="day-ready">
      <${Ring} value=${r.score} size=${wide ? 104 : 92} stroke=${9} color=${BAND_COLOR[r.band] || 'var(--text-3)'}
        label=${isNum(r.score) ? Math.round(r.score) : '—'} sub=${r.scoreSource === 'composite' ? 'READINESS' : 'RECOVERY'} />
      <div class="grow stack xs" style="min-width:0">
        <div class="row wrap" style="gap:8px"><span class="day-mode">${t.label}</span>
          ${isNum(lo) ? html`<span class="tag" title="WHOOP day strain target">strain ${lo}–${hi}</span>` : null}</div>
        <div class="small dim">${r.summary}</div>
        ${r.focus && r.focus.start
          ? html`<div class="small day-focus"><${Icon} name="target" size=${14} /><span><b>Focus ${fmtSpan(hmToMin(r.focus.start), hmToMin(r.focus.end))}</b> <span class="muted">· ${r.focus.note}</span></span></div>`
          : r.focus ? html`<div class="xs muted">${r.focus.note}</div>` : null}
      </div>
    </div>
    <div class="day-metrics">
      <${Metric} label="HRV" value=${isNum(m.hrv) ? fmtNum(m.hrv, 0) : null} unit="ms" tone=${toneOfZ(m.hrvZ)}
        sub=${isNum(m.hrv) && isNum(m.hrvBase) ? `${fmtSigned(m.hrv - m.hrvBase, 0)} vs ${fmtNum(m.hrvBase, 0)} ${base}` : isNum(m.hrv) ? 'baseline building' : null} />
      <${Metric} label="Resting HR" value=${isNum(m.rhr) ? fmtNum(m.rhr, 0) : null} unit="bpm" tone=${toneOfZ(m.rhrZ, true)}
        sub=${isNum(m.rhr) && isNum(m.rhrBase) ? `${fmtSigned(m.rhr - m.rhrBase, 0)} vs ${fmtNum(m.rhrBase, 0)} ${base}` : isNum(m.rhr) ? 'baseline building' : null} />
      <${Metric} label="Sleep" value=${isNum(m.sleepMin) ? fmtDur(m.sleepMin) : null}
        tone=${ratio == null ? null : ratio >= 0.95 ? 'good' : ratio < 0.85 ? 'bad' : null}
        sub=${ratio != null ? `${Math.round(ratio * 100)}% of ${fmtDur(m.sleepNeedMin)} need` : null} />
      <${Metric} label="Sleep debt" value=${isNum(m.sleepDebtMin) ? fmtDur(m.sleepDebtMin) : null} tone=${isNum(m.sleepDebtMin) && m.sleepDebtMin >= 60 ? 'bad' : null}
        sub=${isNum(m.sleepPerf) ? `performance ${fmtNum(m.sleepPerf, 0)}%` : null} />
    </div>
    ${r.drivers && r.drivers.length ? html`<div class="day-drivers">
      ${r.drivers.slice(0, 5).map((d) => html`<div class=${cx('drv', d.impact)}><i aria-hidden="true"></i><span>${d.text}</span></div>`)}
    </div>` : null}
    ${flags.length ? html`<div class="stack sm" style="margin-top:12px">${flags.map((f) => html`<${Notice} tone=${f.level === 'alert' ? 'bad' : f.level === 'warn' ? 'warn' : null}>${f.text}</${Notice}>`)}</div>` : null}
    <${MorningBrief} date=${date} r=${r} isToday=${isToday} />
  </${Card}>`;
}

/* No readiness data: explain what fills it (WHOOP), or that today's score is still pending. */
function ReadinessEmpty({ r, isToday }) {
  const app = useApp(); const { store } = app;
  const connected = !!(store.setting('integrations').whoop || {}).connectedAt;
  const anyData = store.all('whoopRecovery').length > 0 || store.all('whoopSleep').length > 0;
  const st = store.get('status', 'whoop');
  const t = r.training;
  if (!connected && !anyData) {
    return html`<${Card} title="Readiness">
      <div class="day-empty-row">
        <div class="day-empty-ic"><${Icon} name="heart" /></div>
        <div class="grow stack xs">
          <div class="strong">Connect WHOOP to score readiness</div>
          <div class="small dim">Recovery, HRV, resting HR and sleep vs need arrive each morning and drive the training mode, strain target and focus window.</div>
          <div class="xs muted">Until then: ${t.label} — train by feel (strain ${t.strainTarget.join('–')}).</div>
        </div>
      </div>
      <div class="row" style="margin-top:12px"><${Button} size="sm" variant="primary" icon="link" onClick=${() => app.nav('/settings/integrations')}>Connect WHOOP</${Button}></div>
    </${Card}>`;
  }
  return html`<${Card} title="Readiness" action=${html`<${BandPill} band=${null}>Not scored</${BandPill}>`}>
    <div class="day-empty-row">
      <div class="day-empty-ic"><${Icon} name="clock" /></div>
      <div class="grow stack xs">
        <div class="strong">${isToday ? 'Waiting for today’s recovery' : 'No WHOOP data for this day'}</div>
        <div class="small dim">${isToday ? 'WHOOP scores recovery after you wake; automation syncs it hourly.' : 'Recovery, HRV and sleep were not recorded for this date.'}</div>
        ${isToday ? html`<div class="xs muted">Meanwhile: ${t.label} · strain ${t.strainTarget.join('–')}${r.focus && r.focus.start ? ` · focus ${fmtSpan(hmToMin(r.focus.start), hmToMin(r.focus.end))} (from your wake target)` : ''}.</div>` : null}
        ${st && st.lastOkAt ? html`<div class="xs muted">Last WHOOP sync ${fmtAgo(st.lastOkAt)}${st.lastError ? ' · last run failed: ' + st.lastError : ''}</div>` : null}
      </div>
    </div>
  </${Card}>`;
}

/* Morning brief: stored review `brief:<date>`; auto-generated once for today. */
function MorningBrief({ date, r, isToday }) {
  const app = useApp(); useVersion(['reviews']);
  const task = useAiTask();
  const rec = app.store.get('reviews', 'brief:' + date);
  const text = rec && rec.content && rec.content.text;
  const hasKey = !!app.ai();
  const scored = !!r && isNum(r.score);

  const generate = async (auto) => {
    const cfg = app.ai();
    if (!cfg || inflight.has(date)) return;
    inflight.add(date);
    let failure = null;
    try {
      const dv = app.dv;
      const res = await task.run(async ({ ai, signal, onProgress }) => {
        try {
          return await morningBrief(ai, { date, readiness: r, plan: dv.plan(date), events: dv.events(date), nutritionTargets: calorieTargets(dv, date), signal, onProgress });
        } catch (e) { failure = e; throw e; }
      }, { ai: cfg });
      if (res && res.text) {
        app.store.upsert('reviews', 'brief:' + date, { kind: 'brief', period: date, date, createdAt: nowIso(dv.tz), model: res.model, costUsd: res.costUsd, content: { text: res.text }, _d: null });
      } else if (auto && failure && failure.code !== 'aborted') autoFailed.add(date);
    } finally { inflight.delete(date); }
  };

  useEffect(() => {
    if (isToday && scored && !text && hasKey && !inflight.has(date) && !autoFailed.has(date)) generate(true);
  }, [date, isToday, scored, !!text, hasKey]);

  if (!text && !isToday) return null;
  if (!text && !hasKey) {
    return scored ? html`<div class="day-brief-hint xs muted">Morning brief needs an Anthropic key — <button type="button" class="day-linkbtn" onClick=${() => app.nav('/settings/ai')}>Settings → AI</button></div>` : null;
  }
  return html`<div class="day-brief">
    <div class="row between" style="gap:8px;min-height:32px">
      <span class="eyebrow">Morning brief</span>
      ${isToday && hasKey && !task.busy ? html`<${Button} size="sm" variant="ghost" icon="repeat" onClick=${() => generate(false)} title="Write the brief again">${text ? 'Regenerate' : 'Generate'}</${Button}>` : null}
    </div>
    ${task.busy ? html`<${AiStatus} task=${task} label="Writing the brief…" />` : null}
    ${task.error && !task.busy ? html`<${AiError} error=${task.error} onRetry=${() => generate(false)} />` : null}
    ${text ? html`<p class="day-brief-text">${text}</p>`
      : !task.busy && !task.error ? html`<div class="xs muted">${scored ? 'Written once per day from readiness, plan, calendar and nutrition targets.' : 'Written once today’s recovery is scored.'}</div>` : null}
    ${rec && text && !task.busy ? html`<div><${CostNote} usd=${rec.costUsd} model=${rec.model} /></div>` : null}
  </div>`;
}
