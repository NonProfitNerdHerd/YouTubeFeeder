import type { DiscoverFilter, DiscoverBrowseResponse, DiscoverSearchResponse, DiscoveryResult } from '../../src/types/discover';
import {
	getSubscribedFeedIds,
	listPodcastSubscriptions,
	mockDiscoveryResults,
	subscribePodcast,
} from '../db/podcasts';
import { discoverBrowse } from './discoverBrowse';
import { followYoutubeChannel } from './discoverFollow';
import { getPodcastFeedById, searchPodcastIndex } from './discover/podcastIndex';
import { normalizeDiscoverQuery, searchYoutubeDiscover } from './discover/youtube';
import { catchUpPodcast } from './podcastCatchup';

function parseFilter(raw: string | null): DiscoverFilter {
	if (raw === 'podcasts' || raw === 'youtube' || raw === 'live') return raw;
	return 'all';
}

function filterResults(results: DiscoveryResult[], filter: DiscoverFilter): DiscoveryResult[] {
	if (filter === 'all') return results;
	if (filter === 'podcasts') return results.filter((r) => r.provider === 'podcast');
	if (filter === 'youtube') return results.filter((r) => r.provider === 'youtube');
	return results.filter((r) => r.type === 'live');
}

function feedsToResults(feeds: Awaited<ReturnType<typeof searchPodcastIndex>>['feeds'], subscribed: Set<number>): DiscoveryResult[] {
	return feeds.map((feed) => ({
		provider: 'podcast' as const,
		type: 'podcast' as const,
		externalId: String(feed.id),
		title: feed.title,
		description: feed.description?.slice(0, 300),
		imageUrl: feed.image,
		publisher: feed.author,
		feedUrl: feed.url,
		subscribed: subscribed.has(feed.id),
	}));
}

function episodesToResults(
	episodes: Awaited<ReturnType<typeof searchPodcastIndex>>['episodes'],
	subscribed: Set<number>,
): DiscoveryResult[] {
	return episodes.map((ep) => ({
		provider: 'podcast' as const,
		type: 'episode' as const,
		externalId: String(ep.id),
		title: ep.title,
		description: ep.description?.slice(0, 300),
		imageUrl: ep.feedImage,
		publisher: ep.feedTitle,
		publishedAt: ep.datePublished ? new Date(ep.datePublished * 1000).toISOString() : null,
		durationSeconds: ep.duration > 0 ? ep.duration : null,
		feedUrl: ep.feedUrl,
		parentExternalId: String(ep.feedId),
		parentTitle: ep.feedTitle,
		subscribed: subscribed.has(ep.feedId),
		playable: Boolean(ep.enclosureUrl),
		watchUrl: ep.enclosureUrl || ep.link,
	}));
}

export async function discoverSearch(
	env: Env,
	userId: string,
	query: string,
	filterParam: string | null,
	opts: { offset?: number; limit?: number } = {},
): Promise<DiscoverSearchResponse> {
	const filter = parseFilter(filterParam);
	const normalized = normalizeDiscoverQuery(query);
	if (!normalized) {
		return {
			query: '',
			filter,
			results: [],
			warnings: [],
			cached: false,
			searchedAt: new Date().toISOString(),
			hasMore: false,
			nextOffset: 0,
		};
	}

	const offset = Math.max(0, Math.floor(opts.offset ?? 0));
	const subscribed = await getSubscribedFeedIds(env.DB, userId);
	const warnings: DiscoverSearchResponse['warnings'] = [];
	let results: DiscoveryResult[] = [];
	let cached = false;
	let searchedAt = new Date().toISOString();
	let hasMore = false;
	let nextOffset = offset;

	// Podcasts only on the first page — "Add more" appends YouTube candidates.
	if (offset === 0 && (filter === 'all' || filter === 'podcasts')) {
		if (env.MOCK_DATA === 'true' || !env.PODCAST_INDEX_KEY) {
			results.push(...mockDiscoveryResults(query, subscribed));
		} else {
			try {
				const { feeds, episodes } = await searchPodcastIndex(env, query, 20);
				results.push(...feedsToResults(feeds, subscribed), ...episodesToResults(episodes, subscribed));
			} catch (err: unknown) {
				warnings.push({
					provider: 'podcast',
					message: err instanceof Error ? err.message : 'Podcast search failed.',
				});
			}
		}
	}

	if (filter === 'all' || filter === 'youtube') {
		try {
			const youtube = await searchYoutubeDiscover(env, userId, query, new Date(), {
				offset,
				limit: opts.limit,
			});
			results.push(...youtube.results);
			cached = youtube.cached;
			searchedAt = youtube.searchedAt;
			hasMore = Boolean(youtube.hasMore);
			nextOffset = youtube.nextOffset ?? offset + youtube.results.length;
			if (youtube.warning) {
				warnings.push({ provider: 'youtube', message: youtube.warning });
			}
		} catch (err: unknown) {
			warnings.push({
				provider: 'youtube',
				message: err instanceof Error ? err.message : 'YouTube search failed.',
			});
		}
	}

	return {
		query: query.trim(),
		filter,
		results: filterResults(results, filter),
		warnings,
		cached,
		searchedAt,
		hasMore,
		nextOffset,
	};
}

export async function discoverSubscribePodcast(
	env: Env,
	userId: string,
	body: { externalFeedId?: number; feedUrl?: string; title?: string; publisher?: string; description?: string; imageUrl?: string },
): Promise<{ ok: true; podcastId: string; episodesAdded: number; created: boolean }> {
	let feedId = body.externalFeedId;
	let feedUrl = body.feedUrl?.trim() ?? '';
	let title = body.title?.trim() ?? '';
	let publisher = body.publisher?.trim() ?? '';
	let description = body.description?.trim() ?? '';
	let imageUrl = body.imageUrl?.trim() ?? '';

	if (feedId && (!feedUrl || !title) && env.PODCAST_INDEX_KEY) {
		const feed = await getPodcastFeedById(env, feedId);
		if (feed) {
			feedUrl = feed.url || feedUrl;
			title = feed.title || title;
			publisher = feed.author || publisher;
			description = feed.description || description;
			imageUrl = feed.image || imageUrl;
		}
	}

	if (!feedId || !feedUrl || !title) throw new Error('invalid_subscribe');

	const { podcastId, created } = await subscribePodcast(env.DB, userId, {
		externalFeedId: feedId,
		feedUrl,
		title,
		publisher,
		description,
		imageUrl,
	});

	const catchup = await catchUpPodcast(env, userId, podcastId, 0);
	return { ok: true, podcastId, episodesAdded: catchup.episodesAdded, created };
}

export async function listSubscriptions(env: Env, userId: string) {
	const podcasts = await listPodcastSubscriptions(env.DB, userId);
	return { podcasts };
}

export { discoverBrowse };
