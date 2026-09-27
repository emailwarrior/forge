// Settings → Data: decrypted backup export (with a clear warning), import links, storage stats.
import { html, useState } from '../../../vendor/preact-htm.js';
import { useApp, useAnalytics, useSyncStatus, useWide } from '../../ctx.js';
import { Button, Notice, Icon, Stat, Disclosure } from '../../kit.js';
import { Block, saveFile } from '../../parts/settings-ui.js';
import { backupFileName, collectionStats, COLLECTION_LABELS } from '../../parts/settings-util.js';
import { exportBackup } from '../../../app/backup.js';
import { fmtNum } from '../../../core/util.js';

const IMPORTS = [
  { kind: 'backup', icon: 'history', title: 'FORGE backup', sub: 'A file exported here. Merges record by record; newer edits win, nothing is overwritten blindly.' },
  { kind: 'v2', icon: 'file', title: 'FORGE v2 data', sub: 'forge-data.json from the old app: habits, check-ins, finance months, saved quotes and notes.' },
  { kind: 'health', icon: 'heart', title: 'Apple Health', sub: 'Daily totals exported by the iOS Shortcut: steps, energy, resting HR, HRV, VO₂ max, weight.' },
];

export default function DataSection() {
  const app = useApp(); const sync = useSyncStatus(); const wide = useWide();
  const [last, setLast] = useState(null);
  const stats = useAnalytics(() => collectionStats(app.store), []);
  const vault = app.session.vault;
  const exportNow = async () => {
    const ok = await app.confirm({
      title: 'Export an unencrypted backup?',
      message: 'The file contains every record in readable form: meals, labs, protocols, finances and journal. Save it somewhere private and delete it when you no longer need it.',
      confirmLabel: 'Export',
    });
    if (!ok) return;
    try {
      const obj = exportBackup(app.store);
      const name = backupFileName(app.today());
      const how = await saveFile(new Blob([JSON.stringify(obj)], { type: 'application/json' }), name);
      if (how === 'cancelled') { app.toast('Export cancelled'); return; }
      setLast({ name, records: obj.records });
      app.toast(`Exported ${fmtNum(obj.records)} records`);
    } catch (e) { console.warn(e); app.toast('Export failed: ' + (e.message || e), { tone: 'error' }); }
  };
  return html`<div class="stack lg">
    <${Block} title="Backup" desc="Your vault on GitHub is already the encrypted, versioned copy of everything. This export is an extra, portable copy you control.">
      <${Notice} tone="warn">The backup file is <b>not encrypted</b>. Anyone who gets the file can read your meals, labs, protocols and finances. Photos and lab files are not included; they stay encrypted in the vault.</${Notice}>
      <div class="set-actions"><${Button} icon="download" onClick=${exportNow}>Export decrypted backup</${Button}></div>
      ${last ? html`<div class="xs muted">Saved ${last.name} · ${fmtNum(last.records)} records (including deleted ones, so a restore merges correctly).</div>` : html`<div class="xs muted">File name: ${backupFileName(app.today())}. Server-only tokens are never exported.</div>`}
    </${Block}>

    <${Block} title="Import">
      <div class="card flush"><div class="list">${IMPORTS.map((i) => html`<div class="list-row link" key=${i.kind} role="button" tabIndex="0"
          onClick=${() => app.nav('/import/' + i.kind)} onKeyDown=${(e) => { if (e.key === 'Enter') app.nav('/import/' + i.kind); }}>
          <div class="lead"><${Icon} name=${i.icon} /></div>
          <div class="grow"><div class="title">${i.title}</div><div class="meta" style="white-space:normal">${i.sub}</div></div>
          <${Icon} name="chevronRight" size=${16} class="muted" /></div>`)}</div></div>
    </${Block}>

    <${Block} title="Storage" desc=${vault ? html`<span class="set-code">${vault.owner}/${vault.repo}</span> (private, encrypted)` : 'Demo: in memory only, discarded on reload.'}>
      ${stats ? html`<div class="grid four set-stats">
        <${Stat} label="Records" value=${fmtNum(stats.live)} />
        <${Stat} label="Deleted, kept for sync" value=${fmtNum(stats.deleted)} />
        <${Stat} label="Data files" value=${fmtNum(stats.shards)} />
        <${Stat} label="Waiting to upload" value=${app.demo ? '—' : fmtNum(sync.pending || 0)} />
      </div>
      <${Disclosure} summary=${`Records by collection (${stats.rows.length})`} open=${wide}>
        <div class="table-wrap"><table class="data set-table">
          <thead><tr><th>Collection</th><th class="num">Records</th><th class="num">Deleted</th><th class="num">Files</th></tr></thead>
          <tbody>${stats.rows.map((r) => html`<tr key=${r.name}><td>${COLLECTION_LABELS[r.name] || r.name}${r.owner === 'server' ? html` <span class="tag">server</span>` : null}</td>
            <td class="num">${fmtNum(r.live)}</td><td class="num">${r.deleted ? fmtNum(r.deleted) : '—'}</td><td class="num">${r.shards}</td></tr>`)}</tbody>
        </table></div>
        <div class="xs muted" style="margin-top:8px">Deleted records are kept for 180 days so every device learns about the deletion. “server” collections are written only by the automation.</div>
      </${Disclosure}>` : null}
    </${Block}>
  </div>`;
}
