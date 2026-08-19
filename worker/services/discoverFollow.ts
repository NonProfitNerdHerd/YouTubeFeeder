import { enqueueHubSubscriptions, unsubscribeIfOrphaned } from './websub';
import { createYoutubeApiKeyClient, fetchUploadsPlaylistIds, YoutubeApiError } from './youtube';

export interface FollowYoutubeInput {
	channelId: string;
	title?: string;
	description?: string;
	thumbnailUrl?: string;
}

export async function followYoutubeChannel(
	env: Env,
	userId: string,
	input: FollowYoutubeInput,
): Promise<{ ok: true; channelId: string; created: boolean; alreadyFollowing: boolean }> {
	const channelId = input.channelId.trim();
	if (!channelId) throw new Error('invalid_channel');

	const existing = await env.DB.prepare(
		`SELECT is_subscribed FROM channel_prefs WHERE user_id = ? AND channel_id = ? AND is_subscribed = 1`,
	)
		.bind(userId, channelId)
		.first<{ is_subscribed: number }>();
	if (existing) {
		return { ok: true, channelId, created: false, alreadyFollowing: true };
	}

	const title = input.title?.trim() || 'YouTube channel';
	const description = (input.description?.trim() ?? '').slice(0, 500);
	const thumbnailUrl = input.thumbnailUrl?.trim() ?? '';
	const now = new Date().toISOString();

	await env.DB.prepare(
		`INSERT INTO channels (channel_id, title, description, thumbnail_url)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(channel_id) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			thumbnail_url = CASE WHEN excluded.thumbnail_url != '' THEN excluded.thumbnail_url ELSE channels.thumbnail_url END`,
	)
		.bind(channelId, title, description, thumbnailUrl)
		.run();

	await env.DB.prepare(
		`INSERT INTO channel_prefs (
			user_id, channel_id, follow_in_inbox, max_videos_to_pull, is_subscribed,
			subscription_seen_at, newest_seen_published_at, follow_source
		) VALUES (?, ?, 1, 0, 1, ?, ?, 'discover')
		ON CONFLICT(user_id, channel_id) DO UPDATE SET
			is_subscribed = 1,
			follow_in_inbox = 1,
			subscription_seen_at = excluded.subscription_seen_at,
			newest_seen_published_at = excluded.newest_seen_published_at,
			follow_source = 'discover',
			unsubscribed_at = NULL`,
	)
		.bind(userId, channelId, now, now)
		.run();

	await enqueueHubSubscriptions(env, [channelId]);

	const row = await env.DB.prepare(`SELECT uploads_playlist_id FROM channels WHERE channel_id = ?`)
		.bind(channelId)
		.first<{ uploads_playlist_id: string | null }>();

	if (!row?.uploads_playlist_id && env.YOUTUBE_API_KEY) {
		try {
			const yt = createYoutubeApiKeyClient(env.YOUTUBE_API_KEY);
			const found = await fetchUploadsPlaylistIds(yt, [channelId]);
			const playlistId = found.get(channelId);
			if (playlistId) {
				await env.DB.prepare(`UPDATE channels SET uploads_playlist_id = ? WHERE channel_id = ?`)
					.bind(playlistId, channelId)
					.run();
			}
		} catch (error) {
			if (error instanceof YoutubeApiError && error.isGlobalFatal) throw error;
		}
	}

	return { ok: true, channelId, created: true, alreadyFollowing: false };
}

export async function unfollowYoutubeChannel(
	env: Env,
	userId: string,
	channelId: string,
): Promise<{ ok: true; channelId: string; wasFollowing: boolean }> {
	const id = channelId.trim();
	if (!id) throw new Error('invalid_channel');

	const existing = await env.DB.prepare(
		`SELECT is_subscribed FROM channel_prefs WHERE user_id = ? AND channel_id = ? AND is_subscribed = 1`,
	)
		.bind(userId, id)
		.first<{ is_subscribed: number }>();
	if (!existing) {
		return { ok: true, channelId: id, wasFollowing: false };
	}

	const now = new Date().toISOString();
	await env.DB.prepare(
		`UPDATE channel_prefs SET is_subscribed = 0, unsubscribed_at = ? WHERE user_id = ? AND channel_id = ?`,
	)
		.bind(now, userId, id)
		.run();

	await unsubscribeIfOrphaned(env, [id]);

	return { ok: true, channelId: id, wasFollowing: true };
}
