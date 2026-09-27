// First-run setup (connect → create/unlock → recovery key → import → automation → profile) and the lock screen.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { useApp } from '../ctx.js';
import { Icon, Button, Field, Input, NumberInput, Notice, Segmented, FileButton, Spinner, ToggleRow, CopyBox } from '../kit.js';
import { passphraseBits } from '../../core/crypto.js';
import { bytesToB64, deviceTz, todayStr, nowIso } from '../../core/util.js';
import { tokenUrl, setSecret, installAutomation, dispatch, waitForStatus, deviceLabel, NEW_WORKFLOW_WAIT_MS } from '../../app/integrations.js';

function defaultOwner() {
  const h = location.hostname; return h.endsWith('.github.io') ? h.slice(0, -'.github.io'.length) : '';
}
function Strength({ bits }) {
  const lvl = bits >= 70 ? 4 : bits >= 55 ? 3 : bits >= 40 ? 2 : bits > 0 ? 1 : 0;
  const label = ['', 'Weak', 'Fair', 'Good', 'Strong'][lvl];
  return html`<div class="stack xs"><div class=${'strength s' + lvl}><i></i><i></i><i></i><i></i></div><span class="xs muted">${label ? label + (lvl < 3 ? ' — use 5+ random words or 16+ random characters' : '') : 'Use 5+ random words or 16+ random characters'}</span></div>`;
}
// Random passphrase (Crockford base32, 4 × 5 characters ≈ 100 bits), for a password manager.
export function suggestPassphrase() {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; const b = new Uint8Array(20); crypto.getRandomValues(b);
  return [0, 5, 10, 15].map((i) => [...b.slice(i, i + 5)].map((x) => A[x & 31]).join('')).join('-');
}
function Steps({ n, of = 6 }) { return html`<div class="steps">${Array.from({ length: of }, (_, i) => html`<i class=${i < n ? 'on' : ''}></i>`)}</div>`; }

export function SetupFlow() {
  const app = useApp(); const s = app.session;
  const [step, setStep] = useState('welcome');
  const [form, setForm] = useState({ owner: defaultOwner(), repo: 'forge-vault', token: '', pass: '', pass2: '', remember: 'device', recovery: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [recovery, setRecovery] = useState(''); const [secretWarn, setSecretWarn] = useState('');
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const act = (fn) => async () => { setErr(''); setBusy(true); try { await fn(); } catch (e) { console.warn(e); setErr(e.message || String(e)); } finally { setBusy(false); } };

  useEffect(() => { app.setHold(true); return () => {}; }, []);
  const finish = () => { app.setHold(false); app.nav('/today'); };

  const connect = act(async () => {
    const r = await s.connect({ owner: form.owner, repo: form.repo, token: form.token });
    setStep(r.initialized ? 'unlock' : 'create');
  });
  const create = act(async () => {
    if (form.pass !== form.pass2) throw new Error('Passphrases do not match.');
    if (passphraseBits(form.pass) < 55) throw new Error('Choose a stronger passphrase (aim for "Good" or better). It protects everything in the vault.');
    const { recoveryKey, dekRaw } = await s.createVault({ passphrase: form.pass, lock: form.remember });
    try { await setSecret(s.gh, 'FORGE_DATA_KEY', bytesToB64(dekRaw)); }
    catch (e) { setSecretWarn('Could not save the server key to GitHub (' + (e.message || e.status) + '). Automation will stay off until you add it from Settings → Automation.'); }
    finally { dekRaw.fill(0); }
    setRecovery(recoveryKey); setForm((f) => ({ ...f, pass: '', pass2: '' }));
    setStep('recovery');
  });
  const unlock = act(async () => {
    await s.unlockPending(form.recovery ? { recoveryKey: form.recovery, lock: form.remember } : { passphrase: form.pass, lock: form.remember });
    setForm((f) => ({ ...f, pass: '', recovery: '' }));
    finish();
  });

  if (step === 'welcome') return html`<div class="setup">
    <div class="brand" style="padding-left:0"><span class="brand-mark"></span>FORGE</div>
    <h1>Your private performance system</h1>
    <p class="lead">Schedule, training, nutrition, recovery, bloodwork and finances in one place. Everything is encrypted on this device before it reaches your private GitHub vault. Only your passphrase can open it.</p>
    <div class="stack">
      <${Button} variant="primary" size="lg" block icon="lock" onClick=${() => setStep('connect')}>Set up or connect my vault</${Button}>
      <${Button} size="lg" block icon="sparkle" onClick=${() => { location.href = location.pathname + '?demo=1#/today'; }}>Explore with demo data</${Button}>
    </div>
    <div class="notice" style="margin-top:22px"><${Icon} name="shield" /><div>Data is encrypted with AES-256 before upload. GitHub only ever stores ciphertext. Losing both your passphrase and your recovery key means the data cannot be recovered by anyone.</div></div>
  </div>`;

  if (step === 'connect') return html`<div class="setup"><${Steps} n=${1} />
    <h1>Connect your vault</h1>
    <p class="lead">Use your <b>private</b> repository and a fine-grained token that can only reach it.</p>
    <div class="stack">
      <div class="grid two"><${Field} label="Owner"><${Input} value=${form.owner} onValue=${set('owner')} autocapitalize="off" spellcheck="false" /></${Field}>
        <${Field} label="Repository"><${Input} value=${form.repo} onValue=${set('repo')} autocapitalize="off" spellcheck="false" /></${Field}></div>
      <${Field} label="Access token" hint="Stored encrypted on this device only.">
        <${Input} type="password" mono value=${form.token} onValue=${set('token')} placeholder="github_pat_…" autocomplete="off" spellcheck="false" /></${Field}>
      <div class="card inset stack sm small">
        <div class="strong">Create the token (about a minute)</div>
        <ol style="padding-left:18px" class="dim stack xs">
          <li>Open the pre-filled token page below (sign in as <b>${form.owner || 'the vault owner'}</b>).</li>
          <li>Repository access → <b>Only select repositories</b> → <b>${form.repo}</b>.</li>
          <li>Permissions are pre-filled: Contents, Actions, Secrets and Workflows = Read and write.</li>
          <li>Generate, copy, paste above. Use one token per device so you can revoke a lost phone.</li>
        </ol>
        <a class="btn sm" style="align-self:flex-start" href=${tokenUrl(form.owner, deviceLabel())} target="_blank" rel="noopener"><${Icon} name="external" />Open token page</a>
      </div>
      ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
      <div class="row"><${Button} variant="ghost" onClick=${() => setStep('welcome')}>Back</${Button}><span class="grow"></span>
        <${Button} variant="primary" loading=${busy} disabled=${!form.token || !form.owner || !form.repo} onClick=${connect}>Connect</${Button}></div>
    </div></div>`;

  if (step === 'create') return html`<div class="setup"><${Steps} n=${2} />
    <h1>Create your passphrase</h1>
    <p class="lead">This passphrase encrypts the vault key. It never leaves this device and cannot be reset by anyone.</p>
    <div class="stack">
      <${Field} label="Passphrase"><${Input} type=${form.shown ? 'text' : 'password'} mono=${!!form.shown} value=${form.pass} onValue=${set('pass')} autocomplete="new-password" /></${Field}>
      <div class="row between wrap" style="gap:8px"><${Strength} bits=${passphraseBits(form.pass)} />
        <${Button} size="sm" variant="ghost" icon="key" onClick=${() => { const p = suggestPassphrase(); setForm((f) => ({ ...f, pass: p, pass2: p, shown: true })); }}>Suggest one</${Button}></div>
      ${form.shown ? html`<div class="xs muted">Save this passphrase in your password manager (e.g. iCloud Keychain) before continuing — nobody can reset it.</div>` : null}
      <${Field} label="Confirm passphrase"><${Input} type="password" value=${form.pass2} onValue=${set('pass2')} autocomplete="new-password" /></${Field}>
      <${Field} label="On this device"><${Segmented} block value=${form.remember} onValue=${set('remember')} options=${[{ value: 'device', label: 'Stay unlocked' }, { value: 'session', label: 'Ask every time' }]} /></${Field}>
      ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
      <${Button} variant="primary" size="lg" block loading=${busy} disabled=${!form.pass || !form.pass2} onClick=${create}>Create encrypted vault</${Button}>
      ${busy ? html`<div class="xs muted center">Deriving keys (600,000 PBKDF2 rounds) and writing the keyring…</div>` : null}
    </div></div>`;

  if (step === 'unlock') return html`<div class="setup"><${Steps} n=${2} />
    <h1>Unlock your vault</h1>
    <p class="lead">This vault already exists. Enter your passphrase to add this device.</p>
    <div class="stack">
      ${form.recovery !== null && form.useRecovery
        ? html`<${Field} label="Recovery key"><${Input} mono value=${form.recovery} onValue=${set('recovery')} autocapitalize="characters" spellcheck="false" /></${Field}>`
        : html`<${Field} label="Passphrase"><${Input} type="password" value=${form.pass} onValue=${set('pass')} autocomplete="current-password" /></${Field}>`}
      <${Field} label="On this device"><${Segmented} block value=${form.remember} onValue=${set('remember')} options=${[{ value: 'device', label: 'Stay unlocked' }, { value: 'session', label: 'Ask every time' }]} /></${Field}>
      ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
      <${Button} variant="primary" size="lg" block loading=${busy} onClick=${unlock}>Unlock</${Button}>
      <button class="btn ghost sm" onClick=${() => setForm((f) => ({ ...f, useRecovery: !f.useRecovery, recovery: '', pass: '' }))}>${form.useRecovery ? 'Use passphrase instead' : 'Use recovery key instead'}</button>
    </div></div>`;

  if (step === 'recovery') return html`<${RecoveryStep} recovery=${recovery} warn=${secretWarn} onDone=${() => setStep('import')} />`;
  if (step === 'import') return html`<${ImportStep} onDone=${() => setStep('automation')} />`;
  if (step === 'automation') return html`<${AutomationStep} onDone=${() => setStep('profile')} />`;
  if (step === 'profile') return html`<${ProfileStep} onDone=${finish} />`;
  return null;
}

function RecoveryStep({ recovery, warn, onDone }) {
  const [typed, setTyped] = useState('');
  // The key exists only on this screen: a reload or a closed tab loses it for good (after a reload the
  // app opens unlocked and cannot show it again), so ask before leaving until it is confirmed.
  useEffect(() => {
    const hold = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', hold);
    return () => window.removeEventListener('beforeunload', hold);
  }, []);
  const last = recovery.split('-').pop();
  const download = () => {
    const text = `FORGE vault recovery key\nCreated: ${new Date().toISOString()}\n\n${recovery}\n\nKeep this offline (password manager or printed). Anyone with this key AND access to your vault repository can decrypt your data.\n`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'forge-recovery-key.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return html`<div class="setup"><${Steps} n=${3} />
    <h1>Save your recovery key</h1>
    <p class="lead">If you forget your passphrase, this key is the only way back in. Store it in a password manager. It is shown once.</p>
    <div class="stack">
      <div class="recovery-key">${recovery}</div>
      <div class="row"><${CopyBox} value=${recovery} label="Copy key" /></div>
      <${Button} icon="download" onClick=${download}>Download as text file</${Button}>
      ${warn ? html`<${Notice} tone="warn">${warn}</${Notice}>` : null}
      <${Field} label=${'Type the last group (' + last.length + ' characters) to confirm you saved it'}><${Input} mono value=${typed} onValue=${setTyped} autocapitalize="characters" /></${Field}>
      <${Button} variant="primary" size="lg" block disabled=${typed.trim().toUpperCase() !== last} onClick=${onDone}>I saved it — continue</${Button}>
    </div></div>`;
}

function ImportStep({ onDone }) {
  const app = useApp();
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  let local = null; try { local = JSON.parse(localStorage.getItem('forge_data_v2') || 'null'); } catch { local = null; }
  const run = (obj) => { setErr(''); try { const r = app.session.importV2(obj); setMsg(`Imported ${r.standards} habits, ${r.checks} daily check-ins, ${r.snapshots} finance months, ${r.savedQuotes} saved quotes and ${r.journal} notes.`); } catch (e) { setErr(e.message); } };
  return html`<div class="setup"><${Steps} n=${4} />
    <h1>Bring over your old data</h1>
    <p class="lead">Your FORGE v2 history (habits, check-ins, finance months, saved quotes, notes) can be imported now or later from Settings.</p>
    <div class="stack">
      ${local ? html`<${Button} block icon="history" onClick=${() => run(local)}>Import v2 data found on this device</${Button}>` : null}
      <${FileButton} block icon="upload" accept=".json,application/json" onFiles=${async ([f]) => { try { run(JSON.parse(await f.text())); } catch { setErr('Could not read that file.'); } }}>Choose forge-data.json backup</${FileButton}>
      <div class="xs muted">In the old app: Settings (gear) → Export backup. That downloads forge-data.json.</div>
      ${msg ? html`<${Notice} tone="good">${msg}</${Notice}>` : null}
      ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
      <${Button} variant="primary" size="lg" block onClick=${onDone}>${msg ? 'Continue' : 'Skip for now'}</${Button}>
    </div></div>`;
}

function AutomationStep({ onDone }) {
  const app = useApp(); const s = app.session;
  const [state, setState] = useState('idle'); const [log, setLog] = useState([]); const [err, setErr] = useState('');
  const run = async () => {
    setErr(''); setState('busy'); setLog([]);
    try {
      await installAutomation(s, (m) => setLog((l) => [...l, m]));
      setLog((l) => [...l, 'Starting a test run on GitHub Actions']);
      const since = await dispatch(s, 'ping', '', { waitForWorkflowMs: NEW_WORKFLOW_WAIT_MS });
      await waitForStatus(s, 'run', since, { onTick: (t) => setLog((l) => [...l.filter((x) => !x.startsWith('Waiting')), `Waiting for the run… ${t}s`]) });
      setLog((l) => [...l, 'Automation is live']); setState('done');
    } catch (e) { setErr(e.message || String(e)); setState('idle'); }
  };
  return html`<div class="setup"><${Steps} n=${5} />
    <h1>Turn on server automation</h1>
    <p class="lead">A workflow in your private vault syncs WHOOP, Google Calendar and notifications every hour, even when the app is closed. It runs on GitHub Actions (free tier: about 720 of 2,000 monthly minutes).</p>
    <div class="stack">
      ${log.length ? html`<div class="card inset stack xs small">${log.map((l, i) => html`<div class="row">${i === log.length - 1 && state === 'busy' ? html`<${Spinner} />` : html`<${Icon} name="check" size=${16} class="ink-good" />`}<span>${l}</span></div>`)}</div>` : null}
      ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
      ${state !== 'done' ? html`<${Button} variant="primary" size="lg" block loading=${state === 'busy'} onClick=${run}>Install and test</${Button}>` : null}
      <${Button} size="lg" block variant=${state === 'done' ? 'primary' : 'ghost'} onClick=${onDone}>${state === 'done' ? 'Continue' : 'Skip — do it later in Settings'}</${Button}>
    </div></div>`;
}

function ProfileStep({ onDone }) {
  const app = useApp(); const store = app.store;
  const cur = store.setting('profile');
  const [p, setP] = useState({ name: cur.name || '', heightFt: cur.heightIn ? Math.floor(cur.heightIn / 12) : null, heightIn: cur.heightIn ? cur.heightIn % 12 : null, weight: null, goalLow: cur.goalWeightLow, goalHigh: cur.goalWeightHigh, birthYear: cur.birthYear, timezone: cur.timezone || deviceTz() });
  const set = (k) => (v) => setP((x) => ({ ...x, [k]: v }));
  const save = () => {
    const heightIn = p.heightFt != null ? p.heightFt * 12 + (p.heightIn || 0) : null;
    store.updateSetting('profile', { name: p.name, heightIn, goalWeightLow: p.goalLow, goalWeightHigh: p.goalHigh, birthYear: p.birthYear, timezone: p.timezone });
    if (p.weight) store.create('body', { date: todayStr(), at: nowIso(), weightLb: p.weight, method: 'scale' });
    onDone();
  };
  return html`<div class="setup"><${Steps} n=${6} />
    <h1>Baseline</h1>
    <p class="lead">These drive calorie and protein targets until enough weigh-ins and meals exist to compute your real expenditure.</p>
    <div class="stack">
      <${Field} label="Name (optional)"><${Input} value=${p.name} onValue=${set('name')} /></${Field}>
      <div class="grid three"><${Field} label="Height (ft)"><${NumberInput} value=${p.heightFt} onValue=${set('heightFt')} /></${Field}>
        <${Field} label="(in)"><${NumberInput} value=${p.heightIn} onValue=${set('heightIn')} /></${Field}>
        <${Field} label="Birth year"><${NumberInput} value=${p.birthYear} onValue=${set('birthYear')} /></${Field}></div>
      <${Field} label="Current weight"><${NumberInput} value=${p.weight} onValue=${set('weight')} suffix="lb" /></${Field}>
      <div class="grid two"><${Field} label="Goal weight — low"><${NumberInput} value=${p.goalLow} onValue=${set('goalLow')} suffix="lb" /></${Field}>
        <${Field} label="Goal weight — high"><${NumberInput} value=${p.goalHigh} onValue=${set('goalHigh')} suffix="lb" /></${Field}></div>
      <${Field} label="Time zone" hint="Used for every local-time decision (sleep dates, reminders, notifications)."><${Input} value=${p.timezone} onValue=${set('timezone')} /></${Field}>
      <${Button} variant="primary" size="lg" block onClick=${save}>Finish setup</${Button}>
      <${Button} variant="ghost" block onClick=${onDone}>Skip</${Button}>
    </div></div>`;
}

export function LockScreen() {
  const app = useApp(); const s = app.session;
  const [pass, setPass] = useState(''); const [rk, setRk] = useState(''); const [useRk, setUseRk] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = async () => {
    setErr(''); setBusy(true);
    try { await s.unlock(useRk ? { recoveryKey: rk } : { passphrase: pass }); } catch (e) { setErr(e.message); } finally { setBusy(false); setPass(''); }
  };
  return html`<div class="lockscreen"><form class="box stack" onSubmit=${(e) => { e.preventDefault(); go(); }}>
    <div class="brand" style="padding-left:0"><span class="brand-mark"></span>FORGE</div>
    <h1 style="font-size:24px">Vault locked</h1>
    <div class="muted small">${s.vault ? s.vault.owner + '/' + s.vault.repo : ''}</div>
    ${useRk
      ? html`<${Field} label="Recovery key"><${Input} mono value=${rk} onValue=${setRk} autocapitalize="characters" /></${Field}>`
      : html`<${Field} label="Passphrase"><${Input} type="password" value=${pass} onValue=${setPass} autocomplete="current-password" autofocus /></${Field}>`}
    ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
    <${Button} variant="primary" size="lg" block loading=${busy} type="submit">Unlock</${Button}>
    <div class="row between"><button type="button" class="btn ghost sm" onClick=${() => setUseRk(!useRk)}>${useRk ? 'Use passphrase' : 'Use recovery key'}</button>
      <button type="button" class="btn ghost sm danger" onClick=${async () => { if (await app.confirm({ title: 'Forget this device?', message: 'Removes the encrypted local copy and saved credentials from this device. Your vault on GitHub is untouched.', confirmLabel: 'Forget device', danger: true })) s.forgetDevice(); }}>Forget device</button></div>
  </form></div>`;
}
