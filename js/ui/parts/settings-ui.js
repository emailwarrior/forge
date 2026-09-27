// Settings: shared components and hooks for the section modules (autosave drafts, the quiet
// "Saved" indicator, long-running jobs that survive navigation, GitHub availability, small widgets).
import { html, useState, useEffect, useRef, useCallback } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useNow } from '../ctx.js';
import { Icon, IconButton, Button, Notice, Spinner, cx } from '../kit.js';
import { relTime } from './settings-status.js';
import { strengthLevel, STRENGTH_LABELS } from './settings-util.js';
import { latestAutomation, listSecrets, waitForStatus } from '../../app/integrations.js';
import { holdAutoLock } from './settings-shell.js';

/* ------------------------------------------------------ save indicator */
const saveBus = { dirty: new Set(), savedAt: 0, listeners: new Set() };
const emitSave = () => { for (const fn of [...saveBus.listeners]) fn(); };
export function noteDirty(token, on) { if (on) saveBus.dirty.add(token); else saveBus.dirty.delete(token); emitSave(); }
export function noteSaved() { saveBus.savedAt = Date.now(); emitSave(); }

/** Quiet "Saving…" / "Saved" indicator (for the page header). */
export function SaveNote() {
  const [, tick] = useState(0);
  useEffect(() => { const fn = () => tick((n) => n + 1); saveBus.listeners.add(fn); return () => saveBus.listeners.delete(fn); }, []);
  const recent = Date.now() - saveBus.savedAt < 2400;
  useEffect(() => { if (!recent) return undefined; const t = setTimeout(() => tick((n) => n + 1), 2500); return () => clearTimeout(t); }, [saveBus.savedAt]);
  if (saveBus.dirty.size) return html`<span class="set-save xs muted" role="status">Saving…</span>`;
  if (recent) return html`<span class="set-save xs muted" role="status"><${Icon} name="check" size=${14} />Saved</span>`;
  return html`<span class="set-save" aria-hidden="true"></span>`;
}

/**
 * Autosaving draft of one settings record.
 * const { value, set, errors } = useSettingDraft('targets', { validate });
 * set(patch) saves after `delay` ms; set(patch, { now: true }) saves immediately (toggles, selects).
 * `validate(merged) → {key: message}`: invalid keys stay local (shown with their error) and are
 * never written. Nested objects: pass the whole object ({ ai: { ...value.ai, model } }).
 */
export function useSettingDraft(id, { validate, delay = 450 } = {}) {
  const app = useApp(); useVersion(['settings']);
  const stored = app.store.setting(id);
  const [pending, setPending] = useState({});
  const r = useRef({ pending: {}, timer: null, token: {} });
  r.current.validate = validate;
  const flush = useCallback(() => {
    const st = r.current; clearTimeout(st.timer); st.timer = null;
    const p = st.pending; const keys = Object.keys(p);
    if (!keys.length) { noteDirty(st.token, false); return; }
    const errs = st.validate ? st.validate({ ...app.store.setting(id), ...p }) || {} : {};
    const ok = {}; const keep = {};
    for (const k of keys) (errs[k] ? keep : ok)[k] = p[k];
    if (Object.keys(ok).length) { app.store.updateSetting(id, ok); noteSaved(); }
    st.pending = keep; setPending(keep); noteDirty(st.token, false);
  }, [id]);
  const set = useCallback((patch, { now = false } = {}) => {
    const st = r.current;
    st.pending = { ...st.pending, ...patch }; setPending(st.pending);
    clearTimeout(st.timer); noteDirty(st.token, true);
    if (now) flush(); else st.timer = setTimeout(flush, delay);
  }, [flush, delay]);
  useEffect(() => () => { const st = r.current; if (st.timer) flush(); st.pending = {}; noteDirty(st.token, false); }, [flush]);
  const value = { ...stored, ...pending };
  const errors = validate ? validate(value) || {} : {};
  return { value, stored, set, flush, errors };
}

/* --------------------------------------------------------------- jobs */
// Long-running work (install, connect, sync-and-wait) keeps running and keeps its log when the
// user navigates away; returning to the section shows its progress or result.
const jobs = new Map();
function jobOf(key) {
  if (!jobs.has(key)) jobs.set(key, { state: { busy: false, log: [], error: null, result: undefined, startedAt: 0, doneAt: 0 }, listeners: new Set() });
  return jobs.get(key);
}
/**
 * const job = useJob('automation:install');
 * job.run(async ({ log, progress }) => { log('Step'); progress('Waiting… 8s'); return result; }, { onDone, onError })
 * job: { busy, log: [{text, progress}], error, result, startedAt, doneAt, run, reset }
 */
export function useJob(key) {
  const job = jobOf(key);
  const [, tick] = useState(0);
  useEffect(() => { const fn = () => tick((n) => n + 1); job.listeners.add(fn); return () => job.listeners.delete(fn); }, [key]);
  const set = (p) => { job.state = { ...job.state, ...p }; for (const fn of [...job.listeners]) fn(); };
  const run = async (fn, { onDone, onError } = {}) => {
    if (job.state.busy) return undefined;
    set({ busy: true, log: [], error: null, result: undefined, startedAt: Date.now(), doneAt: 0 });
    holdAutoLock(job, true);
    const log = (text) => set({ log: [...job.state.log.filter((l) => !l.progress), { text }] });
    const progress = (text) => set({ log: [...job.state.log.filter((l) => !l.progress), { text, progress: true }] });
    try {
      const result = await fn({ log, progress });
      set({ busy: false, result, doneAt: Date.now(), log: job.state.log.filter((l) => !l.progress) });
      if (onDone) onDone(result);
      return result;
    } catch (e) {
      console.warn('[settings]', key, e);
      set({ busy: false, error: (e && e.message) || String(e), doneAt: Date.now(), log: job.state.log.filter((l) => !l.progress) });
      if (onError) onError(e);
      return undefined;
    } finally { holdAutoLock(job, false); }
  };
  return { ...job.state, run, reset: () => set({ log: [], error: null, result: undefined, doneAt: 0 }) };
}

/** Step log for a job: completed lines with checks, the running line with a spinner. */
export function JobLog({ job, doneText }) {
  if (!job.log.length && !job.error && !(job.result !== undefined && doneText)) return null;
  if (!job.busy && job.doneAt && Date.now() - job.doneAt > 20 * 60000) return null; // an old result is noise
  return html`<div class="stack sm">
    ${job.log.length ? html`<div class="set-log">${job.log.map((l, i) => {
      const running = job.busy && i === job.log.length - 1;
      return html`<div class="row" key=${i}>${running ? html`<${Spinner} />` : html`<${Icon} name="check" size=${15} class="ink-good" />`}<span class=${running ? '' : 'dim'}>${l.text}</span></div>`;
    })}</div>` : null}
    ${job.error ? html`<${Notice} tone="bad">${job.error}</${Notice}>` : null}
    ${!job.busy && !job.error && job.result !== undefined && doneText ? html`<${Notice} tone="good">${typeof doneText === 'function' ? doneText(job.result) : doneText}</${Notice}>` : null}
  </div>`;
}

/* ------------------------------------------------------ availability */
/** Can this session talk to the vault on GitHub? → { ok, reason } */
export function useGitHub() {
  const app = useApp();
  if (app.demo) return { ok: false, reason: 'Not available in demo' };
  if (!app.session.gh || !app.session.creds.githubToken) return { ok: false, reason: 'No GitHub token on this device — add one in Settings → Sync' };
  return { ok: true, reason: '' };
}
/** Automation install record (settings integrations.automation) or null. */
export function useAutomationInstalled() {
  const app = useApp(); useVersion(['settings']);
  return app.store.setting('integrations').automation || null;
}

// Names of the vault's Actions secrets (values are never readable), cached for a minute.
const secrets = { names: undefined, at: 0, promise: null, listeners: new Set() };
/** → undefined while loading, null when unknown (no access), else string[] */
export function useSecretNames(enabled = true) {
  const app = useApp();
  const [names, setNames] = useState(secrets.names);
  const [v, setV] = useState(0);
  useEffect(() => { const fn = () => setV((n) => n + 1); secrets.listeners.add(fn); return () => secrets.listeners.delete(fn); }, []);
  useEffect(() => {
    if (!enabled || !app.session.gh) return undefined;
    let alive = true;
    if (!secrets.promise || Date.now() - secrets.at > 60000) {
      secrets.promise = listSecrets(app.session.gh).then((n) => { secrets.names = n; secrets.at = Date.now(); return n; });
    }
    secrets.promise.then((n) => { if (alive) setNames(n); });
    return () => { alive = false; };
  }, [enabled, v]);
  return enabled ? names : null;
}
/** Call after writing a secret so every mounted list refreshes. */
export function refreshSecretNames() { secrets.promise = null; secrets.at = 0; for (const fn of [...secrets.listeners]) fn(); }

/**
 * Wait for a server run to report status/<id>; a timeout is not an error (the run may still be
 * going), so it resolves { pending: true } instead of throwing.
 */
export async function waitForRun(session, id, since, { progress, timeoutMs = 9 * 60000 } = {}) {
  try {
    const st = await waitForStatus(session, id, since, { timeoutMs, onTick: (t) => progress && progress(`Waiting for the server run… ${fmtWait(t)}`) });
    return { pending: false, status: st };
  } catch (e) {
    if (/No response from automation yet/.test(String(e && e.message))) return { pending: true, status: null };
    throw e;
  }
}
const fmtWait = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

// Latest automation bundle info (./dist/automation-version.json), fetched once per page load.
let latestPromise = null; let latestValue;
/** → undefined while loading, null when unavailable, else { version, builtAt, sha256, bytes } */
export function useLatestAutomation() {
  const [v, setV] = useState(latestValue);
  useEffect(() => {
    let alive = true;
    if (!latestPromise) latestPromise = latestAutomation().then((x) => (latestValue = x)).catch(() => (latestValue = null));
    latestPromise.then((x) => { if (alive) setV(x); });
    return () => { alive = false; };
  }, []);
  return v;
}

/** Muted reason under disabled actions. */
export function Reason({ children }) {
  if (!children) return null;
  return html`<div class="xs muted row" style="gap:6px"><${Icon} name="info" size=${13} />${children}</div>`;
}

/** Notice shown where a feature needs the automation workflow. */
export function NeedsAutomation({ what = 'This' }) {
  const app = useApp();
  return html`<${Notice} tone="warn"><div class="row between wrap" style="gap:8px"><span>${what} runs in the hourly server automation, which is not installed yet.</span>
    <${Button} size="sm" onClick=${() => app.nav('/settings/automation')}>Set up automation</${Button}></div></${Notice}>`;
}

/* ------------------------------------------------------------ widgets */
/** Card-like block with a title row and optional one-line description. */
export function Block({ title, desc, meta, action, children, id }) {
  return html`<section class="card set-block" id=${id}>
    ${title || action || meta ? html`<div class="set-block-head"><h3 class="grow">${title}</h3>
      ${meta ? html`<span class="xs muted">${meta}</span>` : null}${action || null}</div>` : null}
    ${desc ? html`<p class="set-block-desc xs muted">${desc}</p>` : null}
    <div class="stack">${children}</div>
  </section>`;
}

/** Password-style input with a reveal toggle: { value, onValue, placeholder, label, autocomplete, mono } */
export function SecretInput({ value, onValue, placeholder, label, autocomplete = 'off', mono = true, onEnter }) {
  const [show, setShow] = useState(false);
  return html`<div class="set-secret">
    <input class=${cx('input', mono && 'mono')} type=${show ? 'text' : 'password'} value=${value ?? ''} placeholder=${placeholder}
      aria-label=${label} autocomplete=${autocomplete} autocapitalize="off" spellcheck="false"
      onInput=${(e) => onValue(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && onEnter) onEnter(); }} />
    <${IconButton} icon=${show ? 'eyeOff' : 'eye'} label=${show ? 'Hide' : 'Show'} sm onClick=${() => setShow(!show)} />
  </div>`;
}

/** External link styled as a small button. */
export function ExtLink({ href, children, variant = 'sm' }) {
  return html`<a class=${'btn ' + variant} href=${href} target="_blank" rel="noopener noreferrer"><${Icon} name="external" />${children}</a>`;
}

/** Passphrase strength meter (same thresholds as setup). */
export function Strength({ bits }) {
  const lvl = strengthLevel(bits);
  return html`<div class="stack xs"><div class=${'strength s' + lvl}><i></i><i></i><i></i><i></i></div>
    <span class="xs muted">${STRENGTH_LABELS[lvl] || 'Use 4+ random words or 16+ mixed characters'}${lvl && lvl < 3 ? ' — needs “Good” or better' : ''}</span></div>`;
}

/** Status dot + text: { tone ('good'|'warn'|'bad'|null), children } */
export function StatusLine({ tone, children, small }) {
  return html`<div class=${cx('set-status', small && 'xs')}><span class=${cx('set-dot', tone)}></span><span class="grow">${children}</span></div>`;
}

/** "12 min ago" that stays fresh; title shows the exact time. */
export function Ago({ at }) {
  const now = useNow(30000);
  if (!at) return html`<span class="muted">never</span>`;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return html`<span title=${Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''}>${relTime(at, now)}</span>`;
}

/**
 * Field wrapper for grouped controls (segmented, chips, several buttons). kit's Field is a
 * <label>, which forwards clicks on its text to the first button inside; this is a <div>.
 */
export function FieldGroup({ label, hint, error, children, class: cls }) {
  return html`<div class=${cx('field', cls)} role="group" aria-label=${label}>${label ? html`<span class="label-text">${label}</span>` : null}${children}
    ${error ? html`<span class="error">${error}</span>` : hint ? html`<span class="hint">${hint}</span>` : null}</div>`;
}

/** Numbered setup steps: { steps: [node] } */
export function Steps({ children }) { return html`<ol class="set-steps">${children}</ol>`; }
export function Step({ title, done, children }) {
  return html`<li class=${cx(done && 'done')}><div class="set-step-title">${title}${done ? html` <${Icon} name="check" size=${14} class="ink-good" />` : null}</div>${children ? html`<div class="set-step-body">${children}</div>` : null}</li>`;
}

/** Segmented control that supports disabled options: { value, onValue, options: [{value,label,disabled,title}], block, label } */
export function Seg({ value, onValue, options, block, label }) {
  return html`<div class=${cx('seg', block && 'block')} role="group" aria-label=${label}>
    ${options.map((o) => html`<button type="button" aria-pressed=${String(o.value === value)} disabled=${o.disabled} title=${o.title}
      onClick=${() => !o.disabled && onValue && onValue(o.value)}>${o.label}</button>`)}
  </div>`;
}

/**
 * Save a generated file. In the iPhone Home Screen app a blob download opens a dead-end preview,
 * so there the share sheet (Save to Files) is used; elsewhere a normal download.
 * → 'downloaded' | 'shared' | 'cancelled'
 */
export async function saveFile(blob, name) {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  const standalone = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  if (ios && standalone && typeof File === 'function' && typeof navigator.canShare === 'function') {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
