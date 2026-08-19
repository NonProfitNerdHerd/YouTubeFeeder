import type { DiscoveryResult } from '../../../src/types/discover';
import { getTopicDiscoveryCache } from '../../db/discoverCache';
import { normalizeDiscoverQuery } from './youtube';
import {
	buildLegacyInterestQueryKeys,
	buildPhraseLookupKeys,
	canonicalizeClusterQueryKey,
	type ClusterQuery,
} from './clusterQueries';
import type { InterestFingerprint } from './interestFingerprint';

export interface CacheLookupResult {
	results: DiscoveryResult[];
	hitKeys: string[];
	missKeys: string[];
}

export function collectCacheLookupKeys(clusterQuery: ClusterQuery, fingerprint: InterestFingerprint): string[] {
	const keys: string[] = [];
	const add = (key: string) => {
		const trimmed = key.trim();
		if (!trimmed || keys.includes(trimmed)) return;
		keys.push(trimmed);
	};

	add(clusterQuery.cacheKey);
	add(normalizeDiscoverQuery(clusterQuery.query));
	add(canonicalizeClusterQueryKey(clusterQuery.query));

	for (const phrase of clusterQuery.phrases ?? []) {
		add(normalizeDiscoverQuery(phrase));
	}

	for (const legacyKey of buildLegacyInterestQueryKeys(fingerprint)) {
		add(legacyKey);
	}

	return keys;
}

export async function loadCachedCandidatesWithFallback(
	env: Env,
	clusterQuery: ClusterQuery,
	fingerprint: InterestFingerprint,
	now = new Date(),
): Promise<CacheLookupResult> {
	const keys = collectCacheLookupKeys(clusterQuery, fingerprint);
	const merged: DiscoveryResult[] = [];
	const hitKeys: string[] = [];
	const missKeys: string[] = [];
	const seen = new Set<string>();

	for (const key of keys) {
		const cached = await getTopicDiscoveryCache(env.DB, key, now);
		if (!cached?.results.length) {
			missKeys.push(key);
			continue;
		}
		hitKeys.push(key);
		for (const row of cached.results) {
			if (seen.has(row.externalId)) continue;
			seen.add(row.externalId);
			merged.push(row);
		}
	}

	return { results: merged, hitKeys, missKeys };
}

export async function loadPhraseCacheCandidates(
	env: Env,
	fingerprint: InterestFingerprint,
	now = new Date(),
	maxPhrases = 3,
): Promise<CacheLookupResult> {
	const merged: DiscoveryResult[] = [];
	const hitKeys: string[] = [];
	const missKeys: string[] = [];
	const seen = new Set<string>();

	for (const key of buildPhraseLookupKeys(fingerprint, maxPhrases)) {
		const cached = await getTopicDiscoveryCache(env.DB, key, now);
		if (!cached?.results.length) {
			missKeys.push(key);
			continue;
		}
		hitKeys.push(key);
		for (const row of cached.results) {
			if (seen.has(row.externalId)) continue;
			seen.add(row.externalId);
			merged.push(row);
		}
	}

	return { results: merged, hitKeys, missKeys };
}
