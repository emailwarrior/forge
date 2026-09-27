// Templates and exercise library: cards used on the Train overview and full pages (#/train/templates, #/train/exercises).
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics } from '../../ctx.js';
import { Page, Section, Button, Input, Select, List, ListRow, Empty, Icon } from '../../kit.js';
import { MUSCLES } from '../../../core/schema.js';
import { fmtDate } from '../../../core/util.js';
import { startWorkout } from '../../actions/workout.js';
import { filterExercises, rankExercises } from '../../parts/train-logic.js';
import { exerciseList } from '../../parts/train-data.js';
import { editTemplate, editExercise } from '../../parts/train-sheets.js';
import { cap, exName, exMeta, TYPES } from '../../parts/train-ui.js';

/* ------------------------------------------------------------ templates */
export function TemplatesCard({ full }) {
  const app = useApp(); useVersion(['templates', 'exercises']);
  const templates = app.dv.templates('workout').slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const lastUse = useAnalytics(() => { const m = new Map(); for (const s of app.dv.allSessions()) if (s.templateId) m.set(s.templateId, s.date); return m; }, []) || new Map();
  const ex = app.dv.exercises();
  const after = (r) => { if (r && r.start && r.id) startWorkout(app, { templateId: r.id }); };
  const create = async () => after(await editTemplate(app));
  const edit = async (t) => after(await editTemplate(app, { id: t.id }));
  return html`<${Section} title="Templates" meta=${templates.length ? `${templates.length} saved` : ''}
    action=${html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${create}>New</${Button}>`}>
    ${templates.length ? html`<div class="card flush"><${List}>${templates.map((t) => {
      const list = t.exercises || []; const sets = list.reduce((s, x) => s + (x.sets || 0), 0);
      const names = list.map((x) => exName(ex.get(x.exerciseId), x.exerciseId));
      return html`<${ListRow} key=${t.id} lead="layers" title=${t.name}
        meta=${`${list.length} exercise${list.length === 1 ? '' : 's'} · ${sets} sets${lastUse.get(t.id) ? ' · last ' + fmtDate(lastUse.get(t.id), { dow: false }) : ' · not used yet'}`}
        onClick=${() => edit(t)}
        trail=${html`<${Button} size="sm" onClick=${(e) => { e.stopPropagation(); startWorkout(app, { templateId: t.id }); }}>Start</${Button}>`}>
        ${full || names.length ? html`<div class="xs muted tr-names">${names.join(' · ')}</div>` : null}
      </${ListRow}>`;
    })}</${List}></div>`
      : html`<${Empty} title="No templates yet" action=${html`<${Button} icon="plus" onClick=${create}>New template</${Button}>`}>
        Save each day of your split once (e.g. Push, Pull, Legs). Starting from a template pre-fills sets and rep targets, with weights from your last session.</${Empty}>`}
  </${Section}>`;
}

/* ------------------------------------------------------ exercise library */
export function LibraryCard({ full, limit = 8 }) {
  const app = useApp(); useVersion(['exercises']);
  const [q, setQ] = useState(''); const [type, setType] = useState(''); const [muscle, setMuscle] = useState('');
  const usage = useAnalytics(() => new Map(rankExercises(app.dv.allSessions()).map((r) => [r.id, r])), []) || new Map();
  const all = exerciseList(app.dv);
  const results = filterExercises(all, { query: q, type, muscle })
    .sort((a, b) => ((usage.get(b.id) || {}).count || 0) - ((usage.get(a.id) || {}).count || 0) || String(a.name).localeCompare(String(b.name)));
  const filtered = !!(q.trim() || type || muscle);
  const shown = full || filtered ? results : results.slice(0, limit);
  const add = async () => { const id = await editExercise(app, { name: q.trim(), type: type || 'strength' }); if (id && id !== 'deleted') app.nav('/train/exercise/' + id); };
  return html`<${Section} title="Exercise library" meta=${`${all.length} exercises`}
    action=${html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${add}>New</${Button}>`}>
    <div class="tr-lib-controls">
      <div class="tr-search"><${Icon} name="search" size=${16} /><${Input} value=${q} onValue=${setQ} placeholder="Search name, muscle, equipment" aria-label="Search exercises" /></div>
      <${Select} value=${type} onValue=${setType} aria-label="Type" options=${[{ value: '', label: 'All types' }, ...TYPES]} />
      <${Select} value=${muscle} onValue=${setMuscle} aria-label="Muscle" options=${[{ value: '', label: 'All muscles' }, ...MUSCLES.map((m) => ({ value: m, label: cap(m) }))]} />
    </div>
    ${shown.length ? html`<div class="card flush"><${List}>${shown.map((x) => {
      const u = usage.get(x.id);
      return html`<${ListRow} key=${x.id} title=${x.name} onClick=${() => app.nav('/train/exercise/' + x.id)}
        meta=${`${exMeta(x)} · ${u ? `${u.count}× · last ${fmtDate(u.last, { dow: false })}` : 'not logged yet'}`} />`;
    })}</${List}></div>`
      : html`<${Empty} title="No match" action=${q.trim() ? html`<${Button} icon="plus" onClick=${add}>Create “${q.trim()}”</${Button}>` : null}>Nothing in the library matches these filters.</${Empty}>`}
    ${!full && !filtered && results.length > shown.length ? html`<${Button} variant="ghost" block onClick=${() => app.nav('/train/exercises')}>Show all ${results.length} exercises</${Button}>` : null}
  </${Section}>`;
}

export function TemplatesPage() {
  return html`<${Page} title="Templates" sub="Your split, ready to start" back="/train" wide><${TemplatesCard} full /></${Page}>`;
}
export function ExercisesPage() {
  return html`<${Page} title="Exercise library" sub="Search, filter, add your own" back="/train" wide><${LibraryCard} full /></${Page}>`;
}
