# FORGE automation

Server-side jobs for FORGE v3, run by GitHub Actions inside the private vault repository.
Source lives here; `tools/build-automation.mjs` bundles it into one self-contained file,
`dist/forge-automation.mjs`, which the app installs into the vault as
`automation/forge-automation.mjs` next to `.github/workflows/forge-sync.yml`
(copied from `automation/forge-sync.yml`). Contract: `docs/ARCHITECTURE.md` §2, §3, §5, §11.

## What a run does

1. Reads `FORGE_DATA_KEY`, checks it against `forge/keyring.json` (`kid`); aborts with exit
   code 1 if it is missing, malformed or belongs to another vault.
2. Decrypts every `forge/**/*.enc` shard into one in-memory store (owner `server`).
3. Runs the task (`FORGE_TASK`, default `auto`), each integration isolated in its own
   try/catch and recorded in the `status` collection.
4. Encrypts and writes only the `forge/server/**` shards whose records actually changed,
   commits them as `forge-bot <forge-bot@users.noreply.github.com>`, then
   `git pull --rebase` + `git push` (up to 5 attempts). No change → no commit.

| Task | Does |
|---|---|
| `auto` (hourly) | WHOOP sync (if connected) → Google Calendar (if `GOOGLE_SA_KEY`) → server reviews → push notifications |
| `ping` | Writes `status/run` `{lastRunAt, version}` and commits (connectivity check from the setup UI) |
| `whoop` | Incremental WHOOP sync only |
| `whoop-auth` | Decrypts `FORGE_PAYLOAD`, exchanges the OAuth code, commits + pushes the tokens, then backfills |
| `whoop-backfill` | Re-fetches all WHOOP history since 2015-01-01 (resumable) |
| `calendar` / `notify` / `reviews` | That integration only |
| `push-test` | One neutral test notification to every active subscription, now (ignores quiet hours; no `pushLog` entry; result in `status/push.detail.lastTest`) |

Exit code is 0 whenever the vault could be updated (integration failures live in `status`).
It is 1 when the data key is missing/wrong, and also when the results could not be pushed
after 5 attempts (the vault cannot record that failure itself, so the Actions run shows it).

## Secrets (Actions secrets in the vault)

| Secret | Required | Format |
|---|---|---|
| `FORGE_DATA_KEY` | yes | base64 of the raw 32-byte data key (the app sets it with a sealed box) |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | for WHOOP | from the WHOOP developer app |
| `GOOGLE_SA_KEY` | for Calendar | the service-account JSON key file (raw JSON or base64 of it) |
| `ANTHROPIC_API_KEY` | for server reviews | Anthropic API key |
| `VAPID_PRIVATE_KEY` | for push | base64url raw P-256 private scalar `d` (32 bytes) |

Workflow inputs (`workflow_dispatch`): `task` → `FORGE_TASK`, `payload` → `FORGE_PAYLOAD`.
Both reach the script only through `env:`; they are never interpolated into the script.
`FORGE_PAYLOAD` = base64 of `encryptBytes(DEK, utf8(JSON), 'payload/whoop-auth')` with
`{ code, redirectUri, state, at }`; anything that does not decrypt with the vault key is rejected.

## Settings the app must provide

Read from the merged `settings` records (app shards):

- `profile.timezone`: IANA zone (for example `America/New_York`). Every local-time decision uses it; falls back to UTC with a warning.
- `integrations.gcal.readCalendars`: explicit calendar IDs to read (usually the user's
  email). Share each with the service account with **See all event details** (free/busy-only
  sharing stores events titled "(busy)"). Empty → reading is skipped with a status note.
- `integrations.gcal.forgeCalendarId`: the calendar FORGE writes to. Share it with the
  service account with **Make changes to events**. Empty → nothing is pushed.
- `integrations.gcal.pushPlan` (default true), `integrations.gcal.pushReminders`.
- `integrations.push.vapidPublicKey` (base64url uncompressed P-256 point) and
  `integrations.push.subject` (an `https:` URL or `mailto:`; default `mailto:noreply@forge.invalid`).
- `integrations.ai.serverReviews` (+ `model`, `fastModel`, `effort`).
- `notifications.*` (`morningBrief`, `eveningCheckinAt`, `weeklyReview`, `doseReminders`, `quietStart`, `quietEnd`) and `targets.*` (`wake`, `bedtime`, `caffeineCutoff`).
- `pushSubs` records (`endpoint`, `keys{p256dh,auth}`, `active`), id = `hashId(endpoint)`.

WHOOP developer app: redirect URI = the app URL the setup UI uses as `redirectUri`; scopes
`offline read:recovery read:cycles read:sleep read:workout read:body_measurement`.

## What it writes (server shards only)

- `whoopCycles`, `whoopRecovery`, `whoopSleep`, `whoopWorkouts`, `whoopBody`: mapped per §5.
  Record field times come from WHOOP `updated_at`, so re-syncing identical data is a no-op
  and newer WHOOP edits win merges.
- `calendarEvents` (window today−35 … today+21, server-authoritative: vanished events are
  removed; records outside the window are untouched). Extra fields: `response` (your RSVP);
  a declined invitation has `status: 'declined'`.
- `calendarMap` (`forgeRef` → `{eventId, hash, pushedAt, date, calendarId}`) for the FORGE
  calendar: plan blocks (`plan:<id>`) and 10-minute reminders (`rem:<kind>:<date>[:<id>]`,
  kinds `stack` (AM/PM), `dose`, `caffeine`, `winddown`, `checkin`) for today−1 … today+14.
  Inserts, patches (body hash changed) and deletes are diffed; lost map records are adopted,
  duplicates and orphaned FORGE events are removed, events without a `forgeRef` are never touched.
- `pushLog` (`kind:key`, at most one successful delivery each), `reviews` (server shard),
  `secrets/whoop` (tokens, encrypted like everything else), and `status/<id>` for `whoop`,
  `calendar`, `push`, `reviews`, `run`: `{lastRunAt, lastOkAt, lastError, detail}`.

Status details the app can act on: `status/whoop.lastError === 'reauth-needed'` (reconnect
WHOOP; runs stop calling WHOOP until then), `status/whoop.detail.backfill` (`in-progress` /
`complete`), `status/push.detail.deadSubs` (hashes of endpoints that returned 404/410:
deactivate those `pushSubs`), `status/calendar.detail.notes` / `.errors` (sharing problems),
`status/calendar.detail.serviceAccount` (the email to share calendars with).

## Safety properties

- WHOOP refresh tokens rotate and die on use: a refresh happens only when the access token
  expires within 10 minutes (or once after a 401), and the new tokens are committed and
  pushed before any data request. A second 401, or a rejected refresh, marks
  `reauth-needed`.
- Only `forge/server/**` is ever written or committed; unreadable shards are never overwritten.
- Logs contain counts and statuses only; known secrets and token-like strings are redacted
  even if a library echoes them.
- Calendar titles and push payloads for peptides/medications use `neutralLabel` (default
  "Protocol"); substance names never leave the vault through these channels.
- Time budget: the job has 10 minutes. WHOOP gets 5 minutes in `auto` (7.5 alone); backfill
  proceeds newest-first in ~6-month chunks and resumes next run; calendar writes and AI
  reviews stop before the budget runs out and continue next hour.

## Build and test

```sh
npm install                      # dev deps: esbuild, web-push
node tools/build-automation.mjs  # → dist/forge-automation.mjs + dist/automation-version.json
node --test "tests/automation/*.test.mjs"
```

The build fails if an analytics/AI module it loads is missing (`--allow-missing` stubs them
for development only; the version file then lists them under `missing`). The bundle may import
only Node built-ins; the build checks this. `automation-version.json` carries
`{version, builtAt, sha256, bytes}` so the app can tell whether the installed bundle is current.

Tests are offline: temp vaults with encrypted demo data, a real git repo with a bare remote
(token-rotation ordering, rebase over concurrent app pushes), mocked WHOOP / Google / Anthropic
HTTP, a stub push sender, and a smoke test of the built bundle (`FORGE_TASK=ping`).
