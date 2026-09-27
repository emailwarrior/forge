// Minimal GitHub REST client (browser + Node). Git Data API for atomic multi-file commits.
import { bytesToB64, b64ToBytes, utf8ToB64, sleep } from './util.js';

export class GitHubError extends Error {
  constructor(status, message, extra = {}) { super(message); this.name = 'GitHubError'; this.status = status; Object.assign(this, extra); }
}

const API = 'https://api.github.com';

export function createGitHub({ token, owner, repo, branch = 'main', fetchImpl, apiBase = API } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const base = `/repos/${owner}/${repo}`;

  async function request(method, path, body, { accept, raw = false, allow404 = false, retries = 3 } = {}) {
    const url = (path.startsWith('http') ? path : apiBase + path);
    // No X-GitHub-Api-Version header: api.github.com's CORS preflight has rejected it for browsers
    // (github.com/orgs/community/discussions/40619), which would block every request from the app.
    // Without the header GitHub serves the 2022-11-28 version, the one this client is written for.
    const headers = { Accept: accept || 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
      } catch (e) {
        if (attempt++ < retries) { await sleep(400 * 2 ** attempt); continue; }
        throw new GitHubError(0, 'Network error: ' + (e && e.message || e), { network: true });
      }
      if (res.status === 404 && allow404) return null;
      if (res.status === 204) return true;
      if (res.ok) {
        if (raw) return new Uint8Array(await res.arrayBuffer());
        const text = await res.text();
        return text ? JSON.parse(text) : true;
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      let msg = res.statusText; let data = null;
      try { data = await res.json(); msg = data.message || msg; } catch { /* ignore */ }
      const rateLimited = res.status === 429 || (res.status === 403 && (remaining === '0' || /rate limit/i.test(msg)));
      if ((rateLimited || res.status >= 500) && attempt++ < retries) {
        await sleep(retryAfter ? retryAfter * 1000 : 1000 * 2 ** attempt); continue;
      }
      throw new GitHubError(res.status, msg, { rateLimited, data });
    }
  }

  const api = {
    owner, repo, branch, request,
    getRepo: () => request('GET', base),
    async getHead() {
      try {
        const ref = await request('GET', `${base}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, { allow404: true });
        return ref ? ref.object.sha : null;
      } catch (e) { if (e.status === 409) return null; throw e; } // 409 = empty repository
    },
    getCommit: (sha) => request('GET', `${base}/git/commits/${sha}`),
    getTree: (sha, recursive = false) => request('GET', `${base}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`),
    async getBlob(sha) {
      const b = await request('GET', `${base}/git/blobs/${sha}`);
      return b64ToBytes(b.content);
    },
    async createBlob(bytes) {
      const r = await request('POST', `${base}/git/blobs`, { content: bytesToB64(bytes), encoding: 'base64' });
      return r.sha;
    },
    async createTree(baseTree, entries) {
      const r = await request('POST', `${base}/git/trees`, { base_tree: baseTree || undefined, tree: entries });
      return r.sha;
    },
    async createCommit(message, tree, parents) {
      const r = await request('POST', `${base}/git/commits`, { message, tree, parents });
      return r.sha;
    },
    async updateHead(sha) {
      return request('PATCH', `${base}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false }, { retries: 0 });
    },
    // Contents API — for small plaintext files and for initializing empty repos.
    async getFile(path) {
      const r = await request('GET', `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, undefined, { allow404: true });
      if (!r) return null;
      if (Array.isArray(r)) throw new GitHubError(400, path + ' is a directory');
      const bytes = r.content ? b64ToBytes(r.content) : await request('GET', r.git_url.replace(API, apiBase), undefined).then((b) => b64ToBytes(b.content));
      return { sha: r.sha, bytes };
    },
    async getRaw(path) {
      return request('GET', `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, undefined, { accept: 'application/vnd.github.raw+json', raw: true, allow404: true });
    },
    async putFile(path, bytes, message, sha, { defaultBranch = false } = {}) {
      const body = { message, content: bytesToB64(bytes) };
      if (!defaultBranch) body.branch = branch;
      if (sha) body.sha = sha;
      const r = await request('PUT', `${base}/contents/${encodePath(path)}`, body, { retries: 1 });
      return { sha: r.content.sha, commit: r.commit.sha };
    },
    putText: (path, text, message, sha) => api.putFile(path, new TextEncoder().encode(text), message, sha),
    // Actions
    async dispatch(workflowFile, inputs = {}) {
      return request('POST', `${base}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, { ref: branch, inputs }, { retries: 1 });
    },
    async listRuns(workflowFile, perPage = 5) {
      const r = await request('GET', `${base}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${perPage}`, undefined, { allow404: true });
      return r ? r.workflow_runs : [];
    },
    // Secrets
    getSecretsKey: () => request('GET', `${base}/actions/secrets/public-key`),
    async listSecrets() { const r = await request('GET', `${base}/actions/secrets?per_page=100`); return r.secrets.map((s) => s.name); },
    putSecret: (name, encryptedB64, keyIdValue) => request('PUT', `${base}/actions/secrets/${encodeURIComponent(name)}`, { encrypted_value: encryptedB64, key_id: keyIdValue }),
    deleteSecret: (name) => request('DELETE', `${base}/actions/secrets/${encodeURIComponent(name)}`, undefined, { allow404: true }),
  };
  return api;
}

function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

// Initialize an empty repository with a README so the Git Data API works. An empty repository has
// no branch yet, so no `branch` is sent: GitHub creates the repository's default branch, the one
// connect() read from the repository metadata.
export async function ensureInitialized(gh) {
  const head = await gh.getHead();
  if (head) return head;
  await gh.putFile('README.md', new TextEncoder().encode('# forge-vault\n\nPrivate, end-to-end encrypted data store for FORGE. Files under `forge/` and `media/` are encrypted.\n'), 'Initialize vault', undefined, { defaultBranch: true });
  return gh.getHead();
}

export { utf8ToB64 };
