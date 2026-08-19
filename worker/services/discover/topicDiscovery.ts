import type { DiscoveryResult } from '../../../src/types/discover';
import { appendTopicDiscoveryCache, getTopicDiscoveryCache, putTopicDiscoveryCache } from '../../db/discoverCache';
import {
	DISCOVER_TOPIC_REFRESH_PER_REQUEST,
	discoverTopicSearchQuotaStatus,
	recordTopicSearchCall,
} from '../discoverQuota';
import { recordYoutubeCalls } from '../websub';
import { createYoutubeApiKeyClient } from '../youtube';
import { normalizeDiscoverQuery, searchYoutubeChannels } from './youtube';
import { canonicalizeClusterQueryKey } from './clusterQueries';

export function normalizeTopic(topic: string): string {
	const canonical = canonicalizeClusterQueryKey(topic);
	return canonical || normalizeDiscoverQuery(topic);
}

export async function getTopicCandidates(
	env: Env,
	query: string,
	now = new Date(),
	opts?: { allowRefresh?: boolean },
): Promise<{ results: DiscoveryResult[]; refreshed: boolean; cacheKey: string; nextPageToken: string | null }> {
	const cacheKey = normalizeTopic(query);
	if (!cacheKey) return { results: [], refreshed: false, cacheKey: '', nextPageToken: null };

	const cached = await getTopicDiscoveryCache(env.DB, cacheKey, now);
	if (cached && !cached.stale) {
		return { results: cached.results, refreshed: false, cacheKey, nextPageToken: cached.nextPageToken };
	}

	const allowRefresh = opts?.allowRefresh ?? true;
	if (!allowRefresh) {
		return {
			results: cached?.results ?? [],
			refreshed: false,
			cacheKey,
			nextPageToken: cached?.nextPageToken ?? null,
		};
	}

	const quota = await discoverTopicSearchQuotaStatus(env.DB);
	if (!quota.canRefresh) {
		return {
			results: cached?.results ?? [],
			refreshed: false,
			cacheKey,
			nextPageToken: cached?.nextPageToken ?? null,
		};
	}

	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey) {
		return {
			results: cached?.results ?? [],
			refreshed: false,
			cacheKey,
			nextPageToken: cached?.nextPageToken ?? null,
		};
	}

	const yt = createYoutubeApiKeyClient(apiKey);
	const { results: rawResults, nextPageToken } = await searchYoutubeChannels(yt, query);
	await recordYoutubeCalls(env.DB, yt);
	await recordTopicSearchCall(env.DB);

	const cachePayload = rawResults.map(({ subscribed: _s, ...row }) => row);
	await putTopicDiscoveryCache(env.DB, cacheKey, cachePayload, nextPageToken, undefined, now);

	return { results: cachePayload, refreshed: true, cacheKey, nextPageToken };
}

export async function fetchNextInterestPage(
	env: Env,
	query: string,
	now = new Date(),
): Promise<{ results: DiscoveryResult[]; fetched: boolean; nextPageToken: string | null; searchCalls: number }> {
	const cacheKey = normalizeTopic(query);
	if (!cacheKey) return { results: [], fetched: false, nextPageToken: null, searchCalls: 0 };

	const cached = await getTopicDiscoveryCache(env.DB, cacheKey, now);
	const pageToken = cached?.nextPageToken;
	if (!pageToken) {
		return {
			results: cached?.results ?? [],
			fetched: false,
			nextPageToken: null,
			searchCalls: 0,
		};
	}

	const quota = await discoverTopicSearchQuotaStatus(env.DB);
	if (!quota.canRefresh) {
		return {
			results: cached?.results ?? [],
			fetched: false,
			nextPageToken: pageToken,
			searchCalls: 0,
		};
	}

	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey) {
		return {
			results: cached?.results ?? [],
			fetched: false,
			nextPageToken: pageToken,
			searchCalls: 0,
		};
	}

	const yt = createYoutubeApiKeyClient(apiKey);
	const { results: rawResults, nextPageToken } = await searchYoutubeChannels(yt, query, pageToken);
	await recordYoutubeCalls(env.DB, yt);
	await recordTopicSearchCall(env.DB);

	const cachePayload = rawResults.map(({ subscribed: _s, ...row }) => row);
	await appendTopicDiscoveryCache(env.DB, cacheKey, cachePayload, nextPageToken, undefined, now);

	const updated = await getTopicDiscoveryCache(env.DB, cacheKey, now);
	return {
		results: updated?.results ?? cachePayload,
		fetched: true,
		nextPageToken: updated?.nextPageToken ?? nextPageToken,
		searchCalls: 1,
	};
}

export async function refreshQueryCaches(
	env: Env,
	queries: string[],
	now = new Date(),
	maxSearches = DISCOVER_TOPIC_REFRESH_PER_REQUEST,
): Promise<{ cacheByKey: Map<string, DiscoveryResult[]>; searchCalls: number }> {
	const out = new Map<string, DiscoveryResult[]>();
	let searches = 0;

	for (const query of queries) {
		const cacheKey = normalizeTopic(query);
		if (!cacheKey) continue;

		const cached = await getTopicDiscoveryCache(env.DB, cacheKey, now);
		const needsRefresh = !cached || cached.stale;

		if (needsRefresh && searches < maxSearches) {
			const quota = await discoverTopicSearchQuotaStatus(env.DB);
			if (!quota.canRefresh) {
				out.set(cacheKey, cached?.results ?? []);
				continue;
			}
			const { results, cacheKey: key } = await getTopicCandidates(env, query, now, { allowRefresh: true });
			out.set(key, results);
			searches += 1;
			continue;
		}

		out.set(cacheKey, cached?.results ?? []);
	}

	return { cacheByKey: out, searchCalls: searches };
}

export async function loadCachedQueryResults(
	env: Env,
	query: string,
	now = new Date(),
): Promise<DiscoveryResult[]> {
	const cacheKey = normalizeTopic(query);
	if (!cacheKey) return [];
	const cached = await getTopicDiscoveryCache(env.DB, cacheKey, now);
	return cached?.results ?? [];
}

export async function getInterestNextPageToken(
	env: Env,
	query: string,
	now = new Date(),
): Promise<string | null> {
	const cacheKey = normalizeTopic(query);
	if (!cacheKey) return null;
	const cached = await getTopicDiscoveryCache(env.DB, cacheKey, now);
	return cached?.nextPageToken ?? null;
}
