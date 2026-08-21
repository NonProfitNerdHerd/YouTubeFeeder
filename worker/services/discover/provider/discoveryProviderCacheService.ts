import {
	appendDiscoverProviderCachePage,
	cleanupExpiredDiscoverProviderRows,
	discoverProviderCacheKey,
	getDiscoverProviderCache,
	putDiscoverProviderCache,
	releaseDiscoverProviderLock,
	tryAcquireDiscoverProviderLock,
} from '../../../db/discoverProviderCache';
import { normalizeDiscoverQuery } from '../youtube';
import {
	braveUsageStatus,
	recordBraveApiError,
	recordBraveApiRequest,
	recordBraveCacheHit,
	recordBraveCacheMiss,
	recordBraveZeroResultSearch,
} from '../braveQuota';
import { braveDiscoverConfigFromEnv, type BraveDiscoverConfig } from './braveConfig';
import { BraveSearchProvider } from './braveSearchProvider';
import { DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION } from './braveQueryStrategy';
import {
	BraveProviderError,
	type DiscoverProviderCacheRecord,
	type DiscoverySearchProvider,
	type DiscoverySearchResult,
} from './types';

export interface FetchProviderPageOptions {
	userId: string;
	query: string;
	contentType?: 'youtube';
	/** When set, fetch this provider page (append on hit). Default: 0 on miss, else next page. */
	providerOffset?: number;
	count?: number;
	strategyVersion?: string;
	/** Prefer returning stale cache when Brave fails (default true). */
	staleWhileError?: boolean;
	config?: BraveDiscoverConfig;
	provider?: DiscoverySearchProvider;
	now?: Date;
	lockOwner?: string;
}

export type FetchProviderPageResult =
	| {
			ok: true;
			cached: boolean;
			stale: boolean;
			record: DiscoverProviderCacheRecord;
			page: DiscoverySearchResult | null;
			warning?: string;
	  }
	| {
			ok: false;
			cached: boolean;
			stale: boolean;
			record: DiscoverProviderCacheRecord | null;
			error: string;
			code?: string;
			warning?: string;
	  };

/**
 * Infrastructure helper for Phases 1–2.
 * Not wired to /api/discover/* yet — used by tests and future Phase 3 integration.
 */
export async function fetchDiscoverProviderPage(
	env: Env,
	opts: FetchProviderPageOptions,
): Promise<FetchProviderPageResult> {
	const now = opts.now ?? new Date();
	const config = opts.config ?? braveDiscoverConfigFromEnv(env);
	const contentType = opts.contentType ?? 'youtube';
	const strategyVersion = opts.strategyVersion ?? config.strategyVersion ?? DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION;
	const normalizedQuery = normalizeDiscoverQuery(opts.query);
	const cacheKey = discoverProviderCacheKey('brave', contentType, strategyVersion, normalizedQuery);
	const staleWhileError = opts.staleWhileError !== false;
	const lockOwner = opts.lockOwner ?? crypto.randomUUID();

	await cleanupExpiredDiscoverProviderRows(env.DB, now);

	const existing = await getDiscoverProviderCache(env.DB, cacheKey, now);
	const requestedOffset = opts.providerOffset;

	// Fresh cache hit when the requested provider page is already covered.
	if (existing && !existing.stale) {
		const needsNewPage =
			requestedOffset != null &&
			requestedOffset > existing.providerOffset &&
			existing.moreResultsAvailable;

		if (!needsNewPage) {
			await recordBraveCacheHit(env.DB, opts.userId);
			return {
				ok: true,
				cached: true,
				stale: false,
				record: existing,
				page: null,
			};
		}
		await recordBraveCacheMiss(env.DB, opts.userId);
	} else {
		// Miss or stale — an external Brave call may follow (subject to caps/locks).
		await recordBraveCacheMiss(env.DB, opts.userId);
	}

	const usage = await braveUsageStatus(env.DB, opts.userId, config);
	if (!usage.canCallBrave) {
		if (existing && staleWhileError) {
			return {
				ok: true,
				cached: true,
				stale: existing.stale,
				record: existing,
				page: null,
				warning:
					usage.blockReason === 'global_cap'
						? 'Brave daily global soft cap reached. Serving cached results.'
						: 'Brave daily per-user soft cap reached. Serving cached results.',
			};
		}
		return {
			ok: false,
			cached: Boolean(existing),
			stale: Boolean(existing?.stale),
			record: existing,
			error:
				usage.blockReason === 'global_cap'
					? 'Brave daily global soft cap reached'
					: 'Brave daily per-user soft cap reached',
			code: usage.blockReason,
		};
	}

	const acquired = await tryAcquireDiscoverProviderLock(env.DB, cacheKey, lockOwner, undefined, now);
	if (!acquired) {
		const afterWait = await getDiscoverProviderCache(env.DB, cacheKey, now);
		if (afterWait && !afterWait.stale) {
			await recordBraveCacheHit(env.DB, opts.userId);
			return { ok: true, cached: true, stale: false, record: afterWait, page: null };
		}
		if (existing && staleWhileError) {
			return {
				ok: true,
				cached: true,
				stale: existing.stale,
				record: existing,
				page: null,
				warning: 'Discover provider refresh already in progress. Serving cached results.',
			};
		}
		return {
			ok: false,
			cached: false,
			stale: false,
			record: null,
			error: 'Discover provider refresh already in progress',
			code: 'lock_busy',
		};
	}

	const provider =
		opts.provider ??
		new BraveSearchProvider({
			apiKey: config.apiKey,
			timeoutMs: config.timeoutMs,
			strategyVersion,
		});

	const offset =
		requestedOffset ??
		(existing && !existing.stale && existing.moreResultsAvailable ? existing.providerOffset + 1 : 0);

	try {
		await recordBraveApiRequest(env.DB, opts.userId);
		const page = await provider.search({
			contentType,
			query: normalizedQuery,
			offset,
			count: opts.count,
			strategyVersion,
		});

		if (page.hits.length === 0) {
			await recordBraveZeroResultSearch(env.DB, opts.userId);
		}

		let record: DiscoverProviderCacheRecord;
		if (existing && !existing.stale && offset > 0) {
			record =
				(await appendDiscoverProviderCachePage(
					env.DB,
					cacheKey,
					{
						rawHits: page.hits,
						candidates: [],
						providerOffset: offset,
						moreResultsAvailable: page.moreAvailable,
					},
					undefined,
					now,
				)) ?? existing;
		} else {
			record = await putDiscoverProviderCache(
				env.DB,
				{
					provider: 'brave',
					contentType,
					normalizedQuery,
					strategyVersion,
					rawResults: page.hits,
					candidates: [],
					providerOffset: offset,
					moreResultsAvailable: page.moreAvailable,
					candidateConsumeOffset: 0,
				},
				undefined,
				now,
			);
		}

		return { ok: true, cached: false, stale: false, record, page };
	} catch (err) {
		await recordBraveApiError(env.DB, opts.userId);
		const code = err instanceof BraveProviderError ? err.code : 'network_error';
		const message = err instanceof Error ? err.message : String(err);
		if (existing && staleWhileError) {
			return {
				ok: true,
				cached: true,
				stale: existing.stale,
				record: existing,
				page: null,
				warning: `Brave search failed (${code}). Serving cached results.`,
			};
		}
		return {
			ok: false,
			cached: Boolean(existing),
			stale: Boolean(existing?.stale),
			record: existing,
			error: message,
			code,
		};
	} finally {
		await releaseDiscoverProviderLock(env.DB, cacheKey, lockOwner);
	}
}
