import type { DiscoverRecommendation } from '../../../src/types/discover';
import {
	candidateRowToRecommendation,
	FOR_YOU_GLOBAL_INTEREST_ID,
	loadActiveInterestCandidates,
} from '../../db/discoverInterestCandidates';
import { buildInterestFingerprints } from './interestFingerprint';
import { discoverCandidatesForInterest, type InterestDiscoveryMetrics } from './interestDiscovery';
import { DISCOVER_TOPIC_REFRESH_PER_REQUEST } from '../discoverQuota';
import { braveDiscoverConfigFromEnv } from './provider/braveConfig';

export interface InterestPopularResult {
	channels: DiscoverRecommendation[];
	interestLabel?: string;
	fromPersisted: boolean;
	metrics?: InterestDiscoveryMetrics;
	warning?: string;
	/** True when discovery completed without a system failure but found nothing qualifying. */
	empty?: boolean;
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

/**
 * Discover more for an interest chip: score unused provider/topic candidates,
 * then fetch next Brave (or legacy YouTube) pages only if needed.
 */
export async function loadAndPersistInterestPopular(
	env: Env,
	userId: string,
	interestId: string | undefined,
	now = new Date(),
): Promise<InterestPopularResult> {
	const cacheInterestId = interestId ?? FOR_YOU_GLOBAL_INTEREST_ID;

	if (!interestId) {
		return { channels: [], interestLabel: 'All', fromPersisted: false, empty: true };
	}

	const fingerprints = await buildInterestFingerprints(env.DB, userId);
	const fingerprint = fingerprints.find((row) => row.interestId === interestId);
	if (!fingerprint) {
		return { channels: [], interestLabel: '', fromPersisted: false, empty: true };
	}

	const existing = await loadPersistedInterestPopular(env.DB, userId, cacheInterestId);
	const config = braveDiscoverConfigFromEnv(env);
	// Brave: always allow replenish (cache first, then next provider page).
	// Legacy YouTube: only live-search when nothing is persisted (preserves topic quota).
	const allowLiveSearch = config.providerMode === 'brave' || existing.length === 0;
	const maxLiveSearches =
		config.providerMode === 'brave' ? config.maxPagesPerRequest : DISCOVER_TOPIC_REFRESH_PER_REQUEST;

	const discovery = await discoverCandidatesForInterest(
		env,
		userId,
		fingerprint,
		{
			allowLiveSearch,
			maxLiveSearches,
		},
		now,
	);

	const channels = await loadPersistedInterestPopular(env.DB, userId, cacheInterestId);
	return {
		channels,
		interestLabel: fingerprint.label,
		fromPersisted: discovery.metrics.liveSearches === 0 && discovery.metrics.newlyPersisted === 0,
		metrics: discovery.metrics,
		warning: discovery.warning,
		empty: channels.length === 0,
	};
}
