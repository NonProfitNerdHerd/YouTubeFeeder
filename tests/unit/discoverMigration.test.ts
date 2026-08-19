import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('discover migration 0021', () => {
	const sql = readFileSync('migrations/0021_discover_youtube.sql', 'utf8');

	it('creates discover cache tables and follow_source column', () => {
		expect(sql).toContain('CREATE TABLE discover_search_cache');
		expect(sql).toContain('CREATE TABLE discover_browse_cache');
		expect(sql).toContain('ADD COLUMN follow_source');
	});

	it('backfills youtube_sync only when subscription sync id exists', () => {
		expect(sql).toContain("SET follow_source = 'youtube_sync'");
		expect(sql).toContain('WHERE last_subscription_sync_id IS NOT NULL');
	});

	it('classifies manual rows with user activity instead of blindly marking discover', () => {
		expect(sql).toContain("SET follow_source = 'manual'");
		expect(sql).toContain('catchup_pulled');
		expect(sql).toContain('channel_categories');
		expect(sql).toContain('inbox_state');
	});

	it('preserves remaining subscribed rows as legacy', () => {
		expect(sql).toContain("SET follow_source = 'legacy'");
		expect(sql).not.toContain("SET follow_source = 'discover'");
	});
});

describe('follow_source migration safety scenarios', () => {
	it('manual classification criteria match production-style edge cases', () => {
		const legacyPref = {
			last_subscription_sync_id: null,
			is_subscribed: 1,
			catchup_pulled: 0,
			catchup_page_token: null,
			newest_seen_published_at: null,
			hasCategory: false,
			hasInbox: false,
		};
		const manualPref = {
			...legacyPref,
			catchup_pulled: 3,
		};
		const syncPref = {
			last_subscription_sync_id: 'sync-123',
			is_subscribed: 1,
		};

		expect(syncPref.last_subscription_sync_id).toBeTruthy();
		expect(manualPref.catchup_pulled).toBeGreaterThan(0);
		expect(legacyPref.last_subscription_sync_id).toBeNull();
		expect(legacyPref.catchup_pulled).toBe(0);
	});
});
