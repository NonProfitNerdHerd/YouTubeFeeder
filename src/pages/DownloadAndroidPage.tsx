import { useEffect, useState } from 'react';
import { GITHUB_LATEST_RELEASE_API, STABLE_APK_URL, STREAMFEEDER_DISPLAY_NAME, TEST_APK_PATH } from '../lib/androidRelease';
import { qrSvgForUrl } from '../lib/qrSvg';
import '../styles/download.css';

interface VersionFile {
	versionName: string;
	versionCode: number;
}

export function DownloadAndroidPage() {
	const [version, setVersion] = useState<VersionFile | null>(null);
	const [released, setReleased] = useState<boolean | null>(null);
	const [qr, setQr] = useState<string>('');
	const [releaseName, setReleaseName] = useState<string | null>(null);
	const apkUrl = typeof window !== 'undefined' ? `${window.location.origin}${TEST_APK_PATH}` : TEST_APK_PATH;

	useEffect(() => {
		void (async () => {
			const [verRes, relRes, svg] = await Promise.all([
				fetch('/android-version.json'),
				fetch(GITHUB_LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } }),
				qrSvgForUrl(`${window.location.origin}${TEST_APK_PATH}`),
			]);
			if (verRes.ok) setVersion((await verRes.json()) as VersionFile);
			setQr(svg);
			if (!relRes.ok) {
				setReleased(false);
				return;
			}
			const body = (await relRes.json()) as { tag_name?: string; assets?: Array<{ name: string }> };
			const hasApk = (body.assets ?? []).some((a) => a.name === 'StreamFeeder.apk');
			setReleaseName(body.tag_name ?? null);
			setReleased(hasApk);
		})();
	}, []);

	return (
		<main className="download-android">
			<img className="download-icon" src="/icons/icon-192.png" alt="" width={96} height={96} />
			<h1>{STREAMFEEDER_DISPLAY_NAME}</h1>
			<p className="muted">Phase 1 Android app: feeder inbox and watchlists. Same account as the website. Live/Quad is not included yet.</p>
			{version ? (
				<p>
					App version {version.versionName} (build {version.versionCode})
					{releaseName && released ? ` · GitHub ${releaseName}` : ' · debug sideload build'}
				</p>
			) : null}
			<p>
				<a className="primary" href={TEST_APK_PATH}>
					Download APK
				</a>
			</p>
			<div className="download-qr" dangerouslySetInnerHTML={{ __html: qr }} />
			<p>
				Direct link: <a href={TEST_APK_PATH}>{apkUrl}</a>
			</p>
			{released ? (
				<p className="muted">
					Signed GitHub release:{' '}
					<a href={STABLE_APK_URL}>{STABLE_APK_URL}</a>
				</p>
			) : (
				<p className="download-warn">This is a debug test build for sideloading. It is not the signed Play/GitHub StreamFeeder.apk.</p>
			)}
			<h2>Install</h2>
			<ol>
				<li>Scan the QR code or tap Download APK on your Android phone.</li>
				<li>Allow installing unknown apps for your browser or Files app if Android asks.</li>
				<li>Open StreamFeeder-debug.apk and install.</li>
				<li>Sign in with the same Google account you use on the website.</li>
			</ol>
			<h2>Same-account sync</h2>
			<p>
				Inbox hides, restores, and watchlists live in the production database. Changes on the phone show on the web after refresh, and the reverse.
				Refreshing the inbox loads saved data; it does not call YouTube until you use Sync now on the website.
			</p>
			<h2>Updates</h2>
			<p>Return here and download the APK again. Debug builds may require uninstalling first if the signing certificate changed.</p>
		</main>
	);
}
