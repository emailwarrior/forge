// Settings → AI: the Anthropic API key (encrypted, per device), key test, models, effort, web lookup,
// server-side reviews (needs the key as an Actions secret), typical costs, recorded spend, privacy.
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics } from '../../ctx.js';
import { Button, Field, Select, ToggleRow, Notice, KV, Pill } from '../../kit.js';
import {
  Block, SecretInput, Reason, NeedsAutomation, JobLog, Ago, useJob, useGitHub, useAutomationInstalled, useSettingDraft,
  useSecretNames, refreshSecretNames, Seg, FieldGroup, StatusLine,
} from '../../parts/settings-ui.js';
import { MODELS, COST_ROWS, aiSpend, fmtUsd, modelLabel } from '../../parts/settings-status.js';
import { maskKey } from '../../parts/settings-util.js';
import { aiErrorText } from '../../parts/ai.js';
import { makeAiConfig, verifyKey } from '../../../ai/index.js';
import { setSecret } from '../../../app/integrations.js';
import { addDays, fmtNum } from '../../../core/util.js';

export default function AiSection() {
  const { value: integ, set } = useSettingDraft('integrations');
  const ai = integ.ai;
  const setAi = (patch) => set({ ai: { ...ai, ...patch } }, { now: true });
  return html`<div class="stack lg">
    <${KeyBlock} ai=${ai} />
    <${ModelBlock} ai=${ai} setAi=${setAi} />
    <${ServerBlock} ai=${ai} setAi=${setAi} />
    <${CostBlock} />
    <${Block} title="Privacy" desc="What leaves the vault when AI features run.">
      <p class="small dim">Meal photos, lab reports and short summaries of your data (targets, recent days, rules) are sent to Anthropic’s API when you use an AI feature. Under Anthropic’s commercial API terms, API inputs and outputs are not used to train models. The API key is stored encrypted on this device; with server reviews on, it is also an encrypted Actions secret in your private vault.</p>
      <p class="xs muted">Everything else stays encrypted in the vault, apart from Google Calendar event titles for plan blocks and reminders (protocols use neutral titles) and push notifications, which are end-to-end encrypted to your devices.</p>
    </${Block}>
  </div>`;
}

function KeyBlock({ ai }) {
  const app = useApp(); const s = app.session;
  const [saved, setSaved] = useState(s.creds.anthropicKey || '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const test = useJob('ai:test');
  const looksRight = !key.trim() || /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
  const save = async () => {
    const k = key.trim(); if (!k) return;
    setBusy(true);
    try { await s.updateCreds({ anthropicKey: k }); setSaved(k); setKey(''); test.reset(); app.toast('API key saved on this device'); }
    catch (e) { console.warn(e); app.toast('Could not save the key: ' + (e.message || e), { tone: 'error' }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await app.confirm({ title: 'Remove the API key from this device?', message: 'AI features (meal analysis, reviews, Ask) stop working on this device until you add a key again. Other devices and the server secret are not affected.', confirmLabel: 'Remove key', danger: true }))) return;
    await s.updateCreds({ anthropicKey: '' }); setSaved(''); test.reset(); app.toast('API key removed from this device');
  };
  const runTest = () => test.run(async ({ progress }) => {
    const k = key.trim() || saved;
    progress('Sending a one-token request…');
    try { return await verifyKey(makeAiConfig(ai, k)); } catch (e) { throw new Error(aiErrorText(e)); }
  });
  return html`<${Block} title="Anthropic API key" desc="Used for meal analysis, lab extraction, reviews and Ask. Each device keeps its own copy, encrypted with your vault key.">
    <${StatusLine} tone=${saved ? 'good' : 'warn'}>${saved ? html`Key set on this device <span class="set-code muted">${maskKey(saved)}</span>` : 'No key on this device'}</${StatusLine}>
    <${FieldGroup} label=${saved ? 'Replace the key' : 'API key'} hint=${looksRight ? 'Create one at console.anthropic.com → API keys. Billing is per use.' : 'Anthropic keys start with sk-ant-. Check that the whole key was pasted.'}>
      <${SecretInput} value=${key} onValue=${setKey} placeholder="sk-ant-…" label="Anthropic API key" onEnter=${save} />
    </${FieldGroup}>
    <div class="set-actions">
      <${Button} variant="primary" icon="save" loading=${busy} disabled=${!key.trim()} onClick=${save}>Save on this device</${Button}>
      <${Button} icon="zap" loading=${test.busy} disabled=${!key.trim() && !saved} onClick=${runTest}>Test ${key.trim() ? 'this key' : 'saved key'}</${Button}>
      ${saved ? html`<${Button} variant="ghost" class="danger" onClick=${remove}>Remove</${Button}>` : null}
    </div>
    <${JobLog} job=${test} doneText=${(r) => `The key works: ${modelLabel(r.model)} answered in ${fmtNum(r.latencyMs)} ms (cost ${fmtUsd(r.costUsd)}).`} />
  </${Block}>`;
}

function ModelBlock({ ai, setAi }) {
  const opts = MODELS.map((m) => ({ value: m.value, label: m.option }));
  const known = (v) => MODELS.some((m) => m.value === v);
  const note = (v) => (MODELS.find((m) => m.value === v) || {}).note || 'Custom model id.';
  return html`<${Block} title="Models" desc="The main model does meal analysis, labs, reviews and Ask; the fast model writes the morning brief.">
    <div class="set-cols w2">
      <${Field} label="Main model" hint=${note(ai.model)}>
        <${Select} value=${ai.model} onValue=${(v) => setAi({ model: v })} options=${known(ai.model) ? opts : [{ value: ai.model, label: ai.model }, ...opts]} />
      </${Field}>
      <${Field} label="Fast model" hint=${note(ai.fastModel)}>
        <${Select} value=${ai.fastModel} onValue=${(v) => setAi({ fastModel: v })} options=${known(ai.fastModel) ? opts : [{ value: ai.fastModel, label: ai.fastModel }, ...opts]} />
      </${Field}>
    </div>
    <${FieldGroup} label="Effort" hint="How much the main model thinks before answering. Higher is slower and costs more (thinking bills as output).">
      <${Seg} value=${ai.effort} onValue=${(v) => setAi({ effort: v })} label="Effort" options=${[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
    </${FieldGroup}>
    <div class="card inset tight">
      <${ToggleRow} label="Web lookup for branded and restaurant food" sub="Meal analysis may search the web (up to 3 searches, about $0.01 each plus result tokens) when a label, brand or restaurant is involved."
        checked=${ai.webLookup !== false} onValue=${(v) => setAi({ webLookup: v })} />
    </div>
  </${Block}>`;
}

function ServerBlock({ ai, setAi }) {
  const app = useApp(); useVersion(['status']);
  const gh = useGitHub(); const installed = useAutomationInstalled();
  const names = useSecretNames(gh.ok);
  const job = useJob('ai:secret');
  const [asking, setAsking] = useState(false);
  const deviceKey = app.session.creds.anthropicKey || '';
  const has = Array.isArray(names) ? names.includes('ANTHROPIC_API_KEY') : null;
  const status = app.store.get('status', 'reviews');
  const on = !!ai.serverReviews;
  const toggle = (v) => {
    if (!v) { setAi({ serverReviews: false }); setAsking(false); app.toast('Server reviews off'); return; }
    if (has) { setAi({ serverReviews: true }); app.toast('Server reviews on'); return; }
    setAsking(true);
  };
  const saveSecret = () => job.run(async ({ progress }) => {
    progress('Saving the key as the ANTHROPIC_API_KEY Actions secret…');
    await setSecret(app.session.gh, 'ANTHROPIC_API_KEY', deviceKey);
    refreshSecretNames();
    setAi({ serverReviews: true }); setAsking(false);
    return true;
  }, { onDone: () => app.toast('Key saved to the vault; server reviews on') });
  const d = status && status.detail;
  return html`<${Block} title="Server reviews" desc="The hourly automation writes the nutrition review for the previous day (after 3:00 AM, when at least two meals were logged) and, on Monday, the review of the week that ended Sunday, even when the app is closed.">
    <div class="card inset tight">
      <${ToggleRow} label="Run reviews on the server" sub=${has === true ? 'The key is saved as a vault secret.' : has === false ? 'Needs the API key as a vault secret.' : 'Uses the ANTHROPIC_API_KEY vault secret.'}
        checked=${on} onValue=${toggle} disabled=${!gh.ok} />
    </div>
    ${asking && !on ? html`<${Notice} tone="warn"><div class="stack sm">
        <span>To run on GitHub Actions, the key must be stored as the <b>ANTHROPIC_API_KEY</b> Actions secret in your private vault (encrypted by GitHub; readable only by workflow runs). It is used only for these daily nutrition and weekly reviews.</span>
        ${deviceKey ? html`<div class="set-actions"><${Button} variant="primary" icon="key" loading=${job.busy} onClick=${saveSecret}>Save key to vault and turn on</${Button}><${Button} variant="ghost" onClick=${() => setAsking(false)}>Cancel</${Button}></div>`
          : html`<span class="strong">Add the API key above first.</span>`}
      </div></${Notice}>` : null}
    <${JobLog} job=${job} />
    <${Reason}>${app.demo ? 'Not available in demo' : !gh.ok ? gh.reason : on ? 'Turning this off stops server reviews; the secret stays until you delete it in the vault repository (Settings → Secrets and variables → Actions).' : ''}</${Reason}>
    ${on && !installed && !app.demo ? html`<${NeedsAutomation} what="Server reviews" />` : null}
    ${status ? html`<${KV} items=${[
      ['Last run', status.lastRunAt ? html`<${Ago} at=${status.lastRunAt} />` : '—'],
      ['Last review written', d && d.lastCreatedAt ? html`<${Ago} at=${d.lastCreatedAt} />` : '—'],
      ['Cost of that run', d && d.lastCostUsd != null ? fmtUsd(d.lastCostUsd) : '—'],
      status.lastError ? ['Last error', html`<span class="ink-bad">${status.lastError}</span>`] : null,
      d && d.note ? ['Note', d.note] : null,
    ]} />` : null}
  </${Block}>`;
}

function CostBlock() {
  const app = useApp(); useVersion(['meals', 'reviews', 'labs']);
  const today = app.today(); const from = addDays(today, -29);
  const spend = useAnalytics(() => aiSpend({ meals: app.store.range('meals', from, today), reviews: app.store.range('reviews', from, today), labs: app.store.range('labs', from, today) }, from, today), [from, today]);
  return html`<${Block} title="Costs" desc="Typical per-call costs at current API prices. Estimates; every stored result records its actual cost.">
    <div class="card flush"><div class="list">${COST_ROWS.map((r) => html`<div class="list-row set-cost-row" key=${r.what}>
      <div class="grow"><div class="title" style="white-space:normal">${r.what}</div><div class="meta">${r.model} · ${r.latency}</div></div>
      <div class="set-cost">${r.cost}</div></div>`)}</div></div>
    <div class="set-facts">
      <div class="row between"><span class="small">Recorded spend, last 30 days</span><${Pill}>${spend ? fmtUsd(spend.usd) : '—'}</${Pill}></div>
      <div class="xs muted">${spend && spend.n ? `${spend.meals} meal analyses, ${spend.reviews} reviews, ${spend.labs} lab reports with a recorded cost.` : 'No AI calls with a recorded cost yet.'} Anthropic’s console shows the billed total.</div>
    </div>
  </${Block}>`;
}
