import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { discoverSearch } from '../../worker/services/discover';
import {
	formatMixedRankingDiagnostics,
	rankMixedDiscoverCandidates,
	type MixedRankCandidate,
} from '../../worker/services/discover/provider/mixedDiscoverRank';
import { scoreDiscoverTextMatch } from '../../worker/services/discover/provider/scoreDiscoverTextMatch';
import * as mixedMod from '../../worker/services/discover/provider/mixedDiscoverSearch';
import * as podcastMod from '../../worker/services/discover/provider/typedPodcastDiscoverSearch';
import * as braveMod from '../../worker/services/discover/provider/typedBraveDiscoverSearch';
import * as youtubeMod from '../../worker/services/discover/youtube';

const USER = 'user-mixed-phase2';

function yt(id: string, title: string, relevance: number, rank = 0): MixedRankCandidate {
	return {
		contentType: 'youtube',
		canonicalId: id,
		relevance,
		providerRank: rank,
		result: {
			provider: 'youtube',
			type: 'channel',
			externalId: id,
			title,
			imageUrl: '',
			publisher: title,
		},
	};
}

function pod(feed: string, title: string, relevance: number, rank = 0): MixedRankCandidate {
	return {
		contentType: 'podcast',
		canonicalId: feed,
		relevance,
		providerRank: rank,
		result: {
			provider: 'podcast',
			type: 'podcast',
			externalId: feed,
			title,
			feedUrl: feed,
			imageUrl: '',
			publisher: '',
		},
	};
}

describe('Phase 2 mixed Discover ranking', () => {
	it('exact title match scores 100; contains does not', () => {
		expect(scoreDiscoverTextMatch('Microsoft', { title: 'Microsoft' })).toBe(100);
		expect(scoreDiscoverTextMatch('history', { title: 'History Daily' })).toBeLessThan(100);
		expect(
			scoreDiscoverTextMatch('Microsoft', { title: 'Microsoft', description: 'corp' }),
		).toBeGreaterThan(
			scoreDiscoverTextMatch('Microsoft', {
				title: 'Cooking Show',
				description: 'We mention Microsoft once in a long description about cooking.',
			}),
		);
	});

	it('intermixes comparable scores without forced alternation', () => {
		const ranked = rankMixedDiscoverCandidates([
			yt('UC1', 'A', 94),
			yt('UC2', 'B', 91),
			pod('https://a.com/f', 'C', 88),
			yt('UC3', 'D', 85),
			pod('https://b.com/f', 'E', 82),
		]);
		expect(ranked.items.map((i) => i.contentType)).toEqual([
			'youtube',
			'youtube',
			'podcast',
			'youtube',
			'podcast',
		]);
		// Not YT/POD/YT/POD...
		expect(ranked.items[0]!.contentType).toBe(ranked.items[1]!.contentType);
	});

	it('soft diversity promotes within delta after 3 same-type', () => {
		const ranked = rankMixedDiscoverCandidates(
			[yt('UC1', 'A', 94), yt('UC2', 'B', 91), yt('UC3', 'C', 89), yt('UC4', 'D', 82), pod('https://p.com/f', 'P', 81)],
			{ diversityWindow: 3, diversityDelta: 8 },
		);
		expect(ranked.items.map((i) => i.result.title)).toEqual(['A', 'B', 'C', 'P', 'D']);
		expect(ranked.diversityPromotions).toBe(1);
		expect(ranked.items[3]!.diversityPromoted).toBe(true);
	});

	it('does not diversify clearly inferior scores', () => {
		const ranked = rankMixedDiscoverCandidates(
			[yt('UC1', 'A', 94), yt('UC2', 'B', 91), yt('UC3', 'C', 89), yt('UC4', 'D', 82), pod('https://p.com/f', 'P', 55)],
			{ diversityWindow: 3, diversityDelta: 8 },
		);
		expect(ranked.items.map((i) => i.result.title)).toEqual(['A', 'B', 'C', 'D', 'P']);
		expect(ranked.diversityPromotions).toBe(0);
	});

	it('stable ordering for equal scores', () => {
		const a = rankMixedDiscoverCandidates([yt('UC2', 'Beta', 80, 1), yt('UC1', 'Alpha', 80, 0)], {
			diversityDelta: 0,
		});
		const b = rankMixedDiscoverCandidates([yt('UC1', 'Alpha', 80, 0), yt('UC2', 'Beta', 80, 1)], {
			diversityDelta: 0,
		});
		expect(a.items.map((i) => i.canonicalId)).toEqual(b.items.map((i) => i.canonicalId));
	});

	it('does not cross-dedupe same-name YouTube and podcast', () => {
		const ranked = rankMixedDiscoverCandidates([
			yt('UCstorm', 'Storm Chaser', 90),
			pod('https://feed.example/storm', 'Storm Chaser', 90),
		]);
		expect(ranked.items).toHaveLength(2);
	});

	it('formats ranking diagnostics for tuning', () => {
		const ranked = rankMixedDiscoverCandidates([yt('UC1', 'Ryan Hall', 94), pod('https://f', 'Storm Front', 88)]);
		const text = formatMixedRankingDiagnostics('Storm Chasers', ranked.items);
		expect(text).toContain('Search: Storm Chasers');
		expect(text).toContain('Ryan Hall');
		expect(text).toContain('PODCAST');
	});
});

describe('Phase 2 provider gating + concurrency', () => {
	it('All invokes YouTube + podcast discovery', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'brave', DISCOVER_PODCAST_PROVIDER: 'apple' });
		const mixedSpy = vi.spyOn(mixedMod, 'searchMixedDiscoverAll').mockResolvedValue({
			query: 'Storm Chasers',
			filter: 'all',
			results: [],
			warnings: [],
			cached: true,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
		});
		await discoverSearch(env, USER, 'Storm Chasers', 'all');
		expect(mixedSpy).toHaveBeenCalled();
		mixedSpy.mockRestore();
	});

	it('Podcasts invokes podcast only', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'x', YOUTUBE_API_KEY: 'y' });
		const podSpy = vi.spyOn(podcastMod, 'searchPodcastsDiscover').mockResolvedValue({
			results: [
				{
					provider: 'podcast',
					type: 'podcast',
					externalId: '1',
					title: 'Storm',
					feedUrl: 'https://f.example/x',
					imageUrl: '',
				},
			],
			candidates: [],
			cached: true,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
			providerRequests: 0,
		});
		const braveSpy = vi.spyOn(braveMod, 'searchYoutubeDiscoverViaBrave').mockRejectedValue(new Error('no brave'));
		const ytSpy = vi.spyOn(youtubeMod, 'searchYoutubeDiscover').mockRejectedValue(new Error('no yt'));
		const res = await discoverSearch(env, USER, 'Storm Chasers', 'podcasts');
		expect(podSpy).toHaveBeenCalled();
		expect(braveSpy).not.toHaveBeenCalled();
		expect(ytSpy).not.toHaveBeenCalled();
		expect(res.results.every((r) => r.provider === 'podcast')).toBe(true);
		podSpy.mockRestore();
		braveSpy.mockRestore();
		ytSpy.mockRestore();
	});

	it('YouTube invokes YouTube only', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'brave' });
		const ytSpy = vi.spyOn(youtubeMod, 'searchYoutubeDiscover').mockResolvedValue({
			results: [
				{
					provider: 'youtube',
					type: 'channel',
					externalId: 'UCaaaaaaaaaaaaaaaaaaaaaaaa',
					title: 'Storm',
					imageUrl: '',
				},
			],
			cached: true,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
		});
		const podSpy = vi.spyOn(podcastMod, 'searchPodcastsDiscover').mockRejectedValue(new Error('no pod'));
		const res = await discoverSearch(env, USER, 'Storm Chasers', 'youtube');
		expect(ytSpy).toHaveBeenCalled();
		expect(podSpy).not.toHaveBeenCalled();
		expect(res.results.every((r) => r.provider === 'youtube')).toBe(true);
		ytSpy.mockRestore();
		podSpy.mockRestore();
	});

	it('All keeps YouTube results when podcast fails', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			DISCOVER_PODCAST_PROVIDER: 'apple',
			BRAVE_SEARCH_API_KEY: 'brave',
			YOUTUBE_API_KEY: 'yt',
			DISCOVER_RELEVANCE_DEBUG: 'true',
		});
		vi.spyOn(braveMod, 'searchYoutubeDiscoverViaBrave').mockResolvedValue({
			results: [
				{
					provider: 'youtube',
					type: 'channel',
					externalId: 'UCaaaaaaaaaaaaaaaaaaaaaaaa',
					title: 'Storm Chasers Live',
					description: 'tornadoes',
					imageUrl: '',
					publisher: 'Storm Chasers Live',
				},
			],
			cached: false,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 1,
			funnel: {
				rawBraveResults: 1,
				validYoutubeUrls: 1,
				channelUrls: 1,
				videoUrls: 0,
				customUrls: 0,
				resolvedChannels: 1,
				unresolvedResults: 0,
				duplicateChannels: 0,
				subscribedFiltered: 0,
				qualityRejected: 0,
				usableCandidates: 1,
				bravePagesFetched: 1,
				cacheHit: false,
				cacheMiss: true,
				youtubeVideosListCalls: 0,
				youtubeChannelsListCalls: 1,
				youtubeSearchListCalls: 0,
			},
		});
		vi.spyOn(podcastMod, 'searchPodcastsDiscover').mockRejectedValue(new Error('apple_down'));

		const res = await mixedMod.searchMixedDiscoverAll(env, USER, 'Storm Chasers', { limit: 10 });
		expect(res.results.some((r) => r.provider === 'youtube')).toBe(true);
		expect(res.warnings.some((w) => w.provider === 'podcast')).toBe(true);
	});

	it('All keeps podcast results when YouTube fails', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'brave', DISCOVER_PODCAST_PROVIDER: 'apple' });
		vi.spyOn(braveMod, 'searchYoutubeDiscoverViaBrave').mockRejectedValue(new Error('brave_down'));
		vi.spyOn(podcastMod, 'searchPodcastsDiscover').mockResolvedValue({
			results: [],
			candidates: [
				{
					provider: 'podcast',
					type: 'podcast',
					feedUrl: 'https://feeds.example.com/storm.xml',
					feedUrlNormalized: 'https://feeds.example.com/storm.xml',
					title: 'Storm Chasers Weekly',
					providerBackend: 'apple',
					providerExternalId: '1001',
					relevance: 95,
				},
			],
			cached: false,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
			providerRequests: 1,
			warning: undefined,
		});

		const res = await mixedMod.searchMixedDiscoverAll(env, USER, 'Storm Chasers', { limit: 10 });
		expect(res.results.some((r) => r.provider === 'podcast')).toBe(true);
		expect(res.warnings.some((w) => w.provider === 'youtube')).toBe(true);
	});

	it('both failure yields empty controlled result with warnings', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'brave' });
		vi.spyOn(braveMod, 'searchYoutubeDiscoverViaBrave').mockRejectedValue(new Error('brave_down'));
		vi.spyOn(podcastMod, 'searchPodcastsDiscover').mockRejectedValue(new Error('apple_down'));
		const res = await mixedMod.searchMixedDiscoverAll(env, USER, 'Storm Chasers');
		expect(res.results).toEqual([]);
		expect(res.warnings.length).toBe(2);
	});

	it('both empty yields empty results with warnings (not browse-style empty message)', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, { DISCOVER_SEARCH_PROVIDER: 'brave' });
		vi.spyOn(braveMod, 'searchYoutubeDiscoverViaBrave').mockResolvedValue({
			results: [],
			cached: true,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			funnel: {
				rawBraveResults: 0,
				validYoutubeUrls: 0,
				channelUrls: 0,
				videoUrls: 0,
				customUrls: 0,
				resolvedChannels: 0,
				unresolvedResults: 0,
				duplicateChannels: 0,
				subscribedFiltered: 0,
				qualityRejected: 0,
				usableCandidates: 0,
				bravePagesFetched: 0,
				cacheHit: true,
				cacheMiss: false,
				youtubeVideosListCalls: 0,
				youtubeChannelsListCalls: 0,
				youtubeSearchListCalls: 0,
			},
		});
		vi.spyOn(podcastMod, 'searchPodcastsDiscover').mockResolvedValue({
			results: [],
			candidates: [],
			cached: true,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
			providerRequests: 0,
		});
		const res = await mixedMod.searchMixedDiscoverAll(env, USER, 'zzzz-no-results');
		expect(res.results).toEqual([]);
		expect(res.query).toBe('zzzz-no-results');
	});

	it('repeated All with fresh caches reports zero external requests', async () => {
		const db = new MemorySyncDb();
		db.seedUser(USER);
		const env = asEnv(db, {
			DISCOVER_SEARCH_PROVIDER: 'brave',
			DISCOVER_RELEVANCE_DEBUG: 'true',
		});
		vi.spyOn(braveMod, 'searchYoutubeDiscoverViaBrave').mockResolvedValue({
			results: [
				{
					provider: 'youtube',
					type: 'channel',
					externalId: 'UCaaaaaaaaaaaaaaaaaaaaaaaa',
					title: 'Microsoft',
					imageUrl: '',
					publisher: 'Microsoft',
				},
			],
			cached: true,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			funnel: {
				rawBraveResults: 0,
				validYoutubeUrls: 0,
				channelUrls: 0,
				videoUrls: 0,
				customUrls: 0,
				resolvedChannels: 0,
				unresolvedResults: 0,
				duplicateChannels: 0,
				subscribedFiltered: 0,
				qualityRejected: 0,
				usableCandidates: 1,
				bravePagesFetched: 0,
				cacheHit: true,
				cacheMiss: false,
				youtubeVideosListCalls: 0,
				youtubeChannelsListCalls: 0,
				youtubeSearchListCalls: 0,
			},
		});
		vi.spyOn(podcastMod, 'searchPodcastsDiscover').mockResolvedValue({
			results: [],
			candidates: [
				{
					provider: 'podcast',
					type: 'podcast',
					feedUrl: 'https://feeds.example.com/ms.xml',
					feedUrlNormalized: 'https://feeds.example.com/ms.xml',
					title: 'Microsoft Podcast',
					providerBackend: 'apple',
					providerExternalId: '9',
					relevance: 90,
				},
			],
			cached: true,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
			providerRequests: 0,
		});

		const res = await mixedMod.searchMixedDiscoverAll(env, USER, 'Microsoft', {
			includeDebug: true,
			limit: 10,
		});
		expect(res.cached).toBe(true);
		expect(res.mixedTelemetry?.youtubeExternalRequests).toBe(0);
		expect(res.mixedTelemetry?.podcastExternalRequests).toBe(0);
		expect(res.results.length).toBeGreaterThan(0);
		expect(res.results.every((r) => r.type === 'channel' || r.type === 'podcast')).toBe(true);
		expect(res.results.some((r) => r.type === 'episode')).toBe(false);
	});
});
