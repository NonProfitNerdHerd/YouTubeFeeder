import { dailyQuotaUsed } from './websub';

export const DEFAULT_DAILY_QUOTA = 10_000;
export const DEFAULT_QUOTA_WARN = 8_000;
export const DEFAULT_RECONCILE_RESERVE = 2_000;
export const DEFAULT_BACKFILL_CUTOFF = 7_500;

export interface QuotaConfig {
	dailyQuota: number;
	warn: number;
	reconcileReserve: number;
	backfillCutoff: number;
}

function envNumber(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function quotaConfig(env: Env): QuotaConfig {
	return {
		dailyQuota: envNumber(env.YOUTUBE_DAILY_QUOTA, DEFAULT_DAILY_QUOTA),
		warn: envNumber(env.YOUTUBE_QUOTA_WARN, DEFAULT_QUOTA_WARN),
		reconcileReserve: envNumber(env.YOUTUBE_RECONCILE_RESERVE, DEFAULT_RECONCILE_RESERVE),
		backfillCutoff: envNumber(env.YOUTUBE_BACKFILL_CUTOFF, DEFAULT_BACKFILL_CUTOFF),
	};
}

const YOUTUBE_GENERAL_ENDPOINTS = [
	'playlistItems.list',
	'videos.list',
	'channels.list',
	'subscriptions.list',
	'catchup',
	'feed_reconcile',
	'feed_backfill',
];

export async function generalUnitsUsedToday(db: D1Database): Promise<number> {
	let total = 0;
	for (const endpoint of YOUTUBE_GENERAL_ENDPOINTS) {
		total += await dailyQuotaUsed(db, endpoint);
	}
	return total;
}

export async function remainingGeneralUnits(env: Env): Promise<number> {
	const cfg = quotaConfig(env);
	const used = await generalUnitsUsedToday(env.DB);
	return Math.max(0, cfg.dailyQuota - used);
}

export function canRunBackfill(opts: {
	overdueCount: number;
	manualJobActive: boolean;
	used: number;
	config: QuotaConfig;
}): boolean {
	if (opts.overdueCount > 0) return false;
	if (opts.manualJobActive) return false;
	if (opts.used >= opts.config.backfillCutoff) return false;
	return opts.config.dailyQuota - opts.used > opts.config.reconcileReserve;
}

export function canRunReconcile(remaining: number, _reserve = 0): boolean {
	return remaining > 0;
}

/** Extra reconcile (HTTP continuations) yields when the Catch-up/search reserve is gone. */
export function canContinueReconcile(remaining: number, reserve: number): boolean {
	return remaining >= reserve;
}

export function reconcileBatchSize(opts: {
	dueCount: number;
	remainingQuota: number;
	reconcileReserve: number;
	maxChannels?: number;
	subrequestBudget?: number;
	subrequestReserve?: number;
	fetchesPerChannel?: number;
}): number {
	const maxChannels = opts.maxChannels ?? 12;
	const subrequestBudget = opts.subrequestBudget ?? 50;
	const subrequestReserve = opts.subrequestReserve ?? 8;
	const fetchesPerChannel = opts.fetchesPerChannel ?? 4;
	const byQuota = Math.max(0, Math.floor(opts.remainingQuota));
	const bySubrequests = Math.max(0, Math.floor((subrequestBudget - subrequestReserve) / fetchesPerChannel));
	return Math.max(0, Math.min(opts.dueCount, maxChannels, byQuota, bySubrequests));
}

export function invocationsForFullPass(channelCount: number, batchSize: number): number {
	if (channelCount < 1) return 0;
	const size = Math.max(1, batchSize);
	return Math.ceil(channelCount / size);
}

export function maxReconcileAgeHours(cronEveryHours: number): number {
	return cronEveryHours;
}
