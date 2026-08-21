import type { DiscoveryResult } from '../../../src/types/discover';
import {
	upsertInterestCandidates,
	type DiscoverInterestCandidateInsert,
} from '../../db/discoverInterestCandidates';
import { getSubscribedChannelIds } from '../../db/queries';
import { DISCOVER_TOPIC_REFRESH_PER_REQUEST } from '../discoverQuota';
import { buildBraveInterestPrimaryQuery, buildInterestSearchQueries } from './clusterQueries';
import {
	loadCachedCandidatesWithFallback,
	loadPhraseCacheCandidates,
} from './cacheLookup';
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
import { fetchNextInterestPage, getTopicCandidates, normalizeTopic } from './topicDiscovery';
import {
	loadActiveInterestCandidates,
	retireInterestCandidateByRelevance,
	type DiscoverInterestCandidateRow,
} from '../../db/discoverInterestCandidates';
import { braveDiscoverConfigFromEnv } from './provider/braveConfig';

export interface InterestDiscoveryMetrics {
	persistedActive: number;
	persistedRetired: number;
	cacheHits: number;
	liveSearches: number;
	rawCandidates: number;
	rejected: number;
	accepted: number;
	newlyPersisted: number;
	scoreRejected: number;
	subscribedFiltered: number;
	providerPagesFetched: number;
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
	providerPagesFetched?: number;
	scoreRejected?: number;
	subscribedFiltered?: number;
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

function scoreAndCollect(
	candidates: DiscoveryResult[],
	fingerprint: InterestFingerprint,
	subscribed: Set<string>,
	seen: Set<string>,
	originatingQuery: string,
	toPersist: DiscoverInterestCandidateInsert[],
	counters: { raw: number; rejected: number; accepted: number; subscribedFiltered: number; scoreRejected: number },
): void {
	for (const candidate of candidates) {
		if (subscribed.has(candidate.externalId)) {
			counters.subscribedFiltered += 1;
			continue;
		}
		if (seen.has(`${candidate.provider}:${candidate.externalId}`)) continue;
		counters.raw += 1;
		const scored = scoreCandidateAgainstFingerprint(candidate, fingerprint);
		if (shouldPersistNewCandidate(scored.score)) {
			counters.accepted += 1;
			seen.add(`${candidate.provider}:${candidate.externalId}`);
			toPersist.push(scoredToInsert(scored, fingerprint, originatingQuery));
		} else {
			counters.rejected += 1;
			counters.scoreRejected += 1;
		}
	}
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
	warning?: string;
}> {
	const allowLiveSearch = opts?.allowLiveSearch ?? false;
	const maxLiveSearches = opts?.maxLiveSearches ?? DISCOVER_TOPIC_REFRESH_PER_REQUEST;
	const config = braveDiscoverConfigFromEnv(env);
	const isBrave = config.providerMode === 'brave';
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const queries = isBrave
		? [buildBraveInterestPrimaryQuery(fingerprint)].filter((row) => Boolean(row.query.trim()))
		: buildInterestSearchQueries(fingerprint).sort((a, b) => b.confidence - a.confidence);

	let cacheHits = 0;
	let liveSearches = 0;
	let providerPagesFetched = 0;
	let warning: string | undefined;
	const counters = { raw: 0, rejected: 0, accepted: 0, subscribedFiltered: 0, scoreRejected: 0 };

	const persistedRows = await loadActiveInterestCandidates(env.DB, userId, fingerprint.interestId);
	const { active: activePersisted, retired: persistedRetired } = await evaluatePersistedCandidates(
		env.DB,
		userId,
		fingerprint,
		persistedRows,
	);

	const seen = new Set(activePersisted.map((row) => `${row.provider}:${row.external_id}`));
	const toPersist: DiscoverInterestCandidateInsert[] = [];
	const beforePersistCount = activePersisted.length;

	for (const clusterQuery of queries) {
		const cacheLookup = await loadCachedCandidatesWithFallback(env, clusterQuery, fingerprint, now);
		let candidates = cacheLookup.results;
		if (cacheLookup.hitKeys.length) cacheHits += 1;
		else if (allowLiveSearch && liveSearches < maxLiveSearches) {
			const refreshed = await getTopicCandidates(env, clusterQuery.query, now, {
				allowRefresh: true,
				userId,
			});
			if (refreshed.refreshed) {
				liveSearches += 1;
				if (isBrave) providerPagesFetched += 1;
			}
			if (refreshed.warning) warning = refreshed.warning;
			candidates = refreshed.results;
		}

		scoreAndCollect(
			candidates,
			fingerprint,
			subscribed,
			seen,
			normalizeTopic(clusterQuery.query) || clusterQuery.cacheKey,
			toPersist,
			counters,
		);

		// Low-yield Brave pages: keep paginating until we accept enough or hit safety limits.
		const minNewAccepts = Math.max(1, Math.min(5, maxLiveSearches));
		while (
			isBrave &&
			allowLiveSearch &&
			toPersist.length < minNewAccepts &&
			liveSearches < maxLiveSearches
		) {
			const next = await fetchNextInterestPage(env, clusterQuery.query, now, { userId });
			if (!next.fetched) break;
			liveSearches += next.searchCalls;
			providerPagesFetched += next.searchCalls;
			if (next.warning) warning = next.warning;
			const priorSeen = seen.size;
			scoreAndCollect(
				next.results,
				fingerprint,
				subscribed,
				seen,
				normalizeTopic(clusterQuery.query) || clusterQuery.cacheKey,
				toPersist,
				counters,
			);
			if (seen.size === priorSeen && !next.nextPageToken) break;
		}
	}

	if (counters.raw === 0 && !isBrave) {
		const phraseLookup = await loadPhraseCacheCandidates(env, fingerprint, now);
		if (phraseLookup.hitKeys.length) cacheHits += 1;
		scoreAndCollect(
			phraseLookup.results,
			fingerprint,
			subscribed,
			seen,
			phraseLookup.hitKeys[0] ?? normalizeTopic(fingerprint.phrases[0]?.text ?? ''),
			toPersist,
			counters,
		);
	}

	if (toPersist.length) {
		await upsertInterestCandidates(env.DB, userId, toPersist, now);
	}

	const newlyPersisted = toPersist.length;
	const metrics: InterestDiscoveryMetrics = {
		persistedActive: beforePersistCount + newlyPersisted,
		persistedRetired: persistedRetired,
		cacheHits,
		liveSearches,
		rawCandidates: counters.raw,
		rejected: counters.rejected,
		accepted: counters.accepted,
		newlyPersisted,
		scoreRejected: counters.scoreRejected,
		subscribedFiltered: counters.subscribedFiltered,
		providerPagesFetched,
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
				rawCandidates: counters.raw,
				rejected: counters.rejected,
				accepted: counters.accepted,
				persistedActive: metrics.persistedActive,
				providerPagesFetched,
				scoreRejected: counters.scoreRejected,
				subscribedFiltered: counters.subscribedFiltered,
			}
		: undefined;

	return { metrics, debug, warning };
}

export { shouldPersistNewCandidate, shouldRetainPersistedCandidate, MIN_ACCEPT_SCORE };
