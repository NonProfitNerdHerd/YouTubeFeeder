import type { LiveSourceMode } from '../services/quadClassify';
import { clampConfirmMs, clampDiscoveryMs } from '../services/quadClassify';

export interface QuadSettings {
	pollingEnabled: boolean;
	confirmIntervalSeconds: number;
	discoveryIntervalSeconds: number;
	cacheMaxAgeSeconds: number;
	defaultSourceMode: LiveSourceMode;
	searchFallbackEnabled: boolean;
	searchDailyAllowance: number;
}

export const DEFAULT_QUAD_SETTINGS: QuadSettings = {
	pollingEnabled: false,
	confirmIntervalSeconds: 300,
	discoveryIntervalSeconds: 900,
	cacheMaxAgeSeconds: 300,
	defaultSourceMode: 'normal',
	searchFallbackEnabled: true,
	searchDailyAllowance: 20,
};

function parseMode(value: string | null | undefined): LiveSourceMode {
	if (value === 'always_on' || value === 'on_demand' || value === 'disabled' || value === 'normal') return value;
	return 'normal';
}

export async function getQuadSettings(db: D1Database, userId: string): Promise<QuadSettings> {
	const row = await db
		.prepare(
			`SELECT polling_enabled, confirm_interval_seconds, discovery_interval_seconds, cache_max_age_seconds,
				default_source_mode, search_fallback_enabled, search_daily_allowance
			 FROM live_quad_settings WHERE user_id = ?`,
		)
		.bind(userId)
		.first<{
			polling_enabled: number;
			confirm_interval_seconds: number;
			discovery_interval_seconds: number;
			cache_max_age_seconds: number;
			default_source_mode: string;
			search_fallback_enabled: number;
			search_daily_allowance: number;
		}>();
	if (!row) return { ...DEFAULT_QUAD_SETTINGS };
	return {
		pollingEnabled: row.polling_enabled === 1,
		confirmIntervalSeconds: clampConfirmMs(row.confirm_interval_seconds) / 1000,
		discoveryIntervalSeconds: clampDiscoveryMs(row.discovery_interval_seconds) / 1000,
		cacheMaxAgeSeconds: Math.max(300, row.cache_max_age_seconds || 300),
		defaultSourceMode: parseMode(row.default_source_mode),
		searchFallbackEnabled: row.search_fallback_enabled === 1,
		searchDailyAllowance: Math.max(0, row.search_daily_allowance ?? 20),
	};
}

export async function putQuadSettings(db: D1Database, userId: string, patch: Partial<QuadSettings>): Promise<QuadSettings> {
	const current = await getQuadSettings(db, userId);
	const next: QuadSettings = {
		pollingEnabled: patch.pollingEnabled ?? current.pollingEnabled,
		confirmIntervalSeconds: clampConfirmMs(patch.confirmIntervalSeconds ?? current.confirmIntervalSeconds) / 1000,
		discoveryIntervalSeconds: clampDiscoveryMs(patch.discoveryIntervalSeconds ?? current.discoveryIntervalSeconds) / 1000,
		cacheMaxAgeSeconds: Math.max(300, patch.cacheMaxAgeSeconds ?? current.cacheMaxAgeSeconds),
		defaultSourceMode: parseMode(patch.defaultSourceMode ?? current.defaultSourceMode),
		searchFallbackEnabled: patch.searchFallbackEnabled ?? current.searchFallbackEnabled,
		searchDailyAllowance: Math.max(0, patch.searchDailyAllowance ?? current.searchDailyAllowance),
	};
	await db
		.prepare(
			`INSERT INTO live_quad_settings (
				user_id, polling_enabled, confirm_interval_seconds, discovery_interval_seconds, cache_max_age_seconds,
				default_source_mode, search_fallback_enabled, search_daily_allowance
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				polling_enabled = excluded.polling_enabled,
				confirm_interval_seconds = excluded.confirm_interval_seconds,
				discovery_interval_seconds = excluded.discovery_interval_seconds,
				cache_max_age_seconds = excluded.cache_max_age_seconds,
				default_source_mode = excluded.default_source_mode,
				search_fallback_enabled = excluded.search_fallback_enabled,
				search_daily_allowance = excluded.search_daily_allowance,
				updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
		)
		.bind(
			userId,
			next.pollingEnabled ? 1 : 0,
			next.confirmIntervalSeconds,
			next.discoveryIntervalSeconds,
			next.cacheMaxAgeSeconds,
			next.defaultSourceMode,
			next.searchFallbackEnabled ? 1 : 0,
			next.searchDailyAllowance,
		)
		.run();
	return next;
}

export async function bumpQuadStats(
	db: D1Database,
	userId: string,
	day: string,
	patch: {
		generalApiCalls?: number;
		searchQueries?: number;
		cacheHits?: number;
		duplicatesPrevented?: number;
		lastConfirmAt?: string;
		lastDiscoverAt?: string;
		nextConfirmAt?: string;
		nextDiscoverAt?: string;
		lastDurationMs?: number;
		lastError?: string | null;
	},
): Promise<void> {
	await db.prepare(`INSERT OR IGNORE INTO live_quad_stats (user_id, day) VALUES (?, ?)`).bind(userId, day).run();
	const row = await db.prepare(`SELECT day FROM live_quad_stats WHERE user_id = ?`).bind(userId).first<{ day: string }>();
	if (row && row.day !== day) {
		await db
			.prepare(
				`UPDATE live_quad_stats SET day = ?, general_api_calls = 0, search_queries = 0, cache_hits = 0, duplicates_prevented = 0 WHERE user_id = ?`,
			)
			.bind(day, userId)
			.run();
	}
	await db
		.prepare(
			`UPDATE live_quad_stats SET
				general_api_calls = general_api_calls + ?,
				search_queries = search_queries + ?,
				cache_hits = cache_hits + ?,
				duplicates_prevented = duplicates_prevented + ?,
				last_confirm_at = COALESCE(?, last_confirm_at),
				last_discover_at = COALESCE(?, last_discover_at),
				next_confirm_at = COALESCE(?, next_confirm_at),
				next_discover_at = COALESCE(?, next_discover_at),
				last_duration_ms = COALESCE(?, last_duration_ms),
				last_error = CASE WHEN ? = 1 THEN ? ELSE last_error END,
				updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE user_id = ?`,
		)
		.bind(
			patch.generalApiCalls ?? 0,
			patch.searchQueries ?? 0,
			patch.cacheHits ?? 0,
			patch.duplicatesPrevented ?? 0,
			patch.lastConfirmAt ?? null,
			patch.lastDiscoverAt ?? null,
			patch.nextConfirmAt ?? null,
			patch.nextDiscoverAt ?? null,
			patch.lastDurationMs ?? null,
			patch.lastError !== undefined ? 1 : 0,
			patch.lastError ?? null,
			userId,
		)
		.run();
}

export async function getQuadStats(db: D1Database, userId: string, day: string) {
	const row = await db
		.prepare(
			`SELECT day, general_api_calls, search_queries, cache_hits, duplicates_prevented,
				last_confirm_at, last_discover_at, next_confirm_at, next_discover_at, last_duration_ms, last_error
			 FROM live_quad_stats WHERE user_id = ?`,
		)
		.bind(userId)
		.first<{
			day: string;
			general_api_calls: number;
			search_queries: number;
			cache_hits: number;
			duplicates_prevented: number;
			last_confirm_at: string | null;
			last_discover_at: string | null;
			next_confirm_at: string | null;
			next_discover_at: string | null;
			last_duration_ms: number | null;
			last_error: string | null;
		}>();
	if (!row || row.day !== day) {
		return {
			generalApiCalls: 0,
			searchQueries: 0,
			cacheHits: 0,
			duplicatesPrevented: 0,
			lastConfirmAt: row?.last_confirm_at ?? null,
			lastDiscoverAt: row?.last_discover_at ?? null,
			nextConfirmAt: row?.next_confirm_at ?? null,
			nextDiscoverAt: row?.next_discover_at ?? null,
			lastDurationMs: row?.last_duration_ms ?? null,
			lastError: row?.last_error ?? null,
		};
	}
	return {
		generalApiCalls: row.general_api_calls,
		searchQueries: row.search_queries,
		cacheHits: row.cache_hits,
		duplicatesPrevented: row.duplicates_prevented,
		lastConfirmAt: row.last_confirm_at,
		lastDiscoverAt: row.last_discover_at,
		nextConfirmAt: row.next_confirm_at,
		nextDiscoverAt: row.next_discover_at,
		lastDurationMs: row.last_duration_ms,
		lastError: row.last_error,
	};
}
