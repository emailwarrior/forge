// Insights › Ask: questions about your own data, answered by askForge() with a context pack of the last
// 30 or 90 days. The conversation lives in memory for this app session (module level) until Clear.
// Answers are rendered with the escape-first markdown renderer (parts/insights-md.js).
import { html, useState, useRef } from '../../../vendor/preact-htm.js';
import { useSetting } from '../../ctx.js';
import { Card, Button, Segmented, Textarea, IconButton } from '../../kit.js';
import { useAiTask, AiStatus, AiError, CostNote, AiKeyNotice } from '../../parts/ai.js';
import { contextPack } from '../../../analytics/index.js';
import { askForge } from '../../../ai/index.js';
import { isNum } from '../../../core/util.js';
import { renderMarkdown } from '../../parts/insights-md.js';

// Session memory: survives switching sections and screens, not a reload.
const convo = { turns: [], days: 30, draft: '' };
let seq = 0;

function suggestions(profile, hasCycle) {
  const rate = profile && isNum(profile.goalRateLbWk) && profile.goalRateLbWk > 0 ? profile.goalRateLbWk : null;
  return [
    'What drove my lowest recovery days?',
    rate ? `Am I eating enough to gain ${String(Math.round(rate * 100) / 100)} lb a week?` : 'Am I eating enough for my goal weight?',
    'Which lifts are stalling, and what changed around them?',
    'How is meal timing affecting my sleep?',
    'What should I focus on this week?',
    hasCycle ? 'How do dose days line up with my recovery and appetite?' : 'How does meeting load affect my next-day recovery?',
  ];
}

export default function Ask({ app }) {
  const profile = useSetting('profile');
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const [text, setText] = useState(convo.draft);
  const [days, setDays] = useState(convo.days);
  const task = useAiTask();
  const end = useRef(null);
  const lastQ = useRef(null);
  const hasKey = !!app.ai();
  const hasCycle = app.store.all('protocolItems').some((i) => i.active !== false && (i.kind === 'peptide' || i.kind === 'medication'));

  const scrollEnd = () => requestAnimationFrame(() => { if (end.current && end.current.scrollIntoView) end.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  const send = async (q) => {
    const question = String(q ?? text).trim();
    if (!question || task.busy) return;
    if (!app.requireAi()) return;
    const history = convo.turns.filter((t) => !t.failed).map((t) => ({ role: t.role, content: t.content }));
    const turn = { id: ++seq, role: 'user', content: question, days };
    convo.turns = [...convo.turns, turn]; lastQ.current = turn;
    setText(''); convo.draft = ''; rerender(); scrollEnd();
    const res = await task.run(({ ai, signal, onProgress }) => {
      const pack = contextPack(app.dv, app.today(), { days });
      return askForge(ai, { question, contextPack: pack, history, today: app.today(), signal, onProgress });
    });
    if (res) {
      convo.turns = [...convo.turns, { id: ++seq, role: 'assistant', content: res.answer, model: res.model, costUsd: res.costUsd, costEstimated: res.costEstimated, days }];
    } else {
      // Cancelled or failed: take the question back out of the thread (and back into the box when cancelled).
      convo.turns = convo.turns.filter((t) => t !== turn);
      setText((cur) => cur || question);
    }
    rerender(); scrollEnd();
  };
  const retry = () => { const q = lastQ.current && lastQ.current.content; task.reset(); if (q) send(q); };
  const clear = () => {
    const old = convo.turns;
    convo.turns = []; task.reset(); rerender();
    app.toast('Conversation cleared', { action: { label: 'Undo', onClick: () => { convo.turns = old; rerender(); } } });
  };
  const setCtx = (v) => { convo.days = v; setDays(v); };
  const copy = async (t) => { try { await navigator.clipboard.writeText(t.content); app.toast('Answer copied'); } catch { app.toast('Copy failed', { tone: 'error' }); } };
  const total = convo.turns.reduce((s, t) => s + (isNum(t.costUsd) ? t.costUsd : 0), 0);

  return html`<div class="stack" data-ms="0">
    <${Card} title="Ask about your data" meta=${convo.turns.length ? `${convo.turns.filter((t) => t.role === 'assistant').length} answers · $${total.toFixed(3)}` : null}
      action=${convo.turns.length ? html`<${Button} size="sm" variant="ghost" icon="trash" onClick=${clear}>Clear</${Button}>` : null}>
      <div class="stack sm">
        <div class="row between wrap" style="gap:8px">
          <span class="small dim">Context sent with each question</span>
          <${Segmented} label="Context window" value=${days} onValue=${setCtx} options=${[{ value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }]} />
        </div>
        <div class="xs muted">A summary of your logs — daily metrics, targets, standards, protocol items (by their neutral label when set), lab flags and top patterns; no journal text — goes to Anthropic with the question. Not medical advice.</div>
      </div>
    </${Card}>
    ${hasKey ? null : html`<${AiKeyNotice} what="Ask" />`}
    ${convo.turns.length ? html`<div class="ins-chat" aria-live="polite">${convo.turns.map((t) => (t.role === 'user'
      ? html`<div class="ins-msg user" key=${t.id}>${t.content}</div>`
      : html`<div class="ins-msg ai" key=${t.id}>
          <div class="ins-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(t.content) }}></div>
          <div class="foot"><${CostNote} usd=${t.costUsd} model=${t.model} estimated=${t.costEstimated} />
            <span class="row" style="gap:2px"><span class="xs muted">${t.days}d context</span><${IconButton} icon="copy" label="Copy answer" sm onClick=${() => copy(t)} /></span></div>
        </div>`))}</div>` : null}
    <${AiStatus} task=${task} label=${task.phase === 'thinking' ? 'Reading your data…' : null} />
    <${AiError} error=${task.error} onRetry=${retry} />
    ${!task.busy ? html`<div class="ins-suggest">${suggestions(profile, hasCycle).map((q) => html`<button type="button" class="chip" onClick=${() => send(q)}>${q}</button>`)}</div>` : null}
    <div class="ins-compose" ref=${end}>
      <${Textarea} rows=${2} value=${text} onValue=${(v) => { setText(v); convo.draft = v; }} placeholder="Ask about your recovery, training, nutrition, schedule…" aria-label="Question"
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
      <${Button} variant="primary" icon="send" loading=${task.busy} disabled=${!text.trim()} onClick=${() => send()}>Ask</${Button}>
    </div>
  </div>`;
}
