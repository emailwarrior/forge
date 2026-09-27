// Settings → Automation: the vault's GitHub Actions workflow — install/update, test (ping), run now,
// secrets present, recent workflow runs, per-integration status, Actions minutes.
import { html, useState, useEffect } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useNow } from '../../ctx.js';
import { Button, KV, Pill, Notice, Icon } from '../../kit.js';
import { Block, StatusLine, Reason, JobLog, Ago, ExtLink, useJob, useGitHub, useAutomationInstalled, useLatestAutomation, useSecretNames, waitForRun } from '../../parts/settings-ui.js';
import { automationSummary, runState, relTime } from '../../parts/settings-status.js';
import { SECRETS } from '../../parts/settings-util.js';
import { installAutomation, dispatch, recentRuns, NEW_WORKFLOW_WAIT_MS } from '../../../app/integrations.js';
import { fmtDate, fmtNum, localParts } from '../../../core/util.js';

const JOBS = [
  { id: 'whoop', label: 'WHOOP' }, { id: 'calendar', label: 'Google Calendar' }, { id: 'push', label: 'Push notifications' },
  { id: 'reviews', label: 'Server reviews' }, { id: 'run', label: 'Whole run' },
];

export default function AutomationSection() {
  const app = useApp(); useVersion(['settings', 'status']);
  const now = useNow(30000);
  const gh = useGitHub();
  const installed = useAutomationInstalled();
  const latest = useLatestAutomation();
  const job = useJob('automation');
  const [runs, setRuns] = useState(undefined);
  const [runsTick, setRunsTick] = useState(0);
  const names = useSecretNames(gh.ok);
  const runStatus = app.store.get('status', 'run');
  const sum = automationSummary(installed, latest, runStatus, now);
  const vault = app.session.vault;

  useEffect(() => {
    if (!gh.ok || !installed) { setRuns(null); return undefined; }
    let alive = true; setRuns(undefined);
    recentRuns(app.session).then((r) => { if (alive) setRuns(r || []); });
    return () => { alive = false; };
  }, [gh.ok, !!installed, runsTick]);
  useEffect(() => { if (!job.busy && job.doneAt) setRunsTick((n) => n + 1); }, [job.busy]);

  // After a ping/auto run: wait for status/run; on timeout, look at the latest workflow run instead.
  const pingAndWait = async ({ log, progress }, task = 'ping', { justInstalled = false } = {}) => {
    progress(task === 'ping' ? 'Starting a test run on GitHub Actions…' : 'Starting a full run on GitHub Actions…');
    const since = await dispatch(app.session, task, '', justInstalled ? { waitForWorkflowMs: NEW_WORKFLOW_WAIT_MS } : undefined);
    log(task === 'ping' ? 'Test run started' : 'Full run started (WHOOP, Calendar, reviews, push)');
    const res = await waitForRun(app.session, 'run', since, { progress, timeoutMs: (task === 'ping' ? 4 : 10) * 60000 });
    if (res.pending) {
      const r = (await recentRuns(app.session))[0];
      if (r && r.status === 'completed' && r.conclusion !== 'success') throw new Error(`The run failed on GitHub (${r.conclusion}). Open it under Recent runs to see the log; a missing or wrong FORGE_DATA_KEY secret is the usual cause.`);
    }
    return res;
  };
  const install = () => job.run(async ({ log, progress }) => {
    const ver = await installAutomation(app.session, (m) => log(m));
    log(`Installed v${ver.version}`);
    return pingAndWait({ log, progress }, 'ping', { justInstalled: true });
  }, { onDone: (r) => app.toast(r && !r.pending ? 'Automation is live' : 'Automation installed') });
  const test = () => job.run((ctx) => pingAndWait(ctx), { onDone: (r) => r && !r.pending && app.toast('Automation responded') });
  const runNow = () => job.run((ctx) => pingAndWait(ctx, 'auto'));
  const doneText = (r) => {
    if (!r) return null;
    if (r.pending) return 'The run has not reported back yet. GitHub can take a minute to start it; check Recent runs below.';
    const st = r.status || {};
    const steps = st.detail && st.detail.steps ? Object.entries(st.detail.steps).map(([k, v]) => `${k} ${v}`).join(', ') : '';
    return st.lastError ? null : `Automation responded (v${st.version || (st.detail && st.detail.version) || '?'}${st.detail && st.detail.durationMs ? `, ${fmtNum(st.detail.durationMs / 1000, 1)} s` : ''})${steps ? ': ' + steps : ''}.`;
  };
  const runErr = job.result && job.result.status && job.result.status.lastError;
  const missingKey = Array.isArray(names) && !names.includes('FORGE_DATA_KEY');
  const outdated = !!(installed && latest && installed.sha256 !== latest.sha256);
  const disabledReason = gh.ok ? '' : gh.reason;

  return html`<div class="stack lg">
    <${Block} title="Server automation" desc="A GitHub Actions workflow in your private vault runs every hour: WHOOP sync, Google Calendar sync, server reviews and push notifications. It decrypts the vault in memory with the FORGE_DATA_KEY secret and only writes its own encrypted files.">
      ${app.demo ? html`<${StatusLine}>Not available in demo</${StatusLine}>` : html`<${StatusLine} tone=${sum.tone}>${sum.text}</${StatusLine}>`}
      ${installed || latest ? html`<${KV} items=${[
        ['Installed', installed ? `v${installed.version} · ${installed.installedAt ? fmtDate(String(installed.installedAt).slice(0, 10), { dow: false, year: true }) : '—'}` : 'Not installed'],
        ['Latest available', latest ? `v${latest.version}${latest.builtAt ? ` · built ${fmtDate(localParts(latest.builtAt, app.dv.tz).ymd, { dow: false, year: true })}` : ''}` : latest === null ? 'Unavailable offline' : '…'],
        ['Last run', runStatus && runStatus.lastRunAt ? html`<${Ago} at=${runStatus.lastRunAt} />` : 'never'],
        runStatus && runStatus.detail && runStatus.detail.task ? ['Last task', `${runStatus.detail.task}${runStatus.detail.durationMs ? ` · ${fmtNum(runStatus.detail.durationMs / 1000, 1)} s` : ''}`] : null,
        runStatus && runStatus.lastError ? ['Last error', html`<span class="ink-bad">${runStatus.lastError}</span>`] : null,
      ]} />` : null}
      ${missingKey && !app.demo ? html`<${Notice} tone="bad"><div class="row between wrap" style="gap:8px"><span>The FORGE_DATA_KEY secret is missing, so every run stops before doing anything.</span>
        <${Button} size="sm" onClick=${() => app.nav('/settings/security')}>Re-send the data key</${Button}></div></${Notice}>` : null}
      <${JobLog} job=${job} doneText=${runErr ? null : doneText} />
      ${runErr ? html`<${Notice} tone="bad">The run reported: ${runErr}</${Notice}>` : null}
      <div class="set-actions">
        ${!installed || outdated ? html`<${Button} variant="primary" icon="download" loading=${job.busy} disabled=${!gh.ok} onClick=${install}>${installed ? 'Update automation' : 'Install automation'}</${Button}>` : null}
        ${installed ? html`<${Button} icon="zap" loading=${job.busy} disabled=${!gh.ok} onClick=${test}>Test connection</${Button}>
          <${Button} icon="play" disabled=${!gh.ok || job.busy} onClick=${runNow}>Run now</${Button}>` : null}
        ${installed && !outdated ? html`<${Button} variant="ghost" size="sm" disabled=${!gh.ok || job.busy} onClick=${install}>Reinstall</${Button}>` : null}
      </div>
      <${Reason}>${disabledReason || (installed ? 'Test connection starts a short run that only reports back; Run now does a full hourly run.' : 'Installs two files in the vault: the workflow and the automation bundle. Needs the token’s Workflows permission.')}</${Reason}>
    </${Block}>

    ${!app.demo ? html`<${Block} title="Vault secrets" desc="Actions secrets the automation reads. GitHub shows only their names; values can never be read back.">
      ${names === undefined ? html`<div class="xs muted">Checking…</div>` : names === null ? html`<div class="xs muted">${gh.ok ? 'Could not list secrets (the token needs Secrets: Read and write).' : gh.reason}</div>`
        : html`<div class="card flush"><div class="list">${SECRETS.map((s) => {
            const has = names.includes(s.name);
            return html`<div class="list-row" key=${s.name}><span class=${'set-check' + (has ? ' on' : '')}>${has ? html`<${Icon} name="check" size=${14} />` : null}</span>
              <div class="grow"><div class="title set-code">${s.name}</div><div class="meta">${s.purpose}</div></div>
              <span class=${'xs ' + (has ? 'muted' : s.required ? 'ink-bad' : 'muted')}>${has ? 'Set' : s.required ? 'Missing' : 'Not set'}</span></div>`;
          })}</div></div>`}
    </${Block}>` : null}

    ${installed && !app.demo ? html`<${Block} title="Recent runs" action=${html`<${Button} size="sm" variant="ghost" icon="sync" onClick=${() => setRunsTick((n) => n + 1)}>Refresh</${Button}>`}>
      ${runs === undefined ? html`<div class="xs muted">Loading…</div>` : !runs || !runs.length ? html`<div class="xs muted">No runs yet. The first scheduled run starts within the hour.</div>`
        : html`<div class="card flush"><div class="list">${runs.map((r) => { const rs = runState(r); return html`<a class="list-row link" key=${r.id} href=${/^https:\/\/github\.com\//.test(String(r.html_url || '')) ? r.html_url : undefined} target="_blank" rel="noopener noreferrer">
            <div class="grow"><div class="title">${r.event === 'schedule' ? 'Hourly run' : r.event === 'workflow_dispatch' ? 'Started from FORGE' : r.event}</div>
              <div class="meta">${relTime(r.created_at, now)}${r.run_number ? ` · #${r.run_number}` : ''}</div></div>
            <${Pill} tone=${rs.tone} dot>${rs.text}</${Pill}><${Icon} name="external" size=${15} class="muted" /></a>`; })}</div></div>`}
      ${vault ? html`<div><${ExtLink} href=${`https://github.com/${vault.owner}/${vault.repo}/actions`}>All runs on GitHub</${ExtLink}></div>` : null}
    </${Block}>` : null}

    <${Block} title="Integration status" desc="What each part of the last runs reported.">
      ${!JOBS.some((j) => app.store.get('status', j.id)) ? html`<div class="xs muted">No reports yet. Each part reports here after its first server run.</div>`
      : html`<div class="card flush"><div class="list">${JOBS.map((j) => {
        const st = app.store.get('status', j.id);
        const tone = !st ? null : st.lastError ? 'bad' : st.lastOkAt ? 'good' : null;
        return html`<div class="list-row set-job" key=${j.id}>
          <div class="grow" style="min-width:0"><div class="title">${j.label}</div>
            <div class="meta">${st ? `Ran ${relTime(st.lastRunAt, now)} · last OK ${st.lastOkAt ? relTime(st.lastOkAt, now) : 'never'}` : 'No report yet'}</div>
            ${st && st.lastError ? html`<div class="xs ink-bad set-err">${st.lastError}</div>` : null}</div>
          ${st ? html`<${Pill} tone=${tone} dot>${st.lastError ? 'Error' : st.lastOkAt ? 'OK' : 'Skipped'}</${Pill}>` : null}</div>`;
      })}</div></div>`}
    </${Block}>

    <${Block} title="GitHub Actions minutes">
      <p class="small dim">Private repositories get 2,000 free Actions minutes a month on GitHub Free. Each hourly run is billed as at least one minute, so the schedule uses about 720 minutes a month; manual runs and history imports add a few more. GitHub emails you before a limit is reached, and runs simply stop until the next month if it is.</p>
    </${Block}>
  </div>`;
}
