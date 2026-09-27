// Settings → Security: lock mode (this device), auto-lock, lock now, change passphrase, re-send the
// server data key (FORGE_DATA_KEY), recovery-key reminder, forget this device.
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp } from '../../ctx.js';
import { Button, Field, Input, Notice, Select, CopyBox } from '../../kit.js';
import { Block, Seg, FieldGroup, Reason, Strength, StatusLine, JobLog, useJob, useGitHub, useSettingDraft, useSecretNames, refreshSecretNames } from '../../parts/settings-ui.js';
import { MIN_PASSPHRASE_BITS } from '../../parts/settings-util.js';
import { passphraseBits } from '../../../core/crypto.js';
import { setSecret } from '../../../app/integrations.js';
import { bytesToB64 } from '../../../core/util.js';

const AUTOLOCK = [{ value: '0', label: 'Off' }, { value: '5', label: 'After 5 minutes' }, { value: '15', label: 'After 15 minutes' }, { value: '30', label: 'After 30 minutes' }, { value: '60', label: 'After 1 hour' }];

export default function SecuritySection() {
  return html`<div class="stack lg">
    <${DeviceBlock} />
    <${PassphraseBlock} />
    <${DataKeyBlock} />
    <${RecoveryBlock} />
    <${ForgetBlock} />
  </div>`;
}

function DeviceBlock() {
  const app = useApp(); const s = app.session;
  const [mode, setMode] = useState(s.lockMode || 'device');
  const { value: sec, set } = useSettingDraft('security');
  const change = async (m) => {
    if (m === mode) return;
    try { await s.setLockMode(m); setMode(m); app.toast(m === 'session' ? 'This device now asks for the passphrase on every launch' : 'This device stays unlocked'); }
    catch (e) { app.toast(e.message || String(e), { tone: 'error' }); }
  };
  const lockNow = async () => { await s.lock(); };
  return html`<${Block} title="Locking" desc="How this device keeps the vault key.">
    <${FieldGroup} label="On this device" hint=${mode === 'session' ? 'The key lives in memory only: the passphrase is needed on every launch.' : 'The key is kept in this browser as a non-extractable key: FORGE opens without the passphrase. Anyone who can use this unlocked device can open it.'}>
      <${Seg} value=${mode} onValue=${change} label="Lock mode" options=${[{ value: 'device', label: 'Stay unlocked', disabled: app.demo }, { value: 'session', label: 'Ask every launch', disabled: app.demo }]} />
    </${FieldGroup}>
    <div class="set-cols w2"><${Field} label="Auto-lock" hint=${app.demo ? 'Stored, but inactive in demo.' : 'Locks after this long without a tap or key press, including while FORGE is in the background. Applies to every device.'}>
      <${Select} value=${String(sec.autoLockMin || 0)} onValue=${(v) => set({ autoLockMin: Number(v) }, { now: true })} options=${AUTOLOCK} />
    </${Field}></div>
    <div class="set-actions"><${Button} icon="lock" disabled=${app.demo} onClick=${lockNow}>Lock now</${Button}></div>
    <${Reason}>${app.demo ? 'Not available in demo' : 'Locking uploads pending changes first, then removes the key from this device until you enter the passphrase.'}</${Reason}>
  </${Block}>`;
}

function PassphraseBlock() {
  const app = useApp(); const gh = useGitHub();
  const [f, setF] = useState({ old: '', next: '', confirm: '' });
  const [err, setErr] = useState('');
  const job = useJob('security:passphrase');
  const bits = passphraseBits(f.next);
  const set = (k) => (v) => { setF((x) => ({ ...x, [k]: v })); setErr(''); };
  const change = () => {
    if (f.next !== f.confirm) { setErr('The new passphrases do not match.'); return; }
    if (bits < MIN_PASSPHRASE_BITS) { setErr('Choose a stronger passphrase (aim for “Good” or better). It protects everything in the vault.'); return; }
    if (f.next === f.old) { setErr('The new passphrase is the same as the current one.'); return; }
    job.run(async ({ progress }) => {
      progress('Re-wrapping the vault key (600,000 PBKDF2 rounds) and saving the key file…');
      try { await app.session.changePassphrase(f.old, f.next); } catch (e) { throw new Error(/Wrong passphrase|Key check/.test(e.message) ? 'The current passphrase is wrong.' : e.message); }
      setF({ old: '', next: '', confirm: '' });
      return true;
    }, { onDone: () => app.toast('Passphrase changed') });
  };
  return html`<${Block} title="Change passphrase" desc="Re-encrypts the vault key with a new passphrase. Your data and the recovery key stay the same.">
    <div class="set-cols w2"><${Field} label="Current passphrase"><${Input} type="password" value=${f.old} onValue=${set('old')} autocomplete="current-password" /></${Field}></div>
    <div class="set-cols w2">
      <${Field} label="New passphrase"><${Input} type="password" value=${f.next} onValue=${set('next')} autocomplete="new-password" /></${Field}>
      <${Field} label="Confirm new passphrase"><${Input} type="password" value=${f.confirm} onValue=${set('confirm')} autocomplete="new-password" /></${Field}>
    </div>
    ${f.next ? html`<${Strength} bits=${bits} />` : null}
    ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
    <${JobLog} job=${job} doneText="Passphrase changed. Your other devices pick up the new key file the next time they open FORGE online; until then a locked device still accepts the old passphrase. The data key itself is unchanged, so a device that is already unlocked stays unlocked." />
    <div class="set-actions"><${Button} variant="primary" loading=${job.busy} disabled=${!gh.ok || !f.old || !f.next || !f.confirm} onClick=${change}>Change passphrase</${Button}></div>
    <${Reason}>${gh.ok ? '' : gh.reason}</${Reason}>
  </${Block}>`;
}

function DataKeyBlock() {
  const app = useApp(); const gh = useGitHub();
  const names = useSecretNames(gh.ok);
  const [pass, setPass] = useState('');
  const job = useJob('security:datakey');
  const has = Array.isArray(names) ? names.includes('FORGE_DATA_KEY') : null;
  const send = () => job.run(async ({ progress }) => {
    progress('Unlocking the vault key with your passphrase…');
    let raw;
    try { raw = await app.session.dataKeyRaw(pass); } catch { throw new Error('The passphrase is wrong.'); }
    try {
      progress('Sealing it for GitHub and saving FORGE_DATA_KEY…');
      await setSecret(app.session.gh, 'FORGE_DATA_KEY', bytesToB64(raw));
    } finally { raw.fill(0); }
    setPass(''); refreshSecretNames();
    return true;
  }, { onDone: () => app.toast('Server data key saved') });
  return html`<${Block} title="Server data key" desc="The automation decrypts the vault with this key, stored as the FORGE_DATA_KEY Actions secret (sealed for GitHub; it cannot be read back).">
    ${app.demo ? html`<${StatusLine}>Not available in demo</${StatusLine}>` : html`<${StatusLine} tone=${has ? 'good' : has === false ? 'bad' : null}>${has ? 'FORGE_DATA_KEY is set' : has === false ? 'FORGE_DATA_KEY is missing: automation cannot run' : 'Checking the vault secrets…'}</${StatusLine}>`}
    <p class="small dim">Send it again if automation runs fail with a missing or wrong data key, or if setup could not save it. Your passphrase unlocks the key on this device; only the sealed key goes to GitHub.</p>
    <div class="set-cols w2"><${Field} label="Passphrase"><${Input} type="password" value=${pass} onValue=${setPass} autocomplete="current-password" /></${Field}></div>
    <${JobLog} job=${job} doneText="FORGE_DATA_KEY saved. The next automation run uses it." />
    <div class="set-actions"><${Button} icon="key" loading=${job.busy} disabled=${!gh.ok || !pass} onClick=${send}>Send data key to GitHub</${Button}></div>
    <${Reason}>${gh.ok ? '' : gh.reason}</${Reason}>
  </${Block}>`;
}

function ForgetBlock() {
  const app = useApp();
  const forget = async () => {
    const ok = await app.confirm({
      title: 'Forget this device?',
      message: 'Removes the encrypted local copy, the saved GitHub token and the API key from this device. Changes not yet uploaded are uploaded first when possible. The vault on GitHub is untouched; you can connect again with your passphrase.',
      confirmLabel: 'Forget this device', danger: true,
    });
    if (ok) await app.session.forgetDevice();
  };
  return html`<${Block} title="Forget this device" desc="For a device you are handing over, or to set this one up again.">
    <div class="set-actions"><${Button} class="danger" icon="logOut" disabled=${app.demo} onClick=${forget}>Forget this device</${Button}></div>
    <${Reason}>${app.demo ? 'Not available in demo' : ''}</${Reason}>
  </${Block}>`;
}

function RecoveryBlock() {
  const app = useApp(); const gh = useGitHub();
  const [pass, setPass] = useState(''); const [key, setKey] = useState(''); const [err, setErr] = useState('');
  const job = useJob('security:recovery');
  const create = () => job.run(async ({ progress }) => {
    setErr('');
    progress('Checking the passphrase and writing a new key file…');
    try { const k = await app.session.newRecoveryKey(pass); setKey(k); setPass(''); return { ok: true }; }
    catch (e) { setErr(/Wrong passphrase/.test(e.message) ? 'That passphrase is not correct.' : (e.message || String(e))); throw e; }
  });
  return html`<${Block} title="Recovery key" desc="The only way back in if you forget the passphrase.">
    <p class="small dim">It was shown once when the vault was created. FORGE cannot show it again. Keep it in your password manager or printed, away from this device. Anyone with the recovery key and access to your vault repository can decrypt your data.</p>
    ${key ? html`<div class="stack sm"><${Notice} tone="warn">Save this new recovery key now — it is shown only once. The previous recovery key no longer opens the current key file.</${Notice}>
        <${CopyBox} value=${key} label="Copy recovery key" />
        <div class="set-actions"><${Button} onClick=${() => setKey('')}>I saved it</${Button}></div></div>`
      : html`<div class="stack sm"><div class="xs muted">Lost it? Create a new one with your passphrase.</div>
        <div class="set-cols w2"><${Field} label="Your passphrase"><${Input} type="password" value=${pass} onValue=${(v) => { setPass(v); setErr(''); }} autocomplete="current-password" /></${Field}></div>
        ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
        <div class="set-actions"><${Button} icon="key" loading=${job.busy} disabled=${!pass || app.demo || !gh.ok} onClick=${create}>Create a new recovery key</${Button}></div>
        <${Reason}>${app.demo ? 'Not available in demo' : !gh.ok ? gh.reason : 'Older copies of the key file stay in the vault’s git history; a new recovery key protects the current one.'}</${Reason}></div>`}
  </${Block}>`;
}
