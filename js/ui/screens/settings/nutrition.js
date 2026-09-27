// Settings → Nutrition rules: the owner's own best-practice rules (settings nutritionRules.rules
// [{id, text, active}]), sent with every meal analysis and daily review. Add, edit inline, toggle,
// reorder, delete with Undo; generic evidence-based examples as one-tap suggestions (never defaults).
import { html, useState, useEffect, useRef } from '../../../vendor/preact-htm.js';
import { useApp, useVersion } from '../../ctx.js';
import { Button, IconButton, Toggle, Empty } from '../../kit.js';
import { Block, noteSaved } from '../../parts/settings-ui.js';
import { openSuggestions, moveItem } from '../../parts/settings-util.js';
import { uid } from '../../../core/util.js';

const MAX_LEN = 160;

export default function NutritionSection() {
  const app = useApp(); useVersion(['settings']);
  const rules = app.store.setting('nutritionRules').rules || [];
  const [text, setText] = useState('');
  const [reordering, setReordering] = useState(false);
  const latest = () => app.store.setting('nutritionRules').rules || [];
  const write = (next) => { app.store.updateSetting('nutritionRules', { rules: next }); noteSaved(); };
  const add = (raw) => {
    const t = String(raw || '').trim().slice(0, MAX_LEN); if (!t) return;
    if (latest().some((r) => String(r.text || '').trim().toLowerCase() === t.toLowerCase())) { app.toast('That rule is already in the list'); return; }
    write([...latest(), { id: uid(8), text: t, active: true }]);
  };
  const remove = (id) => {
    const before = latest(); const idx = before.findIndex((r) => r.id === id); if (idx < 0) return;
    const rule = before[idx];
    write(before.filter((r) => r.id !== id));
    app.toast('Rule deleted', { action: { label: 'Undo', onClick: () => { const cur = latest(); if (cur.some((r) => r.id === id)) return; const next = [...cur]; next.splice(Math.min(idx, next.length), 0, rule); write(next); } } });
  };
  const patch = (id, p) => write(latest().map((r) => (r.id === id ? { ...r, ...p } : r)));
  const move = (id, dir) => write(moveItem(latest(), id, dir));
  const suggestions = openSuggestions(rules);
  const active = rules.filter((r) => r.active !== false).length;
  return html`<div class="stack lg">
    <${Block} title=${rules.length ? `Your rules · ${active} of ${rules.length} active` : 'Your rules'}
      desc="Active rules are sent with every meal analysis and every daily nutrition review, and the AI grades each day against them. Keep each rule short and checkable."
      action=${rules.length > 1 ? html`<${Button} size="sm" variant=${reordering ? 'primary' : undefined} icon=${reordering ? 'check' : 'grip'} onClick=${() => setReordering(!reordering)}>${reordering ? 'Done' : 'Reorder'}</${Button}>` : null}>
      ${rules.length ? html`<div class="card flush"><div class="list">
          ${rules.map((r, i) => html`<${RuleRow} key=${r.id} rule=${r} reordering=${reordering} first=${i === 0} last=${i === rules.length - 1}
            onText=${(t) => patch(r.id, { text: t })} onToggle=${(on) => patch(r.id, { active: on })} onDelete=${() => remove(r.id)} onMove=${(d) => move(r.id, d)} />`)}
        </div></div>`
        : html`<${Empty} title="No rules yet">Write rules the way you would brief a nutritionist, e.g. “40 g protein at breakfast” or “No fried food on weekdays”. Or start from a suggestion below.</${Empty}>`}
      <form class="set-add-row" onSubmit=${(e) => { e.preventDefault(); add(text); setText(''); }}>
        <input class="input" value=${text} maxlength=${MAX_LEN} placeholder="Add a rule, e.g. Protein at breakfast, 40 g+" aria-label="New rule"
          onInput=${(e) => setText(e.currentTarget.value)} />
        <${Button} type="submit" icon="plus" disabled=${!text.trim()}>Add</${Button}>
      </form>
    </${Block}>
    ${suggestions.length ? html`<${Block} title="Suggestions" desc="Generic, evidence-based starting points. Tap one to add it; edit it to fit you. Nothing is added unless you tap.">
      <div class="set-suggest">${suggestions.map((s) => html`<button type="button" class="chip" key=${s} onClick=${() => { add(s); app.toast('Rule added'); }}>+ ${s}</button>`)}</div>
    </${Block}>` : null}
  </div>`;
}

function RuleRow({ rule, reordering, first, last, onText, onToggle, onDelete, onMove }) {
  const [text, setText] = useState(rule.text || '');
  const editing = useRef(false); const timer = useRef(null); const ref = useRef(null);
  useEffect(() => { if (!editing.current) setText(rule.text || ''); }, [rule.text]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Grow with the text so a rule is always fully readable (no horizontal scrolling on a phone).
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }, [text]);
  const commit = (v) => { clearTimeout(timer.current); const t = v.replace(/\s+/g, ' ').trim(); if (t && t !== rule.text) onText(t.slice(0, MAX_LEN)); };
  const on = rule.active !== false;
  return html`<div class="list-row set-rule">
    <${Toggle} checked=${on} onValue=${onToggle} label=${on ? 'Rule on' : 'Rule off'} />
    <textarea ref=${ref} rows="1" class=${'textarea set-rule-text' + (on ? '' : ' off')} value=${text} maxlength=${MAX_LEN} aria-label="Rule text"
      onFocus=${() => { editing.current = true; }}
      onInput=${(e) => { const v = e.currentTarget.value.replace(/\n/g, ' '); setText(v); clearTimeout(timer.current); timer.current = setTimeout(() => commit(v), 600); }}
      onBlur=${(e) => { editing.current = false; const v = e.currentTarget.value; if (!v.trim()) setText(rule.text || ''); else commit(v); }}
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}></textarea>
    ${reordering ? html`<span class="row" style="gap:2px"><${IconButton} icon="chevronUp" label="Move up" sm bordered disabled=${first} onClick=${() => onMove(-1)} />
        <${IconButton} icon="chevronDown" label="Move down" sm bordered disabled=${last} onClick=${() => onMove(1)} /></span>`
      : html`<${IconButton} icon="trash" label="Delete rule" sm onClick=${onDelete} />`}
  </div>`;
}
