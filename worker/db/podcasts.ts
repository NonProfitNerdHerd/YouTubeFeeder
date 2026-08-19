import { randomToken } from '../auth/crypto';
import type { DiscoveryResult } from '../../src/types/discover';
import type { InboxItem, PodcastSubscriptionRecord, WatchedFilter } from '../../src/types';

const EPISODE_ID_PREFIX = 'pe_';

export function episodeIdFor(feedUrl: string, guid: string): string {
	const key = `${feedUrl}\0${guid}`;
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
	}
	const hex = hash.toString(16).padStart(8, '0');
	const tail = Array.from(new TextEncoder().encode(key.slice(0, 64)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 24);
	return `${EPISODE_ID_PREFIX}${hex}${tail}`;
}

export function isPodcastEpisodeId(id: string): boolean {
	return id.startsWith(EPISODE_ID_PREFIX);
}

export async function listPodcastSubscriptions(db: D1Database, userId: string): Promise<PodcastSubscriptionRecord[]> {
	const rows = await db
		.prepare(
			`SELECT id, external_feed_id, feed_url, title, publisher, description, image_url,
				follow_in_inbox, max_episodes_to_pull, last_polled_at, subscribed_at
			 FROM podcast_subscriptions
			 WHERE user_id = ?
			 ORDER BY title COLLATE NOCASE`,
		)
		.bind(userId)
		.all<{
			id: string;
			external_feed_id: number;
			feed_url: string;
			title: string;
			publisher: string;
			description: string;
			image_url: string;
			follow_in_inbox: number;
			max_episodes_to_pull: number;
			last_polled_at: string | null;
			subscribed_at: string;
		}>();

	const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	const counts = await db
		.prepare(
			`SELECT e.subscription_id, COUNT(*) AS n
			 FROM podcast_inbox_state i
			 JOIN podcast_episodes e ON e.episode_id = i.episode_id
			 WHERE i.user_id = ?
			 AND i.archived = 0
			 AND i.hidden = 0
			 AND (i.snoozed_until IS NULL OR i.snoozed_until <= ${nowExpr})
			 GROUP BY e.subscription_id`,
		)
		.bind(userId)
		.all<{ subscription_id: string; n: number }>();
	const countBySub = new Map((counts.results ?? []).map((r) => [r.subscription_id, r.n]));

	return (rows.results ?? []).map((row) => ({
		podcastId: row.id,
		externalFeedId: row.external_feed_id,
		feedUrl: row.feed_url,
		title: row.title,
		publisher: row.publisher,
		description: row.description,
		imageUrl: row.image_url,
		followInInbox: row.follow_in_inbox === 1,
		maxEpisodesToPull: row.max_episodes_to_pull,
		inboxEpisodeCount: countBySub.get(row.id) ?? 0,
		lastPolledAt: row.last_polled_at,
		subscribedAt: row.subscribed_at,
	}));
}

export async function getSubscribedFeedIds(db: D1Database, userId: string): Promise<Set<number>> {
	const rows = await db
		.prepare(`SELECT external_feed_id FROM podcast_subscriptions WHERE user_id = ?`)
		.bind(userId)
		.all<{ external_feed_id: number }>();
	return new Set((rows.results ?? []).map((r) => r.external_feed_id));
}

export async function subscribePodcast(
	db: D1Database,
	userId: string,
	input: {
		externalFeedId: number;
		feedUrl: string;
		title: string;
		publisher?: string;
		description?: string;
		imageUrl?: string;
	},
): Promise<{ podcastId: string; created: boolean }> {
	const existing = await db
		.prepare(`SELECT id FROM podcast_subscriptions WHERE user_id = ? AND external_feed_id = ?`)
		.bind(userId, input.externalFeedId)
		.first<{ id: string }>();
	if (existing) return { podcastId: existing.id, created: false };

	const id = randomToken(16);
	await db
		.prepare(
			`INSERT INTO podcast_subscriptions (id, user_id, external_feed_id, feed_url, title, publisher, description, image_url)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			userId,
			input.externalFeedId,
			input.feedUrl,
			input.title.slice(0, 200),
			(input.publisher ?? '').slice(0, 200),
			(input.description ?? '').slice(0, 500),
			(input.imageUrl ?? '').slice(0, 500),
		)
		.run();
	return { podcastId: id, created: true };
}

export async function updatePodcastPrefs(
	db: D1Database,
	userId: string,
	podcastId: string,
	input: { followInInbox: boolean; maxEpisodesToPull: number },
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE podcast_subscriptions
			 SET follow_in_inbox = ?, max_episodes_to_pull = ?
			 WHERE user_id = ? AND id = ?`,
		)
		.bind(input.followInInbox ? 1 : 0, Math.min(500, Math.max(0, input.maxEpisodesToPull)), userId, podcastId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function getPodcastSubscription(
	db: D1Database,
	userId: string,
	podcastId: string,
): Promise<{
	id: string;
	feed_url: string;
	title: string;
	follow_in_inbox: number;
	max_episodes_to_pull: number;
	catchup_pulled: number;
	etag: string | null;
	last_modified: string | null;
} | null> {
	return db
		.prepare(
			`SELECT id, feed_url, title, follow_in_inbox, max_episodes_to_pull, catchup_pulled, etag, last_modified
			 FROM podcast_subscriptions WHERE user_id = ? AND id = ?`,
		)
		.bind(userId, podcastId)
		.first();
}

export async function persistPodcastCatchupCursor(
	db: D1Database,
	userId: string,
	podcastId: string,
	pulled: number,
): Promise<void> {
	await db
		.prepare(`UPDATE podcast_subscriptions SET catchup_pulled = ? WHERE user_id = ? AND id = ?`)
		.bind(pulled, userId, podcastId)
		.run();
}

export async function persistPodcastFeedHeaders(
	db: D1Database,
	podcastId: string,
	etag: string | null,
	lastModified: string | null,
): Promise<void> {
	await db
		.prepare(
			`UPDATE podcast_subscriptions SET last_polled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), etag = ?, last_modified = ? WHERE id = ?`,
		)
		.bind(etag, lastModified, podcastId)
		.run();
}

export interface ParsedRssItem {
	guid: string;
	title: string;
	description: string;
	imageUrl: string;
	audioUrl: string;
	publishedAt: string | null;
	durationSeconds: number | null;
}

export async function upsertPodcastEpisode(
	db: D1Database,
	subscriptionId: string,
	feedUrl: string,
	item: ParsedRssItem,
): Promise<string> {
	const episodeId = episodeIdFor(feedUrl, item.guid);
	await db
		.prepare(
			`INSERT INTO podcast_episodes (episode_id, feed_url, guid, subscription_id, title, description_excerpt, image_url, audio_url, published_at, duration_seconds)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(episode_id) DO UPDATE SET
				title = excluded.title,
				description_excerpt = excluded.description_excerpt,
				image_url = excluded.image_url,
				audio_url = excluded.audio_url,
				published_at = excluded.published_at,
				duration_seconds = excluded.duration_seconds`,
		)
		.bind(
			episodeId,
			feedUrl,
			item.guid,
			subscriptionId,
			item.title.slice(0, 300),
			item.description.slice(0, 500),
			item.imageUrl.slice(0, 500),
			item.audioUrl.slice(0, 500),
			item.publishedAt,
			item.durationSeconds,
		)
		.run();
	return episodeId;
}

export async function fanoutPodcastEpisode(db: D1Database, userId: string, episodeId: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO podcast_inbox_state (user_id, episode_id)
			 VALUES (?, ?)
			 ON CONFLICT(user_id, episode_id) DO NOTHING`,
		)
		.bind(userId, episodeId)
		.run();
}

export async function hidePodcastInboxItem(db: D1Database, userId: string, episodeId: string): Promise<boolean> {
	if (!isPodcastEpisodeId(episodeId)) return false;
	const result = await db
		.prepare(`UPDATE podcast_inbox_state SET hidden = 1, snoozed_until = NULL WHERE user_id = ? AND episode_id = ?`)
		.bind(userId, episodeId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function restorePodcastInboxItem(db: D1Database, userId: string, episodeId: string): Promise<boolean> {
	if (!isPodcastEpisodeId(episodeId)) return false;
	const result = await db
		.prepare(`UPDATE podcast_inbox_state SET hidden = 0 WHERE user_id = ? AND episode_id = ?`)
		.bind(userId, episodeId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function snoozePodcastInboxItem(
	db: D1Database,
	userId: string,
	episodeId: string,
	untilIso: string,
): Promise<boolean> {
	if (!isPodcastEpisodeId(episodeId)) return false;
	const result = await db
		.prepare(
			`UPDATE podcast_inbox_state SET hidden = 0, snoozed_until = ? WHERE user_id = ? AND episode_id = ? AND hidden = 0`,
		)
		.bind(untilIso, userId, episodeId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function unsnoozePodcastInboxItem(db: D1Database, userId: string, episodeId: string): Promise<boolean> {
	if (!isPodcastEpisodeId(episodeId)) return false;
	const result = await db
		.prepare(`UPDATE podcast_inbox_state SET snoozed_until = NULL WHERE user_id = ? AND episode_id = ?`)
		.bind(userId, episodeId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function updatePodcastInboxNotes(
	db: D1Database,
	userId: string,
	episodeId: string,
	notes: string,
): Promise<boolean> {
	if (!isPodcastEpisodeId(episodeId)) return false;
	const result = await db
		.prepare(`UPDATE podcast_inbox_state SET notes = ? WHERE user_id = ? AND episode_id = ?`)
		.bind(notes.slice(0, 4000), userId, episodeId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

const PODCAST_SORT_AT = `COALESCE(e.published_at, i.first_seen_at)`;

function podcastViewFilters(view: 'inbox' | 'snoozed' | 'deleted', watched: WatchedFilter): string {
	const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	const hiddenFilter = view === 'deleted' ? 'AND i.hidden = 1' : 'AND i.hidden = 0';
	const snoozeFilter =
		view === 'deleted'
			? ''
			: view === 'snoozed'
				? `AND i.snoozed_until IS NOT NULL AND i.snoozed_until > ${nowExpr}`
				: `AND (i.snoozed_until IS NULL OR i.snoozed_until <= ${nowExpr})`;
	const watchFilter =
		view === 'deleted'
			? ''
			: watched === 'watched'
				? 'AND i.watched_at IS NOT NULL'
				: watched === 'unwatched'
					? 'AND i.watched_at IS NULL'
					: '';
	return `${hiddenFilter} ${snoozeFilter} ${watchFilter}`;
}

export async function listPodcastInbox(
	db: D1Database,
	userId: string,
	view: 'inbox' | 'snoozed' | 'deleted' = 'inbox',
	watched: WatchedFilter = 'all',
	beforeId: string | null = null,
	limit = 200,
): Promise<InboxItem[]> {
	let cursorSql = '';
	const cursorBinds: string[] = [];
	if (beforeId && isPodcastEpisodeId(beforeId)) {
		const head = await db
			.prepare(
				`SELECT ${PODCAST_SORT_AT} AS sort_at
				 FROM podcast_inbox_state i
				 JOIN podcast_episodes e ON e.episode_id = i.episode_id
				 WHERE i.user_id = ? AND i.episode_id = ?`,
			)
			.bind(userId, beforeId)
			.first<{ sort_at: string | null }>();
		if (!head?.sort_at) return [];
		cursorSql = `AND (${PODCAST_SORT_AT} < ? OR (${PODCAST_SORT_AT} = ? AND e.episode_id < ?))`;
		cursorBinds.push(head.sort_at, head.sort_at, beforeId);
	}

	const sql = `
		SELECT e.episode_id, s.id AS subscription_id, s.title AS podcast_title, s.image_url AS podcast_image,
			e.title, e.description_excerpt, e.image_url, e.audio_url, e.published_at, e.duration_seconds,
			i.unread, i.starred, i.archived, i.hidden, i.first_seen_at, i.snoozed_until, COALESCE(i.notes, '') AS notes,
			i.watched_at, COALESCE(i.playback_seconds, 0) AS playback_seconds,
			COALESCE(i.last_position_seconds, 0) AS last_position_seconds, i.watch_updated_at
		FROM podcast_inbox_state i
		JOIN podcast_episodes e ON e.episode_id = i.episode_id
		JOIN podcast_subscriptions s ON s.id = e.subscription_id AND s.user_id = i.user_id
		WHERE i.user_id = ? AND i.archived = 0
		${podcastViewFilters(view, watched)}
		${cursorSql}
		ORDER BY ${PODCAST_SORT_AT} DESC, e.episode_id DESC
		LIMIT ${limit}
	`;

	const rows = await db
		.prepare(sql)
		.bind(userId, ...cursorBinds)
		.all<{
			episode_id: string;
			subscription_id: string;
			podcast_title: string;
			podcast_image: string;
			title: string;
			description_excerpt: string;
			image_url: string;
			audio_url: string;
			published_at: string | null;
			duration_seconds: number | null;
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
		videoId: row.episode_id,
		mediaKind: 'podcast' as const,
		audioUrl: row.audio_url,
		channelId: row.subscription_id,
		channelTitle: row.podcast_title,
		channelThumbnailUrl: row.podcast_image,
		title: row.title,
		descriptionExcerpt: row.description_excerpt,
		thumbnailUrl: row.image_url || row.podcast_image,
		publishedAt: row.published_at,
		scheduledStartAt: null,
		actualStartAt: null,
		actualEndAt: null,
		durationSeconds: row.duration_seconds,
		contentType: 'video' as const,
		livestreamStatus: 'none' as const,
		embeddable: Boolean(row.audio_url),
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

export async function countPodcastInbox(
	db: D1Database,
	userId: string,
	view: 'inbox' | 'snoozed' | 'deleted' = 'inbox',
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM podcast_inbox_state i
			 JOIN podcast_episodes e ON e.episode_id = i.episode_id
			 JOIN podcast_subscriptions s ON s.id = e.subscription_id AND s.user_id = i.user_id
			 WHERE i.user_id = ? AND i.archived = 0 ${podcastViewFilters(view, 'all')}`,
		)
		.bind(userId)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

export async function countUnwatchedPodcastInbox(
	db: D1Database,
	userId: string,
	view: 'inbox' | 'snoozed' | 'deleted' = 'inbox',
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM podcast_inbox_state i
			 JOIN podcast_episodes e ON e.episode_id = i.episode_id
			 JOIN podcast_subscriptions s ON s.id = e.subscription_id AND s.user_id = i.user_id
			 WHERE i.user_id = ? AND i.archived = 0 ${podcastViewFilters(view, 'unwatched')}`,
		)
		.bind(userId)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

export function mergeInboxItems(youtube: InboxItem[], podcasts: InboxItem[], limit: number): InboxItem[] {
	const merged = [...youtube, ...podcasts];
	merged.sort((a, b) => {
		const at = a.publishedAt || a.firstSeenAt;
		const bt = b.publishedAt || b.firstSeenAt;
		if (at !== bt) return bt.localeCompare(at);
		return b.videoId.localeCompare(a.videoId);
	});
	return merged.slice(0, limit);
}

export function mockDiscoveryResults(query: string, subscribed: Set<number>): DiscoveryResult[] {
	const q = query.toLowerCase();
	if (!q.trim()) return [];
	return [
		{
			provider: 'podcast',
			type: 'podcast',
			externalId: '900001',
			title: `Sample Podcast about ${query}`,
			description: 'A mock podcast for local development.',
			imageUrl: '',
			publisher: 'Mock Publisher',
			feedUrl: 'https://example.com/feed.xml',
			subscribed: subscribed.has(900001),
		},
		{
			provider: 'podcast',
			type: 'episode',
			externalId: 'ep-mock-1',
			title: `Episode: ${query} explained`,
			description: 'Mock episode result.',
			publisher: 'Mock Publisher',
			parentExternalId: '900001',
			parentTitle: `Sample Podcast about ${query}`,
			feedUrl: 'https://example.com/feed.xml',
			subscribed: subscribed.has(900001),
			playable: true,
		},
	];
}
