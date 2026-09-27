// FORGE v3 bootstrap: session lifecycle, shell, router, sheets, toasts.
import { html, render, useState, useEffect, useMemo, useRef, useErrorBoundary } from './vendor/preact-htm.js';
import { AppCtx, useRoute } from './ui/ctx.js';
import { SyncBadge } from './ui/chrome.js';
import { Icon, Button, Spinner } from './ui/kit.js';
import { createSession } from './app/session.js';
import { takeOAuthResult } from './app/integrations.js';
import { makeAiConfig } from './ai/index.js';
import { bindShellPrefs } from './ui/parts/settings-shell.js';

// Never run inside a frame: a framing page could observe input or hook crypto (clickjacking/same-origin).
if (window.top !== window.self) { document.documentElement.innerHTML = ''; throw new Error('FORGE refuses to run inside a frame.'); }

const SCREENS = {
  today: () => import('./ui/screens/today.js'),
  plan: () => import('./ui/screens/plan.js'),
  train: () => import('./ui/screens/train.js'),
  fuel: () => import('./ui/screens/fuel.js'),
  insights: () => import('./ui/screens/insights.js'),
  more: () => import('./ui/screens/more.js'),
  protocols: () => import('./ui/screens/protocols.js'),
  labs: () => import('./ui/screens/labs.js'),
  finance: () => import('./ui/screens/finance.js'),
  journal: () => import('./ui/screens/journal.js'),
  settings: () => import('./ui/screens/settings.js'),
  import: () => import('./ui/screens/import.js'),
};
const NAV = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'train', label: 'Train', icon: 'train' },
  { id: 'fuel', label: 'Fuel', icon: 'fuel' },
  { id: 'insights', label: 'Insights', icon: 'insights' },
];
const SIDE_MORE = [
  { id: 'protocols', label: 'Protocols', icon: 'pill' },
  { id: 'labs', label: 'Labs', icon: 'labs' },
  { id: 'finance', label: 'Finance', icon: 'wallet' },
  { id: 'journal', label: 'Journal', icon: 'book' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
const demoParam = new URLSearchParams(location.search).get('demo');
const demo = demoParam !== null; // ?demo = synthetic data, ?demo=empty = fresh vault (seeds only)

/* ----------------------------------------------------------- theme */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta && bg) meta.setAttribute('content', bg);
}

/* ------------------------------------------------------ lazy screens */
const loaded = new Map();
function Screen({ name, route }) {
  const [mod, setMod] = useState(loaded.get(name) || null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true; setErr(null);
    if (loaded.has(name)) { setMod(loaded.get(name)); return undefined; }
    setMod(null);
    SCREENS[name]().then((m) => { loaded.set(name, m); if (alive) setMod(m); }).catch((e) => { console.error(e); if (alive) setErr(e); });
    return () => { alive = false; };
  }, [name]);
  if (err) return html`<${Crash} error=${err} />`;
  if (!mod) return html`<div class="page"><div class="row" style="padding:40px 0;justify-content:center"><${Spinner} /></div></div>`;
  const C = mod.default;
  return html`<${Boundary} key=${name}><${C} route=${route} /></${Boundary}>`;
}
function Boundary({ children }) {
  const [error, reset] = useErrorBoundary((e) => console.error('[screen]', e));
  if (error) return html`<${Crash} error=${error} reset=${reset} />`;
  return children;
}
function Crash({ error, reset }) {
  return html`<div class="page"><div class="card stack sm" style="margin-top:24px"><div class="strong">This screen hit an error</div>
    <div class="xs muted mono" style="white-space:pre-wrap">${String(error && (error.stack || error.message) || error).slice(0, 600)}</div>
    <div class="row">${reset ? html`<${Button} size="sm" onClick=${reset}>Try again</${Button}>` : null}<${Button} size="sm" variant="ghost" onClick=${() => { location.hash = '#/today'; location.reload(); }}>Reload app</${Button}></div></div></div>`;
}

/* ------------------------------------------------------------- shell */
/* ------------------------------------------------------- app updates */
// A new version installs in the background and waits; the banner lets the owner switch when it suits
// him (never mid-set). Local changes are flushed to the vault first.
let updateRequested = false;
function registerWorker(setUpdate) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (w) => { if (w && navigator.serviceWorker.controller) setUpdate(() => () => { updateRequested = true; w.postMessage({ type: 'skip-waiting' }); }); };
    const watch = (w) => { if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); }); };
    if (reg.waiting) offer(reg.waiting);
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('sw', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) location.reload(); });
}

function Shell({ app, update }) {
  const route = useRoute();
  const name = SCREENS[route.name] ? route.name : 'today';
  useEffect(() => { window.scrollTo(0, 0); }, [route.path]);
  const tabActive = (id) => (name === id || (id === 'insights' && false) ? 'page' : undefined);
  return html`<div class="shell">
    <nav class="sidebar" aria-label="Main">
      <div class="brand"><span class="brand-mark"></span>FORGE</div>
      ${NAV.map((n) => html`<button class="side-link" aria-current=${tabActive(n.id)} onClick=${() => app.nav('/' + n.id)}><${Icon} name=${n.icon} />${n.label}</button>`)}
      <div class="side-section">Records</div>
      ${SIDE_MORE.map((n) => html`<button class="side-link" aria-current=${tabActive(n.id)} onClick=${() => app.nav('/' + n.id)}><${Icon} name=${n.icon} />${n.label}</button>`)}
      <div style="margin-top:auto;padding:12px 4px 0"><${SyncBadge} /></div>
    </nav>
    <main class="main">
      ${update ? html`<div class="banner" style="max-width:760px;margin:0 auto 8px"><${Icon} name="sparkle" size=${16} /><span class="grow">A new version of FORGE is ready.</span>
        <button class="btn sm primary" onClick=${async () => { try { if (app.sync) await app.sync.flush(); } catch { /* offline: changes stay queued locally */ } update(); }}>Reload</button></div>` : null}
      ${app.demo ? html`<div class="banner demo-banner" style="max-width:760px;margin:0 auto 8px"><${Icon} name="info" size=${16} /><span class="grow">Demo mode — synthetic data, nothing is saved.</span><a class="strong" href=${location.pathname}>Exit</a></div>` : null}
      <${Screen} name=${name} route=${route} />
    </main>
    <nav class="tabbar" aria-label="Main">
      ${NAV.map((n) => html`<button class="tab" aria-current=${tabActive(n.id)} onClick=${() => app.nav('/' + n.id)}><${Icon} name=${n.icon} />${n.label}</button>`)}
    </nav>
  </div>`;
}

/* ----------------------------------------------------- sheets/toasts */
// Every open sheet stays mounted (keyed) so a sheet keeps its state while another opens on top; only the top one shows.
function SheetHost({ sheets, close }) {
  const top = sheets[sheets.length - 1];
  const live = useRef(sheets); live.current = sheets;
  const closing = useRef(new Set()); // closed but not yet re-rendered (fast repeated Escape)
  for (const id of [...closing.current]) if (!sheets.some((s) => s.id === id)) closing.current.delete(id);
  const open = !!top;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const list = live.current.filter((s) => !closing.current.has(s.id)); const t = list[list.length - 1];
      if (t && !t.opts.modal) { closing.current.add(t.id); close(t.id); }
    };
    document.addEventListener('keydown', onKey); document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open]);
  if (!top) return null;
  return html`${sheets.map((s) => html`<div key=${s.id} class="backdrop" style=${s === top ? '' : 'display:none'}
    onClick=${(e) => { if (e.target === e.currentTarget && !s.opts.modal) close(s.id); }}>
    <div class="sheet" role="dialog" aria-modal="true" style=${s.opts.wide ? 'max-width:860px' : ''}><div class="grab"></div>${s.render({ close: (v) => close(s.id, v) })}</div>
  </div>`)}`;
}
function Toasts({ toasts, dismiss }) {
  return html`<div class="toasts" aria-live="polite">${toasts.map((t) => html`<div class=${'toast ' + (t.tone || '')}><span>${t.message}</span>
    ${t.action ? html`<button onClick=${() => { t.action.onClick(); dismiss(t.id); }}>${t.action.label}</button>` : null}</div>`)}</div>`;
}

/* --------------------------------------------------------------- root */
function Root() {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('booting');
  const [sheets, setSheets] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [hold, setHold] = useState(false);
  const [update, setUpdate] = useState(null); // () => void once a new app version is installed and waiting
  const oauth = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      const s = await createSession({ demo, demoKind: demoParam === 'empty' ? 'empty' : 'full' });
      unsub = s.onChange(() => setStatus(s.status));
      setSession(s);
      await s.boot();
      setStatus(s.status);
    })();
    try { oauth.current = takeOAuthResult(); if (oauth.current) location.hash = '#/settings/integrations'; } catch { /* ignore */ }
    if ('serviceWorker' in navigator && !demo && location.protocol === 'https:') registerWorker(setUpdate);
    return () => unsub();
  }, []);

  const store = session && session.status === 'ready' ? session.store : null;
  useEffect(() => {
    if (!store) return undefined;
    const apply = () => applyTheme(store.setting('ui').theme);
    apply();
    return store.subscribe((ev) => { if (ev.collections.has('settings')) apply(); });
  }, [store]);
  // Settings → Appearance start screen (once per load, empty route only) and Security → auto-lock.
  useEffect(() => (store ? bindShellPrefs({ session, store, demo }) : undefined), [store]);

  const app = useMemo(() => {
    if (!session) return null;
    const closeSheet = (id, value) => setSheets((list) => {
      const item = list.find((x) => x.id === id); if (item && item.resolve) item.resolve(value);
      return list.filter((x) => x.id !== id);
    });
    const a = {
      session, demo,
      get store() { return session.store; }, get dv() { return session.dv; }, get sync() { return session.sync; },
      today: () => session.dv.today(),
      nav: (path) => { location.hash = '#' + (path.startsWith('/') ? path : '/' + path); },
      back: () => { if (history.length > 1) history.back(); else location.hash = '#/today'; },
      toast(message, opts = {}) {
        const id = ++seq.current;
        setToasts((l) => [...l.slice(-2), { id, message, ...opts }]);
        setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), opts.ms || (opts.action ? 6000 : 3000));
      },
      sheet(renderFn, opts = {}) {
        const id = ++seq.current;
        return new Promise((resolve) => setSheets((l) => [...l, { id, render: renderFn, opts, resolve }]));
      },
      closeSheet: (id, v) => closeSheet(id, v),
      confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
        return a.sheet(({ close }) => html`<div class="stack"><h2 style="font-size:18px">${title}</h2>${message ? html`<p class="dim">${message}</p>` : null}
          <div class="sheet-foot"><${Button} onClick=${() => close(false)}>Cancel</${Button}><${Button} variant=${danger ? 'danger' : 'primary'} onClick=${() => close(true)}>${confirmLabel}</${Button}></div></div>`).then((v) => !!v);
      },
      ai() {
        const key = session.creds.anthropicKey;
        if (!key) return null;
        return makeAiConfig(session.store.setting('integrations').ai, key);
      },
      requireAi() {
        const cfg = a.ai();
        if (!cfg) { a.toast('Add your Anthropic API key in Settings → AI first.', { action: { label: 'Open', onClick: () => a.nav('/settings/ai') } }); }
        return cfg;
      },
      takeOAuth() { const r = oauth.current; oauth.current = null; return r; },
      setHold,
    };
    return a;
  }, [session]);

  if (!session || status === 'booting') return html`<div class="lockscreen"><${Spinner} lg /></div>`;
  if (status === 'error') return html`<div class="lockscreen"><div class="box card stack"><div class="strong">FORGE could not start</div><div class="xs muted mono">${String(session.error && session.error.message)}</div><${Button} onClick=${() => location.reload()}>Reload</${Button}></div></div>`;
  return html`<${AppCtx.Provider} value=${app}>
    ${status === 'ready' && !hold ? html`<${Shell} app=${app} update=${update} />` : html`<${Gate} status=${status} />`}
    <${SheetHost} sheets=${sheets} close=${app.closeSheet} />
    <${Toasts} toasts=${toasts} dismiss=${(id) => setToasts((l) => l.filter((t) => t.id !== id))} />
  </${AppCtx.Provider}>`;
}

function Gate({ status }) {
  const [mod, setMod] = useState(null);
  useEffect(() => { import('./ui/screens/setup.js').then(setMod); }, []);
  if (!mod) return html`<div class="lockscreen"><${Spinner} lg /></div>`;
  return status === 'locked' ? html`<${mod.LockScreen} />` : html`<${mod.SetupFlow} />`;
}

render(html`<${Root} />`, document.getElementById('app'));
