import type { DiscoveryResult } from '../../../src/types/discover';
import { getTopicDiscoveryCache, putTopicDiscoveryCache } from '../../db/discoverCache';
import {
	DISCOVER_TOPIC_REFRESH_PER_REQUEST,
	discoverTopicSearchQuotaStatus,
	recordTopicSearchCall,
} from '../discoverQuota';
import { recordYoutubeCalls } from '../websub';
import { createYoutubeApiKeyClient } from '../youtube';
import { normalizeDiscoverQuery, searchYoutubeChannels } from './youtube';

export function normalizeTopic(topic: string): string {
	return normalizeDiscoverQuery(topic);
}

export async function getTopicCandidates(
	env: Env,
	topic: string,
	now = new Date(),
	opts?: { allowRefresh?: boolean },
): Promise<{ results: DiscoveryResult[]; refreshed: boolean }> {
	const normalized = normalizeTopic(topic);
	if (!normalized) return { results: [], refreshed: false };

	const cached = await getTopicDiscoveryCache(env.DB, normalized, now);
	if (cached && !cached.stale) {
		return { results: cached.results, refreshed: false };
	}

	const allowRefresh = opts?.allowRefresh ?? true;
	if (!allowRefresh) {
		return { results: cached?.results ?? [], refreshed: false };
	}

	const quota = await discoverTopicSearchQuotaStatus(env.DB);
	if (!quota.canRefresh) {
		return { results: cached?.results ?? [], refreshed: false };
	}

	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey) {
		return { results: cached?.results ?? [], refreshed: false };
	}

	const yt = createYoutubeApiKeyClient(apiKey);
	const rawResults = await searchYoutubeChannels(yt, topic);
	await recordYoutubeCalls(env.DB, yt);
	await recordTopicSearchCall(env.DB);

	const cachePayload = rawResults.map(({ subscribed: _s, ...row }) => row);
	await putTopicDiscoveryCache(env.DB, normalized, cachePayload, undefined, now);

	return { results: cachePayload, refreshed: true };
}

export async function refreshTopicCaches(
	env: Env,
	topics: string[],
	now = new Date(),
	maxSearches = DISCOVER_TOPIC_REFRESH_PER_REQUEST,
): Promise<Map<string, DiscoveryResult[]>> {
	const out = new Map<string, DiscoveryResult[]>();
	let searches = 0;

	for (const topic of topics) {
		const normalized = normalizeTopic(topic);
		if (!normalized) continue;

		const cached = await getTopicDiscoveryCache(env.DB, normalized, now);
		const needsRefresh = !cached || cached.stale;

		if (needsRefresh && searches < maxSearches) {
			const quota = await discoverTopicSearchQuotaStatus(env.DB);
			if (!quota.canRefresh) {
				out.set(normalized, cached?.results ?? []);
				continue;
			}
			const { results } = await getTopicCandidates(env, topic, now, { allowRefresh: true });
			out.set(normalized, results);
			searches += 1;
			continue;
		}

		out.set(normalized, cached?.results ?? []);
	}

	return out;
}
