# AI API (js/ai/*)

Works in browser and Node (global `fetch`). All functions take `ai` = `{ apiKey, model, fastModel, effort, webLookup, fetchImpl? }` (from settings `integrations.ai` + the device-stored key) and return plain objects. Errors are thrown as `AIError { code: 'no-key'|'auth'|'rate-limit'|'overloaded'|'bad-request'|'network'|'parse'|'refused'|'aborted', message, retryAfter? }`.

Import everything from `js/ai/index.js`. Build `ai` with `makeAiConfig(store.setting('integrations').ai, apiKey, extra?)`.

**Optional `ai` fields (added):** `stream` (default `true`: responses are streamed over SSE and assembled, so long thinking/web-search calls never sit on an idle connection), `timeoutMs` (default 300000, whole request), `maxRetries` (3), `retryBaseMs` (1000), `maxRetryWaitMs` (60000; a longer `retry-after` fails fast with `retryAfter` set).

**AIError (added detail):** `retryAfter` is in seconds. Also `status` (HTTP), `type` (Anthropic error type), `requestId`, and a `retryable` getter (true for `rate-limit`, `overloaded`, `network`). `aborted` is new: the caller's `AbortSignal` fired; the UI should treat it as silent. Mapping: 401/403 → `auth`; 429 → `rate-limit`; 529 and 5xx → `overloaded`; 408/timeouts/unreachable → `network`; 400/404/413 → `bad-request` (message includes the API's reason); unparseable output or cut-off JSON → `parse`; `stop_reason: 'refusal'` → `refused`.

**Every result (added):** besides `model` and `costUsd`, results carry `costEstimated` (true when an unknown model was priced at Sonnet rates) and `usage` (Anthropic usage summed over all calls made).

**Progress (added):** every function accepts `signal` (AbortSignal) and `onProgress(event)`; events are `{ phase: 'thinking' | 'searching' (with `query` once known) | 'searched' | 'writing' | 'tool' (with `name`) | 'continuing' }`. Callback errors are swallowed.

## claude.js
`callClaude(ai, { system, messages, tools, toolChoice, outputFormat, maxTokens=2048, model, thinking, effort, signal })` → `{ content, stopReason, usage, costUsd, model }`
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`, and in browsers `anthropic-dangerous-direct-browser-access: true`.
- Never sends `temperature`/`top_p`/`top_k` (Sonnet 5 rejects non-defaults). Forced `tool_choice` is only used with `thinking: {type:'disabled'}`.
- `outputFormat` maps to `output_config.format` (`{type:'json_schema', schema}`); `effort` maps to `output_config.effort`.
- Handles `stop_reason: 'pause_turn'` by resending the assistant turn (max 4 loops). Retries 429/529/5xx with backoff (max 3), honoring `retry-after`.
- `costUsd` from `pricing.js` (input, output, cache, web searches × $0.01).

Added detail:
- Extra opts: `stream`, `onProgress`. Extra result fields: `costEstimated`, `requestId`. `content` holds every block across `pause_turn` continuations, in order.
- `thinking`: omit for the model default (adaptive on Sonnet 5 / Opus 5.5, off on Haiku), `false` or `{type:'disabled'}` to disable. A forced `toolChoice` (`any`/`tool`) sets thinking disabled automatically; on Opus 5.x (which rejects forced tool use) it is downgraded to `{type:'auto'}` instead.
- `effort` defaults to `ai.effort`; it is not sent to Haiku / legacy models, and a 400 that mentions effort is retried once without it. `effort: null` sends none.
- One retry for network failures (not for timeouts). Requests over 32 MB are rejected locally (`bad-request`, status 413).
- `callClaudeJson(ai, opts)` → `{ data, res }` (structured-output parse; `max_tokens` cut → `parse`). `verifyKey(ai)` → `{ ok, model, latencyMs, costUsd }` (1-token request to `fastModel`; use for the Settings "test key" button). Helpers: `textOf`, `findToolUse`, `parseJsonText`, `buildRequest`, `modelCaps`.

## image.js (browser helpers; pure parts testable in Node)
`readExifDate(bytes)` → ISO local string `YYYY-MM-DDTHH:MM:SS` or null (JPEG APP1 DateTimeOriginal / DateTime). `timeFromFilename(name)` → ISO local string or null (e.g. `meal_2026-09-26_12-34-05.jpg`, `IMG_20260926_123405.jpg`, `20260926T123405-0400.jpg`). `prepareImage(file|blob, {maxEdge=1280, quality=0.82})` → `{ bytes (JPEG Uint8Array), mediaType:'image/jpeg', width, height }` (browser only; canvas; respects EXIF orientation via createImageBitmap). `makeThumb(file|blob, {maxEdge=480})` → same shape.

Added detail:
- `readExifDate` accepts Uint8Array/ArrayBuffer/views/arrays, tries DateTimeOriginal → DateTimeDigitized → DateTime, both byte orders, bare TIFF, and "Exif\0\0"-embedded blocks (HEIC/WebP). Never throws.
- `timeFromFilename` also handles `PXL_…`, `Screenshot 2026-09-26 at 9.05.12 PM.png`, `WhatsApp Image 2026-09-26 at 12.34.05.jpeg`, `Screenshot_20260926-123405.png`, missing seconds (→ `:00`). A trailing offset is ignored.
- `preparePhoto(file, {maxEdge, quality})` → `{ bytes, data (base64), mediaType, width, height, takenAt, takenAtSource: 'exif'|'filename'|null }` — the whole snap/library pipeline in one call. Read EXIF before resizing (canvas output has no EXIF); `preparePhoto` does this.
- `prepareImage` throws `AIError('bad-request')` when the image cannot be decoded (e.g. HEIC outside Safari) or no canvas exists (Node). For lab-report photos use `{ maxEdge: 1568, quality: 0.9 }`.

## meal.js
`analyzeMeal(ai, { image:{data (base64), mediaType}, note, at, date, rules:[text], recentFoods:[name], profile:{weightLb, goal} })` →
```js
{ items: FoodItem[], totals: Nutrients, confidence: 'low'|'medium'|'high', title, assumptions: [string], followUp: string|null,
  searched: boolean, sources: [{title, url}], model, costUsd, usage }
```
Uses `tools: [web_search (if ai.webLookup; type 'web_search_20250305', max_uses 3), record_meal (strict: true)]`, `tool_choice: auto`; if the model ends without calling `record_meal`, a second call with the transcript and thinking disabled forces `tool_choice: {type:'tool', name:'record_meal'}`. `analyzeMealText(ai, { text, at, date, ... })` → same shape, from a text description only (quick add).

Added detail:
- Extra inputs: `images:[{data, mediaType}]` (up to 6, e.g. plate + package label; `data:` URLs accepted; JPEG/PNG/GIF/WebP), `answers:[{q, a}]` (answers to earlier `followUp` questions, treated as ground truth), `webSearch` (false to skip web search for this call; for `analyzeMealText`, true/false overrides brand detection), `model`, `signal`, `onProgress`. `recentFoods` may mix names and saved-food records (`{name, totals, items}` from `foods`); records with totals let the model use basis `'saved'`.
- Extra outputs: `reference` (scale reference used, or null), `fallback` (true when the forced second call was needed), `costEstimated`.
- Guarantees: `totals` are summed in code from `items` (never from the model); every item has all 14 nutrients as non-negative numbers rounded per `NUTRIENT_DP` (kcal/mg/IU whole, grams 0.1, iron/vitC 0.1), `grams` whole. Enums are lowercased. `basis: 'web'` is downgraded to `'estimate'` when no search ran, `'saved'` likewise when no saved foods were given. Overall `confidence` never exceeds the calorie-weighted item confidence; an empty `items` list means no food was found (`confidence: 'low'`, `followUp` asks what was eaten). `assumptions[0]` is `"Scale reference: …"` when one was used.
- `analyzeMealText` includes web search only when `ai.webLookup` and `mentionsBrand(text + note)` (brand/restaurant list, "from/at X", ®/™, possessive names like "Wendy's").
- The fallback on Opus 5.5 runs on `claude-sonnet-5` (Opus rejects forced tool use).
- Helpers: `mealTotals(items)`, `scaleFoodItem(item, grams)` (for portion edits in the UI), `normalizeFoodItem(item)`, `mentionsBrand(text)`, `NUTRIENT_DP`.

## labs.js
`extractLabs(ai, { files:[{ data (base64), mediaType: 'application/pdf'|'image/jpeg'|'image/png' }], note })` → `{ collectedAt: 'YYYY-MM-DD'|null, lab: string|null, markers:[{ name, value, unit, refLow, refHigh, flag }], notes:[string], model, costUsd }` via `output_config.format` JSON schema. Markers keep the report's own names; the caller normalizes keys with `analytics/labs.normalizeMarkerName`.
`interpretLabs(ai, { panel, history, protocols })` → `{ summary, items:[{ key, name, status, text }], askDoctor:[string], model, costUsd }` — educational; flags out-of-range values for physician review; never recommends dosing changes.

Added detail:
- `extractLabs`: up to 20 files (GIF/WebP images also accepted), all sent in one request with thinking disabled. The model transcribes `valueText`/`rangeText`/printed flag verbatim; code parses them. Each marker also carries `note` (string|null), `valueText`, `rangeText`, `section` (string|null).
  - `value`: number, or null for qualitative results ("Negative", titers). `"<0.5"` → `0.5` with note `Reported as "<0.5"; stored as 0.5 (actual value is lower).`; `">90"` likewise; `"1,234"` → 1234.
  - `refLow`/`refHigh`: `"30-100"` → 30/100, `"<150"`/`"< OR = 150"`/`"150 or less"` → null/150, `">39"`/`"> OR = 40"` → 39|40/null, en-dashes and thousands separators handled; null when open or non-numeric.
  - `flag`: `'high'|'low'|'abnormal'|null` — the printed flag (H/L/A/*/CRIT…) when present, else computed from value vs range (censored values handled). Critical flags add "Marked critical on the report." to `note`.
  - `collectedAt` accepts ISO, US `M/D/YYYY`, and month-name dates. Duplicate rows are dropped.
- `interpretLabs` inputs: `panel` = a `labs` record; `history` = older `labs` records (the panel itself is skipped; up to 4 prior values per marker are shown); `protocols` = `protocolItems` records (the `name` is sent — pass `neutralLabel` as `name` to hide it); optional `note`. `status` ∈ `normal|borderline|high|low|abnormal|unknown`. Guarantee: every marker outside its printed range appears in `items` with that status (added in code if the model omitted it, overriding a milder label) and is named in `askDoctor`.
- Helpers: `parseLabValue`, `parseRefRange`, `normalizeLabFlag`, `normalizeLabDate`, `markerOutOfRange`.

## reviews.js
`nutritionReview(ai, { date, meals, totals, targets, rules, training, bodyTrend, protocolNotes })` → `{ score (0–100), headline, wins:[string], gaps:[string], tomorrow:[string], flags:[string], model, costUsd }`.
`weeklyReview(ai, { stats, drivers, goals, lastFocus })` → `{ headline, summary, whatWorked:[string], whatDidnt:[string], focus: { title, why, how:[string] }, model, costUsd }`.
`morningBrief(ai, { readiness, plan, events, nutritionTargets })` → `{ text, model, costUsd }` (≤ 90 words).

Added detail:
- `nutritionReview`: `meals` are `meals` records (tombstoned ones skipped); `totals` optional (summed from meals); `targets` = `calorieTargets()` shape (`kcal, proteinG, fatG, carbsG, fiberG`). Percent-of-target and deltas are computed in code and given to the model; the model applies a fixed rubric (kcal 35, protein 35, fiber/quality 15, rules/timing 15). `score` is an integer clamped to 0–100 (null if missing); lists capped at 3 (`flags` 5). Also exported as `reviewNutritionDay` (ARCHITECTURE §10 name).
- `weeklyReview`: `stats` = `weekStats()` output (required), `drivers` = `findDrivers()` output (or strings), `goals` string|object, `lastFocus` `{title, why, how}`|string. Lists capped at 4.
- `morningBrief`: optional `date`; `readiness` = `readiness()` output, `plan` = plan blocks, `events` = calendar events. Uses `ai.fastModel` (Haiku 4.5 default) with thinking disabled; markdown is stripped and the 90-word cap is enforced in code.

## ask.js
`askForge(ai, { question, contextPack, history:[{role, content}] })` → `{ answer (markdown), model, costUsd }`.

Added detail: optional `today` ('YYYY-MM-DD'). `history` may contain any turns; they are cleaned into alternating user/assistant turns (last 20, leading assistant turns dropped, consecutive same-role turns merged). A context pack ≥ 6,000 characters gets a prompt-cache breakpoint, so follow-ups within ~5 minutes pay the cache-read price for it.

## prompts.js / schemas.js / pricing.js
System prompts and JSON schemas live here. Guardrails in every system prompt: not medical advice; never recommend starting, stopping or changing the dose of any medication, peptide or supplement; flag concerning values for a physician; state uncertainty; no moralizing.

Added detail: `GUARDRAILS` and `STYLE` (direct, analytical, no filler/emojis) are appended to every system prompt. Schemas have no optional or union properties (unknown strings are `""`, negligible nutrients `0`); `schemaReport(schema)` checks the structured-output limits. `pricing.js`: `PRICES`, `priceFor`, `costOf(model, usage)` → `{usd, estimate, searches}`, `costUsd`, `addUsage`, `imageTokens(w, h)`, `estimateCost(model, {inputTokens, outputTokens, searches})`.

## Models, cost and latency (for the UI)
| Function | Model | Typical latency | Typical cost |
|---|---|---|---|
| `analyzeMeal` | `ai.model` (adaptive thinking) | 10–40 s; +5–15 s per web search; fallback adds 5–15 s | $0.02–0.06; each search adds ≈ $0.02–0.05 (fee + result tokens) |
| `analyzeMealText` | `ai.model` | 5–20 s | $0.01–0.04 |
| `extractLabs` | `ai.model`, thinking off | 15–60 s (multi-page PDFs) | $0.03–0.15 |
| `interpretLabs`, `nutritionReview`, `weeklyReview`, `askForge` | `ai.model` | 10–40 s | $0.01–0.06 |
| `morningBrief` | `ai.fastModel`, thinking off | 2–5 s | < $0.002 |

Estimates, not measurements: thinking tokens bill as output, and actual `costUsd` is always computed from the returned usage.

UI notes: show `onProgress` phases as a status line ("Thinking…", "Searching: <query>", "Writing…"); offer Cancel via `AbortSignal` and ignore `aborted` errors. Show `followUp` (when non-null) as a one-line question under the estimate with a short answer box; on submit call `analyzeMeal` again with the same image(s) and `answers: [...previousAnswers, { q: followUp, a }]`. For item edits without AI use `scaleFoodItem` + `mealTotals`. Show `retryAfter` on `rate-limit` errors, and "Check key in Settings" on `auth`/`no-key`.
