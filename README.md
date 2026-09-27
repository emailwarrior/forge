# FORGE

A private performance system: schedule, training, nutrition, recovery, protocols, bloodwork and finances in one place, with analytics built from what was actually done each day.

This repository is the **app code only** (a static PWA served by GitHub Pages). It contains no personal data. All data lives in a separate **private** repository (the vault), end-to-end encrypted on the device with AES-256-GCM; the vault key is wrapped by a passphrase (PBKDF2-SHA256, 600k rounds) and a recovery key. Hourly automation (WHOOP, Google Calendar, push notifications, optional server-side reviews) runs as a GitHub Actions workflow inside the vault.

- Architecture and data contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Setup and integrations: [docs/SETUP.md](docs/SETUP.md)
- UI conventions: [docs/UI_GUIDE.md](docs/UI_GUIDE.md) · Analytics: [docs/ANALYTICS_API.md](docs/ANALYTICS_API.md) · AI: [docs/AI_API.md](docs/AI_API.md)

## Development

No build step for the app (Preact + htm are vendored). Node 20+ for tools and tests.

```sh
npm install                 # dev tools only (esbuild, web-push) for the automation bundle
npm test                    # unit + integration tests
npm run serve               # http://localhost:8123/forge/?demo=1  (synthetic data)  ·  ?demo=empty
npm run e2e                 # browser end-to-end: setup, sync, lock, two devices, offline (mock GitHub + Anthropic)
npm run build:automation    # dist/forge-automation.mjs + dist/automation-version.json
npm run build:sw            # stamp sw.js with the content version + precache list (run before every deploy)
```
