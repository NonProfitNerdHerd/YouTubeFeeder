import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { discoverSearch } from '../../worker/services/discover';
import { searchYoutubeDiscover } from '../../worker/services/discover/youtube';
import { discoverProviderCacheKey, getDiscoverProviderCache, putDiscoverProviderCache } from '../../worker/db/discoverProviderCache';
import { searchYoutubeDiscoverViaBrave } from '../../worker/services/discover/provider/typedBraveDiscoverSearch';
import { resolveBraveHitsToChannels } from '../../worker/services/discover/provider/youtubeBatchResolve';
import { classifyBraveYoutubeHit, scoreTypedBraveCandidate } from '../../worker/services/discover/provider/youtubeCandidateNormalize';
import { buildBraveYoutubeSearchQuery } from '../../worker/services/discover/provider/braveQueryStrategy';
import type { DiscoverySearchProvider } from '../../worker/services/discover/provider/types';
import type { YoutubeClient } from '../../worker/services/youtube';
import { YoutubeApiError } from '../../worker/services/youtube';
import * as podcastIndex from '../../worker/services/discover/podcastIndex';

const USER = 'user-typed-brave';
const CHANNEL_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CHANNEL_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CHANNEL_C = 'UCcccccccccccccccccccccc';

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

function braveHitsPage1() {
	return {
		hits: [
			{ title: 'Storm Chaser Channel', url: `https://www.youtube.com/channel/${CHANNEL_A}`, description: 'storm chasing live' },
			{ title: 'Chase video', url: 'https://www.youtube.com/watch?v=abcdefghijk', description: 'storm chase' },
			{ title: 'Duplicate handle', url: 'https://www.youtube.com/@StormChase', description: 'storm' },
			{ title: 'Custom path', url: 'https://www.youtube.com/c/OldCustom', description: 'storm' },
			{ title: 'Not youtube', url: 'https://example.com/storm', description: 'storm' },
		],
		nextOffset: 1,
		moreAvailable: true,
	};
}

describe('typed Brave Discover Phase 3', () => {
	it('uses site:youtube.com query for v1 strategy', () => {
		expect(buildBraveYoutubeSearchQuery('storm chasing')).toBe('site:youtube.com storm chasing');
	});

	it('classifies channel, handle, video, and custom URLs', () => {
		expect(classifyBraveYoutubeHit({ title: 'a', url: `https://www.youtube.com/channel/${CHANNEL_A}` }).kind).toBe(
			'channelId',
		);
		expect(classifyBraveYoutubeHit({ title: 'a', url: 'https://www.youtube.com/@Handle' }).kind).toBe('handle');
		expect(classifyBraveYoutubeHit({ title: 'a', url: 'https://youtu.be/abcdefghijk' }).kind).toBe('videoId');
		expect(classifyBraveYoutubeHit({ title: 'a', url: 'https://www.youtube.com/c/Foo' }).kind).toBe('custom');
	});

	it('provider=youtube preserves search.list behavior', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'youtube', YOUTUBE_API_KEY: 'yt' });
		const yt = mockYt(async (path) => {
			if (path !== 'search') throw new Error(path);
			return {
				items: [{ id: { channelId: CHANNEL_A }, snippet: { title: 'Legacy', thumbnails: {} } }],
			};
		});
		const createSpy = vi.spyOn(await import('../../worker/services/youtube'), 'createYoutubeApiKeyClient').mockReturnValue(yt);
		const result = await searchYoutubeDiscover(env, USER, 'Olbermann');
		expect(result.results[0]?.externalId).toBe(CHANNEL_A);
		expect(yt.calls.search).toBe(1);
		createSpy.mockRestore();
	});

	it('provider=brave never calls YouTube search.list', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
		});
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list must not be called');
			if (path === 'videos') {
				return {
					items: [{ id: 'abcdefghijk', snippet: { channelId: CHANNEL_B, title: 'vid' } }],
				};
			}
			if (path === 'channels') {
				if (params.forHandle) {
					return { items: [{ id: CHANNEL_A, snippet: { title: 'Storm Chaser Channel', description: 'storm chasing', thumbnails: {} } }] };
				}
				const ids = String(params.id ?? '').split(',');
				return {
					items: ids.map((id) => ({
						id,
						snippet: { title: id === CHANNEL_A ? 'Storm Chaser Channel' : 'Video Channel', description: 'storm chasing', thumbnails: {} },
					})),
				};
			}
			throw new Error(path);
		});
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				return braveHitsPage1();
			},
		};
		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'storm chasing', {
			youtubeClient: yt,
			provider,
			includeDebug: true,
			limit: 10,
			config: {
				apiKey: 'brave-key',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 100,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 10,
			},
		});
		expect(yt.calls.search).toBe(0);
		expect(result.funnel?.youtubeSearchListCalls).toBe(0);
		expect(result.results.length).toBeGreaterThan(0);
		expect(result.results.every((r) => r.externalId.startsWith('UC'))).toBe(true);
	});

	it('resolves video URLs through videos.list and handles through channels.list', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'videos') {
				expect(params.id).toContain('abcdefghijk');
				return { items: [{ id: 'abcdefghijk', snippet: { channelId: CHANNEL_B } }] };
			}
			if (path === 'channels' && params.forHandle === 'StormChase') {
				return { items: [{ id: CHANNEL_A, snippet: { title: 'Handle Channel', thumbnails: {} } }] };
			}
			if (path === 'channels' && params.id) {
				return {
					items: String(params.id)
						.split(',')
						.map((id) => ({ id, snippet: { title: `Title ${id}`, description: 'storm', thumbnails: {} } })),
				};
			}
			throw new Error(`${path}:${JSON.stringify(params)}`);
		});
		const { candidates, stats } = await resolveBraveHitsToChannels(yt, [
			{ title: 'vid', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
			{ title: 'handle', url: 'https://www.youtube.com/@StormChase' },
			{ title: 'custom', url: 'https://www.youtube.com/c/Nope' },
		]);
		expect(stats.searchListCalls).toBe(0);
		expect(stats.videoUrls).toBe(1);
		expect(stats.customUrls).toBe(1);
		expect(candidates.map((c) => c.externalId).sort()).toEqual([CHANNEL_A, CHANNEL_B].sort());
	});

	it('collapses channel page + video + handle for same channel to one candidate', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'videos') return { items: [{ id: 'abcdefghijk', snippet: { channelId: CHANNEL_A } }] };
			if (path === 'channels' && params.forHandle) return { items: [{ id: CHANNEL_A, snippet: { title: 'Same', thumbnails: {} } }] };
			if (path === 'channels') return { items: [{ id: CHANNEL_A, snippet: { title: 'Same', description: 'storm', thumbnails: {} } }] };
			throw new Error(path);
		});
		const { candidates } = await resolveBraveHitsToChannels(yt, [
			{ title: 'Same', url: `https://www.youtube.com/channel/${CHANNEL_A}` },
			{ title: 'Same vid', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
			{ title: 'Same handle', url: 'https://www.youtube.com/@Same' },
		]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.externalId).toBe(CHANNEL_A);
	});

	it('soft-fails videos.list 400 and still resolves channel URL candidates', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'videos') {
				throw new YoutubeApiError('YouTube API videos failed (400).', 400, false, 'videos', 'invalidVideoId');
			}
			if (path === 'search') throw new Error('search.list must not be called');
			if (path === 'channels') {
				return {
					items: [
						{
							id: CHANNEL_A,
							snippet: { title: 'Microsoft Channel', description: 'microsoft', thumbnails: {} },
						},
					],
				};
			}
			throw new Error(`${path}:${JSON.stringify(Object.fromEntries(params))}`);
		});
		const { candidates, stats } = await resolveBraveHitsToChannels(yt, [
			{ title: 'bad vid', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
			{ title: 'channel', url: `https://www.youtube.com/channel/${CHANNEL_A}` },
		]);
		expect(stats.searchListCalls).toBe(0);
		expect(stats.videoResolveFailures).toBeGreaterThanOrEqual(1);
		expect(candidates.some((c) => c.externalId === CHANNEL_A)).toBe(true);
	});

	it('soft-fails a bad video id in a batch and keeps good video→channel mappings', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'videos') {
				const ids = String(params.id ?? '')
					.split(',')
					.filter(Boolean);
				if (ids.length > 1) {
					throw new YoutubeApiError('YouTube API videos failed (400).', 400, false, 'videos', 'invalidVideoId');
				}
				if (ids[0] === 'abcdefghijk') {
					return { items: [{ id: 'abcdefghijk', snippet: { channelId: CHANNEL_B } }] };
				}
				throw new YoutubeApiError('YouTube API videos failed (400).', 400, false, 'videos', 'invalidVideoId');
			}
			if (path === 'channels') {
				return {
					items: [{ id: CHANNEL_B, snippet: { title: 'From Video', description: 'ok', thumbnails: {} } }],
				};
			}
			throw new Error(path);
		});
		const { candidates, stats } = await resolveBraveHitsToChannels(yt, [
			{ title: 'good', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
			{ title: 'bad', url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz' },
		]);
		expect(stats.searchListCalls).toBe(0);
		expect(candidates.some((c) => c.externalId === CHANNEL_B)).toBe(true);
		expect(stats.videoResolveFailures).toBeGreaterThanOrEqual(1);
	});

	it('filters subscribed channels per user without mutating global cache', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		db.seedChannel({ channel_id: CHANNEL_A, uploads_playlist_id: 'UU', title: 'A' });
		db.prefs.set(`${USER}:${CHANNEL_A}`, { user_id: USER, channel_id: CHANNEL_A, is_subscribed: 1, follow_in_inbox: 1 });
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'k', YOUTUBE_API_KEY: 'yt' });
		const now = new Date('2026-08-20T12:00:00.000Z');
		const key = discoverProviderCacheKey('brave', 'youtube', 'v1', 'storm chasing');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [],
				candidates: [
					{
						provider: 'youtube',
						type: 'channel',
						externalId: CHANNEL_A,
						title: 'Storm A',
						description: 'storm chasing',
					},
					{
						provider: 'youtube',
						type: 'channel',
						externalId: CHANNEL_B,
						title: 'Storm B',
						description: 'storm chasing',
					},
				],
				providerOffset: 0,
				moreResultsAvailable: false,
			},
			undefined,
			now,
		);
		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'storm chasing', {
			now,
			youtubeClient: mockYt(async () => ({ items: [] })),
			provider: { id: 'brave', async search() { throw new Error('should not fetch'); } },
			includeDebug: true,
			config: {
				apiKey: 'k',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 100,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 20,
			},
		});
		expect(result.results.map((r) => r.externalId)).toEqual([CHANNEL_B]);
		expect(result.funnel?.subscribedFiltered).toBe(1);
		const cached = await getDiscoverProviderCache(db as unknown as D1Database, key, now);
		expect(cached?.candidates.map((c) => c.externalId).sort()).toEqual([CHANNEL_A, CHANNEL_B].sort());
	});

	it('cache hit causes zero Brave requests; normalized queries share cache', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'k', YOUTUBE_API_KEY: 'yt', DISCOVER_SEARCH_PROVIDER: 'brave' });
		const now = new Date('2026-08-20T12:00:00.000Z');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [{ title: 'A', url: `https://www.youtube.com/channel/${CHANNEL_A}` }],
				candidates: [
					{ provider: 'youtube', type: 'channel', externalId: CHANNEL_A, title: 'Storm', description: 'storm chasing' },
				],
				providerOffset: 0,
				moreResultsAvailable: false,
			},
			undefined,
			now,
		);
		const search = vi.fn(async () => braveHitsPage1());
		const result = await searchYoutubeDiscoverViaBrave(env, USER, '  Storm   Chasing ', {
			now,
			provider: { id: 'brave', search },
			youtubeClient: mockYt(async () => ({ items: [] })),
			config: {
				apiKey: 'k',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 100,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 20,
			},
		});
		expect(search).not.toHaveBeenCalled();
		expect(result.cached).toBe(true);
		expect(result.results[0]?.externalId).toBe(CHANNEL_A);
	});

	it('fetches page 2 when page 1 usable candidates are insufficient', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'k', YOUTUBE_API_KEY: 'yt' });
		let page = 0;
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search(req) {
				page += 1;
				expect(req.offset).toBe(page - 1);
				if (page === 1) {
					return {
						hits: [{ title: 'One', url: `https://www.youtube.com/channel/${CHANNEL_A}`, description: 'storm chasing' }],
						nextOffset: 1,
						moreAvailable: true,
					};
				}
				return {
					hits: [
						{ title: 'Two', url: `https://www.youtube.com/channel/${CHANNEL_B}`, description: 'storm chasing' },
						{ title: 'Three', url: `https://www.youtube.com/channel/${CHANNEL_C}`, description: 'storm chasing' },
					],
					nextOffset: null,
					moreAvailable: false,
				};
			},
		};
		const yt = mockYt(async (path, params) => {
			if (path === 'channels' && params.id) {
				return {
					items: String(params.id)
						.split(',')
						.map((id) => ({ id, snippet: { title: id, description: 'storm chasing', thumbnails: {} } })),
				};
			}
			return { items: [] };
		});
		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'storm chasing', {
			provider,
			youtubeClient: yt,
			limit: 3,
			includeDebug: true,
			config: {
				apiKey: 'k',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 100,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 3,
			},
		});
		expect(page).toBe(2);
		expect(result.funnel?.bravePagesFetched).toBe(2);
		expect(result.results).toHaveLength(3);
	});

	it('stops at max 3 provider pages per request', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'k', YOUTUBE_API_KEY: 'yt' });
		let page = 0;
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				page += 1;
				return {
					hits: [{ title: `P${page}`, url: `https://www.youtube.com/channel/UC${String(page).padStart(22, 'x')}`, description: 'q' }],
					nextOffset: page,
					moreAvailable: true,
				};
			},
		};
		const yt = mockYt(async (path, params) => {
			if (path === 'channels' && params.id) {
				return {
					items: String(params.id)
						.split(',')
						.map((id) => ({ id, snippet: { title: id, description: 'storm chasing weather', thumbnails: {} } })),
				};
			}
			return { items: [] };
		});
		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'storm chasing', {
			provider,
			youtubeClient: yt,
			limit: 50,
			includeDebug: true,
			config: {
				apiKey: 'k',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 100,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 50,
			},
		});
		expect(page).toBe(3);
		expect(result.funnel?.bravePagesFetched).toBe(3);
	});

	it('does not fall back to YouTube search.list when Brave fails; can serve stale cache', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'k', YOUTUBE_API_KEY: 'yt', DISCOVER_SEARCH_PROVIDER: 'brave' });
		const created = new Date('2026-07-01T00:00:00.000Z');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [],
				candidates: [
					{ provider: 'youtube', type: 'channel', externalId: CHANNEL_A, title: 'Cached Storm', description: 'storm chasing' },
				],
				providerOffset: 0,
				moreResultsAvailable: true,
			},
			30 * 24 * 60 * 60 * 1000,
			created,
		);
		const now = new Date(created.getTime() + 31 * 24 * 60 * 60 * 1000);
		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('no search.list');
			return { items: [] };
		});
		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'storm chasing', {
			now,
			youtubeClient: yt,
			provider: {
				id: 'brave',
				async search() {
					throw new Error('brave down');
				},
			},
			config: {
				apiKey: 'k',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 100,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 20,
			},
		});
		expect(yt.calls.search).toBe(0);
		expect(result.results[0]?.title).toBe('Cached Storm');
		expect(result.warning).toMatch(/cached/i);
	});

	it('soft cap stops additional provider pages', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'k', YOUTUBE_API_KEY: 'yt' });
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				return {
					hits: [{ title: 'Only', url: `https://www.youtube.com/channel/${CHANNEL_A}`, description: 'storm chasing' }],
					nextOffset: 1,
					moreAvailable: true,
				};
			},
		};
		const yt = mockYt(async (path, params) => {
			if (path === 'channels' && params.id) {
				return { items: [{ id: CHANNEL_A, snippet: { title: 'Only', description: 'storm chasing', thumbnails: {} } }] };
			}
			return { items: [] };
		});
		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'storm chasing', {
			provider,
			youtubeClient: yt,
			limit: 10,
			includeDebug: true,
			config: {
				apiKey: 'k',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 1,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 10,
			},
		});
		expect(result.funnel?.bravePagesFetched).toBe(1);
		expect(result.funnel?.stopReason).toBe('user_cap');
	});

	it('keeps podcast search on Podcast Index when filter=all', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'k',
			YOUTUBE_API_KEY: 'yt',
			PODCAST_INDEX_KEY: 'pk',
			PODCAST_INDEX_SECRET: 'ps',
		});
		vi.spyOn(podcastIndex, 'searchPodcastIndex').mockResolvedValue({
			feeds: [{ id: 1, title: 'Pod', url: 'https://feed', author: 'A', description: '', image: '' }],
			episodes: [],
		} as never);
		const yt = mockYt(async () => ({ items: [] }));
		vi.spyOn(await import('../../worker/services/youtube'), 'createYoutubeApiKeyClient').mockReturnValue(yt);
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				return { hits: [], nextOffset: null, moreAvailable: false };
			},
		};
		// Force brave path empty youtube via cache
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'news',
				strategyVersion: 'v1',
				rawResults: [],
				candidates: [],
				providerOffset: 0,
				moreResultsAvailable: false,
			},
			undefined,
			new Date(),
		);
		const res = await discoverSearch(env, USER, 'news', 'all');
		expect(res.results.some((r) => r.provider === 'podcast')).toBe(true);
	});

	it('scores typed relevance deterministically', () => {
		expect(scoreTypedBraveCandidate('storm chasing', { title: 'Storm Chasing Live', description: 'tornado' })).toBeGreaterThan(
			scoreTypedBraveCandidate('storm chasing', { title: 'Cooking Show', description: 'recipes' }),
		);
	});
});
