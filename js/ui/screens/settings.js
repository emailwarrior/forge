// Settings: grouped index with one-line current state per section, setup overview, and the
// section modules (js/ui/screens/settings/*.js, lazily imported). Desktop: index left, section
// right. Mobile: index page → section sub-page with Back.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useSyncStatus, useWide, useAnalytics, useNow } from '../ctx.js';
import { Page, Icon, Spinner, Notice, Button, cx } from '../kit.js';
import { SaveNote, useLatestAutomation } from '../parts/settings-ui.js';
import * as S from '../parts/settings-status.js';
import { calorieTargets } from '../../analytics/index.js';
import { openWeighIn } from '../actions/weight.js';

export const SECTIONS = [
  { id: 'profile', group: 'Profile & goals', title: 'Profile', icon: 'scale', desc: 'Body measurements, goal weight and time zone.', load: () => import('./settings/profile.js') },
  { id: 'targets', group: 'Profile & goals', title: 'Targets', icon: 'target', desc: 'Calories, macros and daily timing targets.', load: () => import('./settings/targets.js') },
  { id: 'standards', group: 'Profile & goals', title: 'Standards', icon: 'list', desc: 'What counts as a complete day, and how each item is measured.', load: () => import('./settings/standards.js') },
  { id: 'nutrition', group: 'Profile & goals', title: 'Nutrition rules', icon: 'fuel', desc: 'Your own rules, applied to every meal analysis and daily review.', load: () => import('./settings/nutrition.js') },
  { id: 'integrations', group: 'Connections', title: 'Integrations', icon: 'link', desc: 'WHOOP, Google Calendar, push notifications and Apple Health.', load: () => import('./settings/integrations.js') },
  { id: 'ai', group: 'Connections', title: 'AI', icon: 'sparkle', desc: 'Anthropic API key, models and costs.', load: () => import('./settings/ai.js') },
  { id: 'automation', group: 'Connections', title: 'Automation', icon: 'zap', desc: 'The hourly server job in your vault that syncs integrations and sends notifications.', load: () => import('./settings/automation.js') },
  { id: 'notifications', group: 'Connections', title: 'Notifications', icon: 'bell', desc: 'Which push notifications you get, and quiet hours.', load: () => import('./settings/notifications.js') },
  { id: 'sync', group: 'Device & data', title: 'Sync', icon: 'sync', desc: 'Vault sync status and the GitHub token on this device.', load: () => import('./settings/sync.js') },
  { id: 'security', group: 'Device & data', title: 'Security', icon: 'shield', desc: 'Locking, passphrase and the server data key.', load: () => import('./settings/security.js') },
  { id: 'data', group: 'Device & data', title: 'Data', icon: 'folder', desc: 'Backups, imports and what is stored.', load: () => import('./settings/data.js') },
  { id: 'appearance', group: 'Device & data', title: 'Appearance', icon: 'eye', desc: 'Theme and start screen.', load: () => import('./settings/appearance.js') },
];
const GROUPS = ['Profile & goals', 'Connections', 'Device & data'];
const byId = (id) => SECTIONS.find((s) => s.id === id) || null;

/* ------------------------------------------------------------- summaries */
function useSummaries() {
  const app = useApp(); const store = app.store;
  useVersion(['settings', 'status', 'pushSubs', 'standards', 'body']);
  // Session-level changes (API key, lock mode, token) are not store changes.
  const [, bump] = useState(0);
  useEffect(() => app.session.onChange(() => bump((n) => n + 1)), [app.session]);
  const sync = useSyncStatus(); const now = useNow(60000);
  const latest = useLatestAutomation();
  const today = app.today();
  const ct = useAnalytics(() => calorieTargets(app.dv, today), [today]);
  const profile = store.setting('profile'); const targets = store.setting('targets');
  const integ = store.setting('integrations');
  const subs = store.all('pushSubs');
  const push = S.pushState(subs, store.get('status', 'push'));
  const whoop = S.whoopState(integ.whoop, store.get('status', 'whoop'), now);
  const cal = S.calendarState(integ.gcal, store.get('status', 'calendar'), now);
  const auto = S.automationSummary(integ.automation, latest, store.get('status', 'run'), now);
  const hasKey = !!app.session.creds.anthropicKey;
  const rules = store.setting('nutritionRules').rules || [];
  const vault = app.session.vault;
  const records = store.collections.reduce((n, c) => n + store.all(c).length, 0);
  const summaries = {
    profile: S.profileSummary(profile, today),
    targets: S.targetsSummary(ct, targets.mode),
    standards: S.standardsSummary(store.all('standards')),
    nutrition: S.rulesSummary(rules),
    integrations: app.demo && integ.whoop.connectedAt ? { tone: null, text: `Demo WHOOP and calendar data · ${push.text}` } : S.integrationsSummary(whoop, cal, push, store.get('status', 'whoop'), now),
    ai: S.aiSummary({ hasKey, ai: integ.ai }),
    automation: app.demo ? { tone: null, text: 'Not available in demo' } : auto,
    notifications: S.notificationsSummary(store.setting('notifications'), { devices: push.devices }),
    sync: S.syncSummary(sync, now),
    security: app.demo ? { tone: null, text: 'Not available in demo' } : S.securitySummary({ lockMode: app.session.lockMode, autoLockMin: store.setting('security').autoLockMin }),
    data: { tone: null, text: `${vault ? vault.owner + '/' + vault.repo : 'In memory (demo)'} · ${records.toLocaleString('en-US')} records` },
    appearance: S.appearanceSummary(store.setting('ui')),
  };
  const checklist = S.setupChecklist({
    profileDone: profile.heightIn != null && profile.birthYear != null && (profile.goalWeightLow != null || profile.goalWeightHigh != null),
    hasWeighIn: store.all('body').some((b) => typeof b.weightLb === 'number'),
    hasKey, automationInstalled: !!integ.automation, whoopConnected: whoop.key === 'ok' || whoop.key === 'backfill',
    calendarConnected: cal.key === 'ok', pushOn: push.devices > 0, hasRules: rules.some((r) => r.active !== false),
  });
  return { summaries, checklist };
}

/* ----------------------------------------------------------------- index */
function SettingsIndex({ current, summaries, wide }) {
  const app = useApp();
  return html`<nav class=${cx('set-index', wide && 'side')} aria-label="Settings sections">
    ${GROUPS.map((g) => html`<div class="set-group" key=${g}>
      <div class="eyebrow set-group-title">${g}</div>
      <div class="card flush set-group-list">
        ${SECTIONS.filter((s) => s.group === g).map((s) => {
          const sum = summaries[s.id] || { text: '' };
          return html`<button type="button" class="set-row" key=${s.id} aria-current=${current === s.id ? 'page' : undefined} onClick=${() => app.nav('/settings/' + s.id)}>
            <span class="set-row-icon"><${Icon} name=${s.icon} size=${18} /></span>
            <span class="grow" style="min-width:0"><span class="set-row-title">${s.title}</span>
              <span class=${cx('set-row-sum', sum.tone === 'bad' && 'ink-bad')}>${sum.text}</span></span>
            ${wide ? null : html`<${Icon} name="chevronRight" size=${16} class="muted" />`}
          </button>`;
        })}
      </div>
    </div>`)}
  </nav>`;
}

function Overview({ checklist, compact }) {
  const app = useApp();
  const go = (c) => (c.section ? app.nav('/settings/' + c.section) : c.id === 'weighin' ? openWeighIn(app, {}) : null);
  const required = checklist.filter((c) => !c.optional);
  const done = checklist.filter((c) => c.done).length;
  const next = checklist.find((c) => !c.done && !c.optional) || checklist.find((c) => !c.done);
  if (compact) {
    if (!next) return null;
    return html`<button type="button" class="card set-next" onClick=${() => go(next)}>
      <div class="grow" style="min-width:0"><div class="eyebrow">Setup · ${done} of ${checklist.length} done</div>
        <div class="strong small" style="margin-top:4px">Next: ${next.label}</div></div>
      <${Icon} name="chevronRight" size=${16} class="muted" /></button>`;
  }
  return html`<div class="stack lg">
    <div class="set-panel-head"><h2>Setup</h2><p class="small muted">${done === checklist.length ? 'Everything is set up.' : `${done} of ${checklist.length} done. The first ${required.length} matter most; the rest are optional.`}</p></div>
    <div class="card flush"><div class="list">
      ${checklist.map((c) => html`<div class="list-row link" key=${c.id} role="button" tabIndex="0" onClick=${() => go(c)} onKeyDown=${(e) => { if (e.key === 'Enter') go(c); }}>
        <span class=${cx('set-check', c.done && 'on')}>${c.done ? html`<${Icon} name="check" size=${14} />` : null}</span>
        <div class="grow"><div class=${cx('title', c.done && 'dim')}>${c.label}</div>${c.optional ? html`<div class="meta">Optional</div>` : null}</div>
        <${Icon} name=${c.section ? 'chevronRight' : 'plus'} size=${16} class="muted" />
      </div>`)}
    </div></div>
    <p class="xs muted">Pick a section on the left. Changes save as you type; keys and secrets have their own Save buttons.</p>
  </div>`;
}

/* --------------------------------------------------------------- section */
const loaded = new Map();
function LazySection({ def }) {
  const [mod, setMod] = useState(loaded.get(def.id) || null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true; setErr(null);
    if (loaded.has(def.id)) { setMod(loaded.get(def.id)); return undefined; }
    setMod(null);
    def.load().then((m) => { loaded.set(def.id, m); if (alive) setMod(m); }).catch((e) => { console.error('[settings]', e); if (alive) setErr(e); });
    return () => { alive = false; };
  }, [def.id]);
  if (err) return html`<${Notice} tone="bad"><div class="stack sm"><span>This section could not load (${String(err.message || err)}).</span><div><${Button} size="sm" onClick=${() => location.reload()}>Reload</${Button}></div></div></${Notice}>`;
  if (!mod) return html`<div class="row" style="padding:32px 0;justify-content:center"><${Spinner} /></div>`;
  const C = mod.default;
  return html`<${C} key=${def.id} />`;
}

export default function Screen({ route }) {
  const wide = useWide();
  const { summaries, checklist } = useSummaries();
  const def = byId(route.arg);
  if (wide) {
    return html`<${Page} title="Settings" wide>
      <div class="set-layout">
        <${SettingsIndex} current=${def ? def.id : null} summaries=${summaries} wide />
        <div class="set-panel" key=${def ? def.id : 'overview'}>
          ${def ? html`<div class="stack lg"><div class="set-panel-head"><div class="row between top"><h2>${def.title}</h2><${SaveNote} /></div><p class="small muted">${def.desc}</p></div><${LazySection} def=${def} /></div>`
            : html`<${Overview} checklist=${checklist} />`}
        </div>
      </div>
    </${Page}>`;
  }
  if (def) {
    return html`<${Page} title=${def.title} back="/settings">
      <div class="row between top set-desc"><p class="small muted grow">${def.desc}</p><${SaveNote} /></div>
      <${LazySection} def=${def} />
    </${Page}>`;
  }
  return html`<${Page} title="Settings">
    <${Overview} checklist=${checklist} compact />
    <${SettingsIndex} summaries=${summaries} />
  </${Page}>`;
}
