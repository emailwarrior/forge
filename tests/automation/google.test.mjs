import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { runAutomation } from '../../automation/run.mjs';
import { buildJwt, parseServiceAccount, getGoogleAccessToken, JWT_BEARER, GOOGLE_TOKEN_URL, CALENDAR_SCOPE } from '../../automation/google-auth.mjs';
import { MANAGED_DESCRIPTION } from '../../automation/gcal.mjs';
import { createLogger } from '../../automation/log.mjs';
import { makeVault, googleMock, googleEvent, stubDeps, noSleep, edt, TZ } from './fixtures/helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SA_JSON = JSON.stringify({ type: 'service_account', project_id: 'forge-test', private_key_id: 'kid-123', private_key: privateKey, client_email: 'forge-sync@forge-test.iam.gserviceaccount.com', token_uri: GOOGLE_TOKEN_URL });
const fromB64url = (s) => Buffer.from(s, 'base64url');

test('google auth: RS256 JWT has the service-account header/claims and a valid signature', async () => {
  const sa = parseServiceAccount(SA_JSON);
  assert.equal(sa.clientEmail, 'forge-sync@forge-test.iam.gserviceaccount.com');
  const nowMs = Date.UTC(2026, 8, 26, 16, 0, 0);
  const jwt = buildJwt(sa, { nowMs });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(fromB64url(h)), { alg: 'RS256', typ: 'JWT', kid: 'kid-123' });
  const iat = Math.floor(nowMs / 1000);
  assert.deepEqual(JSON.parse(fromB64url(c)), { iss: sa.clientEmail, scope: CALENDAR_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
  assert.equal(CALENDAR_SCOPE, 'https://www.googleapis.com/auth/calendar.events');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, fromB64url(s)), 'signature verifies with the public key');
  const forged = Buffer.from(JSON.stringify({ iss: 'attacker@example.com', scope: CALENDAR_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 })).toString('base64url');
  assert.ok(!verify('RSA-SHA256', Buffer.from(`${h}.${forged}`), publicKey, fromB64url(s)), 'tampered claims do not verify');
  assert.ok(!/[+/=]/.test(jwt), 'base64url without padding');

  // Accepted key formats: raw JSON or base64 of it; anything else is rejected clearly.
  assert.equal(parseServiceAccount(Buffer.from(SA_JSON).toString('base64')).clientEmail, sa.clientEmail);
  assert.throws(() => parseServiceAccount('{"client_email":"x"}'), /missing client_email or private_key/);
  assert.throws(() => parseServiceAccount(''), /not set/);

  // Token exchange: form-encoded jwt-bearer grant.
  let seen = null;
  const ctx = { sleep: noSleep, fetch: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ access_token: 'ya29.abc', expires_in: 3599, token_type: 'Bearer' }), { status: 200 }); } };
  assert.equal(await getGoogleAccessToken(ctx, sa), 'ya29.abc');
  assert.equal(seen.url, GOOGLE_TOKEN_URL);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(seen.init.body);
  assert.equal(form.get('grant_type'), JWT_BEARER);
  const [ah, ac, as] = form.get('assertion').split('.');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${ah}.${ac}`), publicKey, fromB64url(as)));

  const bad = { sleep: noSleep, fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 }) };
  await assert.rejects(getGoogleAccessToken(bad, sa), /Google auth failed \(HTTP 400 invalid_grant\)/);
});

/* ------------------------------------------------------------ calendar */
const NOW = edt('2026-09-26', '12:00');   // Saturday
const ME = 'me@example.com';
const FORGE = 'forge-cal@group.calendar.google.com';
const log = () => createLogger({ quiet: true });

function calendarVault() {
  return makeVault({
    mutate: (app) => {
      app.updateSetting('integrations', { gcal: { saEmail: 'forge-sync@forge-test.iam.gserviceaccount.com', readCalendars: [ME], forgeCalendarId: FORGE, pushPlan: true, pushReminders: true } });
      const block = (id, date, start, end, title, category, extra = {}) => app.create('plan', { id, date, start, end, title, category, status: 'planned', calendar: true, ...extra });
      block('t-deep', '2026-09-28', '07:30', '09:30', 'Deep work: launch', 'deep');
      block('t-sync', '2026-09-28', '10:00', '10:30', 'Team sync', 'meeting');
      block('t-late', '2026-09-28', '23:00', '00:30', 'Late block', 'personal');
      block('t-nocal', '2026-09-29', '08:00', '09:00', 'Private block', 'personal', { calendar: false });
      block('t-skip', '2026-09-29', '09:00', '10:00', 'Skipped block', 'admin', { status: 'skipped' });
      block('t-far', '2026-10-30', '09:00', '10:00', 'Outside the write window', 'deep');
    },
    serverRecords: {
      calendarEvents: [
        { id: `${ME}:gone1`, date: '2026-09-24', start: '2026-09-24T10:00:00-04:00', end: '2026-09-24T11:00:00-04:00', allDay: false, title: 'Deleted meeting', calendarId: ME, attendees: 2, organizerSelf: false, status: 'confirmed', isForge: false, forgeRef: null },
        { id: `${ME}:old1`, date: '2026-07-01', start: '2026-07-01T10:00:00-04:00', end: '2026-07-01T11:00:00-04:00', allDay: false, title: 'Old meeting', calendarId: ME, attendees: 2, organizerSelf: false, status: 'confirmed', isForge: false, forgeRef: null },
        { id: 'old@example.com:x1', date: '2026-09-25', start: '2026-09-25T10:00:00-04:00', end: '2026-09-25T11:00:00-04:00', allDay: false, title: 'Unconfigured', calendarId: 'old@example.com', attendees: 0, organizerSelf: true, status: 'confirmed', isForge: false, forgeRef: null },
      ],
    },
  });
}

function calendarsFixture() {
  return {
    [ME]: [
      googleEvent('e1', { date: '2026-09-26', start: '10:00', end: '10:30', summary: 'Ops sync', attendees: [{ email: ME, self: true, responseStatus: 'accepted' }, { email: 'a@x.com' }, { email: 'b@x.com' }] }),
      googleEvent('e2', { date: '2026-09-28', start: '14:00', end: '15:00', summary: 'Client call', attendees: [{ email: ME, self: true, responseStatus: 'declined' }, { email: 'c@x.com' }] }),
      googleEvent('e3', { date: '2026-09-30', allDay: true, summary: 'Offsite' }),
      googleEvent('e4', { date: '2026-09-29', start: '09:00', end: '09:30', summary: 'Cancelled', status: 'cancelled' }),
      googleEvent('e5', { date: '2026-10-10', start: '11:00', end: '12:00', summary: '1:1', organizerSelf: true }),
      googleEvent('e6', { date: '2026-08-01', start: '11:00', end: '12:00', summary: 'Before the window' }),
      (() => { const e = googleEvent('e7', { date: '2026-09-27', start: '09:00', end: '10:00' }); delete e.summary; return e; })(),
    ],
    [FORGE]: [],
  };
}

const bodyByRef = (calls, method) => new Map(calls.filter((c) => c.method === method).map((c) => [c.body.extendedProperties.private.forgeRef, c]));

test('calendar: reads events into calendarEvents (authoritative window) and pushes plan + reminders, then diffs', async () => {
  const v = await calendarVault();
  const cals = calendarsFixture();
  const g = googleMock({ calendars: cals, pageSize: 2, now: () => NOW });
  const { deps } = stubDeps();
  const env = v.env({ FORGE_TASK: 'calendar', GOOGLE_SA_KEY: SA_JSON });
  const appBefore = await v.files('forge/app');

  /* ---- run 1: read + initial push */
  const r1 = await runAutomation({ root: v.dir, env, fetch: g.fetch, now: () => NOW, sleep: noSleep, deps, git: false, log: log() });
  assert.equal(r1.results.calendar, 'ok');
  const status1 = (await v.read('forge/server/status.enc')).r.calendar;
  assert.equal(status1.lastError, null);
  assert.equal(status1.detail.serviceAccount, 'forge-sync@forge-test.iam.gserviceaccount.com');

  // Reads: paginated, expanded single events, profile time zone window today−35 … today+21.
  const lists = g.calls.filter((c) => c.method === 'GET' && c.calendarId === ME);
  assert.ok(lists.length >= 3, 'paginated');
  assert.ok(lists.slice(1).every((c) => c.query.pageToken));
  assert.deepEqual(
    { singleEvents: lists[0].query.singleEvents, orderBy: lists[0].query.orderBy, maxResults: lists[0].query.maxResults, timeZone: lists[0].query.timeZone, timeMin: lists[0].query.timeMin, timeMax: lists[0].query.timeMax },
    { singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', timeZone: TZ, timeMin: '2026-08-22T04:00:00.000Z', timeMax: '2026-10-18T04:00:00.000Z' },
  );

  const sep = (await v.read('forge/server/calendarEvents/2026-09.enc')).r;
  const oct = (await v.read('forge/server/calendarEvents/2026-10.enc')).r;
  const jul = (await v.read('forge/server/calendarEvents/2026-07.enc')).r;
  assert.deepEqual(
    (({ date, start, end, allDay, title, calendarId, attendees, organizerSelf, status, response, isForge, forgeRef }) => ({ date, start, end, allDay, title, calendarId, attendees, organizerSelf, status, response, isForge, forgeRef }))(sep[`${ME}:e1`]),
    { date: '2026-09-26', start: '2026-09-26T10:00:00-04:00', end: '2026-09-26T10:30:00-04:00', allDay: false, title: 'Ops sync', calendarId: ME, attendees: 3, organizerSelf: false, status: 'confirmed', response: 'accepted', isForge: false, forgeRef: null },
  );
  assert.equal(sep[`${ME}:e2`].status, 'declined', 'declined invitations are marked so analytics skip them');
  assert.equal(sep[`${ME}:e3`].allDay, true); assert.equal(sep[`${ME}:e3`].start, '2026-09-30'); assert.equal(sep[`${ME}:e3`].end, '2026-10-01');
  assert.equal(sep[`${ME}:e7`].title, '(busy)');
  assert.equal(oct[`${ME}:e5`].organizerSelf, true);
  assert.equal(sep[`${ME}:e4`], undefined, 'cancelled events are not stored');
  assert.equal(sep[`${ME}:gone1`], undefined, 'vanished event inside the window is removed from the shard');
  assert.equal(sep['old@example.com:x1'], undefined, 'events of calendars no longer configured are removed');
  assert.ok(jul[`${ME}:old1`], 'records outside the window are untouched');

  // Writes: every desired event inserted once, neutral titles, managed description.
  const posts = g.calls.filter((c) => c.method === 'POST' && c.calendarId === FORGE);
  assert.equal(posts.length, status1.detail.write.desired);
  assert.equal(status1.detail.write.inserted, posts.length);
  const byRef = bodyByRef(posts, 'POST');
  for (const c of posts) {
    assert.equal(c.body.description, MANAGED_DESCRIPTION);
    const ref = c.body.extendedProperties.private.forgeRef;
    if (ref.startsWith('rem:')) assert.deepEqual(c.body.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }, 'reminder events alert at their time');
    else assert.equal(c.body.reminders.useDefault, false, 'plan blocks control their own alerts');
    assert.equal(c.body.start.timeZone, TZ);
    assert.ok(!/peptide/i.test(JSON.stringify(c.body)), 'no substance names leave the vault');
  }
  const deep = byRef.get('plan:t-deep').body;
  assert.deepEqual({ summary: deep.summary, colorId: deep.colorId, start: deep.start, end: deep.end }, {
    summary: 'Deep work: launch', colorId: '9',
    start: { dateTime: '2026-09-28T07:30:00-04:00', timeZone: TZ }, end: { dateTime: '2026-09-28T09:30:00-04:00', timeZone: TZ },
  });
  assert.equal(byRef.get('plan:t-sync').body.colorId, '8');
  assert.equal(byRef.get('plan:t-late').body.end.dateTime, '2026-09-29T00:30:00-04:00', 'block past midnight ends the next day');
  assert.ok(!byRef.has('plan:t-nocal'), 'calendar: false stays private');
  assert.ok(!byRef.has('plan:t-skip'), 'skipped blocks are not pushed');
  assert.ok(!byRef.has('plan:t-far'), 'outside today−1 … today+14');
  const rem = (ref) => { const b = byRef.get(ref); assert.ok(b, ref); return [b.body.summary, b.body.start.dateTime, b.body.end.dateTime, b.body.transparency]; };
  assert.deepEqual(rem('rem:stack:2026-09-28:AM'), ['AM stack', '2026-09-28T07:00:00-04:00', '2026-09-28T07:10:00-04:00', 'transparent']);
  assert.deepEqual(rem('rem:stack:2026-09-28:PM'), ['PM stack', '2026-09-28T21:30:00-04:00', '2026-09-28T21:40:00-04:00', 'transparent']);
  assert.deepEqual(rem('rem:dose:2026-09-28:p-pep'), ['Protocol', '2026-09-28T07:15:00-04:00', '2026-09-28T07:25:00-04:00', 'transparent']);
  assert.deepEqual(rem('rem:caffeine:2026-09-28'), ['Caffeine cutoff', '2026-09-28T12:00:00-04:00', '2026-09-28T12:10:00-04:00', 'transparent']);
  assert.deepEqual(rem('rem:winddown:2026-09-28'), ['Wind down', '2026-09-28T21:45:00-04:00', '2026-09-28T21:55:00-04:00', 'transparent']);
  assert.deepEqual(rem('rem:checkin:2026-09-28'), ['Evening check-in', '2026-09-28T21:30:00-04:00', '2026-09-28T21:40:00-04:00', 'transparent']);
  assert.ok(!byRef.has('rem:dose:2026-09-29:p-pep'), 'the peptide is due Mon/Thu only');
  assert.ok(byRef.has('rem:caffeine:2026-09-25') && byRef.has('rem:caffeine:2026-10-10') && !byRef.has('rem:caffeine:2026-10-11'), 'window today−1 … today+14');

  const map = (await v.read('forge/server/calendarMap.enc')).r;
  assert.equal(Object.keys(map).length, posts.length);
  assert.deepEqual(Object.keys(map['plan:t-deep']).filter((k) => !k.startsWith('_') && k !== 'id').sort(), ['calendarId', 'date', 'eventId', 'hash', 'pushedAt']);
  assert.equal(map['plan:t-deep'].date, '2026-09-28');
  // FORGE events are reflected in calendarEvents straight from the insert responses.
  const forgeRec = Object.values(sep).find((e) => e.forgeRef === 'plan:t-deep');
  assert.ok(forgeRec && forgeRec.isForge && forgeRec.calendarId === FORGE);

  /* ---- run 2: nothing changed → no writes */
  const before2 = g.writes().length;
  const r2 = await runAutomation({ root: v.dir, env, fetch: g.fetch, now: () => NOW, sleep: noSleep, deps, git: false, log: log() });
  assert.equal(r2.results.calendar, 'ok');
  assert.equal(g.writes().length, before2, 'identical desired state: no insert/patch/delete');
  assert.equal((await v.read('forge/server/status.enc')).r.calendar.detail.write.unchanged, posts.length);

  assert.deepEqual(await v.files('forge/app'), appBefore, 'automation never writes forge/app/**');

  /* ---- run 3: app edits → patch / delete (a 410 on delete is fine) */
  v.app.update('plan', 't-deep', { title: 'Deep work: roadmap' });
  v.app.remove('plan', 't-sync');
  v.app.update('plan', 't-late', { status: 'skipped' });
  await v.writeApp('forge/app/plan/2026-09.enc');
  const appEdited = await v.files('forge/app');
  const syncEventId = map['plan:t-sync'].eventId;
  cals[FORGE].splice(cals[FORGE].findIndex((e) => e.id === syncEventId), 1);   // already gone at Google → 410
  const mark = g.calls.length;
  const r3 = await runAutomation({ root: v.dir, env, fetch: g.fetch, now: () => NOW, sleep: noSleep, deps, git: false, log: log() });
  assert.equal(r3.results.calendar, 'ok');
  const w3 = g.calls.slice(mark).filter((c) => c.calendarId === FORGE && c.method !== 'GET');
  assert.deepEqual(w3.filter((c) => c.method === 'PATCH').map((c) => c.eventId), [map['plan:t-deep'].eventId]);
  assert.equal(w3.find((c) => c.method === 'PATCH').body.summary, 'Deep work: roadmap');
  assert.deepEqual(w3.filter((c) => c.method === 'DELETE').map((c) => c.eventId).sort(), [map['plan:t-late'].eventId, syncEventId].sort());
  assert.equal(w3.filter((c) => c.method === 'POST').length, 0);
  const map3 = (await v.read('forge/server/calendarMap.enc')).r;
  assert.equal(map3['plan:t-sync'], undefined); assert.equal(map3['plan:t-late'], undefined);
  assert.equal(map3['plan:t-deep'].eventId, map['plan:t-deep'].eventId);
  const sep3 = (await v.read('forge/server/calendarEvents/2026-09.enc')).r;
  assert.ok(!Object.values(sep3).some((e) => e.forgeRef === 'plan:t-sync' || e.forgeRef === 'plan:t-late'));
  assert.equal(Object.values(sep3).find((e) => e.forgeRef === 'plan:t-deep').title, 'Deep work: roadmap');

  /* ---- run 4: self-healing — lost map record is adopted, duplicates and orphans removed */
  const lostRef = 'rem:caffeine:2026-09-30';
  const lostId = map3[lostRef].eventId;
  const mapShard = await v.read('forge/server/calendarMap.enc');
  delete mapShard.r[lostRef];
  await v.writeRaw('forge/server/calendarMap.enc', mapShard);
  const dupBody = cals[FORGE].find((e) => e.id === map3['rem:caffeine:2026-10-01'].eventId);
  cals[FORGE].push({ ...structuredClone(dupBody), id: 'dup1' });
  cals[FORGE].push(googleEvent('ghost1', { date: '2026-09-29', start: '13:00', end: '13:10', summary: 'Stale', forgeRef: 'plan:ghost' }));
  cals[FORGE].push(googleEvent('mine1', { date: '2026-09-29', start: '15:00', end: '16:00', summary: 'Added by hand' }));
  const mark4 = g.calls.length;
  const r4 = await runAutomation({ root: v.dir, env, fetch: g.fetch, now: () => NOW, sleep: noSleep, deps, git: false, log: log() });
  assert.equal(r4.results.calendar, 'ok');
  const w4 = g.calls.slice(mark4).filter((c) => c.calendarId === FORGE && c.method !== 'GET');
  assert.deepEqual(w4.filter((c) => c.method === 'PATCH').map((c) => c.eventId), [lostId], 'adopted instead of inserting a duplicate');
  assert.equal(w4.filter((c) => c.method === 'POST').length, 0);
  assert.deepEqual(w4.filter((c) => c.method === 'DELETE').map((c) => c.eventId).sort(), ['dup1', 'ghost1']);
  assert.ok(cals[FORGE].some((e) => e.id === 'mine1'), 'events without a forgeRef are never touched');
  assert.equal((await v.read('forge/server/calendarMap.enc')).r[lostRef].eventId, lostId);

  /* ---- run 5: a calendar that cannot be read keeps its records and reports an error */
  delete cals[ME];
  const r5 = await runAutomation({ root: v.dir, env, fetch: g.fetch, now: () => NOW, sleep: noSleep, deps, git: false, log: log() });
  assert.equal(r5.exitCode, 0);
  assert.equal(r5.results.calendar, 'error');
  const st5 = (await v.read('forge/server/status.enc')).r.calendar;
  assert.match(st5.lastError, /1 calendar\(s\) could not be read/);
  assert.match(st5.detail.errors[ME], /HTTP 404/);
  assert.ok((await v.read('forge/server/calendarEvents/2026-09.enc')).r[`${ME}:e1`], 'unreadable calendar: records kept');

  // The only app-shard change is the one the test made as "the app".
  assert.deepEqual(await v.files('forge/app'), appEdited);
});

test('calendar: nothing configured is a quiet no-op; missing service account is an explicit error', async () => {
  const v = await makeVault({ mutate: (app) => app.updateSetting('integrations', { gcal: { readCalendars: [], forgeCalendarId: '' } }) });
  const g = googleMock();
  const r = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'calendar', GOOGLE_SA_KEY: SA_JSON }), fetch: g.fetch, now: () => NOW, sleep: noSleep, deps: stubDeps().deps, git: false, log: log() });
  assert.equal(r.results.calendar, 'skipped');
  assert.equal(g.calls.length, 0);
  const st = (await v.read('forge/server/status.enc')).r.calendar;
  assert.equal(st.lastError, null);
  assert.ok(st.detail.notes.some((n) => /readCalendars is empty/.test(n)));

  const r2 = await runAutomation({ root: v.dir, env: v.env({ FORGE_TASK: 'calendar' }), fetch: g.fetch, now: () => NOW, sleep: noSleep, deps: stubDeps().deps, git: false, log: log() });
  assert.equal(r2.results.calendar, 'error');
  assert.match((await v.read('forge/server/status.enc')).r.calendar.lastError, /GOOGLE_SA_KEY/);
});

test('calendar: plan block alerts follow the block reminder flag', async () => {
  const { eventBody, BLOCK_ALERT_MIN } = await import('../../automation/gcal.mjs');
  const base = { title: 'Lift', date: '2026-09-28', startMin: 17 * 60, endMin: 18 * 60, tz: 'America/New_York', forgeRef: 'plan:x' };
  assert.deepEqual(eventBody({ ...base, alertMin: BLOCK_ALERT_MIN }).reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
  assert.deepEqual(eventBody({ ...base, alertMin: null }).reminders, { useDefault: false, overrides: [] });
  assert.deepEqual(eventBody(base).reminders, { useDefault: true });
});
