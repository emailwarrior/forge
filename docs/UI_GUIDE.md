# FORGE v3 — UI Guide

Read this before touching `js/ui/**`. It is the contract between screens built in parallel. `docs/ARCHITECTURE.md` defines data; `docs/ANALYTICS_API.md` and `docs/AI_API.md` define the compute layers. If code and docs disagree, fix one of them in the same change.

## 1. Product intent

FORGE is a private performance instrument for one person: schedule, training, nutrition, recovery, protocols, labs and money in one system, with analytics that explain *what was actually done each day* and *what moves the numbers*. The owner's goals: steadily rising strength and endurance output, more muscle, body weight up into the goal range set in the profile, and a schedule that respects recovery.

Design principles:

- **Professional, not a game.** No XP, levels, avatars, trophies, confetti, badges, streak flames, emojis or motivational slogans. A streak is shown as a plain number ("Perfect days in a row: 4").
- **Specifics over summaries.** Show the actual sets, grams, minutes and times. Every number has a unit. Every estimate says it is an estimate (AI nutrition, TDEE) and how confident it is.
- **Explain, briefly.** One short line of "why" beats a paragraph (e.g. "Build: recovery 58, HRV −0.6 SD vs 30-day baseline").
- **Honest empty states.** Say what fills the view and link to it ("Connect WHOOP in Settings → Integrations", "Log 14 days of meals to estimate TDEE").
- **Fast input.** The most common actions (log a set, snap a meal, weigh in, mark the AM stack) are one or two taps from Today, on a phone, one-handed.
- **Calm visual language.** Neutral surfaces, one accent (orange) for primary actions and the current selection, status colors only for status, chart series colors only for series.
- **Health guardrails.** FORGE records protocols and labs; it never suggests starting, stopping or changing a dose. Out-of-range labs say "review with your physician". Peptides/medications show `neutralLabel` wherever text may leave the device (notifications, calendar); inside the app the real name is fine.

Copy style: sentence case, no exclamation marks, no emojis, direct. Units: `lb`, `in`, `kcal`, `g`, `mg`, `mcg`, `ml`, `bpm`, `ms`, `min`, `h`, `%`. Times via `fmtTime` ("7:05 AM"), dates via `fmtDate` ("Sat, Sep 26") or `relDay` ("Yesterday"), durations via `fmtDur` ("1h 05m"), signed deltas via `signed` ("+0.4"), percentages via `fmtPct`.

## 2. Stack rules

- Preact + htm from `js/vendor/preact-htm.js` (no build step, no JSX, no new dependencies). ES modules with relative imports.
- **CSP** (`index.html`): scripts only from `'self'`; network only to `'self'`, `api.github.com`, `api.anthropic.com`; images `'self' blob: data:`. No inline `<script>`, no external images/fonts/APIs, no `eval`/`new Function`.
- **Never** write data to `localStorage`/`sessionStorage` (the only exceptions are the existing transient OAuth keys and per-device UI prefs that contain no personal data, e.g. a selected tab). Everything else goes through the store (encrypted + synced).
- **Never** `console.log` record contents, tokens or keys. `console.warn(e)` for errors is fine.
- Screens only read and write through the `app` object, the store, analytics and AI modules. No direct GitHub calls from screens except through `js/app/integrations.js` / `session`.
- Styling: classes from `css/app.css`, plus your area stylesheet (`css/day.css`, `css/train.css`, `css/fuel.css`, `css/insights.css`, `css/records.css`, `css/settings.css`), tokens only (`var(--…)`), no hard-coded colors. Inline `style` for one-off layout is fine.
- Dates: always from `app.today()` / `dv.today()` (profile time zone). Never `new Date().toISOString().slice(0,10)` (that is UTC). Instants: `isoWithOffset(ms, app.dv.tz)` / `nowIso(app.dv.tz)`. Local date + 'HH:MM' → instant: `zonedToMs(date, hm, tz)`. Instant → local: `localParts(iso, tz)` → `{ymd, hm, min}`.
- Mobile first (390 × 844). Desktop ≥ 1024 px gets the sidebar; use `Page wide` + `.grid.two|three` for multi-column layouts. Tap targets ≥ 40 px. Numeric inputs use `inputmode="decimal"` (`NumberInput`, `Stepper` do this).

## 3. The app object and hooks (`js/ui/ctx.js`, `js/app.js`)

`const app = useApp()`:

| Member | Use |
|---|---|
| `app.store` | the record store (§7) |
| `app.dv` | the DataView for analytics (`dv.tz`, `dv.today()`, per-date accessors — see ANALYTICS_API.md) |
| `app.session` | `session.putMedia(kind, date, id, bytes, mediaType)` → `{path, mediaType, bytes}`, `session.mediaUrl(path, mediaType)` (object URL for `<img>`/links), `session.mediaBytes(path)` (decrypted `Uint8Array`, e.g. to re-send a stored photo to the AI — `fetch()` of a `blob:` URL is blocked by the CSP), `session.creds` (`githubToken`, `anthropicKey`), `session.updateCreds(patch)`, `session.gh`, `session.vault` (`{owner, repo}`), `session.lock()`, `session.setLockMode()`, `session.changePassphrase(old, new)`, `session.dataKeyRaw(passphrase)`, `session.forgetDevice()`, `session.importV2(obj)`, `session.encryptPayload(obj, path)`, `session.syncStatus()` |
| `app.sync` | `sync.sync()`, `sync.flush()`, `sync.pull()` (null in demo) |
| `app.demo` | true in `?demo` mode (synthetic data, nothing saved, no GitHub) |
| `app.today()` | local 'YYYY-MM-DD' |
| `app.nav(path)` / `app.back()` | hash navigation (`app.nav('/train/session/' + id)`) |
| `app.toast(msg, {tone, action:{label,onClick}, ms})` | short confirmation; use `action` for Undo |
| `app.sheet(({close}) => node, {wide, modal})` | bottom sheet (dialog on desktop); resolves with the value passed to `close(v)` |
| `app.confirm({title, message, confirmLabel, danger})` | → `Promise<boolean>` |
| `app.ai()` / `app.requireAi()` | AI config or null (`requireAi` also toasts a link to Settings → AI) |
| `app.takeOAuth()` | pending OAuth callback result (Settings → Integrations only) |

Hooks: `useVersion(collections?)` re-renders on store changes; `useSetting(id)`; `useSyncStatus()`; `useAction(fn, deps)` → `[run, {busy, error, result}]`; `useAnalytics(() => compute(), deps)` memoizes on the store version (wrap every analytics call in it); `useRoute()` → `{path, parts, name, arg, query}`; `useWide()`; `useNow()`.

**Sheets are rendered outside the screen tree** (in `SheetHost`, inside the app context). The render function you pass to `app.sheet` must only return a component element — `app.sheet(({close}) => html\`<${MealSheet} id=${id} close=${close} />\`)` — never call hooks in the render function itself. The component owns its state, calls `useApp()`/`useVersion()` itself, and re-renders on store changes. Open sheets stay mounted while another sheet opens on top (only the top one is visible), so a detail sheet can open a picker sheet and keep its state. `close(value)` resolves the `app.sheet` promise.

## 4. Kit and charts

Read `js/ui/kit.js` (props documented inline): `Page, Section, Card, Stat, Pill, Button, IconButton, Field, Input, NumberInput, TimeInput, Select, Textarea, Segmented, Toggle, ToggleRow, Chips, Scale5, Stepper, Check, List, ListRow, Empty, Notice, Meter, Spinner, Skeleton, KV, BandPill, SheetHead, SheetFoot, FileButton, Disclosure, CopyBox, Icon, cx, html`. Icon names: `js/ui/icon-paths.js`.

Charts (`js/ui/charts.js`): `LineChart, BarChart, StackedBars, Sparkline, Ring, Heatmap, Scatter, RangeBar, Legend, SERIES, niceTicks, fmtAxisDate`. Rules: 2 px lines, one y-axis per chart, legend when ≥ 2 series, series colors `SERIES[i]` in order (never status colors for series), reference ranges as `band`, goals as `target`. Keep ≤ 4 series per chart.

Useful CSS classes: layout `stack (xs|sm|lg)`, `row (wrap|between|end|top)`, `grow`, `grid two|three|four`, `only-sm`, `hide-sm`, `divider`; text `muted`, `dim`, `small`, `xs`, `strong`, `mono`/`num`, `ellipsis`, `eyebrow`, `hero`, `pos`/`neg`, `ink-good|warn|bad`; components `tag` (small mono label, e.g. data source), `quick` + `fab-row` (quick action tiles), `timeline` + `tl-item/tl-time/tl-rail/tl-body/tl-card/tl-now` + `cat-<category>`, `thumb`/`thumb lg`/`photo-ph`, `table-wrap` + `table.data` (`td.num`), `meter-row`, `ai-status`, `kv`, `code-box`, `kbd`, `banner`, `scroll-x`.

## 5. Shared parts (`js/ui/parts/`)

- `media.js`: `EncryptedImage({path, mediaType, class, alt, onClick})`, `usePhotoUrl(path, mediaType)`, `viewImage(app, {path, mediaType, title})`.
- `ai.js`: `useAiTask()` → `task` with `task.run(({ai, signal, onProgress}) => aiFn(ai, {..., signal, onProgress}))`, `task.busy/phase/query/error/result/cancel/reset`; `AiStatus({task})` (phase line + elapsed + Cancel), `AiError({error, onRetry})`, `CostNote({usd, model, estimated})`, `AiKeyNotice({what})`, `aiErrorText(err)`.
- `date.js`: `routeDate(route, app)`, `dateLabel(date, today)`, `DateNav({date, base, max})`.
- `common.js`: `removeWithUndo(app, coll, id, what)`, `QuoteCard({date})`, `quoteId(text, who)`.
- `js/app/backup.js`: `exportBackup(store)`, `importBackup(store, obj)`, `describeBackup(obj)`, `isBackup(obj)`.
- `js/app/integrations.js`: GitHub secrets, automation install/dispatch/status, WHOOP OAuth, Google service account, Web Push (read the file).
- `js/data/quotes.js`: `quoteForDate(ymd)` → `{text, who, bio}`, `PEOPLE`, `QUOTES`.

New shared components go in a new file `js/ui/parts/<area>-<name>.js`. Do not add to `kit.js`/`charts.js` except for small bug fixes (report them).

## 6. Action contracts (`js/ui/actions/*.js`)

Actions are functions that open a sheet, write records and resolve when closed. Screens import them freely; the owner implements them. Every action accepts a missing `date` (defaults to `app.today()`).

| Module (owner) | Export | Behavior |
|---|---|---|
| `meal.js` (Fuel) | `openMealCapture(app, {date, mode})` → `Promise<string[] \| undefined>` | `mode`: `'camera'` (take photo now), `'library'` (photos, multiple), `'files'` (Files app, multiple, times from filenames), `'text'` (describe), `'saved'` (saved foods / quick add), `undefined` (chooser). Stores photos encrypted, creates `meals` records, runs AI analysis when a key exists. Resolves with the created meal ids. |
| | `openMeal(app, id)` | Meal detail: photo, time, items (edit portions), re-analyze, follow-up answer, save as food, delete. |
| `workout.js` (Train) | `startWorkout(app, {date, templateId})` → `Promise<string \| undefined>` | Resumes today's open session (no `endAt`) if any, else asks for a template / empty session, creates the `sessions` record and navigates to `#/train/session/<id>`. |
| | `openCardioLog(app, {date})` → `Promise<string \| undefined>` | Quick cardio entry (exercise, duration, distance, avg watts, avg/max HR, kcal, RPE); appends to today's open session or creates a finished one. |
| `weight.js` (Day) | `openWeighIn(app, {date, id})` | `body` record: weight lb, optional body fat %, waist in, method, time. |
| `checkin.js` (Day) | `openCheckin(app, {date})` | Edits the `days` record (1–5 scales, caffeine, alcohol, deep work, rating, wins/misses/note); sets `checkinAt`. |
| `plan.js` (Day) | `openBlock(app, {date, id, start, end, category})` → `Promise<string \| undefined>` | Create/edit a `plan` block (title, category, start/end, status, actual minutes, reminder, calendar, note, delete). |
| `stack.js` (Records) | `openStackLog(app, {date, stack})` → `Promise<number \| undefined>` | Lists active items of that stack due on the date; logs the checked ones as `doses` at the chosen time. |
| | `openDoseLog(app, {date, itemId, id})` → `Promise<string \| undefined>` | Log/edit one dose (item, amount, unit, time, site, skipped, note); shows the week's total vs `weeklyTarget`. |
| `journal.js` (Records) | `openJournalEntry(app, {date, id})` → `Promise<string \| undefined>` | Create/edit a `journal` entry (text, tags, time). |

Stubs exist so every import works today; the owner replaces the stub body, keeping the exports and signatures.

## 7. Writing data

Store API (`js/core/store.js`, see ARCHITECTURE §7): `store.all(coll)`, `store.get(coll, id)`, `store.byDate(coll, date)`, `store.range(coll, from, to)`, `store.create(coll, fields)` (id = `fields.id ?? uid()`), `store.update(coll, id, patch)` (creates when missing), `store.upsert(coll, id, fields)` (like update, but also revives a deleted record — use it for fixed ids), `store.update` keeps a deleted record deleted, `store.remove(coll, id)` / `store.restore(coll, id)`, `store.setting(id)` / `store.updateSetting(id, patch)` (shallow-merges nested objects one level).

- Returned records are shared: never mutate them. Build a new array/object and `update` the field.
- Merge granularity is the **field**: `update('sessions', id, {entries})` replaces the whole `entries` array. Keep each write to the fields you changed. Debounce typing (≈ 400 ms); the sync layer batches pushes.
- Records in period collections **must** carry `date` ('YYYY-MM-DD', local): `checks, days, journal, sessions, meals, doses, body, health, labs (date = collectedAt), plan, reviews` (reviews: `date` = the period's first day).
- Ids: `checks` = `` `${date}:${standardId}` ``; `days`/`health` = date; `reviews` = `` `${kind}:${period}` `` (`brief:<date>`, `nutrition:<date>`, `weekly:<isoWeek>` e.g. `2026-W39`, `labs:<labId>`); `savedQuotes` = `quoteId(text, who)`; `snapshots` = 'YYYY-MM'; everything else `uid()`.
- `at` fields are ISO instants with offset (`isoWithOffset`). `start`/`end` on `plan` blocks are local 'HH:MM'.
- Server-owned collections (`whoop*`, `calendarEvents`, `calendarMap`, `pushLog`, `status`, `secrets`) are read-only for the app (writes throw). App edits to `meals`/`reviews` are fine (both owners).
- Deleting: `removeWithUndo(app, coll, id, 'Meal')`.
- Settings: `store.updateSetting('targets', {kcal: 3100})`. Defaults live in `SETTINGS_DEFAULTS` (`js/core/schema.js`); personal values are never hard-coded.
- Manual checks override auto values; clearing a manual check = `store.remove('checks', id)`.
- The demo (`?demo`) writes to the in-memory store only; flows must still work there (media works in memory too). Anything that needs GitHub (automation, secrets, WHOOP, Google, push) shows a short "Not available in demo" notice.

## 8. Analytics in the UI

Wrap computations: `const r = useAnalytics(() => readiness(app.dv, date), [date])`. Import from `js/analytics/index.js`. `buildDaily(dv, from, to)` is memoized per store version; keep ranges ≤ 400 days per chart. Heavy views (Insights) compute per section, not all at once. Never re-implement a metric the analytics layer already provides; if something is missing or wrong, add it to the analytics module with a test and note it in your report.

## 9. AI in the UI

Use `useAiTask()` + `AiStatus` + `AiError` + `CostNote`. Always pass `signal` and `onProgress`. Cancel is silent. Show `followUp` questions from meal analysis as a one-line question with a short answer box (re-run with `answers`). Store AI outputs in records (meals.items/ai, reviews, labs.ai) so they are never recomputed on view. Show the model and cost small and muted. Guardrails live in the prompts; never add UI copy that recommends dose changes.

## 10. Routes and navigation

`#/today[/<date>]`, `#/plan[/<date>]`, `#/train`, `#/train/session/<id>`, `#/train/exercise/<id>`, `#/fuel[/<date>]`, `#/insights[/<section>]`, `#/more`, `#/protocols`, `#/labs[/<id>]`, `#/finance`, `#/journal`, `#/settings[/<section>]`, `#/import[/<kind>]`.

Insights sections: `overview` (default), `recovery`, `sleep`, `body`, `strength`, `cardio`, `nutrition`, `protocols`, `labs`, `schedule`, `drivers`, `weekly`, `ask`.
Settings sections: `profile`, `targets`, `standards`, `nutrition`, `integrations`, `ai`, `automation`, `notifications`, `sync`, `security`, `data`, `appearance`. Other screens link to these exact names (`app.nav('/settings/integrations')`).
Import kinds: `health` (Apple Health JSON), `v2` (FORGE v2 `forge-data.json`), `backup` (FORGE v3 backup), `meals` (Shortcut photo import help → meal capture `files` mode).

Each screen module exports `default function Screen({ route })` and renders `Page`. Sub-routes are handled inside the screen (`route.parts`). Keep the default export light and lazy-import heavy sub-views if a screen grows past ~1,500 lines.

## 11. Testing your work

- Static server: `node tools/serve.mjs` (already running at `http://localhost:8123/forge/`; start it in the background if `curl -s localhost:8123/forge/ > /dev/null` fails).
- Screenshots (demo data): `SIZES=mobile,desktop node tools/shot.mjs <outdir> today fuel "train/session/xyz"` → PNGs + console errors + crash detection per route. Use your own `<outdir>` in the scratchpad. Look at the PNGs with the Read tool. `FULL=0` for viewport-only, `SCHEME=light` for the light theme, `WAIT=3000` for slow views, `DEMO=empty` for a fresh vault (seeded standards/exercises only — no WHOOP, meals, sessions, labs; this is what the owner sees in week one, so it must look intentional and guide him to the first actions).
- Demo URLs: `http://localhost:8123/forge/?demo=1#/today` (120 days of synthetic data) and `?demo=empty#/today`.
- Interactions: write a small Playwright script in your scratchpad (import from `/home/claude/.npm-global/lib/node_modules/playwright/index.mjs`, open `…/forge/?demo=1#/…`, click, fill, screenshot). Test the main flows end to end in demo mode (sheets open, records save, lists update, no console errors).
- Real (non-demo) setup, sync, locking and multi-device flows: `node tools/e2e-setup.mjs` (about 5 minutes, no network: in-memory GitHub + Anthropic mocks, runs the automation bundle the app installs). Run it before deploying changes to `js/core/**`, `js/app/**`, setup or Settings; it exits 1 on any failure and writes a report with every GitHub endpoint the app called.
- Pure logic you add (parsers, calculators) gets `node:test` tests under `tests/ui/` or `tests/app/`; run `npm test` before you finish — all tests must pass.
- Check both themes and both sizes for your screens at least once.
