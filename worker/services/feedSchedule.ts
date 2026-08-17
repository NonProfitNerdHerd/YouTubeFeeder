import { randomToken } from '../auth/crypto';
import { accessTokenForUser } from './googleToken';
import { syncSubscriptions, type SyncResult } from './sync';
import { processPendingWebSubEvents, runGlobalBootstrap } from './websubProcess';
import { RECONCILE_USER_LIMIT, renewExpiringLeases } from './websub';

const EVENT_RETRY_LIMIT = 50;
const BOOTSTRAP_BUDGET = 8;

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

export async function runFeedMaintenance(env: Env): Promise<{
	renewed: number;
	eventsProcessed: number;
	reconciled: number;
	bootstrapped: number;
}> {
	const renewed = await renewExpiringLeases(env);
	const events = await processPendingWebSubEvents(env, EVENT_RETRY_LIMIT);
	const bootstrapped = await runGlobalBootstrap(env, BOOTSTRAP_BUDGET);
	const reconciled = await reconcileStaleSubscriptions(env);
	console.log(
		JSON.stringify({
			operation: 'feed_maintenance',
			renewed,
			eventsProcessed: events.processed,
			eventsFailed: events.failed,
			reconciled,
			bootstrapped: bootstrapped.channels,
		}),
	);
	return { renewed, eventsProcessed: events.processed, reconciled, bootstrapped: bootstrapped.channels };
}

/** Manual Sync now: drain WebSub events and a small global bootstrap budget. Always done:true for InboxPage. */
export async function syncFeedNow(env: Env, userId: string): Promise<SyncResult> {
	const startedAt = new Date().toISOString();
	try {
		const events = await processPendingWebSubEvents(env, EVENT_RETRY_LIMIT);
		const bootstrap = await runGlobalBootstrap(env, BOOTSTRAP_BUDGET);
		const result: SyncResult = {
			syncType: 'content',
			status: 'ok',
			channelsChecked: bootstrap.channels,
			videosAdded: bootstrap.videosAdded + events.processed,
			videosUpdated: 0,
			estimatedQuotaUnits: 0,
			errorSummary: null,
			done: true,
			nextOffset: bootstrap.channels,
			totalChannels: bootstrap.channels,
		};
		await recordMaintenanceRun(env.DB, userId, result, startedAt);
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
