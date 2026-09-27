// Settings → Integrations: WHOOP (OAuth via the vault automation), Google Calendar (service account),
// Web Push devices, Apple Health import. Server-side work runs in the vault's GitHub Actions workflow;
// long operations are jobs (useJob) so their progress survives navigation.
import { html, useState, useEffect } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useNow } from '../../ctx.js';
import { Button, Field, Input, Textarea, Notice, CopyBox, ToggleRow, KV, Disclosure, FileButton, IconButton, Pill, Icon, Empty } from '../../kit.js';
import {
  Block, StatusLine, Steps, Step, SecretInput, ExtLink, Reason, NeedsAutomation, JobLog, Ago, useJob, useGitHub, useAutomationInstalled,
  useSettingDraft, useSecretNames, refreshSecretNames, waitForRun, FieldGroup, noteSaved,
} from '../../parts/settings-ui.js';
import { whoopState, calendarState, pushState, whoopRunText, calendarRunText, pushRunText, relTime } from '../../parts/settings-status.js';
import { normalizeCalendarId, calendarIdIssue } from '../../parts/settings-util.js';
import {
  oauthRedirectUri, WHOOP_SCOPES, saveWhoopCredentials, startWhoopAuth, completeWhoopAuth, dispatch, saveGoogleServiceAccount,
  pushSupported, isStandalone, subscribePush, unsubscribePush,
} from '../../../app/integrations.js';
import { fmtDate, relDay, hashId } from '../../../core/util.js';

export default function IntegrationsSection() {
  return html`<div class="stack lg">
    <${WhoopBlock} />
    <${CalendarBlock} />
    <${PushBlock} />
    <${HealthBlock} />
  </div>`;
}

const latestDate = (list) => { let m = null; for (const r of list) if (typeof r.date === 'string' && (!m || r.date > m)) m = r.date; return m; };

/* ================================================================ WHOOP */
function WhoopBlock() {
  const app = useApp(); useVersion(['settings', 'status', 'whoopSleep']);
  const now = useNow(30000); const today = app.today();
  const gh = useGitHub(); const installed = useAutomationInstalled();
  const whoop = app.store.setting('integrations').whoop;
  const status = app.store.get('status', 'whoop');
  const st = whoopState(whoop, status, now);
  const job = useJob('whoop:run');
  const saveJob = useJob('whoop:save');
  const secretNames = useSecretNames(gh.ok);
  const [clientId, setClientId] = useState(whoop.clientId || '');
  const [secret, setSecret] = useState('');
  const connected = ['ok', 'backfill', 'error', 'pending', 'reauth'].includes(st.key) && !!whoop.connectedAt;
  const lastData = latestDate(app.store.all('whoopSleep'));
  const demoData = app.demo && connected;

  // Returning from WHOOP's consent page: hand the code to the automation and wait for the result.
  useEffect(() => {
    const r = app.takeOAuth();
    if (!r || (r.provider && r.provider !== 'whoop')) return;
    job.run(async ({ log, progress }) => {
      if (r.error) throw new Error(r.error);
      log('Authorization received from WHOOP');
      progress('Sending the one-time code to your vault (encrypted)…');
      const since = await completeWhoopAuth(app.session, r);
      log('Code sent; the server exchanges it and starts importing history');
      const res = await waitForRun(app.session, 'whoop', since, { progress, timeoutMs: 11 * 60000 });
      return res;
    });
  }, []);

  const runTask = (task, label) => job.run(async ({ log, progress }) => {
    progress(`Starting ${label} on GitHub Actions…`);
    const since = await dispatch(app.session, task);
    log(`Started ${label}`);
    return waitForRun(app.session, 'whoop', since, { progress, timeoutMs: (task === 'whoop' ? 6 : 11) * 60000 });
  });
  const saveCreds = () => saveJob.run(async ({ progress }) => {
    progress('Saving to your vault’s Actions secrets…');
    await saveWhoopCredentials(app.session, clientId, secret);
    setSecret(''); refreshSecretNames(); noteSaved();
    return true;
  }, { onDone: () => app.toast('WHOOP credentials saved') });
  const connect = () => { try { startWhoopAuth(app.session); } catch (e) { app.toast(e.message, { tone: 'error' }); } };

  const secretSet = Array.isArray(secretNames) ? secretNames.includes('WHOOP_CLIENT_SECRET') : null;
  const credsSaved = !!whoop.clientId && secretSet !== false;
  const canRun = gh.ok && !!installed;
  const result = job.result;
  const resultText = (res) => {
    if (!res) return null;
    if (res.pending) return 'The run is still going (history imports can take several minutes). This page updates when it reports back.';
    const s = res.status;
    if (s && s.lastError) return null;
    return `Done. ${whoopRunText(s && s.detail) || 'No new data'}.${s && s.detail && s.detail.backfill === 'in-progress' ? ' Older history continues importing in the hourly runs.' : ''}`;
  };
  const failed = result && result.status && result.status.lastError;

  return html`<${Block} title="WHOOP" desc="Recovery, HRV, sleep stages, strain and workouts. The hourly server run pulls new data; nothing is fetched from this device.">
    ${demoData ? html`<${StatusLine} tone="good">Demo data (synthetic WHOOP history)</${StatusLine}>` : html`<${StatusLine} tone=${st.tone}>${st.text}</${StatusLine}>`}
    ${!app.demo && st.key === 'reauth' ? html`<${Notice} tone="bad">WHOOP no longer accepts the saved login (the refresh token expired or was revoked). Syncing is paused until you connect again.</${Notice}>` : null}
    ${connected && !app.demo ? html`<${KV} items=${[
      ['Last successful sync', status && status.lastOkAt ? html`<${Ago} at=${status.lastOkAt} />` : 'never'],
      ['Latest sleep in FORGE', lastData ? relDay(lastData, today) : 'none yet'],
      ['History import', status && status.detail && status.detail.backfill === 'complete' ? 'Complete' : status && status.detail && status.detail.backfill === 'in-progress' ? 'In progress (continues hourly)' : '—'],
      ['Last run', status && status.detail ? whoopRunText(status.detail) || '—' : '—'],
    ]} />` : null}
    ${demoData && lastData ? html`<div class="xs muted">Latest sleep in the demo: ${relDay(lastData, today)}.</div>` : null}
    <${JobLog} job=${job} doneText=${!failed ? resultText : null} />
    ${failed ? html`<${Notice} tone="bad">The server reported: ${result.status.lastError}</${Notice}>` : null}
    ${connected ? html`<div class="set-actions">
        <${Button} icon="sync" loading=${job.busy} disabled=${!canRun || app.demo} onClick=${() => runTask('whoop', 'a WHOOP sync')}>Sync now</${Button}>
        ${st.key === 'reauth' || st.key === 'error' ? html`<${Button} variant="primary" icon="link" disabled=${!canRun || !whoop.clientId} onClick=${connect}>Connect again</${Button}>` : null}
      </div>
      <${Reason}>${app.demo ? 'Not available in demo' : !gh.ok ? gh.reason : !installed ? 'Needs the server automation (Settings → Automation)' : ''}</${Reason}>` : null}
    ${!app.demo && !installed ? html`<${NeedsAutomation} what="WHOOP sync" />` : null}
    <${Disclosure} summary=${connected ? 'Connection setup and advanced' : 'Set up the connection (about 5 minutes)'} open=${!connected}>
      <div class="stack">
        <${Steps}>
          <${Step} title="Create a WHOOP developer app">
            <span>Sign in with your WHOOP account, create a team if asked, then create an app. Select every read scope and offline access:</span>
            <div class="code-box set-code">${WHOOP_SCOPES}</div>
            <div><${ExtLink} href="https://developer-dashboard.whoop.com">WHOOP developer dashboard</${ExtLink}></div>
          </${Step}>
          <${Step} title="Add this redirect URL to the app">
            <${CopyBox} value=${oauthRedirectUri()} label="Copy URL" />
          </${Step}>
          <${Step} title="Paste the app’s client ID and secret" done=${credsSaved && !!whoop.clientId}>
            <${Field} label="Client ID"><${Input} mono value=${clientId} onValue=${setClientId} placeholder="Client ID" autocomplete="off" spellcheck="false" autocapitalize="off" /></${Field}>
            <${FieldGroup} label="Client secret" hint=${secretSet ? 'A secret is already saved; paste a new one only to replace it.' : 'Stored only as an encrypted GitHub Actions secret in your vault.'}>
              <${SecretInput} value=${secret} onValue=${setSecret} placeholder=${secretSet ? '•••••••• (saved)' : 'Client secret'} label="WHOOP client secret" />
            </${FieldGroup}>
            <div class="set-actions"><${Button} variant=${credsSaved ? undefined : 'primary'} icon="save" loading=${saveJob.busy} disabled=${!gh.ok || !clientId.trim() || !secret.trim()} onClick=${saveCreds}>Save to vault secrets</${Button}></div>
            <${Reason}>${gh.ok ? '' : gh.reason}</${Reason}>
            <${JobLog} job=${saveJob} />
          </${Step}>
          <${Step} title="Connect" done=${connected && st.key !== 'reauth'}>
            <span>You sign in at WHOOP and land back on this page. FORGE then passes the one-time code (encrypted) to your vault automation, which stores the tokens and imports your history.</span>
            ${isStandalone() && /iPhone|iPad|iPod/.test(navigator.userAgent || '') ? html`<${Notice} tone="warn">In the iPhone Home Screen app, WHOOP sign-in opens in Safari, which cannot hand the result back to this app. Connect from FORGE on your computer instead — the connection lives in your vault, so it covers every device.</${Notice}>` : null}
            <div class="set-actions"><${Button} variant="primary" icon="link" disabled=${!canRun || !whoop.clientId || app.demo} onClick=${connect}>${connected ? 'Reconnect WHOOP' : 'Connect WHOOP'}</${Button}></div>
            <${Reason}>${app.demo ? 'Not available in demo' : !gh.ok ? gh.reason : !installed ? 'Install the server automation first (Settings → Automation)' : !whoop.clientId ? 'Save the client ID and secret first' : ''}</${Reason}>
          </${Step}>
        </${Steps}>
        ${connected && !app.demo ? html`<div class="stack sm"><div class="divider"></div>
          <div class="row between wrap" style="gap:8px"><span class="xs muted">Missing days? Re-import every WHOOP record since 2015 (resumable, runs over several hourly jobs).</span>
            <${Button} size="sm" disabled=${!canRun || job.busy} onClick=${() => runTask('whoop-backfill', 'a full history re-import')}>Re-import history</${Button}></div></div>` : null}
      </div>
    </${Disclosure}>
  </${Block}>`;
}

/* ====================================================== Google Calendar */
function CalendarBlock() {
  const app = useApp(); useVersion(['status']);
  const now = useNow(30000);
  const gh = useGitHub(); const installed = useAutomationInstalled();
  const { value: integ, set } = useSettingDraft('integrations');
  const gcal = integ.gcal;
  const status = app.store.get('status', 'calendar');
  const st = calendarState(gcal, status, now);
  const saJob = useJob('gcal:save');
  const job = useJob('gcal:run');
  const secretNames = useSecretNames(gh.ok);
  const [json, setJson] = useState('');
  const [newCal, setNewCal] = useState('');
  const [forgeId, setForgeId] = useState(gcal.forgeCalendarId || '');
  // Follow changes from other devices; the local text wins while it normalizes to the same id.
  useEffect(() => { if (normalizeCalendarId(forgeId) !== (gcal.forgeCalendarId || '')) setForgeId(gcal.forgeCalendarId || ''); }, [gcal.forgeCalendarId]);
  const saEmail = gcal.saEmail || (status && status.detail && status.detail.serviceAccount) || '';
  const keySet = Array.isArray(secretNames) ? secretNames.includes('GOOGLE_SA_KEY') : null;
  const reads = gcal.readCalendars || [];
  const configured = !!gcal.saEmail;
  const setGcal = (patch, opts) => set({ gcal: { ...gcal, ...patch } }, opts);

  const saveKey = () => saJob.run(async ({ progress }) => {
    progress('Saving the key to your vault’s Actions secrets…');
    const email = await saveGoogleServiceAccount(app.session, json);
    setJson(''); refreshSecretNames(); noteSaved();
    return email;
  }, { onDone: () => app.toast('Service-account key saved') });
  const addCal = () => {
    const id = normalizeCalendarId(newCal); if (!id) return;
    if (reads.includes(id)) { app.toast('Already in the list'); return; }
    setGcal({ readCalendars: [...reads, id] }, { now: true }); setNewCal('');
  };
  const removeCal = (id) => {
    const before = reads;
    setGcal({ readCalendars: before.filter((x) => x !== id) }, { now: true });
    app.toast('Calendar removed', { action: { label: 'Undo', onClick: () => { const cur = app.store.setting('integrations').gcal; app.store.updateSetting('integrations', { gcal: { ...cur, readCalendars: before } }); } } });
  };
  const sync = () => job.run(async ({ log, progress }) => {
    progress('Starting a calendar sync on GitHub Actions…');
    const since = await dispatch(app.session, 'calendar');
    log('Started a calendar sync');
    return waitForRun(app.session, 'calendar', since, { progress, timeoutMs: 6 * 60000 });
  });
  const detail = status && status.detail;
  const errors = detail && detail.errors ? Object.entries(detail.errors) : [];
  const notes = detail && Array.isArray(detail.notes) ? detail.notes : [];
  const canRun = gh.ok && !!installed;

  return html`<${Block} title="Google Calendar" desc="FORGE reads your calendars for meeting load and free time, and writes plan blocks and reminders to a separate FORGE calendar.">
    ${app.demo && configured ? html`<${StatusLine} tone="good">Demo data (synthetic calendar events)</${StatusLine}>` : html`<${StatusLine} tone=${st.tone}>${st.text}</${StatusLine}>`}
    ${detail && !app.demo && calendarRunText(detail) ? html`<div class="xs muted">Last run: ${calendarRunText(detail)}${status.lastRunAt ? ' · ' + relTime(status.lastRunAt, now) : ''}</div>` : null}
    ${errors.length ? html`<${Notice} tone="bad"><div class="stack xs">${errors.map(([cal, msg]) => html`<div><b class="set-code">${cal}</b>: ${String(msg)}</div>`)}
      <div class="xs">Check that each calendar is shared with ${saEmail || 'the service account'}.</div></div></${Notice}>` : null}
    ${detail && detail.writeError ? html`<${Notice} tone="bad">${detail.writeError}</${Notice}>` : null}
    ${notes.length && !app.demo ? html`<${Notice} tone="warn"><div class="stack xs">${notes.map((n) => html`<div>${n}</div>`)}</div></${Notice}>` : null}
    <${JobLog} job=${job} doneText=${(r) => (r.pending ? 'The sync is still running; results appear here when it reports back.' : r.status && r.status.lastError ? `The server reported: ${r.status.lastError}` : `Done. ${calendarRunText(r.status && r.status.detail) || 'No changes'}.`)} />

    ${configured ? html`<div class="stack">
      <${FieldGroup} label="Calendars FORGE reads" hint="Your calendar’s ID is usually your Google account email. Share each one with the service account: “See all event details”.">
        ${reads.length ? html`<div class="card flush"><div class="list">${reads.map((id) => html`<div class="list-row" key=${id} style="min-height:44px;padding:6px 8px 6px 14px">
            <div class="grow set-code">${id}${calendarIdIssue(id) ? html`<div class="xs ink-warn" style="font-family:var(--font)">${calendarIdIssue(id)}</div>` : null}</div>
            <${IconButton} icon="x" label=${'Remove ' + id} sm onClick=${() => removeCal(id)} /></div>`)}</div></div>`
          : html`<div class="xs muted">None yet: meetings will not count toward your load.</div>`}
        <form class="set-add-row" onSubmit=${(e) => { e.preventDefault(); addCal(); }}>
          <input class="input mono" value=${newCal} placeholder="you@gmail.com" aria-label="Calendar ID" autocapitalize="off" spellcheck="false" onInput=${(e) => setNewCal(e.currentTarget.value)} />
          <${Button} type="submit" icon="plus" disabled=${!newCal.trim()}>Add</${Button}>
        </form>
      </${FieldGroup}>
      <${Field} label="FORGE calendar ID" error=${gcal.forgeCalendarId ? calendarIdIssue(gcal.forgeCalendarId) || null : null}
        hint="A calendar you create for FORGE, shared with the service account with “Make changes to events”. Plan blocks and reminders go only here.">
        <input class="input mono" value=${forgeId} placeholder="…@group.calendar.google.com" autocapitalize="off" spellcheck="false" aria-label="FORGE calendar ID"
          onInput=${(e) => { const raw = e.currentTarget.value; setForgeId(raw); setGcal({ forgeCalendarId: normalizeCalendarId(raw) }); }}
          onBlur=${() => setForgeId(normalizeCalendarId(forgeId))} />
      </${Field}>
      <div class="card inset tight stack xs">
        <${ToggleRow} label="Push plan blocks" sub="Each plan block becomes an event on the FORGE calendar" checked=${gcal.pushPlan !== false} onValue=${(v) => setGcal({ pushPlan: v }, { now: true })} />
        <${ToggleRow} label="Push reminders" sub="10-minute reminder events: stacks, protocol, caffeine cutoff, wind-down, check-in (neutral titles)" checked=${!!gcal.pushReminders} onValue=${(v) => setGcal({ pushReminders: v }, { now: true })} />
      </div>
      <div class="set-actions"><${Button} icon="sync" loading=${job.busy} disabled=${!canRun || app.demo} onClick=${sync}>Sync now</${Button}></div>
      <${Reason}>${app.demo ? 'Not available in demo' : !gh.ok ? gh.reason : !installed ? 'Needs the server automation (Settings → Automation)' : 'Runs every hour on its own; changes here apply at the next run.'}</${Reason}>
    </div>` : null}
    ${!app.demo && !installed ? html`<${NeedsAutomation} what="Calendar sync" />` : null}

    <${Disclosure} summary=${configured ? 'Service account setup' : 'Set up the connection (about 10 minutes)'} open=${!configured}>
      <div class="stack">
        <p class="small dim">FORGE syncs your calendar from the hourly server run, so it uses a Google <b>service account</b>: a robot account you share calendars with. There is no sign-in screen and no token to expire, and it can only see the calendars you share with it.</p>
        <${Steps}>
          <${Step} title="Create a Google Cloud project"><div><${ExtLink} href="https://console.cloud.google.com/projectcreate">New project</${ExtLink}></div></${Step}>
          <${Step} title="Enable the Google Calendar API"><span>In that project, open the API page and choose Enable.</span><div><${ExtLink} href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Calendar API</${ExtLink}></div></${Step}>
          <${Step} title="Create a service account and a JSON key">
            <span>Service accounts → Create service account (any name, e.g. forge; no roles needed) → open it → Keys → Add key → Create new key → JSON. A .json file downloads.</span>
            <div><${ExtLink} href="https://console.cloud.google.com/iam-admin/serviceaccounts">Service accounts</${ExtLink}></div>
          </${Step}>
          <${Step} title="Paste the key here" done=${configured}>
            <${Textarea} value=${json} onValue=${setJson} rows="4" placeholder='{"type": "service_account", "client_email": "…", "private_key": "…"}' class="mono set-json" spellcheck="false" autocapitalize="off" />
            <div class="set-actions">
              <${FileButton} accept=".json,application/json" icon="upload" size="sm" onFiles=${async ([f]) => { try { setJson(await f.text()); } catch { app.toast('Could not read that file', { tone: 'error' }); } }}>Choose the .json file</${FileButton}>
              <${Button} variant=${configured ? undefined : 'primary'} icon="save" size="sm" loading=${saJob.busy} disabled=${!gh.ok || !json.trim()} onClick=${saveKey}>Save to vault secrets</${Button}>
            </div>
            <${Reason}>${gh.ok ? (keySet ? 'A key is saved; saving again replaces it.' : 'The key is stored only as an encrypted GitHub Actions secret (GOOGLE_SA_KEY).') : gh.reason}</${Reason}>
            <${JobLog} job=${saJob} />
          </${Step}>
          <${Step} title="Share your calendars with the service account" done=${reads.length > 0}>
            ${saEmail ? html`<${CopyBox} value=${saEmail} label="Copy address" />` : html`<span class="muted">The address appears here after you save the key.</span>`}
            <span>Google Calendar → Settings → your calendar → Share with specific people → add the address with <b>See all event details</b>. Then add the calendar’s ID above.</span>
          </${Step}>
          <${Step} title="Create the FORGE calendar" done=${!!gcal.forgeCalendarId}>
            <span>Google Calendar → Settings → Add calendar → Create new calendar, name it FORGE. Share it with the address above with <b>Make changes to events</b>, then copy its Calendar ID (Integrate calendar) into the field above.</span>
          </${Step}>
        </${Steps}>
      </div>
    </${Disclosure}>
  </${Block}>`;
}

/* ================================================================= Push */
function PushBlock() {
  const app = useApp(); useVersion(['pushSubs', 'status', 'settings']);
  const gh = useGitHub(); const installed = useAutomationInstalled();
  const status = app.store.get('status', 'push');
  const subs = app.store.all('pushSubs');
  const st = pushState(subs, status);
  const job = useJob('push:run');
  const [thisId, setThisId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cleaned, setCleaned] = useState(0);
  const supported = pushSupported();
  const standalone = isStandalone();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '');

  // Which subscription is this device's (null when none).
  useEffect(() => {
    let alive = true;
    if (!supported || !navigator.serviceWorker.getRegistration) return undefined;
    navigator.serviceWorker.getRegistration().then((reg) => (reg ? reg.pushManager.getSubscription() : null))
      .then((sub) => { if (alive) setThisId(sub ? hashId(sub.endpoint) : null); }).catch(() => {});
    return () => { alive = false; };
  }, [subs.length]);
  // Endpoints the server found dead (404/410) → deactivate them.
  useEffect(() => {
    const dead = status && status.detail && Array.isArray(status.detail.deadSubs) ? status.detail.deadSubs : [];
    const hits = subs.filter((s) => s.active !== false && dead.includes(s.id));
    for (const s of hits) app.store.upsert('pushSubs', s.id, { active: false });
    if (hits.length) setCleaned(hits.length);
  }, [status && status.lastRunAt]);

  const enable = () => {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      app.toast('The offline service worker is not active yet. Reload FORGE once, then try again.', { tone: 'error', ms: 5000 });
      return;
    }
    setBusy(true);
    // subscribePush asks for permission first, so it must start inside this click handler.
    subscribePush(app.session).then((id) => { setThisId(id); app.toast('Notifications are on for this device'); })
      .catch((e) => { console.warn(e); app.toast(e.message || 'Could not enable notifications', { tone: 'error', ms: 5000 }); })
      .finally(() => setBusy(false));
  };
  const remove = (s) => {
    const mine = s.id === thisId;
    if (mine) unsubscribePush(app.session).catch((e) => console.warn(e)); else app.store.upsert('pushSubs', s.id, { active: false });
    if (mine) setThisId(null);
    app.toast(`${s.device || 'Device'} removed`, { action: { label: 'Undo', onClick: () => { if (mine) enable(); else app.store.upsert('pushSubs', s.id, { active: true }); } } });
  };
  const localTest = async () => {
    try {
      if (Notification.permission !== 'granted') { app.toast('Notifications are not allowed on this device yet.', { tone: 'error' }); return; }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { app.toast('No service worker on this page.', { tone: 'error' }); return; }
      await reg.showNotification('FORGE', { body: 'Test notification from Settings. Delivery from the server works the same way.', tag: 'forge-test', icon: './icons/icon-192.png' });
    } catch (e) { app.toast(e.message || String(e), { tone: 'error' }); }
  };
  const serverRun = () => job.run(async ({ log, progress }) => {
    progress('Sending a test notification from GitHub Actions…');
    const since = await dispatch(app.session, 'push-test');
    log('Started the push test on the server');
    return waitForRun(app.session, 'push', since, { progress, timeoutMs: 5 * 60000 });
  });
  const active = subs.filter((s) => s.active !== false).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const inactiveCount = subs.length - active.length;
  const mineActive = thisId && active.some((s) => s.id === thisId);
  const guidance = !supported
    ? ios && !standalone ? 'On iPhone, notifications work only in the Home Screen app. In Safari: Share → Add to Home Screen, open FORGE from that icon, then enable here.' : 'This browser does not support web push notifications.'
    : null;

  return html`<${Block} title="Push notifications" desc="Morning brief, evening check-in, weekly review and protocol reminders, sent by the hourly server run. What gets sent is set in Notifications.">
    <${StatusLine} tone=${st.tone}>${st.text}${mineActive ? ' · including this device' : ''}</${StatusLine}>
    ${guidance ? html`<${Notice} tone="warn">${guidance}</${Notice}>` : null}
    ${cleaned ? html`<div class="xs muted">Removed ${cleaned} expired subscription${cleaned === 1 ? '' : 's'} the server could no longer reach.</div>` : null}
    ${active.length ? html`<div class="card flush"><div class="list">${active.map((s) => html`<div class="list-row" key=${s.id}>
        <div class="lead"><${Icon} name=${/iPhone|Android|iPad/.test(s.device || '') ? 'phone' : 'laptop'} /></div>
        <div class="grow"><div class="title">${s.device || 'Device'}${s.id === thisId ? html` <${Pill} tone="accent">This device</${Pill}>` : null}</div>
          <div class="meta">Added ${s.createdAt ? fmtDate(String(s.createdAt).slice(0, 10), { year: true, dow: false }) : '—'}</div></div>
        <${Button} size="sm" variant="ghost" onClick=${() => remove(s)}>Remove</${Button}></div>`)}</div></div>`
      : html`<${Empty} title="No devices yet">Enable notifications on your phone (from the Home Screen app) and on any computer you use.</${Empty}>`}
    ${inactiveCount ? html`<div class="xs muted">${inactiveCount} removed or expired subscription${inactiveCount === 1 ? '' : 's'} kept for history.</div>` : null}
    <div class="set-actions">
      ${mineActive ? null : html`<${Button} variant="primary" icon="bell" loading=${busy} disabled=${!supported || !gh.ok} onClick=${enable}>Enable on this device</${Button}>`}
      ${mineActive ? html`<${Button} icon="bell" onClick=${localTest}>Test on this device</${Button}>` : null}
      <${Button} icon="send" loading=${job.busy} disabled=${!gh.ok || !installed || !active.length} onClick=${serverRun}>Send test from server</${Button}>
    </div>
    <${Reason}>${app.demo ? 'Not available in demo' : !gh.ok ? gh.reason : !installed ? 'Delivery needs the server automation (Settings → Automation)' : 'Sends one test notification to every enabled device through the same server path as real reminders (about a minute, including GitHub Actions start-up).'}</${Reason}>
    <${JobLog} job=${job} doneText=${(r) => (r.pending ? 'Still running; check back in a minute.' : r.status && r.status.lastError ? `The server reported: ${r.status.lastError}` : (r.status && r.status.detail && r.status.detail.lastTest ? (r.status.detail.lastTest.delivered ? 'Test sent. It should appear on your devices now.' : 'The server could not deliver the test — re-enable notifications on the device.') : `Done. ${pushRunText(r.status && r.status.detail) || 'Nothing was due.'}`))} />
  </${Block}>`;
}

/* ========================================================== Apple Health */
function HealthBlock() {
  const app = useApp(); useVersion(['health']);
  const last = latestDate(app.store.all('health'));
  return html`<${Block} title="Apple Health" desc="For the Apple Watch or anything that writes to Apple Health: steps, active and resting energy, exercise minutes, resting heart rate, HRV, VO₂ max and weight.">
    <p class="small dim">An iOS Shortcut exports daily totals from Health as a JSON file, which you import on the Import screen. WHOOP stays the primary source for sleep and recovery; Health fills the gaps (steps, VO₂ max, scale weight).</p>
    <div class="row between wrap" style="gap:8px"><span class="xs muted">${last ? `Latest imported day: ${relDay(last, app.today())}` : 'Nothing imported yet.'}</span>
      <${Button} icon="upload" onClick=${() => app.nav('/import/health')}>Import Apple Health data</${Button}></div>
  </${Block}>`;
}
