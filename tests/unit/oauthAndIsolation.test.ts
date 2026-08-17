import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OAuth and Feed isolation audit', () => {
	it('does not add OAuth scopes', () => {
		const oauth = readFileSync(new URL('../../worker/auth/oauth.ts', import.meta.url), 'utf8');
		expect(oauth).toContain('openid');
		expect(oauth).toContain('youtube.readonly');
		expect(oauth).not.toContain('youtube.force-ssl');
		const scopes = oauth.match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) ?? [];
		expect([...new Set(scopes)].sort()).toEqual([
			'https://www.googleapis.com/auth/userinfo.email',
			'https://www.googleapis.com/auth/userinfo.profile',
			'https://www.googleapis.com/auth/youtube.readonly',
		]);
	});

	it('Feed sync never writes Quad tables', () => {
		const sync = readFileSync(new URL('../../worker/services/sync.ts', import.meta.url), 'utf8');
		for (const table of ['live_sources', 'live_source_videos', 'live_slots', 'live_layouts', 'live_quad_']) {
			expect(sync).not.toContain(table);
		}
	});

	it('Quad refresh never writes Feed tables', () => {
		const refresh = readFileSync(new URL('../../worker/services/quadRefresh.ts', import.meta.url), 'utf8');
		for (const table of ['inbox_state', 'watchlists', 'sync_runs', 'INSERT INTO videos', 'UPDATE videos', 'channel_prefs']) {
			expect(refresh).not.toContain(table);
		}
	});

	it('Quad migrations 0010-0012 do not alter Feed tables', () => {
		for (const file of ['0010_quad_live_status.sql', '0011_quad_settings.sql', '0012_quad_verify_state.sql']) {
			const sql = readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
			expect(sql).not.toMatch(/ALTER TABLE (videos|inbox_state|channels|settings|watchlists|categories|channel_prefs|sync_runs)/);
		}
	});

	it('wrangler still has a single Worker and single D1 database', () => {
		const wrangler = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
		expect(wrangler).toContain('"name": "youtube-feeder-worker"');
		expect(wrangler.match(/"database_id"/g)?.length).toBe(1);
		expect(wrangler).toContain('0 1,4,6,8,10,12,14,16,18,20,23 * * *');
	});

	it('scheduled handler no longer playlist-polls every user', () => {
		const index = readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
		expect(index).not.toContain('syncAllDueContent');
		expect(index).toContain('runFeedMaintenance');
	});
});
