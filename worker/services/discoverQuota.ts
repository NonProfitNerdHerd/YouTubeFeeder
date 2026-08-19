import { dailySearchCallsUsed } from './websub';

/** Soft cap for Discover search.list calls per UTC day (Google default bucket is about 100). */
export const DISCOVER_SEARCH_DAILY_SOFT_CAP = 80;

export async function discoverSearchQuotaStatus(db: D1Database): Promise<{
	used: number;
	cap: number;
	allowed: boolean;
}> {
	const used = await dailySearchCallsUsed(db);
	return {
		used,
		cap: DISCOVER_SEARCH_DAILY_SOFT_CAP,
		allowed: used < DISCOVER_SEARCH_DAILY_SOFT_CAP,
	};
}
