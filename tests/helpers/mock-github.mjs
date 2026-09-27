// In-memory stand-in for the subset of the GitHub Git Data API used by js/core/sync.js.
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export function createMockRepo() {
  const blobs = new Map();   // sha -> Uint8Array
  const trees = new Map();   // sha -> [{path, mode, type, sha}] (one level)
  const commits = new Map(); // sha -> {tree, parents, message}
  let head = null;
  const calls = [];

  function putBlob(bytes) { const s = sha1('blob:' + Buffer.from(bytes).toString('base64')); blobs.set(s, new Uint8Array(bytes)); return s; }
  function putTree(entries) {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
    const s = sha1('tree:' + JSON.stringify(sorted)); trees.set(s, sorted); return s;
  }
  function flatten(treeSha, prefix = '', out = new Map()) {
    if (!treeSha) return out;
    for (const e of trees.get(treeSha) || []) {
      const p = prefix + e.path;
      if (e.type === 'tree') flatten(e.sha, p + '/', out); else out.set(p, e.sha);
    }
    return out;
  }
  function build(flat) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [p, s] of flat) {
      const parts = p.split('/'); let node = root;
      for (let i = 0; i < parts.length - 1; i++) { if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { files: new Map(), dirs: new Map() }); node = node.dirs.get(parts[i]); }
      node.files.set(parts[parts.length - 1], s);
    }
    const write = (node) => {
      const entries = [];
      for (const [name, s] of node.files) entries.push({ path: name, mode: '100644', type: 'blob', sha: s });
      for (const [name, sub] of node.dirs) entries.push({ path: name, mode: '040000', type: 'tree', sha: write(sub) });
      return putTree(entries);
    };
    return write(root);
  }

  const gh = {
    owner: 'o', repo: 'r', branch: 'main',
    async getHead() { calls.push('getHead'); return head; },
    async getCommit(sha) { calls.push('getCommit'); const c = commits.get(sha); if (!c) throw Object.assign(new Error('no commit'), { status: 404 }); return { sha, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) }; },
    async getTree(sha, recursive = false) {
      calls.push('getTree');
      if (!trees.has(sha)) throw Object.assign(new Error('no tree'), { status: 404 });
      if (!recursive) return { sha, tree: trees.get(sha), truncated: false };
      const out = [];
      const walk = (s, prefix) => { for (const e of trees.get(s)) { out.push({ ...e, path: prefix + e.path }); if (e.type === 'tree') walk(e.sha, prefix + e.path + '/'); } };
      walk(sha, ''); return { sha, tree: out, truncated: false };
    },
    async getBlob(sha) { calls.push('getBlob'); const b = blobs.get(sha); if (!b) throw Object.assign(new Error('no blob'), { status: 404 }); return new Uint8Array(b); },
    async createBlob(bytes) { calls.push('createBlob'); return putBlob(bytes); },
    async createTree(baseTree, entries) {
      calls.push('createTree');
      const flat = flatten(baseTree);
      for (const e of entries) { if (e.sha === null) flat.delete(e.path); else flat.set(e.path, e.sha); }
      return build(flat);
    },
    async createCommit(message, tree, parents) { calls.push('createCommit'); const s = sha1('commit:' + tree + parents.join(',') + message + Math.random()); commits.set(s, { tree, parents, message }); return s; },
    async updateHead(sha) {
      calls.push('updateHead');
      const c = commits.get(sha);
      if (head && !c.parents.includes(head)) throw Object.assign(new Error('Update is not a fast forward'), { status: 422 });
      head = sha; return true;
    },
    async getFile(path) { const flat = flatten(head ? commits.get(head).tree : null); const s = flat.get(path); return s ? { sha: s, bytes: blobs.get(s) } : null; },
    async putFile(path, bytes, message) {
      const flat = flatten(head ? commits.get(head).tree : null); flat.set(path, putBlob(bytes));
      const tree = build(flat); const c = sha1('commit:' + tree + message + Math.random()); commits.set(c, { tree, parents: head ? [head] : [], message }); head = c;
      return { sha: flat.get(path), commit: c };
    },
  };

  return {
    gh,
    calls,
    files() { return head ? flatten(commits.get(head).tree) : new Map(); },
    blob: (sha) => blobs.get(sha),
    get head() { return head; },
    // Simulate another writer committing directly (e.g. automation).
    async externalWrite(path, bytes) { return gh.putFile(path, bytes, 'external'); },
  };
}
