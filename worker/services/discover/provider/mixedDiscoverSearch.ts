import type { DiscoverSearchResponse, DiscoveryResult } from '../../../../src/types/discover';
import { DEFAULT_TYPED_BRAVE_RESULT_LIMIT, braveDiscoverConfigFromEnv } from './braveConfig';
import {
	buildMixedAllTelemetry,
	formatMixedRankingDiagnostics,
	logMixedAllTelemetry,
	rankMixedDiscoverCandidates,
	type MixedAllTelemetry,
	type MixedRankCandidate,
	type MixedRankedItem,
} from './mixedDiscoverRank';
import type { PodcastDiscoverCandidate } from './podcastDiscoveryProvider';
import { explainDiscoverTextMatch } from './scoreDiscoverTextMatch';
import { searchPodcastsDiscover } from './typedPodcastDiscoverSearch';
import { searchYoutubeDiscoverViaBrave } from './typedBraveDiscoverSearch';
import { searchYoutubeDiscover } from '../youtube';

export interface MixedDiscoverSearchOptions {
	offset?: number;
	limit?: number;
	now?: Date;
	includeDebug?: boolean;
}

export interface MixedDiscoverSearchResult extends DiscoverSearchResponse {
	mixedTelemetry?: MixedAllTelemetry;
	mixedDiagnostics?: string;
	rankedPage?: MixedRankedItem[];
	/** Full ranked pool (debug/tests only). */
	rankedAll?: MixedRankedItem[];
}

function youtubeResultToMixed(
	result: DiscoveryResult,
	query: string,
	providerRank: number,
): MixedRankCandidate | null {
	if (result.provider !== 'youtube' || result.type !== 'channel') return null;
	if (!result.externalId?.startsWith('UC')) return null;
	const explanation = explainDiscoverTextMatch(query, {
		title: result.title,
		description: result.description,
		publisher: result.publisher,
		providerRank,
	});
	return {
		contentType: 'youtube',
		canonicalId: result.externalId,
		relevance: explanation.score,
		providerRank,
		titleMatch: explanation.titleMatch,
		explanation,
		result,
	};
}

function podcastCandidateToMixed(
	c: PodcastDiscoverCandidate,
	query: string,
	providerRank: number,
): MixedRankCandidate {
	const explanation = explainDiscoverTextMatch(query, {
		title: c.title,
		description: c.description,
		publisher: c.publisher,
		genres: c.genres,
		providerRank,
	});
	return {
		contentType: 'podcast',
		canonicalId: c.feedUrlNormalized,
		relevance: explanation.score,
		providerRank,
		titleMatch: explanation.titleMatch,
		explanation,
		result: {
			provider: 'podcast',
			type: 'podcast',
			externalId: c.providerExternalId,
			title: c.title,
			description: c.description,
			imageUrl: c.imageUrl ?? '',
			publisher: c.publisher ?? '',
			feedUrl: c.feedUrl,
			subscribed: false,
			watchUrl: c.websiteUrl,
		},
	};
}

function dedupeMixed(candidates: MixedRankCandidate[]): MixedRankCandidate[] {
	const seen = new Set<string>();
	const out: MixedRankCandidate[] = [];
	for (const c of candidates) {
		const key = `${c.contentType}:${c.canonicalId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(c);
	}
	return out;
}

/**
 * Typed Discover `All`: concurrent YouTube + podcast pools → mixed relevance rank → page.
 * Independent provider caches; mixed list is recomputed (not cached).
 */
export async function searchMixedDiscoverAll(
	env: Env,
	userId: string,
	query: string,
	opts: MixedDiscoverSearchOptions = {},
): Promise<MixedDiscoverSearchResult> {
	const now = opts.now ?? new Date();
	const offset = Math.max(0, Math.floor(opts.offset ?? 0));
	const config = braveDiscoverConfigFromEnv(env);
	const limit = opts.limit ?? config.typedResultLimit ?? DEFAULT_TYPED_BRAVE_RESULT_LIMIT;
	const needCount = offset + limit;
	const warnings: DiscoverSearchResponse['warnings'] = [];
	const useBrave = (env.DISCOVER_SEARCH_PROVIDER ?? 'youtube').trim().toLowerCase() === 'brave';

	const ytPromise = useBrave
		? searchYoutubeDiscoverViaBrave(env, userId, query, {
				now,
				offset: 0,
				// Expand Brave only until we have enough usable for this mixed page window.
				limit: needCount,
				returnFullUsablePool: true,
				includeDebug: opts.includeDebug,
			})
		: searchYoutubeDiscover(env, userId, query, now, { offset: 0, limit: needCount });

	const podPromise = searchPodcastsDiscover(env, userId, query, {
		now,
		offset: 0,
		limit: 200,
	});

	const [ytSettled, podSettled] = await Promise.allSettled([ytPromise, podPromise]);

	let youtubeFailed = false;
	let podcastFailed = false;
	let yt: Awaited<typeof ytPromise> | null = null;
	let pod: Awaited<typeof podPromise> | null = null;

	if (ytSettled.status === 'fulfilled') {
		yt = ytSettled.value;
		if (yt.warning) warnings.push({ provider: 'youtube', message: yt.warning });
	} else {
		youtubeFailed = true;
		warnings.push({
			provider: 'youtube',
			message: ytSettled.reason instanceof Error ? ytSettled.reason.message : 'YouTube search failed.',
		});
	}

	if (podSettled.status === 'fulfilled') {
		pod = podSettled.value;
		if (pod.warning) {
			warnings.push({ provider: 'podcast', message: pod.warning });
			if (pod.candidates.length === 0) podcastFailed = true;
		}
	} else {
		podcastFailed = true;
		warnings.push({
			provider: 'podcast',
			message: podSettled.reason instanceof Error ? podSettled.reason.message : 'Podcast search failed.',
		});
	}

	if (youtubeFailed && podcastFailed) {
		return {
			query: query.trim(),
			filter: 'all',
			results: [],
			warnings,
			cached: false,
			searchedAt: now.toISOString(),
			hasMore: false,
			nextOffset: offset,
		};
	}

	const youtubePool: MixedRankCandidate[] = [];
	if (yt) {
		yt.results.forEach((r, i) => {
			const mixed = youtubeResultToMixed(r, query, i);
			if (mixed) youtubePool.push(mixed);
		});
	}

	const podcastPool: MixedRankCandidate[] = [];
	if (pod) {
		pod.candidates.forEach((c, i) => {
			podcastPool.push(podcastCandidateToMixed(c, query, i));
		});
	}

	const pooled = dedupeMixed([...youtubePool, ...podcastPool]);
	const { items: ranked, diversityPromotions } = rankMixedDiscoverCandidates(pooled);
	const pageItems = ranked.slice(offset, offset + limit);
	const results = pageItems.map((item) => item.result);

	const unusedAfterPage = ranked.length > offset + pageItems.length;
	const moreFromYoutubeProvider = Boolean(yt && 'hasMore' in yt && yt.hasMore);
	const moreFromPodcastProvider = Boolean(pod?.hasMore);
	const finalHasMore = unusedAfterPage || moreFromYoutubeProvider || moreFromPodcastProvider;

	const youtubeCacheHit = Boolean(yt?.cached);
	const podcastCacheHit = Boolean(pod?.cached);
	const youtubeExternalRequests = (() => {
		if (!yt || youtubeFailed) return 0;
		const funnel = 'funnel' in yt ? (yt as { funnel?: { bravePagesFetched?: number } }).funnel : undefined;
		if (typeof funnel?.bravePagesFetched === 'number') return funnel.bravePagesFetched;
		return youtubeCacheHit ? 0 : 1;
	})();
	const podcastExternalRequests = pod?.providerRequests ?? 0;

	const telemetry = buildMixedAllTelemetry({
		query: query.trim(),
		youtubePool,
		podcastPool,
		page: pageItems,
		youtubeCacheHit,
		podcastCacheHit,
		youtubeExternalRequests,
		podcastExternalRequests,
		youtubeFailed,
		podcastFailed,
		diversityPromotions,
	});
	logMixedAllTelemetry(env, telemetry);

	const includeDebug = Boolean(opts.includeDebug) || env.DISCOVER_RELEVANCE_DEBUG === 'true';

	return {
		query: query.trim(),
		filter: 'all',
		results,
		warnings,
		cached: youtubeCacheHit && podcastCacheHit && !youtubeFailed && !podcastFailed,
		searchedAt: yt?.searchedAt ?? pod?.searchedAt ?? now.toISOString(),
		hasMore: finalHasMore,
		nextOffset: offset + pageItems.length,
		mixedTelemetry: includeDebug ? telemetry : undefined,
		mixedDiagnostics: includeDebug
			? formatMixedRankingDiagnostics(query.trim(), ranked.slice(0, Math.max(needCount, 20)))
			: undefined,
		rankedPage: pageItems,
		rankedAll: includeDebug ? ranked : undefined,
	};
}
