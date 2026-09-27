import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, waitForStatus, WORKFLOW_FILE } from '../../js/app/integrations.js';

function pollSession({ status = () => null, runs = () => [] } = {}) {
  const s = { pulls: 0, listed: 0 };
  s.sync = { pull: async () => { s.pulls++; } };
  s.store = { get: (coll, id) => (coll === 'status' ? status(id, s) : null) };
  s.gh = { listRuns: async (file, n) => { s.listed++; assert.equal(file, WORKFLOW_FILE); return runs(s).slice(0, n); } };
  return s;
}
const run = (o) => ({ event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), ...o });

test('waitForStatus: resolves once the server status is newer than the dispatch', async () => {
  const since = Date.now();
  const s = pollSession({ status: (id, x) => (id === 'run' && x.pulls >= 2 ? { id: 'run', lastRunAt: new Date().toISOString() } : { id: 'run', lastRunAt: new Date(since - 3600e3).toISOString() }) });
  const st = await waitForStatus(s, 'run', since, { pollMs: 1 });
  assert.ok(Date.parse(st.lastRunAt) >= since - 5000);
  assert.equal(s.pulls, 2);
});

test('waitForStatus: a dispatched run that already failed ends the wait early', async () => {
  const since = Date.now();
  const s = pollSession({ runs: () => [run({ conclusion: 'failure' }), run({ created_at: new Date(since - 3600e3).toISOString() })] });
  await assert.rejects(waitForStatus(s, 'run', since, { pollMs: 1, timeoutMs: 5000 }), /run failed on GitHub \(failure\).*FORGE_DATA_KEY/);
  assert.equal(s.pulls, 3, 'runs are checked every third poll');
});

test('waitForStatus: older, scheduled or still-running runs do not end the wait', async () => {
  const since = Date.now();
  const s = pollSession({ runs: () => [run({ status: 'in_progress', conclusion: null }), run({ event: 'schedule', conclusion: 'failure' }), run({ conclusion: 'failure', created_at: new Date(since - 3600e3).toISOString() })] });
  await assert.rejects(waitForStatus(s, 'run', since, { pollMs: 1, timeoutMs: 60 }), /No response from automation yet/);
  assert.ok(s.listed >= 1);
  const broken = pollSession(); broken.gh.listRuns = async () => { throw new Error('403'); };
  await assert.rejects(waitForStatus(broken, 'run', since, { pollMs: 1, timeoutMs: 40 }), /No response from automation yet/);
});

function fakeSession(failures, status = 404) {
  const calls = []; let flushed = 0;
  return {
    calls, get flushed() { return flushed; },
    sync: { flush: async () => { flushed++; } },
    gh: { async dispatch(file, inputs) { calls.push({ file, inputs }); if (calls.length <= failures) throw Object.assign(new Error('Not Found'), { status }); return true; } },
  };
}

test('dispatch: flushes, then dispatches the workflow with task + payload', async () => {
  const s = fakeSession(0);
  const since = await dispatch(s, 'ping');
  assert.equal(s.flushed, 1);
  assert.deepEqual(s.calls, [{ file: WORKFLOW_FILE, inputs: { task: 'ping', payload: '' } }]);
  assert.ok(Math.abs(since - Date.now()) < 1000);
});

test('dispatch: a just-installed workflow that GitHub has not registered yet (404) is retried', async () => {
  const s = fakeSession(2);
  await dispatch(s, 'ping', '', { waitForWorkflowMs: 1000, retryDelayMs: 5 });
  assert.equal(s.calls.length, 3);
});

test('dispatch: without waiting, or once the wait is over, 404 means the workflow is not installed', async () => {
  await assert.rejects(dispatch(fakeSession(1), 'ping'), /Workflow not installed yet/);
  const s = fakeSession(1000);
  await assert.rejects(dispatch(s, 'ping', '', { waitForWorkflowMs: 30, retryDelayMs: 5 }), /Workflow not installed yet/);
  assert.ok(s.calls.length >= 2 && s.calls.length <= 8, `retried within the wait (${s.calls.length} calls)`);
  await assert.rejects(dispatch(fakeSession(1, 403), 'ping', '', { waitForWorkflowMs: 1000, retryDelayMs: 5 }), /Actions: Read and write/);
});
