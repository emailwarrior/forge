// Today → Quick log: one- or two-tap logging tiles, each with a one-line status. Other dates get a
// compact row of "Add" buttons that log to that date. The actions belong to their areas (§6).
import { html } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics } from '../../ctx.js';
import { Icon, Button, cx } from '../../kit.js';
import { openMealCapture } from '../../actions/meal.js';
import { startWorkout, openCardioLog } from '../../actions/workout.js';
import { openWeighIn } from '../../actions/weight.js';
import { openStackLog, openDoseLog } from '../../actions/stack.js';
import { openCheckin } from '../../actions/checkin.js';
import { openJournalEntry } from '../../actions/journal.js';
import { stackStatus, nextDue, inWindow } from '../../../analytics/index.js';
import { fmtTime, fmtNum, fmtDate, diffDays, dayOfWeek, dowName, localParts, isNum } from '../../../core/util.js';

const norm = (s) => String(s ?? '').trim();
const STACK_ORDER = (s) => (s.toUpperCase() === 'AM' ? 0 : s.toUpperCase() === 'PM' ? 1 : 2);

/** Stack names used by protocol items in use on `date` (AM, PM first; case-insensitive unique). */
export function stacksOf(dv, date) {
  const seen = new Map();
  for (const it of dv.protocolItems()) {
    const st = norm(it.schedule && it.schedule.stack);
    if (!st || !inWindow(it, date) || (it.schedule && it.schedule.type === 'asneeded')) continue;
    if (!seen.has(st.toLowerCase())) seen.set(st.toLowerCase(), st);
  }
  return [...seen.values()].sort((a, b) => STACK_ORDER(a) - STACK_ORDER(b) || a.localeCompare(b));
}

/** Peptide / medication items on a weekly or specific-days schedule, in use on `date`. */
export function doseItemsOf(dv, date) {
  return dv.protocolItems().filter((it) => (it.kind === 'peptide' || it.kind === 'medication')
    && it.schedule && (it.schedule.type === 'weekly' || it.schedule.type === 'days') && inWindow(it, date))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function nextLabel(next, date) {
  if (!next) return 'Not scheduled';
  const d = diffDays(date, next);
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return d < 7 ? `Next ${dowName(dayOfWeek(next))}` : `Next ${fmtDate(next, { dow: false })}`;
}

function useQuickModel(date) {
  const app = useApp();
  return useAnalytics(() => {
    const dv = app.dv; const tz = dv.tz;
    const hm = (iso) => (iso ? localParts(iso, tz).hm : null);
    const meals = dv.meals(date);
    const sessions = dv.sessions(date);
    const open = sessions.find((s) => !s.endAt) || null;
    const cardioMin = sessions.reduce((t, s) => t + (s.cardio || []).reduce((u, c) => u + (isNum(c && c.durationMin) ? c.durationMin : 0), 0), 0);
    const trainingBlock = dv.plan(date).find((b) => b.category === 'training' && b.status !== 'skipped') || null;
    const weighs = dv.body(date).filter((b) => isNum(b.weightLb));
    const allW = dv.weighIns();
    const lastW = allW.length ? allW[allW.length - 1] : null;
    const doseAt = (ids) => {
      const times = dv.doses(date).filter((d) => ids.has(d.itemId) && !d.skipped && d.at).map((d) => hm(d.at)).sort();
      return times.length ? times[times.length - 1] : null;
    };
    const stacks = stacksOf(dv, date).map((stack) => {
      const st = stackStatus(dv, date, stack);
      const ids = new Set(st.items.map((x) => x.item.id));
      return { stack, st, taken: st.items.filter((x) => x.taken).length, lastAt: doseAt(ids) };
    });
    const doseItems = doseItemsOf(dv, date).map((item) => {
      const taken = dv.doses(date).filter((d) => d.itemId === item.id && !d.skipped);
      return { item, takenAt: taken.length ? hm(taken[taken.length - 1].at) : null, taken: taken.length > 0, next: nextDue(dv, item, date) };
    });
    const day = dv.day(date);
    return {
      meals: meals.length, lastMeal: meals.length ? hm(meals[meals.length - 1].at) : null,
      open, sessions: sessions.length, sessionName: sessions.length ? sessions[sessions.length - 1].name : null, cardioMin, trainingBlock,
      weight: weighs.length ? weighs[0].weightLb : null, lastW,
      stacks, doseItems,
      checkinAt: day && day.checkinAt ? hm(day.checkinAt) : null,
      notes: dv.journal(date).length,
    };
  }, [date]);
}

function Tile({ icon, label, sub, tone, onClick, testid }) {
  return html`<button type="button" class="quick" onClick=${onClick} data-q=${testid}>
    <${Icon} name=${icon} />
    <span class="q-text"><span class="q-label">${label}</span><span class=${cx('sub', tone && 'q-' + tone)}>${sub}</span></span>
  </button>`;
}

/** Today: horizontally scrollable tiles. */
export function QuickLog({ date }) {
  const app = useApp();
  const q = useQuickModel(date);
  if (!q) return null;
  const tiles = [
    { k: 'meal', icon: 'camera', label: 'Meal', sub: q.meals ? `${q.meals} logged · ${fmtTime(q.lastMeal)}` : 'Take a photo', run: () => openMealCapture(app, { date, mode: 'camera' }) },
    { k: 'photos', icon: 'image', label: 'Photos', sub: 'From library', run: () => openMealCapture(app, { date, mode: 'library' }) },
    { k: 'workout', icon: 'train', label: q.open ? 'Resume' : 'Workout',
      sub: q.open ? (q.open.name || 'Open session') : q.sessions ? `${q.sessions} logged` : q.trainingBlock ? `Planned ${fmtTime(q.trainingBlock.start)}` : 'Start session',
      tone: q.open ? 'accent' : null, run: () => startWorkout(app, { date }) },
    { k: 'cardio', icon: 'bike', label: 'Cardio', sub: q.cardioMin ? `${fmtNum(q.cardioMin)} min logged` : 'Bike, run, row', run: () => openCardioLog(app, { date }) },
    { k: 'weight', icon: 'scale', label: 'Weight', sub: isNum(q.weight) ? `${fmtNum(q.weight, 1)} lb` : q.lastW ? `Last ${fmtNum(q.lastW.weightLb, 1)} lb` : 'Not logged', run: () => openWeighIn(app, { date }) },
    ...q.stacks.map(({ stack, st, taken, lastAt }) => ({
      k: 'stack-' + stack, icon: 'pill', label: `${stack} stack`,
      sub: !st.items.length ? 'Nothing due' : st.complete ? `Logged ${fmtTime(lastAt)}` : taken ? `${taken} of ${st.items.length} logged` : 'Due',
      tone: st.items.length && !st.complete ? 'warn' : null,
      run: () => openStackLog(app, { date, stack }),
    })),
    ...q.doseItems.map(({ item, taken, takenAt, next }) => ({
      k: 'dose-' + item.id, icon: 'droplet', label: item.name || 'Dose',
      sub: taken ? `Logged ${fmtTime(takenAt)}` : nextLabel(next, date),
      tone: !taken && next === date ? 'warn' : null,
      run: () => openDoseLog(app, { date, itemId: item.id }),
    })),
    { k: 'checkin', icon: 'list', label: 'Check-in', sub: q.checkinAt ? `Done ${fmtTime(q.checkinAt)}` : 'Not yet', run: () => openCheckin(app, { date }) },
    { k: 'note', icon: 'book', label: 'Note', sub: q.notes ? `${q.notes} today` : 'Add a note', run: () => openJournalEntry(app, { date }) },
  ];
  return html`<section class="stack sm" aria-label="Quick log">
    <div class="section-title"><h2>Quick log</h2></div>
    <div class="fab-row day-quick">${tiles.map((t) => html`<${Tile} key=${t.k} testid=${t.k} icon=${t.icon} label=${t.label} sub=${t.sub} tone=${t.tone} onClick=${t.run} />`)}</div>
  </section>`;
}

/** Past dates: small "Add" buttons that log to that date. */
export function AddToDay({ date }) {
  const app = useApp();
  const q = useQuickModel(date);
  if (!q) return null;
  const btn = (label, icon, run, k) => html`<${Button} key=${k} size="sm" icon=${icon} onClick=${run}>${label}</${Button}>`;
  return html`<section class="stack sm" aria-label="Add to this day">
    <div class="section-title"><h2>Add to this day</h2><span class="meta">Logs to ${fmtDate(date)}</span></div>
    <div class="row wrap day-addrow">
      ${btn('Meal', 'camera', () => openMealCapture(app, { date }), 'meal')}
      ${btn('Workout', 'train', () => startWorkout(app, { date }), 'workout')}
      ${btn('Cardio', 'bike', () => openCardioLog(app, { date }), 'cardio')}
      ${btn('Weight', 'scale', () => openWeighIn(app, { date }), 'weight')}
      ${q.stacks.map(({ stack }) => btn(`${stack} stack`, 'pill', () => openStackLog(app, { date, stack }), 'stack-' + stack))}
      ${q.doseItems.map(({ item }) => btn(item.name || 'Dose', 'droplet', () => openDoseLog(app, { date, itemId: item.id }), 'dose-' + item.id))}
      ${btn(q.checkinAt ? 'Edit check-in' : 'Check-in', 'list', () => openCheckin(app, { date }), 'checkin')}
      ${btn('Note', 'book', () => openJournalEntry(app, { date }), 'note')}
    </div>
  </section>`;
}
