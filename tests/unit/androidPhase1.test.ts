import { describe, expect, it } from 'vitest';
import { ANDROID_DOWNLOAD_PATH, STABLE_APK_URL, STREAMFEEDER_DISPLAY_NAME, STREAMFEEDER_PACKAGE_ID, TEST_APK_PATH } from '../../src/lib/androidRelease';
import { digitalAssetLinks, normalizeSha256Fingerprint } from '../../worker/android/assetlinks';
import { ANDROID_OAUTH_REDIRECT, oauthClientFromState } from '../../worker/auth/session';
import { signValue, verifySignedValue } from '../../worker/auth/crypto';
import version from '../../public/android-version.json';

describe('VortiQuest Android phase 1', () => {
	it('uses the VortiQuest display name while keeping historical APK filenames', () => {
		expect(STREAMFEEDER_DISPLAY_NAME).toBe('VortiQuest');
	});

	it('uses the stable GitHub APK URL', () => {
		expect(STABLE_APK_URL).toBe(
			'https://github.com/NonProfitNerdHerd/YouTubeFeeder/releases/latest/download/StreamFeeder.apk',
		);
		expect(ANDROID_DOWNLOAD_PATH).toBe('/download/android');
		expect(TEST_APK_PATH).toBe('/StreamFeeder-debug.apk');
	});

	it('keeps package id StreamFeeder without YouTube branding', () => {
		expect(STREAMFEEDER_PACKAGE_ID).toBe('com.heartlandwiwx.streamfeeder');
		expect(STREAMFEEDER_PACKAGE_ID.toLowerCase()).not.toContain('youtube');
		expect(STREAMFEEDER_PACKAGE_ID.toLowerCase()).not.toContain('yt');
	});

	it('normalizes signing fingerprints for Digital Asset Links', () => {
		const fp = normalizeSha256Fingerprint('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');
		expect(fp).toBe('AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99');
		const links = digitalAssetLinks(STREAMFEEDER_PACKAGE_ID, [{ label: 'debug', sha256: fp! }]);
		expect(links[0].target.package_name).toBe(STREAMFEEDER_PACKAGE_ID);
		expect(links[0].relation).toContain('delegate_permission/common.handle_all_urls');
		expect(digitalAssetLinks(STREAMFEEDER_PACKAGE_ID, [])).toEqual([]);
	});

	it('shares one version source', () => {
		expect(version.versionName).toBe('1.0.19');
		expect(version.versionCode).toBe(20);
	});

	it('supports native Android OAuth return and Bearer sessions', async () => {
		expect(ANDROID_OAUTH_REDIRECT).toBe('streamfeeder://oauth/callback');
		expect(oauthClientFromState('login.android.abc')).toBe('android');
		expect(oauthClientFromState('login.xyz')).toBe('web');
		const secret = 'unit-test-session-secret-0123456789';
		const token = await signValue(secret, `user-1.${Date.now()}`);
		const verified = await verifySignedValue(secret, token);
		expect(verified?.startsWith('user-1.')).toBe(true);
		const req = new Request('https://example.test/api/me', {
			headers: { Authorization: `Bearer ${token}` },
		});
		const { readSessionUserId } = await import('../../worker/auth/session');
		expect(await readSessionUserId(secret, req)).toBe('user-1');
	});
});
