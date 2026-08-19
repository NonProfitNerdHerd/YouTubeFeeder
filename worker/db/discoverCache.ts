import type { DiscoveryResult } from '../../src/types/discover';

export const DISCOVER_SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
export const DISCOVER_BROWSE_POPULAR_TTL_MS = 6 * 60 * 60 * 1000;
export const DISCOVER_TOPIC_CACHE_TTL_MS = 60 * 60 * 1000;

export function discoverSearchCacheKey(provider: string, normalizedQuery: string): string {
	return `${provider}:${normalizedQuery}`;
}

export async function getDiscoverSearchCache(
	db: D1Database,
	cacheKey: string,
	now = new Date(),
): Promise<{ results: DiscoveryResult[]; searchedAt: string; stale: boolean } | null> {
	const row = await db
		.prepare(`SELECT results_json, searched_at, expires_at FROM discover_search_cache WHERE cache_key = ?`)
		.bind(cacheKey)
		.first<{ results_json: string; searched_at: string; expires_at: string }>();
	if (!row) return null;
	let results: DiscoveryResult[] = [];
	try {
		results = JSON.parse(row.results_json) as DiscoveryResult[];
	} catch {
		return null;
	}
	const fresh = row.expires_at > now.toISOString();
	return { results, searchedAt: row.searched_at, stale: !fresh };
}

export async function putDiscoverSearchCache(
	db: D1Database,
	cacheKey: string,
	results: DiscoveryResult[],
	ttlMs = DISCOVER_SEARCH_CACHE_TTL_MS,
	now = new Date(),
): Promise<void> {
	const searchedAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	await db
		.prepare(
			`INSERT INTO discover_search_cache (cache_key, results_json, searched_at, expires_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(cache_key) DO UPDATE SET
				results_json = excluded.results_json,
				searched_at = excluded.searched_at,
				expires_at = excluded.expires_at`,
		)
		.bind(cacheKey, JSON.stringify(results), searchedAt, expiresAt)
		.run();
}

export async function getDiscoverBrowseCache<T>(
	db: D1Database,
	sectionKey: string,
	now = new Date(),
): Promise<{ payload: T; refreshedAt: string; stale: boolean } | null> {
	const row = await db
		.prepare(`SELECT payload_json, refreshed_at, expires_at FROM discover_browse_cache WHERE section_key = ?`)
		.bind(sectionKey)
		.first<{ payload_json: string; refreshed_at: string; expires_at: string }>();
	if (!row) return null;
	let payload: T;
	try {
		payload = JSON.parse(row.payload_json) as T;
	} catch {
		return null;
	}
	const fresh = row.expires_at > now.toISOString();
	return { payload, refreshedAt: row.refreshed_at, stale: !fresh };
}

export async function putDiscoverBrowseCache<T>(
	db: D1Database,
	sectionKey: string,
	payload: T,
	ttlMs: number,
	now = new Date(),
): Promise<void> {
	const refreshedAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	await db
		.prepare(
			`INSERT INTO discover_browse_cache (section_key, payload_json, refreshed_at, expires_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(section_key) DO UPDATE SET
				payload_json = excluded.payload_json,
				refreshed_at = excluded.refreshed_at,
				expires_at = excluded.expires_at`,
		)
		.bind(sectionKey, JSON.stringify(payload), refreshedAt, expiresAt)
		.run();
}

export async function getTopicDiscoveryCache(
	db: D1Database,
	normalizedTopic: string,
	now = new Date(),
): Promise<{ results: DiscoveryResult[]; searchedAt: string; stale: boolean } | null> {
	const row = await db
		.prepare(`SELECT results_json, searched_at, expires_at FROM topic_discovery_cache WHERE normalized_topic = ?`)
		.bind(normalizedTopic)
		.first<{ results_json: string; searched_at: string; expires_at: string }>();
	if (!row) return null;
	let results: DiscoveryResult[] = [];
	try {
		results = JSON.parse(row.results_json) as DiscoveryResult[];
	} catch {
		return null;
	}
	const fresh = row.expires_at > now.toISOString();
	return { results, searchedAt: row.searched_at, stale: !fresh };
}

export async function putTopicDiscoveryCache(
	db: D1Database,
	normalizedTopic: string,
	results: DiscoveryResult[],
	ttlMs = DISCOVER_TOPIC_CACHE_TTL_MS,
	now = new Date(),
): Promise<void> {
	const searchedAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	await db
		.prepare(
			`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(normalized_topic) DO UPDATE SET
				results_json = excluded.results_json,
				searched_at = excluded.searched_at,
				expires_at = excluded.expires_at`,
		)
		.bind(normalizedTopic, JSON.stringify(results), searchedAt, expiresAt)
		.run();
}
