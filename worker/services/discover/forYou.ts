import type { DiscoverRecommendation, DiscoveryResult } from '../../../src/types/discover';
import {
	candidateRowToRecommendation,
	loadActiveInterestCandidates,
	markInterestCandidatesPresented,
	upsertInterestCandidates,
	type DiscoverInterestCandidateRow,
} from '../../db/discoverInterestCandidates';
import { loadActiveFeedbackRows, loadActiveSuppressions } from '../../db/recommendationFeedback';
import { getSubscribedChannelIds } from '../../db/queries';
import {
	MIN_ACCEPT_SCORE,
	MIN_EXPAND_SCORE,
	MIN_RETAIN_SCORE,
	shouldPersistNewCandidate,
	shouldRetainPersistedCandidate,
	scoreCandidateAgainstFingerprint,
	type CandidateScoreDebug,
	type ScoredCandidate,
} from './candidateScoring';
import { buildFeedbackAdjustmentIndex, computeFeedbackAdjustment } from './feedbackScoring';
import { buildInterestFingerprints, isInterestFingerprintEmpty, type InterestFingerprint } from './interestFingerprint';
import { buildBraveInterestPrimaryQuery, buildInterestSearchQueries } from './clusterQueries';
import {
	loadCachedCandidatesWithFallback,
	loadPhraseCacheCandidates,
} from './cacheLookup';
import { mintTokenForScoredCandidate, matchedConceptsFromDebug } from './recommendationFeedbackService';
import {
	evaluatePersistedCandidates,
	type InterestDiscoveryDebug,
} from './interestDiscovery';
import {
	fetchNextInterestPage,
	getInterestNextPageToken,
	normalizeTopic,
} from './topicDiscovery';
import { braveDiscoverConfigFromEnv } from './provider/braveConfig';

export const FOR_YOU_PAGE_SIZE = 25;
const INTERESTS_TO_MERGE = 12;

export interface ForYouMetrics {
	retrieved: number;
	rejected: number;
	accepted: number;
	interestsRepresented: number;
	searchCalls: number;
	persistedActive?: number;
	persistedRetired?: number;
	cacheHits?: number;
	newlyPersisted?: number;
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

export interface ForYouPipelineDebug extends InterestDiscoveryDebug {
	feedbackSuppressed: number;
	returned: number;
}

export interface ForYouResult {
	forYou: DiscoverRecommendation[];
	forYouTotal: number;
	forYouHasMore: boolean;
	forYouInterests: ForYouInterest[];
	forYouEmpty: boolean;
	forYouMessage?: string;
	forYouSupportingMessage?: string;
	metrics: ForYouMetrics;
	debug?: CandidateScoreDebug[];
	pipelineDebug?: ForYouPipelineDebug[];
}

function suppressionKey(provider: string, externalId: string): string {
	return `${provider}:${externalId}`;
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

function scoredPersistedRow(
	row: DiscoverInterestCandidateRow,
	fingerprint: InterestFingerprint,
	feedbackIndex: ReturnType<typeof buildFeedbackAdjustmentIndex>,
	includeDebug: boolean,
	debugRows: CandidateScoreDebug[] | undefined,
): ScoredCandidate | null {
	const candidate = candidateRowToRecommendation(row);
	const adjusted = applyFeedbackToCandidate(candidate, fingerprint, feedbackIndex, includeDebug, debugRows);
	if (!shouldRetainPersistedCandidate(adjusted.score)) return null;
	return adjusted;
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
			forYouMessage: 'No high-confidence recommendations yet.',
			forYouSupportingMessage: 'VortiQuest is still learning from the channels in this category.',
			metrics: emptyMetrics,
		};
	}

	let searchCalls = 0;
	if (opts?.loadMore && opts.interestId && activeFingerprints[0]) {
		const config = braveDiscoverConfigFromEnv(env);
		const query =
			config.providerMode === 'brave'
				? buildBraveInterestPrimaryQuery(activeFingerprints[0]).query
				: buildInterestSearchQueries(activeFingerprints[0])[0]?.query;
		if (query) {
			const next = await fetchNextInterestPage(env, query, now, { userId });
			searchCalls += next.searchCalls;
		}
	}

	const [subscribed, suppressions, feedbackRows] = await Promise.all([
		getSubscribedChannelIds(env.DB, userId),
		loadActiveSuppressions(env.DB, userId),
		loadActiveFeedbackRows(env.DB, userId),
	]);
	const feedbackIndex = buildFeedbackAdjustmentIndex(feedbackRows);
	const debugRows: CandidateScoreDebug[] = [];
	const pipelineDebug: ForYouPipelineDebug[] = [];

	let retrieved = 0;
	let rejected = 0;
	let persistedRetired = 0;
	let cacheHits = 0;
	let newlyPersisted = 0;
	const poolEntries: Array<{ row: ScoredCandidate; fingerprint: InterestFingerprint; candidateId?: string }> = [];
	const seenIds = new Set<string>();

	for (const fingerprint of activeFingerprints) {
		let feedbackSuppressed = 0;
		const persistedRows = await loadActiveInterestCandidates(env.DB, userId, fingerprint.interestId);
		const { active: activePersisted, retired } = await evaluatePersistedCandidates(
			env.DB,
			userId,
			fingerprint,
			persistedRows,
		);
		persistedRetired += retired;

		for (const row of activePersisted) {
			if (subscribed.has(row.external_id)) continue;
			if (suppressions.has(suppressionKey(row.provider, row.external_id))) {
				feedbackSuppressed += 1;
				continue;
			}
			const scored = scoredPersistedRow(
				row,
				fingerprint,
				feedbackIndex,
				Boolean(opts?.includeDebug),
				opts?.includeDebug ? debugRows : undefined,
			);
			if (!scored || !shouldRetainPersistedCandidate(scored.score)) continue;
			if (seenIds.has(row.external_id)) continue;
			seenIds.add(row.external_id);
			poolEntries.push({ row: scored, fingerprint, candidateId: row.id });
		}

		const queries = buildInterestSearchQueries(fingerprint);
		const toPersist: Parameters<typeof upsertInterestCandidates>[2] = [];
		let clusterRawCount = 0;

		for (const clusterQuery of queries) {
			const cacheLookup = await loadCachedCandidatesWithFallback(env, clusterQuery, fingerprint, now);
			if (cacheLookup.hitKeys.length) cacheHits += 1;
			const filtered = cacheLookup.results.filter(
				(row) =>
					!subscribed.has(row.externalId) &&
					!suppressions.has(suppressionKey(row.provider, row.externalId)) &&
					!seenIds.has(row.externalId),
			);
			clusterRawCount += filtered.length;
			retrieved += filtered.length;

			for (const candidate of filtered) {
				const scored = applyFeedbackToCandidate(
					candidate,
					fingerprint,
					feedbackIndex,
					Boolean(opts?.includeDebug),
					opts?.includeDebug ? debugRows : undefined,
				);
				if (scored.score >= MIN_ACCEPT_SCORE) {
					if (!seenIds.has(candidate.externalId)) {
						seenIds.add(candidate.externalId);
						poolEntries.push({ row: scored, fingerprint });
					}
					if (shouldPersistNewCandidate(scored.score)) {
						toPersist.push({
							interestId: fingerprint.interestId,
							interestLabel: fingerprint.label,
							provider: candidate.provider,
							externalId: candidate.externalId,
							channelTitle: candidate.title,
							channelThumbnail: candidate.imageUrl ?? '',
							channelDescription: candidate.description ?? '',
							source: 'discovered',
							recommendationReason: scored.recommendationReason,
							originatingQuery: normalizeTopic(clusterQuery.query),
							matchedConceptsJson: JSON.stringify(matchedConceptsFromDebug(scored.debug, fingerprint)),
							baseRelevanceScore: scored.score,
						});
					}
				} else if (scored.score >= MIN_EXPAND_SCORE) {
					if (!seenIds.has(candidate.externalId)) {
						seenIds.add(candidate.externalId);
						poolEntries.push({ row: scored, fingerprint });
					}
				} else {
					rejected += 1;
				}
			}
		}

		if (clusterRawCount === 0) {
			const phraseLookup = await loadPhraseCacheCandidates(env, fingerprint, now);
			if (phraseLookup.hitKeys.length) cacheHits += 1;
			const filtered = phraseLookup.results.filter(
				(row) =>
					!subscribed.has(row.externalId) &&
					!suppressions.has(suppressionKey(row.provider, row.externalId)) &&
					!seenIds.has(row.externalId),
			);
			retrieved += filtered.length;
			for (const candidate of filtered) {
				const scored = applyFeedbackToCandidate(
					candidate,
					fingerprint,
					feedbackIndex,
					Boolean(opts?.includeDebug),
					opts?.includeDebug ? debugRows : undefined,
				);
				if (scored.score >= MIN_ACCEPT_SCORE) {
					if (!seenIds.has(candidate.externalId)) {
						seenIds.add(candidate.externalId);
						poolEntries.push({ row: scored, fingerprint });
					}
					if (shouldPersistNewCandidate(scored.score)) {
						toPersist.push({
							interestId: fingerprint.interestId,
							interestLabel: fingerprint.label,
							provider: candidate.provider,
							externalId: candidate.externalId,
							channelTitle: candidate.title,
							channelThumbnail: candidate.imageUrl ?? '',
							channelDescription: candidate.description ?? '',
							source: 'discovered',
							recommendationReason: scored.recommendationReason,
							originatingQuery: phraseLookup.hitKeys[0] ?? normalizeTopic(fingerprint.phrases[0]?.text ?? ''),
							matchedConceptsJson: JSON.stringify(matchedConceptsFromDebug(scored.debug, fingerprint)),
							baseRelevanceScore: scored.score,
						});
					}
				} else if (scored.score >= MIN_EXPAND_SCORE) {
					if (!seenIds.has(candidate.externalId)) {
						seenIds.add(candidate.externalId);
						poolEntries.push({ row: scored, fingerprint });
					}
				} else {
					rejected += 1;
				}
			}
		}

		if (toPersist.length) {
			await upsertInterestCandidates(env.DB, userId, toPersist, now);
			newlyPersisted += toPersist.length;
		}

		if (opts?.includeDebug) {
			pipelineDebug.push({
				interestId: fingerprint.interestId,
				interestLabel: fingerprint.label,
				channelCount: fingerprint.channelCount,
				videosSampled: fingerprint.videosSampled ?? 0,
				fingerprint: fingerprint.phrases.slice(0, 12).map((row) => ({ text: row.text, weight: row.weight })),
				clusters: (fingerprint.clusters ?? []).map((cluster) => ({
					id: cluster.id,
					confidence: cluster.confidence,
					phrases: cluster.phrases.map((row) => row.text),
				})),
				queries: queries.map((row) => row.query),
				cacheHits,
				liveSearches: searchCalls,
				rawCandidates: retrieved,
				rejected,
				accepted: poolEntries.filter((entry) => entry.row.interestId === fingerprint.interestId).length,
				persistedActive: activePersisted.length,
				feedbackSuppressed,
				returned: 0,
			});
		}
	}

	poolEntries.sort(
		(a, b) => b.row.score - a.row.score || a.row.result.title.localeCompare(b.row.result.title),
	);

	const pageEntries = poolEntries.slice(offset, offset + limit);
	const secret = env.SESSION_SECRET;
	const page: DiscoverRecommendation[] = [];
	const presentedIds: string[] = [];
	for (const entry of pageEntries) {
		page.push(await toRecommendation(secret, userId, entry.row, entry.fingerprint));
		if (entry.candidateId) presentedIds.push(entry.candidateId);
	}
	if (presentedIds.length) {
		await markInterestCandidatesPresented(env.DB, userId, presentedIds, now);
	}

	let forYouHasMore = offset + page.length < poolEntries.length;
	if (!forYouHasMore && opts?.interestId && activeFingerprints[0]) {
		const queries = buildInterestSearchQueries(activeFingerprints[0]);
		const nextToken = await getInterestNextPageToken(env, queries[0]?.query ?? '', now);
		forYouHasMore = Boolean(nextToken);
	}

	const metrics: ForYouMetrics = {
		retrieved,
		rejected,
		accepted: poolEntries.length,
		interestsRepresented: new Set(poolEntries.map((entry) => entry.row.interestId).filter(Boolean)).size,
		searchCalls,
		persistedActive: poolEntries.filter((entry) => entry.candidateId).length,
		persistedRetired,
		cacheHits,
		newlyPersisted,
	};

	if (env.DISCOVER_RELEVANCE_DEBUG === 'true') {
		console.log(
			`ForYou metrics: Retrieved=${metrics.retrieved} Rejected=${metrics.rejected} Accepted=${metrics.accepted} Retired=${persistedRetired} Page=${page.length} search.list=${metrics.searchCalls}`,
		);
	}

	const isInterestScoped = Boolean(opts?.interestId);
	return {
		forYou: page,
		forYouTotal: poolEntries.length,
		forYouHasMore,
		forYouInterests: interests,
		forYouEmpty: poolEntries.length === 0,
		forYouMessage:
			poolEntries.length === 0
				? isInterestScoped
					? 'No high-confidence recommendations yet.'
					: 'No high-confidence recommendations yet.'
				: undefined,
		forYouSupportingMessage:
			poolEntries.length === 0
				? 'VortiQuest is still learning from the channels in this category.'
				: undefined,
		metrics,
		debug: opts?.includeDebug ? debugRows : undefined,
		pipelineDebug: opts?.includeDebug ? pipelineDebug : undefined,
	};
}

export {
	scoreCandidateAgainstFingerprint,
	MIN_ACCEPT_SCORE,
	MIN_RETAIN_SCORE,
	shouldPersistNewCandidate,
	shouldRetainPersistedCandidate,
} from './candidateScoring';
