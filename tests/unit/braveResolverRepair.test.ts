import { describe, expect, it } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import {
	discoverProviderCacheKey,
	getDiscoverProviderCache,
	putDiscoverProviderCache,
} from '../../worker/db/discoverProviderCache';
import { parseYouTubeVideoId } from '../../src/lib/youtubeUrl';
import { searchYoutubeDiscoverViaBrave } from '../../worker/services/discover/provider/typedBraveDiscoverSearch';
import {
	DISCOVER_CANDIDATE_RESOLVER_VERSION,
	needsCandidateReprocess,
	resolveBraveHitsToChannels,
} from '../../worker/services/discover/provider/youtubeBatchResolve';
import { YoutubeApiError, type YoutubeClient } from '../../worker/services/youtube';
import type { DiscoverySearchProvider } from '../../worker/services/discover/provider/types';

const USER = 'user-resolver-repair';
const MS_CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_CHANNEL = 'UCbbbbbbbbbbbbbbbbbbbbbb';

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

describe('Phase 4.1 Brave candidate resolution repair', () => {
	it('extracts valid watch and live video IDs', () => {
		expect(parseYouTubeVideoId('https://www.youtube.com/watch?v=qcTTa8OODfc')).toBe('qcTTa8OODfc');
		expect(parseYouTubeVideoId('https://www.youtube.com/live/abcdefghijk')).toBe('abcdefghijk');
		expect(parseYouTubeVideoId('https://youtu.be/abcdefghijk')).toBe('abcdefghijk');
	});

	it('excludes malformed video IDs and removes duplicates before videos.list', async () => {
		const seenBatches: string[] = [];
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'videos') {
				seenBatches.push(String(params.id));
				return {
					items: [{ id: 'abcdefghijk', snippet: { channelId: MS_CHANNEL } }],
				};
			}
			if (path === 'channels') {
				return {
					items: [{ id: MS_CHANNEL, snippet: { title: 'Microsoft', description: 'ms', thumbnails: {} } }],
				};
			}
			throw new Error(path);
		});
		const { candidates, stats } = await resolveBraveHitsToChannels(yt, [
			{ title: 'a', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
			{ title: 'dup', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
			{ title: 'bad', url: 'https://www.youtube.com/watch?v=short' },
		]);
		expect(seenBatches.some((batch) => batch.split(',').includes('abcdefghijk'))).toBe(true);
		expect(seenBatches.join(',')).not.toContain('short');
		expect(candidates).toHaveLength(1);
		expect(stats.searchListCalls).toBe(0);
	});

	it('collapses multiple videos from one creator to one channel', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'videos') {
				const ids = String(params.id).split(',');
				return {
					items: ids.map((id) => ({ id, snippet: { channelId: MS_CHANNEL } })),
				};
			}
			if (path === 'channels') {
				return {
					items: [{ id: MS_CHANNEL, snippet: { title: 'Microsoft', description: 'official', thumbnails: {} } }],
				};
			}
			throw new Error(path);
		});
		const { candidates } = await resolveBraveHitsToChannels(yt, [
			{ title: 'A', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
			{ title: 'B', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' },
			{ title: 'C', url: 'https://www.youtube.com/watch?v=ccccccccccc' },
		]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.externalId).toBe(MS_CHANNEL);
	});

	it('resolves /user/ via forUsername without search.list', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'channels' && params.forUsername === 'Microsoft') {
				return {
					items: [{ id: MS_CHANNEL, snippet: { title: 'Microsoft', customUrl: '@Microsoft', thumbnails: {} } }],
				};
			}
			if (path === 'channels') return { items: [] };
			if (path === 'videos') return { items: [] };
			throw new Error(path);
		});
		const { candidates, stats } = await resolveBraveHitsToChannels(yt, [
			{ title: 'Microsoft - YouTube', url: 'https://www.youtube.com/user/Microsoft' },
		]);
		expect(stats.searchListCalls).toBe(0);
		expect(stats.usernameLookups).toBe(1);
		expect(candidates[0]?.externalId).toBe(MS_CHANNEL);
	});

	it('associates /c/ alias when exact title matches a canonical candidate', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'videos') {
				return { items: [{ id: 'abcdefghijk', snippet: { channelId: MS_CHANNEL } }] };
			}
			if (path === 'channels' && params.id) {
				return {
					items: [
						{
							id: MS_CHANNEL,
							snippet: { title: 'Microsoft', customUrl: '@Microsoft', description: 'official', thumbnails: {} },
						},
					],
				};
			}
			return { items: [] };
		});
		const { candidates, stats } = await resolveBraveHitsToChannels(yt, [
			{ title: 'Microsoft', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
			{ title: 'Microsoft', url: 'https://www.youtube.com/c/Microsoft' },
		]);
		expect(stats.searchListCalls).toBe(0);
		expect(stats.aliasAssociated).toBe(1);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.sourceUrls?.some((u) => u.includes('/c/Microsoft'))).toBe(true);
	});

	it('extracts channel IDs from Brave descriptions', async () => {
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'channels' && params.id?.includes(OTHER_CHANNEL)) {
				return {
					items: [{ id: OTHER_CHANNEL, snippet: { title: 'Stock Channel', thumbnails: {} } }],
				};
			}
			return { items: [] };
		});
		const { candidates, stats } = await resolveBraveHitsToChannels(yt, [
			{
				title: 'About MSFT',
				url: 'https://example.com/not-yt',
				description: `Subscribe https://www.youtube.com/channel/${OTHER_CHANNEL}?sub_confirmation=1`,
			},
		]);
		// example.com is invalid youtube host for classify, but description extraction still runs
		expect(stats.channelIdsFromDescriptions).toBeGreaterThanOrEqual(1);
		expect(candidates.some((c) => c.externalId === OTHER_CHANNEL)).toBe(true);
		expect(stats.searchListCalls).toBe(0);
	});

	it('marks resolution failed for invalid API key and does not claim empty_legitimate', async () => {
		const yt = mockYt(async () => {
			throw new YoutubeApiError(
				'YouTube API key is invalid or not authorized for this request.',
				400,
				false,
				'videos',
				'keyInvalid',
			);
		});
		const { candidates, resolutionStatus, errorMessage, stats } = await resolveBraveHitsToChannels(yt, [
			{ title: 'vid', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
		]);
		expect(candidates).toEqual([]);
		expect(resolutionStatus).toBe('failed');
		expect(errorMessage).toMatch(/API key/i);
		expect(stats.youtubeErrorReason).toBe('keyInvalid');
		expect(stats.searchListCalls).toBe(0);
	});

	it('reprocesses cached raw results without another Brave request', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const now = new Date('2026-08-21T05:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave',
			YOUTUBE_API_KEY: 'yt',
			DISCOVER_PROVIDER_STRATEGY_VERSION: 'v1',
		});
		await putDiscoverProviderCache(
			env.DB,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'microsoft',
				strategyVersion: 'v1',
				rawResults: [
					{ title: 'Microsoft', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
					{ title: 'Microsoft', url: 'https://www.youtube.com/user/Microsoft' },
				],
				candidates: [],
				providerOffset: 0,
				moreResultsAvailable: false,
				resolverVersion: 'v1',
				resolutionStatus: 'failed',
			},
			undefined,
			now,
		);

		expect(
			needsCandidateReprocess({
				resolverVersion: 'v1',
				resolutionStatus: 'failed',
				rawResults: [{}],
				candidates: [],
			}),
		).toBe(true);

		let braveCalls = 0;
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				braveCalls += 1;
				throw new Error('should not call Brave');
			},
		};
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'videos') {
				return { items: [{ id: 'abcdefghijk', snippet: { channelId: MS_CHANNEL } }] };
			}
			if (path === 'channels' && params.forUsername === 'Microsoft') {
				return { items: [{ id: MS_CHANNEL, snippet: { title: 'Microsoft', thumbnails: {} } }] };
			}
			if (path === 'channels') {
				return { items: [{ id: MS_CHANNEL, snippet: { title: 'Microsoft', description: 'ms', thumbnails: {} } }] };
			}
			return { items: [] };
		});

		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'Microsoft', {
			provider,
			youtubeClient: yt,
			now,
		});
		expect(braveCalls).toBe(0);
		expect(yt.calls.search).toBe(0);
		expect(result.results.some((r) => r.externalId === MS_CHANNEL)).toBe(true);

		const cacheKey = discoverProviderCacheKey('brave', 'youtube', 'v1', 'microsoft');
		const updated = await getDiscoverProviderCache(env.DB, cacheKey, now);
		expect(updated?.resolverVersion).toBe(DISCOVER_CANDIDATE_RESOLVER_VERSION);
		expect(updated?.candidates.length).toBeGreaterThan(0);
		expect(updated?.resolutionStatus).toBe('ok');
	});

	it('keeps subscribed filtering downstream of global candidates', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		db.prefs.set(`${USER}:${MS_CHANNEL}`, {
			user_id: USER,
			channel_id: MS_CHANNEL,
			is_subscribed: 1,
			follow_in_inbox: 1,
		});
		const now = new Date('2026-08-21T05:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave',
			YOUTUBE_API_KEY: 'yt',
			DISCOVER_PROVIDER_STRATEGY_VERSION: 'v1',
		});
		await putDiscoverProviderCache(
			env.DB,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'microsoft',
				strategyVersion: 'v1',
				rawResults: [{ title: 'Microsoft', url: `https://www.youtube.com/channel/${MS_CHANNEL}` }],
				candidates: [
					{
						provider: 'youtube',
						type: 'channel',
						externalId: MS_CHANNEL,
						title: 'Microsoft',
						description: 'microsoft software',
						sourceUrls: [],
					},
				],
				providerOffset: 0,
				moreResultsAvailable: false,
				resolverVersion: DISCOVER_CANDIDATE_RESOLVER_VERSION,
				resolutionStatus: 'ok',
			},
			undefined,
			now,
		);
		const result = await searchYoutubeDiscoverViaBrave(env, USER, 'Microsoft', { now });
		expect(result.results.every((r) => r.externalId !== MS_CHANNEL)).toBe(true);
		const cacheKey = discoverProviderCacheKey('brave', 'youtube', 'v1', 'microsoft');
		const global = await getDiscoverProviderCache(env.DB, cacheKey, now);
		expect(global?.candidates.some((c) => c.externalId === MS_CHANNEL)).toBe(true);
	});
});
