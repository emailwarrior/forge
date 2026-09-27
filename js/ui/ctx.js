// App context + hooks shared by every screen.
import { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from '../vendor/preact-htm.js';

export const AppCtx = createContext(null);

/** The app object: { session, store, dv, sync, nav, back, toast, sheet, closeSheet, confirm, ai, requireAi, today, demo, route } */
export function useApp() { return useContext(AppCtx); }

/** Re-render when the store changes (optionally only for some collections). Returns the store version. */
export function useVersion(collections) {
  const app = useApp();
  const store = app && app.store;
  const [v, setV] = useState(store ? store.version : 0);
  const want = useRef(collections ? new Set(collections) : null);
  useEffect(() => {
    if (!store) return undefined;
    return store.subscribe((ev) => {
      if (!want.current || [...ev.collections].some((c) => want.current.has(c))) setV(ev.version);
    });
  }, [store]);
  return v;
}

/** Settings record (re-renders on change). */
export function useSetting(id) {
  const app = useApp(); useVersion(['settings']);
  return app.store.setting(id);
}

/** Sync status (re-renders on change). */
export function useSyncStatus() {
  const app = useApp();
  const [s, setS] = useState(app.session.syncStatus());
  useEffect(() => app.session.onSyncStatus(setS), [app.session]);
  return s;
}

/** Run an async action with busy/error state. */
export function useAction(fn, deps = []) {
  const [state, setState] = useState({ busy: false, error: null, result: undefined });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = useCallback(async (...args) => {
    setState({ busy: true, error: null, result: undefined });
    try {
      const result = await fn(...args);
      if (alive.current) setState({ busy: false, error: null, result });
      return result;
    } catch (error) {
      console.warn('[action]', error);
      if (alive.current) setState({ busy: false, error, result: undefined });
      return undefined;
    }
  }, deps);
  return [run, state];
}

/** Memoize an analytics computation on the store version. */
export function useAnalytics(fn, deps = []) {
  const v = useVersion();
  return useMemo(() => { try { return fn(); } catch (e) { console.error('[analytics]', e); return null; } }, [v, ...deps]);
}

/** Current hash route: { path, parts, name, arg, query } */
export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  return { path: '/' + parts.join('/'), parts, name: parts[0] || '', arg: parts[1] || '', query };
}
export function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    const on = () => setR(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

/** Window width breakpoint (desktop ≥ 1024). */
export function useWide() {
  const q = typeof matchMedia === 'function' ? matchMedia('(min-width: 1024px)') : null;
  const [w, setW] = useState(q ? q.matches : false);
  useEffect(() => { if (!q) return undefined; const on = () => setW(q.matches); q.addEventListener('change', on); return () => q.removeEventListener('change', on); }, []);
  return w;
}

/** Ticking clock (minutes) for "now" markers. */
export function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}
