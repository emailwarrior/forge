// OWNER: UI-D (Insights). The analytics workspace: #/insights[/<section>]?r=<days>.
// Sticky section switcher (scrolling chips on mobile, vertical nav on desktop), a range selector kept in
// the URL, and one lazily imported module per section (js/ui/screens/insights/<id>.js). Sections receive
// { app, today, section, range, period, query, setQuery, dataStart } and compute their own analytics.
import { html, useState, useEffect, useRef, useErrorBoundary } from '../../vendor/preact-htm.js';
import { useApp, useAnalytics } from '../ctx.js';
import { Page, Icon, Segmented, Button, cx } from '../kit.js';
import { RANGES, rangeLabel, parseRange, periodFor, dataStartOf } from '../parts/insights-logic.js';
import { SectionSkeleton } from '../parts/insights-kit.js';
import { fmtDate, fmtNum } from '../../core/util.js';

export const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: 'gauge', range: 30, load: () => import('./insights/overview.js') },
  { id: 'recovery', label: 'Recovery', icon: 'heart', range: 90, load: () => import('./insights/recovery.js') },
  { id: 'sleep', label: 'Sleep', icon: 'moon', range: 30, load: () => import('./insights/sleep.js') },
  { id: 'body', label: 'Body', icon: 'scale', range: 90, load: () => import('./insights/body.js') },
  { id: 'strength', label: 'Strength', icon: 'train', range: 90, load: () => import('./insights/strength.js') },
  { id: 'cardio', label: 'Cardio', icon: 'bike', range: 90, load: () => import('./insights/cardio.js') },
  { id: 'nutrition', label: 'Nutrition', icon: 'fuel', range: 30, load: () => import('./insights/nutrition.js') },
  { id: 'protocols', label: 'Protocols', icon: 'pill', range: 90, load: () => import('./insights/protocols.js') },
  { id: 'labs', label: 'Labs', icon: 'labs', range: null, load: () => import('./insights/labs.js') },
  { id: 'schedule', label: 'Schedule', icon: 'calendar', range: 30, load: () => import('./insights/schedule.js') },
  { id: 'drivers', label: 'Drivers', icon: 'zap', range: 90, load: () => import('./insights/drivers.js') },
  { id: 'weekly', label: 'Weekly', icon: 'history', range: null, load: () => import('./insights/weekly.js') },
  { id: 'ask', label: 'Ask', icon: 'message', range: null, load: () => import('./insights/ask.js') },
];
const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));
const GROUP_BREAK = new Set(['recovery', 'protocols', 'schedule', 'drivers']); // nav dividers before these
const loaded = new Map();

const qs = (query) => { const s = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString(); return s ? '?' + s : ''; };

export default function Screen({ route }) {
  const app = useApp();
  const id = BY_ID.has(route.arg) ? route.arg : 'overview';
  const sec = BY_ID.get(id);
  const today = app.today();
  const dataStart = useAnalytics(() => app.dv.memo('ins:dataStart', () => dataStartOf(app.store)), []);
  const range = sec.range ? parseRange(route.query.r, sec.range) : null;
  const period = range ? periodFor(today, range, dataStart) : null;
  const query = route.query;

  const setQuery = (patch) => { location.replace('#/insights/' + id + qs({ ...query, ...patch })); };
  const go = (sid) => { if (sid !== id) app.nav('/insights/' + sid + qs({ r: query.r })); };
  const rangeSeg = range ? html`<${Segmented} label="Range" value=${range} onValue=${(r) => setQuery({ r })} options=${RANGES.map((r) => ({ value: r, label: rangeLabel(r) }))} />` : null;

  const sub = period
    ? `${sec.label} · ${period.clamped ? `since ${fmtDate(period.from, { dow: false })} (${fmtNum(period.days)} days of data)` : `${fmtDate(period.from, { dow: false })} – ${fmtDate(period.to, { dow: false })}`}`
    : sec.label;

  return html`<${Page} title="Insights" sub=${sub} wide actions=${rangeSeg ? html`<span class="hide-sm">${rangeSeg}</span>` : null}>
    <div class="ins-layout">
      <nav class="ins-nav hide-sm" aria-label="Insights sections">
        ${SECTIONS.map((s) => html`${GROUP_BREAK.has(s.id) ? html`<div class="ins-nav-gap"></div>` : null}
          <button type="button" class="ins-nav-item" aria-current=${s.id === id ? 'page' : undefined} onClick=${() => go(s.id)}><${Icon} name=${s.icon} size=${16} />${s.label}</button>`)}
      </nav>
      <div class="ins-col">
        <${MobileTabs} id=${id} go=${go} />
        ${rangeSeg ? html`<div class="ins-range only-sm">${rangeSeg}</div>` : null}
        <div class="ins-main">
          <${SectionView} key=${id} sec=${sec} ctx=${{ app, today, section: id, range, period, query, setQuery, dataStart }} />
        </div>
      </div>
    </div>
  </${Page}>`;
}

// Sticky, horizontally scrolling chips (phones). Sticks below the status bar in standalone mode.
function MobileTabs({ id, go }) {
  const bar = useRef(null); const sentinel = useRef(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = bar.current && bar.current.querySelector('[aria-pressed="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [id]);
  useEffect(() => {
    const s = sentinel.current; if (!s || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < 1), { threshold: 0 });
    io.observe(s); return () => io.disconnect();
  }, []);
  return html`<div ref=${sentinel} class="ins-sentinel only-sm"></div>
    <div ref=${bar} class=${cx('ins-tabs only-sm', stuck && 'stuck')} role="tablist" aria-label="Insights sections">
      ${SECTIONS.map((s) => html`<button type="button" class="chip" role="tab" aria-selected=${String(s.id === id)} aria-pressed=${String(s.id === id)} onClick=${() => go(s.id)}>${s.label}</button>`)}
    </div>`;
}

function SectionView({ sec, ctx }) {
  const [mod, setMod] = useState(() => loaded.get(sec.id) || null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    if (loaded.has(sec.id)) { setMod(loaded.get(sec.id)); return undefined; }
    sec.load().then((m) => { loaded.set(sec.id, m); if (alive) setMod(m); }).catch((e) => { console.error('[insights]', e); if (alive) setErr(e); });
    return () => { alive = false; };
  }, [sec.id]);
  if (err) return html`<${SectionError} error=${err} />`;
  if (!mod) return html`<${SectionSkeleton} />`;
  const C = mod.default;
  return html`<${SectionBoundary}><${C} ...${ctx} /></${SectionBoundary}>`;
}

function SectionBoundary({ children }) {
  const [error, reset] = useErrorBoundary((e) => console.error('[insights section]', e));
  if (error) return html`<${SectionError} error=${error} reset=${reset} />`;
  return children;
}
function SectionError({ error, reset }) {
  return html`<div class="card stack sm"><div class="strong">This screen hit an error</div>
    <div class="xs muted mono" style="white-space:pre-wrap">${String((error && (error.stack || error.message)) || error).slice(0, 500)}</div>
    ${reset ? html`<div><${Button} size="sm" onClick=${reset}>Try again</${Button}></div>` : null}</div>`;
}
