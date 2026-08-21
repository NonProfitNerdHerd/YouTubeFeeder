import type { DiscoveryResult } from '../../../../src/types/discover';
import {
	explainDiscoverTextMatch,
	formatDiscoverTextMatchExplanation,
	TITLE_MATCH_CLASS_RANK,
	type DiscoverTextMatchExplanation,
	type TitleMatchClass,
} from './scoreDiscoverTextMatch';

export type MixedContentType = 'youtube' | 'podcast';

export interface MixedRankCandidate {
	contentType: MixedContentType;
	/** Canonical id: YouTube channel ID or feedUrlNormalized. */
	canonicalId: string;
	relevance: number;
	/** 0-based order within provider pool (stable secondary). */
	providerRank: number;
	titleMatch?: TitleMatchClass;
	explanation?: DiscoverTextMatchExplanation;
	result: DiscoveryResult;
}

export interface MixedRankOptions {
	/** Soft diversity: last N same-type triggers alternate look-ahead. Default 3. */
	diversityWindow?: number;
	/**
	 * Soft diversity: alternate may leapfrog only when
	 * (nextSameType.relevance - alternate.relevance) <= delta.
	 * Default 8.
	 */
	diversityDelta?: number;
}

export interface MixedRankedItem extends MixedRankCandidate {
	/** Position after soft diversity (0-based). */
	finalPosition: number;
	/** True when soft diversity moved this item ahead of a same-type peer. */
	diversityPromoted: boolean;
	/** Pre-diversity index in relevance-sorted list (0-based). */
	preDiversityIndex: number;
	originalIndex: number;
	diversityNote: string;
}

export interface MixedRankResult {
	items: MixedRankedItem[];
	diversityPromotions: number;
}

export const DEFAULT_MIXED_DIVERSITY_WINDOW = 3;
export const DEFAULT_MIXED_DIVERSITY_DELTA = 8;

/** Deterministic compare for equal-relevance candidates. */
export function compareMixedTieBreak(a: MixedRankCandidate, b: MixedRankCandidate): number {
	const classA = TITLE_MATCH_CLASS_RANK[a.titleMatch ?? 'none'];
	const classB = TITLE_MATCH_CLASS_RANK[b.titleMatch ?? 'none'];
	if (classB !== classA) return classB - classA;
	if (a.providerRank !== b.providerRank) return a.providerRank - b.providerRank;
	const titleCmp = a.result.title.localeCompare(b.result.title);
	if (titleCmp !== 0) return titleCmp;
	const typeCmp = a.contentType.localeCompare(b.contentType);
	if (typeCmp !== 0) return typeCmp;
	return a.canonicalId.localeCompare(b.canonicalId);
}

/**
 * Soft diversity rule (deterministic, symmetric across content types):
 *
 * After sorting by relevance desc → title-match class → providerRank → title → type → id:
 * While building the final list, if the last `diversityWindow` items are the same
 * content type AND the next pick is also that type AND there exists a later
 * alternate-type candidate whose relevance is within `diversityDelta` of that
 * next same-type candidate, promote the alternate once.
 *
 * Does not promote clearly inferior results (outside the delta).
 * Does not force alternation or equal quotas.
 * Identical rule for YouTube-runs and podcast-runs.
 */
export function rankMixedDiscoverCandidates(
	candidates: MixedRankCandidate[],
	opts: MixedRankOptions = {},
): MixedRankResult {
	const window = opts.diversityWindow ?? DEFAULT_MIXED_DIVERSITY_WINDOW;
	const delta = opts.diversityDelta ?? DEFAULT_MIXED_DIVERSITY_DELTA;

	const sorted = [...candidates].sort((a, b) => {
		if (b.relevance !== a.relevance) return b.relevance - a.relevance;
		return compareMixedTieBreak(a, b);
	});

	const remaining = sorted.map((c, originalIndex) => ({
		...c,
		originalIndex,
		preDiversityIndex: originalIndex,
		diversityPromoted: false,
		diversityNote: 'none',
	}));
	const out: MixedRankedItem[] = [];
	let diversityPromotions = 0;

	while (remaining.length > 0) {
		const last = out.slice(-window);
		const mono =
			last.length === window && last.every((item) => item.contentType === last[0]!.contentType)
				? last[0]!.contentType
				: null;

		let pickIndex = 0;
		if (mono && remaining[0]!.contentType === mono) {
			const nextSame = remaining[0]!;
			const altIndex = remaining.findIndex(
				(c) => c.contentType !== mono && nextSame.relevance - c.relevance <= delta,
			);
			if (altIndex > 0) {
				pickIndex = altIndex;
				diversityPromotions += 1;
			}
		}

		const fromIndex = remaining[pickIndex]!.preDiversityIndex;
		const [picked] = remaining.splice(pickIndex, 1);
		const finalPosition = out.length;
		const diversityNote =
			pickIndex > 0 ? `promoted from ${fromIndex + 1} → ${finalPosition + 1}` : 'none';
		out.push({
			...picked!,
			diversityPromoted: pickIndex > 0,
			diversityNote,
			finalPosition,
		});
	}

	return { items: out, diversityPromotions };
}

/** Dev/test diagnostic lines — not for production UI. */
export function formatMixedRankingDiagnostics(query: string, items: MixedRankedItem[]): string {
	const lines = [`Search: ${query}`, ''];
	for (const item of items) {
		const type = item.contentType === 'youtube' ? 'YT' : 'PODCAST';
		const div = item.diversityPromoted ? ` [${item.diversityNote}]` : '';
		const match = item.titleMatch ? ` (${item.titleMatch})` : '';
		lines.push(
			`${String(item.relevance).padStart(3)} ${type.padEnd(8)} ${item.result.title}${match}${div}`,
		);
	}
	return lines.join('\n');
}

export function formatMixedCandidateExplanation(item: MixedRankedItem): string {
	const explanation =
		item.explanation ??
		explainDiscoverTextMatch('', { title: item.result.title });
	const typeLabel = item.contentType === 'youtube' ? 'YouTube' : 'Podcast';
	return formatDiscoverTextMatchExplanation(
		item.result.title,
		typeLabel,
		explanation,
		item.diversityNote,
	);
}

export interface MixedAllTelemetry {
	query: string;
	youtubeCandidatesAvailable: number;
	podcastCandidatesAvailable: number;
	youtubeCandidatesReturned: number;
	podcastCandidatesReturned: number;
	youtubeRelevanceHigh: number | null;
	youtubeRelevanceLow: number | null;
	podcastRelevanceHigh: number | null;
	podcastRelevanceLow: number | null;
	youtubeCacheHit: boolean;
	podcastCacheHit: boolean;
	youtubeExternalRequests: number;
	podcastExternalRequests: number;
	youtubeFailed: boolean;
	podcastFailed: boolean;
	diversityPromotions: number;
	distinctScoresInTop10?: number;
}

export function buildMixedAllTelemetry(input: {
	query: string;
	youtubePool: MixedRankCandidate[];
	podcastPool: MixedRankCandidate[];
	page: MixedRankedItem[];
	youtubeCacheHit: boolean;
	podcastCacheHit: boolean;
	youtubeExternalRequests: number;
	podcastExternalRequests: number;
	youtubeFailed: boolean;
	podcastFailed: boolean;
	diversityPromotions: number;
}): MixedAllTelemetry {
	const ytPage = input.page.filter((i) => i.contentType === 'youtube');
	const podPage = input.page.filter((i) => i.contentType === 'podcast');
	const ytScores = ytPage.map((i) => i.relevance);
	const podScores = podPage.map((i) => i.relevance);
	const top10Scores = input.page.slice(0, 10).map((i) => i.relevance);
	return {
		query: input.query,
		youtubeCandidatesAvailable: input.youtubePool.length,
		podcastCandidatesAvailable: input.podcastPool.length,
		youtubeCandidatesReturned: ytPage.length,
		podcastCandidatesReturned: podPage.length,
		youtubeRelevanceHigh: ytScores.length ? Math.max(...ytScores) : null,
		youtubeRelevanceLow: ytScores.length ? Math.min(...ytScores) : null,
		podcastRelevanceHigh: podScores.length ? Math.max(...podScores) : null,
		podcastRelevanceLow: podScores.length ? Math.min(...podScores) : null,
		youtubeCacheHit: input.youtubeCacheHit,
		podcastCacheHit: input.podcastCacheHit,
		youtubeExternalRequests: input.youtubeExternalRequests,
		podcastExternalRequests: input.podcastExternalRequests,
		youtubeFailed: input.youtubeFailed,
		podcastFailed: input.podcastFailed,
		diversityPromotions: input.diversityPromotions,
		distinctScoresInTop10: new Set(top10Scores).size,
	};
}

export function logMixedAllTelemetry(env: Env, telemetry: MixedAllTelemetry): void {
	if (env.DISCOVER_RELEVANCE_DEBUG !== 'true') return;
	console.log('[discover-mixed]', JSON.stringify(telemetry));
}
