import { countWebSubEvents, ingestAddedToday, quotaRowsToday } from './websub';
import { countActiveChannels, countOverdueChannels, RECONCILE_MAX_AGE_MS } from './feedReconcile';
import { getActiveJob } from './feedJobs';
import { generalUnitsUsedToday, quotaConfig } from './quotaGuard';
import { newestInboxPublishedAt } from '../db/queries';

export async function buildFeedSyncStatus(env: Env, userId: string, lastSyncAt: string | null, connected: boolean) {
	const now = Date.now();
	const cutoff = new Date(now - RECONCILE_MAX_AGE_MS).toISOString();
	const activeChannels = await countActiveChannels(env.DB);
	const overdueCount = await countOverdueChannels(env.DB, now);
	const oldest = await env.DB.prepare(
		`SELECT MIN(last_reconciled_at) AS oldest FROM channels c
		 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)`,
	).first<{ oldest: string | null }>();
	const recent = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM channels c
		 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
		 AND c.last_reconciled_at IS NOT NULL AND c.last_reconciled_at > ?`,
	)
		.bind(cutoff)
		.first<{ n: number }>();
	const bootstrapOpen = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM channels c
		 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
		 AND (c.bootstrap_status IS NULL OR c.bootstrap_status IN ('pending', 'in_progress'))`,
	).first<{ n: number }>();
	const notifyRow = (await quotaRowsToday(env.DB)).find((row) => row.endpoint === 'websub.notify');
	const used = await generalUnitsUsedToday(env.DB);
	const cfg = quotaConfig(env);
	const remaining = Math.max(0, cfg.dailyQuota - used);
	const job = await getActiveJob(env.DB);
	const quotaLimited = overdueCount > 0 && remaining < cfg.reconcileReserve;
	return {
		lastSyncAt,
		connected,
		websubEvents: await countWebSubEvents(env.DB),
		newestInboxPublishedAt: await newestInboxPublishedAt(env.DB, userId),
		activeChannels,
		overdueCount,
		oldestReconciliationAt: oldest?.oldest ?? null,
		reconciledLastTwoHours: Number(recent?.n ?? 0),
		websubNotificationsToday: Number(notifyRow?.call_count ?? 0),
		videosFound: {
			websub: await ingestAddedToday(env.DB, 'websub'),
			reconcile: await ingestAddedToday(env.DB, 'reconcile'),
			catchup: await ingestAddedToday(env.DB, 'catchup'),
			backfill: await ingestAddedToday(env.DB, 'backfill'),
		},
		quota: {
			used,
			dailyQuota: cfg.dailyQuota,
			warn: cfg.warn,
			byEndpoint: await quotaRowsToday(env.DB),
		},
		quotaLimited,
		bootstrapOpen: Number(bootstrapOpen?.n ?? 0),
		job: job
			? {
					id: job.id,
					kind: job.kind,
					status: job.status,
					channelsChecked: job.channels_checked,
					totalChannels: job.channels_total,
					videosAdded: job.videos_added,
					errors: job.error_count,
				}
			: null,
	};
}
