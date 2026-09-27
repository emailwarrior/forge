// Global header chrome shown on every page: sync status + (mobile) More menu.
import { html } from '../vendor/preact-htm.js';
import { useApp, useSyncStatus, useRoute } from './ctx.js';
import { Icon } from './kit.js';

export function SyncBadge({ compact }) {
  const app = useApp(); const s = useSyncStatus();
  if (!app) return null;
  if (app.demo) return html`<span class="pill accent" title="Demo data — nothing is saved">Demo</span>`;
  const busy = s.state === 'pushing' || s.state === 'pulling';
  const cls = s.state === 'error' ? 'err' : s.state === 'offline' ? 'off' : busy ? 'busy' : '';
  const text = s.state === 'error' ? 'Sync issue' : s.state === 'offline' ? 'Offline' : busy ? 'Syncing' : s.pending ? `${s.pending} pending` : 'Synced';
  return html`<button class="btn ghost sm" onClick=${() => app.nav('/settings/sync')} title=${s.error || text} aria-label=${'Sync: ' + text}>
    <span class=${'sync-dot ' + cls}></span>${compact ? null : html`<span class="xs">${text}</span>`}</button>`;
}

export function GlobalActions() {
  const app = useApp(); const route = useRoute();
  if (!app) return null;
  return html`<span class="row" style="gap:2px">
    <span class="only-sm"><${SyncBadge} compact /></span>
    ${route.name !== 'more' ? html`<button class="icon-btn only-sm" aria-label="More" title="More" onClick=${() => app.nav('/more')}><${Icon} name="more" /></button>` : null}
  </span>`;
}
