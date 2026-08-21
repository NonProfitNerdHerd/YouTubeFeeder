import type { DiscoveryResult } from '../../../../src/types/discover';
import {
	appendDiscoverProviderCachePage,
	cleanupExpiredDiscoverProviderRows,
	DISCOVER_PROVIDER_CACHE_TTL_MS,
	DISCOVER_PROVIDER_FAILED_TTL_MS,
	discoverProviderCacheKey,
	getDiscoverProviderCache,
	putDiscoverProviderCache,
	releaseDiscoverProviderLock,
	tryAcquireDiscoverProviderLock,
	updateDiscoverProviderResolvedCandidates,
} from '../../../db/discoverProviderCache';
import { getSubscribedChannelIds } from '../../../db/queries';
import { recordYoutubeCalls } from '../../websub';
import { createYoutubeApiKeyClient, type YoutubeClient } from '../../youtube';
import {
	braveUsageStatus,
	recordBraveApiError,
	recordBraveApiRequest,
	recordBraveCacheHit,
	recordBraveCacheMiss,
	recordBraveUsableCandidates,
	recordBraveZeroResultSearch,
} from '../braveQuota';
import { normalizeDiscoverQuery, overlayYoutubeSubscribed, type YoutubeDiscoverSearchResult } from '../youtube';
import { braveDiscoverConfigFromEnv, type BraveDiscoverConfig } from './braveConfig';
import { BraveSearchProvider } from './braveSearchProvider';
import {
	DISCOVER_CANDIDATE_RESOLVER_VERSION,
	needsCandidateReprocess,
	resolveBraveHitsToChannels,
} from './youtubeBatchResolve';
import {
	scoreTypedBraveCandidate,
	TYPED_BRAVE_MIN_RELEVANCE,
} from './youtubeCandidateNormalize';
import type {
	DiscoveryProviderCandidate,
	DiscoverySearchProvider,
	TypedBraveSearchFunnel,
} from './types';

function emptyFunnel(): TypedBraveSearchFunnel {
	return {
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
		cacheHit: false,
		cacheMiss: false,
		youtubeVideosListCalls: 0,
		youtubeChannelsListCalls: 0,
		youtubeSearchListCalls: 0,
	};
}

function toDiscoveryResults(candidates: DiscoveryProviderCandidate[]): DiscoveryResult[] {
	return candidates.map((c) => ({
		provider: 'youtube' as const,
		type: 'channel' as const,
		externalId: c.externalId,
		title: c.title,
		description: c.description,
		imageUrl: c.imageUrl ?? '',
		publisher: c.publisher ?? c.title,
		watchUrl: c.watchUrl ?? `https://www.youtube.com/channel/${c.externalId}`,
	}));
}

function filterForUser(
	candidates: DiscoveryProviderCandidate[],
	subscribed: Set<string>,
	normalizedQuery: string,
	funnel: TypedBraveSearchFunnel,
): DiscoveryResult[] {
	const out: DiscoveryResult[] = [];
	for (const c of candidates) {
		if (subscribed.has(c.externalId)) {
			funnel.subscribedFiltered += 1;
			continue;
		}
		const score = scoreTypedBraveCandidate(normalizedQuery, c);
		if (score < TYPED_BRAVE_MIN_RELEVANCE) {
			funnel.qualityRejected += 1;
			continue;
		}
		out.push(...toDiscoveryResults([c]));
	}
	funnel.usableCandidates = out.length;
	return out;
}

function mergeCandidates(
	existing: DiscoveryProviderCandidate[],
	incoming: DiscoveryProviderCandidate[],
): DiscoveryProviderCandidate[] {
	const map = new Map<string, DiscoveryProviderCandidate>();
	for (const c of existing) map.set(c.externalId, { ...c, sourceUrls: [...(c.sourceUrls ?? [])] });
	for (const c of incoming) {
		const prior = map.get(c.externalId);
		if (!prior) {
			map.set(c.externalId, c);
			continue;
		}
		prior.sourceUrls = [...new Set([...(prior.sourceUrls ?? []), ...(c.sourceUrls ?? [])])];
		if (!prior.imageUrl && c.imageUrl) prior.imageUrl = c.imageUrl;
		if ((!prior.description || prior.description.length < 20) && c.description) prior.description = c.description;
	}
	return [...map.values()];
}

export interface TypedBraveSearchOptions {
	limit?: number;
	/** Absolute offset into the usable (post-filter) candidate list. */
	offset?: number;
	includeDebug?: boolean;
	now?: Date;
	config?: BraveDiscoverConfig;
	provider?: DiscoverySearchProvider;
	youtubeClient?: YoutubeClient;
	lockOwner?: string;
}

export interface TypedBraveSearchResult extends YoutubeDiscoverSearchResult {
	funnel?: TypedBraveSearchFunnel;
	hasMore?: boolean;
	nextOffset?: number;
}

function pageFromUsable(
	usable: DiscoveryResult[],
	subscribed: Set<string>,
	offset: number,
	limit: number,
	moreProviderPages: boolean,
): Pick<TypedBraveSearchResult, 'results' | 'hasMore' | 'nextOffset'> {
	const page = usable.slice(offset, offset + limit);
	const hasMore = usable.length > offset + limit || (moreProviderPages && usable.length >= offset);
	return {
		results: overlayYoutubeSubscribed(page, subscribed),
		hasMore,
		nextOffset: offset + page.length,
	};
}

/**
 * Typed Discover YouTube search via Brave + batch YouTube verification.
 * Never calls YouTube search.list. Does not mutate global cache for subscribed filtering.
 */
export async function searchYoutubeDiscoverViaBrave(
	env: Env,
	userId: string,
	query: string,
	opts: TypedBraveSearchOptions = {},
): Promise<TypedBraveSearchResult> {
	const now = opts.now ?? new Date();
	const config = opts.config ?? braveDiscoverConfigFromEnv(env);
	const normalized = normalizeDiscoverQuery(query);
	const funnel = emptyFunnel();
	if (!normalized) {
		return {
			results: [],
			cached: false,
			searchedAt: now.toISOString(),
			hasMore: false,
			nextOffset: 0,
			funnel,
		};
	}

	const strategyVersion = config.strategyVersion;
	const cacheKey = discoverProviderCacheKey('brave', 'youtube', strategyVersion, normalized);
	const limit = opts.limit ?? config.typedResultLimit;
	const offset = Math.max(0, Math.floor(opts.offset ?? 0));
	const needCount = offset + limit;
	const maxPages = config.maxPagesPerRequest;
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const lockOwner = opts.lockOwner ?? crypto.randomUUID();

	await cleanupExpiredDiscoverProviderRows(env.DB, now);

	let record = await getDiscoverProviderCache(env.DB, cacheKey, now);
	let warning: string | undefined;

	const apiKey = env.YOUTUBE_API_KEY;
	const yt =
		opts.youtubeClient ?? (apiKey ? createYoutubeApiKeyClient(apiKey) : undefined);

	// Reprocess cached raw Brave hits when resolver improved or prior resolution failed — 0 Brave cost.
	if (record && record.rawResults.length > 0 && needsCandidateReprocess(record) && yt) {
		const resolved = await resolveBraveHitsToChannels(yt, record.rawResults);
		funnel.youtubeVideosListCalls += resolved.stats.videosListCalls;
		funnel.youtubeChannelsListCalls += resolved.stats.channelsListCalls;
		funnel.youtubeSearchListCalls += resolved.stats.searchListCalls;
		funnel.resolvedChannels += resolved.stats.resolvedChannels;
		record =
			(await updateDiscoverProviderResolvedCandidates(
				env.DB,
				cacheKey,
				{
					candidates: resolved.candidates,
					resolverVersion: DISCOVER_CANDIDATE_RESOLVER_VERSION,
					resolutionStatus: resolved.resolutionStatus,
					ttlMs:
						resolved.resolutionStatus === 'failed'
							? DISCOVER_PROVIDER_FAILED_TTL_MS
							: DISCOVER_PROVIDER_CACHE_TTL_MS,
				},
				now,
			)) ?? record;
		if (resolved.resolutionStatus === 'failed') {
			warning = resolved.errorMessage ?? 'YouTube channel verification failed.';
		}
	}

	if (record && !record.stale && record.candidates.length > 0 && !needsCandidateReprocess(record)) {
		funnel.cacheHit = true;
		await recordBraveCacheHit(env.DB, userId);
		const usable = filterForUser(record.candidates, subscribed, normalized, funnel);
		const needMoreFromProvider = usable.length < needCount && record.moreResultsAvailable;
		if (!needMoreFromProvider) {
			funnel.stopReason = usable.length ? 'cache_satisfied' : 'cache_empty_after_filters';
			if (yt) await recordYoutubeCalls(env.DB, yt);
			const page = pageFromUsable(usable, subscribed, offset, limit, false);
			return {
				...page,
				cached: true,
				searchedAt: record.searchedAt,
				warning,
				funnel: opts.includeDebug ? funnel : undefined,
			};
		}
	} else {
		funnel.cacheMiss = true;
		await recordBraveCacheMiss(env.DB, userId);
	}

	if (!config.apiKey) {
		if (record) {
			const usable = filterForUser(record.candidates, subscribed, normalized, funnel);
			if (yt) await recordYoutubeCalls(env.DB, yt);
			return {
				...pageFromUsable(usable, subscribed, offset, limit, false),
				cached: true,
				searchedAt: record.searchedAt,
				warning: 'Brave Search API key is not configured. Showing cached results.',
				funnel: opts.includeDebug ? funnel : undefined,
			};
		}
		return {
			results: [],
			cached: false,
			searchedAt: now.toISOString(),
			hasMore: false,
			nextOffset: offset,
			warning: 'Brave Discover search is unavailable (API key not configured).',
			funnel: opts.includeDebug ? { ...funnel, stopReason: 'missing_api_key' } : undefined,
		};
	}

	if (!yt) {
		if (record) {
			const usable = filterForUser(record.candidates, subscribed, normalized, funnel);
			return {
				...pageFromUsable(usable, subscribed, offset, limit, false),
				cached: true,
				searchedAt: record.searchedAt,
				warning: 'YouTube API key is not configured for channel verification. Showing cached results.',
				funnel: opts.includeDebug ? funnel : undefined,
			};
		}
		return {
			results: [],
			cached: false,
			searchedAt: now.toISOString(),
			hasMore: false,
			nextOffset: offset,
			warning: 'YouTube verification is unavailable (API key not configured).',
			funnel: opts.includeDebug ? { ...funnel, stopReason: 'missing_youtube_key' } : undefined,
		};
	}

	const provider =
		opts.provider ??
		new BraveSearchProvider({
			apiKey: config.apiKey,
			timeoutMs: config.timeoutMs,
			strategyVersion,
		});

	let pagesFetched = 0;
	let lastError: string | undefined;

	while (pagesFetched < maxPages) {
		const currentUsable = filterForUser(record?.candidates ?? [], subscribed, normalized, emptyFunnel());
		if (currentUsable.length >= needCount) {
			funnel.stopReason = 'limit_satisfied';
			break;
		}
		if (
			record &&
			!record.moreResultsAvailable &&
			record.rawResults.length > 0 &&
			!record.stale &&
			!needsCandidateReprocess(record)
		) {
			funnel.stopReason = 'provider_exhausted';
			break;
		}

		const usage = await braveUsageStatus(env.DB, userId, config);
		if (!usage.canCallBrave) {
			funnel.stopReason = usage.blockReason;
			warning =
				usage.blockReason === 'global_cap'
					? 'Brave daily global soft cap reached. Showing available results.'
					: 'Brave daily per-user soft cap reached. Showing available results.';
			break;
		}

		const nextOffset =
			record && !record.stale && record.rawResults.length > 0 ? record.providerOffset + 1 : 0;
		if (nextOffset > 9) {
			funnel.stopReason = 'provider_offset_cap';
			break;
		}

		const acquired = await tryAcquireDiscoverProviderLock(env.DB, cacheKey, lockOwner, undefined, now);
		if (!acquired) {
			const refreshed = await getDiscoverProviderCache(env.DB, cacheKey, now);
			if (refreshed && refreshed.candidates.length > (record?.candidates.length ?? 0)) {
				record = refreshed;
				continue;
			}
			funnel.stopReason = 'lock_busy';
			warning = warning ?? 'Discover provider refresh already in progress.';
			break;
		}

		try {
			await recordBraveApiRequest(env.DB, userId);
			const page = await provider.search({
				contentType: 'youtube',
				query: normalized,
				offset: nextOffset,
				count: 20,
				strategyVersion,
			});
			pagesFetched += 1;
			funnel.bravePagesFetched = pagesFetched;
			funnel.rawBraveResults += page.hits.length;

			if (page.hits.length === 0) {
				await recordBraveZeroResultSearch(env.DB, userId);
			}

			const resolved = await resolveBraveHitsToChannels(yt, page.hits);
			const pageCandidates = resolved.candidates;
			const stats = resolved.stats;
			funnel.validYoutubeUrls += stats.validYoutubeUrls;
			funnel.channelUrls += stats.channelUrls;
			funnel.videoUrls += stats.videoUrls;
			funnel.customUrls = (funnel.customUrls ?? 0) + stats.customUrls;
			funnel.resolvedChannels += stats.resolvedChannels;
			funnel.unresolvedResults += stats.unresolvedResults;
			funnel.duplicateChannels += stats.duplicateChannels;
			funnel.youtubeVideosListCalls += stats.videosListCalls;
			funnel.youtubeChannelsListCalls += stats.channelsListCalls;
			funnel.youtubeSearchListCalls += stats.searchListCalls;

			const mergedCandidates = mergeCandidates(record?.candidates ?? [], pageCandidates);
			const mergedRaw = [...(record?.rawResults ?? [])];
			const seenUrls = new Set(mergedRaw.map((h) => h.url));
			for (const hit of page.hits) {
				if (seenUrls.has(hit.url)) continue;
				seenUrls.add(hit.url);
				mergedRaw.push(hit);
			}

			const resolutionStatus =
				resolved.resolutionStatus === 'failed'
					? 'failed'
					: mergedCandidates.length > 0
						? 'ok'
						: 'empty_legitimate';
			const ttlMs =
				resolutionStatus === 'failed' ? DISCOVER_PROVIDER_FAILED_TTL_MS : DISCOVER_PROVIDER_CACHE_TTL_MS;

			record = await putDiscoverProviderCache(
				env.DB,
				{
					provider: 'brave',
					contentType: 'youtube',
					normalizedQuery: normalized,
					strategyVersion,
					rawResults: mergedRaw,
					candidates: mergedCandidates,
					providerOffset: nextOffset,
					moreResultsAvailable: page.moreAvailable,
					candidateConsumeOffset: record?.candidateConsumeOffset ?? 0,
					resolverVersion: DISCOVER_CANDIDATE_RESOLVER_VERSION,
					resolutionStatus,
				},
				ttlMs,
				now,
			);

			if (resolved.resolutionStatus === 'failed') {
				warning = resolved.errorMessage ?? 'YouTube channel verification failed.';
				funnel.stopReason = 'youtube_resolve_failed';
				break;
			}

			if (!page.moreAvailable) {
				funnel.stopReason = 'provider_exhausted';
				break;
			}
		} catch (err) {
			await recordBraveApiError(env.DB, userId);
			lastError = err instanceof Error ? err.message : String(err);
			funnel.stopReason = 'provider_error';
			if (record) {
				warning = `Brave search failed. Showing cached results.`;
			} else {
				warning = lastError;
			}
			break;
		} finally {
			await releaseDiscoverProviderLock(env.DB, cacheKey, lockOwner);
		}
	}

	await recordYoutubeCalls(env.DB, yt);

	// Final user filter pass with accurate funnel counts
	const filterFunnel = emptyFunnel();
	const usable = filterForUser(record?.candidates ?? [], subscribed, normalized, filterFunnel);
	funnel.subscribedFiltered = filterFunnel.subscribedFiltered;
	funnel.qualityRejected = filterFunnel.qualityRejected;
	funnel.usableCandidates = filterFunnel.usableCandidates;
	if (!funnel.stopReason) funnel.stopReason = usable.length ? 'completed' : 'no_usable_candidates';

	if (usable.length === 0 && pagesFetched > 0) {
		await recordBraveZeroResultSearch(env.DB, userId);
	}
	const page = pageFromUsable(
		usable,
		subscribed,
		offset,
		limit,
		Boolean(record?.moreResultsAvailable),
	);
	if (page.results.length > 0) {
		await recordBraveUsableCandidates(env.DB, userId, page.results.length);
	}

	return {
		...page,
		cached: pagesFetched === 0,
		searchedAt: record?.searchedAt ?? now.toISOString(),
		warning,
		funnel: opts.includeDebug ? funnel : undefined,
	};
}

/** Test helper: append page candidates without Brave (keeps pagination cursor semantics). */
export async function appendResolvedCandidatesForTests(
	env: Env,
	cacheKey: string,
	page: Parameters<typeof appendDiscoverProviderCachePage>[2],
	now = new Date(),
) {
	return appendDiscoverProviderCachePage(env.DB, cacheKey, page, undefined, now);
}
