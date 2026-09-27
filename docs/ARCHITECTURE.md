# FORGE v3 — Architecture Contract

This file is the contract every module follows. If code and this file disagree, fix one of them in the same change.

## 1. Topology

| Piece | Where | Visibility | Holds |
|---|---|---|---|
| App (PWA) | `emailwarrior/forge` → GitHub Pages `https://emailwarrior.github.io/forge/` | **public** | Code only. No personal data, no personal defaults, no secrets. |
| Vault | `emailwarrior/forge-vault` | **private** | End-to-end encrypted data + the automation workflow + the automation bundle. |
| Automation | GitHub Actions in the vault (`.github/workflows/forge-sync.yml` runs `automation/forge-automation.mjs`) | private | WHOOP sync, Google Calendar sync, push notifications, optional server-side AI. |

The app never needs a server. Devices talk to the GitHub API (vault), the Claude API (analysis), and nothing else. Automation runs on GitHub's runners with secrets stored as Actions secrets.

## 2. Security model

- **Data key (DEK):** random AES-256-GCM key. Every data file in the vault is `gzip → AES-GCM(DEK, iv, aad = "forge/v1:" + path)`.
- **Keyring** `forge/keyring.json` (plaintext JSON, holds only wrapped keys): DEK wrapped by a key derived from the user's passphrase (PBKDF2-SHA256, 600k iterations, 16-byte salt) and separately by a random 256-bit **recovery key** shown once at vault creation.
- **Devices:** after one unlock, the DEK is stored in IndexedDB as a **non-extractable** `CryptoKey`. Optional "lock this device" mode keeps it in memory only (passphrase each session).
- **Local cache** stores the same encrypted blobs as the vault (never plaintext at rest).
- **Credentials on device** (GitHub token, Anthropic key, WHOOP client id): stored encrypted with the DEK.
- **Server:** the DEK is an Actions secret `FORGE_DATA_KEY` (set by the app through the GitHub Secrets API using a libsodium sealed box). Runners decrypt in memory only. Logs never print data.
- **Refuse public vaults:** the app checks `repo.private === true` before writing and aborts otherwise.
- **What leaves the vault unencrypted:** Claude API requests (meal photos, labs, summaries — Anthropic API terms, not used for training), Google Calendar event titles for plan blocks and reminders (sensitive items use neutral titles such as "Protocol"), push notification payloads (Web Push is end-to-end encrypted to the device).

Token (fine-grained PAT, repository access = `forge-vault` only): Contents RW, Actions RW, Secrets RW, Workflows RW, Metadata R.

## 3. Vault layout

```
forge/keyring.json            plaintext: wrapped DEK (passphrase + recovery)
forge/meta.json               plaintext: {schema:3, encrypted:true, createdAt}
forge/app/<collection>[/<period>].enc      app-owned shards (written only by the app)
forge/server/<collection>[/<period>].enc   server-owned shards (written only by automation)
media/<kind>/<yyyy>/<mm>/<id>.enc          encrypted images/PDFs (meal photos, lab files)
automation/forge-automation.mjs            automation bundle (installed by the app)
.github/workflows/forge-sync.yml           workflow (installed by the app)
```

**Single-writer rule:** a shard file is written by exactly one party. The app writes `forge/app/**` and `media/**`; automation writes `forge/server/**`. Collections that both sides produce (e.g. `reviews`) have an app shard and a server shard; readers merge them.

## 4. Records and merge

Every record:

```js
{ id: 'string', _c: createdAtMs, _u: updatedAtMs, _f?: { field: ms }, _d?: 1 | null, ...fields }
```

- Field time = `_f[field] ?? _c`. `_u` = max of all field times.
- **Merge(A, B)** is per field: newest field time wins; ties break on `stableStringify(value)` (larger wins) so merges are deterministic on every device. Commutative, associative, idempotent.
- Deletion is the field `_d: 1` (undelete writes `_d: null`). Live = `!rec._d`.
- A collection's live view = merge of the same `id` across **all** its shards (app + server, all periods). An app edit to a server record writes the patched record into the app shard; its newer field times win.
- Tombstones older than 180 days are pruned from app shards on write.

Shard file (plaintext form before gzip+encrypt): `{ "schema": 3, "c": "<collection>", "o": "app"|"server", "p": "<period>|null", "r": { "<id>": record } }`

## 5. Collections

Period: `none` (single file), `year` (by `date` → `YYYY`), `month` (by `date` → `YYYY-MM`). Owners: `A` app, `S` server. Canonical units: pounds (body weight, loads), inches, grams/mg (nutrition), minutes, local dates `YYYY-MM-DD`, instants as ISO strings with offset.

| Collection | Owners | Period | Id | Key fields |
|---|---|---|---|---|
| settings | A | none | fixed (`profile`,`targets`,`nutritionRules`,`finance`,`integrations`,`notifications`,`ui`,`security`) | see §6 |
| standards | A | none | uid | name, category, kind (`check`\|`avoid`\|`number`\|`time`\|`duration`), target {op,value,unit}, weight 1–3, required, days [0–6 Mon=0], active, effectiveFrom, order, auto (source string, §8) |
| checks | A | year | `${date}:${standardId}` | date, standardId, value (true/false/number/'HH:MM'), source (`manual`\|`auto`), note |
| days | A | year | date | date, deepWorkH, energy, mood, stress, appetite, soreness, focus (1–5), alcohol, caffeineMg, caffeineLastAt ('HH:MM'), sunlightMin, dayRating (1–10), wins, misses, note, checkinAt |
| journal | A | year | uid | date, at, text, tags[] |
| savedQuotes | A | none | hashId(text+who) | text, who, savedAt |
| exercises | A | none | slug/uid | name, muscle, secondary[], equipment, type (`strength`\|`cardio`\|`mobility`), bodyweight |
| templates | A | none | uid | kind (`workout`\|`day`), name, exercises[{exerciseId,sets,reps,rpe}] or blocks[{start,end,title,category,reminder}] |
| sessions | A | month | uid | date, startAt, endAt, name, templateId, entries[{id,exerciseId,sets[{w,reps,rpe,kind,done}],note}], cardio[{id,exerciseId,durationMin,distanceMi,avgWatts,avgHr,maxHr,kcal,rpe}], rpe, note, whoopWorkoutId |
| meals | A,S | month | uid | date, at, timeSource (`camera`\|`exif`\|`filename`\|`file`\|`manual`), slot (`breakfast`\|`lunch`\|`dinner`\|`snack`\|`shake`\|`pre`\|`post`), source (`snap`\|`library`\|`files`\|`text`\|`saved`\|`quick`\|`manual`), photo {path,w,h} (primary), photos[{path,w,h}] (all, incl. labels), note, title, items[FoodItem], totals{Nutrients}, ai{model,confidence,assumptions[],searched,sources[],reference,costUsd,costEstimated,at,fallback,title (title the owner edited; kept across re-analysis)}, followUp (question or null), answers[{q,a}], status (`pending`\|`analyzing`\|`ready`\|`error`), error |
| foods | A | none | uid | name, items[FoodItem], totals{Nutrients}, uses, lastUsedAt, favorite |
| protocolItems | A | none | uid | name, kind (`supplement`\|`peptide`\|`medication`), amount, unit, form, schedule{type:`daily`\|`weekly`\|`days`\|`asneeded`, days[], times[], stack}, weeklyTarget{amount,unit}, active, startedAt, endedAt, neutralLabel, note |
| doses | A | year | uid | itemId, date, at, amount, unit, site, skipped, note |
| body | A | year | uid | date, at, weightLb, bodyFatPct, leanMassLb, waistIn, chestIn, armIn, thighIn, neckIn, method (`scale`\|`tape`\|`dexa`\|`inbody`\|`health`), note |
| health | A | year | date | Apple Health daily import: steps, activeKcal, restingKcal, exerciseMin, standH, restingHr, hrvSdnn, vo2max, weightLb, bodyFatPct |
| labs | A | year | uid | collectedAt (date), lab, source, file{path,mediaType}, markers[{key,name,value,unit,refLow,refHigh,optLow,optHigh,flag,note}], note, ai{...} |
| plan | A | month | uid | date, start 'HH:MM', end 'HH:MM', title, category (`deep`\|`meeting`\|`training`\|`admin`\|`meal`\|`recovery`\|`personal`\|`commute`\|`learning`), status (`planned`\|`done`\|`partial`\|`skipped`), actualMin, note, calendar (bool, default true), reminder (bool), templateId |
| reviews | A,S | year | `${kind}:${period}` | kind (`nutrition`\|`weekly`\|`brief`\|`labs`), period, date (period start), createdAt, model, content{...}, costUsd, source (`app`\|`server`) |
| pushSubs | A | none | hashId(endpoint) | endpoint, keys{p256dh,auth}, device, createdAt, active |
| snapshots | A | none | month 'YYYY-MM' | month, gross, items[{name,type:`asset`\|`liability`,value,category}], note |
| whoopCycles | S | year | String(cycle.id) | date, start, end, tz, scoreState, strain, kj, kcal, avgHr, maxHr, steps |
| whoopRecovery | S | year | String(cycle_id) | date, cycleId, sleepId, scoreState, calibrating, recovery, rhr, hrv, spo2, skinTempC |
| whoopSleep | S | year | sleep.id | date (local date of wake), cycleId, start, end, tz, nap, scoreState, inBedMin, awakeMin, lightMin, deepMin, remMin, asleepMin, cycles, disturbances, needMin, needBaselineMin, needDebtMin, needStrainMin, needNapMin, respRate, performance, consistency, efficiency, bedtime 'HH:MM', wake 'HH:MM' |
| whoopWorkouts | S | year | workout.id | date, start, end, tz, sport, sportId, scoreState, strain, avgHr, maxHr, kj, kcal, percentRecorded, distanceM, altGainM, zonesMin[6] |
| whoopBody | S | none | `body` | heightIn, weightLb, maxHr |
| calendarEvents | S | month | `${calendarId}:${eventId}` | date, start, end, allDay, title, calendarId, attendees, organizerSelf, status (`confirmed`\|`tentative`\|`declined` — your RSVP was no), response (your RSVP or null), isForge, forgeRef |
| calendarMap | S | none | forgeRef | eventId, hash, pushedAt |
| pushLog | S | year | `${kind}:${key}` | kind, date, sentAt, title, ok |
| status | S | none | `whoop`\|`calendar`\|`push`\|`reviews`\|`run` | lastRunAt, lastOkAt, lastError, detail{} |
| secrets | S | none | `whoop` | accessToken, refreshToken, expiresAt, scope (server-only; encrypted like everything else) |

`FoodItem` = `{ name, portion, grams, confidence ('low'|'medium'|'high'), basis ('estimate'|'label'|'web'|'saved'), ...Nutrients }`
`Nutrients` = `{ kcal, protein, carbs, fat, fiber, sugar, satFat, sodium, potassium, calcium, iron, magnesium, vitC, vitD }` (g, except sodium/potassium/calcium/iron/magnesium/vitC mg, vitD IU).

## 6. Settings records (defaults in `js/core/schema.js`)

- `profile`: name, heightIn, birthYear, sex, timezone, units (`imperial`|`metric`), goalWeightLow, goalWeightHigh, goalRateLbWk
- `targets`: mode (`adaptive`|`manual`), kcal, proteinG, proteinPerLb, fatPct, fiberG, surplusKcal, wake, bedtime, caffeineCutoff, lastMealBy, sleepTargetH, deepWorkTargetH, trainingWindow{start,end}
- `nutritionRules`: rules[{id,text,active}]
- `finance`: mult, stake, expense (no personal defaults in code — all zero until set)
- `integrations`: whoop{clientId, connectedAt}, gcal{saEmail, readCalendars[], forgeCalendarId, pushPlan, pushReminders}, push{vapidPublicKey}, ai{model, fastModel, effort, webLookup, serverReviews}
- `notifications`: morningBrief, eveningCheckinAt, weeklyReview, doseReminders, quietStart, quietEnd
- `ui`: theme (`system`|`dark`|`light`), startScreen
- `security`: lockMode (`device`|`session`), autoLockMin

## 7. Store API (`js/core/store.js`) — same in browser and Node

```js
const store = createStore({ owner: 'app' | 'server', clock?: () => ms });
store.loadShard(path, plainObject)        // add/merge a decoded shard
store.all(coll, { includeDeleted })       // live records (merged across shards)
store.get(coll, id)
store.byDate(coll, date) / store.range(coll, from, to)   // by `date`, inclusive
store.create(coll, fields) → record       // id = fields.id ?? uid()
store.update(coll, id, patch) → record    // per-field times
store.upsert(coll, id, fields) → record    // update that also revives a deleted record (fixed ids)
store.remove(coll, id) / store.restore(coll, id)
store.setting(id) → merged with defaults; store.updateSetting(id, patch)
store.subscribe(fn) → unsubscribe         // fn({ collections: Set, source })
store.dirty() → [{ path, shard }] ; store.markClean(path)
store.version                               // increments on every change
```

## 8. Standards auto sources

`whoop.wake` (sleep wake time), `whoop.sleep` (asleep hours), `plan.adherence` (% of planned minutes done), `training.session` (any session or WHOOP workout), `nutrition.meals` (count), `nutrition.protein` (grams), `nutrition.kcal`, `nutrition.item:<text>` (any item name contains text), `protocol.stack:<stack>` (all active items in the stack logged), `protocol.item:<id>`, `day.caffeineCutoff` (caffeineLastAt ≤ target), `day.deepWork` (hours). Manual entry always overrides auto.

## 9. Analytics (`js/analytics/*`) — pure functions over a DataView

`makeDataView(store, { tz })` exposes typed per-date accessors; `buildDaily(dv, from, to)` returns one row per date with every feature (§ analytics/README in code). Modules: `stats`, `daily`, `readiness`, `execution`, `body`, `strength`, `nutrition`, `protocols`, `labs`, `schedule`, `correlations`, `weekly`, `finance`, `context`. No module touches the DOM or the network.

## 10. AI (`js/ai/*`)

`callClaude()` (browser adds `anthropic-dangerous-direct-browser-access: true`; never sends non-default temperature to Sonnet 5; handles `pause_turn`, 429/529 retries), `analyzeMeal()` (web search optional + strict `record_meal` tool, `tool_choice: auto`), `extractLabs()` (`output_config.format` JSON schema), `nutritionReview()` (alias `reviewNutritionDay()`), `weeklyReview()`, `morningBrief()`, `askForge()`. Prompts never recommend changing medication or peptide dosing; abnormal labs are flagged for physician review.

## 11. Automation (`automation/*` → bundled `dist/forge-automation.mjs`)

Env: `FORGE_DATA_KEY` (required), `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `GOOGLE_SA_KEY`, `ANTHROPIC_API_KEY`, `VAPID_PRIVATE_KEY`, `FORGE_TASK` (`auto`|`ping`|`whoop`|`whoop-auth`|`whoop-backfill`|`calendar`|`notify`|`push-test`|`reviews`), `FORGE_PAYLOAD` (DEK-encrypted JSON for `whoop-auth`). Writes only `forge/server/**`. Commits WHOOP token rotations immediately, then data.

## 12. UI

Preact + htm (vendored, no build step). Conventions and the shared action/part contracts are in `docs/UI_GUIDE.md`. Hash routes: `#/today[/<date>]`, `#/plan[/<date>]`, `#/train`, `#/train/session/<id>`, `#/fuel[/<date>]`, `#/insights[/<section>]`, `#/more`, `#/protocols`, `#/labs`, `#/finance`, `#/journal`, `#/settings[/<section>]`, `#/setup`, `#/import/<kind>`. Components come from `js/ui/kit.js` and charts from `js/ui/charts.js`; screens live in `js/ui/screens/*.js` and export one default component. Styling uses the tokens in `css/app.css` only.
