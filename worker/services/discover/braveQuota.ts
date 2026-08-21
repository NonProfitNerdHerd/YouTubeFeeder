import { recordQuota } from '../websub';
import {
	DEFAULT_BRAVE_GLOBAL_DAILY_SOFT_CAP,
	DEFAULT_BRAVE_USER_DAILY_SOFT_CAP,
	type BraveDiscoverConfig,
} from './provider/braveConfig';

/** Global Brave call counter in api_quota_daily (call_count = requests). */
export const BRAVE_SEARCH_ENDPOINT = 'discover.brave.search';
export const BRAVE_CACHE_HIT_ENDPOINT = 'discover.brave.cache_hit';
export const BRAVE_CACHE_MISS_ENDPOINT = 'discover.brave.cache_miss';
export const BRAVE_ZERO_RESULT_ENDPOINT = 'discover.brave.zero_result';
export const BRAVE_API_ERROR_ENDPOINT = 'discover.brave.api_error';

export interface BraveUsageStatus {
	userRequestsToday: number;
	globalRequestsToday: number;
	userDailySoftCap: number;
	globalDailySoftCap: number;
	canCallBrave: boolean;
	blockReason: 'ok' | 'user_cap' | 'global_cap';
}

async function braveUsageRow(
	db: D1Database,
	userId: string,
	day = new Date().toISOString().slice(0, 10),
): Promise<{
	request_count: number;
	cache_hits: number;
	cache_misses: number;
	zero_result_searches: number;
	api_errors: number;
	usable_candidate_count: number;
} | null> {
	return db
		.prepare(
			`SELECT request_count, cache_hits, cache_misses, zero_result_searches, api_errors, usable_candidate_count
			 FROM discover_brave_usage_daily WHERE day = ? AND user_id = ?`,
		)
		.bind(day, userId)
		.first();
}

export async function getBraveUserRequestCount(db: D1Database, userId: string): Promise<number> {
	const row = await braveUsageRow(db, userId);
	return Number(row?.request_count ?? 0);
}

export async function getBraveGlobalRequestCount(db: D1Database): Promise<number> {
	const day = new Date().toISOString().slice(0, 10);
	const row = await db
		.prepare(`SELECT call_count FROM api_quota_daily WHERE day = ? AND endpoint = ?`)
		.bind(day, BRAVE_SEARCH_ENDPOINT)
		.first<{ call_count: number }>();
	return Number(row?.call_count ?? 0);
}

export async function braveUsageStatus(
	db: D1Database,
	userId: string,
	config: Pick<BraveDiscoverConfig, 'userDailySoftCap' | 'globalDailySoftCap'>,
): Promise<BraveUsageStatus> {
	const userDailySoftCap = config.userDailySoftCap ?? DEFAULT_BRAVE_USER_DAILY_SOFT_CAP;
	const globalDailySoftCap = config.globalDailySoftCap ?? DEFAULT_BRAVE_GLOBAL_DAILY_SOFT_CAP;
	const userRequestsToday = await getBraveUserRequestCount(db, userId);
	const globalRequestsToday = await getBraveGlobalRequestCount(db);
	if (globalRequestsToday >= globalDailySoftCap) {
		return {
			userRequestsToday,
			globalRequestsToday,
			userDailySoftCap,
			globalDailySoftCap,
			canCallBrave: false,
			blockReason: 'global_cap',
		};
	}
	if (userRequestsToday >= userDailySoftCap) {
		return {
			userRequestsToday,
			globalRequestsToday,
			userDailySoftCap,
			globalDailySoftCap,
			canCallBrave: false,
			blockReason: 'user_cap',
		};
	}
	return {
		userRequestsToday,
		globalRequestsToday,
		userDailySoftCap,
		globalDailySoftCap,
		canCallBrave: true,
		blockReason: 'ok',
	};
}

async function bumpUserUsage(
	db: D1Database,
	userId: string,
	field:
		| 'request_count'
		| 'cache_hits'
		| 'cache_misses'
		| 'zero_result_searches'
		| 'api_errors'
		| 'usable_candidate_count',
	amount = 1,
): Promise<void> {
	const day = new Date().toISOString().slice(0, 10);
	await db
		.prepare(
			`INSERT INTO discover_brave_usage_daily (
				day, user_id, request_count, cache_hits, cache_misses,
				zero_result_searches, api_errors, usable_candidate_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(day, user_id) DO UPDATE SET
				${field} = ${field} + excluded.${field}`,
		)
		.bind(
			day,
			userId,
			field === 'request_count' ? amount : 0,
			field === 'cache_hits' ? amount : 0,
			field === 'cache_misses' ? amount : 0,
			field === 'zero_result_searches' ? amount : 0,
			field === 'api_errors' ? amount : 0,
			field === 'usable_candidate_count' ? amount : 0,
		)
		.run();
}

/** Count an actual outbound Brave HTTP request (success or error after the request was sent). */
export async function recordBraveApiRequest(db: D1Database, userId: string): Promise<void> {
	await bumpUserUsage(db, userId, 'request_count', 1);
	await recordQuota(db, BRAVE_SEARCH_ENDPOINT, { callCount: 1, generalUnits: 0, searchCalls: 0 });
}

export async function recordBraveCacheHit(db: D1Database, userId: string): Promise<void> {
	await bumpUserUsage(db, userId, 'cache_hits', 1);
	await recordQuota(db, BRAVE_CACHE_HIT_ENDPOINT, { callCount: 1 });
}

export async function recordBraveCacheMiss(db: D1Database, userId: string): Promise<void> {
	await bumpUserUsage(db, userId, 'cache_misses', 1);
	await recordQuota(db, BRAVE_CACHE_MISS_ENDPOINT, { callCount: 1 });
}

export async function recordBraveZeroResultSearch(db: D1Database, userId: string): Promise<void> {
	await bumpUserUsage(db, userId, 'zero_result_searches', 1);
	await recordQuota(db, BRAVE_ZERO_RESULT_ENDPOINT, { callCount: 1 });
}

export async function recordBraveApiError(db: D1Database, userId: string): Promise<void> {
	await bumpUserUsage(db, userId, 'api_errors', 1);
	await recordQuota(db, BRAVE_API_ERROR_ENDPOINT, { callCount: 1 });
}

/** Reserved for Phase 5+ when usable candidates are produced. */
export async function recordBraveUsableCandidates(db: D1Database, userId: string, count: number): Promise<void> {
	if (count <= 0) return;
	await bumpUserUsage(db, userId, 'usable_candidate_count', count);
}

export async function getBraveUsageSnapshot(
	db: D1Database,
	userId: string,
): Promise<{
	user: {
		requestCount: number;
		cacheHits: number;
		cacheMisses: number;
		zeroResultSearches: number;
		apiErrors: number;
		usableCandidateCount: number;
	};
	globalRequestCount: number;
}> {
	const row = await braveUsageRow(db, userId);
	return {
		user: {
			requestCount: Number(row?.request_count ?? 0),
			cacheHits: Number(row?.cache_hits ?? 0),
			cacheMisses: Number(row?.cache_misses ?? 0),
			zeroResultSearches: Number(row?.zero_result_searches ?? 0),
			apiErrors: Number(row?.api_errors ?? 0),
			usableCandidateCount: Number(row?.usable_candidate_count ?? 0),
		},
		globalRequestCount: await getBraveGlobalRequestCount(db),
	};
}
