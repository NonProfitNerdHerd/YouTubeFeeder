import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { discoverSearch, discoverSubscribePodcast, validatePodcastRssFeed } from '../../worker/services/discover';
import {
	buildApplePodcastSearchUrl,
	mapApplePodcastResult,
	ApplePodcastSearchProvider,
} from '../../worker/services/discover/provider/applePodcastSearchProvider';
import { hitsToPodcastCandidates, scoreTypedPodcastCandidate } from '../../worker/services/discover/provider/podcastCandidateNormalize';
import { normalizePodcastFeedUrl, feedUrlToExternalFeedId } from '../../worker/services/discover/provider/podcastFeedUrl';
import {
	createPodcastDiscoveryProvider,
	podcastProviderIdFromEnv,
	searchPodcastsDiscover,
} from '../../worker/services/discover/provider/typedPodcastDiscoverSearch';
import { putDiscoverProviderCache, getDiscoverProviderCache, discoverProviderCacheKey } from '../../worker/db/discoverProviderCache';
import { subscribePodcast, getSubscribedPodcastFeedUrls } from '../../worker/db/podcasts';
import { PODCAST_DISCOVER_STRATEGY_VERSION } from '../../worker/services/discover/provider/podcastDiscoveryProvider';
import * as braveMod from '../../worker/services/discover/provider/typedBraveDiscoverSearch';
import * as youtubeMod from '../../worker/services/discover/youtube';

const USER = 'user-podcast-phase1';
const FEED_A = 'https://feeds.example.com/storm.xml';
const FEED_B = 'http://legacy.example.com/weather/';

function appleHits() {
	return [
		{
			collectionId: 1001,
			collectionName: 'Storm Chasers Weekly',
			artistName: 'Weather Media',
			artworkUrl600: 'https://img.example.com/a.jpg',
			feedUrl: FEED_A,
			collectionViewUrl: 'https://podcasts.apple.com/podcast/id1001',
			primaryGenreName: 'Science',
		},
		{
			collectionId: 1002,
			collectionName: 'Cooking Show',
			artistName: 'Food Co',
			feedUrl: 'https://feeds.example.com/cook.xml',
		},
		{
			collectionId: 1003,
			collectionName: 'Storm Chasers Weekly Mirror',
			artistName: 'Weather Media',
			feedUrl: `${FEED_A}?utm_source=apple`,
		},
		{
			collectionId: 1004,
			collectionName: 'No Feed Podcast',
			artistName: 'X',
			// no feedUrl
		},
	];
}

describe('Podcast Discovery Phase 1', () => {
	it('builds Apple query with media=podcast and entity=podcast', () => {
		const url = buildApplePodcastSearchUrl('Storm Chasers', 25);
		expect(url).toContain('itunes.apple.com/search');
		expect(url).toContain('media=podcast');
		expect(url).toContain('entity=podcast');
		expect(url).toContain('term=Storm');
		expect(url).toContain('limit=25');
	});

	it('maps Apple results and rejects missing feedUrl', () => {
		const mapped = appleHits().map(mapApplePodcastResult);
		expect(mapped.filter(Boolean)).toHaveLength(3);
		expect(mapped[0]?.providerExternalId).toBe('1001');
		expect(mapped[0]?.feedUrl).toBe(FEED_A);
		expect(mapped[3]).toBeNull();
	});

	it('normalizes feed URLs conservatively without forcing https', () => {
		expect(normalizePodcastFeedUrl(`  ${FEED_A}?utm_source=x&utm_medium=y  `)).toBe(FEED_A);
		expect(normalizePodcastFeedUrl(FEED_B)).toBe('http://legacy.example.com/weather');
		expect(normalizePodcastFeedUrl('not a url')).toBeNull();
		expect(feedUrlToExternalFeedId(FEED_A)).toBeGreaterThan(0);
	});

	it('dedupes by normalized feed and scores shows', () => {
		const hits = appleHits()
			.map(mapApplePodcastResult)
			.filter((h): h is NonNullable<typeof h> => Boolean(h));
		const candidates = hitsToPodcastCandidates(hits, 'storm chasers', 'apple');
		expect(candidates.some((c) => c.type === 'podcast')).toBe(true);
		expect(candidates.every((c) => c.type === 'podcast')).toBe(true);
		const storm = candidates.filter((c) => c.feedUrlNormalized === FEED_A);
		expect(storm).toHaveLength(1);
		expect(storm[0]?.relevance).toBeGreaterThan(scoreTypedPodcastCandidate('storm chasers', { title: 'Cooking Show' }));
	});

	it('defaults provider config to apple without Podcast Index credentials', () => {
		const env = asEnv(new MemorySyncDb(), { DISCOVER_PODCAST_PROVIDER: 'apple' });
		expect(podcastProviderIdFromEnv(env)).toBe('apple');
		expect(createPodcastDiscoveryProvider(env).id).toBe('apple');
	});

	it('searchPodcastsDiscover returns shows only, caches, and filters followed locally', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_PODCAST_PROVIDER: 'apple' });
		const now = new Date('2026-08-21T15:00:00.000Z');
		const provider = new ApplePodcastSearchProvider({
			fetchImpl: async () =>
				new Response(JSON.stringify({ results: appleHits() }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		});

		const first = await searchPodcastsDiscover(env, USER, 'Storm Chasers', { now, provider });
		expect(first.providerRequests).toBe(1);
		expect(first.results.every((r) => r.type === 'podcast')).toBe(true);
		expect(first.results.some((r) => r.type === 'episode')).toBe(false);
		expect(first.results.some((r) => r.title.includes('Storm'))).toBe(true);

		const second = await searchPodcastsDiscover(env, USER, '  storm   chasers ', { now, provider });
		expect(second.providerRequests).toBe(0);
		expect(second.cached).toBe(true);

		const cacheKey = discoverProviderCacheKey('apple', 'podcast', PODCAST_DISCOVER_STRATEGY_VERSION, 'storm chasers');
		const cached = await getDiscoverProviderCache(env.DB, cacheKey, now);
		expect(cached?.contentType).toBe('podcast');
		expect(cached?.candidates.length).toBeGreaterThan(0);

		await subscribePodcast(env.DB, USER, {
			feedUrl: FEED_A,
			feedUrlNormalized: FEED_A,
			title: 'Storm Chasers Weekly',
			providerExternalId: '1001',
			externalFeedId: 1001,
		});
		const afterFollow = await searchPodcastsDiscover(env, USER, 'Storm Chasers', { now, provider });
		expect(afterFollow.results.every((r) => r.feedUrl !== FEED_A)).toBe(true);
		const global = await getDiscoverProviderCache(env.DB, cacheKey, now);
		expect(global?.candidates.some((c) => c.feedUrlNormalized === FEED_A)).toBe(true);
	});

	it('provider failure uses short TTL failed status not 30-day empty success', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_PODCAST_PROVIDER: 'apple' });
		const now = new Date('2026-08-21T15:00:00.000Z');
		const provider = new ApplePodcastSearchProvider({
			fetchImpl: async () => new Response('nope', { status: 500 }),
		});
		const res = await searchPodcastsDiscover(env, USER, 'Storm Chasers', { now, provider });
		expect(res.results).toEqual([]);
		expect(res.warning).toBeTruthy();
		const cacheKey = discoverProviderCacheKey('apple', 'podcast', PODCAST_DISCOVER_STRATEGY_VERSION, 'storm chasers');
		const cached = await getDiscoverProviderCache(env.DB, cacheKey, now);
		expect(cached?.resolutionStatus).toBe('failed');
		const expires = new Date(cached!.expiresAt).getTime();
		expect(expires - now.getTime()).toBeLessThan(2 * 60 * 60 * 1000);
	});

	it('Podcasts filter does not call Brave or YouTube Discover', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {
			DISCOVER_PODCAST_PROVIDER: 'apple',
			DISCOVER_SEARCH_PROVIDER: 'brave',
			BRAVE_SEARCH_API_KEY: 'brave',
			YOUTUBE_API_KEY: 'yt',
		});
		const braveSpy = vi.spyOn(braveMod, 'searchYoutubeDiscoverViaBrave').mockImplementation(async () => {
			throw new Error('brave should not run');
		});
		const ytSpy = vi.spyOn(youtubeMod, 'searchYoutubeDiscover').mockImplementation(async () => {
			throw new Error('youtube should not run');
		});
		vi.spyOn(ApplePodcastSearchProvider.prototype, 'search').mockResolvedValue([
			{
				providerExternalId: '1001',
				title: 'Storm Chasers Weekly',
				feedUrl: FEED_A,
				publisher: 'Weather Media',
			},
		]);

		const res = await discoverSearch(env, USER, 'Storm Chasers', 'podcasts');
		expect(braveSpy).not.toHaveBeenCalled();
		expect(ytSpy).not.toHaveBeenCalled();
		expect(res.results.every((r) => r.provider === 'podcast' && r.type === 'podcast')).toBe(true);
		expect(res.results.some((r) => r.type === 'episode')).toBe(false);

		braveSpy.mockRestore();
		ytSpy.mockRestore();
	});

	it('discoverSearch All no longer injects mock podcasts without PI key', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {
			DISCOVER_PODCAST_PROVIDER: 'apple',
			DISCOVER_SEARCH_PROVIDER: 'youtube',
			// no PODCAST_INDEX_KEY, MOCK_DATA unset
		});
		vi.spyOn(ApplePodcastSearchProvider.prototype, 'search').mockResolvedValue([]);
		vi.spyOn(youtubeMod, 'searchYoutubeDiscover').mockResolvedValue({
			results: [],
			cached: false,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
		});
		const res = await discoverSearch(env, USER, 'Storm Chasers', 'all');
		expect(res.results.every((r) => r.externalId !== '900001')).toBe(true);
	});

	it('follow validates RSS then stores canonical feed identity', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_PODCAST_PROVIDER: 'apple' });
		const rssXml = `<?xml version="1.0"?><rss><channel>
			<item><title>Ep1</title><guid>g1</guid><enclosure url="https://cdn.example.com/e.mp3"/></item>
		</channel></rss>`;
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			new Response(rssXml, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
		);
		const catchup = await import('../../worker/services/podcastCatchup');
		vi.spyOn(catchup, 'catchUpPodcast').mockResolvedValue({
			status: 'ok',
			episodesAdded: 3,
			pulled: 3,
			want: 20,
			done: true,
			errorSummary: null,
		});

		const ok = await validatePodcastRssFeed(FEED_A);
		expect(ok.ok).toBe(true);

		const sub = await discoverSubscribePodcast(env, USER, {
			feedUrl: FEED_A,
			title: 'Storm Chasers Weekly',
			publisher: 'Weather Media',
			providerExternalId: '1001',
			externalFeedId: 1001,
		});
		expect(sub.created).toBe(true);
		expect(sub.episodesAdded).toBe(3);
		expect(catchup.catchUpPodcast).toHaveBeenCalled();

		const feeds = await getSubscribedPodcastFeedUrls(env.DB, USER);
		expect(feeds.has(FEED_A)).toBe(true);

		fetchSpy.mockRestore();
	});

	it('preserves existing PI subscription after normalized backfill fields', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {});
		// Simulate pre-migration row then subscribe path updates identity
		await subscribePodcast(env.DB, USER, {
			feedUrl: 'https://pi.example.com/feed.xml',
			feedUrlNormalized: 'https://pi.example.com/feed.xml',
			title: 'Legacy PI Show',
			externalFeedId: 4242,
			providerExternalId: '4242',
		});
		const feeds = await getSubscribedPodcastFeedUrls(env.DB, USER);
		expect(feeds.has('https://pi.example.com/feed.xml')).toBe(true);
	});
});
