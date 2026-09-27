// End-to-end encryption for the vault. WebCrypto only (browser + Node >= 20).
// Blob format: 'FRG1' | flags(1) | iv(12) | AES-256-GCM ciphertext+tag
// AAD = header(5 bytes) + utf8('forge/v1:' + path)  — binds each blob to its path.
import { bytesToB64, b64ToBytes } from './util.js';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const MAGIC = [0x46, 0x52, 0x47, 0x31]; // FRG1
const FLAG_GZIP = 1;
export const PBKDF2_ITERATIONS = 600000;

export function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }

/* -------------------------------------------------------------- gzip */
async function streamThrough(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export async function gzip(bytes) {
  if (typeof CompressionStream !== 'undefined') return streamThrough(bytes, new CompressionStream('gzip'));
  const z = await import('node:zlib'); return new Uint8Array(z.gzipSync(bytes));
}
export async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'undefined') return streamThrough(bytes, new DecompressionStream('gzip'));
  const z = await import('node:zlib'); return new Uint8Array(z.gunzipSync(bytes));
}

/* --------------------------------------------------------------- keys */
export async function importDek(raw, { extractable = false } = {}) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('Data key must be 32 bytes');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}
export async function keyId(raw) {
  const h = new Uint8Array(await subtle().digest('SHA-256', raw));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------- blob codec */
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0); const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
function aadFor(header, path) { return concat(header, enc.encode('forge/v1:' + path)); }

export async function encryptBytes(key, bytes, path, { compress = true } = {}) {
  const body = compress ? await gzip(bytes) : bytes;
  const header = new Uint8Array([...MAGIC, compress ? FLAG_GZIP : 0]);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(header, path) }, key, body));
  return concat(header, iv, ct);
}
export function isEncryptedBlob(bytes) {
  return bytes && bytes.length > 17 && MAGIC.every((m, i) => bytes[i] === m);
}
export async function decryptBytes(key, blob, path) {
  if (!isEncryptedBlob(blob)) throw new Error('Not a FORGE encrypted blob: ' + path);
  const header = blob.slice(0, 5); const iv = blob.slice(5, 17); const ct = blob.slice(17);
  let pt;
  try {
    pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aadFor(header, path) }, key, ct));
  } catch {
    throw new Error('Decryption failed for ' + path + ' (wrong key or tampered file)');
  }
  return (header[4] & FLAG_GZIP) ? gunzip(pt) : pt;
}
export async function encodeJson(key, path, obj) { return encryptBytes(key, enc.encode(JSON.stringify(obj)), path); }
export async function decodeJson(key, path, blob) { return JSON.parse(dec.decode(await decryptBytes(key, blob, path))); }

/* ------------------------------------------------------ recovery key */
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function formatRecoveryKey(raw) {
  let bits = 0, val = 0, out = '';
  for (const b of raw) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += CROCK[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += CROCK[(val << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}
export function parseRecoveryKey(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) {
    const i = CROCK.indexOf(ch); if (i < 0) throw new Error('Invalid character in recovery key');
    val = ((val << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  if (out.length !== 32) throw new Error('Recovery key has the wrong length');
  return new Uint8Array(out);
}

/* ---------------------------------------------------------- keyring */
const WRAP_AAD = enc.encode('forge/keyring/v1');
async function kekFromPassphrase(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function kekFromRecovery(raw) {
  const digest = new Uint8Array(await subtle().digest('SHA-256', concat(enc.encode('forge/recovery/v1'), raw)));
  return subtle().importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function wrap(kek, dekRaw) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, kek, dekRaw));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}
async function unwrap(kek, w) {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: b64ToBytes(w.iv), additionalData: WRAP_AAD }, kek, b64ToBytes(w.ct)));
  } catch { return null; }
}

export async function createKeyring(passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  const dekRaw = randomBytes(32); const recoveryRaw = randomBytes(32); const salt = randomBytes(16);
  const keyring = {
    v: 1,
    kid: await keyId(dekRaw),
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToB64(salt) },
    wraps: {
      passphrase: await wrap(await kekFromPassphrase(passphrase, salt, iterations), dekRaw),
      recovery: await wrap(await kekFromRecovery(recoveryRaw), dekRaw),
    },
  };
  return { keyring, dekRaw, recoveryKey: formatRecoveryKey(recoveryRaw) };
}
// KDF parameters come from the vault file: bound them so a tampered keyring cannot hang the device
// (huge iteration counts) or weaken the derivation (tiny ones).
const MIN_ITERATIONS = 100000, MAX_ITERATIONS = 10000000;
export async function unwrapWithPassphrase(keyring, passphrase) {
  const { kdf } = keyring;
  if (!kdf || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !Number.isInteger(kdf.iterations) || kdf.iterations < MIN_ITERATIONS || kdf.iterations > MAX_ITERATIONS) throw new Error('Unsupported key file parameters');
  const kek = await kekFromPassphrase(passphrase, b64ToBytes(kdf.salt), kdf.iterations);
  const raw = await unwrap(kek, keyring.wraps.passphrase);
  if (!raw) throw new Error('Wrong passphrase');
  if (keyring.kid && (await keyId(raw)) !== keyring.kid) throw new Error('Key check failed');
  return raw;
}
export async function unwrapWithRecovery(keyring, recoveryKey) {
  const raw = await unwrap(await kekFromRecovery(parseRecoveryKey(recoveryKey)), keyring.wraps.recovery);
  if (!raw) throw new Error('Wrong recovery key');
  if (keyring.kid && (await keyId(raw)) !== keyring.kid) throw new Error('Key check failed');
  return raw;
}
// New recovery key (lost or exposed): the old recovery key stops working. Returns { keyring, recoveryKey }.
export async function rewrapRecovery(keyring, dekRaw) {
  const recoveryRaw = randomBytes(32);
  const out = {
    ...keyring,
    wraps: { ...keyring.wraps, recovery: await wrap(await kekFromRecovery(recoveryRaw), dekRaw) },
    updatedAt: new Date().toISOString(),
  };
  const recoveryKey = formatRecoveryKey(recoveryRaw); recoveryRaw.fill(0);
  return { keyring: out, recoveryKey };
}
// New passphrase (e.g. after recovery). Returns an updated keyring; recovery wrap unchanged.
export async function rewrapPassphrase(keyring, dekRaw, newPassphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = randomBytes(16);
  return {
    ...keyring,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToB64(salt) },
    wraps: { ...keyring.wraps, passphrase: await wrap(await kekFromPassphrase(newPassphrase, salt, iterations), dekRaw) },
    updatedAt: new Date().toISOString(),
  };
}

// Passphrase strength: a conservative guess-cost estimate in bits (zxcvbn-style, simplified).
// Repeats, keyboard/alphabet sequences, repeated chunks ("Forge!Forge!") and common words or
// passwords (with l33t substitutions) count as a few bits each instead of per-character entropy.
// Space-separated phrases are scored per word, capped at dictionary-word entropy, so a phrase needs
// about 5 words to reach the 55-bit gate. Used for UI gating only.
const COMMON_WORDS = ('password passwd qwerty qwertz azerty letmein welcome admin login iloveyou monkey dragon master shadow ' +
  'sunshine princess football baseball soccer hockey superman batman trustno1 hello freedom whatever starwars secret ' +
  'changeme forge vault private health fitness summer winter spring autumn love money family friend google apple ' +
  'computer internet michael jordan charlie jessica ashley thomas daniel matthew andrew robert pepper cookie cheese ' +
  'chocolate orange banana purple yellow silver golden diamond killer hunter tiger lion eagle falcon ninja pokemon ' +
  'mustang ferrari porsche harley corvette london paris texas florida america soccer1 abc qwe asd zxc test guest').split(' ');
const LEET = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' };
const ROWS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p'];
const classPool = (c) => (/[a-z]/.test(c) ? 26 : /[A-Z]/.test(c) ? 26 : /\d/.test(c) ? 10 : 33);
function isSeq(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return ROWS.some((r) => { const i = r.indexOf(x); return i >= 0 && (r[i + 1] === y || (i > 0 && r[i - 1] === y)); });
}
function charModelBits(s) {
  const norm = s.toLowerCase().replace(/[013457 8@$!|+]/g, (c) => LEET[c] || c);
  // Dictionary hits (longest first) replace their characters with ~13 bits (+1 when capitalized).
  const covered = new Array(s.length).fill(false); let bits = 0;
  for (const w of [...COMMON_WORDS].sort((a, b) => b.length - a.length)) {
    if (w.length < 3) continue;
    let from = 0; let i;
    while ((i = norm.indexOf(w, from)) >= 0) {
      if (!covered.slice(i, i + w.length).some(Boolean)) {
        for (let k = i; k < i + w.length; k++) covered[k] = true;
        bits += 13 + (/[A-Z]/.test(s.slice(i, i + w.length)) ? 1 : 0);
      }
      from = i + 1;
    }
  }
  for (let i = 0; i < s.length; i++) {
    if (covered[i]) continue;
    const c = s[i], p = i > 0 ? s[i - 1] : null;
    if (p !== null && !covered[i - 1] && c === p) bits += 1;            // repeat
    else if (p !== null && !covered[i - 1] && isSeq(p, c)) bits += 1.5; // sequence / keyboard run
    else bits += Math.log2(classPool(c));
  }
  return bits;
}
function chunkRepeatBits(s) {
  // "abcabcabc" / "Forge!Forge!Forge!": entropy of the chunk plus a little for the count.
  for (let L = 1; L <= Math.floor(s.length / 2); L++) {
    const chunk = s.slice(0, L); let ok = true;
    for (let i = L; i < s.length; i++) if (s[i] !== chunk[i % L]) { ok = false; break; }
    if (ok) return charModelBits(chunk) + Math.log2(s.length / L) + 1;
  }
  return Infinity;
}
export function passphraseBits(p) {
  const s = String(p || ''); if (!s) return 0;
  const words = s.trim().split(/\s+/).filter(Boolean);
  let est = Math.min(charModelBits(s), chunkRepeatBits(s));
  if (words.length >= 3) {
    // Phrase model: each distinct word ≈ a dictionary word (≤ 13 bits); repeats add ~1 bit.
    const seen = new Set(); let phrase = 0;
    for (const w of words) { const k = w.toLowerCase(); phrase += seen.has(k) ? 1 : Math.min(charModelBits(w), 13); seen.add(k); }
    est = Math.min(est, phrase);
  }
  return Math.max(0, Math.round(est));
}
