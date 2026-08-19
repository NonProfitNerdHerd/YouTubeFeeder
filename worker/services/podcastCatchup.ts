import {
	fanoutPodcastEpisode,
	getPodcastSubscription,
	persistPodcastCatchupCursor,
	persistPodcastFeedHeaders,
	upsertPodcastEpisode,
} from '../db/podcasts';
import { fetchAndParseRss } from './discover/rss';

export interface PodcastCatchupResult {
	status: 'ok' | 'error';
	episodesAdded: number;
	pulled: number;
	want: number;
	done: boolean;
	errorSummary: string | null;
}

export async function catchUpPodcast(
	env: Env,
	userId: string,
	podcastId: string,
	pulledOffset = 0,
): Promise<PodcastCatchupResult> {
	const sub = await getPodcastSubscription(env.DB, userId, podcastId);
	if (!sub) {
		return { status: 'error', episodesAdded: 0, pulled: 0, want: 0, done: true, errorSummary: 'Podcast not found.' };
	}

	const want = Math.min(500, Math.max(0, sub.max_episodes_to_pull));
	if (want < 1) {
		return {
			status: 'error',
			episodesAdded: 0,
			pulled: sub.catchup_pulled,
			want: 0,
			done: true,
			errorSummary: 'Set max episodes to pull above 0, then catch up.',
		};
	}

	const alreadyPulled = pulledOffset > 0 ? pulledOffset : sub.catchup_pulled;
	const remaining = Math.max(0, want - alreadyPulled);
	if (remaining < 1) {
		await persistPodcastCatchupCursor(env.DB, userId, podcastId, 0);
		return { status: 'ok', episodesAdded: 0, pulled: alreadyPulled, want, done: true, errorSummary: null };
	}

	try {
		const { items, etag, lastModified } = await fetchAndParseRss(sub.feed_url, {
			etag: sub.etag,
			lastModified: sub.last_modified,
		});
		await persistPodcastFeedHeaders(env.DB, podcastId, etag, lastModified);

		let episodesAdded = 0;
		let pulled = alreadyPulled;
		const slice = items.slice(0, remaining);

		for (const item of slice) {
			if (!item.guid) continue;
			const episodeId = await upsertPodcastEpisode(env.DB, sub.id, sub.feed_url, item);
			if (sub.follow_in_inbox === 1) {
				await fanoutPodcastEpisode(env.DB, userId, episodeId);
			}
			episodesAdded += 1;
			pulled += 1;
		}

		const done = pulled >= want || slice.length < remaining;
		await persistPodcastCatchupCursor(env.DB, userId, podcastId, done ? 0 : pulled);

		return {
			status: 'ok',
			episodesAdded,
			pulled,
			want,
			done,
			errorSummary: null,
		};
	} catch (err: unknown) {
		return {
			status: 'error',
			episodesAdded: 0,
			pulled: alreadyPulled,
			want,
			done: false,
			errorSummary: err instanceof Error ? err.message : 'Catch up failed.',
		};
	}
}
