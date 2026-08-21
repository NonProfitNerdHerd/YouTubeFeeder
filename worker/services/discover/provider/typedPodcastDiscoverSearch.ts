import {
	cleanupExpiredDiscoverProviderRows,
	DISCOVER_PROVIDER_CACHE_TTL_MS,
	DISCOVER_PROVIDER_FAILED_TTL_MS,
	discoverProviderCacheKey,
	getDiscoverProviderCache,
	putDiscoverProviderCache,
} from '../../../db/discoverProviderCache';
import { getSubscribedPodcastFeedUrls } from '../../../db/podcasts';
import type { DiscoveryResult } from '../../../../src/types/discover';
import { normalizeDiscoverQuery } from '../youtube';
import { ApplePodcastSearchProvider } from './applePodcastSearchProvider';
import { hitsToPodcastCandidates } from './podcastCandidateNormalize';
import {
	DEFAULT_TYPED_PODCAST_RESULT_LIMIT,
	PODCAST_DISCOVER_RESOLVER_VERSION,
	PODCAST_DISCOVER_STRATEGY_VERSION,
	type PodcastDiscoverCandidate,
	type PodcastDiscoveryProvider,
} from './podcastDiscoveryProvider';
import { PodcastIndexDiscoveryProvider } from './podcastIndexDiscoveryProvider';
import type { DiscoveryProviderCandidate } from './types';

export function podcastProviderIdFromEnv(env: Env): 'apple' | 'podcastindex' {
	const raw = (env.DISCOVER_PODCAST_PROVIDER ?? 'apple').trim().toLowerCase();
	return raw === 'podcastindex' ? 'podcastindex' : 'apple';
}

export function createPodcastDiscoveryProvider(env: Env): PodcastDiscoveryProvider {
	const id = podcastProviderIdFromEnv(env);
	if (id === 'podcastindex') {
		return new PodcastIndexDiscoveryProvider(env);
	}
	return new ApplePodcastSearchProvider();
}

export interface TypedPodcastSearchOptions {
	limit?: number;
	offset?: number;
	now?: Date;
	provider?: PodcastDiscoveryProvider;
}

export interface TypedPodcastSearchResult {
	results: DiscoveryResult[];
	candidates: PodcastDiscoverCandidate[];
	cached: boolean;
	searchedAt: string;
	warning?: string;
	hasMore: boolean;
	nextOffset: number;
	providerRequests: number;
}

function candidateToDiscoveryResult(
	c: PodcastDiscoverCandidate,
	subscribedFeeds: Set<string>,
): DiscoveryResult {
	return {
		provider: 'podcast',
		type: 'podcast',
		externalId: c.providerExternalId,
		title: c.title,
		description: c.description,
		imageUrl: c.imageUrl ?? '',
		publisher: c.publisher ?? '',
		feedUrl: c.feedUrl,
		subscribed: subscribedFeeds.has(c.feedUrlNormalized),
		watchUrl: c.websiteUrl,
	};
}

function toCacheCandidates(rows: PodcastDiscoverCandidate[]): DiscoveryProviderCandidate[] {
	return rows.map((c) => ({
		provider: 'podcast' as const,
		type: 'podcast' as const,
		externalId: c.providerExternalId,
		title: c.title,
		description: c.description,
		imageUrl: c.imageUrl,
		publisher: c.publisher,
		watchUrl: c.websiteUrl,
		sourceUrls: c.sourceUrls,
		feedUrl: c.feedUrl,
		feedUrlNormalized: c.feedUrlNormalized,
		providerBackend: c.providerBackend,
		providerExternalId: c.providerExternalId,
		relevance: c.relevance,
		websiteUrl: c.websiteUrl,
		genres: c.genres,
	}));
}

function fromCacheCandidates(rows: DiscoveryProviderCandidate[]): PodcastDiscoverCandidate[] {
	const out: PodcastDiscoverCandidate[] = [];
	for (const c of rows) {
		if (c.provider !== 'podcast' || !c.feedUrl || !c.feedUrlNormalized) continue;
		out.push({
			provider: 'podcast',
			type: 'podcast',
			feedUrl: c.feedUrl,
			feedUrlNormalized: c.feedUrlNormalized,
			title: c.title,
			description: c.description,
			imageUrl: c.imageUrl,
			publisher: c.publisher,
			providerBackend: c.providerBackend ?? 'apple',
			providerExternalId: c.providerExternalId ?? c.externalId,
			relevance: c.relevance ?? 0,
			sourceUrls: c.sourceUrls,
			websiteUrl: c.websiteUrl,
			genres: c.genres,
		});
	}
	return out.sort((a, b) => b.relevance - a.relevance || a.title.localeCompare(b.title));
}

/**
 * Typed Podcast Discover via configured PodcastDiscoveryProvider (default Apple).
 * Shows only. Uses discover_provider_cache with content_type=podcast.
 */
export async function searchPodcastsDiscover(
	env: Env,
	userId: string,
	query: string,
	opts: TypedPodcastSearchOptions = {},
): Promise<TypedPodcastSearchResult> {
	const now = opts.now ?? new Date();
	const normalized = normalizeDiscoverQuery(query);
	const limit = opts.limit ?? DEFAULT_TYPED_PODCAST_RESULT_LIMIT;
	const offset = Math.max(0, Math.floor(opts.offset ?? 0));
	if (!normalized) {
		return {
			results: [],
			candidates: [],
			cached: false,
			searchedAt: now.toISOString(),
			hasMore: false,
			nextOffset: 0,
			providerRequests: 0,
		};
	}

	const backend = podcastProviderIdFromEnv(env);
	const provider = opts.provider ?? createPodcastDiscoveryProvider(env);
	const cacheKey = discoverProviderCacheKey(
		backend,
		'podcast',
		PODCAST_DISCOVER_STRATEGY_VERSION,
		normalized,
	);

	await cleanupExpiredDiscoverProviderRows(env.DB, now);
	let record = await getDiscoverProviderCache(env.DB, cacheKey, now);
	let providerRequests = 0;
	let warning: string | undefined;
	let candidates: PodcastDiscoverCandidate[] = [];

	const cacheUsable =
		record &&
		!record.stale &&
		record.contentType === 'podcast' &&
		record.resolverVersion === PODCAST_DISCOVER_RESOLVER_VERSION &&
		record.resolutionStatus !== 'failed';

	if (cacheUsable && record) {
		candidates = fromCacheCandidates(record.candidates);
	} else {
		try {
			providerRequests = 1;
			const hits = await provider.search(normalized, { limit: 50 });
			candidates = hitsToPodcastCandidates(hits, normalized, provider.id);
			const resolutionStatus = candidates.length > 0 ? 'ok' : 'empty_legitimate';
			record = await putDiscoverProviderCache(
				env.DB,
				{
					provider: backend,
					contentType: 'podcast',
					normalizedQuery: normalized,
					strategyVersion: PODCAST_DISCOVER_STRATEGY_VERSION,
					rawResults: hits.map((h) => ({
						title: h.title,
						url: h.feedUrl,
						description: h.description,
					})),
					candidates: toCacheCandidates(candidates),
					providerOffset: 0,
					moreResultsAvailable: false,
					candidateConsumeOffset: 0,
					resolverVersion: PODCAST_DISCOVER_RESOLVER_VERSION,
					resolutionStatus,
				},
				DISCOVER_PROVIDER_CACHE_TTL_MS,
				now,
			);
		} catch (err) {
			warning = err instanceof Error ? err.message : 'Podcast search failed.';
			await putDiscoverProviderCache(
				env.DB,
				{
					provider: backend,
					contentType: 'podcast',
					normalizedQuery: normalized,
					strategyVersion: PODCAST_DISCOVER_STRATEGY_VERSION,
					rawResults: record?.rawResults ?? [],
					candidates: [],
					providerOffset: 0,
					moreResultsAvailable: false,
					resolverVersion: PODCAST_DISCOVER_RESOLVER_VERSION,
					resolutionStatus: 'failed',
				},
				DISCOVER_PROVIDER_FAILED_TTL_MS,
				now,
			);
			candidates = [];
		}
	}

	const subscribedFeeds = await getSubscribedPodcastFeedUrls(env.DB, userId);
	const usable = candidates.filter((c) => !subscribedFeeds.has(c.feedUrlNormalized));
	const page = usable.slice(offset, offset + limit);
	const results = page.map((c) => candidateToDiscoveryResult(c, subscribedFeeds));

	return {
		results,
		candidates: usable,
		cached: providerRequests === 0,
		searchedAt: record?.searchedAt ?? now.toISOString(),
		warning,
		hasMore: usable.length > offset + limit,
		nextOffset: offset + page.length,
		providerRequests,
	};
}
