import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { discoverProviderCacheKey, getDiscoverProviderCache, putDiscoverProviderCache } from '../../worker/db/discoverProviderCache';
import { loadActiveInterestCandidates } from '../../worker/db/discoverInterestCandidates';
import { loadAndPersistInterestPopular } from '../../worker/services/discover/interestPopular';
import { discoverCandidatesForInterest } from '../../worker/services/discover/interestDiscovery';
import { buildInterestFingerprints } from '../../worker/services/discover/interestFingerprint';
import { DISCOVER_CANDIDATE_RESOLVER_VERSION } from '../../worker/services/discover/provider/youtubeBatchResolve';
import { getTopicCandidates } from '../../worker/services/discover/topicDiscovery';
import { MIN_ACCEPT_SCORE } from '../../worker/services/discover/candidateScoring';
import { searchYoutubeDiscover } from '../../worker/services/discover/youtube';
import { discoverSearch } from '../../worker/services/discover';
import * as poolMod from '../../worker/services/discover/provider/braveProviderPool';
import * as podcastIndex from '../../worker/services/discover/podcastIndex';
import type { DiscoverySearchProvider } from '../../worker/services/discover/provider/types';
import type { YoutubeClient } from '../../worker/services/youtube';

const USER = 'user-microsoft-brave';
const MS_CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const MS_CHANNEL_2 = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const MS_CHANNEL_3 = 'UCcccccccccccccccccccccc';
const WEAK_CHANNEL = 'UCdddddddddddddddddddddd';

const realEnsure = poolMod.ensureBraveProviderPool;

function cacheMeta() {
	return {
		resolverVersion: DISCOVER_CANDIDATE_RESOLVER_VERSION,
		resolutionStatus: 'ok' as const,
	};
}

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

function seedMicrosoftInterest(db: MemorySyncDb) {
	db.seedUser(USER);
	for (const [id, title, description] of [
		['ch-ms-1', 'Microsoft Developer', 'microsoft azure windows office 365 development tutorials'],
		['ch-ms-2', 'Azure Cloud Tips', 'microsoft azure devops cloud computing microsoft'],
		['ch-ms-3', 'Windows Insider', 'microsoft windows 11 microsoft surface tips'],
	] as const) {
		db.channels.set(id, {
			channel_id: id,
			title,
			description,
			thumbnail_url: '',
			uploads_playlist_id: 'PL1',
		});
		db.prefs.set(`${USER}:${id}`, {
			user_id: USER,
			channel_id: id,
			is_subscribed: 1,
			follow_in_inbox: 1,
		});
	}
	db.categories.set('cat-ms', { id: 'cat-ms', user_id: USER, name: 'Microsoft' });
	for (const channelId of ['ch-ms-1', 'ch-ms-2', 'ch-ms-3']) {
		db.channelCategories.push({ user_id: USER, channel_id: channelId, category_id: 'cat-ms' });
	}
}

function channelResponse(id: string, title: string, description: string) {
	return {
		items: [
			{
				id,
				snippet: {
					title,
					description,
					thumbnails: { default: { url: 'https://img.example/t.jpg' } },
					customUrl: `@${title.replace(/\s+/g, '')}`,
				},
				statistics: { subscriberCount: '10000', videoCount: '100', viewCount: '1000000' },
			},
		],
	};
}

function withInjectedPool(provider: DiscoverySearchProvider, yt: YoutubeClient) {
	return vi.spyOn(poolMod, 'ensureBraveProviderPool').mockImplementation((e, u, q, opts) =>
		realEnsure(e, u, q, { ...opts, provider, youtubeClient: yt }),
	);
}

describe('Brave For You / topic discovery Phase 4', () => {
	it('keeps MIN_ACCEPT_SCORE at 55', () => {
		expect(MIN_ACCEPT_SCORE).toBe(55);
	});

	it('Microsoft Discover More uses Brave and never calls search.list', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftInterest(db);
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
		});
		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('search.list must not be called');
			if (path === 'channels') {
				return channelResponse(MS_CHANNEL, 'Microsoft 365', 'official microsoft 365 tips azure windows');
			}
			return { items: [] };
		});
		const createSpy = vi.spyOn(await import('../../worker/services/youtube'), 'createYoutubeApiKeyClient').mockReturnValue(yt);

		let braveCalls = 0;
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				braveCalls += 1;
				return {
					hits: [
						{
							title: 'Microsoft 365',
							url: `https://www.youtube.com/channel/${MS_CHANNEL}`,
							description: 'microsoft 365 azure windows office',
						},
					],
					nextOffset: 1,
					moreAvailable: false,
				};
			},
		};
		const ensureSpy = withInjectedPool(provider, yt);

		const result = await loadAndPersistInterestPopular(env, USER, 'cat-ms', new Date('2026-08-20T12:00:00Z'));
		expect(yt.calls.search).toBe(0);
		expect(braveCalls).toBeGreaterThanOrEqual(1);
		expect(Array.isArray(result.channels)).toBe(true);

		createSpy.mockRestore();
		ensureSpy.mockRestore();
	});

	it('topic discovery checks provider cache first and fresh cache avoids Brave', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const now = new Date('2026-08-20T12:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
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
						externalId: MS_CHANNEL,
						title: 'Microsoft',
						description: 'microsoft azure',
						sourceUrls: [`https://www.youtube.com/channel/${MS_CHANNEL}`],
					},
				],
				providerOffset: 0,
				moreResultsAvailable: true,
				...cacheMeta(),
			},
			undefined,
			now,
		);

		let braveCalls = 0;
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				braveCalls += 1;
				throw new Error('should not call Brave on fresh cache');
			},
		};
		const yt = mockYt(async () => ({ items: [] }));
		const ensureSpy = withInjectedPool(provider, yt);

		const result = await getTopicCandidates(env, 'Microsoft', now, { allowRefresh: true, userId: USER });
		expect(braveCalls).toBe(0);
		expect(result.refreshed).toBe(false);
		expect(result.results.some((r) => r.externalId === MS_CHANNEL)).toBe(true);
		ensureSpy.mockRestore();
	});

	it('insufficient cached candidates fetch next Brave page and pagination resumes', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const now = new Date('2026-08-20T12:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
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
				rawResults: [{ title: 'a', url: `https://www.youtube.com/channel/${MS_CHANNEL}` }],
				candidates: [
					{
						externalId: MS_CHANNEL,
						title: 'Microsoft Channel',
						description: 'microsoft',
						sourceUrls: [],
					},
				],
				providerOffset: 0,
				moreResultsAvailable: true,
				...cacheMeta(),
			},
			undefined,
			now,
		);

		const offsets: number[] = [];
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search(req) {
				offsets.push(req.offset);
				return {
					hits: [
						{
							title: 'Azure Tips',
							url: `https://www.youtube.com/channel/${MS_CHANNEL_2}`,
							description: 'microsoft azure',
						},
					],
					nextOffset: req.offset + 1,
					moreAvailable: false,
				};
			},
		};
		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'channels') {
				return channelResponse(MS_CHANNEL_2, 'Azure Tips', 'microsoft azure cloud');
			}
			return { items: [] };
		});

		const pool = await realEnsure(env, USER, 'Microsoft', {
			allowRefresh: true,
			forceNextPage: true,
			maxPages: 1,
			minResolvedCandidates: 2,
			now,
			provider,
			youtubeClient: yt,
		});
		expect(offsets).toEqual([1]);
		expect(pool.record?.candidates.some((c) => c.externalId === MS_CHANNEL)).toBe(true);
		expect(pool.record?.candidates.some((c) => c.externalId === MS_CHANNEL_2)).toBe(true);
		expect(yt.calls.search).toBe(0);

		const offsets2: number[] = [];
		const provider2: DiscoverySearchProvider = {
			id: 'brave',
			async search(req) {
				offsets2.push(req.offset);
				return { hits: [], nextOffset: req.offset + 1, moreAvailable: false };
			},
		};
		const again = await realEnsure(env, USER, 'Microsoft', {
			allowRefresh: true,
			forceNextPage: true,
			maxPages: 1,
			now,
			provider: provider2,
			youtubeClient: yt,
		});
		expect(offsets2).toEqual([]);
		expect(again.funnel.stopReason).toBe('provider_exhausted');
	});

	it('low-yield page can advance to next provider page during interest discovery', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftInterest(db);
		const now = new Date('2026-08-20T12:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
			DISCOVER_PROVIDER_STRATEGY_VERSION: 'v1',
			DISCOVER_BRAVE_MAX_PAGES_PER_REQUEST: '3',
		});

		const offsets: number[] = [];
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search(req) {
				offsets.push(req.offset);
				if (req.offset === 0) {
					return {
						hits: [
							{
								title: 'Unrelated Pets',
								url: `https://www.youtube.com/channel/${WEAK_CHANNEL}`,
								description: 'cute cats and dogs',
							},
						],
						nextOffset: 1,
						moreAvailable: true,
					};
				}
				return {
					hits: [
						{
							title: 'Microsoft Learn',
							url: `https://www.youtube.com/channel/${MS_CHANNEL_3}`,
							description: 'microsoft azure windows office 365 developer tutorials',
						},
					],
					nextOffset: 2,
					moreAvailable: false,
				};
			},
		};
		const yt = mockYt(async (path, params) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'channels') {
				const id = String(params.get('id') ?? '');
				if (id.includes(WEAK_CHANNEL)) {
					return channelResponse(WEAK_CHANNEL, 'Unrelated Pets', 'cute cats and dogs only');
				}
				return channelResponse(
					MS_CHANNEL_3,
					'Microsoft Learn',
					'microsoft azure windows office 365 developer tutorials',
				);
			}
			return { items: [] };
		});
		const ensureSpy = withInjectedPool(provider, yt);

		const fps = await buildInterestFingerprints(env.DB, USER);
		const fp = fps.find((row) => row.interestId === 'cat-ms')!;
		const discovery = await discoverCandidatesForInterest(
			env,
			USER,
			fp,
			{ allowLiveSearch: true, maxLiveSearches: 3 },
			now,
		);
		expect(yt.calls.search).toBe(0);
		expect(offsets.length).toBeGreaterThanOrEqual(1);
		expect(discovery.metrics.providerPagesFetched).toBeGreaterThanOrEqual(1);
		ensureSpy.mockRestore();
	});

	it('subscribed filtering remains per-user and does not mutate global cache', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftInterest(db);
		const now = new Date('2026-08-20T12:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
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
				rawResults: [],
				candidates: [
					{
						externalId: MS_CHANNEL,
						title: 'Microsoft 365',
						description: 'microsoft azure windows office 365 tips',
						sourceUrls: [],
					},
				],
				providerOffset: 0,
				moreResultsAvailable: false,
				...cacheMeta(),
			},
			undefined,
			now,
		);
		db.prefs.set(`${USER}:${MS_CHANNEL}`, {
			user_id: USER,
			channel_id: MS_CHANNEL,
			is_subscribed: 1,
			follow_in_inbox: 1,
		});

		const fps = await buildInterestFingerprints(env.DB, USER);
		const fp = fps.find((row) => row.interestId === 'cat-ms')!;
		await discoverCandidatesForInterest(env, USER, fp, { allowLiveSearch: false }, now);
		const userA = await loadActiveInterestCandidates(env.DB, USER, 'cat-ms');
		expect(userA.every((row) => row.external_id !== MS_CHANNEL)).toBe(true);

		const cacheKey = discoverProviderCacheKey('brave', 'youtube', 'v1', 'microsoft');
		const global = await getDiscoverProviderCache(env.DB, cacheKey, now);
		expect(global?.candidates.some((c) => c.externalId === MS_CHANNEL)).toBe(true);
	});

	it('Brave failure does not invoke YouTube search.list and can use stale cache', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const now = new Date('2026-08-20T12:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
			DISCOVER_PROVIDER_STRATEGY_VERSION: 'v1',
		});
		const writeTime = new Date(now.getTime() - 2 * 60 * 60 * 1000);
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
						externalId: MS_CHANNEL,
						title: 'Microsoft',
						description: 'microsoft',
						sourceUrls: [],
					},
				],
				providerOffset: 0,
				moreResultsAvailable: true,
				...cacheMeta(),
			},
			60 * 60 * 1000,
			writeTime,
		);

		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('search.list');
			return { items: [] };
		});
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				throw new Error('Brave down');
			},
		};
		const pool = await realEnsure(env, USER, 'Microsoft', {
			allowRefresh: true,
			minResolvedCandidates: 50,
			maxPages: 1,
			now,
			provider,
			youtubeClient: yt,
		});
		expect(yt.calls.search).toBe(0);
		expect(pool.record?.candidates.some((c) => c.externalId === MS_CHANNEL)).toBe(true);
		expect(pool.warning).toBeTruthy();
	});

	it('zero qualifying candidates returns normal empty state rather than throwing', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftInterest(db);
		const now = new Date('2026-08-20T12:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
		});
		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'channels') {
				return channelResponse(WEAK_CHANNEL, 'Cat Videos', 'only cats meow');
			}
			return { items: [] };
		});
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				return {
					hits: [
						{
							title: 'Cat Videos',
							url: `https://www.youtube.com/channel/${WEAK_CHANNEL}`,
							description: 'cats',
						},
					],
					nextOffset: 1,
					moreAvailable: false,
				};
			},
		};
		const ensureSpy = withInjectedPool(provider, yt);
		const createSpy = vi.spyOn(await import('../../worker/services/youtube'), 'createYoutubeApiKeyClient').mockReturnValue(yt);

		const result = await loadAndPersistInterestPopular(env, USER, 'cat-ms', now);
		expect(result.empty).toBe(true);
		expect(result.channels).toEqual([]);
		expect(yt.calls.search).toBe(0);
		ensureSpy.mockRestore();
		createSpy.mockRestore();
	});

	it('soft cap produces controlled behavior without search.list', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const now = new Date('2026-08-20T12:00:00Z');
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
			BRAVE_USER_DAILY_SOFT_CAP: '0',
			DISCOVER_PROVIDER_STRATEGY_VERSION: 'v1',
		});
		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('search.list');
			return { items: [] };
		});
		let braveCalls = 0;
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				braveCalls += 1;
				return { hits: [], nextOffset: 1, moreAvailable: false };
			},
		};
		const pool = await realEnsure(env, USER, 'Microsoft', {
			allowRefresh: true,
			minResolvedCandidates: 10,
			maxPages: 2,
			now,
			provider,
			youtubeClient: yt,
		});
		expect(braveCalls).toBe(0);
		expect(pool.funnel.stopReason).toMatch(/cap|user/);
		expect(yt.calls.search).toBe(0);
	});

	it('typed Brave search continues working alongside topic path', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
			DISCOVER_PROVIDER_STRATEGY_VERSION: 'v1',
		});
		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('search.list');
			if (path === 'channels') {
				return channelResponse(MS_CHANNEL, 'Microsoft', 'microsoft software');
			}
			return { items: [] };
		});
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				return {
					hits: [
						{
							title: 'Microsoft',
							url: `https://www.youtube.com/channel/${MS_CHANNEL}`,
							description: 'microsoft',
						},
					],
					nextOffset: 1,
					moreAvailable: false,
				};
			},
		};
		const { searchYoutubeDiscoverViaBrave } = await import(
			'../../worker/services/discover/provider/typedBraveDiscoverSearch'
		);
		const typed = await searchYoutubeDiscoverViaBrave(env, USER, 'Microsoft', {
			provider,
			youtubeClient: yt,
		});
		expect(yt.calls.search).toBe(0);
		expect(typed.results.some((r) => r.externalId === MS_CHANNEL)).toBe(true);

		const topic = await getTopicCandidates(env, 'Microsoft', new Date(), { allowRefresh: false, userId: USER });
		expect(topic.results.some((r) => r.externalId === MS_CHANNEL)).toBe(true);
	});

	it('Podcast Discover remains unchanged under Brave provider flag', async () => {
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
		await putDiscoverProviderCache(
			env.DB,
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

	it('regression: Brave interest-popular path cannot invoke YouTube search.list', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftInterest(db);
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave-key',
			YOUTUBE_API_KEY: 'yt',
		});
		const yt = mockYt(async (path) => {
			if (path === 'search') throw new Error('search.list must not be called for interest-popular');
			if (path === 'channels') {
				return channelResponse(MS_CHANNEL, 'Microsoft Dev', 'microsoft azure windows developer');
			}
			return { items: [] };
		});
		const createSpy = vi.spyOn(await import('../../worker/services/youtube'), 'createYoutubeApiKeyClient').mockReturnValue(yt);
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				return {
					hits: [
						{
							title: 'Microsoft Dev',
							url: `https://www.youtube.com/channel/${MS_CHANNEL}`,
							description: 'microsoft azure',
						},
					],
					nextOffset: 1,
					moreAvailable: false,
				};
			},
		};
		const ensureSpy = withInjectedPool(provider, yt);

		await loadAndPersistInterestPopular(env, USER, 'cat-ms');
		expect(yt.calls.search).toBe(0);
		expect(yt.searchQueries).toBe(0);

		await searchYoutubeDiscover(env, USER, 'Microsoft');
		expect(yt.calls.search).toBe(0);

		createSpy.mockRestore();
		ensureSpy.mockRestore();
	});
});
