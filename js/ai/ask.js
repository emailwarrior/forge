// FORGE AI layer: free-form questions about the user's data ("Ask FORGE").
// The context pack (analytics/context.js) goes into the system prompt; when it is large it carries a
// prompt-cache breakpoint so follow-up questions within ~5 minutes read it at the cache price.
import { callClaude, textOf } from './claude.js';
import { AIError } from './errors.js';
import { askSystemPrompt, clip } from './prompts.js';

const CACHE_MIN_CHARS = 6000;   // below ~1.5K tokens caching does not pay off (or is ignored)
const MAX_HISTORY_TURNS = 20;
const MAX_TURN_CHARS = 8000;

/**
 * askForge(ai, { question, contextPack, history:[{role, content}], today?, model?, signal?, onProgress? })
 * → { answer (markdown), model, costUsd, costEstimated, usage }
 */
export async function askForge(ai, { question, contextPack, history = [], today, model, signal, onProgress } = {}) {
  const q = clip(question, 4000);
  if (!q) throw new AIError('bad-request', 'Ask a question.');
  const system = [{ type: 'text', text: askSystemPrompt({ today }) }];
  const ctx = String(contextPack || '').trim();
  if (ctx) {
    const block = { type: 'text', text: 'FORGE context pack (the user\'s data):\n\n' + ctx };
    if (ctx.length >= CACHE_MIN_CHARS) block.cache_control = { type: 'ephemeral' };
    system.push(block);
  } else {
    system.push({ type: 'text', text: 'No FORGE data was provided with this question; say so if the answer depends on it.' });
  }
  const messages = conversation(history, q);
  const res = await callClaude(ai, {
    model: model || (ai && ai.model),
    system, messages,
    maxTokens: 8000,
    signal, onProgress,
  });
  const answer = textOf(res.content).trim();
  if (!answer) throw new AIError('parse', 'Claude returned an empty answer.', { requestId: res.requestId });
  return { answer, model: res.model, costUsd: res.costUsd, costEstimated: res.costEstimated, usage: res.usage };
}

// Clean, alternating user/assistant turns that start with the user and end with the new question.
function conversation(history, question) {
  const turns = [];
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
    const text = clip(contentText(h.content), MAX_TURN_CHARS);
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === h.role) last.content += '\n\n' + text;
    else turns.push({ role: h.role, content: text });
  }
  let recent = turns.slice(-MAX_HISTORY_TURNS);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  const last = recent[recent.length - 1];
  if (last && last.role === 'user') last.content += '\n\n' + question; // unanswered earlier question
  else recent.push({ role: 'user', content: question });
  return recent;
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  return '';
}
