import { classifyYouTubeVideo } from '../../src/lib/classifyVideo';
import { randomToken } from '../auth/crypto';
import {
	chunk,
	createYoutubeClient,
	fetchUploadsPlaylistIds,
	mapPool,
	parseIsoDuration,
	type YoutubeClient,
	YoutubeApiError,
} from './youtube';
import { enqueueHubSubscriptions, recordYoutubeCalls } from './websub';

interface SubscriptionPage {
	nextPageToken?: string;
	items?: Array<{
		snippet?: {
			title?: string;
			description?: string;
			resourceId?: { channelId?: string };
			thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
		};
	}>;
}

interface PlaylistPage {
	nextPageToken?: string;
	items?: Array<{
		contentDetails?: { videoId?: string };
		snippet?: { publishedAt?: string };
	}>;
}

interface VideosPage {
	items?: Array<{
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
	}>;
}

export type SyncWarningCode = 'uploads_playlist_not_found' | 'channel_unavailable';

export interface SyncWarning {
	channelId: string;
	channelTitle: string;
	code: SyncWarningCode;
	message: string;
}

export interface SyncResult {
	syncType: 'subscriptions' | 'content';
	status: 'ok' | 'error' | 'quota';
	channelsChecked: number;
	videosAdded: number;
	videosUpdated: number;
	estimatedQuotaUnits: number;
	errorSummary: string | null;
	done?: boolean;
	nextOffset?: number;
	nextPageToken?: string;
	pulled?: number;
	want?: number;
	totalChannels?: number;
	channelsSkipped?: number;
	warnings?: SyncWarning[];
}

type ChannelContentSyncOutcome =
	| {
			status: 'ok';
			channelId: string;
			videoIds: string[];
	  }
	| {
			status: 'skipped';
			channelId: string;
			channelTitle: string;
			playlistId: string;
			reason: SyncWarningCode;
	  };

const MAX_SYNC_WARNINGS = 24;

function warningMessage(code: SyncWarningCode): string {
	if (code === 'channel_unavailable') return 'Channel is currently unavailable.';
	return 'Uploads playlist is currently unavailable.';
}

function logChannelSkip(params: {
	channelId: string;
	channelTitle: string;
	playlistId: string;
	reason: SyncWarningCode;
}): void {
	console.warn(
		JSON.stringify({
			operation: 'content_sync',
			channelId: params.channelId,
			channelTitle: params.channelTitle,
			playlistId: params.playlistId,
			status: 404,
			outcome: 'skipped',
			reason: params.reason,
		}),
	);
}

function rethrowIfGlobal(error: unknown): void {
	if (!(error instanceof YoutubeApiError)) throw error;
	if (error.isGlobalFatal) throw error;
	if (error.isPlaylistNotFound) return;
	throw error;
}

const INCREMENTAL_WANT = 15;
const INCREMENTAL_MAX = 100;
const PLAYLIST_PAGE = 50;
const CONTENT_BATCH = 8;
const CATCHUP_PAGE = 50;
const MAX_CONTENT_BATCHES = 256;

async function recordRun(db: D1Database, userId: string, result: SyncResult, startedAt: string): Promise<void> {
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

export async function syncSubscriptions(
	env: Env,
	userId: string,
	accessToken: string,
	ytClient?: YoutubeClient,
): Promise<SyncResult> {
	const startedAt = new Date().toISOString();
	const yt = ytClient ?? createYoutubeClient(accessToken);
	const seen = new Set<string>();
	try {
		let pageToken = '';
		const rows: Array<{
			channelId: string;
			title: string;
			description: string;
			thumbnailUrl: string;
		}> = [];
		do {
			const params: Record<string, string> = { part: 'snippet', mine: 'true', maxResults: '50' };
			if (pageToken) params.pageToken = pageToken;
			const page = await yt.getJson<SubscriptionPage>('subscriptions', params);
			for (const item of page.items ?? []) {
				const channelId = item.snippet?.resourceId?.channelId;
				if (!channelId || seen.has(channelId)) continue;
				seen.add(channelId);
				rows.push({
					channelId,
					title: item.snippet?.title ?? 'Channel',
					description: (item.snippet?.description ?? '').slice(0, 500),
					thumbnailUrl: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? '',
				});
			}
			pageToken = page.nextPageToken ?? '';
		} while (pageToken);

		const syncId = randomToken(12);
		const seenAt = new Date().toISOString();
		for (const group of chunk(rows, 20)) {
			const statements = group.map((row) =>
				env.DB.prepare(
					`INSERT INTO channels (channel_id, title, description, thumbnail_url)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(channel_id) DO UPDATE SET
						title = excluded.title,
						description = excluded.description,
						thumbnail_url = excluded.thumbnail_url`,
				).bind(row.channelId, row.title, row.description, row.thumbnailUrl),
			);
			await env.DB.batch(statements);
		}

		const ids = rows.map((r) => r.channelId);
		for (const group of chunk(ids, 20)) {
			await env.DB.batch(
				group.map((channelId) =>
					env.DB.prepare(
						`INSERT INTO channel_prefs (user_id, channel_id, follow_in_inbox, max_videos_to_pull, is_subscribed, last_subscription_sync_id, subscription_seen_at, unsubscribed_at)
						 VALUES (?, ?, 1, 0, 1, ?, ?, NULL)
						 ON CONFLICT(user_id, channel_id) DO UPDATE SET
							is_subscribed = 1,
							last_subscription_sync_id = excluded.last_subscription_sync_id,
							subscription_seen_at = excluded.subscription_seen_at,
							unsubscribed_at = NULL`,
					).bind(userId, channelId, syncId, seenAt),
				),
			);
		}

		await env.DB.prepare(
			`UPDATE channel_prefs
			 SET is_subscribed = 0, unsubscribed_at = ?
			 WHERE user_id = ? AND is_subscribed = 1 AND (last_subscription_sync_id IS NULL OR last_subscription_sync_id != ?)`,
		)
			.bind(seenAt, userId, syncId)
			.run();

		await enqueueHubSubscriptions(env, ids);

		if (ids.length) {
			const missing = await env.DB.prepare(
				`SELECT channel_id FROM channels WHERE uploads_playlist_id IS NULL AND channel_id IN (${ids.map(() => '?').join(',')})`,
			)
				.bind(...ids)
				.all<{ channel_id: string }>();
			const needPlaylist = (missing.results ?? []).map((row) => row.channel_id);
			if (needPlaylist.length) {
				try {
					const found = await fetchUploadsPlaylistIds(yt, needPlaylist);
					const updates = needPlaylist
						.filter((channelId) => found.get(channelId))
						.map((channelId) =>
							env.DB.prepare('UPDATE channels SET uploads_playlist_id = ? WHERE channel_id = ?').bind(
								found.get(channelId)!,
								channelId,
							),
						);
					if (updates.length) await env.DB.batch(updates);
				} catch (error) {
					if (error instanceof YoutubeApiError && error.isGlobalFatal) throw error;
				}
			}
		}

		await recordYoutubeCalls(env.DB, yt);

		const result: SyncResult = {
			syncType: 'subscriptions',
			status: 'ok',
			channelsChecked: rows.length,
			videosAdded: 0,
			videosUpdated: 0,
			estimatedQuotaUnits: yt.quotaUsed,
			errorSummary: null,
		};
		await recordRun(env.DB, userId, result, startedAt);
		return result;
	} catch (error) {
		const quota = error instanceof YoutubeApiError && error.quotaExceeded;
		const result: SyncResult = {
			syncType: 'subscriptions',
			status: quota ? 'quota' : 'error',
			channelsChecked: seen.size,
			videosAdded: 0,
			videosUpdated: 0,
			estimatedQuotaUnits: yt.quotaUsed,
			errorSummary: error instanceof Error ? error.message : 'sync_failed',
		};
		await recordRun(env.DB, userId, result, startedAt);
		return result;
	}
}

async function fetchPlaylistPage(
	yt: YoutubeClient,
	playlistId: string,
	pageToken: string,
	want: number,
): Promise<{ items: Array<{ videoId: string; publishedAt: string | null }>; nextPageToken: string }> {
	const params: Record<string, string> = {
		part: 'snippet,contentDetails',
		playlistId,
		maxResults: String(Math.min(50, Math.max(1, want))),
	};
	if (pageToken) params.pageToken = pageToken;
	const page = await yt.getJson<PlaylistPage>('playlistItems', params);
	const items: Array<{ videoId: string; publishedAt: string | null }> = [];
	for (const item of page.items ?? []) {
		const videoId = item.contentDetails?.videoId;
		if (!videoId) continue;
		items.push({ videoId, publishedAt: item.snippet?.publishedAt ?? null });
		if (items.length >= want) break;
	}
	return { items, nextPageToken: page.nextPageToken ?? '' };
}

async function fetchIncrementalVideoIds(
	yt: YoutubeClient,
	playlistId: string,
	watermark: string | null,
): Promise<string[]> {
	const ids: string[] = [];
	let pageToken = '';
	const want = watermark ? INCREMENTAL_MAX : INCREMENTAL_WANT;
	const pageSize = watermark ? PLAYLIST_PAGE : INCREMENTAL_WANT;
	while (ids.length < want) {
		const page = await fetchPlaylistPage(yt, playlistId, pageToken, Math.min(pageSize, want - ids.length));
		for (const item of page.items) {
			if (watermark && item.publishedAt && item.publishedAt <= watermark) return ids;
			ids.push(item.videoId);
			if (ids.length >= want) break;
		}
		if (!page.nextPageToken) break;
		pageToken = page.nextPageToken;
	}
	return ids;
}

async function fetchVideoDetails(
	yt: YoutubeClient,
	ids: string[],
): Promise<Map<string, NonNullable<VideosPage['items']>[number]>> {
	const details = new Map<string, NonNullable<VideosPage['items']>[number]>();
	for (const group of chunk(ids, 50)) {
		if (group.length === 0) continue;
		const page = await yt.getJson<VideosPage>('videos', {
			part: 'snippet,contentDetails,status,liveStreamingDetails',
			id: group.join(','),
		});
		for (const video of page.items ?? []) {
			if (video.id) details.set(video.id, video);
		}
	}
	return details;
}

type ChannelSyncRow = {
	channel_id: string;
	title: string;
	uploads_playlist_id: string;
	follow_in_inbox: number;
	max_videos_to_pull: number;
	newest_seen_published_at: string | null;
	last_synchronized_at: string | null;
};

async function touchChannelSync(db: D1Database, channelId: string): Promise<void> {
	await db
		.prepare('UPDATE channels SET last_synchronized_at = ? WHERE channel_id = ?')
		.bind(new Date().toISOString(), channelId)
		.run();
}

async function skipChannel(
	env: Env,
	params: { channelId: string; channelTitle: string; playlistId: string; reason: SyncWarningCode },
): Promise<ChannelContentSyncOutcome> {
	logChannelSkip(params);
	await touchChannelSync(env.DB, params.channelId);
	return {
		status: 'skipped',
		channelId: params.channelId,
		channelTitle: params.channelTitle,
		playlistId: params.playlistId,
		reason: params.reason,
	};
}

async function updateUploadsPlaylist(db: D1Database, channelId: string, playlistId: string): Promise<void> {
	await db
		.prepare('UPDATE channels SET uploads_playlist_id = ? WHERE channel_id = ?')
		.bind(playlistId, channelId)
		.run();
}

async function syncChannelUploads(
	env: Env,
	yt: YoutubeClient,
	ch: ChannelSyncRow,
): Promise<ChannelContentSyncOutcome> {
	const channelTitle = ch.title || 'Channel';
	const storedPlaylist = ch.uploads_playlist_id;

	try {
		const ids = await fetchIncrementalVideoIds(yt, storedPlaylist, ch.newest_seen_published_at);
		await touchChannelSync(env.DB, ch.channel_id);
		return { status: 'ok', channelId: ch.channel_id, videoIds: ids };
	} catch (error) {
		rethrowIfGlobal(error);
		if (!(error instanceof YoutubeApiError) || !error.isPlaylistNotFound) throw error;
	}

	let refreshed: string | null = null;
	try {
		const map = await fetchUploadsPlaylistIds(yt, [ch.channel_id]);
		refreshed = map.get(ch.channel_id) ?? null;
	} catch (error) {
		rethrowIfGlobal(error);
		throw error;
	}

	if (!refreshed) {
		return skipChannel(env, {
			channelId: ch.channel_id,
			channelTitle,
			playlistId: storedPlaylist,
			reason: 'channel_unavailable',
		});
	}

	if (refreshed === storedPlaylist) {
		return skipChannel(env, {
			channelId: ch.channel_id,
			channelTitle,
			playlistId: storedPlaylist,
			reason: 'uploads_playlist_not_found',
		});
	}

	await updateUploadsPlaylist(env.DB, ch.channel_id, refreshed);
	ch.uploads_playlist_id = refreshed;

	try {
		const ids = await fetchIncrementalVideoIds(yt, refreshed, ch.newest_seen_published_at);
		await touchChannelSync(env.DB, ch.channel_id);
		return { status: 'ok', channelId: ch.channel_id, videoIds: ids };
	} catch (error) {
		rethrowIfGlobal(error);
		if (error instanceof YoutubeApiError && error.isPlaylistNotFound) {
			return skipChannel(env, {
				channelId: ch.channel_id,
				channelTitle,
				playlistId: refreshed,
				reason: 'uploads_playlist_not_found',
			});
		}
		throw error;
	}
}

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

async function ingestChannelVideos(
	env: Env,
	userId: string,
	ch: ChannelSyncRow,
	videos: NonNullable<VideosPage['items']>[number][],
	mode: 'incremental' | 'catchup',
): Promise<{ added: number; updated: number }> {
	const watermark = ch.newest_seen_published_at;
	let backfillLeft = mode === 'catchup' ? 0 : watermark ? 0 : ch.max_videos_to_pull;
	let newestPublished = watermark;
	const usable = videos.filter((video) => Boolean(video.id && video.snippet));
	const ids = usable.map((video) => video.id!);
	const existing = new Set<string>();
	if (ids.length) {
		const found = await env.DB.prepare(
			`SELECT video_id FROM videos WHERE video_id IN (${ids.map(() => '?').join(',')})`,
		)
			.bind(...ids)
			.all<{ video_id: string }>();
		for (const row of found.results ?? []) existing.add(row.video_id);
	}

	let videosAdded = 0;
	let videosUpdated = 0;
	const videoStmts: ReturnType<D1Database['prepare']>[] = [];
	const inboxStmts: ReturnType<D1Database['prepare']>[] = [];

	for (const video of usable) {
		const published = video.snippet!.publishedAt ?? null;
		const cls = classifyYouTubeVideo({
			liveBroadcastContent: video.snippet!.liveBroadcastContent,
			scheduledStartTime: video.liveStreamingDetails?.scheduledStartTime ?? null,
			actualStartTime: video.liveStreamingDetails?.actualStartTime ?? null,
			actualEndTime: video.liveStreamingDetails?.actualEndTime ?? null,
		});
		videoStmts.push(
			env.DB.prepare(VIDEO_UPSERT).bind(
				video.id,
				video.snippet!.channelId,
				video.snippet!.title ?? 'Untitled',
				(video.snippet!.description ?? '').slice(0, 400),
				video.snippet!.thumbnails?.default?.url ?? '',
				video.snippet!.thumbnails?.medium?.url ?? '',
				video.snippet!.thumbnails?.high?.url ?? '',
				published,
				video.liveStreamingDetails?.scheduledStartTime ?? null,
				video.liveStreamingDetails?.actualStartTime ?? null,
				video.liveStreamingDetails?.actualEndTime ?? null,
				parseIsoDuration(video.contentDetails?.duration),
				cls.contentType,
				cls.livestreamStatus,
				video.status?.embeddable === false ? 0 : 1,
			),
		);
		if (existing.has(video.id!)) videosUpdated += 1;
		else videosAdded += 1;

		const isNew = Boolean(watermark && published && published > watermark);
		const takeBackfill = mode === 'incremental' && !watermark && backfillLeft > 0;
		const addToInbox = mode === 'catchup' || (ch.follow_in_inbox === 1 && isNew) || takeBackfill;
		if (takeBackfill) backfillLeft -= 1;
		if (addToInbox) {
			inboxStmts.push(
				env.DB.prepare(
					`INSERT OR IGNORE INTO inbox_state (user_id, video_id, unread, starred, archived, hidden)
					 VALUES (?, ?, 1, 0, 0, 0)`,
				).bind(userId, video.id),
			);
		}
		if (published && (!newestPublished || published > newestPublished)) newestPublished = published;
	}

	for (const group of chunk(videoStmts, 40)) await env.DB.batch(group);
	for (const group of chunk(inboxStmts, 40)) await env.DB.batch(group);

	await env.DB.prepare(
		`INSERT INTO channel_prefs (user_id, channel_id, follow_in_inbox, max_videos_to_pull, newest_seen_published_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, channel_id) DO UPDATE SET newest_seen_published_at = excluded.newest_seen_published_at`,
	)
		.bind(userId, ch.channel_id, ch.follow_in_inbox, ch.max_videos_to_pull, newestPublished)
		.run();

	return { added: videosAdded, updated: videosUpdated };
}

export async function syncContent(
	env: Env,
	userId: string,
	accessToken: string,
	offset = 0,
	ytClient?: YoutubeClient,
	opts?: { categoryId?: string | null; allSubscribed?: boolean; staleBefore?: string },
): Promise<SyncResult> {
	const startedAt = new Date().toISOString();
	const yt = ytClient ?? createYoutubeClient(accessToken);
	let videosAdded = 0;
	let videosUpdated = 0;
	try {
		const categoryId = opts?.categoryId?.trim() || null;
		const allSubscribed = opts?.allSubscribed === true;
		const staleBefore = opts?.staleBefore?.trim() || null;
		let sql = `SELECT c.channel_id, c.title, c.uploads_playlist_id,
				COALESCE(p.follow_in_inbox, 1) AS follow_in_inbox,
				COALESCE(p.max_videos_to_pull, 0) AS max_videos_to_pull,
				p.newest_seen_published_at,
				c.last_synchronized_at
			 FROM channels c
			 JOIN channel_prefs p ON p.channel_id = c.channel_id AND p.user_id = ?
			 WHERE p.is_subscribed = 1 AND c.uploads_playlist_id IS NOT NULL`;
		const binds: string[] = [userId];
		if (categoryId) {
			sql += ` AND c.channel_id IN (SELECT channel_id FROM channel_categories WHERE user_id = ? AND category_id = ?)`;
			binds.push(userId, categoryId);
		}
		if (staleBefore) {
			sql += ` AND (c.last_synchronized_at IS NULL OR c.last_synchronized_at < ?)
				ORDER BY CASE WHEN c.last_synchronized_at IS NULL THEN 0 ELSE 1 END, c.last_synchronized_at ASC, c.channel_id ASC`;
			binds.push(staleBefore);
		}
		const channels = await env.DB.prepare(sql).bind(...binds).all<ChannelSyncRow>();
		const list = (channels.results ?? []).filter((ch) =>
			categoryId || allSubscribed ? true : ch.follow_in_inbox === 1 || ch.max_videos_to_pull > 0,
		);
		const batch = staleBefore ? list.slice(0, CONTENT_BATCH) : list.slice(offset, offset + CONTENT_BATCH);
		const outcomes = await mapPool(batch, 3, (ch) => syncChannelUploads(env, yt, ch));

		const idsByChannel = new Map<string, string[]>();
		const warnings: SyncWarning[] = [];
		let channelsSkipped = 0;
		for (const outcome of outcomes) {
			if (outcome.status === 'ok') {
				idsByChannel.set(outcome.channelId, outcome.videoIds);
				continue;
			}
			channelsSkipped += 1;
			if (warnings.length < MAX_SYNC_WARNINGS) {
				warnings.push({
					channelId: outcome.channelId,
					channelTitle: outcome.channelTitle,
					code: outcome.reason,
					message: warningMessage(outcome.reason),
				});
			}
		}

		const unique = [...new Set([...idsByChannel.values()].flat())];
		const details = await fetchVideoDetails(yt, unique);

		for (const ch of batch) {
			const ids = idsByChannel.get(ch.channel_id);
			if (!ids) continue;
			const videos = ids
				.map((id) => details.get(id))
				.filter((video): video is NonNullable<VideosPage['items']>[number] => Boolean(video?.id && video.snippet));
			videos.sort((a, b) => Date.parse(b.snippet?.publishedAt ?? '') - Date.parse(a.snippet?.publishedAt ?? ''));
			const counts = await ingestChannelVideos(env, userId, ch, videos, 'incremental');
			videosAdded += counts.added;
			videosUpdated += counts.updated;
		}

		const nextOffset = staleBefore ? batch.length : offset + batch.length;
		const result: SyncResult = {
			syncType: 'content',
			status: 'ok',
			channelsChecked: batch.length,
			channelsSkipped,
			videosAdded,
			videosUpdated,
			estimatedQuotaUnits: yt.quotaUsed,
			errorSummary: null,
			warnings: warnings.length ? warnings : undefined,
			done: staleBefore ? batch.length < CONTENT_BATCH : nextOffset >= list.length,
			nextOffset,
			totalChannels: list.length,
		};
		await recordRun(env.DB, userId, result, startedAt);
		await recordYoutubeCalls(env.DB, yt);
		return result;
	} catch (error) {
		const quota = error instanceof YoutubeApiError && error.quotaExceeded;
		const result: SyncResult = {
			syncType: 'content',
			status: quota ? 'quota' : 'error',
			channelsChecked: 0,
			videosAdded,
			videosUpdated,
			estimatedQuotaUnits: yt.quotaUsed,
			errorSummary: error instanceof Error ? error.message : 'sync_failed',
		};
		await recordRun(env.DB, userId, result, startedAt);
		return result;
	}
}

export async function syncAllDueContent(
	env: Env,
	userId: string,
	accessToken: string,
	ytClient?: YoutubeClient,
): Promise<SyncResult> {
	const yt = ytClient ?? createYoutubeClient(accessToken);
	const staleBefore = new Date().toISOString();
	let videosAdded = 0;
	let videosUpdated = 0;
	let channelsChecked = 0;
	let channelsSkipped = 0;
	const warnings: SyncWarning[] = [];
	let last: SyncResult | null = null;
	for (let guard = 0; guard < MAX_CONTENT_BATCHES; guard += 1) {
		const result = await syncContent(env, userId, accessToken, 0, yt, { staleBefore });
		last = result;
		channelsChecked += result.channelsChecked;
		channelsSkipped += result.channelsSkipped ?? 0;
		videosAdded += result.videosAdded;
		videosUpdated += result.videosUpdated;
		if (result.warnings) {
			for (const warning of result.warnings) {
				if (warnings.length < MAX_SYNC_WARNINGS) warnings.push(warning);
			}
		}
		if (result.status !== 'ok') {
			return {
				...result,
				channelsChecked,
				channelsSkipped,
				videosAdded,
				videosUpdated,
				estimatedQuotaUnits: yt.quotaUsed,
				warnings: warnings.length ? warnings : undefined,
				done: false,
			};
		}
		if (result.done || result.channelsChecked === 0) break;
	}
	const summary: SyncResult = {
		syncType: 'content',
		status: last?.status ?? 'ok',
		channelsChecked,
		channelsSkipped,
		videosAdded,
		videosUpdated,
		estimatedQuotaUnits: yt.quotaUsed,
		errorSummary: last?.errorSummary ?? null,
		warnings: warnings.length ? warnings : undefined,
		done: true,
		totalChannels: channelsChecked,
	};
	console.log(
		JSON.stringify({
			operation: 'cron_content_sync',
			userId,
			status: summary.status,
			channelsChecked,
			channelsSkipped,
			videosAdded,
			estimatedQuotaUnits: yt.quotaUsed,
		}),
	);
	return summary;
}

export async function catchUpChannel(
	env: Env,
	userId: string,
	accessToken: string,
	channelId: string,
	pageToken = '',
	pulled = 0,
): Promise<SyncResult> {
	const startedAt = new Date().toISOString();
	const yt = createYoutubeClient(accessToken);
	try {
		const ch = await env.DB.prepare(
			`SELECT c.channel_id, c.title, c.uploads_playlist_id,
				COALESCE(p.follow_in_inbox, 1) AS follow_in_inbox,
				COALESCE(p.max_videos_to_pull, 0) AS max_videos_to_pull,
				p.newest_seen_published_at,
				c.last_synchronized_at
			 FROM channels c
			 LEFT JOIN channel_prefs p ON p.channel_id = c.channel_id AND p.user_id = ?
			 WHERE c.channel_id = ? AND p.is_subscribed = 1`,
		)
			.bind(userId, channelId)
			.first<ChannelSyncRow>();
		if (!ch?.uploads_playlist_id) {
			return {
				syncType: 'content',
				status: 'error',
				channelsChecked: 0,
				videosAdded: 0,
				videosUpdated: 0,
				estimatedQuotaUnits: yt.quotaUsed,
				errorSummary: 'Channel is not available to catch up.',
			};
		}
		const want = Math.min(500, Math.max(0, ch.max_videos_to_pull));
		if (want < 1) {
			return {
				syncType: 'content',
				status: 'error',
				channelsChecked: 1,
				videosAdded: 0,
				videosUpdated: 0,
				estimatedQuotaUnits: 0,
				errorSummary: 'Set max videos to pull above 0, then catch up.',
			};
		}
		const remaining = Math.max(0, want - pulled);
		if (remaining < 1) {
			return {
				syncType: 'content',
				status: 'ok',
				channelsChecked: 1,
				videosAdded: 0,
				videosUpdated: 0,
				estimatedQuotaUnits: 0,
				errorSummary: null,
				done: true,
				pulled,
				want,
				totalChannels: 1,
			};
		}
		const page = await fetchPlaylistPage(yt, ch.uploads_playlist_id, pageToken, Math.min(CATCHUP_PAGE, remaining));
		const pageIds = page.items.map((item) => item.videoId);
		const details = await fetchVideoDetails(yt, pageIds);
		const videos = pageIds
			.map((id) => details.get(id))
			.filter((video): video is NonNullable<VideosPage['items']>[number] => Boolean(video?.id && video.snippet));
		videos.sort((a, b) => Date.parse(b.snippet?.publishedAt ?? '') - Date.parse(a.snippet?.publishedAt ?? ''));
		const counts = await ingestChannelVideos(env, userId, ch, videos, 'catchup');
		await touchChannelSync(env.DB, ch.channel_id);
		const nextPulled = pulled + pageIds.length;
		const done = !page.nextPageToken || nextPulled >= want;
		const result: SyncResult = {
			syncType: 'content',
			status: 'ok',
			channelsChecked: 1,
			videosAdded: counts.added,
			videosUpdated: counts.updated,
			estimatedQuotaUnits: yt.quotaUsed,
			errorSummary: null,
			done,
			nextPageToken: done ? undefined : page.nextPageToken,
			pulled: nextPulled,
			want,
			totalChannels: 1,
		};
		await recordRun(env.DB, userId, result, startedAt);
		await recordYoutubeCalls(env.DB, yt);
		return result;
	} catch (error) {
		const quota = error instanceof YoutubeApiError && error.quotaExceeded;
		const result: SyncResult = {
			syncType: 'content',
			status: quota ? 'quota' : 'error',
			channelsChecked: 1,
			videosAdded: 0,
			videosUpdated: 0,
			estimatedQuotaUnits: yt.quotaUsed,
			errorSummary: error instanceof Error ? error.message : 'catchup_failed',
			pulled,
		};
		await recordRun(env.DB, userId, result, startedAt);
		return result;
	}
}
