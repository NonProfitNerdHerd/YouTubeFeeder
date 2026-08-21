import type { DiscoveryResult } from '../../../src/types/discover';
import { getTopicDiscoveryCache } from '../../db/discoverCache';
import { discoverProviderCacheKey, getDiscoverProviderCache } from '../../db/discoverProviderCache';
import { normalizeDiscoverQuery } from './youtube';
import {
	buildLegacyInterestQueryKeys,
	buildPhraseLookupKeys,
	canonicalizeClusterQueryKey,
	type ClusterQuery,
} from './clusterQueries';
import type { InterestFingerprint } from './interestFingerprint';
import { braveDiscoverConfigFromEnv } from './provider/braveConfig';
import { providerCandidatesToDiscoveryResults } from './provider/braveProviderPool';

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

async function loadFromProviderCache(
	env: Env,
	queryOrKey: string,
	now: Date,
	seen: Set<string>,
	merged: DiscoveryResult[],
): Promise<string | null> {
	const config = braveDiscoverConfigFromEnv(env);
	if (config.providerMode !== 'brave') return null;
	const normalized = normalizeDiscoverQuery(queryOrKey);
	if (!normalized) return null;
	const cacheKey = discoverProviderCacheKey('brave', 'youtube', config.strategyVersion, normalized);
	const record = await getDiscoverProviderCache(env.DB, cacheKey, now);
	if (!record?.candidates.length) return null;
	for (const row of providerCandidatesToDiscoveryResults(record.candidates)) {
		if (seen.has(row.externalId)) continue;
		seen.add(row.externalId);
		merged.push(row);
	}
	return cacheKey;
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

	const providerHit = await loadFromProviderCache(env, clusterQuery.query || clusterQuery.cacheKey, now, seen, merged);
	if (providerHit) hitKeys.push(providerHit);

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

	const config = braveDiscoverConfigFromEnv(env);
	if (config.providerMode === 'brave' && fingerprint.label.trim()) {
		const providerHit = await loadFromProviderCache(env, fingerprint.label, now, seen, merged);
		if (providerHit) hitKeys.push(providerHit);
	}

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
