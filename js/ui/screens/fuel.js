// FORGE Fuel (#/fuel[/<date>]): meal capture, the day's intake vs targets, meals in time order, protein distribution
// and meal timing, the daily AI review, the owner's rules, and the last 7 days (adherence + micronutrients).
import { html } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useSetting, useWide } from '../ctx.js';
import { Page, Card, Stat, Button, Icon, Notice, Empty, Meter, KV, Spinner, cx } from '../kit.js';
import { BarChart } from '../charts.js';
import { routeDate, dateLabel, DateNav } from '../parts/date.js';
import { useAiTask, AiStatus, AiError, AiKeyNotice, CostNote } from '../parts/ai.js';
import { dayNutrition, nutritionAdherence, microSummary, buildDaily, bodySummary, dailyRow, calorieTargets } from '../../analytics/index.js';
import { nutritionReview } from '../../ai/reviews.js';
import { openMealCapture, openMeal } from '../actions/meal.js';
import { useQueue, MealRow } from '../parts/fuel-ui.js';
import { waitingMeals, failedMeals, analyzeWaiting, activeJobs } from '../parts/fuel-queue.js';
import {
  mealClock, hasEstimate, slotLabel, proteinPerMealRef, targetBasisText, intakeTone, fmtGrams, trainingText, bodyTrendText,
} from '../parts/fuel-logic.js';
import { addDays, fmtNum, fmtTime, fmtDur, fmtDate, signed, isNum, nowIso, hmToMin } from '../../core/util.js';

export default function Screen({ route }) {
  const app = useApp(); useVersion(); const jobOf = useQueue(); const wide = useWide();
  const today = app.today(); const date = routeDate(route, app);
  const n = useAnalytics(() => dayNutrition(app.dv, date), [date]);
  const tz = app.dv.tz;
  const meals = app.store.byDate('meals', date).slice().sort((a, b) => (mealClock(a, tz).min ?? 1e9) - (mealClock(b, tz).min ?? 1e9));
  const nav = html`<${DateNav} date=${date} base="/fuel" max=${today} />`;
  // Phone: date navigation gets its own row under the title (like Today/Plan) so the subtitle never wraps.
  return html`<${Page} wide title="Fuel" sub=${dateLabel(date, today)} actions=${wide ? nav : null}>
    ${wide ? null : html`<div class="row" style="margin-top:-8px">${nav}</div>`}
    <${CaptureBar} date=${date} />
    <${WaitingNotice} />
    ${n ? html`<div class="fuel-layout">
      <div class="fuel-col">
        <div class="fo-1"><${IntakeCard} n=${n} date=${date} today=${today} meals=${meals} /></div>
        <div class="fo-2"><${MealsCard} meals=${meals} date=${date} today=${today} jobOf=${jobOf} /></div>
        <div class="fo-5"><${WeekCard} date=${date} today=${today} /></div>
      </div>
      <div class="fuel-col">
        ${meals.length ? html`<div class="fo-3"><${DistributionCard} n=${n} date=${date} today=${today} /></div>` : null}
        ${!app.store.all('meals').length ? html`<div class="fo-3"><${GuideCard} /></div>` : null}
        <div class="fo-4"><${ReviewCard} key=${date} n=${n} date=${date} today=${today} meals=${meals} /></div>
        <div class="fo-6"><${MicroCard} date=${date} today=${today} /></div>
        <div class="fo-7"><${RulesCard} /></div>
      </div>
    </div>` : html`<${Notice} tone="bad">Nutrition figures could not be computed for this day. The meals are safe; reload the app.</${Notice}>`}
  </${Page}>`;
}

/* ---------------------------------------------------------------- capture */
const CAPTURE = [
  { mode: 'camera', icon: 'camera', label: 'Snap', sub: 'Camera · time = now' },
  { mode: 'library', icon: 'image', label: 'Photos', sub: 'Library · batch' },
  { mode: 'files', icon: 'folder', label: 'Files', sub: 'iCloud Drive' },
  { mode: 'text', icon: 'edit', label: 'Describe', sub: 'Type it' },
  { mode: 'saved', icon: 'star', label: 'Saved', sub: 'Foods · quick add' },
];
function CaptureBar({ date }) {
  const app = useApp();
  return html`<div class="cap-grid" role="group" aria-label="Log a meal">${CAPTURE.map((o) => html`<button type="button" class=${cx('cap', o.mode === 'camera' && 'primary')}
    onClick=${() => openMealCapture(app, { date, mode: o.mode })}><${Icon} name=${o.icon} /><span class="cap-l">${o.label}</span><span class="cap-s">${o.sub}</span></button>`)}</div>`;
}

function WaitingNotice() {
  const app = useApp(); useQueue();
  const ai = app.ai();
  const since = addDays(app.today(), -14);
  const waiting = waitingMeals(app.store);
  const failed = failedMeals(app.store, since);
  const running = activeJobs().length;
  const runLine = running ? html`<div class="ai-status" role="status"><${Spinner} /><span class="grow">Analyzing ${running} meal${running === 1 ? '' : 's'} — results appear as each finishes.</span></div>` : null;
  if (!waiting.length && !failed.length) return runLine || (ai ? null : html`<${AiKeyNotice} what="meal photo analysis (photos are still saved without it)" />`);
  const oldest = waiting[0] || failed[0];
  const parts = [];
  if (waiting.length) parts.push(`${waiting.length} meal${waiting.length === 1 ? '' : 's'} waiting for analysis`);
  if (failed.length) parts.push(`${failed.length} failed`);
  const text = parts.join(' · ') + (oldest && oldest.date && oldest.date < app.today() ? ` (oldest ${fmtDate(oldest.date)})` : '');
  if (!ai) return html`<${Notice} tone="warn"><div class="row between wrap" style="gap:8px"><span>${text}. Add an Anthropic API key to analyze them.</span>
    <${Button} size="sm" onClick=${() => app.nav('/settings/ai')}>Settings → AI</${Button}></div></${Notice}>`;
  return html`${runLine}<${Notice} tone="warn"><div class="row between wrap" style="gap:8px"><span>${text}.</span>
    <${Button} size="sm" icon="sparkle" onClick=${() => { const k = analyzeWaiting(app, { failed: since }); app.toast(`Analyzing ${k} meal${k === 1 ? '' : 's'}`); }}>Analyze ${waiting.length + failed.length}</${Button}></div></${Notice}>`;
}

/* ----------------------------------------------------------------- intake */
function IntakeCard({ n, date, today, meals }) {
  const app = useApp();
  const t = n.targets || {}; const tot = n.totals || {};
  const hasT = isNum(t.kcal);
  const past = date < today;
  const eaten = isNum(tot.kcal) ? tot.kcal : 0;
  const complete = past && n.complete;
  const waiting = n.pending || 0;
  if (!hasT && !meals.length) {
    return html`<${Card} title="Targets">
      <div class="stack sm"><div class="strong">No calorie target yet</div>
        <div class="small dim">${t.rationale || 'Add your profile and a weigh-in to get targets.'}</div>
        <div class="row wrap" style="gap:8px"><${Button} size="sm" onClick=${() => app.nav('/settings/profile')}>Profile</${Button}>
          <${Button} size="sm" variant="ghost" onClick=${() => app.nav('/settings/targets')}>Targets</${Button}></div></div>
    </${Card}>`;
  }
  let side = null;
  if (hasT && !past) {
    const rem = n.remaining.kcal;
    side = html`<div class=${cx('intake-rem', eaten > t.kcal * 1.1 && 'ink-warn')}><b class="tnum">${fmtNum(Math.abs(rem))}</b> kcal ${rem < 0 ? 'over' : 'left'}
      ${isNum(n.remaining.proteinG) && n.remaining.proteinG > 0 ? html`<span class="muted"> · ${fmtNum(n.remaining.proteinG)} g protein to go</span>` : null}</div>`;
  } else if (hasT && isNum(n.pct.kcal)) {
    side = html`<div class="intake-rem"><b class="tnum">${n.pct.kcal}%</b> of target${isNum(n.pct.protein) ? html`<span class="muted"> · protein ${n.pct.protein}%</span>` : null}</div>`;
  }
  const rows = [['protein', 'Protein', t.proteinG], ['carbs', 'Carbs', t.carbsG], ['fat', 'Fat', t.fatG], ['fiber', 'Fiber', t.fiberG]];
  const meta = waiting ? html`<span class="ink-warn">Partial · ${waiting} not analyzed</span>` : past && n.mealCount ? 'Complete day' : null;
  // The header already says the totals are partial; the meal rows carry each meal's analysis state.
  const flags = (n.flags || []).filter((f) => !/still analyzing|waiting for analysis/.test(f.text)); // shown by the meal list itself
  return html`<${Card} title="Intake" meta=${meta}>
    <div class="intake-hero">
      <div><span class="hero-num tnum">${fmtNum(eaten)}</span><span class="muted small"> ${hasT ? `/ ${fmtNum(t.kcal)} kcal` : 'kcal'}</span></div>
      ${side}
    </div>
    ${hasT ? html`<${Meter} value=${eaten} max=${t.kcal} tone=${intakeTone('kcal', eaten, t.kcal, { complete }) || 'accent'} />` : null}
    <div class="stack sm intake-rows">${rows.map(([k, label, target]) => {
      const v = isNum(tot[k]) ? fmtNum(tot[k]) : n.mealCount ? '—' : '0';
      if (!(isNum(target) && target > 0)) return html`<div class="meter-row"><span class="dim ellipsis">${label}</span><span class="xs muted">no target</span><span class="v">${v} g</span></div>`;
      return html`<${Meter} label=${label} value=${tot[k] || 0} max=${target} tone=${intakeTone(k, tot[k], target, { complete })} valueText=${`${v} / ${fmtNum(target)} g`} />`;
    })}</div>
    ${hasT ? html`<details class="more basis-line"><summary class="xs muted"><span class="disc-sum"><${Icon} name="chevronDown" size=${13} />${targetBasisText(t)}</span></summary>
      <div class="xs dim stack xs" style="margin-top:6px">
        <span>${t.rationale}</span>
        ${t.tdeeInfo && t.tdeeInfo.from ? html`<span>TDEE window ${fmtDate(t.tdeeInfo.from, { dow: false })} – ${fmtDate(t.tdeeInfo.to, { dow: false })}: ${t.tdeeInfo.n} complete intake days, ${t.tdeeInfo.weighIns} weigh-ins${isNum(t.tdeeInfo.trendDeltaLb) ? `, weight ${signed(t.tdeeInfo.trendDeltaLb, 1)} lb` : ''}.${t.tdeeInfo.note ? ' ' + t.tdeeInfo.note : ''}</span>` : null}
        <span>Macros: protein ${isNum(t.proteinG) ? fmtNum(t.proteinG) + ' g' : '—'}, fat ${isNum(t.fatG) ? fmtNum(t.fatG) + ' g' : '—'}, carbs the remainder. Change the method in Settings → Targets.</span>
      </div></details>` : html`<div class="basis-line xs muted">${t.rationale}</div>`}
    ${flags.length ? html`<div class="flag-list">${flags.map((f) => html`<div class=${cx('flag-row', f.level === 'warn' && 'warn')}><${Icon} name=${f.level === 'warn' ? 'alert' : 'info'} size=${14} /><span>${f.text}</span></div>`)}</div>` : null}
  </${Card}>`;
}

/* ------------------------------------------------------------------ meals */
function MealsCard({ meals, date, today, jobOf }) {
  const app = useApp();
  const kcal = meals.reduce((s, m) => s + (hasEstimate(m) ? m.totals.kcal : 0), 0);
  if (!meals.length) {
    return html`<${Card} title="Meals">
      <${Empty} title=${date === today ? 'No meals logged today' : 'No meals logged on ' + fmtDate(date)}
        action=${html`<div class="row wrap" style="gap:8px;justify-content:center">
          ${date === today ? html`<${Button} variant="primary" icon="camera" onClick=${() => openMealCapture(app, { date, mode: 'camera' })}>Snap a meal</${Button}>` : null}
          <${Button} icon="plus" onClick=${() => openMealCapture(app, { date })}>${date === today ? 'Other ways' : 'Add a meal'}</${Button}></div>`}>
        ${date === today
          ? 'Photograph each meal: the photo is stored encrypted and the AI estimates calories, macros and micronutrients. Batch-import at night with Photos or Files — times come from the photos.'
          : 'Add a meal you did not log that day, then set its time.'}
      </${Empty}></${Card}>`;
  }
  return html`<${Card} flush title="Meals" meta=${`${meals.length} · ${fmtNum(kcal)} kcal`}
    action=${html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${() => openMealCapture(app, { date })}>Add</${Button}>`}>
    <div class="list meal-list">${meals.map((m) => html`<${MealRow} key=${m.id} meal=${m} job=${jobOf(m.id)} tz=${app.dv.tz} onOpen=${() => openMeal(app, m.id)} />`)}</div>
  </${Card}>`;
}

/* ------------------------------------------------------ distribution/timing */
function DistributionCard({ n, date, today }) {
  const app = useApp();
  const targets = useSetting('targets');
  const ref = proteinPerMealRef(n.targets && n.targets.weightLb);
  const rows = (n.proteinPerMeal || []).map((p) => ({ ...p, v: isNum(p.protein) ? p.protein : null }));
  const known = rows.filter((r) => isNum(r.v));
  const max = Math.max(ref ? ref * 1.5 : 0, ...known.map((r) => r.v), 1);
  const it = app.dv.intake(date);
  const windowMin = isNum(it.firstMin) && isNum(it.lastMin) && it.lastMin > it.firstMin ? it.lastMin - it.firstMin : null;
  const lastBy = targets.lastMealBy;
  const late = isNum(it.lastMin) && isNum(hmToMin(lastBy)) && it.lastMin > hmToMin(lastBy);
  const hits = ref ? known.filter((r) => r.v >= ref).length : null;
  return html`<${Card} title="Protein per meal" meta=${ref ? `ref ≈ ${ref} g · 0.4 g/kg` : null}>
    <div class="pm-list">${rows.map((r) => html`<div class="pm-row">
      <span class="pm-l"><span class="mono">${r.at ? fmtTime(r.at) : '—'}</span> <span class="muted">${slotLabel(r.slot)}</span></span>
      <div class="pm-bar">${isNum(r.v) ? html`<i style=${`width:${Math.min(100, (r.v / max) * 100)}%`}></i>` : null}${ref ? html`<b class="pm-ref" style=${`left:${(ref / max) * 100}%`} title=${`Reference ${ref} g`}></b>` : null}</div>
      <span class="pm-v mono">${isNum(r.v) ? fmtGrams(r.v) : '…'}</span></div>`)}</div>
    ${ref && known.length ? html`<div class="xs muted" style="margin-top:8px">${hits} of ${known.length} meals at or above ${ref} g. Research on muscle protein synthesis supports ≈ 0.4 g/kg per meal across 3–5 meals.</div>` : null}
    <div class="divider" style="margin:12px 0"></div>
    <${KV} items=${[
      ['First meal', it.firstMin != null ? fmtTime(it.firstMin) : '—'],
      ['Last meal', it.lastMin != null ? html`<span class=${late ? 'ink-warn' : ''}>${fmtTime(it.lastMin)}</span>${lastBy ? html`<span class="muted"> · by ${fmtTime(lastBy)}</span>` : null}` : '—'],
      ['Eating window', windowMin != null ? fmtDur(windowMin) : '—'],
      ['Last meal → bed', isNum(n.lastMealToBedMin) ? fmtDur(n.lastMealToBedMin) : date >= today ? html`<span class="muted">after tonight's sleep</span>` : '—'],
    ]} />
  </${Card}>`;
}

/* ----------------------------------------------------------------- review */
function reviewInputs(app, date, n) {
  const dv = app.dv; const store = app.store;
  const meals = dv.meals(date).filter(hasEstimate);
  const rules = ((store.setting('nutritionRules') || {}).rules || []).filter((r) => r && r.active !== false && r.text).map((r) => r.text);
  let training = '', bodyTrend = '';
  try { training = trainingText(dv.sessions(date), dailyRow(dv, date)); } catch (e) { console.warn('[fuel] training', e); }
  try { bodyTrend = bodyTrendText(bodySummary(dv, date), store.setting('profile')); } catch (e) { console.warn('[fuel] body', e); }
  const t = n.targets || {};
  return { date, meals, totals: n.totals, targets: { kcal: t.kcal, proteinG: t.proteinG, fatG: t.fatG, carbsG: t.carbsG, fiberG: t.fiberG }, rules, training, bodyTrend, protocolNotes: '' };
}

function ReviewCard({ n, date, today, meals }) {
  const app = useApp(); const task = useAiTask();
  const id = 'nutrition:' + date;
  const review = app.store.get('reviews', id);
  const analyzed = meals.filter(hasEstimate).length;
  const ai = app.ai();
  const run = async () => {
    const res = await task.run(({ ai: cfg, signal, onProgress }) => nutritionReview(cfg, { ...reviewInputs(app, date, n), signal, onProgress }));
    if (!res) return;
    app.store.upsert('reviews', id, {
      kind: 'nutrition', period: date, date, createdAt: nowIso(app.dv.tz), model: res.model || null, costUsd: isNum(res.costUsd) ? res.costUsd : null, source: 'app',
      content: { score: res.score ?? null, headline: res.headline || '', wins: res.wins || [], gaps: res.gaps || [], tomorrow: res.tomorrow || [], flags: res.flags || [] },
    });
    app.toast('Day review saved');
  };
  const label = date === today ? 'Review the day so far' : 'Review this day';
  if (!review) {
    if (!meals.length) return null;
    return html`<${Card} title="Day review">
      <div class="stack sm">
        <div class="small dim">${analyzed ? 'An AI review of the day against your targets and rules: score, wins, gaps and what to change tomorrow. Stored with the day.' : 'Available once at least one meal is analyzed.'}</div>
        ${!ai ? html`<${AiKeyNotice} what="the daily review" />` : task.busy ? html`<${AiStatus} task=${task} />`
          : html`<div><${Button} icon="sparkle" disabled=${!analyzed} onClick=${run}>${label}</${Button}></div>`}
        <${AiError} error=${task.error} onRetry=${run} />
        ${ai && !task.busy ? html`<div class="xs muted">≈ $0.01–0.06 per review.</div>` : null}
      </div></${Card}>`;
  }
  const c = review.content || {};
  const created = Date.parse(review.createdAt || '');
  const stale = isFinite(created) && meals.some((m) => (m._u || 0) > created + 1000);
  const tone = !isNum(c.score) ? '' : c.score >= 80 ? 'good' : c.score >= 60 ? 'warn' : 'bad';
  const lists = [['Wins', c.wins], ['Gaps', c.gaps], ['Tomorrow', c.tomorrow]].filter(([, l]) => Array.isArray(l) && l.length);
  return html`<${Card} title="Day review" meta=${review.source === 'server' ? 'by automation' : null}
    action=${ai && !task.busy ? html`<${Button} size="sm" variant="ghost" icon="repeat" onClick=${run}>Redo</${Button}>` : null}>
    <div class="stack">
      <div class="review-head">
        <div class=${cx('score', tone)}><b class="mono">${isNum(c.score) ? c.score : '—'}</b><span>/ 100</span></div>
        <div class="grow stack xs"><div class="strong">${c.headline || 'Review'}</div>
          <div class="row wrap xs muted" style="gap:6px">${review.createdAt ? html`<span>${fmtDate(String(review.createdAt).slice(0, 10))} ${fmtTime(String(review.createdAt).slice(11, 16))}</span>` : null}
            <${CostNote} usd=${review.costUsd} model=${review.model} /></div></div>
      </div>
      ${stale ? html`<div class="flag-row"><${Icon} name="info" size=${14} /><span>Meals changed after this review.${ai ? ' Redo it to include the changes.' : ''}</span></div>` : null}
      ${task.busy ? html`<${AiStatus} task=${task} />` : null}
      <${AiError} error=${task.error} onRetry=${run} />
      <div class="review-lists">${lists.map(([h, l]) => html`<div class="stack xs"><div class="eyebrow">${h}</div><ul class="plain-list small">${l.map((x) => html`<li>${x}</li>`)}</ul></div>`)}</div>
      ${Array.isArray(c.flags) && c.flags.length ? html`<div class="flag-list">${c.flags.map((f) => html`<div class="flag-row warn"><${Icon} name="alert" size=${14} /><span>${f}</span></div>`)}</div>` : null}
    </div>
  </${Card}>`;
}

/* ------------------------------------------------------------------ week */
function WeekCard({ date, today }) {
  const app = useApp();
  const end = date < today ? date : addDays(today, -1);
  const from = addDays(end, -6);
  const adh = useAnalytics(() => nutritionAdherence(app.dv, from, end), [from, end]);
  const rows = useAnalytics(() => buildDaily(app.dv, from, end), [from, end]);
  const tgt = useAnalytics(() => calorieTargets(app.dv, end), [end]);
  const range = `${fmtDate(from, { dow: false })} – ${fmtDate(end, { dow: false })}`;
  if (!adh || !adh.days) {
    return html`<${Card} title="Last 7 days" meta=${range}><div class="small muted">Hit rates, averages and micronutrients appear after the first complete day — a day with meals that are all analyzed.</div></${Card}>`;
  }
  const daysTxt = `${adh.days} complete day${adh.days === 1 ? '' : 's'}`;
  const tone = (v, good) => (!isNum(v) ? null : good(v) ? 'good' : null);
  return html`<${Card} title="Last 7 days" meta=${`${range} · ${daysTxt}`}>
    <div class="stack">
      <div class="grid four week-stats">
        <${Stat} label="kcal on target" value=${`${adh.kcalHits}/${adh.days}`} sub="within ±10%" />
        <${Stat} label="Protein hit" value=${`${adh.proteinHits}/${adh.days}`} sub="≥ 95% of target" />
        <${Stat} label="Avg intake" value=${fmtNum(adh.avgKcal)} unit="kcal" delta=${isNum(adh.avgVsTarget) ? `${signed(adh.avgVsTarget)} kcal vs target` : null} tone=${tone(adh.avgVsTarget, (v) => Math.abs(v) <= 150)} />
        <${Stat} label="Avg protein" value=${fmtNum(adh.avgProtein)} unit="g" delta=${isNum(adh.avgProteinVsTarget) ? `${signed(adh.avgProteinVsTarget)} g vs target` : null} tone=${tone(adh.avgProteinVsTarget, (v) => v >= 0)} />
      </div>
      <div class="week-charts">
        <div><div class="xs muted chart-cap">Calories per day${tgt && isNum(tgt.kcal) ? ` · target ${fmtNum(tgt.kcal)}` : ''}</div>
          <${BarChart} height=${124} data=${(rows || []).map((r) => ({ x: r.date, y: r.kcalIn, label: fmtDate(r.date) }))} target=${tgt && isNum(tgt.kcal) ? { y: tgt.kcal, label: '' } : null} emptyText="No complete days" /></div>
        <div><div class="xs muted chart-cap">Protein per day, g${tgt && isNum(tgt.proteinG) ? ` · target ${fmtNum(tgt.proteinG)}` : ''}</div>
          <${BarChart} height=${124} color="var(--s3)" data=${(rows || []).map((r) => ({ x: r.date, y: r.proteinG, label: fmtDate(r.date) }))} target=${tgt && isNum(tgt.proteinG) ? { y: tgt.proteinG, label: '' } : null} emptyText="No complete days" /></div>
      </div>
    </div>
  </${Card}>`;
}

/* ----------------------------------------------------------- micronutrients */
function MicroCard({ date, today }) {
  const app = useApp();
  const end = date < today ? date : addDays(today, -1);
  const from = addDays(end, -6);
  const micro = useAnalytics(() => microSummary(app.dv, from, end), [from, end]);
  const days = micro && micro.length ? Math.max(...micro.map((m) => m.days || 0)) : 0;
  if (!days) return null;
  const sex = app.store.setting('profile').sex === 'female' ? 'female' : 'male';
  return html`<${Card} title="Micronutrients" meta=${`avg/day · ${days} complete day${days === 1 ? '' : 's'}`}>
    <div class="micro-list">${micro.map((m) => html`<div class="micro-row" key=${m.key}>
      <span class="ml">${m.label}<small>${m.limit ? 'limit ≤ ' : 'ref '}${fmtNum(m.reference)} ${m.unit}</small></span>
      <span class="mv">${isNum(m.avg) ? fmtNum(m.avg, m.key === 'iron' ? 1 : 0) : '—'} <span class="muted">${m.unit}</span></span>
      <${Meter} value=${m.pct || 0} max=${Math.max(100, m.pct || 0)} tone=${!isNum(m.pct) ? null : m.limit ? (m.pct > 100 ? 'warn' : 'good') : m.pct >= 100 ? 'good' : m.pct < 60 ? 'warn' : null} />
      <span class="mp">${isNum(m.pct) ? m.pct + '%' : '—'}</span></div>`)}</div>
    <div class="xs muted" style="margin-top:10px">General adult ${sex} references for the same 7 days; sodium is an upper limit. AI micronutrient estimates are rough — read them as trends.</div>
  </${Card}>`;
}

/* ------------------------------------------------------------ first week */
function GuideCard() {
  return html`<${Card} title="How Fuel works">
    <ol class="imp-steps guide-steps">
      <li><b>Snap every meal.</b> The photo is stored encrypted; the AI itemizes it — grams, macros, micronutrients — and says how confident it is.</li>
      <li><b>Say what the photo can’t show</b> (oil, sauce, portion, brand) in the note, and answer the follow-up question when one appears.</li>
      <li><b>Weigh in most mornings.</b> After 14 logged days and 10 weigh-ins the calorie target switches from an estimate to your measured TDEE.</li>
      <li><b>Save repeat meals as foods</b> — they log in one tap under Saved.</li>
    </ol>
  </${Card}>`;
}

/* ------------------------------------------------------------------ rules */
function RulesCard() {
  const app = useApp();
  const rules = (useSetting('nutritionRules').rules || []).filter((r) => r && r.active !== false && r.text);
  return html`<${Card} title="Your rules" meta=${rules.length ? `${rules.length} active` : null}
    action=${html`<${Button} size="sm" variant="ghost" onClick=${() => app.nav('/settings/nutrition')}>${rules.length ? 'Edit' : 'Add rules'}</${Button}>`}>
    ${rules.length ? html`<ul class="rules-list">${rules.map((r) => html`<li key=${r.id || r.text}>${r.text}</li>`)}</ul>
      <div class="xs muted" style="margin-top:8px">Used by the meal estimator and the day review.</div>`
      : html`<div class="small muted">No rules yet. Write your own best-practice rules in Settings → Nutrition (for example “Last meal 3 h before bed”); the meal estimator and the day review use them.</div>`}
  </${Card}>`;
}
