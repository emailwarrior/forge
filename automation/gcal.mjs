// Google Calendar sync through a service account (docs/ARCHITECTURE.md §5, §11).
//
// Read  : settings.integrations.gcal.readCalendars (+ the FORGE calendar) → calendarEvents
//         for today−35 … today+21 in the profile time zone. The server is authoritative:
//         events inside that window that no longer exist are removed; records outside the
//         window are left untouched.
// Write : the FORGE calendar ← plan blocks and short reminder events for today−1 … today+14,
//         diffed through calendarMap (forgeRef → { eventId, hash, pushedAt, date, calendarId }).
//         Event titles for sensitive items are neutral ("Protocol").
import { createHash } from 'node:crypto';
import { addDays, dateRange, hmToMin, minToHm, zonedToMs, isoWithOffset, localParts, stableStringify, isYmd } from '../js/core/util.js';
import { makeDataView } from '../js/analytics/dataview.js';
import { putRecord, removeRecord } from './vault-fs.mjs';
import { shortError, backoffMs, retryAfterMs, iso } from './log.mjs';
import { parseServiceAccount, getGoogleAccessToken } from './google-auth.mjs';

export const CAL_API = 'https://www.googleapis.com/calendar/v3';
export const READ_BACK_DAYS = 35;
export const READ_AHEAD_DAYS = 21;
export const BLOCK_ALERT_MIN = 10; // phone alert before plan blocks marked "reminder"
export const WRITE_BACK_DAYS = 1;
export const WRITE_AHEAD_DAYS = 14;
export const MANAGED_DESCRIPTION = 'Managed by FORGE — edit in the app';
export const CATEGORY_COLORS = { deep: '9', meeting: '8', admin: '5', training: '10', meal: '6', recovery: '2', learning: '7', personal: '3', commute: '8' };
export const REMINDER_MIN = 10;
const MAP_KEEP_DAYS = 30;   // calendarMap records older than the write window by this much are forgotten

/* ------------------------------------------------------------- client */
export class CalendarError extends Error {
  constructor(op, status, reason) {
    super(`Calendar ${op}: HTTP ${status}${reason ? ' ' + reason : ''}`);
    this.name = 'CalendarError'; this.status = status; this.reason = reason;
  }
}

function reasonOf(data) {
  const e = data && data.error;
  const r = (e && Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason) || (e && e.status) || '';
  return typeof r === 'string' && /^[A-Za-z_]{1,40}$/.test(r) ? r : '';
}

function createClient(ctx, token) {
  let calls = 0;
  async function call(op, method, path, { query, body, tolerate = [] } = {}) {
    const url = CAL_API + path + (query ? '?' + new URLSearchParams(query).toString() : '');
    for (let attempt = 1; ; attempt++) {
      calls++;
      let res;
      try {
        res = await ctx.fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        if (attempt <= 3) { await ctx.sleep(backoffMs(attempt)); continue; }
        throw new CalendarError(op, 0, 'network');
      }
      if (tolerate.includes(res.status)) return { status: res.status, data: null };
      let data = null;
      if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
      const reason = reasonOf(data);
      const limited = res.status === 429 || (res.status === 403 && /rate|quota/i.test(reason));
      if ((limited || res.status >= 500) && attempt <= 4) {
        await ctx.sleep(limited ? Math.min(retryAfterMs(res.headers.get('retry-after'), backoffMs(attempt + 1)), 30000) : backoffMs(attempt));
        continue;
      }
      if (!res.ok) throw new CalendarError(op, res.status, reason);
      return { status: res.status, data };
    }
  }
  return { call, get calls() { return calls; } };
}

const eventsPath = (calendarId, eventId) => `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? '/' + encodeURIComponent(eventId) : ''}`;

// Complete listing or an error — never a partial list: the read is authoritative (vanished
// events get removed) and the write phase trusts it to know what exists.
async function listEvents(client, calendarId, { timeMin, timeMax, tz }) {
  const items = []; const seen = new Set(); let pageToken = null;
  for (let page = 0; page < 100; page++) {
    const query = { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', timeZone: tz };
    if (pageToken) query.pageToken = pageToken;
    const { data } = await client.call('list', 'GET', eventsPath(calendarId), { query });
    if (data && Array.isArray(data.items)) items.push(...data.items);
    pageToken = (data && data.nextPageToken) || null;
    if (!pageToken) return items;
    if (seen.has(pageToken)) break;
    seen.add(pageToken);
  }
  throw new CalendarError('list', 0, 'incomplete listing');
}

/* ------------------------------------------------------------ mapping */
export function mapEvent(ev, calendarId, { tz, forgeCalendarId }) {
  const allDay = !!(ev.start && ev.start.date);
  const start = allDay ? ev.start.date : (ev.start && ev.start.dateTime) || null;
  if (!start) return null;
  const end = allDay ? (ev.end && ev.end.date) || null : (ev.end && ev.end.dateTime) || null;
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const self = attendees.find((a) => a && a.self);
  const response = (self && self.responseStatus) || null;
  const priv = ev.extendedProperties && ev.extendedProperties.private;
  return {
    date: allDay ? start : localParts(start, tz).ymd,
    start,
    end,
    allDay,
    title: ev.summary || '(busy)',
    calendarId,
    attendees: attendees.length,
    organizerSelf: !!(ev.organizer && ev.organizer.self),
    // Analytics count only accepted meetings: a declined invitation reads as 'declined'.
    status: response === 'declined' ? 'declined' : ev.status || 'confirmed',
    response,
    isForge: !!forgeCalendarId && calendarId === forgeCalendarId,
    forgeRef: priv && typeof priv.forgeRef === 'string' ? priv.forgeRef : null,
  };
}

const updatedAt = (ev) => { const t = Date.parse(ev && ev.updated); return Number.isFinite(t) ? t : null; };

/* --------------------------------------------------------------- read */
async function readCalendars(ctx, client, { tz, today, forgeCal, calendars }) {
  const from = addDays(today, -READ_BACK_DAYS);
  const to = addDays(today, READ_AHEAD_DAYS);
  const timeMin = iso(zonedToMs(from, '00:00', tz));
  const timeMax = iso(zonedToMs(addDays(to, 1), '00:00', tz));
  const out = { from, to, calendars: calendars.length, ok: 0, events: 0, upserted: 0, removed: 0, errors: {}, live: null };
  const okCals = new Set(); const seen = new Set();
  for (const [i, calId] of calendars.entries()) {
    if (Date.now() > ctx.deadline - 60000) { out.errors[calId] = 'skipped: time budget reached'; continue; }
    let items;
    try {
      items = await listEvents(client, calId, { timeMin, timeMax, tz });
    } catch (e) {
      out.errors[calId] = shortError(e);
      ctx.log.warn(`calendar: read of calendar #${i + 1} failed (${e.status || 'error'})`);
      continue;
    }
    okCals.add(calId); out.ok++;
    if (calId === forgeCal) out.live = items;
    for (const ev of items) {
      if (!ev || !ev.id || ev.status === 'cancelled') continue;
      const rec = mapEvent(ev, calId, { tz, forgeCalendarId: forgeCal });
      if (!rec || rec.date < from || rec.date > to) continue;
      const id = `${calId}:${ev.id}`;
      seen.add(id); out.events++;
      if (putRecord(ctx, 'calendarEvents', id, rec, updatedAt(ev))) out.upserted++;
    }
  }
  // Server-authoritative window: drop what vanished from calendars read successfully and
  // everything from calendars that are no longer configured.
  const configured = new Set(calendars);
  for (const rec of ctx.store.range('calendarEvents', from, to)) {
    if (seen.has(rec.id)) continue;
    const cal = rec.calendarId || rec.id.slice(0, rec.id.lastIndexOf(':'));
    if ((okCals.has(cal) || !configured.has(cal)) && removeRecord(ctx, 'calendarEvents', rec.id)) out.removed++;
  }
  return out;
}

/* ------------------------------------------------------ desired state */
const hashBody = (body) => createHash('sha256').update(stableStringify(body)).digest('hex').slice(0, 16);

// Instant for a local date + minutes after midnight (minutes may spill into adjacent days).
function zonedAt(date, min, tz) {
  const shift = Math.floor(min / 1440);
  return zonedToMs(addDays(date, shift), minToHm(min - shift * 1440), tz);
}

// alertMin: undefined → the calendar's default notifications; a number → one popup that many minutes
// before; null → no notification (plan blocks without a reminder stay silent on the phone).
export function eventBody({ title, date, startMin, endMin, tz, forgeRef, colorId, transparent, alertMin }) {
  const s = zonedAt(date, startMin, tz);
  const e = zonedAt(date, endMin, tz);
  if (!(e > s)) return null;
  const body = {
    summary: title,
    description: MANAGED_DESCRIPTION,
    start: { dateTime: isoWithOffset(s, tz), timeZone: tz },
    end: { dateTime: isoWithOffset(e, tz), timeZone: tz },
    extendedProperties: { private: { forgeRef } },
    reminders: alertMin === undefined ? { useDefault: true }
      : { useDefault: false, overrides: alertMin === null ? [] : [{ method: 'popup', minutes: alertMin }] },
  };
  if (colorId) body.colorId = colorId;
  if (transparent) body.transparency = 'transparent';
  return body;
}

function dueEntries(ctx, dv, date, notes) {
  let protocols;
  try { protocols = ctx.need('protocols'); } catch (e) { notes.add('protocol reminders skipped: ' + shortError(e)); return []; }
  try {
    const list = protocols.dueItems(dv, date) || [];
    return list.filter((x) => x && x.item && x.due !== false && x.item.active !== false);
  } catch (e) {
    notes.add('protocol reminders skipped: ' + shortError(e));
    return [];
  }
}

// Map forgeRef → { date, body, hash } for everything the FORGE calendar should show.
export function desiredEvents(ctx, dv, { tz, today, gcal }, notes = new Set()) {
  const from = addDays(today, -WRITE_BACK_DAYS);
  const to = addDays(today, WRITE_AHEAD_DAYS);
  const events = new Map();
  const add = (ref, date, spec) => {
    const body = eventBody({ ...spec, forgeRef: ref, tz });
    if (body) events.set(ref, { date, body, hash: hashBody(body) });
  };
  const reminder = (title, date, min) => ({ title, date, startMin: min, endMin: min + REMINDER_MIN, transparent: true, alertMin: 0 });

  if (gcal.pushPlan !== false) {
    for (const b of ctx.store.range('plan', from, to)) {
      if (b.calendar === false || b.status === 'skipped') continue;
      const s = hmToMin(b.start);
      if (s == null) continue;
      let e = hmToMin(b.end);
      if (e == null) e = s + 30;
      if (e <= s) e += 1440;   // block runs past midnight
      add('plan:' + b.id, b.date, { title: b.title || 'Plan block', date: b.date, startMin: s, endMin: e, colorId: CATEGORY_COLORS[b.category], alertMin: b.reminder ? BLOCK_ALERT_MIN : null });
    }
  }

  if (gcal.pushReminders) {
    const targets = ctx.store.setting('targets');
    const notif = ctx.store.setting('notifications');
    const wake = hmToMin(targets.wake);
    let bed = hmToMin(targets.bedtime);
    if (bed != null && wake != null && bed <= wake) bed += 1440;   // bedtime after midnight
    const caffeine = hmToMin(targets.caffeineCutoff);
    const checkin = hmToMin(notif.eveningCheckinAt);
    for (const date of dateRange(from, to)) {
      const stacks = new Set();
      for (const { item } of dueEntries(ctx, dv, date, notes)) {
        const kind = item.kind || 'supplement';
        if (kind === 'peptide' || kind === 'medication') {
          const t = hmToMin(item.schedule && Array.isArray(item.schedule.times) ? item.schedule.times[0] : null) ?? (wake != null ? wake + 45 : null);
          if (t != null) add(`rem:dose:${date}:${item.id}`, date, reminder(item.neutralLabel || 'Protocol', date, t));
        } else {
          const st = String((item.schedule && item.schedule.stack) || '').toUpperCase();
          if (st === 'AM' || st === 'PM') stacks.add(st);
        }
      }
      if (stacks.has('AM') && wake != null) add(`rem:stack:${date}:AM`, date, reminder('AM stack', date, wake + 30));
      if (stacks.has('PM') && bed != null) add(`rem:stack:${date}:PM`, date, reminder('PM stack', date, bed - 60));
      if (caffeine != null) add(`rem:caffeine:${date}`, date, reminder('Caffeine cutoff', date, caffeine));
      if (bed != null) add(`rem:winddown:${date}`, date, reminder('Wind down', date, bed - 45));
      if (checkin != null) add(`rem:checkin:${date}`, date, reminder('Evening check-in', date, checkin));
    }
  }
  return { from, to, events };
}

/* -------------------------------------------------------------- write */
const refOf = (ev) => {
  const p = ev && ev.extendedProperties && ev.extendedProperties.private;
  return p && typeof p.forgeRef === 'string' ? p.forgeRef : null;
};

async function writeForgeCalendar(ctx, client, { tz, forgeCal, readFrom, readTo }, desired, live) {
  const { from, to, events } = desired;
  const stats = { desired: events.size, inserted: 0, patched: 0, adopted: 0, deleted: 0, unchanged: 0, failed: 0, deferred: 0 };
  let error = null;
  const nowIso = iso(ctx.now());
  const inWindow = (d) => isYmd(d) && d >= from && d <= to;
  const pruneBefore = addDays(from, -MAP_KEEP_DAYS);
  const deleted = new Set();

  const liveByRef = new Map();
  for (const ev of live) {
    const ref = refOf(ev);
    if (!ref || !ev.id || ev.status === 'cancelled') continue;
    if (!liveByRef.has(ref)) liveByRef.set(ref, []);
    liveByRef.get(ref).push(ev);
  }
  const touch = (ev) => {
    const rec = mapEvent(ev, forgeCal, { tz, forgeCalendarId: forgeCal });
    if (rec && rec.date >= readFrom && rec.date <= readTo) putRecord(ctx, 'calendarEvents', `${forgeCal}:${ev.id}`, rec, updatedAt(ev));
  };
  const drop = async (calId, eventId) => {
    await client.call('delete', 'DELETE', eventsPath(calId, eventId), { tolerate: [404, 410] });
    deleted.add(eventId);
    if (calId === forgeCal) removeRecord(ctx, 'calendarEvents', `${forgeCal}:${eventId}`);
    stats.deleted++;
  };
  // Permission / missing-calendar errors will fail every call: stop early.
  const hopeless = (e) => e && (e.status === 401 || (e.status === 403 && !/rate|quota/i.test(e.reason || '')) || e.status === 404);

  const mapRecs = new Map(ctx.store.all('calendarMap').map((r) => [r.id, r]));
  let aborted = false;
  // Leave a minute for the other tasks and the commit; whatever is left happens next run.
  const timeUp = () => Date.now() > ctx.deadline - 60000;

  // 1. Insert / patch what should exist.
  let done = 0;
  for (const [ref, want] of events) {
    if (timeUp()) { stats.deferred = events.size - done; aborted = true; break; }
    done++;
    try {
      const m = mapRecs.get(ref);
      const sameCal = m && (!m.calendarId || m.calendarId === forgeCal);
      if (m && !sameCal) { try { await drop(m.calendarId, m.eventId); } catch { /* old calendar may be gone */ } }
      const liveList = liveByRef.get(ref) || [];
      let eventId = sameCal ? m.eventId : null;
      if (eventId && !liveList.some((ev) => ev.id === eventId)) eventId = null;   // deleted outside FORGE
      let adopted = false;
      if (!eventId && liveList.length) { eventId = liveList[0].id; adopted = true; }   // lost map record
      for (const ev of liveList) if (ev.id !== eventId) await drop(forgeCal, ev.id);   // duplicates
      if (eventId && !adopted && m.hash === want.hash) { stats.unchanged++; continue; }
      let res = null;
      if (eventId) {
        res = await client.call('patch', 'PATCH', eventsPath(forgeCal, eventId), { body: want.body, tolerate: [404, 410] });
        if (res.status === 404 || res.status === 410) res = null;
        else stats[adopted ? 'adopted' : 'patched']++;
      }
      if (!res) {
        res = await client.call('insert', 'POST', eventsPath(forgeCal), { body: want.body });
        stats.inserted++;
      }
      const ev = res.data || {};
      putRecord(ctx, 'calendarMap', ref, { eventId: ev.id || eventId, hash: want.hash, pushedAt: nowIso, date: want.date, calendarId: forgeCal });
      if (ev.id) touch(ev);
    } catch (e) {
      stats.failed++; error = shortError(e);
      if (hopeless(e)) { aborted = true; break; }
    }
  }

  // 2. Delete what should no longer exist inside the window; forget old map records.
  if (!aborted) {
    for (const [ref, m] of mapRecs) {
      if (events.has(ref)) continue;
      if (timeUp()) { aborted = true; break; }
      if (!inWindow(m.date)) {
        if (isYmd(m.date) && m.date < pruneBefore) removeRecord(ctx, 'calendarMap', ref);
        continue;
      }
      try {
        if (!deleted.has(m.eventId)) await drop(m.calendarId || forgeCal, m.eventId);
        removeRecord(ctx, 'calendarMap', ref);
      } catch (e) {
        stats.failed++; error = shortError(e);
        if (hopeless(e)) { aborted = true; break; }
      }
    }
  }
  if (!aborted) {
    // 3. FORGE-tagged events in the window that nothing maps to (e.g. an insert whose map
    //    record was never committed).
    const mapped = new Set(ctx.store.all('calendarMap').map((r) => r.eventId));
    for (const [ref, list] of liveByRef) {
      if (events.has(ref)) continue;
      for (const ev of list) {
        if (mapped.has(ev.id) || deleted.has(ev.id)) continue;
        const rec = mapEvent(ev, forgeCal, { tz, forgeCalendarId: forgeCal });
        if (!rec || !inWindow(rec.date)) continue;
        try { await drop(forgeCal, ev.id); } catch (e) { stats.failed++; error = shortError(e); }
      }
    }
  }
  return { ...stats, error };
}

/* ---------------------------------------------------------------- run */
export async function runCalendar(ctx, { explicit = false } = {}) {
  if (!String(ctx.env.GOOGLE_SA_KEY || '').trim()) {
    return explicit ? { ok: false, error: 'GOOGLE_SA_KEY secret is not set' } : { quiet: true, skipped: true };
  }
  const gcal = ctx.store.setting('integrations').gcal || {};
  const forgeCal = String(gcal.forgeCalendarId || '').trim();
  const readIds = [...new Set((Array.isArray(gcal.readCalendars) ? gcal.readCalendars : []).map((s) => String(s || '').trim()).filter(Boolean))];
  const notes = new Set();
  if (!readIds.length) notes.add('readCalendars is empty: add your calendar ID and share that calendar with the service account');
  if (!readIds.length && !forgeCal) {
    return { ok: true, skipped: true, detail: { notes: [...notes, 'no FORGE calendar set (integrations.gcal.forgeCalendarId)'] }, summary: 'no calendars configured' };
  }
  const sa = parseServiceAccount(ctx.env.GOOGLE_SA_KEY);
  const token = await getGoogleAccessToken(ctx, sa);
  const client = createClient(ctx, token);
  const tz = ctx.tz;
  const today = localParts(ctx.now(), tz).ymd;
  const calendars = forgeCal && !readIds.includes(forgeCal) ? [...readIds, forgeCal] : readIds;

  const read = await readCalendars(ctx, client, { tz, today, forgeCal, calendars });

  let write = null; let writeError = null;
  if (forgeCal) {
    if (read.errors[forgeCal]) {
      writeError = 'FORGE calendar is not accessible: share it with the service account ("Make changes to events")';
    } else {
      const dv = makeDataView(ctx.store, { tz, today });
      const desired = desiredEvents(ctx, dv, { tz, today, gcal }, notes);
      write = await writeForgeCalendar(ctx, client, { tz, forgeCal, readFrom: read.from, readTo: read.to }, desired, read.live || []);
      if (write.error) writeError = write.error;
      write.window = { from: desired.from, to: desired.to };
    }
  } else {
    notes.add('no FORGE calendar set: plan blocks and reminders are not pushed');
  }

  const readErrors = Object.keys(read.errors).length;
  const ok = !readErrors && !writeError;
  let writeStats = null;
  if (write) { const { error: _ignored, ...rest } = write; writeStats = rest; }
  const prevDetail = (ctx.store.get('status', 'calendar') || {}).detail || {};
  const prevFrom = ok || read.ok ? prevDetail.coverageFrom : null;
  const detail = {
    serviceAccount: sa.clientEmail,
    window: { from: read.from, to: read.to },
    // Earliest date any successful read covered (records outside the window are kept), so analytics
    // can tell "no meetings" from "not synced yet".
    coverageFrom: read.ok ? (prevFrom && prevFrom < read.from ? prevFrom : read.from) : (prevDetail.coverageFrom || null),
    read: { calendars: read.calendars, ok: read.ok, events: read.events, upserted: read.upserted, removed: read.removed },
    write: writeStats,
    errors: read.errors,
    writeError,
    notes: [...notes],
    apiCalls: client.calls,
  };
  const summary = `read ${read.ok}/${read.calendars} events=${read.events} removed=${read.removed}`
    + (write ? ` write +${write.inserted} ~${write.patched + write.adopted} -${write.deleted} =${write.unchanged}${write.failed ? ` failed=${write.failed}` : ''}${write.deferred ? ` deferred=${write.deferred}` : ''}` : '');
  const error = ok ? null : [readErrors ? `${readErrors} calendar(s) could not be read` : null, writeError].filter(Boolean).join('; ');
  return { ok, error, detail, summary };
}
