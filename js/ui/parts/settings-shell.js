// Shell preferences from Settings, applied by js/app.js once the store is ready:
// - ui.startScreen: opened once per page load when the app starts without a route (empty hash);
// - security.autoLockMin: locks the vault after that many minutes without interaction.
// Pure helpers are exported for tests; bindShellPrefs() touches window/document only when called.

export const START_SCREENS = ['today', 'plan', 'train', 'fuel', 'insights'];

/** Hash to open instead of the default, or null. Only an empty route is redirected. */
export function startRedirect(hash, startScreen) {
  const h = String(hash || '');
  if (h && h !== '#' && h !== '#/') return null;
  if (!START_SCREENS.includes(startScreen) || startScreen === 'today') return null;
  return '#/' + startScreen;
}

/** True when `minutes` (> 0) have passed since the last interaction. */
export function idleExpired(lastMs, nowMs, minutes) {
  return typeof minutes === 'number' && minutes > 0 && Number.isFinite(lastMs) && nowMs - lastMs >= minutes * 60000;
}

let startApplied = false;
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
// Long operations (e.g. waiting for a server run after connecting WHOOP) hold off the auto-lock.
const holds = new Set();
export function holdAutoLock(token, on) { if (on) holds.add(token); else holds.delete(token); }

/**
 * Apply the start screen (first call per page load only) and run the auto-lock timer.
 * Returns a cleanup function. `env` exists for tests (defaults to the browser globals).
 */
export function bindShellPrefs({ session, store, demo }, env = {}) {
  const loc = env.location || (typeof location !== 'undefined' ? location : null);
  const win = env.window || (typeof window !== 'undefined' ? window : null);
  const doc = env.document || (typeof document !== 'undefined' ? document : null);
  const now = env.now || Date.now;
  const every = env.setInterval || setInterval; const stop = env.clearInterval || clearInterval;
  if (!startApplied && loc) {
    startApplied = true;
    try { const to = startRedirect(loc.hash, store.setting('ui').startScreen); if (to) loc.replace(to); } catch (e) { console.warn('[start screen]', e); }
  }
  if (demo || !win || !doc) return () => {};
  let last = now();
  const bump = () => { last = now(); };
  const check = () => {
    if (session.status !== 'ready') return;
    if (holds.size) { last = now(); return; }
    let min = 0; try { min = store.setting('security').autoLockMin; } catch { return; }
    if (idleExpired(last, now(), min)) { last = now(); Promise.resolve(session.lock()).catch((e) => console.warn('[auto-lock]', e)); }
  };
  const onVisible = () => { if (doc.visibilityState === 'visible') check(); };
  for (const e of EVENTS) win.addEventListener(e, bump, { passive: true, capture: true });
  doc.addEventListener('visibilitychange', onVisible);
  const timer = every(check, 30000);
  return () => {
    for (const e of EVENTS) win.removeEventListener(e, bump, { capture: true });
    doc.removeEventListener('visibilitychange', onVisible);
    stop(timer);
  };
}

/** Test helper: allow the start-screen redirect again. */
export function _resetStartScreen() { startApplied = false; }
