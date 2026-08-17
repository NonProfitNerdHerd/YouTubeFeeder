# VortiQuest GitHub Release

Stable APK URL (do not change the filename):

https://github.com/NonProfitNerdHerd/YouTubeFeeder/releases/latest/download/StreamFeeder.apk

Download page:

https://youtube-feeder-worker.ike-j-rebout.workers.dev/download/android

## Workflow

`.github/workflows/android-release.yml`

- `workflow_dispatch`
- Tags `android-v*` (example `android-v1.0.0`)
- Permissions: `contents: write` only
- Runs `npm ci`, `npm test`, `npm run check`, `npm run build`
- Builds the Android APK with Gradle
- If signing secrets are present, verifies the signature, uploads `StreamFeeder.apk`, and (on version tags) creates a GitHub Release
- Deletes the temporary keystore from the runner

## Secrets (never commit)

See `docs/android-signing.md`.

## Version

`public/android-version.json` is the single source for `versionName` / `versionCode`. Bump `versionCode` for every Play-or-sideload update.

Until a signed GitHub `StreamFeeder.apk` exists, the download page and header QR serve the debug sideload at `/StreamFeeder-debug.apk` on the Worker. That file is the native Feed client (not a TWA).
