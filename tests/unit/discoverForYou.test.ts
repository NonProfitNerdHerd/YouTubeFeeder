import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { buildForYouRecommendations } from '../../worker/services/discover/forYou';
import { buildInterestProfile } from '../../worker/services/discover/interestProfile';
import { buildInterestFingerprints } from '../../worker/services/discover/interestFingerprint';
import { buildInterestSearchQuery } from '../../worker/services/discover/queryConstruction';
import { getTopicCandidates, normalizeTopic } from '../../worker/services/discover/topicDiscovery';
import { discoverBrowse } from '../../worker/services/discoverBrowse';
import {
	DISCOVER_TOPIC_SEARCH_DAILY_BUDGET,
	DISCOVER_TOPIC_SEARCH_ENDPOINT,
	DISCOVER_USER_SEARCH_RESERVE,
} from '../../worker/services/discoverQuota';
import * as youtubeModule from '../../worker/services/youtube';
import type { YoutubeClient } from '../../worker/services/youtube';

async function seedTopicCache(db: MemorySyncDb, cacheKey: string, results: unknown[], now: Date) {
	await db.prepare(
		`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
	)
		.bind(cacheKey, JSON.stringify(results), now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
		.run();
}

async function seedInterestQueryCache(db: MemorySyncDb, userId: string, now: Date, results: unknown[]) {
	const fps = await buildInterestFingerprints(db as unknown as D1Database, userId);
	expect(fps.length).toBeGreaterThan(0);
	const fp = fps[0]!;
	const cacheKey = normalizeTopic(buildInterestSearchQuery(fp));
	await seedTopicCache(db, cacheKey, results, now);
	return { cacheKey, fingerprint: fp };
}

function weatherChannel(externalId: string, title: string) {
	return {
		provider: 'youtube',
		type: 'channel',
		externalId,
		title,
		description: 'Storm chasing tornado severe weather meteorology supercells forecasting intercepts',
	};
}

const CHANNEL = 'UCxxxxxxxxxxxxxxxxxxxxxx';
const CHANNEL_B = 'UCyyyyyyyyyyyyyyyyyyyyyy';
const CHANNEL_C = 'UCzzzzzzzzzzzzzzzzzzzzzz';

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

function seedSubscribedUser(db: MemorySyncDb, userId = 'user-1') {
	db.seedUser(userId);
	for (const [id, title, description] of [
		['ch-1', 'Storm Chasing Daily', 'Tornado and severe weather chase footage from tornado alley'],
		['ch-2', 'Meteorology Hub', 'Technology gadgets and severe weather forecasting reviews'],
		['ch-3', 'Supercell Tracker', 'Storm chasing supercells and convective meteorology'],
	] as const) {
		db.channels.set(id, {
			channel_id: id,
			title,
			description,
			thumbnail_url: '',
			uploads_playlist_id: 'PL1',
		});
		db.prefs.set(`${userId}:${id}`, {
			user_id: userId,
			channel_id: id,
			is_subscribed: 1,
			follow_in_inbox: 1,
		});
	}
}

function seedStormChasingCategory(db: MemorySyncDb, userId = 'user-1') {
	db.categories.set('cat-storm', { id: 'cat-storm', user_id: userId, name: 'Storm Chasing' });
	for (const channelId of ['ch-1', 'ch-2', 'ch-3']) {
		db.channelCategories.push({ user_id: userId, channel_id: channelId, category_id: 'cat-storm' });
	}
}

describe('interest profile', () => {
	it('weights categories highest and preserves multi-word phrases', async () => {
		const db = new MemorySyncDb();
		seedSubscribedUser(db);
		seedStormChasingCategory(db);
		db.inbox.set('user-1:vid-1', { user_id: 'user-1', video_id: 'vid-1', hidden: 0 });
		db.videos.set('vid-1', {
			video_id: 'vid-1',
			channel_id: 'ch-1',
			title: 'Live tornado chase video today',
			published_at: '2026-08-19T00:00:00Z',
		});

		const topics = await buildInterestProfile(db as unknown as D1Database, 'user-1');
		expect(topics.length).toBeGreaterThanOrEqual(1);
		const storm = topics.find((t) => t.reasonLabel === 'Storm Chasing');
		expect(storm?.source).toBe('category');
		expect(storm?.topic).toMatch(/storm|tornado|weather|meteorology|supercell/);
		expect(storm?.score).toBeGreaterThan(3);
		expect(topics.some((t) => t.topic === 'video')).toBe(false);
	});

	it('returns empty profile with fewer than three subscribed channels', async () => {
		const db = new MemorySyncDb();
		db.seedUser('user-1');
		db.seedChannel({ channel_id: 'ch-1', uploads_playlist_id: 'PL1' }, 'user-1');
		db.seedChannel({ channel_id: 'ch-2', uploads_playlist_id: 'PL2' }, 'user-1');
		const topics = await buildInterestProfile(db as unknown as D1Database, 'user-1');
		expect(topics).toHaveLength(0);
	});
});

describe('topic discovery cache', () => {
	it('returns cached results with zero YouTube requests', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const now = new Date('2026-08-19T12:00:00Z');
		await db.prepare(
			`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
		)
			.bind(
				'storm',
				JSON.stringify([{ provider: 'youtube', type: 'channel', externalId: CHANNEL, title: 'Storm Channel' }]),
				now.toISOString(),
				new Date(now.getTime() + 60_000).toISOString(),
			)
			.run();

		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		const result = await getTopicCandidates(env, 'storm', now);
		expect(spy).not.toHaveBeenCalled();
		expect(result.results).toHaveLength(1);
		expect(result.refreshed).toBe(false);
		spy.mockRestore();
	});

	it('does not live-search on For You page load when cache is cold', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const yt = mockYt(async (path, params) => {
			if (path !== 'search') throw new Error(`unexpected:${path}`);
			const q = String(params?.q ?? '');
			return {
				items: [
					{
						id: { channelId: `${q.slice(0, 8)}-ch` },
						snippet: {
							title: 'Storm Chaser Live',
							description: 'Storm chasing tornado severe weather meteorology supercells',
							thumbnails: {},
						},
					},
				],
			};
		});
		vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient').mockReturnValue(yt);

		seedSubscribedUser(db);
		seedStormChasingCategory(db);
		db.categories.set('cat-tech', { id: 'cat-tech', user_id: 'user-1', name: 'Technology' });
		db.channelCategories.push({ user_id: 'user-1', channel_id: 'ch-1', category_id: 'cat-tech' });

		const result = await buildForYouRecommendations(env, 'user-1');
		expect(yt.calls.search).toBe(0);
		expect(result.metrics.searchCalls).toBe(0);
		vi.restoreAllMocks();
	});

	it('serves cached cluster results on For You page load without live search', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const now = new Date('2026-08-19T12:00:00Z');
		seedSubscribedUser(db);
		seedStormChasingCategory(db);

		const fps = await buildInterestFingerprints(db as unknown as D1Database, 'user-1');
		const query = fps[0]?.queries?.[0]?.cacheKey ?? normalizeTopic('storm chasing');
		await db
			.prepare(
				`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
			)
			.bind(
				query,
				JSON.stringify([
					{
						provider: 'youtube',
						type: 'channel',
						externalId: CHANNEL,
						title: 'Storm Chaser Live',
						description: 'storm chasing tornado severe weather meteorology supercells',
					},
				]),
				now.toISOString(),
				new Date(now.getTime() + 60_000).toISOString(),
			)
			.run();

		const yt = mockYt(async () => ({ items: [] }));
		vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient').mockReturnValue(yt);
		const result = await buildForYouRecommendations(env, 'user-1', undefined, now);
		expect(yt.calls.search).toBe(0);
		expect(result.forYou.length).toBeGreaterThan(0);
		vi.restoreAllMocks();
	});

	it('uses stale cache when topic budget is exhausted', async () => {
		const db = new MemorySyncDb();
		const day = new Date().toISOString().slice(0, 10);
		await db.prepare(`INSERT INTO api_quota_daily (day, endpoint, call_count, general_units, search_calls) VALUES (?, ?, ?, ?, ?)`)
			.bind(day, DISCOVER_TOPIC_SEARCH_ENDPOINT, DISCOVER_TOPIC_SEARCH_DAILY_BUDGET, 0, DISCOVER_TOPIC_SEARCH_DAILY_BUDGET)
			.run();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const now = new Date('2026-08-19T12:00:00Z');
		await db.prepare(
			`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
		)
			.bind(
				normalizeTopic('storm'),
				JSON.stringify([{ provider: 'youtube', type: 'channel', externalId: CHANNEL, title: 'Cached Storm' }]),
				'2026-08-01T00:00:00Z',
				'2026-08-01T01:00:00Z',
			)
			.run();

		const yt = mockYt(async () => ({ items: [] }));
		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient').mockReturnValue(yt);
		seedSubscribedUser(db);
		seedStormChasingCategory(db);

		const result = await getTopicCandidates(env, 'storm', now);
		expect(spy).not.toHaveBeenCalled();
		expect(result.results[0]?.title).toBe('Cached Storm');
		vi.restoreAllMocks();
	});

	it('blocks topic refresh when user search reserve is hit', async () => {
		const db = new MemorySyncDb();
		const day = new Date().toISOString().slice(0, 10);
		await db.prepare(`INSERT INTO api_quota_daily (day, endpoint, call_count, general_units, search_calls) VALUES (?, ?, ?, ?, ?)`)
			.bind(day, 'search.list', DISCOVER_USER_SEARCH_RESERVE, 0, DISCOVER_USER_SEARCH_RESERVE)
			.run();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		const result = await getTopicCandidates(env, 'storm');
		expect(spy).not.toHaveBeenCalled();
		expect(result.results).toHaveLength(0);
		spy.mockRestore();
	});
});

describe('For You assembly', () => {
	it('excludes subscribed channels and dedupes duplicates', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const now = new Date('2026-08-19T12:00:00Z');
		seedSubscribedUser(db);
		seedStormChasingCategory(db);

		const dupChannel = weatherChannel(CHANNEL_B, 'Dup Channel');
		await seedInterestQueryCache(db, 'user-1', now, [dupChannel, dupChannel, { ...dupChannel, title: 'Dup Channel Alt' }]);

		const result = await buildForYouRecommendations(env, 'user-1', undefined, now);
		expect(result.forYou.some((r) => r.externalId === 'ch-1')).toBe(false);
		expect(result.forYou.filter((r) => r.externalId === CHANNEL_B)).toHaveLength(1);
	});

	it('rejects weak matches and caps accepted results per interest', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const now = new Date('2026-08-19T12:00:00Z');
		seedSubscribedUser(db);
		seedStormChasingCategory(db);

		const many = Array.from({ length: 8 }, (_, i) => weatherChannel(`UCtopic${i}`, `Storm Channel ${i}`));
		const weak = {
			provider: 'youtube',
			type: 'channel',
			externalId: 'UCweak',
			title: 'STORM Records',
			description: 'Music producer records songs and studio sessions',
		};
		await seedInterestQueryCache(db, 'user-1', now, [...many, weak]);

		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		const result = await buildForYouRecommendations(env, 'user-1', undefined, now);
		expect(spy).not.toHaveBeenCalled();
		expect(result.forYou.some((r) => r.externalId === 'UCweak')).toBe(false);
		expect(result.forYou.length).toBeLessThanOrEqual(8);
		expect(result.metrics.rejected).toBeGreaterThan(0);
		spy.mockRestore();
	});

	it('returns empty state without searches for sparse profiles', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		db.seedUser('user-1');
		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		const result = await buildForYouRecommendations(env, 'user-1');
		expect(result.forYouEmpty).toBe(true);
		expect(result.forYouMessage).toMatch(/Follow and categorize/i);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('browse tabs', () => {
	it('loads For You by default without popular videos.list', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		seedSubscribedUser(db);
		seedStormChasingCategory(db);
		const now = new Date('2026-08-19T12:00:00Z');
		await seedInterestQueryCache(db, 'user-1', now, [weatherChannel(CHANNEL_C, 'For You Channel')]);

		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		const forYou = await discoverBrowse(env, 'user-1', 'forYou', undefined, now);
		expect(forYou.forYou.some((r) => r.externalId === CHANNEL_C)).toBe(true);
		expect(forYou.forYouInterests?.some((i) => i.label === 'Storm Chasing')).toBe(true);
		expect(forYou.popularChannels).toHaveLength(0);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('popular tab returns deduped trending channels not videos', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		const yt = mockYt(async (path) => {
			if (path !== 'videos') throw new Error(`unexpected:${path}`);
			return {
				items: [
					{
						id: 'vid-pop',
						snippet: {
							title: 'Popular Video',
							channelId: CHANNEL,
							channelTitle: 'Popular Channel',
							thumbnails: { medium: { url: 'https://example.com/v.jpg' } },
						},
					},
					{
						id: 'vid-pop-2',
						snippet: {
							title: 'Another Video',
							channelId: CHANNEL,
							channelTitle: 'Popular Channel',
							thumbnails: { medium: { url: 'https://example.com/v2.jpg' } },
						},
					},
				],
			};
		});
		vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient').mockReturnValue(yt);

		const popular = await discoverBrowse(env, 'user-1', 'popular');
		expect(popular.popularChannels).toHaveLength(1);
		expect(popular.popularChannels[0]?.type).toBe('channel');
		expect(popular.popularChannels[0]?.externalId).toBe(CHANNEL);
		expect(popular.forYou).toHaveLength(0);
		expect(yt.calls.search).toBe(0);
		expect(yt.calls.videos).toBe(1);
		vi.restoreAllMocks();
	});

	it('popular tab with interest returns topic channels plus global popular', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		seedSubscribedUser(db);
		seedStormChasingCategory(db);
		const now = new Date('2026-08-19T12:00:00Z');
		const { fingerprint } = await seedInterestQueryCache(db, 'user-1', now, [weatherChannel(CHANNEL_C, 'Storm Channel')]);

		const yt = mockYt(async (path) => {
			if (path !== 'videos') throw new Error(`unexpected:${path}`);
			return {
				items: [
					{
						id: 'vid-pop',
						snippet: {
							title: 'Trending Video',
							channelId: CHANNEL_B,
							channelTitle: 'Trending Channel',
							thumbnails: { medium: { url: 'https://example.com/t.jpg' } },
						},
					},
				],
			};
		});
		vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient').mockReturnValue(yt);

		const popular = await discoverBrowse(env, 'user-1', 'popular', { interestId: fingerprint.interestId }, now);
		expect(popular.popularInterestChannels?.some((r) => r.externalId === CHANNEL_C)).toBe(true);
		expect(popular.popularInterestLabel).toBe('Storm Chasing');
		expect(popular.popularChannels.some((r) => r.externalId === CHANNEL_B)).toBe(true);
		expect(popular.popularChannels.some((r) => r.externalId === CHANNEL_C)).toBe(false);
		vi.restoreAllMocks();
	});

	it('recent tab includes all subscribed channels not only discover follows', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'test-secret' });
		db.seedUser('user-1');
		db.channels.set('sync-ch', { channel_id: 'sync-ch', title: 'Sync Channel', description: '', thumbnail_url: '', uploads_playlist_id: 'PL' });
		db.prefs.set('user-1:sync-ch', {
			user_id: 'user-1',
			channel_id: 'sync-ch',
			is_subscribed: 1,
			follow_source: 'youtube_sync',
			subscription_seen_at: '2026-08-19T10:00:00Z',
		});

		const recent = await discoverBrowse(env, 'user-1', 'recent');
		expect(recent.recentlyFollowed.some((r) => r.externalId === 'sync-ch')).toBe(true);
	});
});
