import type { DiscoveryResult } from '../../../src/types/discover';
import {
	upsertInterestCandidates,
	type DiscoverInterestCandidateInsert,
} from '../../db/discoverInterestCandidates';
import { getSubscribedChannelIds } from '../../db/queries';
import { DISCOVER_TOPIC_REFRESH_PER_REQUEST } from '../discoverQuota';
import { buildInterestSearchQueries } from './clusterQueries';
import {
	MIN_ACCEPT_SCORE,
	shouldPersistNewCandidate,
	shouldRetainPersistedCandidate,
	scoreCandidateAgainstFingerprint,
	type ScoredCandidate,
} from './candidateScoring';
import { computeFeedbackAdjustment, buildFeedbackAdjustmentIndex } from './feedbackScoring';
import { loadActiveFeedbackRows } from '../../db/recommendationFeedback';
import { matchedConceptsFromDebug } from './recommendationFeedbackService';
import type { InterestFingerprint } from './interestFingerprint';
import { getTopicCandidates, loadCachedQueryResults, normalizeTopic } from './topicDiscovery';
import {
	loadActiveInterestCandidates,
	retireInterestCandidateByRelevance,
	type DiscoverInterestCandidateRow,
} from '../../db/discoverInterestCandidates';

export interface InterestDiscoveryMetrics {
	persistedActive: number;
	persistedRetired: number;
	cacheHits: number;
	liveSearches: number;
	rawCandidates: number;
	rejected: number;
	accepted: number;
	newlyPersisted: number;
}

export interface InterestDiscoveryDebug {
	interestId: string;
	interestLabel: string;
	channelCount: number;
	videosSampled: number;
	fingerprint: Array<{ text: string; weight: number; channelCoverage?: number }>;
	clusters: Array<{ id: string; confidence: number; phrases: string[] }>;
	queries: string[];
	cacheHits: number;
	liveSearches: number;
	rawCandidates: number;
	rejected: number;
	accepted: number;
	persistedActive: number;
}

function scoredToInsert(
	row: ScoredCandidate,
	fingerprint: InterestFingerprint,
	originatingQuery: string,
): DiscoverInterestCandidateInsert {
	return {
		interestId: row.interestId,
		interestLabel: row.interestLabel,
		provider: row.result.provider,
		externalId: row.result.externalId,
		channelTitle: row.result.title,
		channelThumbnail: row.result.imageUrl ?? '',
		channelDescription: row.result.description ?? '',
		source: 'discovered',
		recommendationReason: row.recommendationReason,
		originatingQuery,
		matchedConceptsJson: JSON.stringify(matchedConceptsFromDebug(row.debug, fingerprint)),
		baseRelevanceScore: row.score,
	};
}

export async function evaluatePersistedCandidates(
	db: D1Database,
	userId: string,
	fingerprint: InterestFingerprint,
	rows: DiscoverInterestCandidateRow[],
): Promise<{ active: DiscoverInterestCandidateRow[]; retired: number }> {
	const feedbackRows = await loadActiveFeedbackRows(db, userId);
	const feedbackIndex = buildFeedbackAdjustmentIndex(feedbackRows);
	const active: DiscoverInterestCandidateRow[] = [];
	let retired = 0;

	for (const row of rows) {
		const candidate: DiscoveryResult = {
			provider: row.provider as DiscoveryResult['provider'],
			type: 'channel',
			externalId: row.external_id,
			title: row.channel_title,
			description: row.channel_description,
			imageUrl: row.channel_thumbnail,
			publisher: row.channel_title,
			subscribed: false,
			watchUrl: `https://www.youtube.com/channel/${row.external_id}`,
		};
		const scored = scoreCandidateAgainstFingerprint(candidate, fingerprint);
		const adjustment = computeFeedbackAdjustment(scored.debug, feedbackIndex);
		const currentScore = scored.score + adjustment.total;
		if (shouldRetainPersistedCandidate(currentScore)) {
			active.push(row);
		} else {
			await retireInterestCandidateByRelevance(db, userId, row.id);
			retired += 1;
		}
	}

	return { active, retired };
}

export async function discoverCandidatesForInterest(
	env: Env,
	userId: string,
	fingerprint: InterestFingerprint,
	opts?: {
		allowLiveSearch?: boolean;
		maxLiveSearches?: number;
		includeDebug?: boolean;
	},
	now = new Date(),
): Promise<{
	metrics: InterestDiscoveryMetrics;
	debug?: InterestDiscoveryDebug;
}> {
	const allowLiveSearch = opts?.allowLiveSearch ?? false;
	const maxLiveSearches = opts?.maxLiveSearches ?? DISCOVER_TOPIC_REFRESH_PER_REQUEST;
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const queries = buildInterestSearchQueries(fingerprint).sort((a, b) => b.confidence - a.confidence);

	let cacheHits = 0;
	let liveSearches = 0;
	let rawCandidates = 0;
	let rejected = 0;
	let accepted = 0;
	let newlyPersisted = 0;

	const persistedRows = await loadActiveInterestCandidates(env.DB, userId, fingerprint.interestId);
	const { active: activePersisted, retired: persistedRetired } = await evaluatePersistedCandidates(
		env.DB,
		userId,
		fingerprint,
		persistedRows,
	);

	const seen = new Set(activePersisted.map((row) => `${row.provider}:${row.external_id}`));
	const toPersist: DiscoverInterestCandidateInsert[] = [];

	for (const clusterQuery of queries) {
		let candidates = await loadCachedQueryResults(env, clusterQuery.query, now);
		if (candidates.length) {
			cacheHits += 1;
		} else if (allowLiveSearch && liveSearches < maxLiveSearches) {
			const refreshed = await getTopicCandidates(env, clusterQuery.query, now, { allowRefresh: true });
			if (refreshed.refreshed) liveSearches += 1;
			candidates = refreshed.results;
		}

		const filtered = candidates.filter(
			(row) => !subscribed.has(row.externalId) && !seen.has(`${row.provider}:${row.externalId}`),
		);
		rawCandidates += filtered.length;

		for (const candidate of filtered) {
			const scored = scoreCandidateAgainstFingerprint(candidate, fingerprint);
			if (shouldPersistNewCandidate(scored.score)) {
				accepted += 1;
				seen.add(`${candidate.provider}:${candidate.externalId}`);
				toPersist.push(scoredToInsert(scored, fingerprint, normalizeTopic(clusterQuery.query)));
			} else {
				rejected += 1;
			}
		}
	}

	if (toPersist.length) {
		await upsertInterestCandidates(env.DB, userId, toPersist, now);
		newlyPersisted = toPersist.length;
	}

	const metrics: InterestDiscoveryMetrics = {
		persistedActive: activePersisted.length + newlyPersisted,
		persistedRetired: persistedRetired,
		cacheHits,
		liveSearches,
		rawCandidates,
		rejected,
		accepted,
		newlyPersisted,
	};

	const debug: InterestDiscoveryDebug | undefined = opts?.includeDebug
		? {
				interestId: fingerprint.interestId,
				interestLabel: fingerprint.label,
				channelCount: fingerprint.channelCount,
				videosSampled: fingerprint.videosSampled ?? 0,
				fingerprint: fingerprint.phrases.slice(0, 12).map((row) => ({
					text: row.text,
					weight: row.weight,
				})),
				clusters: (fingerprint.clusters ?? []).map((cluster) => ({
					id: cluster.id,
					confidence: cluster.confidence,
					phrases: cluster.phrases.map((row) => row.text),
				})),
				queries: queries.map((row) => row.query),
				cacheHits,
				liveSearches,
				rawCandidates,
				rejected,
				accepted,
				persistedActive: metrics.persistedActive,
			}
		: undefined;

	return { metrics, debug };
}

export { shouldPersistNewCandidate, shouldRetainPersistedCandidate, MIN_ACCEPT_SCORE };
