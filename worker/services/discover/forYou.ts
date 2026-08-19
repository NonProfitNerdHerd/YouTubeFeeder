import type { DiscoverRecommendation } from '../../../src/types/discover';
import { getSubscribedChannelIds } from '../../db/queries';
import {
	scoreCandidateAgainstFingerprint,
	scoreCandidatesForInterest,
	type CandidateScoreDebug,
	type ScoredCandidate,
} from './candidateScoring';
import { buildInterestFingerprints, isInterestFingerprintEmpty } from './interestFingerprint';
import { buildInterestSearchQuery, interestQueryCacheKey } from './queryConstruction';
import { loadCachedQueryResults, refreshQueryCaches } from './topicDiscovery';

const MAX_FOR_YOU = 30;
const MAX_PER_INTEREST = 8;
const INTERESTS_FOR_REFRESH = 2;
const INTERESTS_TO_MERGE = 6;

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

export interface ForYouResult {
	forYou: DiscoverRecommendation[];
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

function diversifyByInterest(
	grouped: Map<string, DiscoverRecommendation[]>,
	maxTotal = MAX_FOR_YOU,
	maxPerInterest = MAX_PER_INTEREST,
): DiscoverRecommendation[] {
	const keys = [...grouped.keys()];
	const picked: DiscoverRecommendation[] = [];
	const counts = new Map<string, number>();

	while (picked.length < maxTotal) {
		let added = false;
		for (const key of keys) {
			const count = counts.get(key) ?? 0;
			if (count >= maxPerInterest) continue;
			const list = grouped.get(key) ?? [];
			const next = list[count];
			if (!next) continue;
			picked.push(next);
			counts.set(key, count + 1);
			added = true;
			if (picked.length >= maxTotal) break;
		}
		if (!added) break;
	}

	return picked;
}

function toRecommendation(row: ScoredCandidate): DiscoverRecommendation {
	return {
		...row.result,
		subscribed: false,
		recommendationReason: row.recommendationReason,
		interestId: row.interestId,
	};
}

export async function buildForYouRecommendations(
	env: Env,
	userId: string,
	opts?: { interestId?: string; includeDebug?: boolean },
	now = new Date(),
): Promise<ForYouResult> {
	const fingerprints = await buildInterestFingerprints(env.DB, userId);
	const emptyMetrics: ForYouMetrics = {
		retrieved: 0,
		rejected: 0,
		accepted: 0,
		interestsRepresented: 0,
		searchCalls: 0,
	};

	if (isInterestFingerprintEmpty(fingerprints)) {
		return {
			forYou: [],
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
	const refreshQueries = mergeFingerprints.slice(0, INTERESTS_FOR_REFRESH).map((fp) => buildInterestSearchQuery(fp));
	const { cacheByKey, searchCalls } = await refreshQueryCaches(env, refreshQueries, now, INTERESTS_FOR_REFRESH);

	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const debugRows: CandidateScoreDebug[] = [];
	let retrieved = 0;
	let rejected = 0;
	const allAccepted: ScoredCandidate[] = [];

	for (const fingerprint of mergeFingerprints) {
		if (opts?.interestId && fingerprint.interestId !== opts.interestId) continue;

		const query = buildInterestSearchQuery(fingerprint);
		const cacheKey = interestQueryCacheKey(fingerprint);
		let candidates = cacheByKey.get(cacheKey) ?? [];
		if (!candidates.length) {
			candidates = await loadCachedQueryResults(env, query, now);
		}

		const filtered = candidates.filter((row) => !subscribed.has(row.externalId));
		retrieved += filtered.length;

		if (opts?.includeDebug) {
			for (const candidate of filtered) {
				const scored = scoreCandidateAgainstFingerprint(candidate, fingerprint);
				debugRows.push(scored.debug);
			}
		}

		const scored = scoreCandidatesForInterest(filtered, fingerprint);
		rejected += filtered.length - scored.length;
		allAccepted.push(...scored);
	}

	const deduped = dedupeScored(allAccepted);
	const grouped = new Map<string, DiscoverRecommendation[]>();
	for (const row of deduped) {
		const list = grouped.get(row.interestId) ?? [];
		list.push(toRecommendation(row));
		grouped.set(row.interestId, list);
	}

	const forYou = opts?.interestId
		? deduped.filter((row) => row.interestId === opts.interestId).map(toRecommendation)
		: diversifyByInterest(grouped);

	const metrics: ForYouMetrics = {
		retrieved,
		rejected,
		accepted: forYou.length,
		interestsRepresented: new Set(forYou.map((row) => row.interestId).filter(Boolean)).size,
		searchCalls,
	};

	if (env.DISCOVER_RELEVANCE_DEBUG === 'true') {
		console.log(
			`ForYou metrics: Retrieved=${metrics.retrieved} Rejected=${metrics.rejected} Accepted=${metrics.accepted} Interests=${metrics.interestsRepresented} search.list=${metrics.searchCalls}`,
		);
	}

	return {
		forYou,
		forYouInterests: interests,
		forYouEmpty: forYou.length === 0,
		forYouMessage: forYou.length === 0 ? 'No strong matches yet. Follow and categorize more channels to improve For You.' : undefined,
		metrics,
		debug: opts?.includeDebug ? debugRows : undefined,
	};
}

export { scoreCandidateAgainstFingerprint } from './candidateScoring';
