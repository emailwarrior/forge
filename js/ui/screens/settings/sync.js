// Settings → Sync: live sync status, Sync now, the vault (read-only), and replacing this device's
// GitHub token (fine-grained, vault only) with a check and a way back if GitHub rejects it.
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useSyncStatus, useNow } from '../../ctx.js';
import { Button, KV, Notice } from '../../kit.js';
import { Block, StatusLine, SecretInput, ExtLink, Reason, Ago, FieldGroup } from '../../parts/settings-ui.js';
import { syncSummary } from '../../parts/settings-status.js';
import { maskKey } from '../../parts/settings-util.js';
import { tokenUrl, deviceLabel } from '../../../app/integrations.js';
import { fmtDate } from '../../../core/util.js';

const STATE = { idle: 'Idle', pushing: 'Uploading', pulling: 'Downloading', offline: 'Offline', error: 'Error', demo: 'Demo' };

export default function SyncSection() {
  const app = useApp(); const s = app.session;
  const sync = useSyncStatus(); const now = useNow(30000);
  const sum = syncSummary(sync, now);
  const vault = s.vault;
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [tokBusy, setTokBusy] = useState(false);
  const [tokErr, setTokErr] = useState('');
  const [prev, setPrev] = useState(null);
  const [current, setCurrent] = useState(s.creds.githubToken || '');

  const syncNow = async () => {
    if (!app.sync) return;
    setBusy(true);
    await app.sync.sync();
    setBusy(false);
    const st = s.syncStatus();
    if (st.state === 'error') app.toast('Sync failed: ' + (st.error || 'unknown error'), { tone: 'error', ms: 5000 });
    else if (st.state === 'offline') app.toast('Offline: changes stay on this device until the connection is back');
    else app.toast('Synced');
  };
  const replace = async (value, { revert = false } = {}) => {
    const t = String(value || '').trim(); if (!t) return;
    setTokErr(''); setTokBusy(true);
    const old = s.creds.githubToken || '';
    try {
      await s.updateCreds({ githubToken: t });
      await app.sync.sync();
      const st = s.syncStatus();
      if (st.state === 'error') {
        setTokErr(`GitHub did not accept this token: ${st.error}. Check its repository access (${vault ? vault.repo : 'the vault'} only) and permissions.`);
        if (!revert) setPrev(old);
      } else {
        setToken(''); setPrev(null);
        app.toast(revert ? 'Previous token restored' : 'Token replaced; sync works');
      }
      if (revert) setPrev(null);
      setCurrent(t);
    } catch (e) { console.warn(e); setTokErr(e.message || String(e)); } finally { setTokBusy(false); }
  };
  const tokenLooksRight = !token.trim() || /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token.trim());

  return html`<div class="stack lg">
    <${Block} title="Status">
      <${StatusLine} tone=${sum.tone}>${sum.text}</${StatusLine}>
      <${KV} items=${[
        ['State', STATE[sync.state] || sync.state],
        ['Changes waiting to upload', String(sync.pending || 0)],
        ['Last sync', sync.lastSyncAt ? html`<${Ago} at=${sync.lastSyncAt} />` : app.demo ? '—' : 'not yet'],
        sync.error ? ['Error', html`<span class="ink-bad">${sync.error}</span>`] : null,
      ]} />
      <div class="set-actions"><${Button} icon="sync" loading=${busy || sync.state === 'pushing' || sync.state === 'pulling'} disabled=${app.demo || !app.sync} onClick=${syncNow}>Sync now</${Button}></div>
      <${Reason}>${app.demo ? 'Not available in demo' : 'FORGE syncs on its own: after edits (within seconds), every minute while open, and when the app comes back to the foreground.'}</${Reason}>
    </${Block}>

    <${Block} title="Vault" desc="Your data lives encrypted in this private GitHub repository.">
      ${vault ? html`<${KV} items=${[
        ['Repository', html`<span class="set-code">${vault.owner}/${vault.repo}</span>`],
        ['Branch', vault.branch || 'main'],
        ['Visibility', 'Private (checked on connect)'],
        ['Encryption', 'AES-256-GCM, on your devices before upload'],
        ['This device connected', vault.connectedAt ? fmtDate(String(vault.connectedAt).slice(0, 10), { dow: false, year: true }) : '—'],
      ]} /><div><${ExtLink} href=${`https://github.com/${vault.owner}/${vault.repo}`}>Open on GitHub</${ExtLink}></div>`
        : html`<div class="small muted">${app.demo ? 'Demo mode: nothing is stored or synced.' : 'No vault connected.'}</div>`}
    </${Block}>

    <${Block} title="GitHub token on this device" desc="A fine-grained personal access token, stored encrypted on this device only. Use one token per device so a lost phone can be revoked on its own.">
      ${current ? html`<${StatusLine} tone="good">Token set <span class="set-code muted">${maskKey(current)}</span></${StatusLine}>` : html`<${StatusLine} tone=${app.demo ? null : 'warn'}>${app.demo ? 'Not used in demo' : 'No token on this device'}</${StatusLine}>`}
      <div class="card inset tight stack xs small">
        <div class="strong">The token needs</div>
        <ul class="set-list dim">
          <li>Repository access: <b>only</b> ${vault ? html`<span class="set-code">${vault.repo}</span>` : 'the vault repository'}</li>
          <li>Contents, Actions, Secrets, Workflows: Read and write</li>
          <li>Metadata: Read (added automatically)</li>
          <li>Expiration: up to a year; FORGE shows a sync error when it expires</li>
        </ul>
        <div><${ExtLink} href=${tokenUrl(vault ? vault.owner : '', deviceLabel())}>Create a token (pre-filled)</${ExtLink}></div>
      </div>
      <${FieldGroup} label="Replace the token" hint=${tokenLooksRight ? 'The new token is tested with a sync right away.' : 'GitHub tokens start with github_pat_ (fine-grained) or ghp_.'}>
        <${SecretInput} value=${token} onValue=${setToken} placeholder="github_pat_…" label="New GitHub token" onEnter=${() => !app.demo && replace(token)} />
      </${FieldGroup}>
      <div class="set-actions"><${Button} variant="primary" icon="key" loading=${tokBusy} disabled=${app.demo || !token.trim() || !vault} onClick=${() => replace(token)}>Replace token</${Button}></div>
      <${Reason}>${app.demo ? 'Not available in demo' : ''}</${Reason}>
      ${tokErr ? html`<${Notice} tone="bad"><div class="stack sm"><span>${tokErr}</span>
        ${prev ? html`<div><${Button} size="sm" icon="undo" loading=${tokBusy} onClick=${() => replace(prev, { revert: true })}>Restore the previous token</${Button}></div>` : null}</div></${Notice}>` : null}
    </${Block}>
  </div>`;
}
