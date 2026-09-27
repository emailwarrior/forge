// Encrypted media (meal photos, lab files) → object URLs via session.mediaUrl (decrypts in memory).
import { html, useState, useEffect } from '../../vendor/preact-htm.js';
import { useApp } from '../ctx.js';
import { Icon, cx } from '../kit.js';

/** usePhotoUrl(path, mediaType) → undefined while loading, null when missing/unavailable, else an object URL. */
export function usePhotoUrl(path, mediaType = 'image/jpeg') {
  const app = useApp();
  const [url, setUrl] = useState(path ? undefined : null);
  useEffect(() => {
    let alive = true;
    if (!path) { setUrl(null); return undefined; }
    setUrl(undefined);
    app.session.mediaUrl(path, mediaType).then((u) => { if (alive) setUrl(u || null); }).catch((e) => { console.warn('[media]', path, e); if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [path, mediaType]);
  return url;
}

/**
 * EncryptedImage: { path, mediaType, alt, class ('thumb' | 'thumb lg' | custom), style, onClick, icon (placeholder icon) }
 * Renders a placeholder box (same class) while loading or when the file is missing.
 */
export function EncryptedImage({ path, mediaType = 'image/jpeg', alt = '', class: cls = 'thumb', style, onClick, icon = 'image' }) {
  const url = usePhotoUrl(path, mediaType);
  if (url) return html`<img class=${cls} style=${style} src=${url} alt=${alt} loading="lazy" decoding="async" onClick=${onClick} />`;
  return html`<div class=${cx(cls, 'photo-ph', url === undefined && path && 'skeleton')} style=${style} onClick=${onClick} role=${onClick ? 'button' : undefined} aria-label=${alt || undefined}>
    ${url === undefined && path ? null : html`<${Icon} name=${icon} />`}</div>`;
}

/** Opens a full-size image in a sheet. */
export function viewImage(app, { path, mediaType = 'image/jpeg', title = 'Photo' }) {
  return app.sheet(({ close }) => html`<div class="stack">
    <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" aria-label="Close" onClick=${() => close()}><${Icon} name="x" /></button></div>
    <${EncryptedImage} path=${path} mediaType=${mediaType} class="thumb lg" style="height:auto;max-height:70vh;object-fit:contain" alt=${title} />
  </div>`, { wide: true });
}
