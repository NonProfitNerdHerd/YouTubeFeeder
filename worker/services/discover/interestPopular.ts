import type { DiscoverRecommendation } from '../../../src/types/discover';
import {
	candidateRowToRecommendation,
	FOR_YOU_GLOBAL_INTEREST_ID,
	hasActiveInterestCandidates,
	loadActiveInterestCandidates,
} from '../../db/discoverInterestCandidates';
import { buildInterestFingerprints } from './interestFingerprint';
import { discoverCandidatesForInterest } from './interestDiscovery';
import { DISCOVER_TOPIC_REFRESH_PER_REQUEST } from '../discoverQuota';

export interface InterestPopularResult {
	channels: DiscoverRecommendation[];
	interestLabel?: string;
	fromPersisted: boolean;
}

export async function loadPersistedInterestPopular(
	db: D1Database,
	userId: string,
	interestId: string,
): Promise<DiscoverRecommendation[]> {
	const rows = await loadActiveInterestCandidates(db, userId, interestId);
	return rows.map(candidateRowToRecommendation);
}

export async function loadAllPersistedInterestPopular(
	db: D1Database,
	userId: string,
): Promise<DiscoverRecommendation[]> {
	const rows = await loadActiveInterestCandidates(db, userId);
	return rows.map(candidateRowToRecommendation);
}

export async function loadAndPersistInterestPopular(
	env: Env,
	userId: string,
	interestId: string | undefined,
	now = new Date(),
): Promise<InterestPopularResult> {
	const cacheInterestId = interestId ?? FOR_YOU_GLOBAL_INTEREST_ID;

	if (interestId && (await hasActiveInterestCandidates(env.DB, userId, cacheInterestId))) {
		const channels = await loadPersistedInterestPopular(env.DB, userId, cacheInterestId);
		return {
			channels,
			interestLabel: channels[0]?.interestLabel,
			fromPersisted: true,
		};
	}

	if (!interestId) {
		return { channels: [], interestLabel: 'All', fromPersisted: false };
	}

	const fingerprints = await buildInterestFingerprints(env.DB, userId);
	const fingerprint = fingerprints.find((row) => row.interestId === interestId);
	if (!fingerprint) {
		return { channels: [], interestLabel: '', fromPersisted: false };
	}

	await discoverCandidatesForInterest(
		env,
		userId,
		fingerprint,
		{
			allowLiveSearch: true,
			maxLiveSearches: DISCOVER_TOPIC_REFRESH_PER_REQUEST,
		},
		now,
	);

	const channels = await loadPersistedInterestPopular(env.DB, userId, cacheInterestId);
	return {
		channels,
		interestLabel: fingerprint.label,
		fromPersisted: false,
	};
}
