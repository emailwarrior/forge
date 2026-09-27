// Shared UI for Claude calls: task hook (busy/progress/cancel/errors), status line, error notice, cost note.
import { html, useState, useRef, useEffect, useCallback } from '../../vendor/preact-htm.js';
import { useApp } from '../ctx.js';
import { Button, Notice, Spinner } from '../kit.js';

/** Human text for an AIError (or any error). */
export function aiErrorText(e) {
  if (!e) return '';
  switch (e.code) {
    case 'no-key': return 'Add your Anthropic API key in Settings → AI.';
    case 'auth': return 'The Anthropic API key was rejected. Check it in Settings → AI.';
    case 'rate-limit': return 'Rate limited by the API' + (e.retryAfter ? ` — retry in ${Math.ceil(e.retryAfter)} s.` : '.');
    case 'overloaded': return 'The API is overloaded right now. Try again in a minute.';
    case 'network': return 'Could not reach the API. Check the connection and retry.';
    // No HTTP status → raised locally (e.g. an image that cannot be decoded): show the message as is.
    case 'bad-request': return e.status ? 'The request was rejected: ' + (e.message || 'bad request') : (e.message || 'That input could not be used.');
    case 'parse': return 'The response could not be read. Retry.';
    case 'refused': return 'The model declined this request.';
    default: return (e && e.message) || String(e);
  }
}

const PHASE_TEXT = { thinking: 'Thinking…', searched: 'Reading search results…', writing: 'Writing…', tool: 'Recording…', continuing: 'Continuing…' };
export function phaseText(phase, query) {
  if (phase === 'searching') return query ? `Searching: ${query}` : 'Searching the web…';
  return PHASE_TEXT[phase] || 'Working…';
}

/**
 * const task = useAiTask();
 * await task.run(({ ai, signal, onProgress }) => analyzeMeal(ai, { ..., signal, onProgress }))
 *   → result, or undefined on error/cancel/no key (a missing key shows the Settings toast).
 * task: { run, cancel, reset, busy, phase, query, error, result, startedAt }
 * Pass { ai } in opts to supply a prebuilt config (e.g. with a different model).
 */
export function useAiTask() {
  const app = useApp();
  const [st, setSt] = useState({ busy: false, phase: null, query: null, error: null, result: undefined, startedAt: 0 });
  const ctl = useRef(null); const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (ctl.current) ctl.current.abort(); }, []);
  const set = (p) => { if (alive.current) setSt((s) => ({ ...s, ...p })); };
  const run = useCallback(async (fn, opts = {}) => {
    const ai = opts.ai || app.requireAi();
    if (!ai) return undefined;
    if (ctl.current) ctl.current.abort();
    const c = new AbortController(); ctl.current = c;
    set({ busy: true, phase: 'thinking', query: null, error: null, result: undefined, startedAt: Date.now() });
    const onProgress = (ev) => { if (ctl.current === c && ev && ev.phase) set({ phase: ev.phase, query: ev.query || null }); };
    try {
      const result = await fn({ ai, signal: c.signal, onProgress });
      if (ctl.current === c) { ctl.current = null; set({ busy: false, phase: null, result }); }
      return result;
    } catch (error) {
      if (ctl.current === c) ctl.current = null;
      if (error && error.code === 'aborted') { set({ busy: false, phase: null }); return undefined; }
      console.warn('[ai]', error);
      set({ busy: false, phase: null, error });
      return undefined;
    }
  }, [app]);
  const cancel = useCallback(() => { if (ctl.current) { ctl.current.abort(); ctl.current = null; } set({ busy: false, phase: null }); }, []);
  const reset = useCallback(() => set({ error: null, result: undefined }), []);
  return { ...st, run, cancel, reset };
}

/** Status line while a task runs: { task, label } (label overrides the phase text). */
export function AiStatus({ task, label }) {
  const [, tick] = useState(0);
  useEffect(() => { if (!task.busy) return undefined; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [task.busy]);
  if (!task.busy) return null;
  const secs = Math.max(0, Math.round((Date.now() - task.startedAt) / 1000));
  return html`<div class="ai-status" role="status"><${Spinner} /><span class="grow ellipsis">${label || phaseText(task.phase, task.query)}</span>
    <span class="xs muted mono">${secs}s</span><${Button} size="sm" variant="ghost" onClick=${task.cancel}>Cancel</${Button}></div>`;
}

/** Error notice with Retry / Settings: { error, onRetry } */
export function AiError({ error, onRetry }) {
  const app = useApp();
  if (!error) return null;
  const keyIssue = error.code === 'auth' || error.code === 'no-key';
  return html`<${Notice} tone="bad"><div class="stack sm"><span>${aiErrorText(error)}</span>
    <div class="row" style="gap:8px">${onRetry && !keyIssue ? html`<${Button} size="sm" onClick=${onRetry}>Retry</${Button}>` : null}
    ${keyIssue ? html`<${Button} size="sm" onClick=${() => app.nav('/settings/ai')}>Open Settings</${Button}>` : null}</div></div></${Notice}>`;
}

/** "≈ $0.031 · claude-sonnet-5": { usd, model, estimated } */
export function CostNote({ usd, model, estimated }) {
  if (usd == null && !model) return null;
  const cost = usd == null ? null : '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3));
  return html`<span class="xs muted mono">${[cost && (estimated ? '≈ ' : '') + cost, model].filter(Boolean).join(' · ')}</span>`;
}

/** Inline prompt shown where an AI feature needs a key: { what } */
export function AiKeyNotice({ what = 'this' }) {
  const app = useApp();
  return html`<${Notice}><div class="row between wrap" style="gap:8px"><span>Add an Anthropic API key to enable ${what}.</span>
    <${Button} size="sm" onClick=${() => app.nav('/settings/ai')}>Settings → AI</${Button}></div></${Notice}>`;
}
