import { classifyYouTubeVideo } from '../../src/lib/classifyVideo';
import { chunk, createYoutubeApiKeyClient, fetchUploadsPlaylistIds, parseIsoDuration, selectInChunks, type YoutubeClient } from './youtube';
import { dailyQuotaUsed, recordQuota, recordYoutubeCalls, VIDEO_ID_RE } from './websub';

const VIDEO_UPSERT = `INSERT INTO videos (
				video_id, channel_id, title, description_excerpt, thumbnail_default, thumbnail_medium, thumbnail_high,
				published_at, scheduled_start_at, actual_start_at, actual_end_at, duration_seconds, content_type,
				livestream_status, embeddable, last_api_update_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			ON CONFLICT(video_id) DO UPDATE SET
				title = excluded.title,
				description_excerpt = excluded.description_excerpt,
				thumbnail_default = excluded.thumbnail_default,
				thumbnail_medium = excluded.thumbnail_medium,
				thumbnail_high = excluded.thumbnail_high,
				published_at = excluded.published_at,
				scheduled_start_at = excluded.scheduled_start_at,
				actual_start_at = excluded.actual_start_at,
				actual_end_at = excluded.actual_end_at,
				duration_seconds = excluded.duration_seconds,
				content_type = excluded.content_type,
				livestream_status = excluded.livestream_status,
				embeddable = excluded.embeddable,
				last_api_update_at = excluded.last_api_update_at`;

const FANOUT_INBOX = `INSERT OR IGNORE INTO inbox_state (user_id, video_id, unread, starred, archived, hidden)
	SELECT p.user_id, ?, 1, 0, 0, 0
	FROM channel_prefs p
	WHERE p.channel_id = ? AND p.is_subscribed = 1 AND p.follow_in_inbox = 1`;

interface VideoDetails {
	id?: string;
	snippet?: {
		channelId?: string;
		title?: string;
		description?: string;
		publishedAt?: string;
		liveBroadcastContent?: string;
		thumbnails?: { default?: { url?: string }; medium?: { url?: string }; high?: { url?: string } };
	};
	contentDetails?: { duration?: string };
	status?: { embeddable?: boolean };
	liveStreamingDetails?: {
		scheduledStartTime?: string;
		actualStartTime?: string;
		actualEndTime?: string;
	};
}

export async function upsertGlobalVideo(db: D1Database, video: VideoDetails): Promise<boolean> {
	if (!video.id || !video.snippet?.channelId || !VIDEO_ID_RE.test(video.id)) return false;
	const cls = classifyYouTubeVideo({
		liveBroadcastContent: video.snippet.liveBroadcastContent,
		scheduledStartTime: video.liveStreamingDetails?.scheduledStartTime ?? null,
		actualStartTime: video.liveStreamingDetails?.actualStartTime ?? null,
		actualEndTime: video.liveStreamingDetails?.actualEndTime ?? null,
	});
	await db
		.prepare(VIDEO_UPSERT)
		.bind(
			video.id,
			video.snippet.channelId,
			video.snippet.title ?? 'Untitled',
			(video.snippet.description ?? '').slice(0, 400),
			video.snippet.thumbnails?.default?.url ?? '',
			video.snippet.thumbnails?.medium?.url ?? '',
			video.snippet.thumbnails?.high?.url ?? '',
			video.snippet.publishedAt ?? null,
			video.liveStreamingDetails?.scheduledStartTime ?? null,
			video.liveStreamingDetails?.actualStartTime ?? null,
			video.liveStreamingDetails?.actualEndTime ?? null,
			parseIsoDuration(video.contentDetails?.duration),
			cls.contentType,
			cls.livestreamStatus,
			video.status?.embeddable === false ? 0 : 1,
		)
		.run();
	return true;
}

export async function fanoutInbox(db: D1Database, videoId: string, channelId: string): Promise<void> {
	await db.prepare(FANOUT_INBOX).bind(videoId, channelId).run();
}

export const WEBSUB_EVENT_MAX_ATTEMPTS = 8;
export const WEBSUB_EVENT_BACKOFF_BASE_MS = 60_000;
export const WEBSUB_EVENT_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
export const FEED_RECONCILE_DAILY_BUDGET = 40;
export const FEED_RECONCILE_TICK_BUDGET = 4;

export function nextAttemptAt(attempts: number, now = Date.now()): string {
	const exp = Math.max(0, attempts - 1);
	const delay = Math.min(WEBSUB_EVENT_BACKOFF_MAX_MS, WEBSUB_EVENT_BACKOFF_BASE_MS * 2 ** exp);
	return new Date(now + delay).toISOString();
}

async function markEventAttempt(db: D1Database, id: string, attempts: number, error: string): Promise<void> {
	const nextAttempts = attempts + 1;
	const now = new Date().toISOString();
	const status = nextAttempts >= WEBSUB_EVENT_MAX_ATTEMPTS ? 'dead' : 'error';
	await db
		.prepare(
			`UPDATE websub_events SET status = ?, attempts = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
		)
		.bind(status, nextAttempts, now, nextAttemptAt(nextAttempts), error.slice(0, 180), id)
		.run();
}

async function markEventDone(db: D1Database, id: string): Promise<void> {
	await db
		.prepare(
			`UPDATE websub_events SET status = 'done', processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = NULL, last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
		)
		.bind(id)
		.run();
}

export async function processPendingWebSubEvents(env: Env, limit = 50, ytClient?: YoutubeClient): Promise<{ processed: number; failed: number }> {
	const now = new Date().toISOString();
	const rows = await env.DB.prepare(
		`SELECT id, channel_id, video_id, attempts FROM websub_events
		 WHERE status IN ('pending', 'error')
		 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
		 ORDER BY created_at LIMIT ?`,
	)
		.bind(now, limit)
		.all<{ id: string; channel_id: string; video_id: string; attempts: number }>();
	const events = rows.results ?? [];
	if (!events.length) return { processed: 0, failed: 0 };

	const uniqueIds = [...new Set(events.map((e) => e.video_id).filter((id) => VIDEO_ID_RE.test(id)))];
	const knownRows = uniqueIds.length
		? await selectInChunks<{ video_id: string }>(
				env.DB,
				(placeholders) => `SELECT video_id FROM videos WHERE video_id IN (${placeholders})`,
				uniqueIds,
			)
		: [];
	const known = new Set(knownRows.map((row) => row.video_id));
	const missing = uniqueIds.filter((id) => !known.has(id));

	const apiKey = env.YOUTUBE_API_KEY;
	const details = new Map<string, VideoDetails>();
	if (missing.length) {
		if (!apiKey && !ytClient) {
			for (const event of events) {
				if (known.has(event.video_id)) continue;
				await markEventAttempt(env.DB, event.id, event.attempts ?? 0, 'missing_api_key');
			}
		} else {
			const yt = ytClient ?? createYoutubeApiKeyClient(apiKey!);
			for (const group of chunk(missing, 50)) {
				const page = await yt.getJson<{ items?: VideoDetails[] }>('videos', {
					part: 'snippet,contentDetails,status,liveStreamingDetails',
					id: group.join(','),
				});
				for (const item of page.items ?? []) {
					if (item.id) details.set(item.id, item);
				}
			}
			await recordYoutubeCalls(env.DB, yt);
		}
	}

	let processed = 0;
	let failed = 0;
	for (const event of events) {
		try {
			const video = details.get(event.video_id);
			if (!known.has(event.video_id) && !video) {
				if (!apiKey && !ytClient && missing.includes(event.video_id)) {
					failed += 1;
					continue;
				}
				await markEventAttempt(env.DB, event.id, event.attempts ?? 0, 'video_not_found');
				failed += 1;
				continue;
			}
			if (video) {
				const ok = await upsertGlobalVideo(env.DB, video);
				if (!ok) {
					await markEventAttempt(env.DB, event.id, event.attempts ?? 0, 'video_upsert_failed');
					failed += 1;
					continue;
				}
			}
			const channelId = video?.snippet?.channelId ?? event.channel_id;
			await fanoutInbox(env.DB, event.video_id, channelId);
			await markEventDone(env.DB, event.id);
			processed += 1;
		} catch (error) {
			await markEventAttempt(
				env.DB,
				event.id,
				event.attempts ?? 0,
				error instanceof Error ? error.message : 'process_failed',
			);
			failed += 1;
		}
	}
	return { processed, failed };
}

const BOOTSTRAP_PAGE = 50;

export async function runGlobalBootstrap(
	env: Env,
	budget = 8,
	ytClient?: YoutubeClient,
): Promise<{ channels: number; videosAdded: number }> {
	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey && !ytClient) return { channels: 0, videosAdded: 0 };
	const yt = ytClient ?? createYoutubeApiKeyClient(apiKey!);
	const rows = await env.DB.prepare(
		`SELECT c.channel_id, c.uploads_playlist_id, c.bootstrap_status, c.bootstrap_page_token
		 FROM channels c
		 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
		 AND (c.bootstrap_status IS NULL OR c.bootstrap_status IN ('pending', 'in_progress'))
		 ORDER BY c.channel_id
		 LIMIT 20`,
	).all<{
		channel_id: string;
		uploads_playlist_id: string | null;
		bootstrap_status: string | null;
		bootstrap_page_token: string | null;
	}>();
	let channels = 0;
	let videosAdded = 0;
	for (const row of rows.results ?? []) {
		if (yt.quotaUsed >= budget) break;
		let playlistId = row.uploads_playlist_id;
		if (!playlistId) {
			const found = await fetchUploadsPlaylistIds(yt, [row.channel_id]);
			playlistId = found.get(row.channel_id) ?? null;
			if (playlistId) {
				await env.DB.prepare('UPDATE channels SET uploads_playlist_id = ? WHERE channel_id = ?')
					.bind(playlistId, row.channel_id)
					.run();
			} else {
				await env.DB.prepare(
					`UPDATE channels SET bootstrap_status = 'unavailable', bootstrap_updated_at = ? WHERE channel_id = ?`,
				)
					.bind(new Date().toISOString(), row.channel_id)
					.run();
				channels += 1;
				continue;
			}
		}
		if (yt.quotaUsed >= budget) break;
		const params: Record<string, string> = {
			part: 'contentDetails,snippet',
			playlistId,
			maxResults: String(BOOTSTRAP_PAGE),
		};
		if (row.bootstrap_page_token) params.pageToken = row.bootstrap_page_token;
		const page = await yt.getJson<{
			nextPageToken?: string;
			items?: Array<{ contentDetails?: { videoId?: string } }>;
		}>('playlistItems', params);
		const ids = [...new Set((page.items ?? []).map((item) => item.contentDetails?.videoId).filter((id): id is string => Boolean(id && VIDEO_ID_RE.test(id))))];
		const existingRows = ids.length
			? await selectInChunks<{ video_id: string }>(
					env.DB,
					(placeholders) => `SELECT video_id FROM videos WHERE video_id IN (${placeholders})`,
					ids,
				)
			: [];
		const known = new Set(existingRows.map((item) => item.video_id));
		const missing = ids.filter((id) => !known.has(id));
		if (missing.length && yt.quotaUsed < budget) {
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
		const now = new Date().toISOString();
		if (page.nextPageToken) {
			await env.DB.prepare(
				`UPDATE channels SET bootstrap_status = 'in_progress', bootstrap_page_token = ?, bootstrap_updated_at = ? WHERE channel_id = ?`,
			)
				.bind(page.nextPageToken, now, row.channel_id)
				.run();
		} else {
			await env.DB.prepare(
				`UPDATE channels SET bootstrap_status = 'done', bootstrap_page_token = NULL, bootstrap_updated_at = ? WHERE channel_id = ?`,
			)
				.bind(now, row.channel_id)
				.run();
		}
		channels += 1;
	}
	await recordYoutubeCalls(env.DB, yt);
	return { channels, videosAdded };
}

interface ReconcileState {
	day: string;
	units_used: number;
	last_channel_id: string | null;
}

async function loadReconcileState(db: D1Database, today: string): Promise<ReconcileState> {
	const row = await db
		.prepare(`SELECT day, units_used, last_channel_id FROM feed_reconcile_state WHERE id = 1`)
		.first<ReconcileState>();
	if (!row || row.day !== today) {
		return { day: today, units_used: 0, last_channel_id: row?.last_channel_id ?? null };
	}
	return row;
}

async function saveReconcileState(db: D1Database, state: ReconcileState): Promise<void> {
	await db
		.prepare(
			`INSERT INTO feed_reconcile_state (id, day, units_used, last_channel_id, updated_at)
			 VALUES (1, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			 ON CONFLICT(id) DO UPDATE SET
				day = excluded.day,
				units_used = excluded.units_used,
				last_channel_id = excluded.last_channel_id,
				updated_at = excluded.updated_at`,
		)
		.bind(state.day, state.units_used, state.last_channel_id)
		.run();
}

/** Bounded unique-channel safety net. Never per-user playlist polling. */
export async function runStaleChannelReconcile(
	env: Env,
	dailyBudget = FEED_RECONCILE_DAILY_BUDGET,
	tickBudget = FEED_RECONCILE_TICK_BUDGET,
	ytClient?: YoutubeClient,
): Promise<{ channels: number; videosAdded: number; unitsUsed: number; budgetExhausted: boolean }> {
	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey && !ytClient) return { channels: 0, videosAdded: 0, unitsUsed: 0, budgetExhausted: false };
	const today = new Date().toISOString().slice(0, 10);
	const persisted = await dailyQuotaUsed(env.DB, 'feed_reconcile');
	const state = await loadReconcileState(env.DB, today);
	state.units_used = Math.max(state.units_used, persisted);
	const remainingDaily = Math.max(0, dailyBudget - state.units_used);
	if (remainingDaily < 1) {
		await saveReconcileState(env.DB, state);
		return { channels: 0, videosAdded: 0, unitsUsed: 0, budgetExhausted: true };
	}
	const budget = Math.min(tickBudget, remainingDaily);
	const yt = ytClient ?? createYoutubeApiKeyClient(apiKey!);
	const now = new Date().toISOString();
	const rows = await env.DB.prepare(
		`SELECT c.channel_id, c.uploads_playlist_id, c.last_synchronized_at,
			w.status AS websub_status, w.lease_expires_at, w.last_verified_at
		 FROM channels c
		 LEFT JOIN websub_subscriptions w ON w.channel_id = c.channel_id
		 WHERE EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id AND p.is_subscribed = 1)
		 ORDER BY CASE
				WHEN w.channel_id IS NULL THEN 0
				WHEN w.status IN ('error', 'pending', 'inactive') THEN 0
				WHEN w.lease_expires_at IS NULL OR w.lease_expires_at <= ? THEN 0
				WHEN w.last_verified_at IS NULL THEN 0
				ELSE 1
			END,
			CASE WHEN c.last_synchronized_at IS NULL THEN 0 ELSE 1 END,
			c.last_synchronized_at ASC,
			c.channel_id ASC
		 LIMIT 80`,
	)
		.bind(now)
		.all<{
			channel_id: string;
			uploads_playlist_id: string | null;
			last_synchronized_at: string | null;
			websub_status: string | null;
			lease_expires_at: string | null;
			last_verified_at: string | null;
		}>();

	const candidates = rows.results ?? [];
	const cursor = state.last_channel_id;
	const start = cursor ? candidates.findIndex((row) => row.channel_id > cursor) : 0;
	const ordered =
		start > 0 ? [...candidates.slice(start), ...candidates.slice(0, start)] : candidates;

	let channels = 0;
	let videosAdded = 0;
	let lastProcessed = cursor;
	for (const row of ordered) {
		if (yt.quotaUsed >= budget) break;
		let playlistId = row.uploads_playlist_id;
		if (!playlistId) {
			if (yt.quotaUsed + 1 > budget) break;
			const found = await fetchUploadsPlaylistIds(yt, [row.channel_id]);
			playlistId = found.get(row.channel_id) ?? null;
			if (playlistId) {
				await env.DB.prepare('UPDATE channels SET uploads_playlist_id = ? WHERE channel_id = ?')
					.bind(playlistId, row.channel_id)
					.run();
			}
		}
		if (!playlistId) {
			await env.DB.prepare('UPDATE channels SET last_synchronized_at = ? WHERE channel_id = ?')
				.bind(new Date().toISOString(), row.channel_id)
				.run();
			lastProcessed = row.channel_id;
			channels += 1;
			continue;
		}
		if (yt.quotaUsed + 1 > budget) break;
		const page = await yt.getJson<{
			items?: Array<{ contentDetails?: { videoId?: string } }>;
		}>('playlistItems', {
			part: 'contentDetails,snippet',
			playlistId,
			maxResults: '50',
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
		if (missing.length && yt.quotaUsed < budget) {
			for (const group of chunk(missing, 50)) {
				if (yt.quotaUsed >= budget) break;
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
		await env.DB.prepare('UPDATE channels SET last_synchronized_at = ? WHERE channel_id = ?')
			.bind(new Date().toISOString(), row.channel_id)
			.run();
		lastProcessed = row.channel_id;
		channels += 1;
	}

	const used = yt.quotaUsed;
	state.units_used += used;
	state.last_channel_id = lastProcessed ?? state.last_channel_id;
	await saveReconcileState(env.DB, state);
	if (used) await recordQuota(env.DB, 'feed_reconcile', { callCount: used, generalUnits: used });
	await recordYoutubeCalls(env.DB, yt);
	return {
		channels,
		videosAdded,
		unitsUsed: used,
		budgetExhausted: remainingDaily - used < 1 || yt.quotaUsed >= budget,
	};
}

