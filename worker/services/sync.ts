import { classifyYouTubeVideo } from '../../src/lib/classifyVideo';
import { randomToken } from '../auth/crypto';
import { chunk, createYoutubeClient, mapPool, parseIsoDuration, YoutubeApiError } from './youtube';

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

interface ChannelPage {
	items?: Array<{
		id?: string;
		contentDetails?: { relatedPlaylists?: { uploads?: string } };
	}>;
}

interface PlaylistPage {
	nextPageToken?: string;
	items?: Array<{ contentDetails?: { videoId?: string } }>;
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
}

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

export async function syncSubscriptions(env: Env, userId: string, accessToken: string): Promise<SyncResult> {
	const startedAt = new Date().toISOString();
	const yt = createYoutubeClient(accessToken);
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

		await env.DB.prepare('UPDATE channels SET subscribed = 0').run();
		for (const group of chunk(rows, 20)) {
			const statements = group.map((row) =>
				env.DB.prepare(
					`INSERT INTO channels (channel_id, title, description, thumbnail_url, subscribed, last_synchronized_at)
					 VALUES (?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
					 ON CONFLICT(channel_id) DO UPDATE SET
						title = excluded.title,
						description = excluded.description,
						thumbnail_url = excluded.thumbnail_url,
						subscribed = 1,
						last_synchronized_at = excluded.last_synchronized_at`,
				).bind(row.channelId, row.title, row.description, row.thumbnailUrl),
			);
			await env.DB.batch(statements);
		}

		const ids = rows.map((r) => r.channelId);
		for (const group of chunk(ids, 50)) {
			const page = await yt.getJson<ChannelPage>('channels', {
				part: 'contentDetails',
				id: group.join(','),
				maxResults: '50',
			});
			const updates = (page.items ?? [])
				.filter((ch) => ch.id && ch.contentDetails?.relatedPlaylists?.uploads)
				.map((ch) =>
					env.DB.prepare('UPDATE channels SET uploads_playlist_id = ? WHERE channel_id = ?').bind(
						ch.contentDetails!.relatedPlaylists!.uploads!,
						ch.id!,
					),
				);
			if (updates.length) await env.DB.batch(updates);
		}

		for (const group of chunk(ids, 20)) {
			await env.DB.batch(
				group.map((channelId) =>
					env.DB.prepare(
						`INSERT OR IGNORE INTO channel_prefs (user_id, channel_id, follow_in_inbox, max_videos_to_pull) VALUES (?, ?, 1, 0)`,
					).bind(userId, channelId),
				),
			);
		}

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
	yt: ReturnType<typeof createYoutubeClient>,
	playlistId: string,
	pageToken: string,
	want: number,
): Promise<{ ids: string[]; nextPageToken: string }> {
	const params: Record<string, string> = {
		part: 'contentDetails',
		playlistId,
		maxResults: String(Math.min(50, Math.max(1, want))),
	};
	if (pageToken) params.pageToken = pageToken;
	const page = await yt.getJson<PlaylistPage>('playlistItems', params);
	const ids: string[] = [];
	for (const item of page.items ?? []) {
		if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
		if (ids.length >= want) break;
	}
	return { ids, nextPageToken: page.nextPageToken ?? '' };
}

async function fetchPlaylistIds(
	yt: ReturnType<typeof createYoutubeClient>,
	playlistId: string,
	want: number,
): Promise<string[]> {
	const ids: string[] = [];
	let pageToken = '';
	while (ids.length < want) {
		const page = await fetchPlaylistPage(yt, playlistId, pageToken, want - ids.length);
		ids.push(...page.ids);
		if (!page.nextPageToken) break;
		pageToken = page.nextPageToken;
	}
	return ids;
}

async function fetchVideoDetails(
	yt: ReturnType<typeof createYoutubeClient>,
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
	uploads_playlist_id: string;
	follow_in_inbox: number;
	max_videos_to_pull: number;
	newest_seen_published_at: string | null;
};

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

const INCREMENTAL_WANT = 15;
const CONTENT_BATCH = 8;
const CATCHUP_PAGE = 50;

export async function syncContent(env: Env, userId: string, accessToken: string, offset = 0): Promise<SyncResult> {
	const startedAt = new Date().toISOString();
	const yt = createYoutubeClient(accessToken);
	let videosAdded = 0;
	let videosUpdated = 0;
	try {
		const channels = await env.DB.prepare(
			`SELECT c.channel_id, c.uploads_playlist_id,
				COALESCE(p.follow_in_inbox, 1) AS follow_in_inbox,
				COALESCE(p.max_videos_to_pull, 0) AS max_videos_to_pull,
				p.newest_seen_published_at
			 FROM channels c
			 LEFT JOIN channel_prefs p ON p.channel_id = c.channel_id AND p.user_id = ?
			 WHERE c.subscribed = 1 AND c.uploads_playlist_id IS NOT NULL`,
		)
			.bind(userId)
			.all<{
				channel_id: string;
				uploads_playlist_id: string;
				follow_in_inbox: number;
				max_videos_to_pull: number;
				newest_seen_published_at: string | null;
			}>();
		const list = (channels.results ?? []).filter((ch) => ch.follow_in_inbox === 1 || ch.max_videos_to_pull > 0);
		const batch = list.slice(offset, offset + CONTENT_BATCH);
		const idsByChannel = new Map<string, string[]>();
		await mapPool(batch, 3, async (ch) => {
			const ids = await fetchPlaylistIds(yt, ch.uploads_playlist_id, INCREMENTAL_WANT);
			idsByChannel.set(ch.channel_id, ids);
			await env.DB.prepare(
				`UPDATE channels SET last_synchronized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE channel_id = ?`,
			)
				.bind(ch.channel_id)
				.run();
		});

		const unique = [...new Set([...idsByChannel.values()].flat())];
		const details = await fetchVideoDetails(yt, unique);

		for (const ch of batch) {
			const ids = idsByChannel.get(ch.channel_id) ?? [];
			const videos = ids
				.map((id) => details.get(id))
				.filter((video): video is NonNullable<VideosPage['items']>[number] => Boolean(video?.id && video.snippet));
			videos.sort((a, b) => Date.parse(b.snippet?.publishedAt ?? '') - Date.parse(a.snippet?.publishedAt ?? ''));
			const counts = await ingestChannelVideos(env, userId, ch, videos, 'incremental');
			videosAdded += counts.added;
			videosUpdated += counts.updated;
		}

		const nextOffset = offset + batch.length;
		const result: SyncResult = {
			syncType: 'content',
			status: 'ok',
			channelsChecked: batch.length,
			videosAdded,
			videosUpdated,
			estimatedQuotaUnits: yt.quotaUsed,
			errorSummary: null,
			done: nextOffset >= list.length,
			nextOffset,
			totalChannels: list.length,
		};
		await recordRun(env.DB, userId, result, startedAt);
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
			`SELECT c.channel_id, c.uploads_playlist_id,
				COALESCE(p.follow_in_inbox, 1) AS follow_in_inbox,
				COALESCE(p.max_videos_to_pull, 0) AS max_videos_to_pull,
				p.newest_seen_published_at
			 FROM channels c
			 LEFT JOIN channel_prefs p ON p.channel_id = c.channel_id AND p.user_id = ?
			 WHERE c.channel_id = ? AND c.subscribed = 1`,
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
		const details = await fetchVideoDetails(yt, page.ids);
		const videos = page.ids
			.map((id) => details.get(id))
			.filter((video): video is NonNullable<VideosPage['items']>[number] => Boolean(video?.id && video.snippet));
		videos.sort((a, b) => Date.parse(b.snippet?.publishedAt ?? '') - Date.parse(a.snippet?.publishedAt ?? ''));
		const counts = await ingestChannelVideos(env, userId, ch, videos, 'catchup');
		await env.DB.prepare(
			`UPDATE channels SET last_synchronized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE channel_id = ?`,
		)
			.bind(ch.channel_id)
			.run();
		const nextPulled = pulled + page.ids.length;
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
