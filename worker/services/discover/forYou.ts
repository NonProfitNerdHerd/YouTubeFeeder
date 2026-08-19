import type { DiscoverRecommendation, DiscoveryResult } from '../../../src/types/discover';
import {
	candidateRowToRecommendation,
	loadActiveInterestCandidates,
	type DiscoverInterestCandidateRow,
} from '../../db/discoverInterestCandidates';
import { loadActiveFeedbackRows, loadActiveSuppressions } from '../../db/recommendationFeedback';
import { getSubscribedChannelIds } from '../../db/queries';
import {
	MIN_ACCEPT_SCORE,
	MIN_EXPAND_SCORE,
	scoreCandidateAgainstFingerprint,
	type CandidateScoreDebug,
	type ScoredCandidate,
} from './candidateScoring';
import { buildFeedbackAdjustmentIndex, computeFeedbackAdjustment } from './feedbackScoring';
import { buildInterestFingerprints, isInterestFingerprintEmpty, type InterestFingerprint } from './interestFingerprint';
import { buildInterestSearchQuery } from './queryConstruction';
import { mintTokenForScoredCandidate } from './recommendationFeedbackService';
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

function suppressionKey(provider: string, externalId: string): string {
	return `${provider}:${externalId}`;
}

function fingerprintForPersistedCandidate(
	row: DiscoverInterestCandidateRow,
	fingerprintByInterest: Map<string, InterestFingerprint>,
): InterestFingerprint | null {
	const existing = fingerprintByInterest.get(row.interest_id);
	if (existing) return existing;
	const label = row.interest_label.trim();
	if (!label) return null;
	return {
		interestId: row.interest_id,
		label: row.interest_label,
		phrases: [{ text: label.toLowerCase(), weight: 10 }],
		terms: [],
		negativeHints: [],
		channelCount: 0,
		confidence: 0,
	};
}

function persistedCandidatesToPoolEntries(
	rows: DiscoverInterestCandidateRow[],
	fingerprintByInterest: Map<string, InterestFingerprint>,
	subscribed: Set<string>,
	suppressions: Set<string>,
	excludeIds: Set<string>,
): Array<{ row: ScoredCandidate; fingerprint: InterestFingerprint }> {
	const out: Array<{ row: ScoredCandidate; fingerprint: InterestFingerprint }> = [];
	for (const row of rows) {
		if (subscribed.has(row.external_id)) continue;
		if (suppressions.has(suppressionKey(row.provider, row.external_id))) continue;
		if (excludeIds.has(row.external_id)) continue;
		const fingerprint = fingerprintForPersistedCandidate(row, fingerprintByInterest);
		if (!fingerprint) continue;
		const candidate: DiscoveryResult = candidateRowToRecommendation(row);
		out.push({
			row: scoreCandidateAgainstFingerprint(candidate, fingerprint),
			fingerprint,
		});
	}
	return out;
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

async function toRecommendation(
	secret: string | undefined,
	userId: string,
	row: ScoredCandidate,
	fingerprint: InterestFingerprint,
): Promise<DiscoverRecommendation> {
	const base: DiscoverRecommendation = {
		...row.result,
		subscribed: false,
		recommendationReason: row.recommendationReason,
		interestId: row.interestId,
		interestLabel: row.interestLabel,
	};
	if (secret) {
		base.recommendationToken = await mintTokenForScoredCandidate(secret, userId, row, fingerprint);
	}
	return base;
}

function applyFeedbackToCandidate(
	candidate: DiscoveryResult,
	fingerprint: InterestFingerprint,
	feedbackIndex: ReturnType<typeof buildFeedbackAdjustmentIndex>,
	includeDebug: boolean,
	debugRows: CandidateScoreDebug[] | undefined,
): ScoredCandidate {
	const scored = scoreCandidateAgainstFingerprint(candidate, fingerprint);
	const adjustment = computeFeedbackAdjustment(scored.debug, feedbackIndex);
	const finalScore = scored.score + adjustment.total;
	const adjusted: ScoredCandidate = {
		...scored,
		score: finalScore,
		debug: {
			...scored.debug,
			score: finalScore,
			baseScore: scored.score,
			feedbackPositive: adjustment.positive,
			feedbackNegative: adjustment.negative,
			finalScore,
			contributingFeedbackIds: adjustment.contributingFeedbackIds,
			result: finalScore >= MIN_ACCEPT_SCORE ? 'ACCEPT' : 'REJECT',
		},
	};
	if (includeDebug && debugRows) {
		debugRows.push(adjusted.debug);
	}
	return adjusted;
}

function scoreFingerprintCandidates(
	fingerprint: InterestFingerprint,
	candidates: DiscoveryResult[],
	feedbackIndex: ReturnType<typeof buildFeedbackAdjustmentIndex>,
	debugRows: CandidateScoreDebug[] | undefined,
	includeDebug: boolean,
): { primary: ScoredCandidate[]; extended: ScoredCandidate[]; retrieved: number; rejected: number } {
	const scored = candidates.map((candidate) =>
		applyFeedbackToCandidate(candidate, fingerprint, feedbackIndex, includeDebug, debugRows),
	);
	const primary = scored
		.filter((row) => row.score >= MIN_ACCEPT_SCORE)
		.sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title));
	const extended = scored
		.filter((row) => row.score >= MIN_EXPAND_SCORE && row.score < MIN_ACCEPT_SCORE)
		.sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title));
	return {
		primary,
		extended,
		retrieved: candidates.length,
		rejected: candidates.length - primary.length - extended.length,
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

	const [subscribed, suppressions, feedbackRows] = await Promise.all([
		getSubscribedChannelIds(env.DB, userId),
		loadActiveSuppressions(env.DB, userId),
		loadActiveFeedbackRows(env.DB, userId),
	]);
	const feedbackIndex = buildFeedbackAdjustmentIndex(feedbackRows);
	const debugRows: CandidateScoreDebug[] = [];
	let retrieved = 0;
	let rejected = 0;
	const allPrimary: Array<{ row: ScoredCandidate; fingerprint: InterestFingerprint }> = [];
	const allExtended: Array<{ row: ScoredCandidate; fingerprint: InterestFingerprint }> = [];

	for (const fingerprint of activeFingerprints) {
		const query = buildInterestSearchQuery(fingerprint);
		const candidates = (await loadCachedQueryResults(env, query, now)).filter(
			(row) =>
				!subscribed.has(row.externalId) &&
				!suppressions.has(suppressionKey(row.provider, row.externalId)),
		);
		const scored = scoreFingerprintCandidates(
			fingerprint,
			candidates,
			feedbackIndex,
			opts?.includeDebug ? debugRows : undefined,
			Boolean(opts?.includeDebug),
		);
		retrieved += scored.retrieved;
		rejected += scored.rejected;
		for (const row of scored.primary) allPrimary.push({ row, fingerprint });
		for (const row of scored.extended) allExtended.push({ row, fingerprint });
	}

	const primaryDeduped = dedupeScored(allPrimary.map((entry) => entry.row));
	const primaryIds = new Set(primaryDeduped.map((row) => row.result.externalId));
	const fingerprintByInterest = new Map(activeFingerprints.map((fp) => [fp.interestId, fp]));
	const extendedDeduped = dedupeScored(allExtended.map((entry) => entry.row)).filter(
		(row) => !primaryIds.has(row.result.externalId),
	);
	const poolEntries = [
		...primaryDeduped.map((row) => ({ row, fingerprint: fingerprintByInterest.get(row.interestId)! })),
		...extendedDeduped.map((row) => ({ row, fingerprint: fingerprintByInterest.get(row.interestId)! })),
	];
	const poolIds = new Set(poolEntries.map((entry) => entry.row.result.externalId));
	const persistedRows = await loadActiveInterestCandidates(
		env.DB,
		userId,
		opts?.interestId,
	);
	const persistedEntries = persistedCandidatesToPoolEntries(
		persistedRows,
		fingerprintByInterest,
		subscribed,
		suppressions,
		poolIds,
	);
	poolEntries.push(...persistedEntries);

	const pageSlice = poolEntries.slice(offset, offset + limit);
	const secret = env.SESSION_SECRET;
	const page: DiscoverRecommendation[] = [];
	for (const entry of pageSlice) {
		page.push(await toRecommendation(secret, userId, entry.row, entry.fingerprint));
	}

	let forYouHasMore = offset + page.length < poolEntries.length;
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
		accepted: poolEntries.length,
		interestsRepresented: new Set(poolEntries.map((entry) => entry.row.interestId).filter(Boolean)).size,
		searchCalls,
	};

	if (env.DISCOVER_RELEVANCE_DEBUG === 'true') {
		console.log(
			`ForYou metrics: Retrieved=${metrics.retrieved} Rejected=${metrics.rejected} Accepted=${metrics.accepted} Page=${page.length} offset=${offset} search.list=${metrics.searchCalls}`,
		);
	}

	return {
		forYou: page,
		forYouTotal: poolEntries.length,
		forYouHasMore,
		forYouInterests: interests,
		forYouEmpty: poolEntries.length === 0,
		forYouMessage: poolEntries.length === 0 ? 'No strong matches yet. Follow and categorize more channels to improve For You.' : undefined,
		metrics,
		debug: opts?.includeDebug ? debugRows : undefined,
	};
}

export { scoreCandidateAgainstFingerprint } from './candidateScoring';
