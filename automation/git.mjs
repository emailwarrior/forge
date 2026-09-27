// Git persistence for automation (runs in the Actions checkout of the vault).
// Commits only the server shards this run wrote, then pull --rebase + push with retries.
// Credentials come from actions/checkout (persist-credentials); nothing here handles tokens.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { shortError, backoffMs, realSleep } from './log.mjs';

export const BOT_NAME = 'forge-bot';
export const BOT_EMAIL = 'forge-bot@users.noreply.github.com';

function exec(cwd, args, env) {
  return new Promise((done) => {
    execFile('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      done({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

const lastLine = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';

// Secrets never reach git subprocesses (hooks, credential helpers): pass everything except them.
const SECRET_ENV = new Set(['FORGE_DATA_KEY', 'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'GOOGLE_SA_KEY', 'ANTHROPIC_API_KEY', 'VAPID_PRIVATE_KEY', 'FORGE_PAYLOAD']);
export function gitSafeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!SECRET_ENV.has(k)) out[k] = v;
  return out;
}

export function createGit({ cwd, env = process.env, log = null, sleep = realSleep, attempts = 5 } = {}) {
  const gitEnv = {
    ...gitSafeEnv(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL,
    LC_ALL: 'C',
  };
  const git = (args) => exec(cwd, args, gitEnv);
  const failure = (what, r) => new Error(`git ${what} failed: ${shortError(lastLine(r && (r.stderr || r.stdout)))}`);
  const pending = new Set();   // written by us, not yet committed
  let unpushed = false;        // local commits the remote does not have yet
  let branch = null;

  async function currentBranch() {
    if (branch) return branch;
    const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    branch = (r.ok && r.stdout) || env.GITHUB_REF_NAME || 'main';
    return branch;
  }

  async function rebaseInProgress() {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const r = await git(['rev-parse', '--git-path', name]);
      if (r.ok && r.stdout && existsSync(resolve(cwd, r.stdout))) return true;
    }
    return false;
  }

  async function commit(message) {
    const paths = [...pending];
    if (!paths.length) return false;
    const add = await git(['add', '-A', '--', ...paths]);
    if (!add.ok) throw failure('add', add);
    const diff = await git(['diff', '--cached', '--quiet', '--', ...paths]);
    if (diff.ok) { pending.clear(); return false; }   // content identical to HEAD: skip the commit
    const c = await git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message, '--', ...paths]);
    if (!c.ok) throw failure('commit', c);
    pending.clear();
    unpushed = true;
    return true;
  }

  async function push() {
    const b = await currentBranch();
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const pull = await git(['-c', 'commit.gpgsign=false', 'pull', '--rebase', '--autostash', '-q', 'origin', b]);
      if (!pull.ok) {
        if (await rebaseInProgress()) {
          await git(['rebase', '--abort']);
          throw failure('pull --rebase (conflict)', pull);
        }
        last = pull;
        if (log) log.warn(`git: pull failed (attempt ${attempt}/${attempts})`);
      } else {
        const p = await git(['push', '-q', 'origin', `HEAD:refs/heads/${b}`]);
        if (p.ok) { unpushed = false; return attempt; }
        last = p;
        if (log) log.warn(`git: push rejected (attempt ${attempt}/${attempts})`);
      }
      if (attempt < attempts) await sleep(backoffMs(attempt));
    }
    throw failure('push', last);
  }

  return {
    // Remember files written to the working tree; the next commit includes them.
    stage(paths) { for (const p of paths || []) pending.add(p); },
    // Commit staged shards (skipped when nothing changed) and push any unpushed commits.
    async commitAndPush(message) {
      const committed = await commit(message);
      if (!unpushed) return { committed, pushed: false, attempts: 0 };
      const n = await push();
      return { committed, pushed: true, attempts: n };
    },
    get unpushed() { return unpushed; },
    get pendingCount() { return pending.size; },
  };
}
