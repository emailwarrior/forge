// Train: #/train (overview), #/train/session/<id> (logger), #/train/exercise/<id> (history),
// #/train/templates, #/train/exercises. Sub-views load lazily; the rest timer bar spans all of them.
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { Spinner, Page, Empty, Button } from '../kit.js';
import { useApp } from '../ctx.js';
import { RestBar } from '../parts/train-ui.js';

const VIEWS = {
  overview: () => import('./train/overview.js'),
  session: () => import('./train/session.js'),
  exercise: () => import('./train/exercise.js'),
  library: () => import('./train/library.js'),
};
const loading = new Map(); const ready = new Map();
const load = (name) => {
  if (!loading.has(name)) loading.set(name, VIEWS[name]().then((m) => { ready.set(name, m); return m; }).catch((e) => { loading.delete(name); throw e; }));
  return loading.get(name);
};

// Loaded views render synchronously (no spinner flash when moving between Train sub-routes).
function useView(name) {
  const [, force] = useState(0);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (ready.has(name)) return undefined;
    let alive = true;
    load(name).then(() => { if (alive) force((n) => n + 1); }).catch((e) => { console.warn('[train] view', e); if (alive) setErr({ name, e }); });
    return () => { alive = false; };
  }, [name]);
  useEffect(() => { // warm the other views once the first one is up
    const t = setTimeout(() => { for (const k of Object.keys(VIEWS)) load(k).catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, []);
  return { mod: ready.get(name) || null, err: err && err.name === name ? err.e : null };
}

export default function Screen({ route }) {
  const app = useApp();
  const sub = route.parts[1] || '';
  const arg = route.parts[2] || '';
  const name = sub === 'session' && arg ? 'session' : sub === 'exercise' && arg ? 'exercise' : sub === 'templates' || sub === 'exercises' ? 'library' : 'overview';
  const { mod, err } = useView(name);
  let body;
  if (err) body = html`<${Page} title="Train" back="/train"><${Empty} title="Could not load this view" action=${html`<${Button} onClick=${() => location.reload()}>Reload</${Button}>`}>Check the connection and reload.</${Empty}></${Page}>`;
  else if (!mod) body = html`<div class="page"><div class="row" style="padding:40px 0;justify-content:center"><${Spinner} /></div></div>`;
  else if (name === 'session') body = html`<${mod.default} key=${arg} id=${arg} />`;
  else if (name === 'exercise') body = html`<${mod.default} key=${arg} id=${arg} />`;
  else if (name === 'library') body = sub === 'templates' ? html`<${mod.TemplatesPage} />` : html`<${mod.ExercisesPage} />`;
  else body = html`<${mod.default} />`;
  return html`<div class="tr-root">${body}</div>${app ? html`<${RestBar} />` : null}`;
}
