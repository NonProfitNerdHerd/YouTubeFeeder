import type { DiscoverRecommendation, DiscoveryResult } from '../../../src/types/discover';
import { getSubscribedChannelIds } from '../../db/queries';
import {
	MIN_ACCEPT_SCORE,
	MIN_EXPAND_SCORE,
	scoreCandidateAgainstFingerprint,
	scoreCandidatesForInterest,
	type CandidateScoreDebug,
	type ScoredCandidate,
} from './candidateScoring';
import { buildInterestFingerprints, isInterestFingerprintEmpty, type InterestFingerprint } from './interestFingerprint';
import { buildInterestSearchQuery, interestQueryCacheKey } from './queryConstruction';
import {
	fetchNextInterestPage,
	getInterestNextPageToken,
	getTopicCandidates,
	loadCachedQueryResults,
	refreshQueryCaches,
} from './topicDiscovery';

export const FOR_YOU_PAGE_SIZE = 25;
const INTERESTS_FOR_REFRESH = 2;
const INTERESTS_TO_MERGE = 12;

export interface ForYouMetrics {
	retrieved: number;
	rejected: number;
	accepted: number;
	interestsRepresented: number;
	searchCalls: number;
}

export interface ForYouInterest {
	id: string;
	label: string;
	confidence: number;
}

export interface ForYouBuildOpts {
	interestId?: string;
	includeDebug?: boolean;
	limit?: number;
	offset?: number;
	loadMore?: boolean;
	refreshOffset?: number;
}

export interface ForYouResult {
	forYou: DiscoverRecommendation[];
	forYouTotal: number;
	forYouHasMore: boolean;
	forYouInterests: ForYouInterest[];
	forYouEmpty: boolean;
	forYouMessage?: string;
	metrics: ForYouMetrics;
	debug?: CandidateScoreDebug[];
}

function dedupeScored(scored: ScoredCandidate[]): ScoredCandidate[] {
	const byId = new Map<string, ScoredCandidate>();
	for (const row of scored) {
		const existing = byId.get(row.result.externalId);
		if (!existing || row.score > existing.score) {
			byId.set(row.result.externalId, row);
		}
	}
	return [...byId.values()].sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title));
}

function toRecommendation(row: ScoredCandidate): DiscoverRecommendation {
	return {
		...row.result,
		subscribed: false,
		recommendationReason: row.recommendationReason,
		interestId: row.interestId,
	};
}

function scoreFingerprintCandidates(
	fingerprint: InterestFingerprint,
	candidates: DiscoveryResult[],
	debugRows: CandidateScoreDebug[] | undefined,
	includeDebug: boolean,
): { primary: ScoredCandidate[]; extended: ScoredCandidate[]; retrieved: number; rejected: number } {
	const filtered = candidates;
	if (includeDebug && debugRows) {
		for (const candidate of filtered) {
			debugRows.push(scoreCandidateAgainstFingerprint(candidate, fingerprint).debug);
		}
	}
	const primary = scoreCandidatesForInterest(filtered, fingerprint, { minScore: MIN_ACCEPT_SCORE });
	const extended = scoreCandidatesForInterest(filtered, fingerprint, { minScore: MIN_EXPAND_SCORE }).filter(
		(row) => row.score < MIN_ACCEPT_SCORE,
	);
	return {
		primary,
		extended,
		retrieved: filtered.length,
		rejected: filtered.length - primary.length - extended.length,
	};
}

export async function buildForYouRecommendations(
	env: Env,
	userId: string,
	opts?: ForYouBuildOpts,
	now = new Date(),
): Promise<ForYouResult> {
	const limit = Math.min(50, Math.max(1, opts?.limit ?? FOR_YOU_PAGE_SIZE));
	const offset = Math.max(0, opts?.offset ?? 0);
	const emptyMetrics: ForYouMetrics = {
		retrieved: 0,
		rejected: 0,
		accepted: 0,
		interestsRepresented: 0,
		searchCalls: 0,
	};

	const fingerprints = await buildInterestFingerprints(env.DB, userId);
	if (isInterestFingerprintEmpty(fingerprints)) {
		return {
			forYou: [],
			forYouTotal: 0,
			forYouHasMore: false,
			forYouInterests: [],
			forYouEmpty: true,
			forYouMessage: 'Follow and categorize channels to improve For You.',
			metrics: emptyMetrics,
		};
	}

	const interests: ForYouInterest[] = fingerprints.map((fp) => ({
		id: fp.interestId,
		label: fp.label,
		confidence: fp.confidence,
	}));

	const mergeFingerprints = fingerprints.slice(0, INTERESTS_TO_MERGE);
	const activeFingerprints = opts?.interestId
		? mergeFingerprints.filter((fp) => fp.interestId === opts.interestId)
		: mergeFingerprints;

	if (!activeFingerprints.length) {
		return {
			forYou: [],
			forYouTotal: 0,
			forYouHasMore: false,
			forYouInterests: interests,
			forYouEmpty: true,
			forYouMessage: 'No recommendations for this interest yet.',
			metrics: emptyMetrics,
		};
	}

	let searchCalls = 0;
	const refreshOffset = Math.max(0, opts?.refreshOffset ?? 0);

	if (opts?.interestId && activeFingerprints[0]) {
		const fp = activeFingerprints[0];
		const query = buildInterestSearchQuery(fp);
		if (opts.loadMore) {
			const next = await fetchNextInterestPage(env, query, now);
			searchCalls += next.searchCalls;
		} else {
			const refreshed = await getTopicCandidates(env, query, now);
			if (refreshed.refreshed) searchCalls += 1;
		}
	} else if (opts?.loadMore) {
		const refreshSlice = mergeFingerprints.slice(refreshOffset, refreshOffset + INTERESTS_FOR_REFRESH);
		const refreshTargets = refreshSlice.length ? refreshSlice : mergeFingerprints.slice(0, INTERESTS_FOR_REFRESH);
		const refreshQueries = refreshTargets.map((fp) => buildInterestSearchQuery(fp));
		const refreshed = await refreshQueryCaches(env, refreshQueries, now, INTERESTS_FOR_REFRESH);
		searchCalls += refreshed.searchCalls;
	} else {
		const refreshQueries = mergeFingerprints.slice(0, INTERESTS_FOR_REFRESH).map((fp) => buildInterestSearchQuery(fp));
		const refreshed = await refreshQueryCaches(env, refreshQueries, now, INTERESTS_FOR_REFRESH);
		searchCalls += refreshed.searchCalls;
	}

	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const debugRows: CandidateScoreDebug[] = [];
	let retrieved = 0;
	let rejected = 0;
	const allPrimary: ScoredCandidate[] = [];
	const allExtended: ScoredCandidate[] = [];

	for (const fingerprint of activeFingerprints) {
		const query = buildInterestSearchQuery(fingerprint);
		const candidates = (await loadCachedQueryResults(env, query, now)).filter((row) => !subscribed.has(row.externalId));
		const scored = scoreFingerprintCandidates(
			fingerprint,
			candidates,
			opts?.includeDebug ? debugRows : undefined,
			Boolean(opts?.includeDebug),
		);
		retrieved += scored.retrieved;
		rejected += scored.rejected;
		allPrimary.push(...scored.primary);
		allExtended.push(...scored.extended);
	}

	const primaryDeduped = dedupeScored(allPrimary);
	const primaryIds = new Set(primaryDeduped.map((row) => row.result.externalId));
	const extendedDeduped = dedupeScored(allExtended).filter((row) => !primaryIds.has(row.result.externalId));
	const pool = [...primaryDeduped, ...extendedDeduped];
	const page = pool.slice(offset, offset + limit).map(toRecommendation);

	let forYouHasMore = offset + page.length < pool.length;
	if (!forYouHasMore && opts?.interestId && activeFingerprints[0]) {
		const query = buildInterestSearchQuery(activeFingerprints[0]);
		const nextToken = await getInterestNextPageToken(env, query, now);
		forYouHasMore = Boolean(nextToken);
	} else if (!forYouHasMore && !opts?.interestId) {
		forYouHasMore = refreshOffset + INTERESTS_FOR_REFRESH < mergeFingerprints.length;
	}

	const metrics: ForYouMetrics = {
		retrieved,
		rejected,
		accepted: pool.length,
		interestsRepresented: new Set(pool.map((row) => row.interestId).filter(Boolean)).size,
		searchCalls,
	};

	if (env.DISCOVER_RELEVANCE_DEBUG === 'true') {
		console.log(
			`ForYou metrics: Retrieved=${metrics.retrieved} Rejected=${metrics.rejected} Accepted=${metrics.accepted} Page=${page.length} offset=${offset} search.list=${metrics.searchCalls}`,
		);
	}

	return {
		forYou: page,
		forYouTotal: pool.length,
		forYouHasMore,
		forYouInterests: interests,
		forYouEmpty: pool.length === 0,
		forYouMessage: pool.length === 0 ? 'No strong matches yet. Follow and categorize more channels to improve For You.' : undefined,
		metrics,
		debug: opts?.includeDebug ? debugRows : undefined,
	};
}

export { scoreCandidateAgainstFingerprint } from './candidateScoring';
