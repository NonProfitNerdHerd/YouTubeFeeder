import type { DiscoveryResult } from '../../../src/types/discover';
import {
	discoverSearchCacheKey,
	getDiscoverSearchCache,
	putDiscoverSearchCache,
} from '../../db/discoverCache';
import { getSubscribedChannelIds } from '../../db/queries';
import { discoverSearchQuotaStatus } from '../discoverQuota';
import { recordYoutubeCalls } from '../websub';
import { createYoutubeApiKeyClient, type YoutubeClient } from '../youtube';

export function normalizeDiscoverQuery(query: string): string {
	return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface SearchListChannelItem {
	id?: { channelId?: string };
	snippet?: {
		title?: string;
		description?: string;
		channelTitle?: string;
		thumbnails?: { default?: { url?: string }; medium?: { url?: string }; high?: { url?: string } };
	};
}

export function mapChannelSearchItems(items: SearchListChannelItem[]): DiscoveryResult[] {
	const results: DiscoveryResult[] = [];
	for (const item of items) {
		const channelId = item.id?.channelId;
		if (!channelId) continue;
		results.push({
			provider: 'youtube',
			type: 'channel',
			externalId: channelId,
			title: item.snippet?.title ?? 'YouTube channel',
			description: item.snippet?.description?.slice(0, 500),
			imageUrl:
				item.snippet?.thumbnails?.medium?.url ??
				item.snippet?.thumbnails?.default?.url ??
				item.snippet?.thumbnails?.high?.url ??
				'',
			publisher: item.snippet?.channelTitle ?? item.snippet?.title ?? '',
			watchUrl: `https://www.youtube.com/channel/${channelId}`,
		});
	}
	return results;
}

export function overlayYoutubeSubscribed(results: DiscoveryResult[], subscribed: Set<string>): DiscoveryResult[] {
	return results.map((row) => ({
		...row,
		subscribed: subscribed.has(row.externalId),
	}));
}

export async function searchYoutubeChannels(
	yt: YoutubeClient,
	query: string,
	pageToken?: string,
): Promise<{ results: DiscoveryResult[]; nextPageToken: string | null }> {
	const page = await yt.getJson<{ items?: SearchListChannelItem[]; nextPageToken?: string }>('search', {
		part: 'snippet',
		q: query,
		type: 'channel',
		maxResults: '50',
		...(pageToken ? { pageToken } : {}),
	});
	return {
		results: mapChannelSearchItems(page.items ?? []),
		nextPageToken: page.nextPageToken ?? null,
	};
}

export interface YoutubeDiscoverSearchResult {
	results: DiscoveryResult[];
	cached: boolean;
	searchedAt: string;
	warning?: string;
}

export async function searchYoutubeDiscover(
	env: Env,
	userId: string,
	query: string,
	now = new Date(),
): Promise<YoutubeDiscoverSearchResult> {
	const normalized = normalizeDiscoverQuery(query);
	if (!normalized) {
		return { results: [], cached: false, searchedAt: now.toISOString() };
	}

	const cacheKey = discoverSearchCacheKey('youtube', normalized);
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const cached = await getDiscoverSearchCache(env.DB, cacheKey, now);

	if (cached && !cached.stale) {
		return {
			results: overlayYoutubeSubscribed(cached.results, subscribed),
			cached: true,
			searchedAt: cached.searchedAt,
		};
	}

	const quota = await discoverSearchQuotaStatus(env.DB);
	if (!quota.allowed) {
		if (cached) {
			return {
				results: overlayYoutubeSubscribed(cached.results, subscribed),
				cached: true,
				searchedAt: cached.searchedAt,
				warning: 'YouTube Discover search quota reached. Showing cached results.',
			};
		}
		return {
			results: [],
			cached: false,
			searchedAt: now.toISOString(),
			warning: 'YouTube Discover search is temporarily unavailable due to daily search quota.',
		};
	}

	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey) {
		if (cached) {
			return {
				results: overlayYoutubeSubscribed(cached.results, subscribed),
				cached: true,
				searchedAt: cached.searchedAt,
				warning: 'YouTube API key is not configured. Showing cached results.',
			};
		}
		return {
			results: [],
			cached: false,
			searchedAt: now.toISOString(),
			warning: 'YouTube Discover search is unavailable (API key not configured).',
		};
	}

	const yt = createYoutubeApiKeyClient(apiKey);
	const { results: rawResults } = await searchYoutubeChannels(yt, query.trim());
	await recordYoutubeCalls(env.DB, yt);

	const cachePayload = rawResults.map(({ subscribed: _s, ...row }) => row);
	await putDiscoverSearchCache(env.DB, cacheKey, cachePayload, undefined, now);

	return {
		results: overlayYoutubeSubscribed(rawResults, subscribed),
		cached: false,
		searchedAt: now.toISOString(),
	};
}
