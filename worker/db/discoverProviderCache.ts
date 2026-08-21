import type {
	DiscoverProviderCacheRecord,
	DiscoverProviderCacheWrite,
	DiscoveryProviderRawHit,
} from '../services/discover/provider/types';

export const DISCOVER_PROVIDER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Keep expired rows briefly so stale-while-error can still serve them. */
export const DISCOVER_PROVIDER_STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DISCOVER_PROVIDER_LOCK_TTL_MS = 25_000;

export function discoverProviderCacheKey(
	provider: string,
	contentType: string,
	strategyVersion: string,
	normalizedQuery: string,
): string {
	return `${provider}:${contentType}:${strategyVersion}:${normalizedQuery}`;
}

function parseHits(json: string): DiscoveryProviderRawHit[] {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((row): row is DiscoveryProviderRawHit => {
			return Boolean(row && typeof row === 'object' && typeof (row as DiscoveryProviderRawHit).url === 'string');
		});
	} catch {
		return [];
	}
}

function mapRow(
	row: {
		cache_key: string;
		provider: string;
		content_type: string;
		normalized_query: string;
		strategy_version: string;
		raw_results_json: string;
		candidates_json: string;
		provider_offset: number;
		more_results_available: number;
		candidate_consume_offset: number;
		raw_result_count: number;
		searched_at: string;
		updated_at: string;
		expires_at: string;
	},
	now: Date,
): DiscoverProviderCacheRecord {
	return {
		cacheKey: row.cache_key,
		provider: row.provider,
		contentType: row.content_type,
		normalizedQuery: row.normalized_query,
		strategyVersion: row.strategy_version,
		rawResults: parseHits(row.raw_results_json),
		candidates: parseHits(row.candidates_json),
		providerOffset: Number(row.provider_offset ?? 0),
		moreResultsAvailable: Boolean(row.more_results_available),
		candidateConsumeOffset: Number(row.candidate_consume_offset ?? 0),
		rawResultCount: Number(row.raw_result_count ?? 0),
		searchedAt: row.searched_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
		stale: row.expires_at <= now.toISOString(),
	};
}

/** Lazy cleanup — inexpensive; call on read/write paths, not a dedicated high-frequency cron. */
export async function cleanupExpiredDiscoverProviderRows(db: D1Database, now = new Date()): Promise<void> {
	const iso = now.toISOString();
	await db.prepare(`DELETE FROM discover_provider_locks WHERE expires_at <= ?`).bind(iso).run();
	// Retain expired cache for a short window so stale-while-error still works.
	const cacheDeleteBefore = new Date(now.getTime() - DISCOVER_PROVIDER_STALE_RETENTION_MS).toISOString();
	await db.prepare(`DELETE FROM discover_provider_cache WHERE expires_at <= ?`).bind(cacheDeleteBefore).run();
}

export async function getDiscoverProviderCache(
	db: D1Database,
	cacheKey: string,
	now = new Date(),
): Promise<DiscoverProviderCacheRecord | null> {
	const row = await db
		.prepare(
			`SELECT cache_key, provider, content_type, normalized_query, strategy_version,
			        raw_results_json, candidates_json, provider_offset, more_results_available,
			        candidate_consume_offset, raw_result_count, searched_at, updated_at, expires_at
			 FROM discover_provider_cache WHERE cache_key = ?`,
		)
		.bind(cacheKey)
		.first<{
			cache_key: string;
			provider: string;
			content_type: string;
			normalized_query: string;
			strategy_version: string;
			raw_results_json: string;
			candidates_json: string;
			provider_offset: number;
			more_results_available: number;
			candidate_consume_offset: number;
			raw_result_count: number;
			searched_at: string;
			updated_at: string;
			expires_at: string;
		}>();
	if (!row) return null;
	return mapRow(row, now);
}

export async function putDiscoverProviderCache(
	db: D1Database,
	write: DiscoverProviderCacheWrite,
	ttlMs = DISCOVER_PROVIDER_CACHE_TTL_MS,
	now = new Date(),
): Promise<DiscoverProviderCacheRecord> {
	const cacheKey = discoverProviderCacheKey(
		write.provider,
		write.contentType,
		write.strategyVersion,
		write.normalizedQuery,
	);
	const searchedAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	const candidates = write.candidates ?? [];
	const rawResultCount = write.rawResults.length;
	const candidateConsumeOffset = write.candidateConsumeOffset ?? 0;

	await db
		.prepare(
			`INSERT INTO discover_provider_cache (
				cache_key, provider, content_type, normalized_query, strategy_version,
				raw_results_json, candidates_json, provider_offset, more_results_available,
				candidate_consume_offset, raw_result_count, searched_at, updated_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(cache_key) DO UPDATE SET
				raw_results_json = excluded.raw_results_json,
				candidates_json = excluded.candidates_json,
				provider_offset = excluded.provider_offset,
				more_results_available = excluded.more_results_available,
				candidate_consume_offset = excluded.candidate_consume_offset,
				raw_result_count = excluded.raw_result_count,
				searched_at = excluded.searched_at,
				updated_at = excluded.updated_at,
				expires_at = excluded.expires_at`,
		)
		.bind(
			cacheKey,
			write.provider,
			write.contentType,
			write.normalizedQuery,
			write.strategyVersion,
			JSON.stringify(write.rawResults),
			JSON.stringify(candidates),
			write.providerOffset,
			write.moreResultsAvailable ? 1 : 0,
			candidateConsumeOffset,
			rawResultCount,
			searchedAt,
			searchedAt,
			expiresAt,
		)
		.run();

	return {
		cacheKey,
		provider: write.provider,
		contentType: write.contentType,
		normalizedQuery: write.normalizedQuery,
		strategyVersion: write.strategyVersion,
		rawResults: write.rawResults,
		candidates,
		providerOffset: write.providerOffset,
		moreResultsAvailable: write.moreResultsAvailable,
		candidateConsumeOffset,
		rawResultCount,
		searchedAt,
		updatedAt: searchedAt,
		expiresAt,
		stale: false,
	};
}

/**
 * Append another provider page into an existing cache row.
 * Keeps usable-candidate cursor intact so provider pagination ≠ candidate consumption.
 */
export async function appendDiscoverProviderCachePage(
	db: D1Database,
	cacheKey: string,
	page: {
		rawHits: DiscoveryProviderRawHit[];
		candidates?: DiscoveryProviderRawHit[];
		providerOffset: number;
		moreResultsAvailable: boolean;
	},
	ttlMs = DISCOVER_PROVIDER_CACHE_TTL_MS,
	now = new Date(),
): Promise<DiscoverProviderCacheRecord | null> {
	const existing = await getDiscoverProviderCache(db, cacheKey, now);
	if (!existing) return null;

	const seenUrls = new Set(existing.rawResults.map((h) => h.url));
	const mergedRaw = [...existing.rawResults];
	for (const hit of page.rawHits) {
		if (seenUrls.has(hit.url)) continue;
		seenUrls.add(hit.url);
		mergedRaw.push(hit);
	}

	const mergedCandidates = [...existing.candidates];
	if (page.candidates?.length) {
		const seenCand = new Set(mergedCandidates.map((h) => h.url));
		for (const hit of page.candidates) {
			if (seenCand.has(hit.url)) continue;
			seenCand.add(hit.url);
			mergedCandidates.push(hit);
		}
	}

	return putDiscoverProviderCache(
		db,
		{
			provider: existing.provider,
			contentType: existing.contentType,
			normalizedQuery: existing.normalizedQuery,
			strategyVersion: existing.strategyVersion,
			rawResults: mergedRaw,
			candidates: mergedCandidates,
			providerOffset: page.providerOffset,
			moreResultsAvailable: page.moreResultsAvailable,
			candidateConsumeOffset: existing.candidateConsumeOffset,
		},
		ttlMs,
		now,
	);
}

export async function updateDiscoverProviderCandidateCursor(
	db: D1Database,
	cacheKey: string,
	candidateConsumeOffset: number,
	now = new Date(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE discover_provider_cache
			 SET candidate_consume_offset = ?, updated_at = ?
			 WHERE cache_key = ?`,
		)
		.bind(Math.max(0, Math.floor(candidateConsumeOffset)), now.toISOString(), cacheKey)
		.run();
}

export async function tryAcquireDiscoverProviderLock(
	db: D1Database,
	cacheKey: string,
	lockOwner: string,
	ttlMs = DISCOVER_PROVIDER_LOCK_TTL_MS,
	now = new Date(),
): Promise<boolean> {
	const iso = now.toISOString();
	await db.prepare(`DELETE FROM discover_provider_locks WHERE cache_key = ? AND expires_at <= ?`).bind(cacheKey, iso).run();

	const existing = await db
		.prepare(`SELECT lock_owner, expires_at FROM discover_provider_locks WHERE cache_key = ?`)
		.bind(cacheKey)
		.first<{ lock_owner: string; expires_at: string }>();

	if (existing && existing.expires_at > iso && existing.lock_owner !== lockOwner) {
		return false;
	}

	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	await db
		.prepare(
			`INSERT INTO discover_provider_locks (cache_key, lock_owner, locked_at, expires_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(cache_key) DO UPDATE SET
				lock_owner = excluded.lock_owner,
				locked_at = excluded.locked_at,
				expires_at = excluded.expires_at
			 WHERE discover_provider_locks.expires_at <= excluded.locked_at
			    OR discover_provider_locks.lock_owner = excluded.lock_owner`,
		)
		.bind(cacheKey, lockOwner, iso, expiresAt)
		.run();

	const held = await db
		.prepare(`SELECT lock_owner FROM discover_provider_locks WHERE cache_key = ? AND expires_at > ?`)
		.bind(cacheKey, iso)
		.first<{ lock_owner: string }>();
	return held?.lock_owner === lockOwner;
}

export async function releaseDiscoverProviderLock(
	db: D1Database,
	cacheKey: string,
	lockOwner: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM discover_provider_locks WHERE cache_key = ? AND lock_owner = ?`)
		.bind(cacheKey, lockOwner)
		.run();
}

export async function getDiscoverProviderLock(
	db: D1Database,
	cacheKey: string,
	now = new Date(),
): Promise<{ lockOwner: string; lockedAt: string; expiresAt: string; expired: boolean } | null> {
	const row = await db
		.prepare(`SELECT lock_owner, locked_at, expires_at FROM discover_provider_locks WHERE cache_key = ?`)
		.bind(cacheKey)
		.first<{ lock_owner: string; locked_at: string; expires_at: string }>();
	if (!row) return null;
	return {
		lockOwner: row.lock_owner,
		lockedAt: row.locked_at,
		expiresAt: row.expires_at,
		expired: row.expires_at <= now.toISOString(),
	};
}
