import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { discoverSearch } from '../../worker/services/discover';
import { followYoutubeChannel, unfollowYoutubeChannel } from '../../worker/services/discoverFollow';
import * as podcastIndex from '../../worker/services/discover/podcastIndex';
import {
	mapChannelSearchItems,
	normalizeDiscoverQuery,
	searchYoutubeChannels,
	searchYoutubeDiscover,
} from '../../worker/services/discover/youtube';
import { DISCOVER_SEARCH_DAILY_SOFT_CAP } from '../../worker/services/discoverQuota';
import { fanoutInbox } from '../../worker/services/websubProcess';
import type { YoutubeClient } from '../../worker/services/youtube';

const CHANNEL = 'UCxxxxxxxxxxxxxxxxxxxxxx';

function mockYt(handler: YoutubeClient['getJson']): YoutubeClient {
	const yt: YoutubeClient = {
		quotaUsed: 0,
		searchQueries: 0,
		calls: { search: 0, videos: 0, playlistItems: 0, channels: 0, subscriptions: 0, other: 0 },
		async getJson(path, params) {
			if (path === 'search') {
				yt.searchQueries += 1;
				yt.calls.search += 1;
			} else {
				yt.quotaUsed += 1;
				if (path === 'videos') yt.calls.videos += 1;
				else if (path === 'channels') yt.calls.channels += 1;
				else yt.calls.other += 1;
			}
			return handler(path, params);
		},
	};
	return yt;
}

describe('YouTube discover search', () => {
	it('normalizes query keys for cache lookup', () => {
		expect(normalizeDiscoverQuery('  Olbermann  ')).toBe('olbermann');
		expect(normalizeDiscoverQuery('Olbermann')).toBe('olbermann');
	});

	it('maps channel search items to DiscoveryResult', () => {
		const results = mapChannelSearchItems([
			{
				id: { channelId: CHANNEL },
				snippet: {
					title: 'Keith Olbermann',
					description: 'Sports and politics commentary',
					channelTitle: 'Keith Olbermann',
					thumbnails: { medium: { url: 'https://example.com/thumb.jpg' } },
				},
			},
		]);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			provider: 'youtube',
			type: 'channel',
			externalId: CHANNEL,
			title: 'Keith Olbermann',
		});
	});

	it('uses exactly one search.list call per uncached search', async () => {
		const yt = mockYt(async (path) => {
			if (path !== 'search') throw new Error(`unexpected:${path}`);
			return {
				items: [{ id: { channelId: CHANNEL }, snippet: { title: 'Keith Olbermann', thumbnails: {} } }],
			};
		});
		const { results } = await searchYoutubeChannels(yt, 'Olbermann');
		expect(results).toHaveLength(1);
		expect(yt.calls.search).toBe(1);
		expect(yt.searchQueries).toBe(1);
	});

	it('returns cached results with zero YouTube requests', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key' });
		const now = new Date('2026-08-19T12:00:00Z');
		const cacheKey = 'youtube:olbermann';
		await db.prepare(
			`INSERT INTO discover_search_cache (cache_key, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
		)
			.bind(
				cacheKey,
				JSON.stringify([
					{
						provider: 'youtube',
						type: 'channel',
						externalId: CHANNEL,
						title: 'Keith Olbermann',
					},
				]),
				now.toISOString(),
				new Date(now.getTime() + 60_000).toISOString(),
			)
			.run();

		const getJson = vi.fn();
		const result = await searchYoutubeDiscover(env, 'user-1', 'Olbermann', now);
		expect(getJson).not.toHaveBeenCalled();
		expect(result.cached).toBe(true);
		expect(result.results[0]?.title).toBe('Keith Olbermann');
	});

	it('isolates podcast failure from YouTube success', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', PODCAST_INDEX_KEY: 'pi-key' });
		vi.spyOn(podcastIndex, 'searchPodcastIndex').mockRejectedValue(new Error('podcast down'));
		await db.prepare(
			`INSERT INTO discover_search_cache (cache_key, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
		)
			.bind(
				'youtube:test',
				JSON.stringify([{ provider: 'youtube', type: 'channel', externalId: CHANNEL, title: 'Test' }]),
				new Date().toISOString(),
				new Date(Date.now() + 60_000).toISOString(),
			)
			.run();
		const body = await discoverSearch(env, 'user-1', 'test', 'all');
		expect(body.results.some((r) => r.provider === 'youtube')).toBe(true);
		expect(body.warnings.some((w) => w.provider === 'podcast')).toBe(true);
		vi.restoreAllMocks();
	});

	it('blocks uncached search when soft cap is reached', async () => {
		const db = new MemorySyncDb();
		const day = new Date().toISOString().slice(0, 10);
		await db.prepare(`INSERT INTO api_quota_daily (day, endpoint, call_count, general_units, search_calls) VALUES (?, ?, ?, ?, ?)`)
			.bind(day, 'search.list', DISCOVER_SEARCH_DAILY_SOFT_CAP, 0, DISCOVER_SEARCH_DAILY_SOFT_CAP)
			.run();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key' });
		const result = await searchYoutubeDiscover(env, 'user-1', 'Olbermann');
		expect(result.results).toHaveLength(0);
		expect(result.warning).toMatch(/quota/i);
	});
});

describe('Follow in VortiQuest', () => {
	it('creates discover follow without subscriptions.insert', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'key' });
		const result = await followYoutubeChannel(env, 'user-1', {
			channelId: CHANNEL,
			title: 'Keith Olbermann',
			description: 'Commentary',
			thumbnailUrl: 'https://example.com/a.jpg',
		});
		expect(result.created).toBe(true);
		const pref = [...db.prefs.values()].find((p) => p.channel_id === CHANNEL);
		expect(pref?.follow_source).toBe('discover');
		expect(pref?.newest_seen_published_at).toBeTruthy();
		expect(db.websub.has(CHANNEL)).toBe(true);
	});

	it('does not duplicate an already followed channel', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'key' });
		await followYoutubeChannel(env, 'user-1', { channelId: CHANNEL, title: 'Keith Olbermann' });
		const second = await followYoutubeChannel(env, 'user-1', { channelId: CHANNEL, title: 'Keith Olbermann' });
		expect(second.alreadyFollowing).toBe(true);
		expect([...db.prefs.values()].filter((p) => p.channel_id === CHANNEL)).toHaveLength(1);
	});

	it('unfollows a discover channel without affecting other users', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'key', PUBLIC_ORIGIN: 'https://example.com', SESSION_SECRET: 'secret' });
		await followYoutubeChannel(env, 'user-1', { channelId: CHANNEL, title: 'Keith Olbermann' });
		db.prefs.set(`user-2:${CHANNEL}`, {
			user_id: 'user-2',
			channel_id: CHANNEL,
			is_subscribed: 1,
			follow_source: 'discover',
		});
		const result = await unfollowYoutubeChannel(env, 'user-1', CHANNEL);
		expect(result.wasFollowing).toBe(true);
		expect(db.prefs.get(`user-1:${CHANNEL}`)?.is_subscribed).toBe(0);
		expect(db.prefs.get(`user-2:${CHANNEL}`)?.is_subscribed).toBe(1);
	});

	it('is idempotent when channel is not followed', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'key' });
		const result = await unfollowYoutubeChannel(env, 'user-1', CHANNEL);
		expect(result.wasFollowing).toBe(false);
	});

	it('preserves discover follows during YouTube subscription sync unsubscribe pass', async () => {
		const db = new MemorySyncDb();
		db.prefs.set('user-1:discover-ch', {
			user_id: 'user-1',
			channel_id: 'discover-ch',
			is_subscribed: 1,
			follow_source: 'discover',
			follow_in_inbox: 1,
		});
		db.prefs.set('user-1:sync-ch', {
			user_id: 'user-1',
			channel_id: 'sync-ch',
			is_subscribed: 1,
			follow_source: 'youtube_sync',
			last_subscription_sync_id: 'old-sync',
			follow_in_inbox: 1,
		});
		await db.prepare(
			`UPDATE channel_prefs SET is_subscribed = 0, unsubscribed_at = ? WHERE user_id = ? AND is_subscribed = 1 AND follow_source = 'youtube_sync' AND (last_subscription_sync_id IS NULL OR last_subscription_sync_id != ?)`,
		)
			.bind(new Date().toISOString(), 'user-1', 'new-sync')
			.run();
		expect(db.prefs.get('user-1:discover-ch')?.is_subscribed).toBe(1);
		expect(db.prefs.get('user-1:sync-ch')?.is_subscribed).toBe(0);
	});
});

describe('Feed protection after discover follow', () => {
	it('does not fan out historical uploads when watermark is set', async () => {
		const db = new MemorySyncDb();
		const watermark = '2026-08-19T12:00:00.000Z';
		db.prefs.set('user-1:ch', {
			user_id: 'user-1',
			channel_id: CHANNEL,
			is_subscribed: 1,
			follow_in_inbox: 1,
			follow_source: 'discover',
			newest_seen_published_at: watermark,
		});
		db.videos.set('old-video', {
			video_id: 'old-video',
			channel_id: CHANNEL,
			published_at: '2026-08-01T00:00:00.000Z',
		});
		db.videos.set('new-video', {
			video_id: 'new-video',
			channel_id: CHANNEL,
			published_at: '2026-08-20T00:00:00.000Z',
		});
		await fanoutInbox(db as unknown as D1Database, 'old-video', CHANNEL);
		await fanoutInbox(db as unknown as D1Database, 'new-video', CHANNEL);
		expect(db.inbox.has('user-1:old-video')).toBe(false);
		expect(db.inbox.has('user-1:new-video')).toBe(true);
	});
});

describe('Discover UI wiring', () => {
	it('DiscoverPage uses submit-only search and follow actions', () => {
		const source = readFileSync('src/pages/DiscoverPage.tsx', 'utf8');
		expect(source).toContain('/api/discover/search?');
		expect(source).toContain('onSubmit');
		expect(source).not.toMatch(/onChange=\{[^}]*runSearch/);
		expect(source).toContain('Follow in VortiQuest');
		expect(source).not.toContain('Follow channel');
		expect(source).toContain('discover-shell');
		expect(source).toContain('discover-scroll');
		expect(source).toContain('/api/discover/follow/youtube');
		expect(source).toContain('/api/discover/unfollow/youtube');
		expect(source).toContain('Unfollow in VortiQuest');
		expect(source).toContain('modal-backdrop');
		expect(source).toContain('Are you sure you want to unfollow');
		expect(source).toContain('/api/discover/browse?tab=');
		expect(source).toContain('discover-browse-tabs');
		expect(source).toContain("'forYou'");
		expect(source).toContain('For You');
		expect(source).toContain('discover-reason');
		expect(source).toContain('discover-badge-link');
	});
});
