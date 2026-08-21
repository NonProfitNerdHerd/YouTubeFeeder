import type { DiscoveryResult } from '../../../../src/types/discover';
import {
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
import { recordYoutubeCalls } from '../../websub';
import { createYoutubeApiKeyClient, type YoutubeClient } from '../../youtube';
import {
	braveUsageStatus,
	recordBraveApiError,
	recordBraveApiRequest,
	recordBraveCacheHit,
	recordBraveCacheMiss,
	recordBraveZeroResultSearch,
} from '../braveQuota';
import { normalizeDiscoverQuery } from '../youtube';
import { braveDiscoverConfigFromEnv, type BraveDiscoverConfig } from './braveConfig';
import { BraveSearchProvider } from './braveSearchProvider';
import {
	DISCOVER_CANDIDATE_RESOLVER_VERSION,
	needsCandidateReprocess,
	resolveBraveHitsToChannels,
} from './youtubeBatchResolve';
import type {
	DiscoverProviderCacheRecord,
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

export function providerCandidatesToDiscoveryResults(
	candidates: DiscoveryProviderCandidate[],
): DiscoveryResult[] {
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

export interface EnsureBraveProviderPoolOptions {
	allowRefresh?: boolean;
	/** Max Brave HTTP pages this call may fetch (default from config). */
	maxPages?: number;
	/** Keep fetching while resolved channel count is below this (and more pages exist). */
	minResolvedCandidates?: number;
	now?: Date;
	config?: BraveDiscoverConfig;
	provider?: DiscoverySearchProvider;
	youtubeClient?: YoutubeClient;
	lockOwner?: string;
	/** When true, force at least one next-page fetch if more_results_available. */
	forceNextPage?: boolean;
}

export interface EnsureBraveProviderPoolResult {
	record: DiscoverProviderCacheRecord | null;
	pagesFetched: number;
	refreshed: boolean;
	warning?: string;
	funnel: TypedBraveSearchFunnel;
	normalizedQuery: string;
	cacheKey: string;
}

/**
 * Shared Brave provider pool filler for typed search and For You topic discovery.
 * Uses cache key brave:youtube:{strategy}:{normalizeDiscoverQuery(query)} so typed/topic can share.
 * Never calls YouTube search.list.
 */
export async function ensureBraveProviderPool(
	env: Env,
	userId: string,
	query: string,
	opts: EnsureBraveProviderPoolOptions = {},
): Promise<EnsureBraveProviderPoolResult> {
	const now = opts.now ?? new Date();
	const config = opts.config ?? braveDiscoverConfigFromEnv(env);
	const normalizedQuery = normalizeDiscoverQuery(query);
	const funnel = emptyFunnel();
	const cacheKey = discoverProviderCacheKey('brave', 'youtube', config.strategyVersion, normalizedQuery);
	if (!normalizedQuery) {
		return { record: null, pagesFetched: 0, refreshed: false, funnel, normalizedQuery, cacheKey };
	}

	const allowRefresh = opts.allowRefresh ?? true;
	const maxPages = opts.maxPages ?? config.maxPagesPerRequest;
	const minResolved = opts.minResolvedCandidates ?? 1;
	const lockOwner = opts.lockOwner ?? crypto.randomUUID();

	await cleanupExpiredDiscoverProviderRows(env.DB, now);
	let record = await getDiscoverProviderCache(env.DB, cacheKey, now);

	const ytKey = env.YOUTUBE_API_KEY;
	const ytEarly = opts.youtubeClient ?? (ytKey ? createYoutubeApiKeyClient(ytKey) : undefined);
	if (record && record.rawResults.length > 0 && needsCandidateReprocess(record) && ytEarly) {
		const resolved = await resolveBraveHitsToChannels(ytEarly, record.rawResults);
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
			funnel.stopReason = 'youtube_resolve_failed';
			await recordYoutubeCalls(env.DB, ytEarly);
			return {
				record,
				pagesFetched: 0,
				refreshed: false,
				warning: resolved.errorMessage,
				funnel,
				normalizedQuery,
				cacheKey,
			};
		}
	}

	const freshEnough =
		record &&
		!record.stale &&
		record.candidates.length >= minResolved &&
		!opts.forceNextPage &&
		!needsCandidateReprocess(record);

	if (freshEnough) {
		funnel.cacheHit = true;
		await recordBraveCacheHit(env.DB, userId);
		funnel.usableCandidates = record!.candidates.length;
		funnel.stopReason = 'cache_satisfied';
		return { record, pagesFetched: 0, refreshed: false, funnel, normalizedQuery, cacheKey };
	}

	if (record && !record.stale && !opts.forceNextPage && !allowRefresh) {
		funnel.cacheHit = true;
		await recordBraveCacheHit(env.DB, userId);
		funnel.stopReason = 'cache_only';
		return { record, pagesFetched: 0, refreshed: false, funnel, normalizedQuery, cacheKey };
	}

	funnel.cacheMiss = !record || record.stale || Boolean(opts.forceNextPage);
	if (funnel.cacheMiss) await recordBraveCacheMiss(env.DB, userId);

	if (!allowRefresh) {
		funnel.stopReason = 'refresh_disallowed';
		return { record, pagesFetched: 0, refreshed: false, funnel, normalizedQuery, cacheKey };
	}

	if (!config.apiKey) {
		return {
			record,
			pagesFetched: 0,
			refreshed: false,
			warning: record
				? 'Brave Search API key is not configured. Showing cached results.'
				: 'Brave Discover search is unavailable (API key not configured).',
			funnel: { ...funnel, stopReason: 'missing_api_key' },
			normalizedQuery,
			cacheKey,
		};
	}

	if (!ytKey && !opts.youtubeClient) {
		return {
			record,
			pagesFetched: 0,
			refreshed: false,
			warning: record
				? 'YouTube API key is not configured for channel verification. Showing cached results.'
				: 'YouTube verification is unavailable (API key not configured).',
			funnel: { ...funnel, stopReason: 'missing_youtube_key' },
			normalizedQuery,
			cacheKey,
		};
	}

	const yt = ytEarly ?? createYoutubeApiKeyClient(ytKey!);
	const provider =
		opts.provider ??
		new BraveSearchProvider({
			apiKey: config.apiKey,
			timeoutMs: config.timeoutMs,
			strategyVersion: config.strategyVersion,
		});

	let pagesFetched = 0;
	let warning: string | undefined;
	let refreshed = false;

	while (pagesFetched < maxPages) {
		const resolvedCount = record?.candidates.length ?? 0;
		const fresh = Boolean(record && !record.stale);
		const moreAvailable = Boolean(record?.moreResultsAvailable);
		const needMoreResolved = resolvedCount < minResolved;
		const wantForcedPage = Boolean(opts.forceNextPage) && pagesFetched === 0;

		if (fresh && !needMoreResolved && !wantForcedPage) {
			funnel.stopReason = 'limit_satisfied';
			break;
		}
		if (fresh && !moreAvailable && record!.rawResults.length > 0) {
			// Pool exists and Brave reports no further pages.
			if (!needMoreResolved || pagesFetched > 0 || !wantForcedPage) {
				funnel.stopReason = 'provider_exhausted';
				break;
			}
			// wantForcedPage with exhausted pool — nothing to fetch.
			if (wantForcedPage && !moreAvailable) {
				funnel.stopReason = 'provider_exhausted';
				break;
			}
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
			const refreshedRow = await getDiscoverProviderCache(env.DB, cacheKey, now);
			if (refreshedRow && refreshedRow.candidates.length > (record?.candidates.length ?? 0)) {
				record = refreshedRow;
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
				query: normalizedQuery,
				offset: nextOffset,
				count: 20,
				strategyVersion: config.strategyVersion,
			});
			pagesFetched += 1;
			refreshed = true;
			funnel.bravePagesFetched = pagesFetched;
			funnel.rawBraveResults += page.hits.length;

			if (page.hits.length === 0) await recordBraveZeroResultSearch(env.DB, userId);

			const resolved = await resolveBraveHitsToChannels(yt, page.hits);
			const pageCandidates = resolved.candidates;
			const stats = resolved.stats;
			funnel.validYoutubeUrls += stats.validYoutubeUrls;
			funnel.channelUrls += stats.channelUrls;
			funnel.videoUrls += stats.videoUrls;
			funnel.customUrls += stats.customUrls;
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
					normalizedQuery,
					strategyVersion: config.strategyVersion,
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
				funnel.stopReason = 'youtube_resolve_failed';
				warning = resolved.errorMessage ?? 'YouTube channel verification failed.';
				break;
			}

			if (!page.moreAvailable) {
				funnel.stopReason = 'provider_exhausted';
				break;
			}
			if (opts.forceNextPage && pagesFetched >= 1) {
				funnel.stopReason = 'next_page_fetched';
				break;
			}
			if (record.candidates.length >= minResolved) {
				funnel.stopReason = 'limit_satisfied';
				break;
			}
		} catch (err) {
			await recordBraveApiError(env.DB, userId);
			funnel.stopReason = 'provider_error';
			warning = record
				? 'Brave search failed. Showing cached results.'
				: err instanceof Error
					? err.message
					: 'Brave search failed.';
			break;
		} finally {
			await releaseDiscoverProviderLock(env.DB, cacheKey, lockOwner);
		}
	}

	await recordYoutubeCalls(env.DB, yt);
	funnel.usableCandidates = record?.candidates.length ?? 0;
	if (!funnel.stopReason) funnel.stopReason = refreshed ? 'completed' : 'no_fetch';

	return { record, pagesFetched, refreshed, warning, funnel, normalizedQuery, cacheKey };
}
