# FORGE — setup and integrations

The app walks you through each step on screen (Setup, then Settings → Integrations / AI / Automation). This page is the reference: the order that works, and the iPhone Shortcuts.

Do the first setup on the laptop. The phone joins afterwards with the same passphrase.

## 1. Vault token (laptop)

The Connect screen has a **pre-filled token link**. On GitHub: Repository access → *Only select repositories* → your private vault repo. Permissions: **Contents**, **Actions**, **Secrets**, **Workflows**: Read and write (Metadata: read is automatic). Expiration: 1 year — set a reminder to renew it (Settings → Sync → replace token).

The token is stored on the device encrypted with the vault key. Anyone holding it can change the vault repository, so never paste it anywhere else.

## 2. First run (laptop)

1. Open the app → **Set up** → paste the token → the app refuses a public repository.
2. **Passphrase**: use *Suggest one* (≈100 bits) and save it in your password manager. It cannot be reset.
3. **Recovery key**: save it in your password manager and keep a printed copy offline. It is shown once (Settings → Security can create a new one with your passphrase).
4. **Import from FORGE v2** (optional): in the old app use *Export backup* to get `forge-data.json`, then choose it here. Standards, history, finance snapshots, saved quotes and notes come across; duplicates of the built-in standards are switched off (re-enable in Settings → Standards).
5. **Automation**: *Install and test*. This writes the workflow and bundle into the vault and runs a connection test (about a minute).
6. **Profile**: height, birth year, starting weight, goal range, time zone.

## 3. AI (Settings → AI)

Paste an Anthropic API key (console.anthropic.com → API keys) and press **Test**. It is stored encrypted on this device only; add it on each device. *Server reviews* (nightly nutrition review, Monday weekly review) additionally stores the key as an encrypted GitHub Actions secret.

## 4. WHOOP (Settings → Integrations, from the laptop)

1. developer-dashboard.whoop.com → create an app, all read scopes + offline.
2. Redirect URL: copy it from the screen (`…/forge/callback.html`).
3. Paste client ID and secret → **Save to vault secrets** → **Connect WHOOP**.
Connect from the laptop: in the iPhone Home Screen app the WHOOP sign-in opens in Safari and cannot hand the result back. The connection lives in the vault, so it covers every device. History imports automatically; new data arrives hourly.

## 5. Google Calendar (Settings → Integrations)

A service account reads your calendars and writes a separate **FORGE** calendar (plan blocks + reminders) — no OAuth screen, runs hourly on GitHub.
1. console.cloud.google.com → new project → enable **Google Calendar API** → IAM → Service accounts → create → Keys → Add key → JSON.
2. Paste the JSON → **Save**. The screen shows the service-account email.
3. Google Calendar → your calendar → *Share with specific people* → the service-account email → **See all event details**. Add its calendar ID (usually your email) under *Calendars to read*.
4. Create a calendar named **FORGE**, share it with the service account → **Make changes to events**, paste its calendar ID (Settings of that calendar → *Integrate calendar*).
5. **Sync now**. Protocol reminders use the neutral label ("Protocol"); plan block titles are sent as written.

## 6. iPhone

1. Safari → the app URL → Share → **Add to Home Screen** → open FORGE from the icon (notifications only work there).
2. Connect with a token (the same one, or a second one with the same permissions) → **Unlock** with the passphrase.
3. Settings → Integrations → **Enable on this device** → **Send test from server**.
4. Settings → AI → paste the Anthropic key (per device).

## 7. Meals

- **Snap** (Fuel or Today → Meal): the photo is analyzed immediately; the time is the capture time.
- **Photos**: pick from the library; times come from the photo when iOS keeps it, otherwise confirm them.
- **Batch via Shortcut** (for photographing quickly and uploading later): Shortcut *FORGE meal* = **Take Photo** → **Format Date** (Current Date, custom `yyyy-MM-dd_HH-mm-ss`) → **Set Name** of the photo to `meal_<Formatted Date>.jpg` → **Save File** to iCloud Drive `FORGE/Meals` (*Ask Where to Save* off). Later: Fuel → **Files** → select the photos; times are read from the names.
- Your own nutrition rules (Settings → Nutrition) are applied to every analysis and the daily review.

## 8. Apple Health (optional; WHOOP is primary)

Shortcut *FORGE Health*:
1. **Find Health Samples** — Steps, start date *in the last 7 days*, **Group by Day**. Repeat for Resting Heart Rate, Heart Rate Variability, Active Energy and Weight (one action each).
2. **Text**, typing this and inserting each result's *Start Date* and *Value* (tap the variable → choose the property):
   `{"steps":{"dates":"[Steps › Start Date]","values":"[Steps › Value]"},"restingHr":{"dates":"[…]","values":"[…]"},"hrv":{"dates":"[…]","values":"[…]"},"activeKcal":{"dates":"[…]","values":"[…]"},"weight":{"dates":"[…]","values":"[…]","unit":"lb"}}`
3. **Copy to Clipboard**. Then FORGE → More → Import → **Apple Health** → Paste → Import.

## 9. Protocols and labs

- Protocols: add each supplement with its stack (AM/PM) and the peptide with its schedule days, amount per dose, weekly target and neutral label. Log from Today (stack tiles, dose tile).
- Labs: Labs → Add panel → upload the PDF or screenshots → review every row → save. Out-of-range values are flagged for your physician; FORGE never suggests dose changes.

## Security notes

- Everything in the vault is AES-256-GCM encrypted on your devices; the app code is public, your data is not.
- Do **not** publish other GitHub Pages sites from the same account: they would share the app's web origin.
- What leaves the vault: meal photos, lab files and summaries sent to Anthropic's API for analysis; plan block titles and neutral reminder labels in Google Calendar; push notifications (end-to-end encrypted to your devices, lock-screen text kept neutral).
- Lost device: Settings → Security → *Forget this device* on it if you can; revoke its token on GitHub; change the passphrase.
- The automation bundle's checksum is pinned in the workflow; updating it from Settings → Automation re-pins it.
