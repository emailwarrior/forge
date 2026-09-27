// Web Push notifications (VAPID, via the bundled `web-push` package).
// Decisions happen in the profile time zone and respect quiet hours; every (kind, key)
// is delivered at most once (pushLog). Payloads stay neutral: protocol reminders never
// name the substance.
import { localParts, hmToMin, isoWeek, hashId, isNum, addDays } from '../js/core/util.js';
import { makeDataView } from '../js/analytics/dataview.js';
import { putRecord } from './vault-fs.mjs';
import { shortError, iso } from './log.mjs';

export const DEFAULT_SUBJECT = 'mailto:noreply@forge.invalid';
const TTL = { brief: 6 * 3600, checkin: 3 * 3600, weekly: 24 * 3600, dose: 4 * 3600 };
const BRIEF_FROM = 5 * 60;
const BRIEF_UNTIL = 11 * 60;
const DOSE_NOT_BEFORE = 12 * 60;
const WEEKLY_FROM = 7 * 60; // Monday; the server writes last week's review after 03:00

export function isQuiet(min, quietStart, quietEnd) {
  const s = hmToMin(quietStart); const e = hmToMin(quietEnd);
  if (s == null || e == null || s === e) return false;
  return s < e ? min >= s && min < e : min >= s || min < e;
}

const bandOf = (score) => (!isNum(score) ? null : score >= 67 ? 'green' : score >= 34 ? 'yellow' : 'red');
const clip = (text, n) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
// VAPID keys as web-push wants them: base64url without padding (standard base64 is accepted).
export const normalizeKey = (v) => String(v || '').trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const normKey = normalizeKey;
const validSubject = (s) => (typeof s === 'string' && /^(https:\/\/|mailto:)\S+$/.test(s.trim()) ? s.trim() : null);
const DOSE_KINDS = new Set(['peptide', 'medication']);
// Browser push services only: a subscription record can never make the runner POST to an arbitrary host.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function isPushEndpoint(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname)); } catch { return false; }
}

// When a protocol item is expected (minutes after local midnight).
function dueAtMin(item, wake, bed) {
  const sched = item.schedule || {};
  const t = hmToMin(Array.isArray(sched.times) ? sched.times[0] : null);
  if (t != null) return t;
  const stack = String(sched.stack || '').toUpperCase();
  if (stack === 'AM' && wake != null) return wake + 30;
  if (stack === 'PM' && bed != null) return bed - 60;
  return wake != null ? wake + 45 : null;
}

// Candidate notifications for this run: [{ kind, key, title, body, url, tag, ttl, topic }].
export function decideNotifications(ctx, dv, { nowMs, tz }, notes = new Set()) {
  const notif = ctx.store.setting('notifications');
  const targets = ctx.store.setting('targets');
  const lp = localParts(nowMs, tz);
  const today = lp.ymd; const min = lp.min;
  const list = [];
  if (isQuiet(min, notif.quietStart, notif.quietEnd)) return { today, quiet: true, list };

  // Morning brief: once today's WHOOP recovery is scored.
  if (notif.morningBrief && min >= BRIEF_FROM && min < BRIEF_UNTIL) {
    const rec = dv.recovery(today);
    if (rec && rec.scoreState === 'SCORED') {
      let score = isNum(rec.recovery) ? Math.round(rec.recovery) : null;
      let band = bandOf(score); let summary = '';
      try {
        const r = ctx.need('readiness').readiness(dv, today);
        if (r) {
          if (isNum(r.score)) score = Math.round(r.score);
          if (r.band) band = r.band;
          // Lock screens are visible to anyone nearby: only the plan for the day, never the drivers
          // (they can mention doses, alcohol or illness signs).
          const t = r.training || {};
          if (t.label || t.mode) summary = `${t.label || (t.mode[0].toUpperCase() + t.mode.slice(1))} day`
            + (Array.isArray(t.strainTarget) && t.strainTarget.length === 2 ? ` · strain ${t.strainTarget[0]}–${t.strainTarget[1]}` : '')
            + (r.focus && r.focus.start ? ` · focus ${r.focus.start}–${r.focus.end}` : '') + '. Open FORGE for the brief.';
        }
      } catch (e) { notes.add('brief: readiness unavailable (' + shortError(e, 80) + ')'); }
      list.push({
        kind: 'brief', key: today,
        title: score != null ? `Readiness ${score}${band ? ' · ' + band : ''}` : 'Morning brief',
        body: clip(summary || 'Your readiness and plan for today are ready.', 140),
        url: '#/today', tag: 'brief', ttl: TTL.brief, topic: 'brief',
      });
    }
  }

  // Evening check-in: from eveningCheckinAt until quiet hours, if today has no check-in.
  const checkinAt = hmToMin(notif.eveningCheckinAt);
  if (checkinAt != null && min >= checkinAt) {
    const day = dv.day(today);
    if (!day || !day.checkinAt) {
      list.push({ kind: 'checkin', key: today, title: 'Evening check-in', body: "Log plan vs actual and tomorrow's blocks.", url: '#/today', tag: 'checkin', ttl: TTL.checkin, topic: 'checkin' });
    }
  }

  // Weekly review: Monday from 07:00, about the week that just ended (keyed by that ISO week).
  if (notif.weeklyReview && lp.dow === 0 && min >= WEEKLY_FROM) {
    const week = isoWeek(addDays(today, -7));
    const written = !!ctx.store.get('reviews', `weekly:${week}`);
    list.push({ kind: 'weekly', key: week, title: 'Weekly review', body: written ? "Last week's review is ready." : 'Last week is ready to review.', url: '#/insights/weekly', tag: 'weekly', ttl: TTL.weekly, topic: 'weekly' });
  }

  // Protocol reminders: peptide/medication items due today with no dose logged by 12:00
  // (or an hour after their own scheduled time, when that is later).
  if (notif.doseReminders) {
    let due = [];
    try {
      due = (ctx.need('protocols').dueItems(dv, today) || []).filter((x) => x && x.item && x.due !== false);
    } catch (e) { notes.add('dose: protocols unavailable (' + shortError(e, 80) + ')'); }
    const wake = hmToMin(targets.wake);
    let bed = hmToMin(targets.bedtime);
    if (bed != null && wake != null && bed <= wake) bed += 1440;
    const doses = dv.doses(today);
    for (const { item } of due) {
      if (item.active === false || !DOSE_KINDS.has(item.kind)) continue;
      const at = dueAtMin(item, wake, bed);
      if (min < Math.max(DOSE_NOT_BEFORE, at != null ? at + 60 : 0)) continue;
      if (doses.some((d) => d.itemId === item.id)) continue;
      list.push({
        kind: 'dose', key: `${today}:${item.id}`, title: 'Protocol reminder', body: item.neutralLabel || 'Scheduled item',
        url: '#/protocols', tag: `dose:${item.id}`, ttl: TTL.dose,
      });
    }
  }
  return { today, quiet: false, list };
}

async function webPushSender({ subject, publicKey, privateKey }) {
  const mod = await import('web-push');
  const webpush = mod.default || mod;
  const vapidDetails = { subject, publicKey, privateKey };
  return (sub, payload, opts) => webpush.sendNotification(sub, payload, { ...opts, vapidDetails, timeout: 15000 });
}

// test: send one neutral test notification to every active subscription now (ignores quiet hours, no pushLog).
export async function runNotify(ctx, { explicit = false, test = false } = {}) {
  const push = ctx.store.setting('integrations').push || {};
  const prev = (ctx.store.get('status', 'push') || {}).detail || {};
  const all = ctx.store.all('pushSubs').filter((s) => s && s.active !== false && typeof s.endpoint === 'string'
    && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string');
  const subs = all.filter((s) => isPushEndpoint(s.endpoint));
  const foreign = all.length - subs.length;
  const hashes = new Map(subs.map((s) => [s, hashId(s.endpoint)]));
  const live = new Set(hashes.values());
  // Keep reporting dead endpoints until the app deactivates them.
  const dead = new Set((Array.isArray(prev.deadSubs) ? prev.deadSubs : []).filter((h) => live.has(h)));

  if (!subs.length) {
    if (!explicit && !push.vapidPublicKey) return { quiet: true, skipped: true };
    return { ok: true, skipped: true, detail: { subs: 0, deadSubs: [], notes: ['no active push subscriptions'] }, summary: 'no subscriptions' };
  }
  const publicKey = normKey(push.vapidPublicKey);
  const privateKey = normKey(ctx.env.VAPID_PRIVATE_KEY);
  if (!publicKey || !privateKey) {
    return {
      ok: false,
      error: !privateKey ? 'VAPID_PRIVATE_KEY secret is not set' : 'integrations.push.vapidPublicKey is not set',
      detail: { subs: subs.length, deadSubs: [...dead] },
    };
  }
  const sender = ctx.sender || await webPushSender({ subject: validSubject(push.subject) || DEFAULT_SUBJECT, publicKey, privateKey });

  const nowMs = ctx.now();
  const today = localParts(nowMs, ctx.tz).ymd;
  const dv = makeDataView(ctx.store, { tz: ctx.tz, today });
  const notes = new Set();
  if (foreign) notes.add(`${foreign} subscription(s) ignored: not a known browser push service`);
  const { quiet, list } = test
    ? { quiet: false, list: [{ kind: 'test', key: iso(nowMs), title: 'FORGE test notification', body: 'Push notifications reach this device.', url: '#/settings/integrations', tag: 'test', ttl: 600 }] }
    : decideNotifications(ctx, dv, { nowMs, tz: ctx.tz }, notes);

  const sent = []; let failures = 0;
  for (const n of list) {
    const id = `${n.kind}:${n.key}`;
    const logged = test ? null : ctx.store.get('pushLog', id);
    if (logged && logged.ok) continue;
    const targets = subs.filter((s) => !dead.has(hashes.get(s)));
    if (!targets.length) { notes.add('every subscription is dead'); break; }
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag });
    const opts = { TTL: n.ttl, urgency: 'normal' };
    if (n.topic) opts.topic = n.topic;
    let delivered = 0;
    for (const sub of targets) {
      try {
        await sender({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, payload, opts);
        delivered++;
      } catch (e) {
        const code = e && (e.statusCode ?? e.status);
        if (code === 404 || code === 410) dead.add(hashes.get(sub));
        else { failures++; notes.add(`send failed (${code || shortError(e, 60)})`); }
      }
    }
    if (!test) putRecord(ctx, 'pushLog', id, { kind: n.kind, date: today, sentAt: iso(nowMs), title: n.title, ok: delivered > 0 });
    if (delivered) sent.push(n.kind);
    if (test) notes.add(`test delivered to ${delivered} of ${targets.length} device(s)`);
  }

  const detail = {
    subs: subs.length,
    deadSubs: [...dead],
    quiet,
    lastSent: sent.length && !test ? { at: iso(nowMs), kinds: sent } : (prev.lastSent || null),
    lastTest: test ? { at: iso(nowMs), delivered: sent.length > 0 } : (prev.lastTest || null),
    notes: [...notes],
  };
  const ok = failures === 0 || sent.length > 0;
  return {
    ok,
    error: ok ? null : 'push delivery failed',
    detail,
    summary: `subs=${subs.length} sent=${sent.length}${sent.length ? ` (${sent.join(',')})` : ''} dead=${dead.size}${quiet ? ' quiet-hours' : ''}`,
  };
}
