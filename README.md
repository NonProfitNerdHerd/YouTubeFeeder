# VortiQuest

Personal YouTube inbox, live-stream grid, and Android client. The GitHub repo (`YouTubeFeeder`) and Worker (`youtube-feeder-worker`) names are historical; the product is **VortiQuest**.

Production: [https://youtube-feeder-worker.ike-j-rebout.workers.dev](https://youtube-feeder-worker.ike-j-rebout.workers.dev)

## What it does

- **Inbox** — per-user subscriptions, categories, snooze, watchlists, and catch-up. Uploads arrive through YouTube WebSub, then one API-key `videos.list` (batches of 50) fans out into each follower’s inbox in D1. Membership is `channel_prefs(user_id, channel_id)`, not the old global `channels.subscribed` flag.
- **Live / Quad** — a separate 12-slot live grid with its own refresh path. It shares the Worker and D1 but not the feed playlist poll.
- **Android** — native Feed client (`com.heartlandwiwx.streamfeeder`) against the same Worker APIs. Sideload and signing notes live under `docs/`.

Scheduled work is bounded (Workers Free: 50 external fetches per invocation). Hub subscribe is queued at 20 POSTs per cron tick. A unique-channel reconciliation sweep is a safety net for missed WebSub notifications, not a per-user playlist cron.

## Stack

Single [Cloudflare Worker](https://developers.cloudflare.com/workers/) + one [D1](https://developers.cloudflare.com/d1/) database (`youtube-feeder`). React/Vite UI is served as Worker assets. Google OAuth (web + Android) stores a refresh token per user.

## Local development

```
npm install
copy .dev.vars.example .dev.vars
npm run dev
```

`npm run dev` is Vite with the Cloudflare plugin. Apply D1 migrations locally with:

```
npx wrangler d1 migrations apply youtube-feeder --local
```

## Secrets and config

Never put YouTube or Google secrets in Vite/`VITE_*` files.

| Name | Where | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Worker secrets / `.dev.vars` | OAuth |
| `GOOGLE_REDIRECT_URI` | optional | Defaults to `{origin}/api/auth/google/callback` |
| `SESSION_SECRET` | secret | Sessions, WebSub `hub.secret`, and callback token |
| `TOKEN_ENCRYPTION_KEY` | secret | Encrypted Google refresh tokens |
| `YOUTUBE_API_KEY` | secret | Public `videos.list` / playlist metadata (same GCP project as OAuth) |
| `BRAVE_SEARCH_API_KEY` | secret | Brave Search API (Discover provider infra; not wired to UI until Phase 3) |
| `PUBLIC_ORIGIN` | `wrangler.jsonc` vars | Public Worker URL so Google’s hub can reach `/api/websub/callback` |
| `MOCK_DATA` | var | `"true"` only for local mock mode |
| `DISCOVER_SEARCH_PROVIDER` | var | `youtube` (default) or `brave` (Phase 3+) |
| `BRAVE_USER_DAILY_SOFT_CAP` / `BRAVE_GLOBAL_DAILY_SOFT_CAP` | vars | Soft caps on **actual Brave HTTP calls** (default 100 / 750) |

```
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put SESSION_SECRET
```

Quota buckets (general 10,000/day vs a separate `search.list` bucket) are documented in [docs/youtube-quota.md](docs/youtube-quota.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local Vite + Worker |
| `npm test` | Unit tests (Vitest) |
| `npm run check` | TypeScript |
| `npm run build` | Production UI + Worker bundle |
| `npm run deploy` | Build and `wrangler deploy` |
| `npx wrangler types` | Regenerate `Env` after binding changes |
| `npx wrangler d1 migrations apply youtube-feeder --remote` | Apply pending D1 migrations in production |

After changing bindings in `wrangler.jsonc`, run `npx wrangler types`.

## Deploy

```
npm run deploy
```

Cron is configured in `wrangler.jsonc` (UTC). Feed maintenance renews WebSub leases, retries pending events, bootstraps missing playlists on a small budget, and runs the unique-channel sweep. Quad refresh stays on its own `waitUntil` path.

## Android

- Phase 1 notes: [docs/android-feeder-phase-1.md](docs/android-feeder-phase-1.md)
- Signing: [docs/android-signing.md](docs/android-signing.md)
- GitHub releases: [docs/android-github-release.md](docs/android-github-release.md)
- Download page: `/download/android`

CI (`.github/workflows/android-release.yml`) runs tests, a web build, and a debug APK on pushes to `main`. Tags `android-v*` build a signed `StreamFeeder.apk` when signing secrets are present.
