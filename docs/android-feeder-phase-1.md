# StreamFeeder Android Phase 1 (Native Feed client)

## Architecture

Phase 1 ships a **native Android app** (Jetpack Compose) that talks to the same Cloudflare Worker Feed APIs as the website. It is not a Trusted Web Activity wrapper and does not include Live/Quad.

- Application ID: `com.heartlandwiwx.streamfeeder`
- Launcher name: StreamFeeder
- API base: `https://youtube-feeder-worker.ike-j-rebout.workers.dev`
- Auth: Custom Tab → `/api/auth/google?client=android` → deep link `streamfeeder://oauth/callback?token=…`
- API auth: `Authorization: Bearer <session token>` (same signed value as `yf_session`)
- Session cookie for the website is unchanged

## Features

- Sign in with Google (same account as the website)
- Inbox / Snoozed / Deleted / Watchlists
- Filter by category
- Open a video (YouTube)
- Delete, restore, snooze, unsnooze
- Add to an existing watchlist

## Reused APIs

`GET /api/me`, `GET /api/inbox`, `PATCH /api/inbox/:id`, `GET /api/categories`, `GET /api/watchlists`, `POST /api/watchlists/:id/items`, `POST /api/auth/logout`.

## Version

`public/android-version.json` is the single source for `versionName` / `versionCode`.
