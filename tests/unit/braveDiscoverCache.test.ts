import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import {
	appendDiscoverProviderCachePage,
	cleanupExpiredDiscoverProviderRows,
	DISCOVER_PROVIDER_CACHE_TTL_MS,
	discoverProviderCacheKey,
	getDiscoverProviderCache,
	getDiscoverProviderLock,
	putDiscoverProviderCache,
	releaseDiscoverProviderLock,
	tryAcquireDiscoverProviderLock,
	updateDiscoverProviderCandidateCursor,
} from '../../worker/db/discoverProviderCache';
import {
	braveUsageStatus,
	getBraveGlobalRequestCount,
	getBraveUserRequestCount,
	recordBraveApiRequest,
	recordBraveCacheHit,
} from '../../worker/services/discover/braveQuota';
import { fetchDiscoverProviderPage } from '../../worker/services/discover/provider/discoveryProviderCacheService';
import { BraveSearchProvider } from '../../worker/services/discover/provider/braveSearchProvider';
import type { DiscoverySearchProvider, DiscoverySearchResult } from '../../worker/services/discover/provider/types';
import { normalizeDiscoverQuery } from '../../worker/services/discover/youtube';

const USER = 'user-brave-1';
const USER_B = 'user-brave-2';

function mockProvider(result: DiscoverySearchResult | (() => DiscoverySearchResult | Promise<DiscoverySearchResult>)): DiscoverySearchProvider {
	return {
		id: 'brave',
		async search() {
			return typeof result === 'function' ? await result() : result;
		},
	};
}

describe('discover provider cache keys', () => {
	it('normalizes equivalent queries to the same key', () => {
		const a = normalizeDiscoverQuery('  Storm   Chasing ');
		const b = normalizeDiscoverQuery('storm chasing');
		expect(a).toBe(b);
		expect(discoverProviderCacheKey('brave', 'youtube', 'v1', a)).toBe('brave:youtube:v1:storm chasing');
	});

	it('isolates strategy versions and content types', () => {
		const q = 'storm chasing';
		expect(discoverProviderCacheKey('brave', 'youtube', 'v1', q)).not.toBe(
			discoverProviderCacheKey('brave', 'youtube', 'v2', q),
		);
		expect(discoverProviderCacheKey('brave', 'youtube', 'v1', q)).not.toBe(
			discoverProviderCacheKey('brave', 'podcast', 'v1', q),
		);
	});
});

describe('discover provider cache TTL and stale', () => {
	it('stores and returns a fresh cache hit', async () => {
		const db = new MemorySyncDb();
		const now = new Date('2026-08-20T12:00:00.000Z');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [{ title: 'A', url: 'https://www.youtube.com/@a' }],
				candidates: [],
				providerOffset: 0,
				moreResultsAvailable: true,
			},
			DISCOVER_PROVIDER_CACHE_TTL_MS,
			now,
		);
		const row = await getDiscoverProviderCache(
			db as unknown as D1Database,
			discoverProviderCacheKey('brave', 'youtube', 'v1', 'storm chasing'),
			now,
		);
		expect(row?.stale).toBe(false);
		expect(row?.rawResults).toHaveLength(1);
		expect(row?.moreResultsAvailable).toBe(true);
	});

	it('marks cache stale after 30 days and supports stale-while-error reads', async () => {
		const db = new MemorySyncDb();
		const created = new Date('2026-07-01T00:00:00.000Z');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [{ title: 'A', url: 'https://www.youtube.com/@a' }],
				providerOffset: 0,
				moreResultsAvailable: false,
			},
			DISCOVER_PROVIDER_CACHE_TTL_MS,
			created,
		);
		const later = new Date(created.getTime() + DISCOVER_PROVIDER_CACHE_TTL_MS + 1000);
		const row = await getDiscoverProviderCache(
			db as unknown as D1Database,
			discoverProviderCacheKey('brave', 'youtube', 'v1', 'storm chasing'),
			later,
		);
		expect(row?.stale).toBe(true);
		expect(row?.rawResults).toHaveLength(1);
	});

	it('keeps provider pagination state separate from candidate consume cursor', async () => {
		const db = new MemorySyncDb();
		const now = new Date('2026-08-20T12:00:00.000Z');
		const key = discoverProviderCacheKey('brave', 'youtube', 'v1', 'storm chasing');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [
					{ title: '1', url: 'https://www.youtube.com/@1' },
					{ title: '2', url: 'https://www.youtube.com/@2' },
				],
				candidates: [{ title: '1', url: 'https://www.youtube.com/@1', provider: 'youtube', type: 'channel', externalId: 'UCxxxxxxxxxxxxxxxxxxxxxx1' }],
				providerOffset: 0,
				moreResultsAvailable: true,
				candidateConsumeOffset: 0,
			},
			undefined,
			now,
		);
		await updateDiscoverProviderCandidateCursor(db as unknown as D1Database, key, 1, now);
		await appendDiscoverProviderCachePage(
			db as unknown as D1Database,
			key,
			{
				rawHits: [{ title: '3', url: 'https://www.youtube.com/@3' }],
				candidates: [
					{
						provider: 'youtube',
						type: 'channel',
						externalId: 'UCxxxxxxxxxxxxxxxxxxxxxx3',
						title: '3',
						watchUrl: 'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx3',
					},
				],
				providerOffset: 1,
				moreResultsAvailable: false,
			},
			undefined,
			now,
		);
		const row = await getDiscoverProviderCache(db as unknown as D1Database, key, now);
		expect(row?.providerOffset).toBe(1);
		expect(row?.moreResultsAvailable).toBe(false);
		expect(row?.candidateConsumeOffset).toBe(1);
		expect(row?.rawResults).toHaveLength(3);
		expect(row?.candidates).toHaveLength(2);
	});

	it('lazy-cleans expired locks and aged-out cache rows', async () => {
		const db = new MemorySyncDb();
		const past = new Date('2026-01-01T00:00:00.000Z');
		const now = new Date('2026-08-20T00:00:00.000Z');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'old',
				strategyVersion: 'v1',
				rawResults: [],
				providerOffset: 0,
				moreResultsAvailable: false,
			},
			1000,
			past,
		);
		await tryAcquireDiscoverProviderLock(db as unknown as D1Database, 'lock-old', 'owner', 1000, past);
		await cleanupExpiredDiscoverProviderRows(db as unknown as D1Database, now);
		expect(db.discoverProviderCache.size).toBe(0);
		expect(db.discoverProviderLocks.size).toBe(0);
	});
});

describe('discover provider locks', () => {
	it('acquires a lock and rejects concurrent owners until expiry', async () => {
		const db = new MemorySyncDb();
		const now = new Date('2026-08-20T12:00:00.000Z');
		const key = 'brave:youtube:v1:storm chasing';
		expect(await tryAcquireDiscoverProviderLock(db as unknown as D1Database, key, 'owner-a', 25_000, now)).toBe(
			true,
		);
		expect(await tryAcquireDiscoverProviderLock(db as unknown as D1Database, key, 'owner-b', 25_000, now)).toBe(
			false,
		);
		const held = await getDiscoverProviderLock(db as unknown as D1Database, key, now);
		expect(held?.lockOwner).toBe('owner-a');
		expect(held?.expired).toBe(false);

		await releaseDiscoverProviderLock(db as unknown as D1Database, key, 'owner-a');
		expect(await tryAcquireDiscoverProviderLock(db as unknown as D1Database, key, 'owner-b', 25_000, now)).toBe(
			true,
		);
	});

	it('recovers automatically after lock expiry', async () => {
		const db = new MemorySyncDb();
		const t0 = new Date('2026-08-20T12:00:00.000Z');
		const key = 'brave:youtube:v1:storm chasing';
		expect(await tryAcquireDiscoverProviderLock(db as unknown as D1Database, key, 'owner-a', 1000, t0)).toBe(true);
		const t1 = new Date(t0.getTime() + 2000);
		expect(await tryAcquireDiscoverProviderLock(db as unknown as D1Database, key, 'owner-b', 25_000, t1)).toBe(
			true,
		);
		const held = await getDiscoverProviderLock(db as unknown as D1Database, key, t1);
		expect(held?.lockOwner).toBe('owner-b');
	});
});

describe('Brave soft caps and fetchDiscoverProviderPage', () => {
	it('cache hit does not increment Brave request counters', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'secret' });
		const now = new Date('2026-08-20T12:00:00.000Z');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [{ title: 'A', url: 'https://www.youtube.com/@a' }],
				providerOffset: 0,
				moreResultsAvailable: false,
			},
			undefined,
			now,
		);

		const search = vi.fn(async () => ({
			hits: [],
			nextOffset: null,
			moreAvailable: false,
		}));
		const result = await fetchDiscoverProviderPage(env, {
			userId: USER,
			query: 'Storm Chasing',
			now,
			provider: { id: 'brave', search },
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.cached).toBe(true);
		expect(search).not.toHaveBeenCalled();
		expect(await getBraveUserRequestCount(db as unknown as D1Database, USER)).toBe(0);
		expect(await getBraveGlobalRequestCount(db as unknown as D1Database)).toBe(0);
	});

	it('cache miss calls provider once and records a Brave request', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'secret' });
		const now = new Date('2026-08-20T12:00:00.000Z');
		const provider = mockProvider({
			hits: [{ title: 'A', url: 'https://www.youtube.com/@a' }],
			nextOffset: 1,
			moreAvailable: true,
		});
		const result = await fetchDiscoverProviderPage(env, {
			userId: USER,
			query: 'storm chasing',
			now,
			provider,
			lockOwner: 'lock-1',
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.cached).toBe(false);
			expect(result.record.rawResults).toHaveLength(1);
			expect(result.record.moreResultsAvailable).toBe(true);
		}
		expect(await getBraveUserRequestCount(db as unknown as D1Database, USER)).toBe(1);
		expect(await getBraveGlobalRequestCount(db as unknown as D1Database)).toBe(1);
	});

	it('enforces per-user soft cap on actual Brave calls', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, {
			BRAVE_SEARCH_API_KEY: 'secret',
			BRAVE_USER_DAILY_SOFT_CAP: '2',
			BRAVE_GLOBAL_DAILY_SOFT_CAP: '750',
		});
		await recordBraveApiRequest(db as unknown as D1Database, USER);
		await recordBraveApiRequest(db as unknown as D1Database, USER);
		const status = await braveUsageStatus(db as unknown as D1Database, USER, {
			userDailySoftCap: 2,
			globalDailySoftCap: 750,
		});
		expect(status.canCallBrave).toBe(false);
		expect(status.blockReason).toBe('user_cap');

		const result = await fetchDiscoverProviderPage(env, {
			userId: USER,
			query: 'storm chasing',
			provider: mockProvider({ hits: [{ title: 'X', url: 'https://www.youtube.com/@x' }], nextOffset: null, moreAvailable: false }),
			config: {
				apiKey: 'secret',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 2,
				globalDailySoftCap: 750,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 20,
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('user_cap');
	});

	it('enforces global soft cap on actual Brave calls', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'secret' });
		await recordBraveApiRequest(db as unknown as D1Database, USER_B);
		await recordBraveApiRequest(db as unknown as D1Database, USER_B);
		const result = await fetchDiscoverProviderPage(env, {
			userId: USER,
			query: 'storm chasing',
			provider: mockProvider({ hits: [], nextOffset: null, moreAvailable: false }),
			config: {
				apiKey: 'secret',
				providerMode: 'brave',
				strategyVersion: 'v1',
				userDailySoftCap: 100,
				globalDailySoftCap: 2,
				timeoutMs: 8000,
				maxPagesPerRequest: 3,
				typedResultLimit: 20,
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('global_cap');
	});

	it('serves stale cache when Brave fails (stale-while-error)', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { BRAVE_SEARCH_API_KEY: 'secret' });
		const created = new Date('2026-07-01T00:00:00.000Z');
		await putDiscoverProviderCache(
			db as unknown as D1Database,
			{
				provider: 'brave',
				contentType: 'youtube',
				normalizedQuery: 'storm chasing',
				strategyVersion: 'v1',
				rawResults: [{ title: 'Cached', url: 'https://www.youtube.com/@cached' }],
				providerOffset: 0,
				moreResultsAvailable: false,
			},
			DISCOVER_PROVIDER_CACHE_TTL_MS,
			created,
		);
		const now = new Date(created.getTime() + DISCOVER_PROVIDER_CACHE_TTL_MS + 60_000);
		const provider: DiscoverySearchProvider = {
			id: 'brave',
			async search() {
				throw new Error('boom');
			},
		};
		const result = await fetchDiscoverProviderPage(env, {
			userId: USER,
			query: 'storm chasing',
			now,
			provider,
			lockOwner: 'stale-1',
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.cached).toBe(true);
			expect(result.stale).toBe(true);
			expect(result.record.rawResults[0]?.title).toBe('Cached');
			expect(result.warning).toMatch(/Serving cached results/i);
		}
	});

	it('cache hits remain free under soft caps', async () => {
		const db = new MemorySyncDb();
		await recordBraveCacheHit(db as unknown as D1Database, USER);
		await recordBraveCacheHit(db as unknown as D1Database, USER);
		expect(await getBraveUserRequestCount(db as unknown as D1Database, USER)).toBe(0);
		const status = await braveUsageStatus(db as unknown as D1Database, USER, {
			userDailySoftCap: 1,
			globalDailySoftCap: 1,
		});
		expect(status.canCallBrave).toBe(true);
	});
});

describe('BraveSearchProvider construction for infra wiring', () => {
	it('can be constructed from env without exposing secrets in provider id', () => {
		const provider = new BraveSearchProvider({ apiKey: 'secret-value' });
		expect(provider.id).toBe('brave');
		expect(JSON.stringify(provider)).not.toContain('secret-value');
	});
});
