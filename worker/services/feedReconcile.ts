import { chunk, createYoutubeApiKeyClient, fetchUploadsPlaylistIds, selectInChunks, type YoutubeClient } from './youtube';
import { YoutubeApiError } from './youtube';
import { recordIngest, recordYoutubeCalls, VIDEO_ID_RE } from './websub';
import { fanoutInbox, nextAttemptAt, upsertGlobalVideo, type VideoDetails } from './websubProcess';
import { quotaConfig, reconcileBatchSize, remainingGeneralUnits } from './quotaGuard';

export const RECONCILE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const RECENT_PLAYLIST_PAGE = 15;
export const MAX_CHANNELS_PER_TICK = 12;

interface ChannelRow {
	channel_id: string;
	uploads_playlist_id: string | null;
	last_reconciled_at: string | null;
	reconcile_next_retry_at: string | null;
	reconcile_failure_count: number;
}

export interface ReconcileBatchResult {
	channels: number;
	videosAdded: number;
	unitsUsed: number;
	errors: number;
	dueRemaining: number;
	budgetExhausted: boolean;
	lastChannelId: string | null;
}

async function markReconcileSuccess(db: D1Database, channelId: string, videosAdded: number): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE channels SET
				last_synchronized_at = ?,
				last_reconciled_at = ?,
				last_reconcile_attempt_at = ?,
				reconcile_failure_count = 0,
				reconcile_last_error = NULL,
				reconcile_next_retry_at = NULL,
				last_new_video_at = CASE WHEN ? > 0 THEN ? ELSE last_new_video_at END
			 WHERE channel_id = ?`,
		)
		.bind(now, now, now, videosAdded, now, channelId)
		.run();
}

async function markReconcileFailure(db: D1Database, channelId: string, attempts: number, error: string): Promise<void> {
	const nextAttempts = attempts + 1;
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE channels SET
				last_reconcile_attempt_at = ?,
				reconcile_failure_count = ?,
				reconcile_last_error = ?,
				reconcile_next_retry_at = ?
			 WHERE channel_id = ?`,
		)
		.bind(now, nextAttempts, error.slice(0, 180), nextAttemptAt(nextAttempts), channelId)
		.run();
}

export async function countActiveChannels(db: D1Database): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM channels c
			 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)`,
		)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

export async function countChannelsAfter(db: D1Database, afterChannelId: string | null): Promise<number> {
	if (!afterChannelId) return countActiveChannels(db);
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM channels c
			 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
			 AND c.channel_id > ?`,
		)
		.bind(afterChannelId)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

export async function countOverdueChannels(db: D1Database, now = Date.now()): Promise<number> {
	const cutoff = new Date(now - RECONCILE_MAX_AGE_MS).toISOString();
	const nowIso = new Date(now).toISOString();
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM channels c
			 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
			 AND (c.last_reconciled_at IS NULL OR c.last_reconciled_at <= ?)
			 AND (c.reconcile_next_retry_at IS NULL OR c.reconcile_next_retry_at <= ?)`,
		)
		.bind(cutoff, nowIso)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

export async function listDueChannels(
	db: D1Database,
	limit: number,
	opts?: { force?: boolean; afterChannelId?: string | null; now?: number },
): Promise<ChannelRow[]> {
	const now = opts?.now ?? Date.now();
	const nowIso = new Date(now).toISOString();
	const cutoff = new Date(now - RECONCILE_MAX_AGE_MS).toISOString();
	if (opts?.force) {
		const rows = await db
			.prepare(
				`SELECT c.channel_id, c.uploads_playlist_id, c.last_reconciled_at,
					c.reconcile_next_retry_at, COALESCE(c.reconcile_failure_count, 0) AS reconcile_failure_count
				 FROM channels c
				 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
				 AND (? IS NULL OR c.channel_id > ?)
				 ORDER BY c.channel_id ASC
				 LIMIT ?`,
			)
			.bind(opts.afterChannelId ?? null, opts.afterChannelId ?? '', limit)
			.all<ChannelRow>();
		return rows.results ?? [];
	}
	const rows = await db
		.prepare(
			`SELECT c.channel_id, c.uploads_playlist_id, c.last_reconciled_at,
				c.reconcile_next_retry_at, COALESCE(c.reconcile_failure_count, 0) AS reconcile_failure_count
			 FROM channels c
			 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
			 AND (c.last_reconciled_at IS NULL OR c.last_reconciled_at <= ?)
			 AND (c.reconcile_next_retry_at IS NULL OR c.reconcile_next_retry_at <= ?)
			 ORDER BY CASE WHEN c.last_reconciled_at IS NULL THEN 0 ELSE 1 END,
				c.last_reconciled_at ASC,
				c.channel_id ASC
			 LIMIT ?`,
		)
		.bind(cutoff, nowIso, limit)
		.all<ChannelRow>();
	return rows.results ?? [];
}

async function reconcileOneChannel(
	env: Env,
	yt: YoutubeClient,
	row: ChannelRow,
	jobId: string | null,
): Promise<{ videosAdded: number; ok: boolean }> {
	const log = (result: string, extra?: Record<string, unknown>) => {
		console.log(
			JSON.stringify({
				operation: 'playlistItems.list',
				source: 'reconcile',
				channelId: row.channel_id,
				jobId,
				result,
				...extra,
			}),
		);
	};
	try {
		let playlistId = row.uploads_playlist_id;
		if (!playlistId) {
			const found = await fetchUploadsPlaylistIds(yt, [row.channel_id]);
			playlistId = found.get(row.channel_id) ?? null;
			if (playlistId) {
				await env.DB.prepare('UPDATE channels SET uploads_playlist_id = ? WHERE channel_id = ?')
					.bind(playlistId, row.channel_id)
					.run();
			}
		}
		if (!playlistId) {
			await markReconcileSuccess(env.DB, row.channel_id, 0);
			log('ok', { error: 'no_uploads_playlist' });
			return { videosAdded: 0, ok: true };
		}
		const page = await yt.getJson<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>('playlistItems', {
			part: 'contentDetails,snippet',
			playlistId,
			maxResults: String(RECENT_PLAYLIST_PAGE),
		});
		const ids = [
			...new Set(
				(page.items ?? [])
					.map((item) => item.contentDetails?.videoId)
					.filter((id): id is string => Boolean(id && VIDEO_ID_RE.test(id))),
			),
		];
		const existingRows = ids.length
			? await selectInChunks<{ video_id: string }>(
					env.DB,
					(placeholders) => `SELECT video_id FROM videos WHERE video_id IN (${placeholders})`,
					ids,
				)
			: [];
		const known = new Set(existingRows.map((item) => item.video_id));
		const missing = ids.filter((id) => !known.has(id));
		let videosAdded = 0;
		if (missing.length) {
			for (const group of chunk(missing, 50)) {
				const details = await yt.getJson<{ items?: VideoDetails[] }>('videos', {
					part: 'snippet,contentDetails,status,liveStreamingDetails',
					id: group.join(','),
				});
				for (const video of details.items ?? []) {
					const ok = await upsertGlobalVideo(env.DB, video);
					if (ok && video.id && video.snippet?.channelId) {
						await fanoutInbox(env.DB, video.id, video.snippet.channelId);
						videosAdded += 1;
					}
				}
			}
		}
		await markReconcileSuccess(env.DB, row.channel_id, videosAdded);
		log('ok', { videosAdded });
		return { videosAdded, ok: true };
	} catch (error) {
		const message =
			error instanceof YoutubeApiError ? error.message : error instanceof Error ? error.message : 'reconcile_failed';
		await markReconcileFailure(env.DB, row.channel_id, row.reconcile_failure_count ?? 0, message);
		log('error', { error: message.slice(0, 120) });
		return { videosAdded: 0, ok: false };
	}
}

export async function reconcileDueChannels(
	env: Env,
	opts?: {
		force?: boolean;
		afterChannelId?: string | null;
		maxChannels?: number;
		ytClient?: YoutubeClient;
		jobId?: string | null;
		now?: number;
	},
): Promise<ReconcileBatchResult> {
	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey && !opts?.ytClient) {
		return { channels: 0, videosAdded: 0, unitsUsed: 0, errors: 0, dueRemaining: 0, budgetExhausted: false, lastChannelId: opts?.afterChannelId ?? null };
	}
	const remaining = await remainingGeneralUnits(env);
	const cfg = quotaConfig(env);
	if (remaining < 1) {
		const dueRemaining = opts?.force ? await countActiveChannels(env.DB) : await countOverdueChannels(env.DB, opts?.now);
		return {
			channels: 0,
			videosAdded: 0,
			unitsUsed: 0,
			errors: 0,
			dueRemaining,
			budgetExhausted: true,
			lastChannelId: opts?.afterChannelId ?? null,
		};
	}
	const remainingChannels = opts?.force
		? await countChannelsAfter(env.DB, opts.afterChannelId ?? null)
		: await countOverdueChannels(env.DB, opts?.now);
	const batch = reconcileBatchSize({
		dueCount: remainingChannels,
		remainingQuota: remaining,
		reconcileReserve: cfg.reconcileReserve,
		maxChannels: opts?.maxChannels ?? MAX_CHANNELS_PER_TICK,
	});
	const limit = Math.max(0, batch);
	if (limit < 1) {
		return {
			channels: 0,
			videosAdded: 0,
			unitsUsed: 0,
			errors: 0,
			dueRemaining: remainingChannels,
			budgetExhausted: remaining < 1,
			lastChannelId: opts?.afterChannelId ?? null,
		};
	}
	const rows = await listDueChannels(env.DB, limit, {
		force: opts?.force,
		afterChannelId: opts?.afterChannelId,
		now: opts?.now,
	});
	if (!rows.length) {
		return { channels: 0, videosAdded: 0, unitsUsed: 0, errors: 0, dueRemaining: 0, budgetExhausted: false, lastChannelId: opts?.afterChannelId ?? null };
	}
	const yt = opts?.ytClient ?? createYoutubeApiKeyClient(apiKey!);
	let videosAdded = 0;
	let errors = 0;
	let lastChannelId = opts?.afterChannelId ?? null;
	for (const row of rows) {
		const result = await reconcileOneChannel(env, yt, row, opts?.jobId ?? null);
		videosAdded += result.videosAdded;
		if (!result.ok) errors += 1;
		lastChannelId = row.channel_id;
	}
	await recordYoutubeCalls(env.DB, yt);
	await recordIngest(env.DB, 'reconcile', videosAdded);
	const dueRemaining = opts?.force
		? await countChannelsAfter(env.DB, lastChannelId)
		: await countOverdueChannels(env.DB, opts?.now);
	return {
		channels: rows.length,
		videosAdded,
		unitsUsed: yt.quotaUsed,
		errors,
		dueRemaining,
		budgetExhausted: remaining - yt.quotaUsed < 1,
		lastChannelId,
	};
}

/** @deprecated Unique-channel API-key reconcile. tickBudget maps to maxChannels. */
export async function runStaleChannelReconcile(
	env: Env,
	_dailyBudget = 40,
	tickBudget = MAX_CHANNELS_PER_TICK,
	ytClient?: YoutubeClient,
): Promise<{ channels: number; videosAdded: number; unitsUsed: number; budgetExhausted: boolean }> {
	const result = await reconcileDueChannels(env, { maxChannels: tickBudget, ytClient });
	return {
		channels: result.channels,
		videosAdded: result.videosAdded,
		unitsUsed: result.unitsUsed,
		budgetExhausted: result.budgetExhausted,
	};
}
