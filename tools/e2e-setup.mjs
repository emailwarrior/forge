#!/usr/bin/env node
// FORGE v3 — browser end-to-end test of the REAL (non-demo) first-run and multi-device flows.
//
//   node tools/e2e-setup.mjs        (~5 min; no network: Chromium via Playwright, everything mocked)
//
// Runs before a deploy to prove that setup, sync, locking and multi-device use still work against
// GitHub and Anthropic as the app actually calls them. Everything is local:
// - an embedded static server for the app (no service worker on http);
// - an in-memory GitHub: private vault, a public repo, other repos; fine-grained tokens with
//   repository selection + permissions; Contents API (base64 wrapped at 60, sha checks, raw media
//   type, empty repositories), Git Data API (real git object hashing, base_tree, recursive trees,
//   fast-forward-only ref updates), Actions secrets (the sealed box is opened with the repo key, so
//   the test knows FORGE_DATA_KEY), workflow dispatch (inputs validated against the installed
//   workflow; a new workflow is dispatchable only after E2E_WORKFLOW_DELAY_MS, like GitHub) and runs.
//   Request headers are checked against GitHub's documented CORS allow list (Playwright does not
//   route preflights, so this is the only CORS guard);
// - a dispatched workflow runs automation/forge-automation.mjs exactly as the app installed it in the
//   vault, with the secrets as the app sealed them, in a temporary git checkout; its push becomes a
//   forge-bot commit in the mock vault;
// - an Anthropic mock (streams SSE, checks headers and that no sampling parameter is sent).
//
// Flows: 1 first run on a laptop (bad/foreign token and public repo refused, weak passphrase refused,
// recovery key copy/download/confirm, FORGE_DATA_KEY == vault key, v2 import + retired seeds,
// automation install + ping, profile) · 2 weigh-in, check-in, plan block, workout set, meal photo +
// AI, then an at-rest audit (vault objects, request bodies, IndexedDB, localStorage: FRG1 blobs only,
// no plaintext markers) · 3 reload, lock modes, wrong/right passphrase, recovery-key unlock · 4 phone
// joins, concurrent edits converge · 5 passphrase change reaches the phone · 6 forget this device ·
// 7 GitHub unreachable / browser offline: edits stay queued and flush · 8 token replaced with a photo
// queued · 9 probes: reload on the recovery-key screen, failing automation run.
// Exit code 1 on any failed flow, API contract violation, page error, unhandled rejection,
// unexpected dialog or request to an unknown host. Report + requests.json + screenshots in E2E_OUT.
//
// Env: PLAYWRIGHT_MODULE (playwright's index.mjs), FORGE_ROOT (repo root, default ..), E2E_OUT
// (artifacts), E2E_TMP (temp dir for automation checkouts), E2E_WORKFLOW_DELAY_MS (default 4000),
// E2E_BASE (use a running server instead), E2E_HEADED=1, E2E_KEEP=1 (keep the checkouts).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

const ROOT = process.env.FORGE_ROOT ? path.resolve(process.env.FORGE_ROOT) : path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PW = process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'forge-e2e-'));
const TMP = process.env.E2E_TMP || os.tmpdir();
const WORKFLOW_DELAY_MS = Number(process.env.E2E_WORKFLOW_DELAY_MS ?? 4000); // new workflows are dispatchable only after GitHub registers them
fs.mkdirSync(OUT, { recursive: true });

const imp = (p) => import(url.pathToFileURL(path.join(ROOT, p)).href);
const { chromium } = await import(PW);
const C = await imp('js/core/crypto.js');
const { createStore } = await imp('js/core/store.js');
const { parseShardPath } = await imp('js/core/schema.js');
const claudeFx = await imp('tests/ai/fixtures/mock-claude.mjs');

/* ------------------------------------------------------------------ utils */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const b64wrap = (buf) => Buffer.from(buf).toString('base64').replace(/(.{60})/g, '$1\n') + '\n';
const isB64 = (s) => typeof s === 'string' && /^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(s);
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);
const alnum = (n) => [...randomBytes(n)].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[b % 57]).join('');
function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }
async function until(fn, { timeout = 20000, interval = 250, what = 'condition' } = {}) {
  const t0 = Date.now(); let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() - t0 > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ''}`);
    await sleep(interval);
  }
}
function execP(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
}

// The vendored sealed box bundles tweetnacl + blake2b; expose them to open sealed boxes like GitHub does.
async function loadNacl() {
  const src = fs.readFileSync(path.join(ROOT, 'js/vendor/sealedbox.js'), 'utf8');
  const marker = /export\{(\w+) as sealedBox\};?\s*$/;
  const m = marker.exec(src.trim());
  const naclVar = /var (\w+)=\w+\(\w+\(\)\),(\w+)=\w+\(\w+\(\)\);function \w+\(a,i\)\{let h=\1\.default\.box\.keyPair\(\)/.exec(src);
  if (!m || !naclVar) throw new Error('js/vendor/sealedbox.js changed shape: update loadNacl() in tools/e2e-setup.mjs');
  const patched = src.trim().replace(marker, `export{${m[1]} as sealedBox, ${naclVar[1]} as __nacl, ${naclVar[2]} as __blake};`);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(patched).toString('base64'));
  const nacl = mod.__nacl.default; const blake2b = mod.__blake.blake2b;
  const openSealed = (sealed, pk, sk) => {
    if (sealed.length < 48) return null;
    const epk = sealed.subarray(0, 32); const n = new Uint8Array(64); n.set(epk, 0); n.set(pk, 32);
    return nacl.box.open(sealed.subarray(32), blake2b(n, undefined, 24), epk, sk);
  };
  return { nacl, openSealed, sealedBox: mod.sealedBox };
}

/* ============================================================ mock GitHub */
// Non-safelisted request headers api.github.com's CORS preflight is documented to allow
// (docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests).
// X-GitHub-Api-Version is deliberately absent: GitHub confirmed its preflight rejected it
// (github.com/orgs/community/discussions/40619). Playwright does not route preflights, so this list is
// the E2E's only CORS guard: any other header would fail in a real browser.
const GH_ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'if-match', 'if-modified-since', 'if-none-match', 'if-unmodified-since', 'x-github-otp', 'x-requested-with']);
// Safelisted or set by the browser itself (cache-control/pragma come from fetch's cache: 'no-store').
const BROWSER_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'origin', 'referer', 'user-agent', 'accept-encoding', 'connection', 'host', 'content-length', 'cache-control', 'pragma']);
const GH_CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, Deprecation, Sunset',
};
const MODES = { blob: ['100644', '100755', '120000'], tree: ['040000'], commit: ['160000'] };
const API = 'https://api.github.com';

function createGitHubMock({ nacl, openSealed, latency = [3, 25], workflowDelayMs = 0, onDispatch = null }) {
  const repos = new Map(); const tokens = new Map();
  const requests = []; const violations = [];
  let fault = null;

  function addRepo({ owner, name, isPrivate = true, defaultBranch = 'main' }) {
    const kp = nacl.box.keyPair();
    const r = {
      owner, name, full: `${owner}/${name}`, private: isPrivate, defaultBranch, id: 700000000 + repos.size,
      objects: new Map(), refs: new Map(), secrets: new Map(), runs: [], dispatches: [], workflowSeen: new Map(),
      secretsKey: { pk: kp.publicKey, sk: kp.secretKey, id: String(3380204578043523366n + BigInt(repos.size)) },
    };
    repos.set(r.full.toLowerCase(), r); return r;
  }
  // perms: { contents, actions, secrets, workflows } each 'read' | 'write' | undefined
  function addToken(token, { label, repos: list, perms }) { tokens.set(token, { label, repos: new Set(list.map((s) => s.toLowerCase())), perms }); }

  /* ---------------------------------------------------- git objects */
  function putObject(r, type, body, extra = {}) {
    const sha = sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
    if (!r.objects.has(sha)) r.objects.set(sha, { type, body, ...extra });
    return sha;
  }
  const putBlob = (r, bytes) => putObject(r, 'blob', Buffer.from(bytes));
  const sortKey = (e) => (e.type === 'tree' ? e.name + '/' : e.name);
  function putTree(r, entries) {
    const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(sortKey(a)), Buffer.from(sortKey(b))));
    const body = Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.type === 'tree' ? '40000' : e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
    return putObject(r, 'tree', body, { entries: sorted });
  }
  function putCommit(r, { tree, parents, message, author }) {
    const who = `${author.name} <${author.email}> ${Math.floor(author.ms / 1000)} +0000`;
    const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${who}\ncommitter ${who}\n\n${message}`;
    return putObject(r, 'commit', Buffer.from(text), { tree, parents, message, author: { name: author.name, email: author.email, date: iso(author.ms) } });
  }
  function flatten(r, treeSha, prefix = '', out = new Map()) {
    const t = r.objects.get(treeSha); if (!t || t.type !== 'tree') return out;
    for (const e of t.entries) { const p = prefix + e.name; if (e.type === 'tree') flatten(r, e.sha, p + '/', out); else out.set(p, { mode: e.mode, type: e.type, sha: e.sha }); }
    return out;
  }
  function buildTree(r, flat) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [p, e] of flat) {
      const parts = p.split('/'); let n = root;
      for (let i = 0; i < parts.length - 1; i++) { if (!n.dirs.has(parts[i])) n.dirs.set(parts[i], { files: new Map(), dirs: new Map() }); n = n.dirs.get(parts[i]); }
      n.files.set(parts[parts.length - 1], e);
    }
    const write = (n) => putTree(r, [
      ...[...n.files].map(([name, e]) => ({ name, mode: e.mode, type: e.type, sha: e.sha })),
      ...[...n.dirs].map(([name, d]) => ({ name, mode: '040000', type: 'tree', sha: write(d) })),
    ]);
    return write(root);
  }
  const headOf = (r, branch = r.defaultBranch) => r.refs.get('heads/' + branch) || null;
  const filesAt = (r, commitSha) => (commitSha ? flatten(r, r.objects.get(commitSha).tree) : new Map());
  function setRef(r, branch, sha) {
    r.refs.set('heads/' + branch, sha);
    if (branch === r.defaultBranch) for (const p of filesAt(r, sha).keys()) if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) && !r.workflowSeen.has(p)) r.workflowSeen.set(p, Date.now());
  }
  function isAncestor(r, anc, sha) {
    const seen = new Set(); const stack = [sha];
    while (stack.length) { const s = stack.pop(); if (s === anc) return true; if (seen.has(s)) continue; seen.add(s); const c = r.objects.get(s); if (c && c.type === 'commit') stack.push(...c.parents); }
    return false;
  }
  // Server-side commit (Contents API, the automation's push): on top of the branch head.
  function commitFiles(r, branch, changes, message, who = { name: 'GitHub', email: 'noreply@github.com' }) {
    const head = headOf(r, branch); const flat = filesAt(r, head);
    for (const [p, bytes] of changes) { if (bytes == null) flat.delete(p); else flat.set(p, { mode: '100644', type: 'blob', sha: putBlob(r, bytes) }); }
    const c = putCommit(r, { tree: buildTree(r, flat), parents: head ? [head] : [], message, author: { ...who, ms: Date.now() } });
    setRef(r, branch, c); return c;
  }
  function resolveRef(r, ref) {
    if (!ref) return headOf(r);
    const name = String(ref).replace(/^refs\/heads\//, '');
    if (r.refs.has('heads/' + name)) return r.refs.get('heads/' + name);
    if (/^[0-9a-f]{40}$/.test(ref) && r.objects.get(ref)?.type === 'commit') return ref;
    return null;
  }

  /* --------------------------------------------------------- json */
  const repoUrl = (r) => `${API}/repos/${r.full}`;
  const json = (status, obj, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: Buffer.from(JSON.stringify(obj)) });
  const fail = (status, message) => json(status, { message, documentation_url: 'https://docs.github.com/rest', status: String(status) });
  const commitJson = (r, sha) => {
    const c = r.objects.get(sha);
    return { sha, node_id: 'C_' + sha.slice(0, 12), url: `${repoUrl(r)}/git/commits/${sha}`, html_url: `https://github.com/${r.full}/commit/${sha}`,
      author: c.author, committer: c.author, tree: { sha: c.tree, url: `${repoUrl(r)}/git/trees/${c.tree}` }, message: c.message,
      parents: c.parents.map((p) => ({ sha: p, url: `${repoUrl(r)}/git/commits/${p}`, html_url: `https://github.com/${r.full}/commit/${p}` })),
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null } };
  };
  const refJson = (r, branch, sha) => ({ ref: 'refs/heads/' + branch, node_id: 'REF_' + branch, url: `${repoUrl(r)}/git/refs/heads/${branch}`, object: { sha, type: 'commit', url: `${repoUrl(r)}/git/commits/${sha}` } });
  const entryJson = (r, e, p) => ({ path: p, mode: e.mode, type: e.type, sha: e.sha, ...(e.type === 'blob' ? { size: r.objects.get(e.sha).body.length, url: `${repoUrl(r)}/git/blobs/${e.sha}` } : { url: `${repoUrl(r)}/git/trees/${e.sha}` }) });
  const fileJson = (r, p, sha, ref, withContent) => {
    const body = r.objects.get(sha).body; const big = body.length > 1024 * 1024;
    return { type: 'file', encoding: withContent ? (big ? 'none' : 'base64') : undefined, size: body.length, name: p.split('/').pop(), path: p,
      ...(withContent ? { content: big ? '' : b64wrap(body) } : {}), sha,
      url: `${repoUrl(r)}/contents/${p}?ref=${ref}`, git_url: `${repoUrl(r)}/git/blobs/${sha}`, html_url: `https://github.com/${r.full}/blob/${ref}/${p}`,
      download_url: `https://raw.githubusercontent.com/${r.full}/${ref}/${p}`, _links: { self: `${repoUrl(r)}/contents/${p}?ref=${ref}`, git: `${repoUrl(r)}/git/blobs/${sha}`, html: `https://github.com/${r.full}/blob/${ref}/${p}` } };
  };
  function workflowInputs(yml) {
    const lines = yml.split('\n');
    const i = lines.findIndex((l) => /^\s*workflow_dispatch:\s*(#.*)?$/.test(l)); if (i < 0) return null;
    const base = lines[i].match(/^\s*/)[0].length; const inputs = {};
    let inputsIndent = -1, keyIndent = -1, last = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]; if (!l.trim() || l.trim().startsWith('#')) continue;
      const ind = l.match(/^\s*/)[0].length; if (ind <= base) break;
      if (inputsIndent < 0) { if (/^\s*inputs:\s*$/.test(l)) inputsIndent = ind; continue; }
      if (ind <= inputsIndent) break;
      if (keyIndent < 0) keyIndent = ind;
      if (ind === keyIndent) { const m = /^\s*([A-Za-z_][\w-]*):/.exec(l); if (m) { last = m[1]; inputs[last] = { type: 'string' }; } }
      else if (last) { const m = /^\s*type:\s*(\w+)/.exec(l); if (m) inputs[last].type = m[1]; }
    }
    return inputs;
  }
  function validPath(p) { return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.endsWith('/') && p.split('/').every((s) => s && s !== '.' && s !== '..'); }

  /* ------------------------------------------------------- routes */
  const need = (t, r, perm, level) => {
    const v = t.perms[perm];
    return v === 'write' || (level === 'read' && v === 'read');
  };
  const ROUTES = [
    ['GET', /^$/, '/repos/{owner}/{repo}', null, (c) => json(200, {
      id: c.r.id, node_id: 'R_' + c.r.id, name: c.r.name, full_name: c.r.full, private: c.r.private, visibility: c.r.private ? 'private' : 'public',
      owner: { login: c.r.owner, id: 4242, type: 'User' }, html_url: `https://github.com/${c.r.full}`, fork: false, default_branch: c.r.defaultBranch,
      size: 0, archived: false, disabled: false, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    })],
    ['GET', /^\/git\/ref\/heads\/(.+)$/, '/repos/{owner}/{repo}/git/ref/heads/{branch}', ['contents', 'read'], (c, [b]) => {
      if (!c.r.refs.size) return fail(409, 'Git Repository is empty.');
      const branch = decodeURIComponent(b); const sha = headOf(c.r, branch);
      return sha ? json(200, refJson(c.r, branch, sha)) : fail(404, 'Not Found');
    }],
    ['PATCH', /^\/git\/refs\/heads\/(.+)$/, '/repos/{owner}/{repo}/git/refs/heads/{branch}', ['contents', 'write'], (c, [b]) => {
      const branch = decodeURIComponent(b); const cur = headOf(c.r, branch); const { sha, force } = c.body || {};
      if (!cur) return fail(422, 'Reference does not exist');
      if (typeof sha !== 'string' || c.r.objects.get(sha)?.type !== 'commit') return fail(422, 'Object does not exist');
      if (force !== undefined && typeof force !== 'boolean') c.violation('PATCH ref: force must be a boolean');
      if (!force && cur !== sha && !isAncestor(c.r, cur, sha)) return fail(422, 'Update is not a fast forward');
      setRef(c.r, branch, sha); return json(200, refJson(c.r, branch, sha));
    }],
    ['GET', /^\/git\/commits\/([0-9a-f]{40})$/, '/repos/{owner}/{repo}/git/commits/{sha}', ['contents', 'read'], (c, [sha]) => (c.r.objects.get(sha)?.type === 'commit' ? json(200, commitJson(c.r, sha)) : fail(404, 'Not Found'))],
    ['POST', /^\/git\/commits$/, '/repos/{owner}/{repo}/git/commits', ['contents', 'write'], (c) => {
      const { message, tree, parents } = c.body || {};
      if (typeof message !== 'string') return fail(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
      if (typeof tree !== 'string' || c.r.objects.get(tree)?.type !== 'tree') return fail(422, 'Tree SHA does not exist');
      if (parents !== undefined && (!Array.isArray(parents) || parents.some((p) => c.r.objects.get(p)?.type !== 'commit'))) return fail(422, 'Parent SHA does not exist or is not a commit object');
      const sha = putCommit(c.r, { tree, parents: parents || [], message, author: { name: c.tok.label, email: 'owner@users.noreply.github.com', ms: Date.now() } });
      return json(201, commitJson(c.r, sha), { location: `${repoUrl(c.r)}/git/commits/${sha}` });
    }],
    ['GET', /^\/git\/trees\/([0-9a-f]{40})$/, '/repos/{owner}/{repo}/git/trees/{sha}', ['contents', 'read'], (c, [sha]) => {
      const t = c.r.objects.get(sha); if (!t || t.type !== 'tree') return fail(404, 'Not Found');
      if (!c.url.searchParams.has('recursive')) return json(200, { sha, url: `${repoUrl(c.r)}/git/trees/${sha}`, tree: t.entries.map((e) => entryJson(c.r, e, e.name)), truncated: false });
      const out = [];
      const walk = (s, prefix) => { for (const e of c.r.objects.get(s).entries) { out.push(entryJson(c.r, e, prefix + e.name)); if (e.type === 'tree') walk(e.sha, prefix + e.name + '/'); } };
      walk(sha, ''); return json(200, { sha, url: `${repoUrl(c.r)}/git/trees/${sha}`, tree: out, truncated: false });
    }],
    ['POST', /^\/git\/trees$/, '/repos/{owner}/{repo}/git/trees', ['contents', 'write'], (c) => {
      const { base_tree: baseTree, tree } = c.body || {};
      if (!Array.isArray(tree)) return fail(422, 'Invalid request.\n\n"tree" wasn\'t supplied.');
      if (baseTree !== undefined && c.r.objects.get(baseTree)?.type !== 'tree') return fail(422, 'base_tree is not a valid tree oid');
      const flat = baseTree ? flatten(c.r, baseTree) : new Map();
      for (const e of tree) {
        if (!e || !validPath(e.path)) return fail(422, `tree.path contains a malformed path component: ${e && e.path}`);
        if (!MODES[e.type] || !MODES[e.type].includes(e.mode)) return fail(422, `Invalid tree info: mode ${e.mode} / type ${e.type}`);
        if ('content' in e && 'sha' in e) return fail(422, 'tree entry must have either sha or content');
        if (e.sha === null) { flat.delete(e.path); continue; }
        let sha = e.sha;
        if (typeof e.content === 'string') sha = putBlob(c.r, Buffer.from(e.content, 'utf8'));
        if (typeof sha !== 'string' || c.r.objects.get(sha)?.type !== e.type) return fail(422, 'GitRPC::BadObjectState');
        if (e.type !== 'blob') { c.violation('tree entry of type ' + e.type + ' is not supported by this mock'); continue; }
        flat.set(e.path, { mode: e.mode, type: 'blob', sha });
      }
      const sha = buildTree(c.r, flat);
      return json(201, { sha, url: `${repoUrl(c.r)}/git/trees/${sha}`, tree: c.r.objects.get(sha).entries.map((e) => entryJson(c.r, e, e.name)), truncated: false });
    }],
    ['GET', /^\/git\/blobs\/([0-9a-f]{40})$/, '/repos/{owner}/{repo}/git/blobs/{sha}', ['contents', 'read'], (c, [sha]) => {
      const b = c.r.objects.get(sha); if (!b || b.type !== 'blob') return fail(404, 'Not Found');
      return json(200, { sha, node_id: 'B_' + sha.slice(0, 12), size: b.body.length, url: `${repoUrl(c.r)}/git/blobs/${sha}`, content: b64wrap(b.body), encoding: 'base64' });
    }],
    ['POST', /^\/git\/blobs$/, '/repos/{owner}/{repo}/git/blobs', ['contents', 'write'], (c) => {
      const { content, encoding = 'utf-8' } = c.body || {};
      if (typeof content !== 'string') return fail(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
      if (!['utf-8', 'base64'].includes(encoding)) return fail(422, 'encoding must be utf-8 or base64');
      if (encoding === 'base64' && !isB64(content)) return fail(422, 'content is not valid Base64');
      const sha = putBlob(c.r, encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8'));
      return json(201, { sha, url: `${repoUrl(c.r)}/git/blobs/${sha}` }, { location: `${repoUrl(c.r)}/git/blobs/${sha}` });
    }],
    ['GET', /^\/contents\/(.+)$/, '/repos/{owner}/{repo}/contents/{path}', ['contents', 'read'], (c, [raw]) => {
      if (!c.r.refs.size) return fail(404, 'This repository is empty.');
      const p = raw.split('/').map(decodeURIComponent).join('/');
      const ref = c.url.searchParams.get('ref') || c.r.defaultBranch;
      const head = resolveRef(c.r, ref); if (!head) return fail(404, `No commit found for the ref ${ref}`);
      const flat = filesAt(c.r, head); const f = flat.get(p);
      const accept = String(c.headers.accept || '');
      if (!f) {
        const dir = [...flat.keys()].filter((k) => k.startsWith(p + '/'));
        if (!dir.length) return fail(404, 'Not Found');
        const names = [...new Set(dir.map((k) => k.slice(p.length + 1).split('/')[0]))];
        return json(200, names.map((n) => (flat.has(p + '/' + n) ? fileJson(c.r, p + '/' + n, flat.get(p + '/' + n).sha, ref, false) : { type: 'dir', name: n, path: p + '/' + n })));
      }
      if (/application\/vnd\.github(\.v3)?\.raw/.test(accept)) return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: c.r.objects.get(f.sha).body };
      return json(200, fileJson(c.r, p, f.sha, ref, true));
    }],
    ['PUT', /^\/contents\/(.+)$/, '/repos/{owner}/{repo}/contents/{path}', ['contents', 'write'], (c, [raw]) => {
      const p = raw.split('/').map(decodeURIComponent).join('/');
      const { message, content, sha, branch } = c.body || {};
      if (/^\.github\/workflows\//.test(p) && !need(c.tok, c.r, 'workflows', 'write')) return fail(403, `refusing to allow a Personal Access Token to create or update workflow \`${p}\` without \`workflows\` permission`);
      if (typeof message !== 'string' || !message) return fail(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
      if (typeof content !== 'string' || !isB64(content)) return fail(422, 'Invalid request.\n\n"content" is not valid Base64.');
      if (!validPath(p)) return fail(422, 'path is invalid');
      const br = branch || c.r.defaultBranch;
      if (c.r.refs.size && !headOf(c.r, br)) return fail(404, `Branch ${br} not found`);
      if (!c.r.refs.size && br !== c.r.defaultBranch) c.violation('first commit of an empty repository on a non-default branch');
      const cur = filesAt(c.r, headOf(c.r, br)).get(p);
      if (cur && !sha) return fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
      if (cur && sha !== cur.sha) return fail(409, `${p} does not match ${sha}`);
      if (!cur && sha) c.violation(`PUT contents ${p}: sha supplied for a new file`);
      const commit = commitFiles(c.r, br, new Map([[p, Buffer.from(content, 'base64')]]), message, { name: c.tok.label, email: 'owner@users.noreply.github.com' });
      const fsha = filesAt(c.r, commit).get(p).sha;
      return json(cur ? 200 : 201, { content: fileJson(c.r, p, fsha, br, false), commit: commitJson(c.r, commit) });
    }],
    ['GET', /^\/actions\/secrets\/public-key$/, '/repos/{owner}/{repo}/actions/secrets/public-key', ['secrets', 'read'], (c) => json(200, { key_id: c.r.secretsKey.id, key: Buffer.from(c.r.secretsKey.pk).toString('base64') })],
    ['GET', /^\/actions\/secrets$/, '/repos/{owner}/{repo}/actions/secrets', ['secrets', 'read'], (c) => {
      const list = [...c.r.secrets.entries()].sort().map(([name, s]) => ({ name, created_at: s.created_at, updated_at: s.updated_at }));
      const per = Math.min(100, Number(c.url.searchParams.get('per_page') || 30));
      return json(200, { total_count: list.length, secrets: list.slice(0, per) });
    }],
    ['PUT', /^\/actions\/secrets\/([^/]+)$/, '/repos/{owner}/{repo}/actions/secrets/{name}', ['secrets', 'write'], (c, [n]) => {
      const name = decodeURIComponent(n).toUpperCase();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('GITHUB_')) return fail(422, 'Secret names can only contain alphanumeric characters or underscores and must not start with a number or GITHUB_');
      const { encrypted_value: ev, key_id: kid } = c.body || {};
      if (typeof ev !== 'string' || !isB64(ev)) return fail(422, 'encrypted_value must be Base64');
      if (kid !== c.r.secretsKey.id) return fail(422, 'key_id does not match the repository public key');
      const plain = openSealed(Buffer.from(ev, 'base64'), c.r.secretsKey.pk, c.r.secretsKey.sk);
      if (!plain) return fail(422, 'Bad request: the secret could not be decrypted with the repository public key');
      const existed = c.r.secrets.has(name); const t = iso();
      c.r.secrets.set(name, { value: Buffer.from(plain).toString('utf8'), created_at: existed ? c.r.secrets.get(name).created_at : t, updated_at: t });
      return existed ? { status: 204, headers: {}, body: Buffer.alloc(0) } : json(201, {});
    }],
    ['DELETE', /^\/actions\/secrets\/([^/]+)$/, '/repos/{owner}/{repo}/actions/secrets/{name}', ['secrets', 'write'], (c, [n]) => (c.r.secrets.delete(decodeURIComponent(n).toUpperCase()) ? { status: 204, headers: {}, body: Buffer.alloc(0) } : fail(404, 'Not Found'))],
    ['POST', /^\/actions\/workflows\/([^/]+)\/dispatches$/, '/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches', ['actions', 'write'], (c, [wf]) => {
      const file = decodeURIComponent(wf); const wpath = '.github/workflows/' + file;
      const seen = c.r.workflowSeen.get(wpath);
      if (!seen || Date.now() - seen < workflowDelayMs) return fail(404, 'Not Found');
      const { ref, inputs = {} } = c.body || {};
      if (typeof ref !== 'string' || !ref) return fail(422, 'Invalid request.\n\n"ref" wasn\'t supplied.');
      const head = resolveRef(c.r, ref); if (!head || /^[0-9a-f]{40}$/.test(ref)) return fail(422, `No ref found for: ${ref}`);
      const f = filesAt(c.r, head).get(wpath); if (!f) return fail(404, 'Not Found');
      const declared = workflowInputs(c.r.objects.get(f.sha).body.toString('utf8'));
      if (!declared) return fail(422, "Workflow does not have 'workflow_dispatch' trigger");
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return fail(422, 'inputs must be an object');
      const unexpected = Object.keys(inputs).filter((k) => !(k in declared));
      if (unexpected.length) return fail(422, `Unexpected inputs provided: ${JSON.stringify(unexpected)}`);
      for (const [k, v] of Object.entries(inputs)) if (declared[k].type === 'string' && typeof v !== 'string') return fail(422, `Provided value for input '${k}' must be a string`);
      if (JSON.stringify(inputs).length > 65535) return fail(422, 'inputs are too large');
      const run = { id: 9000000000 + c.r.runs.length, name: 'FORGE sync', display_title: 'FORGE sync', event: 'workflow_dispatch', status: 'queued', conclusion: null,
        head_branch: ref, head_sha: head, path: wpath, run_number: c.r.runs.length + 1, run_attempt: 1, created_at: iso(), updated_at: iso(), run_started_at: iso(),
        html_url: `https://github.com/${c.r.full}/actions/runs/${9000000000 + c.r.runs.length}`, inputs };
      c.r.runs.unshift(run); c.r.dispatches.push({ file, ref, inputs, at: Date.now() });
      if (onDispatch) setTimeout(() => onDispatch(c.r, run), 300);
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }],
    ['GET', /^\/actions\/workflows\/([^/]+)\/runs$/, '/repos/{owner}/{repo}/actions/workflows/{workflow}/runs', ['actions', 'read'], (c, [wf]) => {
      const wpath = '.github/workflows/' + decodeURIComponent(wf);
      if (!c.r.workflowSeen.has(wpath)) return fail(404, 'Not Found');
      const list = c.r.runs.filter((x) => x.path === wpath); const per = Math.min(100, Number(c.url.searchParams.get('per_page') || 30));
      return json(200, { total_count: list.length, workflow_runs: list.slice(0, per).map(({ inputs, ...x }) => x) });
    }],
  ];

  function preflight(req) {
    const wantHeaders = String(req.headers['access-control-request-headers'] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = wantHeaders.filter((h) => !GH_ALLOWED_HEADERS.has(h) && !BROWSER_HEADERS.has(h));
    if (bad.length) violations.push({ req: { method: 'OPTIONS', path: req.url, endpoint: 'OPTIONS (preflight)' }, msg: `asks for headers GitHub does not allow: ${bad.join(', ')}` });
    return { status: 204, headers: { ...GH_CORS, 'access-control-allow-headers': [...GH_ALLOWED_HEADERS].join(', '), 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE', 'access-control-max-age': '86400' }, body: Buffer.alloc(0) };
  }

  async function handle(req) {
    const u = new URL(req.url); const method = req.method.toUpperCase();
    const entry = { t: Date.now(), method, path: u.pathname + u.search, endpoint: null, status: 0, device: '?', bodyText: req.body ? req.body.toString('utf8') : '' };
    requests.push(entry);
    await sleep(rand(latency));
    if (fault) {
      const f = fault(req, u);
      if (f === 'network') { entry.status = 'network-error'; entry.endpoint = '(fault)'; return { abort: 'internetdisconnected' }; }
      if (f) { entry.status = f.status; return { ...json(f.status, { message: f.message || 'fault' }), headers: { ...GH_CORS, 'content-type': 'application/json' } }; }
    }
    if (method === 'OPTIONS') { entry.status = 204; entry.endpoint = 'OPTIONS (preflight)'; return preflight(req); }
    const vio = (m) => violations.push({ req: entry, msg: m }); // reported per endpoint pattern
    const h = req.headers;
    for (const k of Object.keys(h)) if (!k.startsWith('sec-') && !k.startsWith(':') && !GH_ALLOWED_HEADERS.has(k) && !BROWSER_HEADERS.has(k)) vio(`request header "${k}" is not allowed by GitHub's CORS preflight`);
    if (h['x-github-api-version'] && h['x-github-api-version'] !== '2022-11-28') vio('X-GitHub-Api-Version other than 2022-11-28 (the client is written for 2022-11-28, the default)');
    if (!/application\/vnd\.github/.test(String(h.accept || ''))) vio('Accept is not a GitHub media type: ' + h.accept);
    let body;
    if (req.body && req.body.length) {
      if (!/application\/json/.test(String(h['content-type'] || ''))) vio('body without Content-Type: application/json');
      try { body = JSON.parse(req.body.toString('utf8')); } catch { entry.status = 400; return withCors(fail(400, 'Problems parsing JSON')); }
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    const auth = /^(?:Bearer|token) (.+)$/.exec(String(h.authorization || ''));
    const tok = auth && tokens.get(auth[1]);
    entry.device = tok ? tok.label : '?';
    if (!m) { vio('unknown endpoint'); entry.status = 404; return withCors(fail(404, 'Not Found')); }
    const r = repos.get(`${m[1]}/${m[2]}`.toLowerCase());
    const sub = m[3] || '';
    const found = ROUTES.find(([meth, re]) => meth === method && re.test(sub));
    if (!found) { vio('unknown endpoint or method'); entry.status = 404; entry.endpoint = `${method} ?${sub}`; return withCors(fail(404, 'Not Found')); }
    const [, re, name, perm, fn] = found;
    entry.endpoint = `${method} ${name}`;
    if (!tok) { entry.status = 401; return withCors(fail(401, 'Bad credentials')); }
    const readable = r && (tok.repos.has(r.full.toLowerCase()) || !r.private);
    if (!readable) { entry.status = 404; return withCors(fail(404, 'Not Found')); }
    if (perm) {
      const [p, level] = perm;
      const writes = level === 'write' || p === 'workflows';
      if (writes && !tok.repos.has(r.full.toLowerCase())) { entry.status = 403; return withCors(fail(403, 'Resource not accessible by personal access token')); }
      if (tok.repos.has(r.full.toLowerCase()) && !need(tok, r, p, level)) { entry.status = 403; return withCors(fail(403, 'Resource not accessible by personal access token')); }
      if (!tok.repos.has(r.full.toLowerCase()) && p !== 'contents') { entry.status = 403; return withCors(fail(403, 'Resource not accessible by personal access token')); }
    }
    let res;
    try { res = fn({ r, tok, url: u, headers: h, body, violation: vio }, re.exec(sub).slice(1)); } catch (e) { vio('mock crashed: ' + e.stack); res = fail(500, 'mock error'); }
    entry.status = res.status;
    return withCors(res);
  }
  const withCors = (res) => ({ ...res, headers: { ...GH_CORS, 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-github-api-version-selected': '2022-11-28', ...res.headers } });

  return {
    addRepo, addToken, handle, requests, violations, commitFiles, filesAt, headOf, isAncestor,
    setFault(fn) { fault = fn; },
    repo: (full) => repos.get(full.toLowerCase()),
    files: (r) => filesAt(r, headOf(r)),
    blob: (r, sha) => r.objects.get(sha)?.body || null,
    fileBytes(r, p) { const e = filesAt(r, headOf(r)).get(p); return e ? r.objects.get(e.sha).body : null; },
  };
}

/* ========================================================= mock Anthropic */
const AI_KEY = 'sk-ant-api03-' + alnum(40) + '-E2EKEY';
const MEAL_TITLE = 'E2E Salmon Quinoa Bowl';
const zeros = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, satFat: 0, sodium: 0, potassium: 0, calcium: 0, iron: 0, magnesium: 0, vitC: 0, vitD: 0 };
const MEAL_INPUT = {
  title: MEAL_TITLE, portionReference: 'standard dinner plate', assumptions: ['Salmon baked with a teaspoon of oil'], confidence: 'medium', followUp: '',
  items: [
    { ...zeros, name: 'Baked salmon', portion: '1 fillet', grams: 170, confidence: 'high', basis: 'estimate', kcal: 350, protein: 38, fat: 21, satFat: 4, sodium: 110, potassium: 620, vitD: 600 },
    { ...zeros, name: 'Quinoa', portion: '1 cup cooked', grams: 185, confidence: 'medium', basis: 'estimate', kcal: 222, protein: 8, carbs: 39, fat: 3.6, fiber: 5, sugar: 1.6, magnesium: 118 },
  ],
};
function createClaudeMock() {
  const calls = []; const violations = [];
  async function handle(req) {
    const vio = (m) => violations.push(m);
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'request-id, retry-after, x-should-retry' };
    if (req.method === 'OPTIONS') return { status: 204, headers: { ...cors, 'access-control-allow-headers': 'x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, content-type, anthropic-beta', 'access-control-allow-methods': 'POST' }, body: '' };
    const h = req.headers; let body = null;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { vio('body is not JSON'); }
    calls.push({ url: req.url, headers: h, body });
    if (req.url !== 'https://api.anthropic.com/v1/messages') vio('bad url ' + req.url);
    if (req.method !== 'POST') vio('method must be POST');
    if (h['x-api-key'] !== AI_KEY) vio('x-api-key is not the key saved in Settings → AI');
    if (h['anthropic-version'] !== '2023-06-01') vio('anthropic-version missing');
    if (h['anthropic-dangerous-direct-browser-access'] !== 'true') vio('browser requests need anthropic-dangerous-direct-browser-access: true');
    for (const k of ['temperature', 'top_p', 'top_k']) if (body && k in body) vio(k + ' must never be sent');
    let msg;
    const tools = (body && body.tools) || [];
    if (tools.some((t) => t.name === 'record_meal')) {
      const img = body.messages[0].content.find((b) => b.type === 'image');
      if (!img || img.source.media_type !== 'image/jpeg' || !img.source.data) vio('meal analysis without a JPEG image block');
      msg = claudeFx.message([claudeFx.toolUse('record_meal', MEAL_INPUT)], { stop_reason: 'tool_use', model: body.model });
    } else if (body && body.max_tokens === 1) {
      msg = claudeFx.message([claudeFx.text('p')], { stop_reason: 'max_tokens', model: body.model, usage: { input_tokens: 8, output_tokens: 1 } });
    } else {
      msg = claudeFx.message([claudeFx.text('{}')], { model: body && body.model });
    }
    if (body && body.stream) return { status: 200, headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req_e2e' }, body: claudeFx.sseText(msg) };
    return { status: 200, headers: { ...cors, 'content-type': 'application/json', 'request-id': 'req_e2e' }, body: JSON.stringify(msg) };
  }
  return { handle, calls, violations };
}

/* ================================================= automation runner */
// Runs automation/forge-automation.mjs AS INSTALLED IN THE MOCK VAULT, like the workflow does:
// checkout of the default branch, env from the secrets + dispatch inputs, git push to "origin",
// then the pushed forge/server/** files are committed to the mock vault by forge-bot.
function createRunner(gh, report) {
  let chain = Promise.resolve();
  const runs = [];
  async function execute(r, run) {
    const dir = await fsp.mkdtemp(path.join(TMP, 'forge-e2e-run-'));
    const work = path.join(dir, 'work'); const origin = path.join(dir, 'origin.git');
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: dir };
    const git = async (args, cwd = work) => { const x = await execP('git', args, { cwd, env: gitEnv }); if (x.code) throw new Error(`git ${args.join(' ')}: ${x.stderr}`); return x; };
    const head = gh.headOf(r); const flat = gh.filesAt(r, head);
    run.status = 'in_progress'; run.updated_at = iso();
    try {
      await fsp.mkdir(work, { recursive: true });
      for (const [p, e] of flat) { const f = path.join(work, p); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, r.objects.get(e.sha).body); }
      await git(['init', '-q', '--bare', '-b', r.defaultBranch, origin], dir);
      await git(['init', '-q', '-b', r.defaultBranch]);
      await git(['add', '-A']); await git(['commit', '-q', '-m', 'checkout']);
      await git(['remote', 'add', 'origin', origin]); await git(['push', '-q', 'origin', r.defaultBranch]);
      const secret = (n) => (r.secrets.get(n) || {}).value || '';
      const env = {
        PATH: process.env.PATH, HOME: dir, CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: r.defaultBranch, GITHUB_REPOSITORY: r.full,
        FORGE_DATA_KEY: secret('FORGE_DATA_KEY'), WHOOP_CLIENT_ID: secret('WHOOP_CLIENT_ID'), WHOOP_CLIENT_SECRET: secret('WHOOP_CLIENT_SECRET'),
        GOOGLE_SA_KEY: secret('GOOGLE_SA_KEY'), ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'), VAPID_PRIVATE_KEY: secret('VAPID_PRIVATE_KEY'),
        FORGE_TASK: (run.inputs && run.inputs.task) || 'auto', FORGE_PAYLOAD: (run.inputs && run.inputs.payload) || '',
      };
      if (!fs.existsSync(path.join(work, 'automation/forge-automation.mjs'))) throw new Error('automation/forge-automation.mjs is not in the vault');
      const x = await execP(process.execPath, ['automation/forge-automation.mjs'], { cwd: work, env, timeout: 120000 });
      run.log = (x.stdout + x.stderr).trim();
      const changes = new Map();
      const walk = async (d) => { for (const n of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) { const f = path.join(d, n.name); if (n.isDirectory()) await walk(f); else changes.set(path.relative(work, f).split(path.sep).join('/'), await fsp.readFile(f)); } };
      await walk(path.join(work, 'forge/server'));
      for (const [p, bytes] of [...changes]) { const e = flat.get(p); if (e && Buffer.compare(r.objects.get(e.sha).body, bytes) === 0) changes.delete(p); }
      // Only what the automation pushed counts (a run that exits before pushing changes nothing).
      const pushed = await execP('git', ['--git-dir', origin, 'log', '--format=%an', '-1', r.defaultBranch], { env: gitEnv });
      if (changes.size && /forge-bot/.test(pushed.stdout)) gh.commitFiles(r, r.defaultBranch, changes, `forge: automation ${env.FORGE_TASK}`, { name: 'forge-bot', email: 'forge-bot@users.noreply.github.com' });
      run.status = 'completed'; run.conclusion = x.code === 0 ? 'success' : 'failure'; run.updated_at = iso();
      runs.push({ task: env.FORGE_TASK, code: x.code, wrote: [...changes.keys()], log: run.log });
    } catch (e) {
      run.status = 'completed'; run.conclusion = 'failure'; run.updated_at = iso();
      runs.push({ task: run.inputs && run.inputs.task, code: -1, error: e.message });
      report.notes.push('automation runner error: ' + e.message);
    } finally {
      if (!process.env.E2E_KEEP) await fsp.rm(dir, { recursive: true, force: true });
    }
  }
  return { runs, onDispatch: (r, run) => { chain = chain.then(() => execute(r, run)); return chain; } };
}

/* =============================================================== server */
function startStatic() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.yml': 'text/yaml', '.txt': 'text/plain' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith('/forge/')) { res.writeHead(302, { Location: '/forge/' }); return res.end(); }
    p = p.slice('/forge'.length); if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, () => resolve({ srv, base: `http://localhost:${srv.address().port}/forge/` })));
}

/* ================================================================ test */
const report = { flows: [], notes: [], console: [], pageErrors: [], external: [] };
const OWNER = 'e2e-owner'; const VAULT = 'forge-vault'; const PUBLIC = 'forge-public';
const TOKEN_A = 'github_pat_11E2ELAPTOP0_' + alnum(59); const TOKEN_B = 'github_pat_11E2EPHONE00_' + alnum(59);
const PASS1 = 'orbit lantern maple copper thistle'; const PASS2 = 'granite violet harbor pepper summit';
const WEAK = 'password12';
const MARK = { win: 'E2E-WIN-alpha7', plan: 'E2E-PLAN-deepblock', note: 'E2E-MEALNOTE-lemon', journalB: 'E2E-B-JOURNAL-note', v2note: 'E2E-V2-NOTE-marker', name: 'E2E Tester Person' };

const { nacl, openSealed } = await loadNacl();
let runner;
const gh = createGitHubMock({ nacl, openSealed, workflowDelayMs: WORKFLOW_DELAY_MS, onDispatch: (r, run) => runner.onDispatch(r, run) });
runner = createRunner(gh, report);
const claude = createClaudeMock();
const vault = gh.addRepo({ owner: OWNER, name: VAULT, isPrivate: true });
const pub = gh.addRepo({ owner: OWNER, name: PUBLIC, isPrivate: false });
gh.commitFiles(pub, 'main', new Map([['README.md', Buffer.from('# public\n')]]), 'init');
const fullPerms = { contents: 'write', actions: 'write', secrets: 'write', workflows: 'write' };
gh.addToken(TOKEN_A, { label: 'A', repos: [vault.full], perms: fullPerms });
gh.addToken(TOKEN_B, { label: 'B', repos: [vault.full], perms: fullPerms });
const TOKEN_OTHER = 'github_pat_11E2EOTHER000_' + alnum(59); // valid, but its repository selection is another repo
gh.addRepo({ owner: OWNER, name: 'dotfiles', isPrivate: true });
gh.addToken(TOKEN_OTHER, { label: 'other', repos: [`${OWNER}/dotfiles`], perms: fullPerms });

const { srv, base: BASE } = process.env.E2E_BASE ? { srv: null, base: process.env.E2E_BASE } : await startStatic();
const ORIGIN = new URL(BASE).origin;
const browser = await chromium.launch({ headless: !process.env.E2E_HEADED });

let DEK = null; let DEK_RAW = null; let RECOVERY = null;

async function device(label, { mobile = false } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' : undefined,
    timezoneId: 'America/New_York', locale: 'en-US', acceptDownloads: true, colorScheme: 'dark',
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await ctx.route((u) => u.origin !== ORIGIN, (route) => { report.external.push(route.request().method() + ' ' + route.request().url()); return route.abort('blockedbyclient'); });
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const adapt = (mock) => async (route) => {
    const req = route.request();
    const res = await mock.handle({ method: req.method(), url: req.url(), headers: await req.allHeaders(), body: req.postDataBuffer() || Buffer.alloc(0) });
    if (res.abort) return route.abort(res.abort).catch(() => {});
    return route.fulfill({ status: res.status, headers: res.headers, body: res.body }).catch(() => {});
  };
  await ctx.route('https://api.github.com/**', adapt(gh));
  await ctx.route('https://api.anthropic.com/**', adapt(claude));
  await ctx.addInitScript(() => {
    window.__rejections = [];
    window.addEventListener('unhandledrejection', (e) => { window.__rejections.push(String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)); });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`[${label}] ${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => report.pageErrors.push(`[${label}] ${e.message}`));
  const dev = { label, ctx, page, dialogs: [], onDialog: null };
  page.on('dialog', async (d) => {
    dev.dialogs.push(d.type());
    if (dev.onDialog) return dev.onDialog(d);
    report.pageErrors.push(`[${label}] unexpected ${d.type()} dialog: ${d.message()}`);
    await d.dismiss().catch(() => {});
  });
  return dev;
}

/* ------------------------------------------------------------ UI helpers */
const button = (page, name, exact = true) => page.getByRole('button', { name, exact });
const heading = (page, name, timeout = 20000) => page.getByRole('heading', { name }).first().waitFor({ timeout });
const nav = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
const topSheet = (page) => page.locator('.sheet:visible').last();
async function shellReady(page, timeout = 30000) { await page.locator('main.main').waitFor({ timeout }); }
const WEIGHTS = ['181.4'];
async function logWeight(page, value) {
  await page.locator('[data-q=weight]').click();
  await page.getByLabel('Weight in pounds').fill(value);
  await topSheet(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.sheet:visible').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  WEIGHTS.push(value);
}
// Distinct badge states over time (e.g. '1 pending → Syncing → Offline').
async function badgeTimeline(page, ms, { until: stopRe, interval = 250 } = {}) {
  const seen = []; const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const b = String(await badge(page).catch(() => null)).replace('Sync: ', '');
    if (seen[seen.length - 1] !== b) seen.push(b);
    if (stopRe && stopRe.test(b)) break;
    await sleep(interval);
  }
  return seen;
}
async function goToday(page) { await shellReady(page); await nav(page, '#/today'); await heading(page, 'Today'); await page.locator('[data-q=meal]').waitFor(); }
async function badge(page) { return page.locator('[aria-label^="Sync: "]:visible').first().getAttribute('aria-label'); }
async function toastText(page, re, timeout = 15000) {
  const t = page.locator('.toasts .toast', { hasText: re }).first(); await t.waitFor({ timeout }); return t.innerText();
}
async function syncNow(page) {
  await nav(page, '#/settings/sync');
  const b = button(page, 'Sync now'); await b.waitFor();
  await until(async () => b.isEnabled(), { what: 'Sync now enabled', timeout: 30000 });
  const done = page.locator('.toasts .toast', { hasText: /^(Synced|Sync failed|Offline)/ });
  await until(async () => (await done.count()) === 0, { what: 'previous sync toast gone', timeout: 8000 });
  await b.click();
  const t = done.last();
  await t.waitFor({ timeout: 60000 });
  return t.innerText();
}
async function shot(page, name) { try { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); } catch { /* ignore */ } }
async function rejections(page) { try { return await page.evaluate(() => window.__rejections.splice(0)); } catch { return []; } }

/* ------------------------------------------------------ vault inspection */
async function vaultStore() {
  const s = createStore({ owner: 'reader' });
  for (const [p, e] of gh.files(vault)) if (parseShardPath(p)) s.loadShard(p, await C.decodeJson(DEK, p, vault.objects.get(e.sha).body), { source: 'remote' });
  return s;
}
const keyringNow = () => JSON.parse(gh.fileBytes(vault, 'forge/keyring.json').toString('utf8'));

async function noStuckSpinners(d, what) {
  if (!d) return;
  try { await until(async () => (await d.page.locator('.spinner:visible').count()) === 0, { what: `no spinner left on ${d.label} (${what})`, timeout: 20000, interval: 500 }); }
  catch (e) { await shot(d.page, `stuck-spinner-${d.label}`); throw e; }
}
async function flow(n, name, fn) {
  const t0 = Date.now(); process.stdout.write(`\n▶ Flow ${n}: ${name}\n`);
  gh.setFault(null);
  try { await fn(); for (const d of [A, B]) await noStuckSpinners(d, 'end of flow ' + n); report.flows.push({ n, name, ok: true, ms: Date.now() - t0 }); process.stdout.write(`✔ Flow ${n} passed (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`); return true; }
  catch (e) { report.flows.push({ n, name, ok: false, ms: Date.now() - t0, error: e.message }); process.stdout.write(`✘ Flow ${n} FAILED: ${e.stack}\n`); for (const d of [A, B]) if (d) await shot(d.page, `fail-flow${n}-${d.label}`); return false; }
  finally { gh.setFault(null); try { await A.ctx.setOffline(false); } catch { /* closed */ } }
}
const step = (s) => process.stdout.write(`  · ${s}\n`);

/* ======================================================================= */
const A = await device('A');
let B = null;
let jpeg = null;

try {
  // A real JPEG made by the browser (preparePhoto decodes and re-encodes it).
  jpeg = Buffer.from(await A.page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 640, 480); grd.addColorStop(0, '#d9774b'); grd.addColorStop(1, '#f2e6c9'); g.fillStyle = grd; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#e8e2d0'; g.beginPath(); g.arc(320, 240, 170, 0, 7); g.fill(); g.fillStyle = '#f08a5d'; g.fillRect(230, 170, 180, 90);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); return [...new Uint8Array(await blob.arrayBuffer())];
  }));

  const ok1 = await flow(1, 'First run on the laptop', async () => {
    const { page } = A;
    await page.goto(BASE);
    await heading(page, 'Your private performance system');
    await button(page, 'Set up or connect my vault').click();
    await heading(page, 'Connect your vault');
    step('mistyped token and a token without access to the vault are explained');
    await page.getByLabel('Owner').fill(OWNER);
    await page.getByLabel('Repository').fill(VAULT);
    await page.getByLabel('Access token').fill('github_pat_11MISTYPED000_' + alnum(59));
    await button(page, 'Connect').click();
    await page.locator('.notice.bad', { hasText: /GitHub rejected the token/ }).waitFor();
    await page.getByLabel('Access token').fill(TOKEN_OTHER);
    await button(page, 'Connect').click();
    await page.locator('.notice.bad', { hasText: /Repository not found, or this token has no access to it/ }).waitFor();
    assert(!gh.files(vault).size, 'nothing written with a rejected token');
    step('public repository is refused');
    await page.getByLabel('Repository').fill(PUBLIC);
    await page.getByLabel('Access token').fill(TOKEN_A);
    await button(page, 'Connect').click();
    const pubErr = await page.locator('.notice.bad').first().innerText({ timeout: 15000 });
    assert(/PUBLIC/.test(pubErr) && /refuses/.test(pubErr), 'public repo refused with a clear message: ' + pubErr);
    assert(!gh.requests.some((q) => q.path.includes('/' + PUBLIC) && q.method !== 'GET'), 'nothing was written to the public repository');
    assert([...gh.files(pub).keys()].join() === 'README.md', 'public repository untouched');

    step('private (empty) repository accepted');
    await page.getByLabel('Repository').fill(VAULT);
    await button(page, 'Connect').click();
    await heading(page, 'Create your passphrase');
    assert(gh.files(vault).has('README.md'), 'empty vault initialized with a README');
    const initReq = gh.requests.find((q) => q.method === 'PUT' && q.path.endsWith('/contents/README.md'));
    assert(initReq && !('branch' in JSON.parse(initReq.bodyText)), 'first commit of the empty repository lets GitHub pick its default branch');

    step('weak passphrase and mismatch rejected');
    await page.getByLabel('Passphrase', { exact: true }).fill(WEAK);
    await page.getByLabel('Confirm passphrase').fill(WEAK);
    await button(page, 'Create encrypted vault').click();
    await page.getByText(/Choose a stronger passphrase/).waitFor();
    await page.getByLabel('Passphrase', { exact: true }).fill(PASS1);
    await page.getByLabel('Confirm passphrase').fill(PASS1 + 'x');
    await button(page, 'Create encrypted vault').click();
    await page.getByText('Passphrases do not match.').waitFor();
    assert(!gh.files(vault).has('forge/keyring.json'), 'no keyring written for rejected passphrases');

    step('create vault');
    await page.getByLabel('Confirm passphrase').fill(PASS1);
    await button(page, 'Create encrypted vault').click();
    await heading(page, 'Save your recovery key', 45000);
    RECOVERY = (await page.locator('.recovery-key').innerText()).trim();
    assert(/^[0-9A-Z]{4}(-[0-9A-Z]{1,4}){12}$/.test(RECOVERY), 'recovery key format: ' + RECOVERY);

    step('recovery key: copy, download, confirm');
    await button(page, 'Copy key').click();
    await button(page, 'Copied').waitFor();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip === RECOVERY, 'clipboard holds the recovery key');
    const [dl] = await Promise.all([page.waitForEvent('download'), button(page, 'Download as text file').click()]);
    const dlText = fs.readFileSync(await dl.path(), 'utf8');
    assert(dlText.includes(RECOVERY) && dl.suggestedFilename() === 'forge-recovery-key.txt', 'downloaded recovery key file');
    const cont = button(page, 'I saved it — continue');
    assert(await cont.isDisabled(), 'continue disabled before confirming');
    const lastGroup = RECOVERY.split('-').pop();
    const confirmInput = page.getByLabel(/Type the last group/);
    await confirmInput.fill(lastGroup === 'ZZZZ' ? 'YYYY' : 'ZZZZ');
    assert(await cont.isDisabled(), 'continue disabled for a wrong group');
    await confirmInput.fill(lastGroup.toLowerCase());
    assert(await cont.isEnabled(), 'continue enabled for the right group (case-insensitive)');
    const warn = await page.locator('.notice.warn').count();
    assert(!warn, 'no warning about the server key');

    step('FORGE_DATA_KEY secret == vault data key');
    const sec = vault.secrets.get('FORGE_DATA_KEY');
    assert(sec, 'FORGE_DATA_KEY secret written');
    DEK_RAW = new Uint8Array(Buffer.from(sec.value, 'base64'));
    assert(DEK_RAW.length === 32, 'secret is base64 of 32 bytes');
    const kr = keyringNow();
    assert(kr.kid === await C.keyId(DEK_RAW), 'secret matches keyring kid');
    assert(Buffer.compare(Buffer.from(await C.unwrapWithRecovery(kr, RECOVERY)), Buffer.from(DEK_RAW)) === 0, 'recovery key unwraps to the same key');
    assert(Buffer.compare(Buffer.from(await C.unwrapWithPassphrase(kr, PASS1)), Buffer.from(DEK_RAW)) === 0, 'passphrase unwraps to the same key');
    DEK = await C.importDek(DEK_RAW);
    const meta = JSON.parse(gh.fileBytes(vault, 'forge/meta.json').toString());
    assert(meta.schema === 3 && meta.encrypted === true, 'meta.json');
    await until(() => gh.files(vault).has('forge/app/standards.enc'), { what: 'first push of the seeded vault', timeout: 30000 });
    const st0 = await vaultStore();
    assert(st0.all('standards').some((s) => s.name === 'Wake on time'), 'seeded standards decrypt with the secret key');
    await cont.click();

    step('v2 import');
    await heading(page, 'Bring over your old data');
    const v2 = {
      tasks: [
        { id: 't1', name: 'Wake up 6:30am', cat: 'Discipline', w: 3, req: true },
        { id: 't2', name: 'Gym', cat: 'Body', w: 3, req: true },
        { id: 't3', name: 'Read 30 min', cat: 'Mind', w: 2 },
        { id: 't4', name: 'No caffeine after 12pm', cat: 'Recovery', type: 'avoid', w: 1 },
        { id: 't5', name: 'Journal E2E', cat: 'Mind', w: 1 },
      ],
      log: { '2026-09-20': { t1: true, t2: true }, '2026-09-21': { t1: true, t3: true, t5: true }, '2026-09-22': { t2: 1, t4: true, t9: true } },
      snapshots: [{ month: '2026-07', gross: 1000, items: [{ name: 'Checking', type: 'asset', value: 1000 }] }, { month: '2026-08', gross: 1250, items: [{ name: 'Checking', type: 'asset', value: 1250 }] }],
      saved: [{ text: 'E2E quote alpha', who: 'Test Author', ts: 1758000000000 }],
      notes: [{ id: 'n1', text: MARK.v2note, ts: 1758100000000 }],
      settings: { mult: 12, stake: 0, expense: 1500 }, updatedAt: 1758200000000,
    };
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button(page, 'Choose forge-data.json backup').click()]);
    await chooser.setFiles({ name: 'forge-data.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v2)) });
    const good = await page.locator('.notice.good').first().innerText();
    assert(/Imported 5 habits, 7 daily check-ins, 2 finance months, 1 saved quotes? and 1 notes?/.test(good), 'import summary: ' + good);
    await button(page, 'Continue').click();

    step('automation install + ping');
    await heading(page, 'Turn on server automation');
    await button(page, 'Install and test').click();
    await until(async () => (await page.getByText('Automation is live').count()) || (await page.locator('.notice.bad').count()), { what: 'automation result', timeout: 150000, interval: 500 });
    const autoErr = await page.locator('.notice.bad').count() ? await page.locator('.notice.bad').first().innerText() : '';
    assert(!autoErr, 'automation step error: ' + autoErr);
    const wf = gh.fileBytes(vault, '.github/workflows/forge-sync.yml');
    const bundle = gh.fileBytes(vault, 'automation/forge-automation.mjs');
    const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/automation-version.json'), 'utf8'));
    assert(bundle && sha256(bundle) === ver.sha256, 'bundle installed byte-identical (sha256 matches automation-version.json)');
    const expectedWf = fs.readFileSync(path.join(ROOT, 'automation/forge-sync.yml'), 'utf8').split('__BUNDLE_SHA256__').join(ver.sha256);
    assert(wf && wf.toString('utf8') === expectedWf, 'workflow installed with the bundle checksum pinned');
    assert(wf.toString('utf8').includes(`BUNDLE_SHA256: '${sha256(bundle)}'`), 'pinned checksum = sha256 of the installed bundle');
    const ping = runner.runs.find((x) => x.task === 'ping');
    assert(ping && ping.code === 0, 'installed bundle ran the ping with the sealed FORGE_DATA_KEY: ' + JSON.stringify(ping && { code: ping.code, log: ping.log && ping.log.slice(-400) }));
    await button(page, 'Continue').click();

    step('profile');
    await heading(page, 'Baseline');
    await page.getByLabel('Name (optional)').fill(MARK.name);
    await page.getByLabel('Height (ft)').fill('5');
    await page.getByLabel('(in)').fill('11');
    await page.getByLabel('Birth year').fill('1991');
    await page.getByLabel('Current weight').fill('181.4');
    await page.getByLabel('Goal weight — low').fill('185');
    await page.getByLabel('Goal weight — high').fill('195');
    await button(page, 'Finish setup').click();
    await heading(page, 'Today');
    await page.locator('[data-q=weight]').waitFor();

    step('seeds retired by the import, in the vault');
    const st = await until(async () => { await syncNow(page); const s = await vaultStore(); return s.all('journal').length && s.get('settings', 'profile') ? s : null; }, { what: 'import + profile pushed', timeout: 60000, interval: 1000 });
    const std = new Map(st.all('standards').map((s) => [s.id, s]));
    for (const id of ['std-wake', 'std-train', 'std-read', 'std-caffeine']) assert(std.get(id) && std.get(id).active === false, id + ' retired');
    for (const id of ['std-plan', 'std-deep', 'std-protein', 'std-meals', 'std-stack']) assert(std.get(id) && std.get(id).active !== false, id + ' still active');
    assert(st.all('standards').filter((s) => String(s.id).startsWith('v2-')).length === 5, '5 imported standards');
    assert(st.all('checks').length === 7 && st.all('snapshots').length === 2 && st.all('savedQuotes').length === 1, 'imported checks/snapshots/quotes');
    assert(st.setting('finance').mult === 12, 'v2 finance settings');
    assert(st.setting('profile').name === MARK.name && st.setting('profile').heightIn === 71, 'profile saved');
    assert(st.all('body').some((b) => b.weightLb === 181.4), 'baseline weigh-in saved');
    assert(st.setting('integrations').automation && st.setting('integrations').automation.sha256 === ver.sha256, 'automation install recorded');
    assert(st.get('status', 'run') && st.get('status', 'run').lastRunAt, 'server status/run readable');
    await nav(page, '#/settings/security');
    await page.getByText('FORGE_DATA_KEY is set').waitFor({ timeout: 20000 });
    await nav(page, '#/settings/automation');
    await page.locator('.set-status').first().filter({ hasText: /last run|up to date|live/i }).waitFor({ timeout: 20000 });
    report.notes.push('Settings → Automation after setup: ' + (await page.locator('.set-status').first().innerText()).replace(/\s+/g, ' '));
    await shot(page, '1-automation');
  });
  if (!ok1) throw new Error('First run failed; later flows depend on it');

  await flow(2, 'Log data on the laptop, sync, at-rest audit', async () => {
    const { page } = A;
    await nav(page, '#/today'); await heading(page, 'Today');
    step('weigh-in');
    await page.locator('[data-q=weight]').click();
    await heading(page, 'Weigh-in');
    await page.getByLabel('Weight in pounds').fill('182.6');
    await topSheet(page).getByRole('button', { name: 'Save', exact: true }).click();
    await toastText(page, /182\.6 lb saved/);
    WEIGHTS.push('182.6');

    step('check-in');
    await page.locator('[data-q=checkin]').click();
    await heading(page, 'Check-in');
    const s1 = topSheet(page);
    await s1.locator('.day-group', { has: page.locator('.label-text', { hasText: /^Energy$/ }) }).locator('.scale-row button', { hasText: /^4$/ }).click();
    await s1.getByPlaceholder('What went well').fill(MARK.win);
    await s1.getByRole('button', { name: 'Save check-in' }).click();
    await toastText(page, /Check-in saved/);

    step('plan block');
    await page.locator('.card', { has: page.locator('h3', { hasText: /^Timeline$/ }) }).getByRole('button', { name: /Block/ }).first().click();
    await heading(page, 'New block');
    await topSheet(page).getByLabel('Title').fill(MARK.plan);
    await topSheet(page).getByRole('button', { name: 'Add block' }).click();
    await toastText(page, new RegExp('Added ' + MARK.plan));

    step('workout set');
    await page.locator('[data-q=workout]').click();
    await heading(page, 'Start workout');
    await topSheet(page).getByRole('button', { name: 'Empty session' }).click();
    await page.waitForURL(/#\/train\/session\//);
    await button(page, 'Add exercise').first().click();
    await heading(page, 'Add exercise');
    await topSheet(page).getByLabel('Search exercises').fill('Bench Press');
    await topSheet(page).locator('.list-row', { has: page.locator('.title', { hasText: /^Bench Press$/ }) }).first().click();
    await page.getByLabel('Set 1 weight, pounds').fill('185');
    await page.getByLabel('Set 1 reps').fill('5');
    await page.getByRole('checkbox', { name: 'Set 1 done' }).click();
    await until(async () => (await page.getByRole('checkbox', { name: 'Set 1 done' }).getAttribute('aria-checked')) === 'true', { what: 'set 1 done' });

    step('Anthropic key');
    await nav(page, '#/settings/ai');
    await page.getByLabel('Anthropic API key', { exact: true }).fill(AI_KEY);
    await button(page, 'Save on this device').click();
    await toastText(page, /API key saved on this device/);
    await button(page, 'Test saved key').click();
    await page.getByText(/The key works/).waitFor({ timeout: 20000 });

    step('meal photo + AI analysis');
    await nav(page, '#/today'); await heading(page, 'Today');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-q=meal]').click()]);
    await fc.setFiles({ name: 'IMG_E2E.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await heading(page, 'Review photo');
    await page.getByLabel('Note for meal 1').fill(MARK.note);
    const save = topSheet(page).getByRole('button', { name: 'Save & analyze' });
    await until(() => save.isEnabled(), { what: 'photo prepared' });
    await save.click();
    await topSheet(page).getByText(MEAL_TITLE).first().waitFor({ timeout: 30000 });
    await topSheet(page).getByRole('button', { name: 'Done' }).click();
    const mealCall = claude.calls.find((c) => c.body && c.body.tools && c.body.tools.some((t) => t.name === 'record_meal'));
    assert(mealCall && mealCall.body.stream === true, 'meal analysis streamed');

    step('sync and inspect the vault');
    const t = await syncNow(page);
    assert(t === 'Synced', 'sync result: ' + t);
    const st = await until(async () => { const s = await vaultStore(); return s.all('meals').some((m) => m.title === MEAL_TITLE) && s.all('sessions').length ? s : null; }, { what: 'records in the vault', timeout: 30000 });
    assert(st.all('body').some((b) => b.weightLb === 182.6), 'weigh-in in vault');
    assert(st.all('days').some((d) => d.energy === 4 && d.wins === MARK.win), 'check-in in vault');
    assert(st.all('plan').some((p) => p.title === MARK.plan), 'plan block in vault');
    const sess = st.all('sessions')[0];
    assert(sess.entries[0].exerciseId === 'ex-bench-press' && sess.entries[0].sets[0].w === 185 && sess.entries[0].sets[0].reps === 5 && sess.entries[0].sets[0].done !== false, 'workout set in vault: ' + JSON.stringify(sess.entries));
    const meal = st.all('meals').find((m) => m.title === MEAL_TITLE);
    assert(meal.status === 'ready' && meal.items.length === 2 && meal.totals.kcal === 572 && meal.note === MARK.note, 'meal analysis stored: ' + JSON.stringify({ status: meal.status, kcal: meal.totals && meal.totals.kcal }));
    const photo = gh.fileBytes(vault, meal.photo.path);
    assert(/^media\/meals\/\d{4}\/\d{2}\/[a-z0-9]+-0\.enc$/.test(meal.photo.path) && photo, 'meal photo uploaded to ' + meal.photo.path);
    const plainPhoto = Buffer.from(await C.decryptBytes(DEK, new Uint8Array(photo), meal.photo.path));
    assert(plainPhoto[0] === 0xff && plainPhoto[1] === 0xd8, 'photo decrypts to a JPEG');

    step('at-rest audit');
    const files = gh.files(vault);
    const PUBLIC_FILES = new Set(['README.md', 'forge/keyring.json', 'forge/meta.json', '.github/workflows/forge-sync.yml', 'automation/forge-automation.mjs']);
    for (const [p, e] of files) {
      if (PUBLIC_FILES.has(p)) continue;
      assert(/^(forge\/(app|server)\/.+\.enc|media\/.+\.enc)$/.test(p), 'unexpected vault file ' + p);
      const bytes = vault.objects.get(e.sha).body;
      assert(bytes.subarray(0, 4).toString() === 'FRG1', p + ' starts with FRG1');
      await C.decryptBytes(DEK, new Uint8Array(bytes), p); // authenticates (AAD = path)
    }
    assert([...files.keys()].some((p) => p.startsWith('forge/app/')) && [...files.keys()].some((p) => p.startsWith('media/meals/')), 'app shards and media present');
    const kr = keyringNow();
    assert(Object.keys(kr).sort().join() === 'createdAt,kdf,kid,v,wraps', 'keyring holds only wrapped keys: ' + Object.keys(kr));
    await auditPlaintext('after flow 2', [A]);
    await shot(page, '2-synced');
  });

  await flow(3, 'Reload, lock modes, passphrase and recovery-key unlock', async () => {
    const { page } = A;
    await goToday(page);
    step('device mode: reload stays unlocked');
    await page.reload(); await goToday(page);
    await nav(page, '#/settings/security');
    await page.getByRole('group', { name: 'Lock mode' }).getByRole('button', { name: 'Ask every launch' }).click();
    await toastText(page, /asks for the passphrase on every launch/);
    step('session mode: reload locks');
    await page.reload();
    await heading(page, 'Vault locked');
    await page.getByLabel('Passphrase').fill('wrong passphrase entirely');
    await button(page, 'Unlock').click();
    await page.getByText('Wrong passphrase').waitFor({ timeout: 20000 });
    await page.getByLabel('Passphrase').fill(PASS1);
    await button(page, 'Unlock').click();
    await goToday(page);
    step('recovery-key unlock (lowercase, spaces)');
    await page.reload(); await heading(page, 'Vault locked');
    await button(page, 'Use recovery key').click();
    await page.getByLabel('Recovery key').fill(RECOVERY.toLowerCase().replace(/-/g, ' '));
    await button(page, 'Unlock').click();
    await goToday(page);
    const sub = await page.locator('[data-q=meal] .sub').innerText();
    assert(/1 logged/.test(sub), 'data visible after unlock: ' + sub);
    step('back to device mode');
    await nav(page, '#/settings/security');
    await page.getByRole('group', { name: 'Lock mode' }).getByRole('button', { name: 'Stay unlocked' }).click();
    await toastText(page, /stays unlocked/);
    await page.reload(); await goToday(page);
  });

  await flow(4, 'Second device (phone) + concurrent edits converge', async () => {
    B = await device('B', { mobile: true });
    const p = B.page;
    await p.goto(BASE);
    await button(p, 'Set up or connect my vault').click();
    await p.getByLabel('Owner').fill(OWNER);
    await p.getByLabel('Repository').fill(VAULT);
    await p.getByLabel('Access token').fill(TOKEN_B);
    await button(p, 'Connect').click();
    await heading(p, 'Unlock your vault');
    await p.getByLabel('Passphrase').fill(PASS1);
    await button(p, 'Unlock').click();
    await heading(p, 'Today', 30000);
    step('device B sees the laptop data');
    const tile = (k) => p.locator(`[data-q=${k}]`).innerText();
    await until(async () => /1 logged/.test(await tile('meal')), { what: 'meal on B', timeout: 30000 });
    await until(async () => /Done/.test(await tile('checkin')), { what: 'check-in on B' });
    await until(async () => /Resume|1 logged/.test(await tile('workout')), { what: 'workout on B' });
    await until(async () => /18\d\.\d lb/.test(await tile('weight')), { what: 'weigh-in on B' });
    await nav(p, '#/train'); await p.getByText(/Bench Press/).first().waitFor({ timeout: 20000 });
    await nav(p, '#/today'); await heading(p, 'Today');
    await nav(p, '#/fuel'); await p.getByText(MEAL_TITLE).first().waitFor({ timeout: 20000 });
    await until(async () => p.evaluate(() => [...document.querySelectorAll('img')].some((i) => i.src.startsWith('blob:') && i.naturalWidth > 0)), { what: 'meal photo decrypted on B', timeout: 20000 });
    await shot(p, '4-phone-fuel');

    step('concurrent edits: A energy + weigh-in, B mood + journal');
    await nav(A.page, '#/today'); await heading(A.page, 'Today');
    await nav(p, '#/today'); await heading(p, 'Today');
    await A.page.locator('[data-q=checkin]').click();
    const sa = topSheet(A.page);
    await sa.locator('.day-group', { has: A.page.locator('.label-text', { hasText: /^Energy$/ }) }).locator('.scale-row button', { hasText: /^5$/ }).click();
    await sa.getByRole('button', { name: 'Save check-in' }).click();
    await logWeight(A.page, '183.2');
    await p.locator('[data-q=checkin]').click();
    const sb = topSheet(p);
    await sb.locator('.day-group', { has: p.locator('.label-text', { hasText: /^Mood$/ }) }).locator('.scale-row button', { hasText: /^2$/ }).click();
    await sb.getByRole('button', { name: 'Save check-in' }).click();
    await p.locator('[data-q=note]').click();
    await topSheet(p).getByLabel('Entry text').fill(MARK.journalB);
    await topSheet(p).getByRole('button', { name: 'Save', exact: true }).click();
    const refPatches = () => gh.requests.filter((q) => q.endpoint === 'PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}');
    const before = refPatches().length;
    const [ra, rb] = await Promise.all([syncNow(A.page), syncNow(p)]);
    const conflicts = refPatches().slice(before).filter((q) => q.status === 422).length;
    report.notes.push(`concurrent Sync now: A="${ra}", B="${rb}", non-fast-forward rejections retried: ${conflicts}`);
    assert(ra === 'Synced' && rb === 'Synced', 'both synced');
    await syncNow(A.page); await syncNow(p);
    step('both converge, nothing lost or duplicated');
    const st = await vaultStore();
    const today = [...st.all('days')].find((d) => d.wins === MARK.win);
    assert(today && today.energy === 5 && today.mood === 2, 'per-field merge on the days record: ' + JSON.stringify(today && { energy: today.energy, mood: today.mood }));
    assert(st.all('days').length === 1, 'one days record');
    assert(st.all('body').map((b) => String(b.weightLb)).sort().join() === [...WEIGHTS].sort().join(), 'weigh-ins, no duplicates: ' + st.all('body').map((b) => b.weightLb));
    assert(st.all('journal').filter((j) => j.text === MARK.journalB).length === 1, 'journal entry once');
    assert(st.all('meals').length === 1 && st.all('sessions').length === 1 && st.all('plan').length === 1, 'no duplicated meals/sessions/plan');
    for (const d of [A, B]) {
      await nav(d.page, '#/today'); await heading(d.page, 'Today');
      await d.page.locator('[data-q=note] .sub').filter({ hasText: /1 today/ }).waitFor({ timeout: 20000 });
      const wsub = await d.page.locator('[data-q=weight] .sub').innerText();
      assert(/lb/.test(wsub), d.label + ' weight tile ' + wsub);
    }
  });

  await flow(5, 'Passphrase change reaches the other device', async () => {
    const { page } = A;
    const krBefore = keyringNow();
    await nav(page, '#/settings/security');
    await page.getByLabel('Current passphrase').fill(PASS1);
    await page.getByLabel('New passphrase', { exact: true }).fill(PASS2);
    await page.getByLabel('Confirm new passphrase').fill(PASS2);
    await button(page, 'Change passphrase').click();
    await toastText(page, /Passphrase changed/, 45000);
    const kr = keyringNow();
    assert(kr.kid === krBefore.kid && JSON.stringify(kr.wraps.recovery) === JSON.stringify(krBefore.wraps.recovery) && kr.kdf.salt !== krBefore.kdf.salt, 'keyring rewrapped, same key, recovery unchanged');
    assert(Buffer.compare(Buffer.from(await C.unwrapWithPassphrase(kr, PASS2)), Buffer.from(DEK_RAW)) === 0, 'new passphrase unwraps the key');
    let oldWorks = true; try { await C.unwrapWithPassphrase(kr, PASS1); } catch { oldWorks = false; }
    assert(!oldWorks, 'old passphrase no longer unwraps the vault keyring');
    step('B restarts (still unlocked) and adopts the new keyring');
    const p = B.page;
    const keyringReads = () => gh.requests.filter((q) => q.device === 'B' && q.path.includes('/contents/forge/keyring.json')).length;
    const reads0 = keyringReads();
    await p.reload(); await shellReady(p);
    await until(() => keyringReads() > reads0, { what: 'B fetched the keyring', timeout: 20000 });
    await sleep(1500);
    await nav(p, '#/settings/security');
    await button(p, 'Lock now').click();
    await heading(p, 'Vault locked');
    await p.reload(); await heading(p, 'Vault locked');
    await p.getByLabel('Passphrase').fill(PASS1);
    await button(p, 'Unlock').click();
    await p.getByText('Wrong passphrase').waitFor({ timeout: 20000 });
    await p.getByLabel('Passphrase').fill(PASS2);
    await button(p, 'Unlock').click();
    await goToday(p);
    step('A: new passphrase unlocks A too');
    await nav(page, '#/settings/security');
    await button(page, 'Lock now').click();
    await heading(page, 'Vault locked');
    await page.getByLabel('Passphrase').fill(PASS2);
    await button(page, 'Unlock').click();
    await goToday(page);
  });

  await flow(6, 'Forget this device', async () => {
    const p = B.page;
    step('an unsynced edit is uploaded before forgetting');
    await nav(p, '#/today'); await heading(p, 'Today');
    await logWeight(p, '183.9');
    await nav(p, '#/settings/security');
    await button(p, 'Forget this device').click();
    await topSheet(p).getByRole('button', { name: 'Forget this device' }).click();
    await heading(p, 'Your private performance system', 30000);
    const st = await vaultStore();
    assert(st.all('body').some((b) => b.weightLb === 183.9), 'pending weigh-in uploaded before forgetting');
    const idb = await p.evaluate(async () => {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      const out = { dbs: dbs.map((d) => d.name), blobs: -1, meta: -1 };
      if (!out.dbs.includes('forge-v3')) return out;
      const db = await new Promise((res, rej) => { const r = indexedDB.open('forge-v3'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const count = (s) => new Promise((res) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); r.onerror = () => res(-2); });
      out.blobs = await count('blobs'); out.meta = await count('meta'); db.close(); return out;
    });
    assert(!idb.dbs.includes('forge-v3') || (idb.blobs === 0 && idb.meta === 0), 'IndexedDB cleared: ' + JSON.stringify(idb));
    const ls = await p.evaluate(() => Object.keys(localStorage));
    assert(!ls.length, 'localStorage empty: ' + ls);
    await p.reload(); await heading(p, 'Your private performance system');
    step('reconnect B with the recovery key, "Ask every time"');
    await button(p, 'Set up or connect my vault').click();
    await p.getByLabel('Owner').fill(OWNER); await p.getByLabel('Repository').fill(VAULT); await p.getByLabel('Access token').fill(TOKEN_B);
    await button(p, 'Connect').click();
    await heading(p, 'Unlock your vault');
    await button(p, 'Use recovery key instead').click();
    await p.getByLabel('Recovery key').fill(RECOVERY);
    await p.getByRole('button', { name: 'Ask every time', exact: true }).click();
    await button(p, 'Unlock').click();
    await goToday(p);
    await until(async () => /1 logged/.test(await p.locator('[data-q=meal] .sub').innerText()), { what: 'data back on B', timeout: 30000 });
    step('the lock choice made at unlock is honored');
    await p.reload();
    await heading(p, 'Vault locked', 20000);
    await p.getByLabel('Passphrase').fill(PASS2);
    await button(p, 'Unlock').click();
    await goToday(p);
  });

  await flow(7, 'GitHub unreachable: edits stay queued, flush when it is back', async () => {
    const { page } = A;
    await goToday(page);
    await syncNow(page); await goToday(page);
    gh.setFault(() => 'network');
    step('edit while GitHub fails with network errors');
    await logWeight(page, '184.4');
    const tl1 = await badgeTimeline(page, 30000, { until: /Offline|issue/ });
    report.notes.push('badge while GitHub is unreachable: ' + tl1.join(' → '));
    assert(/Offline/.test(tl1[tl1.length - 1]) && !tl1.some((x) => /issue/.test(x)), 'badge ends at Offline, never "Sync issue": ' + tl1.join(' → '));
    const settingsLine = async () => { await nav(page, '#/settings/sync'); const t = await page.locator('.set-status').first().innerText(); await goToday(page); return t; };
    const line = await settingsLine();
    report.notes.push('Settings → Sync while unreachable: ' + line.replace(/\s+/g, ' '));
    assert(/Offline · 1 pending/.test(line), 'settings shows the queued change: ' + line);
    step('reload while unreachable: the edit survives in the local cache');
    await page.reload(); await goToday(page);
    const tl2 = await badgeTimeline(page, 30000, { until: /Offline|issue/ });
    report.notes.push('badge after reload while unreachable: ' + tl2.join(' → '));
    assert(/Offline/.test(tl2[tl2.length - 1]), 'Offline after reload: ' + tl2.join(' → '));
    const line2 = await settingsLine();
    assert(/Offline · 1 pending/.test(line2), 'still queued after reload: ' + line2);
    let st = await vaultStore();
    assert(!st.all('body').some((b) => b.weightLb === 184.4), 'nothing reached the vault while unreachable');
    step('GitHub back: flushes without user action');
    gh.setFault(null);
    const t0 = Date.now();
    await until(async () => { const s2 = await vaultStore(); return s2.all('body').some((b) => b.weightLb === 184.4); }, { what: 'queued edit flushed automatically', timeout: 90000, interval: 1000 });
    report.notes.push(`queued edit reached the vault ${((Date.now() - t0) / 1000).toFixed(0)} s after GitHub came back (no user action; the app retries on its 60 s timer)`);
    await until(async () => (await badge(page)) === 'Sync: Synced', { what: 'badge back to Synced', timeout: 20000 });
    step('browser offline (navigator.onLine = false)');
    await A.ctx.setOffline(true);
    await logWeight(page, '184.9');
    const tl3 = await badgeTimeline(page, 30000, { until: /Offline/ });
    report.notes.push('badge with the browser offline: ' + tl3.join(' → '));
    assert(/Offline/.test(tl3[tl3.length - 1]), 'Offline badge');
    await A.ctx.setOffline(false);
    const t1 = Date.now();
    await until(async () => { const s2 = await vaultStore(); return s2.all('body').some((b) => b.weightLb === 184.9); }, { what: 'flush on the online event', timeout: 30000, interval: 500 });
    report.notes.push(`back online: flushed ${((Date.now() - t1) / 1000).toFixed(1)} s after the online event`);
    st = await vaultStore();
    assert(st.all('body').map((b) => String(b.weightLb)).sort().join() === [...WEIGHTS].sort().join(), `all weigh-ins once: vault ${st.all('body').map((b) => b.weightLb)} vs logged ${WEIGHTS}`);
    await auditPlaintext('end of run', [A, B]);
  });
  await flow(8, 'Replace the GitHub token on a device (photo queued while GitHub was unreachable)', async () => {
    const { page } = A;
    const TOKEN_A2 = 'github_pat_11E2ELAPTOP2_' + alnum(59);
    gh.addToken(TOKEN_A2, { label: 'A2', repos: [vault.full], perms: fullPerms });
    await goToday(page);
    step('photo taken while GitHub is unreachable');
    gh.setFault(() => 'network');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-q=meal]').click()]);
    await fc.setFiles({ name: 'IMG_E2E_2.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await heading(page, 'Review photo');
    const save = topSheet(page).getByRole('button', { name: 'Save & analyze' });
    await until(() => save.isEnabled(), { what: 'photo prepared' });
    await save.click();
    await topSheet(page).locator('.sheet-foot').getByRole('button', { name: /^(Done|Close)$/ }).click({ timeout: 30000 });
    await badgeTimeline(page, 30000, { until: /Offline/ });
    gh.setFault(null);
    step('a wrong token is rejected and the previous one restored');
    await nav(page, '#/settings/sync');
    await page.getByLabel('New GitHub token').fill('github_pat_11WRONG0000000_' + alnum(59));
    await button(page, 'Replace token').click();
    await page.getByText(/GitHub did not accept this token/).waitFor({ timeout: 30000 });
    await button(page, 'Restore the previous token').click();
    await toastText(page, /Previous token restored/, 30000);
    step('replace with a new valid token');
    await page.getByLabel('New GitHub token').fill(TOKEN_A2);
    await button(page, 'Replace token').click();
    await toastText(page, /Token replaced; sync works/, 30000);
    const st = await vaultStore();
    const meals = st.all('meals').filter((m) => m.photo);
    const missing = meals.filter((m) => !gh.fileBytes(vault, m.photo.path)).map((m) => m.photo.path);
    assert(meals.length === 2 && !missing.length, 'every meal photo is in the vault after the token change: missing ' + missing.join(', '));
    step('old token revoked: the device keeps syncing with the new one');
    const n0 = gh.requests.length;
    await goToday(page);
    await logWeight(page, '185.3');
    assert((await syncNow(page)) === 'Synced', 'synced with the new token');
    const used = new Set(gh.requests.slice(n0).map((q) => q.device));
    assert(!used.has('A'), 'no request with the replaced token: ' + [...used]);
    await nav(page, '#/today');
    await page.reload(); await goToday(page);
    assert((await syncNow(page)) === 'Synced', 'the new token was persisted (encrypted) across a reload');
  });

  await flow(9, 'Probes: reload on the recovery-key screen, failing automation run', async () => {
    const r2 = gh.addRepo({ owner: OWNER, name: 'forge-vault-2', isPrivate: true });
    const tok = 'github_pat_11E2EPROBE000_' + alnum(59);
    gh.addToken(tok, { label: 'P', repos: [r2.full], perms: fullPerms });
    const P = await device('P');
    try {
      const p = P.page;
      await p.goto(BASE); await button(p, 'Set up or connect my vault').click();
      await p.getByLabel('Owner').fill(OWNER); await p.getByLabel('Repository').fill(r2.name); await p.getByLabel('Access token').fill(tok);
      await button(p, 'Connect').click(); await heading(p, 'Create your passphrase');
      await p.getByLabel('Passphrase', { exact: true }).fill(PASS1); await p.getByLabel('Confirm passphrase').fill(PASS1);
      await button(p, 'Create encrypted vault').click(); await heading(p, 'Save your recovery key', 45000);
      P.onDialog = (d) => d.dismiss(); // "Stay on page"
      await p.reload({ timeout: 5000 }).catch(() => {});
      await sleep(500);
      const guarded = P.dialogs.includes('beforeunload') && (await p.getByRole('heading', { name: 'Save your recovery key' }).count()) === 1;
      report.notes.push(`reload on the recovery-key screen → ${guarded ? '"Leave site?" prompt; staying keeps the key on screen' : 'NO prompt'}`);
      assert(guarded, 'the recovery-key screen asks before a reload discards the key');
      P.onDialog = (d) => d.accept(); // the user leaves anyway
      await p.reload();
      await until(async () => (await p.locator('main.main').count()) || (await p.getByRole('heading', { name: /recovery key|Unlock|Vault locked|private performance/i }).count()), { what: 'screen after reload', timeout: 20000 });
      const onShell = await p.locator('main.main').count();
      const h1 = await p.locator('h1').first().innerText().catch(() => '?');
      report.notes.push(`leaving anyway → ${onShell ? 'app shell (' + h1 + '): the recovery key is not shown again and the import/automation/profile steps are skipped' : 'setup screen "' + h1 + '"'}; FORGE_DATA_KEY secret ${r2.secrets.has('FORGE_DATA_KEY') ? 'was' : 'was NOT'} saved`);
      step('a failing automation run ends the wait early (no FORGE_DATA_KEY)');
      r2.secrets.delete('FORGE_DATA_KEY');
      await nav(p, '#/settings/automation');
      const t0 = Date.now();
      await button(p, 'Install automation').click();
      const err = p.locator('.notice.bad', { hasText: /run failed on GitHub/ });
      await err.waitFor({ timeout: 90000 });
      const secs = (Date.now() - t0) / 1000;
      const probeRun = runner.runs.filter((x) => x.task === 'ping').pop();
      report.notes.push(`automation run without FORGE_DATA_KEY (bundle exit ${probeRun && probeRun.code}): Settings → Automation reported "${(await err.innerText()).replace(/\s+/g, ' ').slice(0, 90)}…" after ${secs.toFixed(0)} s (the wait times out after 4 min)`);
      assert(probeRun && probeRun.code !== 0, 'the installed bundle refuses to run without FORGE_DATA_KEY');
      assert(secs < 60, 'failure surfaced quickly');
      step('remedy: Settings → Security → send the data key, then test the automation');
      await nav(p, '#/settings/security');
      await p.getByText('FORGE_DATA_KEY is missing').waitFor({ timeout: 20000 }).catch(() => {}); // secret names are cached for a minute
      const block = p.locator('.set-block', { has: p.locator('h3', { hasText: /^Server data key$/ }) });
      await block.getByLabel('Passphrase').fill(PASS1);
      await block.getByRole('button', { name: 'Send data key to GitHub' }).click();
      await toastText(p, /Server data key saved/, 45000);
      const sent = r2.secrets.get('FORGE_DATA_KEY');
      assert(sent && (await C.keyId(new Uint8Array(Buffer.from(sent.value, 'base64')))) === JSON.parse(gh.fileBytes(r2, 'forge/keyring.json').toString()).kid, 're-sent key matches the probe vault');
      await nav(p, '#/settings/automation');
      await button(p, 'Test connection').click();
      await toastText(p, /Automation responded/, 90000);
      report.notes.push('remedy for a missing FORGE_DATA_KEY (Security → Send data key, Automation → Test connection) works');
    } finally { await P.ctx.close(); }
  });
} catch (e) {
  report.notes.push('aborted: ' + e.message);
} finally {
  for (const d of [A, B].filter(Boolean)) { const r = await rejections(d.page); for (const x of r) report.pageErrors.push(`[${d.label}] unhandled rejection: ${x}`); }
  await browser.close();
  if (srv) srv.close();
}

/* --------------------------------------------------------- plaintext audit */
async function auditPlaintext(when, devices) {
  const markers = {
    passphrase1: PASS1, passphrase2: PASS2, tokenA: TOKEN_A, tokenB: TOKEN_B, anthropicKey: AI_KEY, recoveryKey: RECOVERY, recoveryKeyRaw: RECOVERY.replace(/-/g, ''),
    mealTitle: MEAL_TITLE, mealNote: MARK.note, checkinWins: MARK.win, planTitle: MARK.plan, journalB: MARK.journalB, v2note: MARK.v2note, profileName: MARK.name,
    weight: '182.6', dekBase64: Buffer.from(DEK_RAW).toString('base64'), dekRaw: Buffer.from(DEK_RAW), jpegHead: jpeg.subarray(0, 48), jfif: Buffer.from('ffd8ffe000104a464946', 'hex'), exercise: 'ex-bench-press', item: 'Baked salmon',
  };
  const code = new Set(['automation/forge-automation.mjs', '.github/workflows/forge-sync.yml'].map((p) => { const e = gh.files(vault).get(p); return e && e.sha; }).filter(Boolean));
  const hits = [];
  const scan = (where, buf) => { for (const [k, v] of Object.entries(markers)) if (v && Buffer.from(buf).includes(Buffer.isBuffer(v) ? v : Buffer.from(v))) hits.push(`${k} in ${where}`); };
  for (const [sha, o] of vault.objects) { if (code.has(sha)) continue; scan(`vault ${o.type} ${sha.slice(0, 8)}`, o.body); }
  for (const q of gh.requests) {
    scan(`request URL ${q.method} ${q.path}`, Buffer.from(q.path));
    if (!q.bodyText) continue;
    let body = q.bodyText; try { const j = JSON.parse(body); if (typeof j.content === 'string' && j.encoding !== 'utf-8') body = body.replace(j.content, ''); } catch { /* not json */ }
    if (/\/contents\/automation\/forge-automation\.mjs|\/contents\/\.github\//.test(q.path)) continue;
    scan(`request body ${q.method} ${q.path}`, Buffer.from(body));
  }
  for (const d of devices) {
    if (!d) continue;
    const dump = await d.page.evaluate(async () => {
      const out = { ls: JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)), idb: [] };
      if (!(await indexedDB.databases()).some((x) => x.name === 'forge-v3')) return out;
      const db = await new Promise((res, rej) => { const r = indexedDB.open('forge-v3'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const all = (s, keys) => new Promise((res) => { const r = db.transaction(s).objectStore(s)[keys ? 'getAllKeys' : 'getAll'](); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
      const enc = (v) => { if (v instanceof Uint8Array) { let s = ''; for (const b of v) s += String.fromCharCode(b); return { __u8: btoa(s) }; } if (v instanceof CryptoKey) return `CryptoKey(extractable=${v.extractable})`; if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o; } return v; };
      const keys = await all('meta', true); const vals = await all('meta');
      keys.forEach((k, i) => out.idb.push({ store: 'meta', key: k, v: enc(vals[i]) }));
      for (const b of await all('blobs')) out.idb.push({ store: 'blobs', key: b.path, v: enc(b) });
      db.close(); return out;
    });
    scan(`${d.label} localStorage/sessionStorage`, Buffer.from(dump.ls));
    for (const e of dump.idb) {
      const u8 = (x) => (x && typeof x === 'object' && typeof x.__u8 === 'string' ? Buffer.from(x.__u8, 'base64') : null);
      const raw = u8(e.v) || (e.v && typeof e.v === 'object' ? u8(e.v.bytes) : null);
      if (raw && e.store === 'blobs') assert(raw.subarray(0, 4).toString() === 'FRG1', `${d.label} IndexedDB blob ${e.key} is encrypted`);
      scan(`${d.label} IndexedDB ${e.store}/${e.key}`, raw || Buffer.from(JSON.stringify(e.v)));
      if (e.key === 'dek') assert(String(e.v) === 'CryptoKey(extractable=false)', `${d.label} stored data key is a non-extractable CryptoKey: ${e.v}`);
      if (e.key === 'creds') assert(raw && raw.subarray(0, 4).toString() === 'FRG1', `${d.label} credentials stored as an encrypted blob`);
    }
  }
  report.notes.push(`plaintext audit (${when}): ${hits.length ? 'LEAKS: ' + hits.join('; ') : 'no marker found in vault objects, request URLs/bodies, IndexedDB, localStorage'}`);
  assert(!hits.length, 'plaintext found: ' + hits.join('; '));
}

/* ------------------------------------------------------------------ report */
const endpoints = new Map();
for (const q of gh.requests) { const k = q.endpoint || `${q.method} ${q.path}`; const e = endpoints.get(k) || { n: 0, statuses: new Set(), devices: new Set() }; e.n++; e.statuses.add(q.status); e.devices.add(q.device); endpoints.set(k, e); }
const lines = [];
lines.push('\n================ FORGE E2E report ================');
for (const f of report.flows) lines.push(`${f.ok ? 'PASS' : 'FAIL'}  Flow ${f.n}: ${f.name} (${(f.ms / 1000).toFixed(1)} s)${f.ok ? '' : '\n      ' + f.error}`);
lines.push('\nGitHub endpoints used (count, statuses, devices):');
for (const [k, e] of [...endpoints].sort()) lines.push(`  ${k}  ×${e.n}  [${[...e.statuses].join(',')}]  {${[...e.devices].join(',')}}`);
lines.push(`\nAnthropic calls: ${claude.calls.length} (${claude.calls.map((c) => `${c.body && c.body.model}${c.body && c.body.stream ? ' stream' : ''}${c.body && c.body.tools ? ' tools=' + c.body.tools.map((t) => t.name).join('+') : ''}`).join('; ')})`);
lines.push(`Automation runs: ${runner.runs.map((r) => `${r.task}→exit ${r.code}${r.wrote && r.wrote.length ? ' wrote ' + r.wrote.join(',') : ''}`).join('; ') || 'none'}`);
const vioCount = new Map();
for (const v of gh.violations) { const k = `${v.req.endpoint || `${v.req.method} ${v.req.path}`}: ${v.msg}`; vioCount.set(k, (vioCount.get(k) || 0) + 1); }
for (const v of claude.violations) { const k = 'anthropic: ' + v; vioCount.set(k, (vioCount.get(k) || 0) + 1); }
const vio = [...vioCount].map(([k, n]) => `${k}${n > 1 ? `  (×${n})` : ''}`);
lines.push(`\nAPI contract violations: ${vio.length ? '\n  ' + vio.join('\n  ') : 'none'}`);
lines.push(`Unexpected external requests: ${report.external.length ? '\n  ' + [...new Set(report.external)].join('\n  ') : 'none'}`);
lines.push(`Page errors / unhandled rejections: ${report.pageErrors.length ? '\n  ' + report.pageErrors.join('\n  ') : 'none'}`);
const cons = [...new Set(report.console)];
lines.push(`Console errors/warnings (${cons.length} distinct): ${cons.length ? '\n  ' + cons.slice(0, 60).join('\n  ') : 'none'}`);
lines.push(`\nNotes:\n  ${report.notes.join('\n  ')}`);
lines.push(`\nArtifacts: ${OUT}`);
const text = lines.join('\n');
console.log(text);
fs.writeFileSync(path.join(OUT, 'report.txt'), text);
fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(gh.requests.map(({ bodyText, ...q }) => q), null, 1));
const failed = report.flows.filter((f) => !f.ok).length + (report.flows.length < 9 ? 1 : 0) + (vio.length ? 1 : 0) + (report.pageErrors.length ? 1 : 0) + (report.external.length ? 1 : 0);
process.exit(failed ? 1 : 0);
