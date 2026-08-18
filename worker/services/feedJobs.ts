import { randomToken } from '../auth/crypto';
import { countActiveChannels, reconcileDueChannels } from './feedReconcile';
import { processPendingWebSubEvents } from './websubProcess';
import type { SyncResult } from './sync';

const EVENT_RETRY_LIMIT = 50;

export interface FeedSyncJob {
	id: string;
	kind: 'manual' | 'cron';
	status: string;
	user_id: string | null;
	cursor_channel_id: string | null;
	channels_total: number;
	channels_checked: number;
	videos_added: number;
	error_count: number;
	last_error: string | null;
	started_at: string;
	completed_at: string | null;
}

export async function getActiveJob(db: D1Database, kind?: 'manual' | 'cron'): Promise<FeedSyncJob | null> {
	const sql = kind
		? `SELECT * FROM feed_sync_jobs WHERE status IN ('queued', 'running') AND kind = ? ORDER BY started_at DESC LIMIT 1`
		: `SELECT * FROM feed_sync_jobs WHERE status IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1`;
	const row = kind
		? await db.prepare(sql).bind(kind).first<FeedSyncJob>()
		: await db.prepare(sql).first<FeedSyncJob>();
	return row ?? null;
}

export async function getJob(db: D1Database, id: string): Promise<FeedSyncJob | null> {
	return (await db.prepare(`SELECT * FROM feed_sync_jobs WHERE id = ?`).bind(id).first<FeedSyncJob>()) ?? null;
}

async function saveJob(db: D1Database, job: FeedSyncJob): Promise<void> {
	await db
		.prepare(
			`INSERT INTO feed_sync_jobs (
				id, kind, status, user_id, cursor_channel_id, channels_total, channels_checked,
				videos_added, error_count, last_error, started_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
			ON CONFLICT(id) DO UPDATE SET
				status = excluded.status,
				cursor_channel_id = excluded.cursor_channel_id,
				channels_total = excluded.channels_total,
				channels_checked = excluded.channels_checked,
				videos_added = excluded.videos_added,
				error_count = excluded.error_count,
				last_error = excluded.last_error,
				updated_at = excluded.updated_at,
				completed_at = excluded.completed_at`,
		)
		.bind(
			job.id,
			job.kind,
			job.status,
			job.user_id,
			job.cursor_channel_id,
			job.channels_total,
			job.channels_checked,
			job.videos_added,
			job.error_count,
			job.last_error,
			job.started_at,
			job.completed_at,
		)
		.run();
}

function toResult(job: FeedSyncJob, extras?: Partial<SyncResult>): SyncResult {
	const done = job.status === 'completed' || job.status === 'error';
	return {
		syncType: 'content',
		status: extras?.status ?? (job.status === 'error' ? 'error' : 'ok'),
		channelsChecked: job.channels_checked,
		videosAdded: job.videos_added,
		videosUpdated: 0,
		estimatedQuotaUnits: 0,
		errorSummary: job.last_error,
		done,
		nextOffset: job.channels_checked,
		totalChannels: job.channels_total,
		...extras,
	};
}

export async function runManualSyncJob(
	env: Env,
	userId: string,
	opts?: { ytClient?: import('./youtube').YoutubeClient },
): Promise<SyncResult> {
	const existing = await getActiveJob(env.DB, 'manual');
	if (existing && existing.user_id && existing.user_id !== userId) {
		return {
			syncType: 'content',
			status: 'busy',
			channelsChecked: existing.channels_checked,
			videosAdded: existing.videos_added,
			videosUpdated: 0,
			estimatedQuotaUnits: 0,
			errorSummary: 'A sync is already running.',
			done: false,
			nextOffset: existing.channels_checked,
			totalChannels: existing.channels_total,
		};
	}
	let job = existing && (!existing.user_id || existing.user_id === userId) ? existing : null;
	if (!job) {
		const total = await countActiveChannels(env.DB);
		job = {
			id: randomToken(12),
			kind: 'manual',
			status: 'running',
			user_id: userId,
			cursor_channel_id: null,
			channels_total: total,
			channels_checked: 0,
			videos_added: 0,
			error_count: 0,
			last_error: null,
			started_at: new Date().toISOString(),
			completed_at: null,
		};
		await saveJob(env.DB, job);
	} else {
		job.status = 'running';
	}

	await processPendingWebSubEvents(env, EVENT_RETRY_LIMIT);
	const batch = await reconcileDueChannels(env, {
		force: true,
		afterChannelId: job.cursor_channel_id,
		jobId: job.id,
		ytClient: opts?.ytClient,
	});
	job.cursor_channel_id = batch.lastChannelId;
	job.channels_checked += batch.channels;
	job.videos_added += batch.videosAdded;
	job.error_count += batch.errors;
	if (batch.budgetExhausted && batch.channels < 1) {
		job.status = 'error';
		job.last_error = 'YouTube API quota exhausted.';
		job.completed_at = new Date().toISOString();
		await saveJob(env.DB, job);
		return toResult(job, { status: 'quota' });
	}
	const done = batch.channels < 1 || batch.dueRemaining < 1;
	if (done) {
		job.status = 'completed';
		job.completed_at = new Date().toISOString();
		job.channels_checked = Math.max(job.channels_checked, job.channels_total);
	}
	await saveJob(env.DB, job);
	return toResult(job);
}

export async function hasActiveManualJob(db: D1Database): Promise<boolean> {
	return Boolean(await getActiveJob(db, 'manual'));
}
