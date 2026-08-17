# VortiQuest Android signing

All updates must use the **same** release key. Never commit `*.jks` / release keystores or passwords.

## Generate the release key once

```bash
keytool -genkeypair -v -keystore streamfeeder-release.jks -alias streamfeeder -keyalg RSA -keysize 2048 -validity 10000
```

Store `streamfeeder-release.jks` offline (encrypted disk / password manager). Losing it means users cannot update the installed APK in place.

## GitHub Actions secrets

1. Base64 the keystore (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("streamfeeder-release.jks")) | Set-Clipboard
```

2. Add repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The workflow writes the keystore to `$RUNNER_TEMP` only, then deletes it.

## SHA-256 fingerprint for Digital Asset Links

```bash
keytool -list -v -keystore streamfeeder-release.jks -alias streamfeeder
```

Copy the SHA-256 line. Also capture the debug keystore:

```bash
keytool -list -v -keystore android/debug.keystore -alias androiddebugkey -storepass android
```

Put both in `worker/android/fingerprints.json`:

```json
[
  { "label": "debug", "sha256": "AA:BB:..." },
  { "label": "release", "sha256": "CC:DD:..." }
]
```

Redeploy the Worker so `https://youtube-feeder-worker.ike-j-rebout.workers.dev/.well-known/assetlinks.json` lists them.

Until fingerprints are published and Google’s statement list crawls the origin, Android may open a Custom Tab with a URL bar instead of a chrome-less TWA. That is a verification failure, not a WebView.

## Verify an APK

```bash
apksigner verify --print-certs StreamFeeder.apk
```
