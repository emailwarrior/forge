// FORGE AI layer: image helpers.
// Pure (Node-testable): readExifDate, timeFromFilename.
// Browser-only: prepareImage, makeThumb, preparePhoto (createImageBitmap / <img> + OffscreenCanvas or
// <canvas> → JPEG). Nothing here touches browser globals at import time, so importing in Node is safe.
import { AIError } from './errors.js';
import { bytesToB64 } from '../core/util.js';

/* --------------------------------------------------------------- EXIF */

/**
 * Capture time from EXIF: DateTimeOriginal (0x9003) in the Exif sub-IFD, then DateTimeDigitized (0x9004),
 * then IFD0 DateTime (0x0132). Handles JPEG APP1 (both byte orders), bare TIFF, and containers that embed
 * "Exif\0\0" + TIFF (HEIC/WebP). → 'YYYY-MM-DDTHH:MM:SS' (camera local time) or null. Never throws.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|number[]} input
 */
export function readExifDate(input) {
  try {
    const u8 = toBytes(input);
    if (!u8 || u8.length < 12) return null;
    for (const start of tiffStarts(u8)) {
      const d = dateFromTiff(u8, start);
      if (d) return d;
    }
    return null;
  } catch {
    return null;
  }
}

function toBytes(x) {
  if (x == null) return null;
  if (x instanceof Uint8Array) return x;
  if (typeof ArrayBuffer !== 'undefined') {
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  }
  if (Array.isArray(x)) return Uint8Array.from(x, (v) => Number(v) & 0xff);
  return null;
}

const isTiffHeader = (u8, i) => i >= 0 && i + 8 <= u8.length && (
  (u8[i] === 0x49 && u8[i + 1] === 0x49 && u8[i + 2] === 0x2a && u8[i + 3] === 0x00) ||
  (u8[i] === 0x4d && u8[i + 1] === 0x4d && u8[i + 2] === 0x00 && u8[i + 3] === 0x2a));
const isExifHeader = (u8, i) => u8[i] === 0x45 && u8[i + 1] === 0x78 && u8[i + 2] === 0x69 && u8[i + 3] === 0x66 &&
  u8[i + 4] === 0 && u8[i + 5] === 0 && isTiffHeader(u8, i + 6);

// Offsets of candidate TIFF headers.
function tiffStarts(u8) {
  const n = u8.length;
  const out = [];
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let p = 2;
    for (let guard = 0; guard < 1000 && p + 4 <= n; guard++) {
      if (u8[p] !== 0xff) break; // lost sync: fall back to scanning
      const marker = u8[p + 1];
      if (marker === 0xff) { p++; continue; } // fill byte
      p += 2;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // standalone markers
      if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan: no more metadata
      if (p + 2 > n) break;
      const len = (u8[p] << 8) | u8[p + 1];
      if (len < 2) break;
      if (marker === 0xe1 && p + 2 + 14 <= n && isExifHeader(u8, p + 2)) out.push(p + 2 + 6);
      p += len;
    }
  } else if (isTiffHeader(u8, 0)) {
    out.push(0);
  }
  if (!out.length) {
    const limit = Math.min(n - 14, 1 << 20);
    for (let i = 0; i <= limit && out.length < 4; i++) if (u8[i] === 0x45 && isExifHeader(u8, i)) out.push(i + 6);
  }
  return out;
}

function dateFromTiff(u8, t) {
  const n = u8.length;
  if (!isTiffHeader(u8, t)) return null;
  const le = u8[t] === 0x49;
  const r16 = (o) => (o >= 0 && o + 2 <= n ? (le ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1]) : -1);
  const r32 = (o) => (o >= 0 && o + 4 <= n
    ? (le ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0
      : ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0)
    : -1);
  const readIfd = (rel) => {
    if (!(rel >= 8) || t + rel + 2 > n) return null; // an IFD cannot overlap the 8-byte header
    const off = t + rel;
    const count = r16(off);
    if (count <= 0) return null;
    const max = Math.min(count, 1000, Math.floor((n - off - 2) / 12));
    const entries = new Map();
    for (let i = 0; i < max; i++) {
      const e = off + 2 + i * 12;
      const tag = r16(e);
      if (!entries.has(tag)) entries.set(tag, { type: r16(e + 2), count: r32(e + 4), at: e + 8 });
    }
    return entries;
  };
  const ascii = (entry) => {
    if (!entry || entry.type !== 2 || !(entry.count > 0)) return null;
    let off = entry.at;
    if (entry.count > 4) { const rel = r32(entry.at); if (rel < 0) return null; off = t + rel; }
    if (off < 0 || off >= n) return null;
    let s = '';
    for (let i = 0; i < Math.min(entry.count, 64) && off + i < n; i++) {
      const c = u8[off + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const ifd0 = readIfd(r32(t + 4));
  if (!ifd0) return null;
  let sub = null;
  const ptr = ifd0.get(0x8769);
  if (ptr) { const rel = r32(ptr.at); if (rel > 0) sub = readIfd(rel); }
  for (const e of [sub && sub.get(0x9003), sub && sub.get(0x9004), ifd0.get(0x0132)]) {
    const d = exifDateString(ascii(e));
    if (d) return d;
  }
  return null;
}

function exifDateString(s) {
  if (!s) return null;
  const m = /^\s*(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || se > 60) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${se === 60 ? '59' : m[6]}`;
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* ------------------------------------------------------------ filenames */

// YYYY[sep]MM[sep]DD [sep] HH[sep]MM[[sep]SS] [AM|PM] with consistent separators inside date and time.
// A one-digit hour ("at 9.05.12 PM") must be followed by a separator.
const FILENAME_RE = /(?:^|\D)((?:19|20)\d{2})([-_.]?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?:\s+at\s+|_at_|[ _T-])?([01]\d|2[0-3]|\d(?=[-_.:]))([-_.:]?)([0-5]\d)(?:\6([0-5]\d))?(?:\s*([ap])\.?m\.?(?![a-z]))?/i;

/**
 * Capture time from common camera/app filenames → 'YYYY-MM-DDTHH:MM:SS' or null. Examples:
 * meal_2026-09-26_12-34-05.jpg, IMG_20260926_123405.jpg, PXL_20260926_123405123.jpg, 20260926T123405-0400.jpg,
 * Screenshot 2026-09-26 at 9.05.12 PM.png, WhatsApp Image 2026-09-26 at 12.34.05.jpeg, Screenshot_20260926-123405.png.
 * A trailing UTC offset is ignored (the local wall time is returned).
 */
export function timeFromFilename(name) {
  try {
    const base = String(name == null ? '' : name).split(/[\\/]/).pop();
    const m = base ? FILENAME_RE.exec(base) : null;
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[3]), d = Number(m[4]);
    let h = Number(m[5]);
    const mi = m[7], se = m[8] || '00', ap = m[9] ? m[9].toLowerCase() : '';
    if (d > daysInMonth(y, mo)) return null;
    if (ap && h >= 1 && h <= 12) h = ap === 'p' ? (h % 12) + 12 : h % 12;
    if (h > 23) return null;
    return `${m[1]}-${m[3]}-${m[4]}T${String(h).padStart(2, '0')}:${mi}:${se}`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ browser pipeline */

/**
 * Decode (respecting EXIF orientation), downscale to maxEdge and re-encode as JPEG. Browser only.
 * → { bytes: Uint8Array, mediaType: 'image/jpeg', width, height }
 */
export async function prepareImage(file, { maxEdge = 1280, quality = 0.82 } = {}) {
  if (!file) throw new AIError('bad-request', 'No image to process.');
  if (!canvasAvailable()) throw new AIError('bad-request', 'Image processing needs a browser (canvas).');
  const src = await decodeImage(file);
  try {
    const edge = Math.max(16, Number(maxEdge) || 1280);
    const scale = Math.min(1, edge / Math.max(src.width, src.height));
    const width = Math.max(1, Math.round(src.width * scale));
    const height = Math.max(1, Math.round(src.height * scale));
    const blob = await renderJpeg(src, width, height, Math.min(1, Math.max(0.3, Number(quality) || 0.82)));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType: 'image/jpeg', width, height };
  } finally {
    src.close();
  }
}

/** Small JPEG thumbnail (default 480 px long edge). Browser only. */
export function makeThumb(file, { maxEdge = 480, quality = 0.72 } = {}) {
  return prepareImage(file, { maxEdge, quality });
}

/**
 * One-stop meal-photo pipeline: capture time from EXIF (falling back to the filename) + prepareImage + base64.
 * → { bytes, data (base64), mediaType, width, height, takenAt, takenAtSource: 'exif'|'filename'|null }
 */
export async function preparePhoto(file, opts = {}) {
  let takenAt = null, takenAtSource = null;
  try {
    const head = typeof file.slice === 'function' ? file.slice(0, 512 * 1024) : file;
    takenAt = readExifDate(new Uint8Array(await head.arrayBuffer()));
    if (takenAt) takenAtSource = 'exif';
  } catch { /* no EXIF */ }
  if (!takenAt && file && file.name) {
    takenAt = timeFromFilename(file.name);
    if (takenAt) takenAtSource = 'filename';
  }
  const img = await prepareImage(file, opts);
  return { ...img, data: bytesToB64(img.bytes), takenAt, takenAtSource };
}

function canvasAvailable() {
  return typeof OffscreenCanvas === 'function' || (typeof document !== 'undefined' && typeof document.createElement === 'function');
}

async function decodeImage(file) {
  let firstError = null;
  const fromBitmap = (bmp) => ({ source: bmp, width: bmp.width, height: bmp.height, close: () => { try { bmp.close(); } catch { /* ignore */ } } });
  if (typeof createImageBitmap === 'function') {
    try { return fromBitmap(await createImageBitmap(file, { imageOrientation: 'from-image' })); } catch (e) { firstError = e; }
  }
  // <img> applies EXIF orientation in every current browser (also when the option above is unsupported).
  if (typeof Image === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('Image decode failed')); img.src = url; });
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('Empty image');
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      firstError = firstError || e;
    }
  }
  if (typeof createImageBitmap === 'function') {
    try { return fromBitmap(await createImageBitmap(file)); } catch (e) { firstError = firstError || e; }
  }
  throw new AIError('bad-request', 'Could not read this image. Try a JPEG or PNG.', { cause: firstError });
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx && typeof canvas.convertToBlob === 'function') return { canvas, ctx };
    } catch { /* fall through to a DOM canvas */ }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  throw new AIError('bad-request', 'Image processing needs a browser (canvas).');
}

async function renderJpeg(src, width, height, quality) {
  // Halve in steps when shrinking by more than 2× (single-step canvas downscales alias fine detail).
  let cur = src.source, cw = src.width, ch = src.height;
  while (cw > width * 2 && ch > height * 2) {
    const nw = Math.max(width, Math.round(cw / 2)), nh = Math.max(height, Math.round(ch / 2));
    const step = makeCanvas(nw, nh);
    step.ctx.imageSmoothingEnabled = true;
    step.ctx.imageSmoothingQuality = 'high';
    step.ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = step.canvas; cw = nw; ch = nh;
  }
  const out = makeCanvas(width, height);
  out.ctx.fillStyle = '#ffffff'; // JPEG has no alpha: flatten transparency onto white
  out.ctx.fillRect(0, 0, width, height);
  out.ctx.imageSmoothingEnabled = true;
  out.ctx.imageSmoothingQuality = 'high';
  out.ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, width, height);
  if (typeof out.canvas.convertToBlob === 'function') return out.canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    out.canvas.toBlob((b) => (b ? resolve(b) : reject(new AIError('bad-request', 'Could not encode the image.'))), 'image/jpeg', quality);
  });
}
