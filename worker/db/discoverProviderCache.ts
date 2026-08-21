import type {
	DiscoverProviderCacheRecord,
	DiscoverProviderCacheWrite,
	DiscoveryProviderCandidate,
	DiscoveryProviderRawHit,
} from '../services/discover/provider/types';

export const DISCOVER_PROVIDER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Short TTL when resolution failed so we do not poison Discover for 30 days. */
export const DISCOVER_PROVIDER_FAILED_TTL_MS = 60 * 60 * 1000;
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

function parseYoutubeCandidates(json: string): DiscoveryProviderCandidate[] {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((row): row is DiscoveryProviderCandidate => {
			const c = row as DiscoveryProviderCandidate;
			return Boolean(
				c &&
					typeof c === 'object' &&
					typeof c.externalId === 'string' &&
					c.externalId.startsWith('UC') &&
					typeof c.title === 'string',
			);
		});
	} catch {
		return [];
	}
}

function parseCandidates(json: string, contentType: string): DiscoveryProviderCandidate[] {
	if (contentType === 'podcast') {
		// Podcast candidates are stored as DiscoveryProviderCandidate-shaped rows with feedUrlNormalized.
		try {
			const parsed = JSON.parse(json) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((row): row is DiscoveryProviderCandidate => {
				const c = row as DiscoveryProviderCandidate & { feedUrlNormalized?: string; feedUrl?: string };
				return Boolean(
					c &&
						typeof c === 'object' &&
						typeof c.title === 'string' &&
						typeof c.feedUrlNormalized === 'string' &&
						c.feedUrlNormalized.length > 0 &&
						typeof c.feedUrl === 'string' &&
						c.feedUrl.length > 0,
				);
			});
		} catch {
			return [];
		}
	}
	return parseYoutubeCandidates(json);
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
		resolver_version?: string | null;
		resolution_status?: string | null;
	},
	now: Date,
): DiscoverProviderCacheRecord {
	return {
		cacheKey: row.cache_key,
		provider: row.provider,
		contentType: row.content_type,
		normalizedQuery: row.normalized_query,
		strategyVersion: row.strategy_version,
		resolverVersion: row.resolver_version ?? 'v1',
		resolutionStatus: row.resolution_status ?? 'ok',
		rawResults: parseHits(row.raw_results_json),
		candidates: parseCandidates(row.candidates_json, row.content_type),
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
			        candidate_consume_offset, raw_result_count, searched_at, updated_at, expires_at,
			        resolver_version, resolution_status
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
			resolver_version?: string | null;
			resolution_status?: string | null;
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
	const resolverVersion = write.resolverVersion ?? 'v1';
	const resolutionStatus = write.resolutionStatus ?? 'ok';

	await db
		.prepare(
			`INSERT INTO discover_provider_cache (
				cache_key, provider, content_type, normalized_query, strategy_version,
				raw_results_json, candidates_json, provider_offset, more_results_available,
				candidate_consume_offset, raw_result_count, searched_at, updated_at, expires_at,
				resolver_version, resolution_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(cache_key) DO UPDATE SET
				raw_results_json = excluded.raw_results_json,
				candidates_json = excluded.candidates_json,
				provider_offset = excluded.provider_offset,
				more_results_available = excluded.more_results_available,
				candidate_consume_offset = excluded.candidate_consume_offset,
				raw_result_count = excluded.raw_result_count,
				searched_at = excluded.searched_at,
				updated_at = excluded.updated_at,
				expires_at = excluded.expires_at,
				resolver_version = excluded.resolver_version,
				resolution_status = excluded.resolution_status`,
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
			resolverVersion,
			resolutionStatus,
		)
		.run();

	return {
		cacheKey,
		provider: write.provider,
		contentType: write.contentType,
		normalizedQuery: write.normalizedQuery,
		strategyVersion: write.strategyVersion,
		resolverVersion,
		resolutionStatus,
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

/** Update resolved candidates without changing Brave raw hits / pagination / searched_at. */
export async function updateDiscoverProviderResolvedCandidates(
	db: D1Database,
	cacheKey: string,
	update: {
		candidates: DiscoveryProviderCandidate[];
		resolverVersion: string;
		resolutionStatus: string;
		ttlMs?: number;
	},
	now = new Date(),
): Promise<DiscoverProviderCacheRecord | null> {
	const existing = await getDiscoverProviderCache(db, cacheKey, now);
	if (!existing) return null;
	const ttlMs =
		update.ttlMs ??
		(update.resolutionStatus === 'failed' ? DISCOVER_PROVIDER_FAILED_TTL_MS : DISCOVER_PROVIDER_CACHE_TTL_MS);
	const updatedAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	await db
		.prepare(
			`UPDATE discover_provider_cache SET
				candidates_json = ?,
				resolver_version = ?,
				resolution_status = ?,
				updated_at = ?,
				expires_at = ?
			 WHERE cache_key = ?`,
		)
		.bind(
			JSON.stringify(update.candidates),
			update.resolverVersion,
			update.resolutionStatus,
			updatedAt,
			expiresAt,
			cacheKey,
		)
		.run();
	return {
		...existing,
		candidates: update.candidates,
		resolverVersion: update.resolverVersion,
		resolutionStatus: update.resolutionStatus,
		updatedAt,
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
		candidates?: DiscoveryProviderCandidate[];
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
		const seenIds = new Set(mergedCandidates.map((c) => c.externalId));
		for (const cand of page.candidates) {
			if (seenIds.has(cand.externalId)) {
				const prior = mergedCandidates.find((c) => c.externalId === cand.externalId);
				if (prior && cand.sourceUrls?.length) {
					prior.sourceUrls = [...new Set([...(prior.sourceUrls ?? []), ...cand.sourceUrls])];
				}
				continue;
			}
			seenIds.add(cand.externalId);
			mergedCandidates.push(cand);
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
			resolverVersion: existing.resolverVersion,
			resolutionStatus: existing.resolutionStatus,
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
