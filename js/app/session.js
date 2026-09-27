// Vault session: setup, unlock/lock, credentials, store + sync lifecycle, media.
// Security notes: the data key is a non-extractable CryptoKey; everything cached locally is ciphertext.
import { openCache, memoryCache, deleteCache } from '../core/idb.js';
import { createStore } from '../core/store.js';
import { createSync } from '../core/sync.js';
import { createGitHub, ensureInitialized } from '../core/github.js';
import * as C from '../core/crypto.js';
import { KEYRING_PATH, META_PATH, SCHEMA, seedStandards, seedExercises, mediaPath } from '../core/schema.js';
import { buildV2Migration, applyMigration, isV2Data } from '../core/migrate.js';
import { deviceTz, todayStr, nowIso, bytesToB64, hashId } from '../core/util.js';
import { makeDataView } from '../analytics/dataview.js';

const CACHE_NAME = 'forge-v3';
const enc = new TextEncoder(); const dec = new TextDecoder();

export async function createSession({ demo = false, demoKind = 'full' } = {}) {
  const listeners = new Set(); const syncListeners = new Set();
  let status = 'booting'; let error = null;
  let cache = null, store = null, sync = null, gh = null, key = null, dv = null, vault = null, keyring = null;
  let creds = {}; let lockMode = 'device'; let pending = null;
  let syncState = { state: 'idle', pending: 0, lastSyncAt: 0, error: null };
  const mediaUrls = new Map();

  const emit = () => { for (const fn of [...listeners]) { try { fn(api); } catch (e) { console.error(e); } } };
  const setStatus = (s, err = null) => { status = s; error = err; emit(); };

  /* ------------------------------------------------------------ boot */
  async function boot() {
    try {
      if (demo) {
        const { loadDemo } = await import('../dev/demo.js');
        cache = memoryCache(); store = createStore({ owner: 'app' });
        key = await C.importDek(C.randomBytes(32)); // ephemeral: lets media + creds work in memory
        if (demoKind === 'empty') { // fresh-vault simulation: seeds only
          for (const x of seedStandards()) store.create('standards', x);
          for (const x of seedExercises()) store.create('exercises', x);
          store.updateSetting('profile', { timezone: deviceTz() });
        } else loadDemo(store, { today: todayStr(), tz: deviceTz() });
        dv = makeDataView(store);
        syncState = { state: 'demo', pending: 0, lastSyncAt: 0, error: null };
        return setStatus('ready');
      }
      cache = await openCache(CACHE_NAME);
      vault = await cache.getMeta('vault');
      keyring = await cache.getMeta('keyring');
      lockMode = (await cache.getMeta('lockMode')) || 'device';
      if (!vault) return setStatus('needs-setup');
      const stored = lockMode === 'device' ? await cache.getMeta('dek') : null;
      if (stored) { key = stored; await start(); } else setStatus('locked');
    } catch (e) {
      console.error('[session] boot', e);
      setStatus('error', e);
    }
  }

  async function readCreds() {
    const blob = await cache.getMeta('creds');
    if (!blob) return {};
    try { return JSON.parse(dec.decode(await C.decryptBytes(key, blob, 'local/creds'))); } catch { return {}; }
  }
  async function writeCreds() { await cache.setMeta('creds', await C.encryptBytes(key, enc.encode(JSON.stringify(creds)), 'local/creds')); }

  function makeGh() {
    return createGitHub({ token: creds.githubToken, owner: vault.owner, repo: vault.repo, branch: vault.branch || 'main' });
  }

  async function start() {
    creds = await readCreds();
    gh = makeGh();
    store = createStore({ owner: 'app' });
    sync = createSync({ store, gh, key, cache, onStatus: (s) => { syncState = s; for (const fn of [...syncListeners]) fn(s); } });
    await sync.loadFromCache();
    dv = makeDataView(store);
    setStatus('ready');
    sync.sync();
    refreshKeyring();
    // Ask the browser not to evict local data (the encrypted cache + device key) under storage pressure.
    try { if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* ignore */ }
  }

  // Adopt a keyring rewrapped on another device (passphrase change), so the old passphrase stops
  // unlocking this device too. Only a keyring for the same data key (kid) is ever adopted.
  async function refreshKeyring() {
    try {
      if (!gh || !vault) return;
      // The vault must stay private: if it was made public, stop syncing (data stays encrypted, but
      // file names and commit times would be public) and surface the problem.
      const info = await gh.getRepo();
      if (info && info.private === false) {
        if (sync) sync.dispose();
        syncState = { ...syncState, state: 'error', error: 'The vault repository is PUBLIC. Sync is stopped — make it private on GitHub, then reload.' };
        for (const fn of [...syncListeners]) fn(syncState);
        return;
      }
      const f = await gh.getFile(KEYRING_PATH); if (!f) return;
      const kr = JSON.parse(dec.decode(f.bytes));
      if (!kr || !kr.kid || kr.kid !== vault.kid) return;
      if (JSON.stringify(kr) !== JSON.stringify(keyring)) { keyring = kr; await cache.setMeta('keyring', kr); }
    } catch { /* offline or rate-limited: keep the cached keyring */ }
  }

  function stop() {
    if (sync) sync.dispose();
    for (const url of mediaUrls.values()) URL.revokeObjectURL(url);
    mediaUrls.clear(); sync = null; store = null; dv = null; gh = null; key = null; creds = {};
  }

  async function persistVault({ kr, k, token }) {
    keyring = kr; key = k; creds = { ...creds, githubToken: token };
    await cache.setMeta('vault', vault);
    await cache.setMeta('keyring', kr);
    await cache.setMeta('lockMode', lockMode);
    if (lockMode === 'device') await cache.setMeta('dek', k);
    await writeCreds();
  }

  /* ----------------------------------------------------------- setup */
  async function connect({ owner, repo, token }) {
    owner = String(owner || '').trim(); repo = String(repo || '').trim(); token = String(token || '').trim();
    if (!owner || !repo || !token) throw new Error('Owner, repository and token are all required.');
    const g = createGitHub({ token, owner, repo });
    let info;
    try { info = await g.getRepo(); } catch (e) {
      if (e.status === 404) throw new Error('Repository not found, or this token has no access to it. Check the token\'s repository selection.');
      if (e.status === 401) throw new Error('GitHub rejected the token (expired or mistyped).');
      throw e;
    }
    if (!info.private) throw new Error(`${info.full_name} is PUBLIC. FORGE refuses to store data in a public repository — make it private first.`);
    const branch = info.default_branch || 'main';
    const g2 = createGitHub({ token, owner, repo, branch });
    await ensureInitialized(g2);
    const file = await g2.getFile(KEYRING_PATH);
    pending = { owner, repo, token, branch, gh: g2, keyring: file ? JSON.parse(dec.decode(file.bytes)) : null };
    return { initialized: !!file, fullName: info.full_name, branch };
  }

  async function createVault({ passphrase, lock = 'device' }) {
    if (!pending) throw new Error('Connect to the vault first.');
    if (pending.keyring) throw new Error('This vault already has a keyring — unlock it instead.');
    const { keyring: kr, dekRaw, recoveryKey } = await C.createKeyring(passphrase);
    const k = await C.importDek(dekRaw);
    await pending.gh.putText(KEYRING_PATH, JSON.stringify(kr, null, 2) + '\n', 'Create vault keyring');
    const existingMeta = await pending.gh.getFile(META_PATH);
    await pending.gh.putText(META_PATH, JSON.stringify({ schema: SCHEMA, encrypted: true, createdAt: nowIso() }, null, 2) + '\n', 'Create vault metadata', existingMeta && existingMeta.sha);
    vault = { owner: pending.owner, repo: pending.repo, branch: pending.branch, kid: kr.kid, connectedAt: nowIso() };
    lockMode = lock;
    await persistVault({ kr, k, token: pending.token });
    pending = null;
    await start();
    seedNewVault();
    return { recoveryKey, dekRaw };
  }

  async function unlockPending({ passphrase, recoveryKey, lock = 'device' }) {
    if (!pending || !pending.keyring) throw new Error('Nothing to unlock.');
    const raw = passphrase ? await C.unwrapWithPassphrase(pending.keyring, passphrase) : await C.unwrapWithRecovery(pending.keyring, recoveryKey);
    const k = await C.importDek(raw); raw.fill(0);
    vault = { owner: pending.owner, repo: pending.repo, branch: pending.branch, kid: pending.keyring.kid, connectedAt: nowIso() };
    lockMode = lock;
    await persistVault({ kr: pending.keyring, k, token: pending.token });
    pending = null;
    await start();
  }

  function seedNewVault() {
    // Seeds apply from today: days before FORGE v3 are not judged by standards that did not exist yet.
    if (!store.all('standards').length) for (const s of seedStandards()) store.create('standards', { ...s, effectiveFrom: todayStr(deviceTz()) });
    if (!store.all('exercises').length) for (const e of seedExercises()) store.create('exercises', e);
    const profile = store.setting('profile');
    if (!profile.timezone) store.updateSetting('profile', { timezone: deviceTz() });
  }

  /* ------------------------------------------------------ lock/unlock */
  async function unlock({ passphrase, recoveryKey }) {
    if (!keyring) throw new Error('No keyring cached on this device — set up the vault again.');
    const raw = passphrase ? await C.unwrapWithPassphrase(keyring, passphrase) : await C.unwrapWithRecovery(keyring, recoveryKey);
    key = await C.importDek(raw); raw.fill(0);
    if (lockMode === 'device') await cache.setMeta('dek', key);
    await start();
  }
  async function lock() {
    if (demo) return;
    if (sync) await sync.flush().catch(() => {});
    await cache.delMeta('dek');
    stop(); setStatus('locked');
  }
  async function setLockMode(mode) {
    lockMode = mode === 'session' ? 'session' : 'device';
    await cache.setMeta('lockMode', lockMode);
    if (lockMode === 'device' && key) await cache.setMeta('dek', key); else await cache.delMeta('dek');
    emit();
  }
  async function forgetDevice() {
    if (demo) return;
    // Stop this device's notifications (the inactive record syncs before local data is wiped).
    try {
      const reg = typeof navigator !== 'undefined' && navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      if (sub) { if (store) store.upsert('pushSubs', hashId(sub.endpoint), { active: false }); await sub.unsubscribe(); }
    } catch { /* ignore */ }
    try { if (sync) await sync.flush(); } catch { /* ignore */ }
    stop(); await cache.clear(); if (cache.close) cache.close(); await deleteCache(CACHE_NAME);
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('forge')) localStorage.removeItem(k); } catch { /* ignore */ }
    cache = await openCache(CACHE_NAME); vault = null; keyring = null;
    setStatus('needs-setup');
  }

  async function changePassphrase(oldPass, newPass) {
    const raw = await C.unwrapWithPassphrase(keyring, oldPass);
    const kr = await C.rewrapPassphrase(keyring, raw, newPass); raw.fill(0);
    const cur = await gh.getFile(KEYRING_PATH);
    await gh.putText(KEYRING_PATH, JSON.stringify(kr, null, 2) + '\n', 'Rotate vault passphrase', cur && cur.sha);
    keyring = kr; await cache.setMeta('keyring', kr);
  }
  async function dataKeyRaw(passphrase) { return C.unwrapWithPassphrase(keyring, passphrase); }
  // Replace a lost recovery key: the new key file makes the old recovery key useless from now on.
  async function newRecoveryKey(passphrase) {
    const raw = await C.unwrapWithPassphrase(keyring, passphrase);
    let res; try { res = await C.rewrapRecovery(keyring, raw); } finally { raw.fill(0); }
    const cur = await gh.getFile(KEYRING_PATH);
    await gh.putText(KEYRING_PATH, JSON.stringify(res.keyring, null, 2) + '\n', 'Replace vault recovery key', cur && cur.sha);
    keyring = res.keyring; await cache.setMeta('keyring', res.keyring);
    return res.recoveryKey;
  }

  async function updateCreds(patch) {
    creds = { ...creds, ...patch };
    for (const k of Object.keys(creds)) if (creds[k] === '' || creds[k] == null) delete creds[k];
    await writeCreds();
    if ('githubToken' in patch && store) {
      gh = makeGh();
      sync.dispose();
      sync = createSync({ store, gh, key, cache, onStatus: (s) => { syncState = s; for (const fn of [...syncListeners]) fn(s); } });
      await sync.loadFromCache(); // like start(): queued media uploads, known remote shas and head
      sync.sync();
    }
    emit();
  }

  /* ------------------------------------------------------------ v2 */
  function importV2(obj) {
    if (!isV2Data(obj)) throw new Error('That file is not a FORGE v2 backup (forge-data.json).');
    return applyMigration(store, buildV2Migration(obj, { tz: deviceTz() }));
  }

  /* ----------------------------------------------------------- media */
  async function putMedia(kind, date, id, bytes, mediaType = 'image/jpeg') {
    const path = mediaPath(kind, date, id);
    const blob = await C.encryptBytes(key, bytes, path, { compress: false });
    if (sync) sync.queueFile(path, blob);
    else if (cache) await cache.putBlob(path, { kind: 'file', sha: null, bytes: blob, pending: false }); // demo: keep in memory
    mediaUrls.set(path, URL.createObjectURL(new Blob([bytes], { type: mediaType })));
    return { path, mediaType, bytes: bytes.length };
  }
  /** Decrypted bytes of a media file (pending upload → local cache → vault). null when unavailable. */
  async function mediaBytes(path) {
    if (!path) return null;
    let encBytes = sync ? sync.pendingFile(path) : null;
    if (!encBytes && cache) { const c = await cache.getBlob(path); if (c && c.bytes) encBytes = c.bytes; }
    if (!encBytes && gh) { encBytes = await gh.getRaw(path); if (encBytes && cache) await cache.putBlob(path, { kind: 'file', sha: null, bytes: encBytes, pending: false }); }
    if (!encBytes) return null;
    return C.decryptBytes(key, encBytes, path);
  }
  async function mediaUrl(path, mediaType = 'image/jpeg') {
    if (!path) return null;
    if (mediaUrls.has(path)) return mediaUrls.get(path);
    const plain = await mediaBytes(path);
    if (!plain) return null;
    const url = URL.createObjectURL(new Blob([plain], { type: mediaType }));
    mediaUrls.set(path, url); return url;
  }
  async function encryptPayload(obj, path) { return bytesToB64(await C.encryptBytes(key, enc.encode(JSON.stringify(obj)), path)); }

  const api = {
    get status() { return status; }, get error() { return error; }, demo,
    get vault() { return vault; }, get store() { return store; }, get dv() { return dv; }, get sync() { return sync; }, get gh() { return gh; },
    get creds() { return { ...creds }; }, get lockMode() { return lockMode; }, get keyring() { return keyring; }, get pendingConnect() { return pending ? { owner: pending.owner, repo: pending.repo, initialized: !!pending.keyring } : null; },
    boot, connect, createVault, unlockPending, unlock, lock, setLockMode, forgetDevice, changePassphrase, dataKeyRaw, newRecoveryKey, updateCreds, importV2,
    putMedia, mediaUrl, mediaBytes, encryptPayload,
    syncStatus: () => syncState,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onSyncStatus(fn) { syncListeners.add(fn); return () => syncListeners.delete(fn); },
  };
  return api;
}
