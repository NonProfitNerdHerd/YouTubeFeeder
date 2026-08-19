import type { CategoryRecord, ChannelRecord, InboxItem, InboxWatchFields, WatchlistRecord, WatchedFilter } from '../../src/types';
import { isUncategorizedFilter } from '../../src/lib/categories';
import { meetsWatchThreshold, mergeStoredPlayback } from '../../src/lib/watchProgress';
import { randomToken } from '../auth/crypto';
import {
	countPodcastInbox,
	countUnwatchedPodcastInbox,
	isPodcastEpisodeId,
	listPodcastInbox,
	mergeInboxItems,
} from './podcasts';

export async function listSubscribedChannels(db: D1Database, userId: string): Promise<ChannelRecord[]> {
	const rows = await db
		.prepare(
			`SELECT c.channel_id, c.title, c.description, c.thumbnail_url, c.uploads_playlist_id, p.is_subscribed AS subscribed, c.last_synchronized_at,
				COALESCE(p.follow_in_inbox, 1) AS follow_in_inbox,
				COALESCE(p.max_videos_to_pull, 0) AS max_videos_to_pull
			 FROM channel_prefs p
			 JOIN channels c ON c.channel_id = p.channel_id
			 WHERE p.user_id = ? AND p.is_subscribed = 1
			 ORDER BY c.title COLLATE NOCASE`,
		)
		.bind(userId)
		.all<{
			channel_id: string;
			title: string;
			description: string;
			thumbnail_url: string;
			uploads_playlist_id: string | null;
			subscribed: number;
			last_synchronized_at: string | null;
			follow_in_inbox: number;
			max_videos_to_pull: number;
		}>();

	const tags = await db
		.prepare(`SELECT channel_id, category_id FROM channel_categories WHERE user_id = ?`)
		.bind(userId)
		.all<{ channel_id: string; category_id: string }>();
	const byChannel = new Map<string, string[]>();
	for (const row of tags.results ?? []) {
		const list = byChannel.get(row.channel_id) ?? [];
		list.push(row.category_id);
		byChannel.set(row.channel_id, list);
	}

	const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	const counts = await db
		.prepare(
			`SELECT v.channel_id, COUNT(*) AS n
			 FROM inbox_state i
			 JOIN videos v ON v.video_id = i.video_id
			 WHERE i.user_id = ?
			 AND i.archived = 0
			 AND i.hidden = 0
			 AND (i.snoozed_until IS NULL OR i.snoozed_until <= ${nowExpr})
			 AND NOT EXISTS (
				SELECT 1 FROM watchlist_items wi
				WHERE wi.user_id = i.user_id AND wi.video_id = i.video_id
			 )
			 GROUP BY v.channel_id`,
		)
		.bind(userId)
		.all<{ channel_id: string; n: number }>();
	const countByChannel = new Map<string, number>();
	for (const row of counts.results ?? []) {
		countByChannel.set(row.channel_id, Number(row.n ?? 0));
	}

	return (rows.results ?? []).map((row) => ({
		channelId: row.channel_id,
		title: row.title,
		description: row.description,
		thumbnailUrl: row.thumbnail_url,
		uploadsPlaylistId: row.uploads_playlist_id,
		subscribed: row.subscribed === 1,
		lastSynchronizedAt: row.last_synchronized_at,
		followInInbox: row.follow_in_inbox === 1,
		maxVideosToPull: row.max_videos_to_pull,
		inboxVideoCount: countByChannel.get(row.channel_id) ?? 0,
		categoryIds: byChannel.get(row.channel_id) ?? [],
	}));
}

function watchedClause(filter: WatchedFilter): string {
	if (filter === 'watched') return 'AND i.watched_at IS NOT NULL';
	if (filter === 'unwatched') return 'AND i.watched_at IS NULL';
	return '';
}

function inboxWhere(
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' = 'inbox',
	watched: WatchedFilter = 'all',
) {
	const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	const hiddenFilter = view === 'deleted' ? 'AND i.hidden = 1' : 'AND i.hidden = 0';
	const snoozeFilter =
		view === 'deleted' || view === 'watchlist'
			? ''
			: view === 'snoozed'
				? `AND i.snoozed_until IS NOT NULL AND i.snoozed_until > ${nowExpr}`
				: `AND (i.snoozed_until IS NULL OR i.snoozed_until <= ${nowExpr})`;
	const watchFilter =
		view === 'watchlist'
			? 'AND i.video_id IN (SELECT video_id FROM watchlist_items WHERE user_id = ? AND watchlist_id = ?)'
			: view === 'deleted'
				? ''
				: 'AND NOT EXISTS (SELECT 1 FROM watchlist_items wi WHERE wi.user_id = i.user_id AND wi.video_id = i.video_id)';
	return `
		FROM inbox_state i
		JOIN videos v ON v.video_id = i.video_id
		JOIN channels c ON c.channel_id = v.channel_id
		JOIN channel_prefs p ON p.user_id = i.user_id AND p.channel_id = v.channel_id AND p.is_subscribed = 1
		WHERE i.user_id = ? AND i.archived = 0
		${hiddenFilter}
		${snoozeFilter}
		${watchFilter}
		${watchedClause(watched)}
		${channelId ? 'AND v.channel_id = ?' : ''}
		${
			isUncategorizedFilter(categoryId)
				? 'AND NOT EXISTS (SELECT 1 FROM channel_categories cc WHERE cc.user_id = ? AND cc.channel_id = v.channel_id)'
				: categoryId
					? 'AND v.channel_id IN (SELECT channel_id FROM channel_categories WHERE user_id = ? AND category_id = ?)'
					: ''
		}
	`;
}

function inboxBinds(
	userId: string,
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' = 'inbox',
	watchlistId: string | null = null,
): string[] {
	const binds: string[] = [userId];
	if (view === 'watchlist' && watchlistId) binds.push(userId, watchlistId);
	if (channelId) binds.push(channelId);
	if (isUncategorizedFilter(categoryId)) binds.push(userId);
	else if (categoryId) binds.push(userId, categoryId);
	return binds;
}

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const INBOX_SORT_AT = `COALESCE(v.published_at, v.scheduled_start_at, i.first_seen_at)`;
export const INBOX_PAGE_LIMIT = 200;

export async function countInbox(
	db: D1Database,
	userId: string,
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' = 'inbox',
	watchlistId: string | null = null,
): Promise<number> {
	if (view === 'watchlist' && !watchlistId) return 0;
	const row = await db
		.prepare(`SELECT COUNT(*) AS n ${inboxWhere(channelId, categoryId, view, 'all')}`)
		.bind(...inboxBinds(userId, channelId, categoryId, view, watchlistId))
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

export async function countUnwatchedInbox(
	db: D1Database,
	userId: string,
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' = 'inbox',
	watchlistId: string | null = null,
): Promise<number> {
	if (view === 'watchlist' && !watchlistId) return 0;
	const row = await db
		.prepare(`SELECT COUNT(*) AS n ${inboxWhere(channelId, categoryId, view, 'unwatched')}`)
		.bind(...inboxBinds(userId, channelId, categoryId, view, watchlistId))
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

export async function listInbox(
	db: D1Database,
	userId: string,
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' = 'inbox',
	watchlistId: string | null = null,
	watched: WatchedFilter = 'all',
	beforeId: string | null = null,
): Promise<InboxItem[]> {
	if (view === 'watchlist' && !watchlistId) return [];
	let cursorSql = '';
	const cursorBinds: string[] = [];
	if (beforeId && VIDEO_ID.test(beforeId)) {
		const head = await db
			.prepare(
				`SELECT ${INBOX_SORT_AT} AS sort_at
				 FROM inbox_state i
				 JOIN videos v ON v.video_id = i.video_id
				 WHERE i.user_id = ? AND i.video_id = ?`,
			)
			.bind(userId, beforeId)
			.first<{ sort_at: string | null }>();
		if (!head?.sort_at) return [];
		cursorSql = `AND (${INBOX_SORT_AT} < ? OR (${INBOX_SORT_AT} = ? AND v.video_id < ?))`;
		cursorBinds.push(head.sort_at, head.sort_at, beforeId);
	}
	const sql = `
		SELECT
			v.video_id, v.channel_id, c.title AS channel_title, c.thumbnail_url AS channel_thumbnail,
			v.title, v.description_excerpt, v.thumbnail_medium, v.thumbnail_high, v.published_at,
			v.scheduled_start_at, v.actual_start_at, v.actual_end_at, v.duration_seconds,
			v.content_type, v.livestream_status, v.embeddable,
			i.unread, i.starred, i.archived, i.hidden, i.first_seen_at, i.snoozed_until, COALESCE(i.notes, '') AS notes,
			i.watched_at, COALESCE(i.playback_seconds, 0) AS playback_seconds,
			COALESCE(i.last_position_seconds, 0) AS last_position_seconds, i.watch_updated_at
		${inboxWhere(channelId, categoryId, view, watched)}
		${cursorSql}
		ORDER BY ${INBOX_SORT_AT} DESC, v.video_id DESC
		LIMIT ${INBOX_PAGE_LIMIT}
	`;
	const binds = [...inboxBinds(userId, channelId, categoryId, view, watchlistId), ...cursorBinds];
	const rows = await db
		.prepare(sql)
		.bind(...binds)
		.all<{
			video_id: string;
			channel_id: string;
			channel_title: string;
			channel_thumbnail: string;
			title: string;
			description_excerpt: string;
			thumbnail_medium: string;
			thumbnail_high: string;
			published_at: string | null;
			scheduled_start_at: string | null;
			actual_start_at: string | null;
			actual_end_at: string | null;
			duration_seconds: number | null;
			content_type: InboxItem['contentType'];
			livestream_status: InboxItem['livestreamStatus'];
			embeddable: number;
			unread: number;
			starred: number;
			archived: number;
			hidden: number;
			first_seen_at: string;
			snoozed_until: string | null;
			notes: string;
			watched_at: string | null;
			playback_seconds: number;
			last_position_seconds: number;
			watch_updated_at: string | null;
		}>();
	return (rows.results ?? []).map((row) => ({
		videoId: row.video_id,
		mediaKind: 'youtube' as const,
		channelId: row.channel_id,
		channelTitle: row.channel_title,
		channelThumbnailUrl: row.channel_thumbnail,
		title: row.title,
		descriptionExcerpt: row.description_excerpt,
		thumbnailUrl: row.thumbnail_high || row.thumbnail_medium,
		publishedAt: row.published_at,
		scheduledStartAt: row.scheduled_start_at,
		actualStartAt: row.actual_start_at,
		actualEndAt: row.actual_end_at,
		durationSeconds: row.duration_seconds,
		contentType: row.content_type,
		livestreamStatus: row.livestream_status,
		embeddable: row.embeddable === 1,
		unread: row.unread === 1,
		starred: row.starred === 1,
		archived: row.archived === 1,
		hidden: row.hidden === 1,
		firstSeenAt: row.first_seen_at,
		snoozedUntil: row.snoozed_until,
		notes: row.notes ?? '',
		watchedAt: row.watched_at,
		playbackSeconds: Number(row.playback_seconds ?? 0),
		lastPositionSeconds: Number(row.last_position_seconds ?? 0),
		watchUpdatedAt: row.watch_updated_at,
	}));
}

function includePodcastsInInbox(
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist',
): view is 'inbox' | 'snoozed' | 'deleted' {
	return !channelId && !categoryId && view !== 'watchlist';
}

export async function listInboxMerged(
	db: D1Database,
	userId: string,
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' = 'inbox',
	watchlistId: string | null = null,
	watched: WatchedFilter = 'all',
	beforeId: string | null = null,
): Promise<InboxItem[]> {
	const youtube = await listInbox(db, userId, channelId, categoryId, view, watchlistId, watched, beforeId);
	if (!includePodcastsInInbox(channelId, categoryId, view)) return youtube;
	const podcastView = view === 'inbox' || view === 'snoozed' || view === 'deleted' ? view : 'inbox';
	const podcastBefore = beforeId && isPodcastEpisodeId(beforeId) ? beforeId : null;
	const podcasts = await listPodcastInbox(db, userId, podcastView, watched, podcastBefore, INBOX_PAGE_LIMIT);
	if (beforeId && !isPodcastEpisodeId(beforeId)) return youtube;
	return mergeInboxItems(youtube, podcasts, INBOX_PAGE_LIMIT);
}

export async function hideInboxItem(db: D1Database, userId: string, videoId: string): Promise<boolean> {
	if (!VIDEO_ID.test(videoId)) return false;
	const result = await db
		.prepare(
			`UPDATE inbox_state SET hidden = 1, snoozed_until = NULL WHERE user_id = ? AND video_id = ?`,
		)
		.bind(userId, videoId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function snoozeInboxItem(db: D1Database, userId: string, videoId: string, untilIso: string): Promise<boolean> {
	if (!VIDEO_ID.test(videoId)) return false;
	const result = await db
		.prepare(
			`UPDATE inbox_state SET hidden = 0, snoozed_until = ? WHERE user_id = ? AND video_id = ? AND hidden = 0`,
		)
		.bind(untilIso, userId, videoId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function unsnoozeInboxItem(db: D1Database, userId: string, videoId: string): Promise<boolean> {
	if (!VIDEO_ID.test(videoId)) return false;
	const result = await db
		.prepare(`UPDATE inbox_state SET snoozed_until = NULL WHERE user_id = ? AND video_id = ?`)
		.bind(userId, videoId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function restoreInboxItem(db: D1Database, userId: string, videoId: string): Promise<boolean> {
	if (!VIDEO_ID.test(videoId)) return false;
	const result = await db
		.prepare(`UPDATE inbox_state SET hidden = 0, snoozed_until = NULL WHERE user_id = ? AND video_id = ?`)
		.bind(userId, videoId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function updateInboxNotes(db: D1Database, userId: string, videoId: string, notes: string): Promise<boolean> {
	if (!VIDEO_ID.test(videoId)) return false;
	const result = await db
		.prepare(`UPDATE inbox_state SET notes = ? WHERE user_id = ? AND video_id = ?`)
		.bind(notes.slice(0, 4000), userId, videoId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

const nowSql = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function clampPlayback(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.min(value, 86_400);
}

async function readInboxWatch(
	db: D1Database,
	userId: string,
	videoId: string,
): Promise<(InboxWatchFields & { durationSeconds: number | null }) | null> {
	const row = await db
		.prepare(
			`SELECT i.watched_at, COALESCE(i.playback_seconds, 0) AS playback_seconds,
				COALESCE(i.last_position_seconds, 0) AS last_position_seconds, i.watch_updated_at,
				v.duration_seconds
			 FROM inbox_state i
			 LEFT JOIN videos v ON v.video_id = i.video_id
			 WHERE i.user_id = ? AND i.video_id = ?`,
		)
		.bind(userId, videoId)
		.first<{
			watched_at: string | null;
			playback_seconds: number;
			last_position_seconds: number;
			watch_updated_at: string | null;
			duration_seconds: number | null;
		}>();
	if (!row) return null;
	return {
		watchedAt: row.watched_at,
		playbackSeconds: Number(row.playback_seconds ?? 0),
		lastPositionSeconds: Number(row.last_position_seconds ?? 0),
		watchUpdatedAt: row.watch_updated_at,
		durationSeconds: row.duration_seconds,
	};
}

async function writeInboxWatch(
	db: D1Database,
	userId: string,
	videoId: string,
	fields: { playbackSeconds: number; lastPositionSeconds: number; watchedAt: string | null },
): Promise<InboxWatchFields | null> {
	await db
		.prepare(
			`UPDATE inbox_state
			 SET playback_seconds = ?,
			     last_position_seconds = ?,
			     watched_at = ?,
			     watch_updated_at = ${nowSql}
			 WHERE user_id = ? AND video_id = ?`,
		)
		.bind(fields.playbackSeconds, fields.lastPositionSeconds, fields.watchedAt, userId, videoId)
		.run();
	const next = await readInboxWatch(db, userId, videoId);
	if (!next) return null;
	return {
		watchedAt: next.watchedAt,
		playbackSeconds: next.playbackSeconds,
		lastPositionSeconds: next.lastPositionSeconds,
		watchUpdatedAt: next.watchUpdatedAt,
	};
}

export async function applyInboxProgress(
	db: D1Database,
	userId: string,
	videoId: string,
	input: { playbackSeconds: number; lastPositionSeconds?: number; ended?: boolean },
): Promise<InboxWatchFields | null> {
	if (!VIDEO_ID.test(videoId)) return null;
	const current = await readInboxWatch(db, userId, videoId);
	if (!current) return null;
	const playbackSeconds = mergeStoredPlayback(current.playbackSeconds, clampPlayback(input.playbackSeconds));
	const lastPositionSeconds =
		input.lastPositionSeconds != null && Number.isFinite(input.lastPositionSeconds)
			? clampPlayback(input.lastPositionSeconds)
			: current.lastPositionSeconds;
	const ended = Boolean(input.ended);
	const watchedAt =
		current.watchedAt ??
		(meetsWatchThreshold(playbackSeconds, current.durationSeconds, ended) ? new Date().toISOString() : null);
	return writeInboxWatch(db, userId, videoId, { playbackSeconds, lastPositionSeconds, watchedAt });
}

export async function markInboxWatched(db: D1Database, userId: string, videoId: string): Promise<InboxWatchFields | null> {
	if (!VIDEO_ID.test(videoId)) return null;
	const current = await readInboxWatch(db, userId, videoId);
	if (!current) return null;
	const watchedAt = current.watchedAt ?? new Date().toISOString();
	return writeInboxWatch(db, userId, videoId, {
		playbackSeconds: current.playbackSeconds,
		lastPositionSeconds: current.lastPositionSeconds,
		watchedAt,
	});
}

export async function unwatchInboxItem(db: D1Database, userId: string, videoId: string): Promise<InboxWatchFields | null> {
	if (!VIDEO_ID.test(videoId)) return null;
	const current = await readInboxWatch(db, userId, videoId);
	if (!current) return null;
	return writeInboxWatch(db, userId, videoId, { playbackSeconds: 0, lastPositionSeconds: 0, watchedAt: null });
}

export async function watchAllInbox(
	db: D1Database,
	userId: string,
	channelId: string | null,
	categoryId: string | null,
	view: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' = 'inbox',
	watchlistId: string | null = null,
	watched: WatchedFilter = 'all',
): Promise<number> {
	if (view === 'watchlist' && !watchlistId) return 0;
	const result = await db
		.prepare(
			`UPDATE inbox_state
			 SET watched_at = COALESCE(watched_at, ${nowSql}),
			     watch_updated_at = ${nowSql}
			 WHERE rowid IN (
				SELECT i.rowid ${inboxWhere(channelId, categoryId, view, watched)}
			 )`,
		)
		.bind(...inboxBinds(userId, channelId, categoryId, view, watchlistId))
		.run();
	return Number(result.meta.changes ?? 0);
}

export async function lastSyncAt(db: D1Database, userId: string): Promise<string | null> {
	const row = await db
		.prepare(`SELECT started_at FROM sync_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1`)
		.bind(userId)
		.first<{ started_at: string }>();
	return row?.started_at ?? null;
}

export async function newestInboxPublishedAt(db: D1Database, userId: string): Promise<string | null> {
	const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	const row = await db
		.prepare(
			`SELECT MAX(COALESCE(v.published_at, v.scheduled_start_at, i.first_seen_at)) AS newest
			 FROM inbox_state i
			 JOIN videos v ON v.video_id = i.video_id
			 WHERE i.user_id = ?
			 AND i.archived = 0
			 AND i.hidden = 0
			 AND (i.snoozed_until IS NULL OR i.snoozed_until <= ${nowExpr})`,
		)
		.bind(userId)
		.first<{ newest: string | null }>();
	return row?.newest ?? null;
}

export async function listCategories(db: D1Database, userId: string): Promise<CategoryRecord[]> {
	const rows = await db
		.prepare(`SELECT id, name FROM categories WHERE user_id = ? ORDER BY name COLLATE NOCASE`)
		.bind(userId)
		.all<{ id: string; name: string }>();
	return rows.results ?? [];
}

export async function createCategory(db: D1Database, userId: string, name: string): Promise<CategoryRecord> {
	const id = randomToken(12);
	const trimmed = name.trim().slice(0, 80);
	if (!trimmed) throw new Error('invalid_name');
	await db.prepare(`INSERT INTO categories (id, user_id, name) VALUES (?, ?, ?)`).bind(id, userId, trimmed).run();
	return { id, name: trimmed };
}

export async function renameCategory(db: D1Database, userId: string, id: string, name: string): Promise<CategoryRecord> {
	const trimmed = name.trim().slice(0, 80);
	if (!trimmed) throw new Error('invalid_name');
	const result = await db
		.prepare(`UPDATE categories SET name = ? WHERE user_id = ? AND id = ?`)
		.bind(trimmed, userId, id)
		.run();
	if (!result.meta.changes) throw new Error('not_found');
	return { id, name: trimmed };
}

export async function deleteCategory(db: D1Database, userId: string, id: string): Promise<void> {
	const linked = await db
		.prepare(`SELECT COUNT(*) AS n FROM channel_categories WHERE user_id = ? AND category_id = ?`)
		.bind(userId, id)
		.first<{ n: number }>();
	if ((linked?.n ?? 0) > 0) throw new Error('in_use');
	await db.prepare(`DELETE FROM categories WHERE user_id = ? AND id = ?`).bind(userId, id).run();
}

export async function listWatchlists(db: D1Database, userId: string): Promise<WatchlistRecord[]> {
	const rows = await db
		.prepare(
			`SELECT w.id, w.name, COUNT(i.video_id) AS video_count
			 FROM watchlists w
			 LEFT JOIN watchlist_items i ON i.user_id = w.user_id AND i.watchlist_id = w.id
			 WHERE w.user_id = ?
			 GROUP BY w.id, w.name
			 ORDER BY w.name COLLATE NOCASE`,
		)
		.bind(userId)
		.all<{ id: string; name: string; video_count: number }>();
	return (rows.results ?? []).map((row) => ({ id: row.id, name: row.name, videoCount: row.video_count }));
}

async function watchlistNameTaken(db: D1Database, userId: string, name: string, exceptId?: string): Promise<boolean> {
	const row = exceptId
		? await db
				.prepare(`SELECT id FROM watchlists WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?`)
				.bind(userId, name, exceptId)
				.first()
		: await db.prepare(`SELECT id FROM watchlists WHERE user_id = ? AND name = ? COLLATE NOCASE`).bind(userId, name).first();
	return Boolean(row);
}

export async function createWatchlist(db: D1Database, userId: string, name: string): Promise<WatchlistRecord> {
	const id = randomToken(12);
	const trimmed = name.trim().slice(0, 80);
	if (!trimmed) throw new Error('invalid_name');
	if (await watchlistNameTaken(db, userId, trimmed)) throw new Error('duplicate_name');
	await db.prepare(`INSERT INTO watchlists (id, user_id, name) VALUES (?, ?, ?)`).bind(id, userId, trimmed).run();
	return { id, name: trimmed, videoCount: 0 };
}

export async function renameWatchlist(db: D1Database, userId: string, id: string, name: string): Promise<WatchlistRecord> {
	const trimmed = name.trim().slice(0, 80);
	if (!trimmed) throw new Error('invalid_name');
	const existing = await db
		.prepare(
			`SELECT w.id, w.name, COUNT(i.video_id) AS video_count
			 FROM watchlists w
			 LEFT JOIN watchlist_items i ON i.user_id = w.user_id AND i.watchlist_id = w.id
			 WHERE w.user_id = ? AND w.id = ?
			 GROUP BY w.id, w.name`,
		)
		.bind(userId, id)
		.first<{ id: string; name: string; video_count: number }>();
	if (!existing) throw new Error('not_found');
	if (await watchlistNameTaken(db, userId, trimmed, id)) throw new Error('duplicate_name');
	await db.prepare(`UPDATE watchlists SET name = ? WHERE user_id = ? AND id = ?`).bind(trimmed, userId, id).run();
	return { id, name: trimmed, videoCount: existing.video_count };
}

export async function deleteWatchlist(db: D1Database, userId: string, id: string): Promise<void> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM watchlist_items WHERE user_id = ? AND watchlist_id = ?`)
		.bind(userId, id)
		.first<{ n: number }>();
	if ((row?.n ?? 0) > 0) throw new Error('not_empty');
	await db.prepare(`DELETE FROM watchlists WHERE user_id = ? AND id = ?`).bind(userId, id).run();
}

export async function addToWatchlist(db: D1Database, userId: string, watchlistId: string, videoId: string): Promise<boolean> {
	if (!VIDEO_ID.test(videoId)) return false;
	const list = await db
		.prepare(`SELECT id FROM watchlists WHERE user_id = ? AND id = ?`)
		.bind(userId, watchlistId)
		.first();
	if (!list) return false;
	await db
		.prepare(
			`INSERT OR IGNORE INTO inbox_state (user_id, video_id, unread, starred, archived, hidden) VALUES (?, ?, 1, 0, 0, 0)`,
		)
		.bind(userId, videoId)
		.run();
	await db
		.prepare(`INSERT OR IGNORE INTO watchlist_items (user_id, watchlist_id, video_id) VALUES (?, ?, ?)`)
		.bind(userId, watchlistId, videoId)
		.run();
	return true;
}

export async function removeFromWatchlist(db: D1Database, userId: string, watchlistId: string, videoId: string): Promise<void> {
	await db
		.prepare(`DELETE FROM watchlist_items WHERE user_id = ? AND watchlist_id = ? AND video_id = ?`)
		.bind(userId, watchlistId, videoId)
		.run();
}

export async function updateChannelPrefs(
	db: D1Database,
	userId: string,
	channelId: string,
	input: { followInInbox: boolean; maxVideosToPull: number; categoryIds: string[] },
): Promise<void> {
	const maxVideos = Math.max(0, Math.min(500, Math.floor(input.maxVideosToPull)));
	await db
		.prepare(
			`INSERT INTO channel_prefs (user_id, channel_id, follow_in_inbox, max_videos_to_pull, is_subscribed)
			 VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT(user_id, channel_id) DO UPDATE SET
				follow_in_inbox = excluded.follow_in_inbox,
				max_videos_to_pull = excluded.max_videos_to_pull`,
		)
		.bind(userId, channelId, input.followInInbox ? 1 : 0, maxVideos)
		.run();
	await db.prepare(`DELETE FROM channel_categories WHERE user_id = ? AND channel_id = ?`).bind(userId, channelId).run();
	for (const categoryId of input.categoryIds) {
		await db
			.prepare(`INSERT OR IGNORE INTO channel_categories (user_id, channel_id, category_id) VALUES (?, ?, ?)`)
			.bind(userId, channelId, categoryId)
			.run();
	}
}
