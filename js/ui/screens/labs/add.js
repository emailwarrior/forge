// Lab panel sheet: upload (PDF/photos → AI extraction) → review every marker → save; manual entry; edit.
// openLabSheet(app, { mode: 'upload'|'manual', id }) → Promise<labId|undefined>
// Originals are stored encrypted via session.putMedia('labs', collectedAt, `${id}-${i}`, bytes, mediaType) on save.
import { html, useState, useEffect, useRef } from '../../../vendor/preact-htm.js';
import { useApp } from '../../ctx.js';
import {
  Button, Field, IconButton, Input, NumberInput, Select, SheetFoot, SheetHead, Textarea, Segmented, FileButton, Notice, Icon, Disclosure, cx,
} from '../../kit.js';
import { useAiTask, AiStatus, AiError, CostNote, AiKeyNotice } from '../../parts/ai.js';
import { extractLabs, prepareImage } from '../../../ai/index.js';
import { bytesToB64, nowIso, uid } from '../../../core/util.js';
import {
  FLAGS, newRow, autoFlag, rowsFromExtraction, rowsFromPanel, reviewMarkers, keyForName, isCatalogKey, catalogName, fileKind,
  MAX_UPLOAD_FILES, MAX_UPLOAD_BYTES,
} from '../../parts/records-labs.js';
import { plural } from '../../parts/records-util.js';
import { DateInput } from '../../parts/records-ui.js';

export function openLabSheet(app, { mode = 'upload', id } = {}) {
  return app.sheet(({ close }) => html`<${LabSheet} mode=${mode} id=${id} close=${close} />`, { wide: true, modal: true });
}

const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

function LabSheet({ mode, id, close }) {
  const app = useApp(); const tz = app.dv.tz; const today = app.today();
  const existing = id ? app.store.get('labs', id) : null;
  const [step, setStep] = useState(existing || mode === 'manual' ? 'review' : 'upload');
  const [files, setFiles] = useState([]); // [{ key, name, kind, mediaType, bytes, size, url }]
  const [note, setNote] = useState(existing ? existing.note || '' : '');
  const [rows, setRows] = useState(() => (existing ? rowsFromPanel(existing) : [newRow()]));
  const [collectedAt, setCollectedAt] = useState(existing ? String(existing.collectedAt || existing.date || '').slice(0, 10) || today : today);
  const [lab, setLab] = useState(existing ? existing.lab || '' : '');
  const [extraction, setExtraction] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [missing, setMissing] = useState([]);
  const task = useAiTask();
  const hasKey = !!app.ai();
  const urls = useRef([]);
  const dirty = useRef(false);
  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); }, []);

  const addFiles = async (list) => {
    setErr(''); setPreparing(true);
    const out = []; const problems = [];
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const file of list) {
      if (files.length + out.length >= MAX_UPLOAD_FILES) { problems.push(`At most ${MAX_UPLOAD_FILES} files per panel.`); break; }
      const kind = fileKind(file);
      if (!kind) { problems.push(`${file.name}: not a PDF or image.`); continue; }
      try {
        let bytes, mediaType;
        if (kind === 'pdf') { bytes = new Uint8Array(await file.arrayBuffer()); mediaType = 'application/pdf'; }
        else { const img = await prepareImage(file, { maxEdge: 1568, quality: 0.9 }); bytes = img.bytes; mediaType = img.mediaType; }
        if (total + bytes.length > MAX_UPLOAD_BYTES) { problems.push(`${file.name}: over the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB total for one panel.`); continue; }
        total += bytes.length;
        let url = null;
        if (kind === 'image') { url = URL.createObjectURL(new Blob([bytes], { type: mediaType })); urls.current.push(url); }
        out.push({ key: uid(8), name: file.name || (kind === 'pdf' ? 'report.pdf' : 'photo.jpg'), kind, mediaType, bytes, size: bytes.length, url });
      } catch (e) {
        console.warn('[labs] file', e);
        problems.push(`${file.name}: ${e && e.message ? e.message : 'could not be read'}`);
      }
    }
    if (out.length) { dirty.current = true; setFiles((f) => [...f, ...out]); }
    if (problems.length) setErr(problems.join(' '));
    setPreparing(false);
  };
  const removeFile = (key) => setFiles((l) => l.filter((f) => f.key !== key));

  const extract = async () => {
    setErr('');
    const res = await task.run(({ ai, signal, onProgress }) => extractLabs(ai, {
      files: files.map((f) => ({ data: bytesToB64(f.bytes), mediaType: f.mediaType })), note: note.trim() || undefined, signal, onProgress,
    }));
    if (!res) return;
    dirty.current = true;
    setRows(res.markers.length ? rowsFromExtraction(res) : [newRow()]);
    if (res.collectedAt) setCollectedAt(res.collectedAt);
    if (res.lab) setLab(res.lab);
    setExtraction({ model: res.model, costUsd: res.costUsd, costEstimated: res.costEstimated, notes: res.notes || [], count: res.markers.length, at: nowIso(tz), dateFound: !!res.collectedAt });
    setStep('review');
  };

  const setRow = (rid, patch) => { dirty.current = true; setRows((l) => l.map((r) => (r.rid === rid ? { ...r, ...patch } : r))); if (missing.includes(rid)) setMissing((m) => m.filter((x) => x !== rid)); };
  const addRow = () => { dirty.current = true; setRows((l) => [...l, newRow()]); };
  const removeRow = (rid) => { dirty.current = true; setRows((l) => (l.length > 1 ? l.filter((r) => r.rid !== rid) : [newRow()])); };

  const save = async () => {
    setErr('');
    const { markers, missing: miss } = reviewMarkers(rows);
    if (!collectedAt) { setErr('Set the collection date.'); return; }
    if (collectedAt > today) { setErr('The collection date is in the future.'); return; }
    if (!markers.length) { setErr('Add at least one result.'); return; }
    if (miss.length) { setMissing(miss); setErr(`${plural(miss.length, 'row')} ${miss.length === 1 ? 'has' : 'have'} a name or a value missing. Complete or remove ${miss.length === 1 ? 'it' : 'them'}.`); return; }
    setSaving(true);
    const labId = existing ? existing.id : uid();
    const prior = existing ? (existing.files && existing.files.length ? existing.files : existing.file ? [existing.file] : []) : [];
    const stored = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const r = await app.session.putMedia('labs', collectedAt, `${labId}-${prior.length + i}`, f.bytes, f.mediaType);
        stored.push({ path: r.path, mediaType: f.mediaType, name: f.name, bytes: r.bytes });
      }
    } catch (e) {
      console.warn('[labs] media', e);
      setSaving(false); setErr('The files could not be stored: ' + (e && e.message ? e.message : e)); return;
    }
    const fields = { date: collectedAt, collectedAt, lab: lab.trim() || null, markers, note: note.trim() || null };
    if (stored.length || !existing) { const all = [...prior, ...stored]; fields.files = all; fields.file = all[0] || null; }
    if (existing) {
      fields.editedAt = nowIso(tz);
      app.store.update('labs', labId, fields);
      app.toast(`Panel updated · ${plural(markers.length, 'result')}`);
    } else {
      fields.source = extraction ? 'upload' : 'manual';
      if (extraction) fields.ai = { model: extraction.model, costUsd: extraction.costUsd, at: extraction.at };
      app.store.create('labs', { id: labId, ...fields });
      app.toast(`Panel saved · ${plural(markers.length, 'result')}`);
    }
    setSaving(false);
    close(labId);
  };

  const tryClose = async () => {
    if (task.busy) task.cancel();
    if (dirty.current && !(await app.confirm({ title: 'Discard this panel?', message: 'Files and values entered here are not saved.', confirmLabel: 'Discard', danger: true }))) return;
    close();
  };

  const fileList = files.length ? html`<div class="rec-files">${files.map((f) => html`<div class="rec-file">
      ${f.url ? html`<img class="thumb" src=${f.url} alt="" />` : html`<div class="thumb photo-ph"><${Icon} name="file" /></div>`}
      <div class="grow" style="min-width:0"><div class="small strong ellipsis">${f.name}</div><div class="xs muted">${f.kind === 'pdf' ? 'PDF' : 'Photo'} · ${sizeText(f.size)}</div></div>
      <${IconButton} icon="x" label=${'Remove ' + f.name} onClick=${() => removeFile(f.key)} disabled=${task.busy} /></div>`)}</div>` : null;
  const picker = (label, variant) => html`<${FileButton} accept="application/pdf,image/*" multiple onFiles=${addFiles} icon="upload" variant=${variant} block=${variant === 'primary'}>${label}</${FileButton}>`;

  /* ----------------------------------------------------------- upload step */
  if (step === 'upload') {
    return html`<div class="stack">
      <${SheetHead} title="Add lab results" onClose=${tryClose} />
      <${Segmented} block value="upload" onValue=${(v) => v === 'manual' && setStep('review')} options=${[{ value: 'upload', label: 'Upload report' }, { value: 'manual', label: 'Enter manually' }]} label="Entry mode" />
      <p class="small dim">Upload the lab’s PDF or screenshots of every page. AI reads each result, unit and reference range; you check everything before it is saved. The originals are kept encrypted in your vault with the panel.</p>
      ${hasKey ? null : html`<${AiKeyNotice} what="report extraction" />`}
      ${fileList}
      ${preparing ? html`<div class="row small dim" style="gap:8px"><span class="spinner"></span>Preparing files…</div>` : null}
      ${files.length ? picker('Add more files') : picker('Choose PDF or photos', 'primary')}
      <${Field} label="Note for the extraction" hint="Optional, e.g. fasted, 8 AM draw, lab name if it is not printed.">
        <${Input} value=${note} onValue=${setNote} placeholder="Optional" /></${Field}>
      <${AiStatus} task=${task} label=${task.busy ? `Reading ${plural(files.length, 'file')}… (15–60 s)` : null} />
      <${AiError} error=${task.error} onRetry=${extract} />
      ${err ? html`<${Notice} tone="warn">${err}</${Notice}>` : null}
      <${SheetFoot}>
        <${Button} onClick=${() => { if (files.length) dirty.current = true; setStep('review'); }} disabled=${task.busy}>${files.length ? 'Enter by hand' : 'Cancel'}</${Button}>
        <${Button} variant="primary" icon="sparkle" onClick=${extract} disabled=${!files.length || !hasKey || preparing} loading=${task.busy}>Extract results</${Button}>
      </${SheetFoot}>
    </div>`;
  }

  /* ----------------------------------------------------------- review step */
  const prior = existing ? (existing.files && existing.files.length ? existing.files.length : existing.file ? 1 : 0) : 0;
  return html`<div class="stack">
    <${SheetHead} title=${existing ? 'Edit panel' : extraction ? 'Review results' : 'Enter results'} onClose=${tryClose} />
    ${!existing && !extraction ? html`<${Segmented} block value="manual" onValue=${(v) => v === 'upload' && setStep('upload')} options=${[{ value: 'upload', label: 'Upload report' }, { value: 'manual', label: 'Enter manually' }]} label="Entry mode" />` : null}
    ${extraction ? html`<${Notice} tone=${extraction.count ? 'good' : 'warn'}>
      <div class="stack xs"><span>${extraction.count ? `Extracted ${plural(extraction.count, 'result')} from ${plural(files.length, 'file')}. Check each value, unit and range against the report before saving.` : 'No results were found in these files. Enter them by hand or try clearer photos.'}${extraction.dateFound ? '' : ' No collection date was found — set it below.'}</span>
      <${CostNote} usd=${extraction.costUsd} model=${extraction.model} estimated=${extraction.costEstimated} /></div></${Notice}>` : null}
    ${extraction && extraction.notes.length ? html`<${Disclosure} summary=${`Extraction notes (${extraction.notes.length})`}><ul class="small dim rec-notes">${extraction.notes.map((n) => html`<li>${n}</li>`)}</ul></${Disclosure}>` : null}
    <div class="grid two rec-collapse">
      <${Field} label="Collected"><${DateInput} value=${collectedAt} onValue=${(v) => { dirty.current = true; setCollectedAt(v); }} max=${today} /></${Field}>
      <${Field} label="Lab"><${Input} value=${lab} onValue=${(v) => { dirty.current = true; setLab(v); }} placeholder="e.g. Quest, Labcorp, Rythm" /></${Field}>
    </div>

    <div class="stack sm">
      <div class="row between"><span class="label-text">Results · ${rows.filter((r) => String(r.name).trim() || String(r.value).trim()).length}</span>
        <span class="xs muted">Flags follow the printed range unless you pick one</span></div>
      <div class="rec-lab-rows">
        <div class="rec-lab-row rec-lab-head xs muted" aria-hidden="true"><span>Result</span><span>Value</span><span>Unit</span><span>Ref low</span><span>Ref high</span><span>Flag</span><span></span></div>
        ${rows.map((r) => html`<${ReviewRow} key=${r.rid} row=${r} bad=${missing.includes(r.rid)} onChange=${(p) => setRow(r.rid, p)} onRemove=${() => removeRow(r.rid)} />`)}
      </div>
      <div><${Button} size="sm" icon="plus" onClick=${addRow}>Add result</${Button}></div>
    </div>

    <${Field} label="Panel note"><${Textarea} value=${note} onValue=${(v) => { dirty.current = true; setNote(v); }} rows="2" placeholder="Optional: fasting, time of draw, context" /></${Field}>
    <div class="stack sm">
      <span class="label-text">Original report</span>
      ${prior ? html`<div class="xs muted">${plural(prior, 'file')} already stored with this panel.</div>` : null}
      ${fileList}
      ${preparing ? html`<div class="row small dim" style="gap:8px"><span class="spinner"></span>Preparing files…</div>` : null}
      <div>${picker(files.length || prior ? 'Attach more files' : 'Attach PDF or photos')}</div>
      <div class="xs muted">Stored encrypted in your vault when you save.</div>
    </div>
    ${err ? html`<${Notice} tone="bad">${err}</${Notice}>` : null}
    <${SheetFoot}>
      ${!existing && extraction ? html`<${Button} onClick=${() => setStep('upload')} disabled=${saving}>Back</${Button}>` : html`<${Button} onClick=${tryClose} disabled=${saving}>Cancel</${Button}>`}
      <${Button} variant="primary" onClick=${save} loading=${saving}>${existing ? 'Save changes' : 'Save panel'}</${Button}>
    </${SheetFoot}>
  </div>`;
}

function ReviewRow({ row, bad, onChange, onRemove }) {
  const key = keyForName(row.name);
  const mapped = isCatalogKey(key);
  const flag = row.flagTouched ? row.flag : autoFlag(row);
  return html`<div class=${cx('rec-lab-row', bad && 'bad', flag && 'flagged')}>
    <div class="rec-lab-name">
      <${Input} sm value=${row.name} onValue=${(v) => onChange({ name: v })} placeholder="Result name" aria-label="Result name" />
      <span class="xs muted ellipsis">${!String(row.name).trim() ? ' ' : mapped ? (catalogName(key).toLowerCase() === String(row.name).trim().toLowerCase() ? 'In catalog' : `→ ${catalogName(key)}`) : 'Not in catalog · kept as reported'}</span>
    </div>
    <${Input} sm mono value=${row.value} onValue=${(v) => onChange({ value: v })} placeholder="Value" aria-label="Value" autocapitalize="off" />
    <${Input} sm value=${row.unit} onValue=${(v) => onChange({ unit: v })} placeholder="Unit" aria-label="Unit" />
    <${NumberInput} class="sm" value=${row.refLow} onValue=${(v) => onChange({ refLow: v })} placeholder="Low" aria-label="Reference low" />
    <${NumberInput} class="sm" value=${row.refHigh} onValue=${(v) => onChange({ refHigh: v })} placeholder="High" aria-label="Reference high" />
    <${Select} class="sm" value=${flag || ''} onValue=${(v) => onChange({ flag: v, flagTouched: true })} options=${FLAGS} aria-label="Flag" />
    <${IconButton} icon="x" label="Remove result" onClick=${onRemove} />
    ${row.note ? html`<div class="xs muted rec-lab-note">${row.note}</div>` : null}
  </div>`;
}
