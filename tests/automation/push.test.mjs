import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutomation } from '../../automation/run.mjs';
import { createECDH, randomBytes } from 'node:crypto';
import { isQuiet, DEFAULT_SUBJECT, normalizeKey } from '../../automation/push.mjs';
import { createLogger } from '../../automation/log.mjs';
import { hashId } from '../../js/core/util.js';
import { makeVault, senderStub, addPushSubs, stubDeps, SUBS, noSleep, edt } from './fixtures/helpers.mjs';

const log = () => createLogger({ quiet: true });
const VAPID_PUBLIC = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

function pushVault(extra = {}) {
  return makeVault({
    server: true,   // demo WHOOP data: today's recovery is scored
    mutate: (app) => {
      app.updateSetting('integrations', { push: { vapidPublicKey: VAPID_PUBLIC, subject: 'https://example.github.io/forge/' } });
      addPushSubs(app);
      if (extra.mutate) extra.mutate(app);
    },
  });
}

async function notify(v, at, { sender, deps = stubDeps().deps } = {}) {
  return runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'notify', VAPID_PRIVATE_KEY: 'test-private-key-value-not-real' }), now: () => at, sleep: noSleep, deps, sender, git: false, log: log() });
}

test('push: quiet hours wrap midnight', () => {
  assert.equal(isQuiet(23 * 60, '22:45', '06:00'), true);
  assert.equal(isQuiet(3 * 60, '22:45', '06:00'), true);
  assert.equal(isQuiet(6 * 60, '22:45', '06:00'), false);
  assert.equal(isQuiet(12 * 60, '13:00', '14:00'), false);
  assert.equal(isQuiet(13 * 60 + 30, '13:00', '14:00'), true);
  assert.equal(isQuiet(12 * 60, '', '06:00'), false);
  assert.equal(DEFAULT_SUBJECT, 'mailto:noreply@forge.invalid');
});

test('push: morning brief once per day after recovery is scored, never in quiet hours', async () => {
  const v = await pushVault();
  const long = 'Recovery 72 is in the green band. Day 2 after a peptide dose; 3 drinks yesterday.';
  const { deps } = stubDeps({ readiness: { status: 'ok', band: 'green', score: 72, summary: long, training: { mode: 'push', label: 'Push', strainTarget: [14, 18] }, focus: { start: '09:00', end: '11:00' } } });

  const q = senderStub();
  const r0 = await notify(v, edt('2026-09-26', '04:10'), { sender: q.sender, deps });
  assert.equal(r0.results.push, 'ok');
  assert.equal(q.sent.length, 0, '04:10 is inside quiet hours');

  const s = senderStub();
  const r = await notify(v, edt('2026-09-26', '07:10'), { sender: s.sender, deps });
  assert.equal(r.results.push, 'ok');
  assert.equal(s.sent.length, 2, 'one per active subscription');
  const p = s.sent[0].payload;
  assert.deepEqual(Object.keys(p).sort(), ['body', 'tag', 'title', 'url']);
  assert.equal(p.title, 'Readiness 72 · green');
  assert.equal(p.body, 'Push day · strain 14–18 · focus 09:00–11:00. Open FORGE for the brief.');
  assert.ok(!/peptide|dose|drink/i.test(p.body), 'drivers never reach the lock screen');
  assert.equal(p.url, '#/today');
  assert.equal(s.sent[0].opts.topic, 'brief');
  assert.ok(s.sent[0].opts.TTL > 0);
  const logRec = (await v.read('forge/server/pushLog/2026.enc')).r['brief:2026-09-26'];
  assert.deepEqual({ kind: logRec.kind, date: logRec.date, title: logRec.title, ok: logRec.ok }, { kind: 'brief', date: '2026-09-26', title: 'Readiness 72 · green', ok: true });

  const again = senderStub();
  await notify(v, edt('2026-09-26', '08:10'), { sender: again.sender, deps });
  assert.equal(again.sent.length, 0, 'each (kind, key) at most once');
});

test('push: evening check-in until quiet hours when today has no check-in', async () => {
  const v = await pushVault({ mutate: (app) => app.update('days', '2026-09-26', { checkinAt: null }) });
  const early = senderStub();
  await notify(v, edt('2026-09-26', '21:10'), { sender: early.sender });
  assert.equal(early.sent.length, 0, 'before eveningCheckinAt');
  const s = senderStub();
  await notify(v, edt('2026-09-26', '21:40'), { sender: s.sender });
  assert.deepEqual(s.sent.map((x) => x.payload.title), ['Evening check-in', 'Evening check-in']);
  assert.equal(s.sent[0].payload.body, "Log plan vs actual and tomorrow's blocks.");
  const late = senderStub();
  await notify(v, edt('2026-09-26', '23:05'), { sender: late.sender });
  assert.equal(late.sent.length, 0);

  // Already checked in → nothing.
  const v2 = await pushVault();
  const s2 = senderStub();
  await notify(v2, edt('2026-09-26', '21:40'), { sender: s2.sender });
  assert.equal(s2.sent.length, 0);
});

test('push: weekly review on Monday morning about the week that ended, keyed by its ISO week', async () => {
  const v = await pushVault();
  const sun = senderStub();
  await notify(v, edt('2026-09-27', '18:30'), { sender: sun.sender });
  assert.ok(!sun.sent.some((x) => x.payload.title === 'Weekly review'), 'not before the week is over');
  const early = senderStub();
  await notify(v, edt('2026-09-28', '06:30'), { sender: early.sender });
  assert.ok(!early.sent.some((x) => x.payload.title === 'Weekly review'), 'not before 07:00');
  const s = senderStub();
  await notify(v, edt('2026-09-28', '07:30'), { sender: s.sender });
  const msg = s.sent.find((x) => x.payload.title === 'Weekly review');
  assert.ok(msg); assert.equal(msg.payload.body, 'Last week is ready to review.');
  assert.equal((await v.read('forge/server/pushLog/2026.enc')).r['weekly:2026-W39'].ok, true);
});

test('push: neutral protocol reminder after 12:00 when no dose is logged; dead endpoints are reported', async () => {
  const v = await pushVault({ mutate: (app) => app.update('days', '2026-09-28', { date: '2026-09-28', checkinAt: '2026-09-28T21:00:00-04:00' }) });
  const morning = senderStub({ gone: [SUBS[1]] });
  await notify(v, edt('2026-09-28', '11:50'), { sender: morning.sender });
  assert.ok(!morning.sent.some((x) => x.payload.title === 'Protocol reminder'), 'not before 12:00');

  const s = senderStub({ gone: [SUBS[1]] });
  const r = await notify(v, edt('2026-09-28', '12:30'), { sender: s.sender });
  assert.equal(r.results.push, 'ok');
  const doses = s.sent.filter((x) => x.payload.title === 'Protocol reminder');
  assert.equal(doses.length, 1, 'peptide due Monday; supplements are not dose-reminded; dead endpoint skipped');
  assert.equal(doses[0].payload.body, 'Protocol', 'neutral label, never the substance');
  assert.ok(!JSON.stringify(s.sent).toLowerCase().includes('peptide'));
  assert.ok((await v.read('forge/server/pushLog/2026.enc')).r['dose:2026-09-28:p-pep'].ok);
  const st = (await v.read('forge/server/status.enc')).r.push;
  assert.deepEqual(st.detail.deadSubs, [hashId(SUBS[1])], 'dead endpoint hash for the app to clean up');
  assert.equal(st.lastError, null);

  // Logging the dose silences the reminder for that day (new vault: clean pushLog).
  const v2 = await pushVault({ mutate: (app) => app.create('doses', { itemId: 'p-pep', date: '2026-09-28', at: '2026-09-28T07:20:00-04:00', amount: 1, unit: 'mg' }) });
  const s2 = senderStub();
  await notify(v2, edt('2026-09-28', '12:30'), { sender: s2.sender });
  assert.ok(!s2.sent.some((x) => x.payload.title === 'Protocol reminder'));
});

test('push: not configured → quiet in auto, explicit error when subscriptions exist without a VAPID key', async () => {
  const v = await makeVault();
  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'auto' }), now: () => edt('2026-09-26', '07:10'), sleep: noSleep, deps: stubDeps().deps, git: false, log: log() });
  assert.equal(r.results.push, 'skipped');
  assert.equal((await v.read('forge/server/status.enc')).r.push, undefined, 'no status noise for an unused integration');

  const v2 = await pushVault();
  const r2 = await runAutomation({ root: v2.dir, env: v2.env({ FORGE_TASK: 'notify' }), now: () => edt('2026-09-26', '07:10'), sleep: noSleep, deps: stubDeps().deps, sender: senderStub().sender, git: false, log: log() });
  assert.equal(r2.results.push, 'error');
  assert.match((await v2.read('forge/server/status.enc')).r.push.lastError, /VAPID_PRIVATE_KEY/);
});

test('push: VAPID key formats are what web-push signs with (offline)', async () => {
  const { default: webpush } = await import('web-push');
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();   // what the setup UI generates
  assert.equal(Buffer.from(privateKey, 'base64url').length, 32, 'raw P-256 scalar d');
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65, 'uncompressed point');
  const asStdB64 = Buffer.from(privateKey, 'base64url').toString('base64');   // pasted as plain base64
  assert.equal(normalizeKey(asStdB64), privateKey);
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') } };
  const req = webpush.generateRequestDetails(sub, JSON.stringify({ title: 't', body: 'b', url: '#/today', tag: 'brief' }), {
    vapidDetails: { subject: DEFAULT_SUBJECT, publicKey: normalizeKey(publicKey), privateKey: normalizeKey(asStdB64) }, TTL: 60, urgency: 'normal', topic: 'brief',
  });
  assert.match(req.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(req.headers.Topic, 'brief');
});

test('push: missing readiness module still sends a brief built from WHOOP recovery', async () => {
  const v = await pushVault();
  const { deps } = stubDeps();
  const s = senderStub();
  await notify(v, edt('2026-09-26', '07:10'), { sender: s.sender, deps: { ...deps, readiness: { __error: new Error('missing') } } });
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[0].payload.title, /^Readiness \d+ · (green|yellow|red)$/);
  assert.ok((await v.read('forge/server/status.enc')).r.push.detail.notes.some((n) => /readiness unavailable/.test(n)));
});

test('push: push-test sends one neutral test notification now, even in quiet hours, without a pushLog entry', async () => {
  const v = await pushVault();
  const s = senderStub();
  await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'push-test', VAPID_PRIVATE_KEY: 'test-private-key-value-not-real' }), now: () => edt('2026-09-26', '23:30'), sleep: noSleep, deps: stubDeps().deps, sender: s.sender, git: false, log: log() });
  assert.equal(s.sent.length, SUBS.length);
  assert.ok(s.sent.every((x) => x.payload.title === 'FORGE test notification'));
  const status = (await v.read('forge/server/status.enc')).r.push;
  assert.equal(status.detail.lastTest.delivered, true);
  const pushLog = await v.read('forge/server/pushLog/2026.enc').catch(() => null);
  assert.ok(!pushLog || !Object.keys(pushLog.r).some((k) => k.startsWith('test:')));
});

test('push: only browser push services are ever contacted', async () => {
  const { isPushEndpoint } = await import('../../automation/push.mjs');
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
    assert.equal(isPushEndpoint(ok), true, ok);
  for (const bad of ['https://attacker.example/push', 'http://fcm.googleapis.com/x', 'https://push.apple.com.evil.example/x', 'javascript:alert(1)', '', null])
    assert.equal(isPushEndpoint(bad), false, String(bad));
});
