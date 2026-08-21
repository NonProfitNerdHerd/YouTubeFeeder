import type { DiscoverFilter, DiscoverSearchResponse, DiscoveryResult } from '../../src/types/discover';
import { listPodcastSubscriptions, subscribePodcast } from '../db/podcasts';
import { discoverBrowse } from './discoverBrowse';
import { followYoutubeChannel } from './discoverFollow';
import { getPodcastFeedById } from './discover/podcastIndex';
import { searchMixedDiscoverAll } from './discover/provider/mixedDiscoverSearch';
import { normalizePodcastFeedUrl } from './discover/provider/podcastFeedUrl';
import { searchPodcastsDiscover } from './discover/provider/typedPodcastDiscoverSearch';
import { normalizeDiscoverQuery, searchYoutubeDiscover } from './discover/youtube';
import { catchUpPodcast } from './podcastCatchup';
import { fetchAndParseRss } from './discover/rss';

function parseFilter(raw: string | null): DiscoverFilter {
	if (raw === 'podcasts' || raw === 'youtube' || raw === 'live') return raw;
	return 'all';
}

export async function discoverSearch(
	env: Env,
	userId: string,
	query: string,
	filterParam: string | null,
	opts: { offset?: number; limit?: number; includeDebug?: boolean } = {},
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

	// All: concurrent YouTube + podcast → mixed relevance rank (Phase 2).
	if (filter === 'all') {
		return searchMixedDiscoverAll(env, userId, query, {
			offset,
			limit: opts.limit,
			includeDebug: opts.includeDebug,
		});
	}

	const warnings: DiscoverSearchResponse['warnings'] = [];
	let results: DiscoveryResult[] = [];
	let cached = false;
	let searchedAt = new Date().toISOString();
	let hasMore = false;
	let nextOffset = offset;

	// Podcasts-only: never call Brave / YouTube.
	if (filter === 'podcasts') {
		try {
			const podcasts = await searchPodcastsDiscover(env, userId, query, {
				limit: opts.limit,
				offset,
			});
			results = podcasts.results;
			cached = podcasts.cached;
			searchedAt = podcasts.searchedAt;
			hasMore = podcasts.hasMore;
			nextOffset = podcasts.nextOffset;
			if (podcasts.warning) {
				warnings.push({ provider: 'podcast', message: podcasts.warning });
			}
		} catch (err: unknown) {
			warnings.push({
				provider: 'podcast',
				message: err instanceof Error ? err.message : 'Podcast search failed.',
			});
		}
		return {
			query: query.trim(),
			filter,
			results,
			warnings,
			cached,
			searchedAt,
			hasMore,
			nextOffset,
		};
	}

	// YouTube-only (and live): never call podcast discovery provider.
	if (filter === 'youtube' || filter === 'live') {
		try {
			const youtube = await searchYoutubeDiscover(env, userId, query, new Date(), {
				offset,
				limit: opts.limit,
			});
			results =
				filter === 'live' ? youtube.results.filter((r) => r.type === 'live') : youtube.results;
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
		return {
			query: query.trim(),
			filter,
			results,
			warnings,
			cached,
			searchedAt,
			hasMore,
			nextOffset,
		};
	}

	return {
		query: query.trim(),
		filter,
		results: [],
		warnings,
		cached: false,
		searchedAt: new Date().toISOString(),
		hasMore: false,
		nextOffset: offset,
	};
}

/** Validate feed parses as podcast RSS before creating a subscription. */
export async function validatePodcastRssFeed(feedUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const parsed = await fetchAndParseRss(feedUrl, {});
		if (!parsed.items.length) {
			return { ok: false, error: 'Podcast feed returned no episodes.' };
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : 'Podcast feed could not be fetched.',
		};
	}
}

export async function discoverSubscribePodcast(
	env: Env,
	userId: string,
	body: {
		externalFeedId?: number;
		feedUrl?: string;
		title?: string;
		publisher?: string;
		description?: string;
		imageUrl?: string;
		providerExternalId?: string;
	},
): Promise<{ ok: true; podcastId: string; episodesAdded: number; created: boolean }> {
	let feedId = body.externalFeedId;
	let feedUrl = body.feedUrl?.trim() ?? '';
	let title = body.title?.trim() ?? '';
	let publisher = body.publisher?.trim() ?? '';
	let description = body.description?.trim() ?? '';
	let imageUrl = body.imageUrl?.trim() ?? '';
	let providerExternalId = body.providerExternalId?.trim() || (feedId != null ? String(feedId) : '');

	if (feedId && (!feedUrl || !title) && env.PODCAST_INDEX_KEY) {
		const feed = await getPodcastFeedById(env, feedId);
		if (feed) {
			feedUrl = feed.url || feedUrl;
			title = feed.title || title;
			publisher = feed.author || publisher;
			description = feed.description || description;
			imageUrl = feed.image || imageUrl;
			providerExternalId = providerExternalId || String(feed.id);
		}
	}

	if (!feedUrl || !title) throw new Error('invalid_subscribe');

	const feedUrlNormalized = normalizePodcastFeedUrl(feedUrl);
	if (!feedUrlNormalized) throw new Error('invalid_feed_url');

	const validation = await validatePodcastRssFeed(feedUrl);
	if (!validation.ok) {
		throw new Error(`invalid_podcast_feed:${validation.error}`);
	}

	const { podcastId, created } = await subscribePodcast(env.DB, userId, {
		feedUrl,
		feedUrlNormalized,
		title,
		publisher,
		description,
		imageUrl,
		providerExternalId: providerExternalId || undefined,
		externalFeedId: feedId,
	});

	const catchup = await catchUpPodcast(env, userId, podcastId, 0);
	return { ok: true, podcastId, episodesAdded: catchup.episodesAdded, created };
}

export async function listSubscriptions(env: Env, userId: string) {
	const podcasts = await listPodcastSubscriptions(env.DB, userId);
	return { podcasts };
}

export { discoverBrowse, followYoutubeChannel };
