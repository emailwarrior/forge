import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindShellPrefs, _resetStartScreen, holdAutoLock } from '../../js/ui/parts/settings-shell.js';
import { createStore } from '../../js/core/store.js';

function fakeEnv({ hash = '' } = {}) {
  const listeners = new Map(); const docListeners = new Map(); const timers = [];
  let t = 1_000_000;
  const env = {
    location: { hash, replaced: [], replace(h) { this.replaced.push(h); this.hash = h; } },
    window: { addEventListener: (e, fn) => listeners.set(e, fn), removeEventListener: (e) => listeners.delete(e) },
    document: { visibilityState: 'visible', addEventListener: (e, fn) => docListeners.set(e, fn), removeEventListener: (e) => docListeners.delete(e) },
    now: () => t,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: (id) => { timers[id - 1] = null; },
  };
  return { env, listeners, docListeners, timers, advance: (ms) => { t += ms; }, tick: () => timers.forEach((fn) => fn && fn()) };
}
const session = () => { const s = { status: 'ready', locks: 0, lock: async () => { s.locks++; } }; return s; };

test('settings-shell: start screen opens once, only from an empty route', () => {
  _resetStartScreen();
  const store = createStore({ owner: 'app' });
  store.updateSetting('ui', { startScreen: 'fuel' });
  const a = fakeEnv({ hash: '' });
  bindShellPrefs({ session: session(), store, demo: true }, a.env)();
  assert.deepEqual(a.env.location.replaced, ['#/fuel']);
  const b = fakeEnv({ hash: '' });
  bindShellPrefs({ session: session(), store, demo: true }, b.env)();
  assert.deepEqual(b.env.location.replaced, [], 'second store (after unlock) does not redirect again');
  _resetStartScreen();
  const c = fakeEnv({ hash: '#/today' });
  bindShellPrefs({ session: session(), store, demo: true }, c.env)();
  assert.deepEqual(c.env.location.replaced, [], 'an explicit route wins');
});

test('settings-shell: auto-lock after idle minutes, reset by interaction, off at 0, cleaned up', () => {
  _resetStartScreen();
  const store = createStore({ owner: 'app' });
  store.updateSetting('security', { autoLockMin: 5 });
  const f = fakeEnv({ hash: '#/today' }); const s = session();
  const off = bindShellPrefs({ session: s, store, demo: false }, f.env);
  assert.ok(f.listeners.has('pointerdown') && f.docListeners.has('visibilitychange'));
  f.advance(4 * 60000); f.tick();
  assert.equal(s.locks, 0);
  f.listeners.get('pointerdown')(); // interaction resets the idle clock
  f.advance(4 * 60000); f.tick();
  assert.equal(s.locks, 0);
  f.advance(60000); f.docListeners.get('visibilitychange')(); // back from background after 5 min idle
  assert.equal(s.locks, 1);
  store.updateSetting('security', { autoLockMin: 0 });
  f.advance(60 * 60000); f.tick();
  assert.equal(s.locks, 1, 'off');
  off();
  assert.ok(!f.listeners.has('pointerdown') && !f.docListeners.has('visibilitychange'));
  assert.equal(f.timers[0], null);
});

test('settings-shell: demo mode never locks', () => {
  _resetStartScreen();
  const store = createStore({ owner: 'app' });
  store.updateSetting('security', { autoLockMin: 5 });
  const f = fakeEnv({ hash: '#/x' }); const s = session();
  bindShellPrefs({ session: s, store, demo: true }, f.env);
  assert.equal(f.timers.length, 0);
});

test('settings-shell: a running settings job holds off the auto-lock', () => {
  _resetStartScreen();
  const store = createStore({ owner: 'app' });
  store.updateSetting('security', { autoLockMin: 5 });
  const f = fakeEnv({ hash: '#/x' }); const s = session();
  const off = bindShellPrefs({ session: s, store, demo: false }, f.env);
  const token = {};
  holdAutoLock(token, true);
  f.advance(20 * 60000); f.tick();
  assert.equal(s.locks, 0, 'held');
  holdAutoLock(token, false);
  f.advance(4 * 60000); f.tick();
  assert.equal(s.locks, 0, 'the hold counted as activity');
  f.advance(60000); f.tick();
  assert.equal(s.locks, 1);
  off();
});
