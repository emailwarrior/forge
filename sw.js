// FORGE service worker: versioned offline app shell + Web Push display.
// Every deploy stamps VERSION and PRECACHE (tools/build-sw.mjs). A version is installed completely
// before it serves anything, and it waits until the app asks for it (Update → Reload), so a
// running app never mixes files from two versions. Only public app code is cached here — vault
// data never passes through this worker (GitHub/Anthropic requests go straight to the network).
const VERSION = '3.0.0-554e07e44d'; // @build
const PRECACHE = ["./","./callback.html","./css/app.css","./css/day.css","./css/fuel.css","./css/insights.css","./css/records.css","./css/settings.css","./css/train.css","./icons/apple-touch-icon.png","./icons/favicon.svg","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./index.html","./js/ai/ask.js","./js/ai/claude.js","./js/ai/errors.js","./js/ai/image.js","./js/ai/index.js","./js/ai/labs.js","./js/ai/meal.js","./js/ai/pricing.js","./js/ai/prompts.js","./js/ai/reviews.js","./js/ai/schemas.js","./js/analytics/body.js","./js/analytics/context.js","./js/analytics/correlations.js","./js/analytics/daily.js","./js/analytics/dataview.js","./js/analytics/execution.js","./js/analytics/finance.js","./js/analytics/index.js","./js/analytics/labs.js","./js/analytics/nutrition.js","./js/analytics/protocols.js","./js/analytics/readiness.js","./js/analytics/schedule.js","./js/analytics/stats.js","./js/analytics/strength.js","./js/analytics/weekly.js","./js/app.js","./js/app/backup.js","./js/app/health-import.js","./js/app/integrations.js","./js/app/session.js","./js/callback.js","./js/core/crypto.js","./js/core/github.js","./js/core/idb.js","./js/core/merge.js","./js/core/migrate.js","./js/core/schema.js","./js/core/store.js","./js/core/sync.js","./js/core/util.js","./js/data/quotes.js","./js/ui/actions/checkin.js","./js/ui/actions/journal.js","./js/ui/actions/meal.js","./js/ui/actions/plan.js","./js/ui/actions/stack.js","./js/ui/actions/weight.js","./js/ui/actions/workout.js","./js/ui/charts.js","./js/ui/chrome.js","./js/ui/ctx.js","./js/ui/icon-paths.js","./js/ui/kit.js","./js/ui/parts/ai.js","./js/ui/parts/common.js","./js/ui/parts/date.js","./js/ui/parts/day-model.js","./js/ui/parts/day-ui.js","./js/ui/parts/fuel-capture.js","./js/ui/parts/fuel-logic.js","./js/ui/parts/fuel-meal.js","./js/ui/parts/fuel-queue.js","./js/ui/parts/fuel-ui.js","./js/ui/parts/insights-charts.js","./js/ui/parts/insights-kit.js","./js/ui/parts/insights-logic.js","./js/ui/parts/insights-md.js","./js/ui/parts/media.js","./js/ui/parts/records-finance.js","./js/ui/parts/records-journal.js","./js/ui/parts/records-labs.js","./js/ui/parts/records-protocols.js","./js/ui/parts/records-ui.js","./js/ui/parts/records-util.js","./js/ui/parts/settings-shell.js","./js/ui/parts/settings-standards.js","./js/ui/parts/settings-status.js","./js/ui/parts/settings-ui.js","./js/ui/parts/settings-util.js","./js/ui/parts/train-data.js","./js/ui/parts/train-logic.js","./js/ui/parts/train-sheets.js","./js/ui/parts/train-ui.js","./js/ui/screens/finance.js","./js/ui/screens/finance/snapshot.js","./js/ui/screens/fuel.js","./js/ui/screens/import.js","./js/ui/screens/import/health.js","./js/ui/screens/insights.js","./js/ui/screens/insights/ask.js","./js/ui/screens/insights/body.js","./js/ui/screens/insights/cardio.js","./js/ui/screens/insights/drivers.js","./js/ui/screens/insights/labs.js","./js/ui/screens/insights/nutrition.js","./js/ui/screens/insights/overview.js","./js/ui/screens/insights/protocols.js","./js/ui/screens/insights/recovery.js","./js/ui/screens/insights/schedule.js","./js/ui/screens/insights/sleep.js","./js/ui/screens/insights/strength.js","./js/ui/screens/insights/weekly.js","./js/ui/screens/journal.js","./js/ui/screens/labs.js","./js/ui/screens/labs/add.js","./js/ui/screens/labs/panel.js","./js/ui/screens/labs/trends.js","./js/ui/screens/more.js","./js/ui/screens/plan.js","./js/ui/screens/plan/day.js","./js/ui/screens/plan/schedule.js","./js/ui/screens/plan/sheets.js","./js/ui/screens/plan/week.js","./js/ui/screens/protocols.js","./js/ui/screens/protocols/detail.js","./js/ui/screens/protocols/editor.js","./js/ui/screens/settings.js","./js/ui/screens/settings/ai.js","./js/ui/screens/settings/appearance.js","./js/ui/screens/settings/automation.js","./js/ui/screens/settings/data.js","./js/ui/screens/settings/integrations.js","./js/ui/screens/settings/notifications.js","./js/ui/screens/settings/nutrition.js","./js/ui/screens/settings/profile.js","./js/ui/screens/settings/security.js","./js/ui/screens/settings/standards.js","./js/ui/screens/settings/sync.js","./js/ui/screens/settings/targets.js","./js/ui/screens/setup.js","./js/ui/screens/today.js","./js/ui/screens/today/cards.js","./js/ui/screens/today/execution.js","./js/ui/screens/today/quicklog.js","./js/ui/screens/today/readiness.js","./js/ui/screens/today/timeline.js","./js/ui/screens/train.js","./js/ui/screens/train/exercise.js","./js/ui/screens/train/library.js","./js/ui/screens/train/overview.js","./js/ui/screens/train/session.js","./js/vendor/preact-htm.js","./js/vendor/sealedbox.js","./manifest.webmanifest"]; // @build
const CACHE = 'forge-' + VERSION;
const FONTS = 'forge-fonts';

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the HTTP cache so a new version never precaches stale files.
  const list = PRECACHE.length ? PRECACHE : ['./index.html'];
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(list.map((u) => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('forge-') && k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (isFont) {
    e.respondWith(caches.open(FONTS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }))));
    return;
  }
  if (url.origin !== self.location.origin) return; // GitHub / Anthropic APIs: never cached
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const rel = url.pathname.slice(scope.length);
  // Automation bundle + workflow are fetched fresh when installing them into the vault.
  if (rel.startsWith('dist/') || rel.startsWith('automation/') || rel === 'sw.js') return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const key = req.mode === 'navigate' ? (rel.startsWith('callback.html') ? './callback.html' : './index.html') : req;
    const hit = await c.match(key, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic' && req.mode !== 'navigate') c.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') { const shell = await c.match('./index.html'); if (shell) return shell; }
      throw err;
    }
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'FORGE', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'FORGE', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || './#/today' },
    icon: './icons/icon-192.png', badge: './icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './#/today', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.navigate(target).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
