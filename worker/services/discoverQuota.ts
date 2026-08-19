import { dailySearchCallsUsed, recordQuota } from './websub';

/** Soft cap for Discover search.list calls per UTC day (Google default bucket is about 100). */
export const DISCOVER_SEARCH_DAILY_SOFT_CAP = 80;

/** Block automatic topic refresh when total search.list usage reaches this level. */
export const DISCOVER_USER_SEARCH_RESERVE = 70;

/** Max automatic topic search.list calls per UTC day (global). */
export const DISCOVER_TOPIC_SEARCH_DAILY_BUDGET = 12;

/** Max topic searches attempted per For You browse request. */
export const DISCOVER_TOPIC_REFRESH_PER_REQUEST = 2;

export const DISCOVER_TOPIC_SEARCH_ENDPOINT = 'discover.topic.search';

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

async function dailyTopicSearchCallsUsed(db: D1Database): Promise<number> {
	const day = new Date().toISOString().slice(0, 10);
	const row = await db
		.prepare(`SELECT search_calls FROM api_quota_daily WHERE day = ? AND endpoint = ?`)
		.bind(day, DISCOVER_TOPIC_SEARCH_ENDPOINT)
		.first<{ search_calls: number }>();
	return Number(row?.search_calls ?? 0);
}

export async function discoverTopicSearchQuotaStatus(db: D1Database): Promise<{
	topicUsed: number;
	topicBudget: number;
	totalSearchUsed: number;
	userReserve: number;
	canRefresh: boolean;
}> {
	const totalSearchUsed = await dailySearchCallsUsed(db);
	const topicUsed = await dailyTopicSearchCallsUsed(db);
	return {
		topicUsed,
		topicBudget: DISCOVER_TOPIC_SEARCH_DAILY_BUDGET,
		totalSearchUsed,
		userReserve: DISCOVER_USER_SEARCH_RESERVE,
		canRefresh: topicUsed < DISCOVER_TOPIC_SEARCH_DAILY_BUDGET && totalSearchUsed < DISCOVER_USER_SEARCH_RESERVE,
	};
}

export async function recordTopicSearchCall(db: D1Database): Promise<void> {
	await recordQuota(db, DISCOVER_TOPIC_SEARCH_ENDPOINT, { searchCalls: 1 });
}
