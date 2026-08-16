# StreamFeeder Android Phase 1 (Feeder only)

## Local repository

The production web app lives in this Windows checkout. Origin is `https://github.com/NonProfitNerdHerd/YouTubeFeeder.git`. Do not replace local source from the nearly empty historical `main` snapshot. Application source was present locally (including uncommitted feeder/Live work) before Android packaging.

## Architecture

Phase 1 packages the **deployed website** as an Android Trusted Web Activity (TWA) using Android Browser Helper. The APK does not contain a second frontend and does not talk to D1 or Google APIs itself.

- Application ID: `com.heartlandwiwx.streamfeeder`
- Launcher name: StreamFeeder
- Production start URL: `https://youtube-feeder-worker.ike-j-rebout.workers.dev/?source=android`
- Session cookie: `yf_session` (HttpOnly, SameSite=Lax, Secure on HTTPS, Path=/, 30-day Max-Age)
- OAuth: existing `/api/auth/google` → Google → `/api/auth/google/callback` in Chrome Custom Tabs / TWA, not a WebView

## Reused APIs

`GET /api/me`, `GET /api/inbox`, `PATCH /api/inbox/:id` (`delete`, `restore`, `snooze`, `unsnooze`, `notes`), `GET|POST /api/watchlists`, `PATCH|DELETE /api/watchlists/:id`, `POST /api/watchlists/:id/items`, `DELETE /api/watchlists/:id/items/:videoId`, `GET /api/channels`, `GET /api/categories`. Inbox refresh uses these database reads. YouTube Data API is not called unless the user uses website **Sync now** (hidden in the Android client chrome).

Read/unread is stored on inbox rows and shown in the list. There is no existing mark-read mutation; Phase 1 does not add one.

## Backend changes (justified)

- `/.well-known/assetlinks.json` served by the Worker (`run_worker_first` includes `/.well-known/*`).
- API JSON `Cache-Control: private, no-store` so authenticated inbox/watchlist payloads are not cached.
- Public download route `/download/android`, debug sideload `/StreamFeeder-debug.apk`, and PWA manifest / conservative service worker (static `/assets` and `/icons` only).
- No Feed D1 schema change. No Quad/Live behavior change.

## Mobile feeder

Android/`?source=android` hides Live/Quad chrome. Phone layout uses a list-or-detail split, Back to return, bottom Inbox / Watchlists / Refresh / Account. Destructive watchlist delete asks for confirmation. Failed inbox mutations restore the previous list.

## Validation still required on a device

OAuth in the APK, Digital Asset Links verification (needs a real SHA-256 in `worker/android/fingerprints.json`), and cross-device hide/restore/watchlist checks after a signed release exists.
