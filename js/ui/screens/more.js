// More (#/more): the mobile hub for everything outside the five tabs — Protocols, Labs, Finance, Journal,
// Import, Settings — plus status (vault sync, WHOOP, Google Calendar), Lock now and the app version.
import { html, useState } from '../../vendor/preact-htm.js';
import { useApp, useVersion, useAnalytics, useSyncStatus, useNow, useWide } from '../ctx.js';
import { Page, Section, Card, Button, List, ListRow, Pill } from '../kit.js';
import { dueItems, labSummary, financeSummary } from '../../analytics/index.js';
import { fmtDate, fmtMoney } from '../../core/util.js';
import { todayGroups, stackTitle } from '../parts/records-protocols.js';
import { flaggedMarkers } from '../parts/records-labs.js';
import { monthLabel } from '../parts/records-finance.js';
import { plural, syncLine, integrationLine } from '../parts/records-util.js';

export const APP_VERSION = '3.0.0';

export default function Screen() {
  const app = useApp(); useVersion(['protocolItems', 'doses', 'labs', 'snapshots', 'journal', 'savedQuotes', 'status', 'settings']);
  const wide = useWide();
  const now = useNow();
  const sync = useSyncStatus();
  const today = app.today(); const tz = app.dv.tz;
  const [locking, setLocking] = useState(false);

  const groups = useAnalytics(() => todayGroups(dueItems(app.dv, today).filter((x) => x.item.active !== false || x.taken)), [today]) || [];
  const labs = useAnalytics(() => labSummary(app.dv), []);
  const fin = useAnalytics(() => financeSummary(app.dv), []);
  const items = app.store.all('protocolItems').filter((i) => i.active !== false);
  const journal = app.store.all('journal');
  const quotes = app.store.all('savedQuotes');

  const stacks = groups.filter((g) => g.total);
  const protoMeta = !items.length ? 'Supplements, peptides, medications' : stacks.length
    ? stacks.map((g) => `${g.stack ? stackTitle(g.stack).replace(/ stack$/, '') : 'Other'} ${g.taken}/${g.total}`).join(' · ') + ' today'
    : `${plural(items.length, 'active item')} · nothing due today`;
  const latestPanel = labs && labs.latest ? app.store.get('labs', labs.latest.id) : null;
  const labMeta = labs && labs.latest
    ? `Latest ${fmtDate(labs.latest.date, { dow: false })}${latestPanel ? ` · ${flaggedMarkers(latestPanel).length ? `${flaggedMarkers(latestPanel).length} flagged` : 'all in range'}` : ''}`
    : 'Blood panels and marker trends';
  const finMeta = fin && fin.latest ? `Net worth ${fmtMoney(fin.latest.total, true)} · ${monthLabel(fin.latest.month, { short: true })}` : 'Net worth and company equity';
  const jMeta = journal.length || quotes.length ? `${plural(journal.length, 'entry', 'entries')} · ${plural(quotes.length, 'saved quote')}` : 'Notes and saved quotes';

  const links = [
    { id: 'protocols', icon: 'pill', title: 'Protocols', meta: protoMeta },
    { id: 'labs', icon: 'labs', title: 'Labs', meta: labMeta },
    { id: 'finance', icon: 'wallet', title: 'Finance', meta: finMeta },
    { id: 'journal', icon: 'book', title: 'Journal', meta: jMeta },
    { id: 'import', icon: 'upload', title: 'Import', meta: 'Apple Health, FORGE v2, backups, meal photos' },
    { id: 'settings', icon: 'settings', title: 'Settings', meta: 'Profile, targets, integrations, AI, security' },
  ];

  const integ = app.store.setting('integrations');
  const syncL = syncLine(sync, { demo: app.demo, now, tz });
  const whoopL = integrationLine(app.store.get('status', 'whoop'), { configured: !!(integ.whoop && integ.whoop.connectedAt), demo: app.demo, now, tz });
  const calL = integrationLine(app.store.get('status', 'calendar'), { configured: !!(integ.gcal && (integ.gcal.saEmail || (integ.gcal.readCalendars || []).length)), demo: app.demo, now, tz });
  const pill = (l) => (l.tone ? html`<${Pill} tone=${l.tone} dot>${l.tone === 'good' ? 'OK' : l.tone === 'bad' ? 'Error' : 'Check'}</${Pill}>` : null);

  const lock = async () => {
    if (!(await app.confirm({ title: 'Lock FORGE on this device?', message: 'Your passphrase is needed to open it again. Changes waiting to sync are pushed first.', confirmLabel: 'Lock now' }))) return;
    setLocking(true);
    try { await app.session.lock(); } catch (e) { console.warn('[lock]', e); app.toast('Could not lock: ' + (e.message || e), { tone: 'error' }); setLocking(false); }
  };

  const nav = html`<${Card} flush><${List}>${links.map((l) => html`<${ListRow} lead=${l.icon} title=${l.title} meta=${l.meta} onClick=${() => app.nav('/' + l.id)} />`)}</${List}></${Card}>`;
  const status = html`<div class="stack">
    <${Section} title="Status">
      <${Card} flush><${List}>
        <${ListRow} lead="sync" title="Vault sync" meta=${syncL.text} trail=${pill(syncL)} onClick=${() => app.nav('/settings/sync')} />
        <${ListRow} lead="activity" title="WHOOP" meta=${whoopL.text} trail=${pill(whoopL)} onClick=${() => app.nav('/settings/integrations')} />
        <${ListRow} lead="calendar" title="Google Calendar" meta=${calL.text} trail=${pill(calL)} onClick=${() => app.nav('/settings/integrations')} />
      </${List}></${Card}>
    </${Section}>
    ${app.demo ? null : html`<${Button} icon="lock" block onClick=${lock} loading=${locking}>Lock now</${Button}>`}
    <div class="xs muted center rec-version">FORGE ${APP_VERSION} · end-to-end encrypted</div>
  </div>`;

  return html`<${Page} title="More" sub="Records, import and settings" wide=${wide}>
    ${wide ? html`<div class="rec-split wide-right">${html`<${Section} title="Records">${nav}</${Section}>`}${status}</div>` : html`${nav}${status}`}
  </${Page}>`;
}
