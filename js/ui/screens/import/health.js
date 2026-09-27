// Import → Apple Health (#/import/health): paste or pick what an iOS Shortcut exported, preview days × fields
// (new / changed / unchanged), then upsert `health` records and weigh-ins. Parser: js/app/health-import.js.
import { html, useState, useEffect, useMemo } from '../../../vendor/preact-htm.js';
import { useApp, useVersion } from '../../ctx.js';
import { Page, Card, Button, Notice, Pill, Textarea, FileButton, Disclosure, cx } from '../../kit.js';
import { parseHealthExport, diffHealthDays, applyHealthImport, HEALTH_FIELDS } from '../../../app/health-import.js';
import { fmtNum, fmtDate } from '../../../core/util.js';

const EXAMPLE = `{ "days": [
  { "date": "2026-09-25", "steps": 9876, "activeKcal": 640,
    "restingKcal": 1890, "exerciseMin": 42, "standH": 12,
    "restingHr": 55, "hrvSdnn": 62, "vo2max": 47.1,
    "weightLb": 176.4, "bodyFatPct": 17.5 } ] }`;
const MAX_TEXTAREA = 200000;
const ROWS = 31;

export function HealthImport() {
  const app = useApp(); useVersion(['health', 'body']);
  const tz = app.dv.tz;
  const [text, setText] = useState('');
  const [file, setFile] = useState(null); // { name, size, content } when too large for the textarea
  const [result, setResult] = useState(null);
  const [done, setDone] = useState(null);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState('');
  const source = file ? file.content : text;
  useEffect(() => {
    if (!source.trim()) { setResult(null); return undefined; }
    const t = setTimeout(() => { try { setResult(parseHealthExport(source, { tz })); } catch (e) { console.warn('[health]', e); setResult({ days: [], warnings: ['Could not read this data: ' + e.message], format: null }); } }, 250);
    return () => clearTimeout(t);
  }, [source, tz]);
  const diff = useMemo(() => (result ? diffHealthDays(result.days, (d) => app.store.get('health', d)) : []), [result, app.store.version]);
  const counts = { new: diff.filter((d) => d.status === 'new').length, changed: diff.filter((d) => d.status === 'changed').length, same: diff.filter((d) => d.status === 'same').length };
  const toImport = diff.filter((d) => d.status !== 'same');
  const fields = HEALTH_FIELDS.filter((f) => diff.some((d) => d.day[f.key] != null));
  const rows = [...diff].reverse();

  const reset = () => { setText(''); setFile(null); setResult(null); setDone(null); setErr(''); setAll(false); };
  const paste = async () => {
    setErr('');
    try { const t = await navigator.clipboard.readText(); if (!t.trim()) { setErr('The clipboard is empty.'); return; } setFile(null); setDone(null); setText(t); }
    catch (e) { console.warn('[health] clipboard', e); setErr('Clipboard access was blocked. Long-press the box below and choose Paste.'); }
  };
  const pick = async (files) => {
    const f = files[0]; if (!f) return;
    setErr(''); setDone(null);
    try {
      const content = await f.text();
      if (content.length > MAX_TEXTAREA) { setText(''); setFile({ name: f.name, size: f.size, content }); } else { setFile(null); setText(content); }
    } catch (e) { setErr('Could not read ' + f.name + ': ' + (e.message || e)); }
  };
  const run = () => {
    const res = applyHealthImport(app.store, toImport.map((d) => d.day));
    setDone(res);
    app.toast(`Imported ${res.created + res.updated} day${res.created + res.updated === 1 ? '' : 's'} from Apple Health`);
  };

  return html`<${Page} wide title="Apple Health" sub="Daily data from an iOS Shortcut" back="/import">
    ${done ? html`<${Notice} tone="good"><div class="stack sm"><span><b>Imported.</b> ${done.created} new day${done.created === 1 ? '' : 's'}, ${done.updated} updated${done.unchanged ? `, ${done.unchanged} unchanged` : ''}${done.weighIns ? `; ${done.weighIns} weigh-in${done.weighIns === 1 ? '' : 's'} added to Body` : ''}.</span>
      <div class="row wrap" style="gap:8px"><${Button} size="sm" onClick=${reset}>Import more</${Button}><${Button} size="sm" variant="ghost" onClick=${() => app.nav('/insights/body')}>Open Insights → Body</${Button}></div></div></${Notice}>` : null}
    <div class="grid imp-grid">
      <${Card} title="1 · Data">
        <div class="stack sm">
          <div class="row wrap" style="gap:8px">
            ${typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText ? html`<${Button} size="sm" icon="copy" onClick=${paste}>Paste</${Button}>` : null}
            <${FileButton} accept=".json,.txt,.csv,application/json,text/plain,text/csv" onFiles=${pick} icon="file" size="sm">Choose file</${FileButton}>
            ${source ? html`<${Button} size="sm" variant="ghost" onClick=${reset}>Clear</${Button}>` : null}
          </div>
          ${file ? html`<div class="small dim"><span class="mono">${file.name}</span> · ${fmtNum(file.size / 1024)} KB loaded</div>`
            : html`<${Textarea} class="imp-drop" rows="7" value=${text} onValue=${(v) => { setText(v); setDone(null); }} placeholder="Paste the Shortcut output here — JSON or CSV" aria-label="Health data" spellcheck="false" />`}
          ${err ? html`<div class="xs ink-bad">${err}</div>` : null}
          <${Disclosure} summary="Accepted formats">
            <div class="stack sm small dim">
              <div><b>Days</b> — <span class="mono">{"days": [{date, steps, activeKcal, restingKcal, exerciseMin, standH, restingHr, hrvSdnn, vo2max, weightLb, bodyFatPct}]}</span>. Any subset of fields.</div>
              <div><b>Samples</b> — <span class="mono">{"samples": [{type, value, unit, start}]}</span> with Apple Health names (Steps, Active Energy, Resting Energy, Exercise Minutes, Stand Hours, Resting Heart Rate, Heart Rate Variability, VO2 Max, Weight / Body Mass, Body Fat Percentage). Summed per day (steps, energy, minutes, stand hours), averaged (resting HR, HRV) or the day's last value (VO₂ max, weight, body fat).</div>
              <div><b>CSV</b> — a header row with <span class="mono">date</span> plus field names; a unit in brackets is converted, e.g. <span class="mono">Weight (kg)</span>.</div>
              <div><b>Shortcut lists</b> — <span class="mono">{"dates": "…\\n…", "steps": "…\\n…"}</span>: newline-separated values aligned with the dates (the Shortcuts "Combine Text" output).</div>
              <div>Units are converted (kg → lb, kJ → kcal, body-fat fractions → %). Unknown fields are ignored; implausible values (e.g. HRV outside 5–300 ms, resting HR outside 25–150 bpm) are dropped and listed.</div>
              <div class="imp-code">${EXAMPLE}</div>
            </div>
          </${Disclosure}>
        </div>
      </${Card}>
      <${Card} title="2 · Preview" meta=${result && result.format ? { days: 'days', samples: 'samples', csv: 'CSV', lists: 'Shortcut lists' }[result.format] + ' format' : null}>
        ${!result ? html`<div class="small muted">Paste or choose the export to see which days and fields will be written. Nothing is saved until you import.</div>` : html`<div class="stack sm">
          ${diff.length ? html`<div class="row between wrap" style="gap:8px">
            <span class="small"><b>${diff.length} day${diff.length === 1 ? '' : 's'}</b> · ${fmtDate(diff[0].date)} – ${fmtDate(diff[diff.length - 1].date)}</span>
            <span class="imp-counts"><${Pill} tone=${counts.new ? 'accent' : null}>${counts.new} new</${Pill}><${Pill}>${counts.changed} changed</${Pill}><${Pill}>${counts.same} unchanged</${Pill}></span></div>` : null}
          ${result.warnings.length ? html`<${Notice} tone=${diff.length ? 'warn' : 'bad'}><div class="stack xs">${result.warnings.map((w) => html`<div class="small">${w}</div>`)}</div></${Notice}>` : null}
          ${diff.length ? html`<div class="imp-table-wrap"><table class="data">
            <thead><tr><th>Date</th><th></th>${fields.map((f) => html`<th class="num">${f.label}${f.unit ? html`<span class="muted"> ${f.unit}</span>` : null}</th>`)}</tr></thead>
            <tbody>${(all ? rows : rows.slice(0, ROWS)).map((d) => html`<tr>
              <td class="mono">${d.date}</td>
              <td>${d.status === 'new' ? html`<span class="tag accent-tag">new</span>` : d.status === 'changed' ? html`<span class="tag">changed</span>` : html`<span class="xs muted">same</span>`}</td>
              ${fields.map((f) => html`<td class=${cx('num', d.status === 'changed' && d.changed.includes(f.key) && 'chg')}>${d.day[f.key] == null ? '' : fmtNum(d.day[f.key], f.dp && d.day[f.key] % 1 ? 1 : 0)}</td>`)}</tr>`)}</tbody>
          </table></div>
          ${rows.length > ROWS && !all ? html`<div><${Button} size="sm" variant="ghost" onClick=${() => setAll(true)}>Show all ${rows.length} days</${Button}></div>` : null}
          <div class="xs muted">Imported days fill steps, energy, resting HR, HRV and VO₂ max where WHOOP has no data; a weight becomes a weigh-in (method “health”) only on days without another weigh-in.</div>
          <div class="row wrap" style="gap:8px"><${Button} variant="primary" icon="download" disabled=${!toImport.length} onClick=${run}>${toImport.length ? `Import ${toImport.length} day${toImport.length === 1 ? '' : 's'}` : 'Nothing new to import'}</${Button}></div>` : null}
        </div>`}
      </${Card}>
    </div>
    <${Card} title="Exporting from iPhone">
      <ol class="imp-steps">
        <li>In <b>Shortcuts</b>, add <b>Find Health Samples</b> for each type you want (Steps, Active Energy, Resting Heart Rate, Heart Rate Variability, Weight…), <b>grouped by Day</b>, for the last 30 days.</li>
        <li>Build a <b>Dictionary</b>: <span class="mono">dates</span> = the start dates, and one key per type (<span class="mono">steps</span>, <span class="mono">restingHr</span>…) = its values, each combined with new lines.</li>
        <li>End with <b>Copy to Clipboard</b> (or <b>Save File</b> to iCloud Drive as JSON).</li>
        <li>Run it, come back here, tap <b>Paste</b>, check the preview and import. Re-running is safe: unchanged days are skipped.</li>
      </ol>
    </${Card}>
  </${Page}>`;
}
