import { randomToken, signValue } from '../auth/crypto';
import { accessTokenForUser } from './googleToken';
import { syncSubscriptions, type SyncResult } from './sync';
import { processPendingWebSubEvents, runGlobalBootstrap } from './websubProcess';
import { countOverdueChannels, reconcileDueChannels } from './feedReconcile';
import { hasActiveManualJob, runManualSyncJob } from './feedJobs';
import { canContinueReconcile, canRunBackfill, generalUnitsUsedToday, quotaConfig, remainingGeneralUnits } from './quotaGuard';
import { countWebSubEvents, HUB_FETCH_LIMIT, RECONCILE_USER_LIMIT, renewExpiringLeases } from './websub';

const EVENT_RETRY_LIMIT = 50;
const BOOTSTRAP_BUDGET = 8;
const OVERDUE_LEASE_LIMIT = 5;

async function recordMaintenanceRun(db: D1Database, userId: string, result: SyncResult, startedAt: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO sync_runs (id, user_id, sync_type, status, started_at, completed_at, channels_checked, videos_added, videos_updated, estimated_quota_units, error_summary)
			 VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?, ?, ?)`,
		)
		.bind(
			randomToken(12),
			userId,
			result.syncType,
			result.status,
			startedAt,
			result.channelsChecked,
			result.videosAdded,
			result.videosUpdated,
			result.estimatedQuotaUnits,
			result.errorSummary,
		)
		.run();
}

export async function reconcileStaleSubscriptions(env: Env, limit = RECONCILE_USER_LIMIT): Promise<number> {
	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const users = await env.DB.prepare(
		`SELECT u.id, u.google_account_id, u.display_name, u.encrypted_refresh_token
		 FROM users u
		 WHERE u.encrypted_refresh_token IS NOT NULL
		 AND NOT EXISTS (
			SELECT 1 FROM channel_prefs p
			WHERE p.user_id = u.id AND p.subscription_seen_at IS NOT NULL AND p.subscription_seen_at > ?
		 )
		 LIMIT ?`,
	)
		.bind(cutoff, limit)
		.all<{ id: string; google_account_id: string; display_name: string; encrypted_refresh_token: string }>();
	let n = 0;
	for (const user of users.results ?? []) {
		try {
			const token = await accessTokenForUser(env, user);
			await syncSubscriptions(env, user.id, token);
			n += 1;
		} catch (error) {
			console.warn(
				JSON.stringify({
					operation: 'subscription_reconcile',
					userId: user.id,
					status: 'error',
					error: error instanceof Error ? error.message : 'reconcile_failed',
				}),
			);
		}
	}
	return n;
}

async function continueReconcileIfNeeded(env: Env, ctx: ExecutionContext | undefined, dueRemaining: number): Promise<void> {
	if (dueRemaining < 1 || !ctx || !env.SESSION_SECRET || !env.PUBLIC_ORIGIN) return;
	const remaining = await remainingGeneralUnits(env);
	const cfg = quotaConfig(env);
	if (!canContinueReconcile(remaining, cfg.reconcileReserve)) return;
	const token = await signValue(env.SESSION_SECRET, `cron-content:continue:${Date.now()}`);
	ctx.waitUntil(
		fetch(`${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/api/cron/sync-content`, {
			method: 'POST',
			headers: { 'x-cron-sync': token },
		}).then((res) => {
			if (!res.ok) console.warn(JSON.stringify({ operation: 'feed_reconcile_continue', result: 'error', error: res.status }));
		}),
	);
}

export async function continueOverdueReconcile(env: Env, ctx?: ExecutionContext): Promise<{ channels: number; videosAdded: number; dueRemaining: number }> {
	if (await hasActiveManualJob(env.DB)) {
		return { channels: 0, videosAdded: 0, dueRemaining: await countOverdueChannels(env.DB) };
	}
	const sweep = await reconcileDueChannels(env);
	await continueReconcileIfNeeded(env, ctx, sweep.dueRemaining);
	return { channels: sweep.channels, videosAdded: sweep.videosAdded, dueRemaining: sweep.dueRemaining };
}

export async function runFeedMaintenance(
	env: Env,
	ctx?: ExecutionContext,
): Promise<{
	renewed: number;
	eventsProcessed: number;
	eventsFailed: number;
	eventsDead: number;
	reconciled: number;
	bootstrapped: number;
	swept: number;
	dueRemaining: number;
}> {
	const events = await processPendingWebSubEvents(env, EVENT_RETRY_LIMIT);
	const manualActive = await hasActiveManualJob(env.DB);
	let sweep = { channels: 0, videosAdded: 0, dueRemaining: 0, unitsUsed: 0 };
	if (!manualActive) {
		sweep = await reconcileDueChannels(env);
		await continueReconcileIfNeeded(env, ctx, sweep.dueRemaining);
	}
	const overdue = sweep.dueRemaining;
	const leaseLimit = overdue > 0 ? OVERDUE_LEASE_LIMIT : HUB_FETCH_LIMIT;
	const renewed = await renewExpiringLeases(env, leaseLimit);
	const used = await generalUnitsUsedToday(env.DB);
	const cfg = quotaConfig(env);
	let bootstrapped = { channels: 0, videosAdded: 0 };
	if (canRunBackfill({ overdueCount: overdue, manualJobActive: manualActive, used, config: cfg })) {
		bootstrapped = await runGlobalBootstrap(env, BOOTSTRAP_BUDGET);
	}
	const reconciled = await reconcileStaleSubscriptions(env);
	const eventCounts = await countWebSubEvents(env.DB);
	console.log(
		JSON.stringify({
			operation: 'feed_maintenance',
			renewed,
			eventsProcessed: events.processed,
			eventsFailed: events.failed,
			eventsDead: eventCounts.dead,
			eventsPending: eventCounts.pending,
			eventsError: eventCounts.error,
			reconciled,
			bootstrapped: bootstrapped.channels,
			swept: sweep.channels,
			sweepUnits: sweep.unitsUsed,
			dueRemaining: overdue,
		}),
	);
	return {
		renewed,
		eventsProcessed: events.processed,
		eventsFailed: events.failed,
		eventsDead: eventCounts.dead,
		reconciled,
		bootstrapped: bootstrapped.channels,
		swept: sweep.channels,
		dueRemaining: overdue,
	};
}

export async function syncFeedNow(env: Env, userId: string): Promise<SyncResult> {
	const startedAt = new Date().toISOString();
	try {
		const result = await runManualSyncJob(env, userId);
		if (result.status !== 'busy') await recordMaintenanceRun(env.DB, userId, result, startedAt);
		return result;
	} catch (error) {
		const result: SyncResult = {
			syncType: 'content',
			status: 'error',
			channelsChecked: 0,
			videosAdded: 0,
			videosUpdated: 0,
			estimatedQuotaUnits: 0,
			errorSummary: error instanceof Error ? error.message : 'sync_failed',
			done: true,
		};
		await recordMaintenanceRun(env.DB, userId, result, startedAt);
		return result;
	}
}
