// FORGE Import (#/import[/<kind>]): Apple Health (health), meal photos from a Shortcut (meals), FORGE v2 (v2),
// FORGE v3 backup (backup). The Apple Health importer lives in ./import/health.js.
import { html, useState } from '../../vendor/preact-htm.js';
import { useApp } from '../ctx.js';
import { Page, Card, List, ListRow, Button, Notice, KV, FileButton, Empty, cx } from '../kit.js';
import { HealthImport } from './import/health.js';
import { openMealCapture } from '../actions/meal.js';
import { buildV2Migration, isV2Data } from '../../core/migrate.js';
import { describeBackup, importBackup, isBackup } from '../../app/backup.js';
import { fmtNum, fmtDate } from '../../core/util.js';

const KINDS = [
  { id: 'health', icon: 'heart', title: 'Apple Health', sub: 'Steps, energy, resting HR, HRV, VO₂ max, weight — from an iOS Shortcut' },
  { id: 'meals', icon: 'camera', title: 'Meal photos', sub: 'Shortcut photos in iCloud Drive → meals at their capture times' },
  { id: 'v2', icon: 'history', title: 'FORGE v2', sub: 'forge-data.json: standards, check-offs, snapshots, quotes, notes' },
  { id: 'backup', icon: 'upload', title: 'FORGE backup', sub: 'A backup from Settings → Data, merged — newer edits win' },
];

export default function Screen({ route }) {
  const kind = route.parts[1] || '';
  if (kind === 'health') return html`<${HealthImport} />`;
  if (kind === 'meals') return html`<${MealsImport} />`;
  if (kind === 'v2') return html`<${V2Import} />`;
  if (kind === 'backup') return html`<${BackupImport} />`;
  return html`<${ImportIndex} unknown=${kind} />`;
}

function ImportIndex({ unknown }) {
  const app = useApp();
  return html`<${Page} title="Import" sub="Bring data into this vault" back>
    ${unknown ? html`<${Notice} tone="warn">There is no importer called “${unknown}”.</${Notice}>` : null}
    <${Card} flush><div class="imp-list"><${List}>${KINDS.map((k) => html`<${ListRow} key=${k.id} lead=${k.icon} title=${k.title} meta=${k.sub} onClick=${() => app.nav('/import/' + k.id)} />`)}</${List}></div></${Card}>
    <div class="xs muted">Imports are merged into your encrypted vault and sync like any other change. Exports and backups: Settings → Data.</div>
  </${Page}>`;
}

/* -------------------------------------------------------------- meal photos */
function MealsImport() {
  const app = useApp();
  return html`<${Page} title="Meal photos" sub="Snap with a Shortcut now, import and analyze later" back="/import">
    <${Card} title="Shortcut workflow">
      <ol class="imp-steps">
        <li>In <b>Shortcuts</b>, create a shortcut: <b>Take Photo</b> → <b>Format Date</b> (Current Date, custom format <span class="mono">yyyy-MM-dd_HH-mm-ss</span>) → <b>Save File</b> to <b>iCloud Drive / FORGE / Meals</b> named <span class="mono">meal_</span> + the formatted date + <span class="mono">.jpg</span>, with “Ask Where to Save” off.</li>
        <li>Put it on the Home Screen or the Action button and snap every meal with it — FORGE does not need to be open.</li>
        <li>Later, open <b>Fuel → Files</b> (or the button below), go to FORGE / Meals and <b>Select</b> the new photos.</li>
        <li>Check the times and meals in the review — photos within 10 minutes become one meal — add notes, then <b>Save & analyze</b>. Move the imported files out of the folder afterwards.</li>
      </ol>
    </${Card}>
    <div class="grid two imp-actions">
      <${Button} variant="primary" icon="folder" block onClick=${() => openMealCapture(app, { mode: 'files' })}>Import from Files</${Button}>
      <${Button} icon="image" block onClick=${() => openMealCapture(app, { mode: 'library' })}>From Photos</${Button}>
    </div>
    <${Notice}>Picking from the photo library on iPhone often drops the capture time (Safari strips EXIF), so those meals default to the file date and are marked “check time”. File names from the Shortcut keep the exact time.</${Notice}>
  </${Page}>`;
}

/* ------------------------------------------------------------------- FORGE v2 */
async function readJson(file) {
  const text = await file.text();
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error(`${file.name} is not valid JSON.`); }
}

function V2Import() {
  const app = useApp();
  const [st, setSt] = useState({ name: '', obj: null, preview: null, error: '', result: null, busy: false });
  const pick = async (files) => {
    const f = files[0]; if (!f) return;
    try {
      const obj = await readJson(f);
      if (!isV2Data(obj)) throw new Error('That file is not a FORGE v2 export (forge-data.json).');
      setSt({ name: f.name, obj, preview: buildV2Migration(obj, { tz: app.dv.tz }).summary, error: '', result: null, busy: false });
    } catch (e) { setSt({ name: f.name, obj: null, preview: null, error: e.message || String(e), result: null, busy: false }); }
  };
  const run = () => {
    try { const result = app.session.importV2(st.obj); setSt((s) => ({ ...s, result })); app.toast('FORGE v2 data imported'); }
    catch (e) { console.warn('[import v2]', e); setSt((s) => ({ ...s, error: e.message || String(e) })); }
  };
  const summary = (s) => html`<${KV} items=${[
    ['Standards', fmtNum(s.standards)], ['Check-offs', fmtNum(s.checks)], ['Monthly snapshots', fmtNum(s.snapshots)],
    ['Saved quotes', fmtNum(s.savedQuotes)], ['Journal notes', fmtNum(s.journal)],
    s.skipped && s.skipped.length ? ['Skipped standards', s.skipped.join(', ')] : null,
  ]} />`;
  return html`<${Page} title="FORGE v2" sub="Import forge-data.json from the old app" back="/import">
    <${Card}>
      <div class="stack sm">
        <div class="small dim">Standards (with auto sources where they map), daily check-offs, finance snapshots and settings, saved quotes and notes. Records keep stable ids, so importing twice changes nothing and later edits in v3 win.</div>
        <div><${FileButton} accept=".json,application/json" onFiles=${pick} icon="file" variant=${st.preview ? null : 'primary'}>${st.name ? 'Choose another file' : 'Choose forge-data.json'}</${FileButton}></div>
        ${st.error ? html`<${Notice} tone="bad">${st.error}</${Notice}>` : null}
      </div>
    </${Card}>
    ${st.preview && !st.result ? html`<${Card} title="Found in ${st.name}">
      <div class="stack">${summary(st.preview)}
        <div><${Button} variant="primary" icon="download" onClick=${run}>Import into this vault</${Button}></div></div></${Card}>` : null}
    ${st.result ? html`<${Notice} tone="good"><div class="stack sm"><b>Imported.</b>${summary(st.result)}
      <div class="row wrap" style="gap:8px"><${Button} size="sm" onClick=${() => app.nav('/today')}>Open Today</${Button}><${Button} size="sm" variant="ghost" onClick=${() => app.nav('/settings/standards')}>Review standards</${Button}></div></div></${Notice}>` : null}
  </${Page}>`;
}

/* --------------------------------------------------------------- FORGE backup */
function BackupImport() {
  const app = useApp();
  const [st, setSt] = useState({ name: '', obj: null, rows: null, error: '', result: null });
  const pick = async (files) => {
    const f = files[0]; if (!f) return;
    try {
      const obj = await readJson(f);
      if (!isBackup(obj)) throw new Error('That file is not a FORGE backup. Backups come from Settings → Data → Export.');
      setSt({ name: f.name, obj, rows: describeBackup(obj).sort((a, b) => Number(b.importable) - Number(a.importable) || b.count - a.count), error: '', result: null });
    } catch (e) { setSt({ name: f.name, obj: null, rows: null, error: e.message || String(e), result: null }); }
  };
  const rows = st.rows || [];
  const importable = rows.filter((r) => r.importable);
  const nRec = importable.reduce((s, r) => s + r.count, 0);
  const run = async () => {
    const ok = await app.confirm({ title: 'Merge this backup?', message: `${fmtNum(nRec)} records in ${importable.length} collections are merged into this vault. For each field the newer edit wins; deletions in the backup apply only where they are newer than your changes.`, confirmLabel: 'Merge' });
    if (!ok) return;
    try { const result = importBackup(app.store, st.obj); setSt((s) => ({ ...s, result })); app.toast(`Merged ${fmtNum(result.records)} records`); }
    catch (e) { console.warn('[import backup]', e); setSt((s) => ({ ...s, error: e.message || String(e) })); }
  };
  const exported = st.obj && st.obj.exportedAt ? String(st.obj.exportedAt) : '';
  return html`<${Page} title="FORGE backup" sub="Merge a backup file into this vault" back="/import">
    <${Card}>
      <div class="stack sm">
        <div class="small dim">Restores or combines data from a FORGE backup. Server-written data (WHOOP, calendar) is skipped — automation syncs it again.</div>
        <div><${FileButton} accept=".json,application/json" onFiles=${pick} icon="file" variant=${st.rows ? null : 'primary'}>${st.name ? 'Choose another file' : 'Choose backup file'}</${FileButton}></div>
        ${st.error ? html`<${Notice} tone="bad">${st.error}</${Notice}>` : null}
      </div>
    </${Card}>
    ${st.rows && !st.result ? html`<${Card} title=${st.name} meta=${exported ? 'exported ' + fmtDate(exported.slice(0, 10), { year: true }) : null}>
      <div class="stack">
        ${rows.length ? html`<div class="imp-table-wrap"><table class="data"><thead><tr><th>Collection</th><th class="num">Records</th><th>Import</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr><td class="mono">${r.name}</td><td class="num">${fmtNum(r.count)}</td>
            <td class=${cx(!r.importable && 'muted')}>${r.importable ? 'Merge' : 'Skipped (server)'}</td></tr>`)}</tbody></table></div>`
          : html`<${Empty} title="Empty backup">This file contains no records.</${Empty}>`}
        ${importable.length ? html`<div><${Button} variant="primary" icon="download" onClick=${run}>Merge ${fmtNum(nRec)} records</${Button}></div>` : null}
      </div></${Card}>` : null}
    ${st.result ? html`<${Notice} tone="good"><div class="stack sm"><span><b>Merged.</b> ${fmtNum(st.result.records)} records in ${st.result.collections} collection${st.result.collections === 1 ? '' : 's'}${st.result.skipped.length ? `; skipped ${st.result.skipped.join(', ')}` : ''}. The changes sync on the next push.</span>
      <div><${Button} size="sm" onClick=${() => app.nav('/today')}>Open Today</${Button}></div></div></${Notice}>` : null}
  </${Page}>`;
}
