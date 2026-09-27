// Insights › Weekly: a Mon–Sun week (default: the last complete one; ?w=<any date in the week>) —
// weekStats (averages and deltas vs the prior week, best/worst day, training, adherence, highlights, gaps)
// and the weekly review (reviews 'weekly:<isoWeek>', made by automation or here with Generate).
import { html } from '../../../vendor/preact-htm.js';
import { useApp } from '../../ctx.js';
import { Card, Pill, Button, IconButton, Notice } from '../../kit.js';
import { useAiTask, AiStatus, AiError, CostNote, AiKeyNotice } from '../../parts/ai.js';
import { removeWithUndo } from '../../parts/common.js';
import { weekStats, buildDaily, findDrivers } from '../../../analytics/index.js';
import { weeklyReview } from '../../../ai/index.js';
import { addDays, diffDays, weekStart, isoWeek, isYmd, nowIso, fmtNum, fmtDur, fmtDate, isNum } from '../../../core/util.js';
import { lastCompleteWeek, weekLabel, fmtSigned, plural } from '../../parts/insights-logic.js';
import { useInsight, StatGrid, SectionSkeleton } from '../../parts/insights-kit.js';

// [key, label, format, dp, lowerIsBetter, neutral]
const METRICS = [
  ['recovery', 'Recovery', (v) => fmtNum(v) + '%', 0],
  ['hrv', 'HRV', (v) => fmtNum(v, 1) + ' ms', 1],
  ['rhr', 'Resting HR', (v) => fmtNum(v, 1) + ' bpm', 1, true],
  ['sleepMin', 'Asleep', (v) => fmtDur(v), 0],
  ['sleepNeedMin', 'Sleep need', (v) => fmtDur(v), 0, false, true],
  ['sleepPerf', 'Sleep performance', (v) => fmtNum(v) + '%', 0],
  ['dayStrain', 'Day strain', (v) => fmtNum(v, 1), 1, false, true],
  ['kcalIn', 'Calories', (v) => fmtNum(v) + ' kcal', 0, false, true],
  ['proteinG', 'Protein', (v) => fmtNum(v) + ' g', 0],
  ['executionScore', 'Execution score', (v) => fmtNum(v), 0],
  ['deepWorkH', 'Deep work', (v) => fmtNum(v, 1) + ' h', 1],
  ['planAdherence', 'Plan adherence', (v) => fmtNum(v) + '%', 0],
  ['energy', 'Energy (1–5)', (v) => fmtNum(v, 1), 1],
  ['meetingMin', 'Meetings / day', (v) => fmtDur(v), 0, true],
  ['weightTrendLb', 'Weight trend', (v) => fmtNum(v, 1) + ' lb', 1, false, true],
];
const deltaText = (key, v) => { const m = METRICS.find((x) => x[0] === key); if (!isNum(v)) return '—'; return key === 'sleepMin' || key === 'sleepNeedMin' || key === 'meetingMin' ? (v >= 0 ? '+' : '−') + fmtDur(Math.abs(v)) : fmtSigned(v, m ? m[3] : 0); };
const toneOf = (key, v) => { const m = METRICS.find((x) => x[0] === key); if (!m || m[5] || !isNum(v) || v === 0) return ''; return (v > 0) !== !!m[4] ? 'pos' : 'neg'; };

// Same inputs the automation uses for server-made reviews (automation/reviews.mjs).
function reviewInputs(app, week) {
  const dv = app.dv;
  const stats = weekStats(dv, week);
  const drivers = findDrivers(buildDaily(dv, addDays(week, -120), addDays(week, 6))).slice(0, 10);
  const profile = app.store.setting('profile'); const targets = app.store.setting('targets');
  const goals = {
    weightLow: profile.goalWeightLow, weightHigh: profile.goalWeightHigh, rateLbWk: profile.goalRateLbWk,
    sleepTargetH: targets.sleepTargetH, deepWorkTargetH: targets.deepWorkTargetH, wake: targets.wake, bedtime: targets.bedtime,
  };
  const prev = app.store.get('reviews', `weekly:${isoWeek(addDays(week, -7))}`);
  return { stats, drivers, goals, lastFocus: (prev && prev.content && prev.content.focus) || null };
}

export default function Weekly({ app, today, query, setQuery, dataStart }) {
  const current = weekStart(today);
  // Default: the last complete week, or this week while the history is younger than that.
  const lastFull = lastCompleteWeek(today);
  const def = dataStart && addDays(lastFull, 6) < dataStart ? current : lastFull;
  const week = isYmd(query.w) ? weekStart(query.w) : def;
  const { data: s, ms } = useInsight(() => weekStats(app.dv, week), [week]);
  const task = useAiTask();
  if (!s) return html`<${SectionSkeleton} />`;
  const id = `weekly:${isoWeek(week)}`;
  const review = app.store.get('reviews', id);
  const past = app.store.all('reviews').filter((r) => r.kind === 'weekly' && r.content).sort((a, b) => (a.period < b.period ? 1 : -1));
  const go = (w) => setQuery({ w: w === def ? null : w });
  const future = week > current;
  // Days before the first log are not "logged" days, whatever the standards score says.
  const wEnd = addDays(week, 6) < today ? addDays(week, 6) : today;
  const covered = dataStart && !future ? Math.max(0, diffDays(week < dataStart ? dataStart : week, wEnd) + 1) : 0;
  const logged = Math.min(s.daysLogged, covered);
  const partial = !!dataStart && week < dataStart && logged > 0;
  const canGen = logged >= 3;
  // Week-over-week deltas only when the prior week is inside the history (else they compare against nothing).
  const prevOk = !!dataStart && addDays(week, -7) >= dataStart;

  const generate = async () => {
    const res = await task.run(({ ai, signal, onProgress }) => weeklyReview(ai, { ...reviewInputs(app, week), signal, onProgress }));
    if (!res) return;
    const old = app.store.get('reviews', id);
    app.store.upsert('reviews', id, {
      kind: 'weekly', period: isoWeek(week), date: week, createdAt: nowIso(app.dv.tz), model: res.model || null, costUsd: isNum(res.costUsd) ? res.costUsd : null, source: 'app',
      content: { headline: res.headline || '', summary: res.summary || '', whatWorked: res.whatWorked || [], whatDidnt: res.whatDidnt || [], focus: res.focus || null },
    });
    if (old && old.content) {
      const back = { createdAt: old.createdAt ?? null, model: old.model ?? null, costUsd: old.costUsd ?? null, source: old.source ?? null, content: old.content };
      app.toast('Weekly review regenerated', { action: { label: 'Undo', onClick: () => app.store.update('reviews', id, back) } });
    } else app.toast('Weekly review saved');
  };

  const a = s.averages, dl = prevOk ? s.deltas : {};
  return html`<div class="stack" data-ms=${ms}>
    <div class="row between wrap" style="gap:8px">
      <div class="ins-week-nav">
        <${IconButton} icon="chevronLeft" label="Previous week" bordered sm onClick=${() => go(addDays(week, -7))} />
        <span class="lbl">${isoWeek(week).replace(/^\d{4}-/, '')} · ${weekLabel(week, today)}</span>
        <${IconButton} icon="chevronRight" label="Next week" bordered sm disabled=${week >= current} onClick=${() => week < current && go(addDays(week, 7))} />
      </div>
      <div class="row" style="gap:6px">
        ${!s.complete && !future ? html`<${Pill} tone="accent">In progress</${Pill}>` : null}
        ${week !== def ? html`<${Button} size="sm" variant="ghost" onClick=${() => go(def)}>Last complete week</${Button}>` : null}
      </div>
    </div>
    ${partial ? html`<${Notice}>Your history starts ${fmtDate(dataStart, { dow: false })}; the ${diffDays(week, dataStart)} earlier day${diffDays(week, dataStart) === 1 ? '' : 's'} of this week have no logs and pull some averages down.</${Notice}>` : null}
    ${!logged ? html`<${Card}><div class="small dim">${future ? 'This week has not started yet.' : `Nothing was logged in the week of ${weekLabel(week, today)}.`}${past.length ? ' Pick a week with a review below.' : ''}</div></${Card}>` : html`
    <${StatGrid} items=${[
      { label: 'Recovery avg', value: isNum(a.recovery) ? fmtNum(a.recovery) : '—', unit: '%', delta: isNum(dl.recovery) ? { text: deltaText('recovery', dl.recovery) + ' vs prior week', tone: dl.recovery > 0 ? 'good' : dl.recovery < 0 ? 'bad' : null } : null },
      { label: 'Asleep avg', value: isNum(a.sleepMin) ? fmtDur(a.sleepMin) : '—', delta: isNum(dl.sleepMin) ? { text: deltaText('sleepMin', dl.sleepMin) + ' vs prior week', tone: dl.sleepMin > 0 ? 'good' : dl.sleepMin < 0 ? 'bad' : null } : null },
      { label: 'Execution avg', value: isNum(a.executionScore) ? fmtNum(a.executionScore) : '—', delta: isNum(dl.executionScore) ? { text: deltaText('executionScore', dl.executionScore) + ' vs prior week', tone: dl.executionScore > 0 ? 'good' : dl.executionScore < 0 ? 'bad' : null } : null, sub: `${plural(s.perfectDays, 'perfect day')}` },
      { label: 'Weight trend', value: isNum(s.weightChange) ? fmtSigned(s.weightChange, 1) : '—', unit: isNum(s.weightChange) ? 'lb' : '', sub: isNum(a.weightTrendLb) ? `avg ${fmtNum(a.weightTrendLb, 1)} lb` : null },
    ]} />`}
    <${ReviewCard} review=${review} task=${task} generate=${generate} canGen=${canGen} logged=${logged} future=${future} complete=${s.complete} id=${id} />
    ${logged ? html`<div class="ins-grid two">
      <${Card} title="Week in numbers" meta=${prevOk ? 'avg · vs prior week' : 'avg · prior week predates your history'}>
        <div class="table-wrap"><table class="data ins-table"><tbody>${METRICS.filter(([k]) => isNum(a[k])).map(([k, label, fmt]) => html`<tr>
          <td>${label}</td><td class="num">${fmt(a[k])}</td><td class=${'num ' + toneOf(k, dl[k])}>${deltaText(k, dl[k])}</td></tr>`)}</tbody></table></div>
      </${Card}>
      <div class="stack">
        <${Card} title="Highlights" meta=${plural(logged, 'day') + ' logged'}>
          ${s.highlights.length ? html`<ul class="ins-points">${s.highlights.map((h) => html`<li>${h}</li>`)}</ul>` : html`<div class="small dim">No highlights yet.</div>`}
        </${Card}>
        <${Card} title="Training and adherence">
          <div class="ins-list">
            <${Line} k="Sessions" v=${`${s.training.sessions} · ${fmtNum(s.training.sets)} hard sets`} />
            <${Line} k="PRs" v=${s.training.prs ? `${s.training.prs}` : '0'} />
            <${Line} k="Protein target hit" v=${isNum(s.adherence.protein) ? s.adherence.protein + '%' : '—'} />
            <${Line} k="Calories within ±10%" v=${isNum(s.adherence.kcal) ? s.adherence.kcal + '%' : '—'} />
            <${Line} k="Supplements taken" v=${isNum(s.adherence.stack) ? s.adherence.stack + '%' : '—'} />
            ${s.best ? html`<${Line} k="Best day" v=${`${fmtDate(s.best.date)} · exec ${fmtNum(s.best.executionScore)} · rec ${isNum(s.best.recovery) ? s.best.recovery + '%' : '—'}`} />` : null}
            ${s.worst ? html`<${Line} k="Hardest day" v=${`${fmtDate(s.worst.date)} · exec ${fmtNum(s.worst.executionScore)} · rec ${isNum(s.worst.recovery) ? s.worst.recovery + '%' : '—'}`} />` : null}
          </div>
        </${Card}>
      </div>
      <${Card} title="Largest gaps" meta="computed from the week" class="span-2">
        ${s.focusCandidates.length ? html`<div class="ins-list">${s.focusCandidates.map((f) => html`<div class="ins-row" style="align-items:flex-start;padding:9px 0">
            <span class="mono xs muted" style="width:34px;flex:0 0 auto;margin-top:2px">${fmtNum(f.gap * 100)}</span>
            <div class="grow"><div class="small strong">${f.text}</div><div class="xs dim">${f.reason}</div></div></div>`)}</div>
          <div class="ins-note" style="margin-top:6px">Ranked by size of the gap to target (0–100).</div>`
          : html`<div class="small dim">No large gaps against targets this week.</div>`}
      </${Card}>
    </div>` : null}
    ${past.length ? html`<${Card} title="Past weekly reviews" meta=${plural(past.length, 'review')}>
      <div class="ins-list">${past.map((r) => html`<button type="button" class="ins-row ins-past" onClick=${() => go(r.date || week)} aria-current=${r.id === id ? 'true' : undefined}>
        <span class="mono xs muted" style="width:44px;flex:0 0 auto">${String(r.period).replace(/^\d{4}-/, '')}</span>
        <div class="grow" style="text-align:left"><div class="small ellipsis">${(r.content && r.content.headline) || 'Weekly review'}</div><div class="xs muted">${r.date ? weekLabel(r.date, today) : r.period}${r.source === 'server' ? ' · automation' : ''}</div></div>
      </button>`)}</div>
    </${Card}>` : null}
  </div>`;
}

function Line({ k, v }) {
  return html`<div class="ins-row" style="padding:7px 0"><span class="grow small dim">${k}</span><span class="small mono" style="text-align:right">${v}</span></div>`;
}

function ReviewCard({ review, task, generate, canGen, logged, future, complete, id }) {
  const app = useApp();
  const c = review && review.content;
  const hasKey = !!app.ai();
  const genBtn = (label, variant) => html`<${Button} size="sm" variant=${variant} icon="sparkle" loading=${task.busy} disabled=${!canGen || future} onClick=${generate}>${label}</${Button}>`;
  return html`<div class="card ins-review stack">
    <div class="row between wrap" style="gap:8px"><h3 class="ins-card-title-sm">Weekly review</h3>
      ${c ? html`<div class="row" style="gap:6px">${genBtn('Regenerate', 'ghost')}<${IconButton} icon="trash" label="Delete review" sm onClick=${() => removeWithUndo(app, 'reviews', id, 'Weekly review')} /></div>` : null}</div>
    <${AiStatus} task=${task} label=${task.phase === 'thinking' ? 'Reviewing the week…' : null} />
    <${AiError} error=${task.error} onRetry=${generate} />
    ${c ? html`
      <h4>${c.headline}</h4>
      ${c.summary ? html`<p class="summary">${c.summary}</p>` : null}
      <div class="ins-grid two">
        <div class="stack xs"><div class="eyebrow">What worked</div>${c.whatWorked && c.whatWorked.length ? html`<ul>${c.whatWorked.map((x) => html`<li>${x}</li>`)}</ul>` : html`<div class="small dim">—</div>`}</div>
        <div class="stack xs"><div class="eyebrow">What didn't</div>${c.whatDidnt && c.whatDidnt.length ? html`<ul>${c.whatDidnt.map((x) => html`<li>${x}</li>`)}</ul>` : html`<div class="small dim">—</div>`}</div>
      </div>
      ${c.focus && c.focus.title ? html`<div class="ins-focus stack xs">
        <div class="eyebrow">Focus for next week</div><div class="strong">${c.focus.title}</div>
        ${c.focus.why ? html`<div class="small dim">${c.focus.why}</div>` : null}
        ${c.focus.how && c.focus.how.length ? html`<ul>${c.focus.how.map((x) => html`<li>${x}</li>`)}</ul>` : null}
      </div>` : null}
      <div class="row between wrap" style="gap:8px"><span class="xs muted">${review.source === 'server' ? 'Made by automation' : 'Made on this device'}${review.createdAt ? ' · ' + fmtDate(String(review.createdAt).slice(0, 10), { dow: false }) : ''}</span>
        <${CostNote} usd=${review.costUsd} model=${review.model} /></div>`
    : html`<div class="stack sm">
        <div class="small dim">${future ? 'This week has not started yet.' : !canGen ? `A review needs at least 3 logged days (${logged} so far).` : `No review for this week yet.${complete ? '' : ' The week is still in progress — a review now covers the days so far.'}`}</div>
        ${hasKey ? html`<div>${genBtn('Generate review', 'primary')}</div>` : html`<${AiKeyNotice} what="weekly reviews" />`}
        <div class="xs muted">Sends the week's statistics, your top associations and goal targets to Anthropic; ≈ $0.01–0.06 per review.</div>
      </div>`}
  </div>`;
}

