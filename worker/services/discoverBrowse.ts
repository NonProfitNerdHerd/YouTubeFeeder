import type { DiscoverBrowseResponse, DiscoverBrowseTab, DiscoveryResult } from '../../src/types/discover';
import {
	DISCOVER_BROWSE_POPULAR_TTL_MS,
	getDiscoverBrowseCache,
	putDiscoverBrowseCache,
} from '../db/discoverCache';
import { getSubscribedChannelIds, listRecentlyFollowedChannels } from '../db/queries';
import { buildForYouRecommendations } from './discover/forYou';
import { recordYoutubeCalls } from './websub';
import { createYoutubeApiKeyClient } from './youtube';

const POPULAR_SECTION_KEY = 'popular_videos';

interface PopularVideoRow {
	videoId: string;
	channelId: string;
	channelTitle: string;
	title: string;
	thumbnailUrl: string;
	publishedAt: string | null;
}

async function fetchPopularVideos(env: Env): Promise<PopularVideoRow[]> {
	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey) return [];
	const yt = createYoutubeApiKeyClient(apiKey);
	const page = await yt.getJson<{
		items?: Array<{
			id?: string;
			snippet?: {
				title?: string;
				channelId?: string;
				channelTitle?: string;
				publishedAt?: string;
				thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
			};
		}>;
	}>('videos', {
		part: 'snippet',
		chart: 'mostPopular',
		regionCode: 'US',
		maxResults: '12',
	});
	await recordYoutubeCalls(env.DB, yt);
	return (page.items ?? [])
		.filter((item) => item.id && item.snippet?.channelId)
		.map((item) => ({
			videoId: item.id!,
			channelId: item.snippet!.channelId!,
			channelTitle: item.snippet!.channelTitle ?? 'YouTube channel',
			title: item.snippet!.title ?? 'Video',
			thumbnailUrl: item.snippet!.thumbnails?.medium?.url ?? item.snippet!.thumbnails?.default?.url ?? '',
			publishedAt: item.snippet!.publishedAt ?? null,
		}));
}

function popularToDiscoveryResults(rows: PopularVideoRow[], subscribed: Set<string>): DiscoveryResult[] {
	return rows.map((row) => ({
		provider: 'youtube' as const,
		type: 'video' as const,
		externalId: row.videoId,
		title: row.title,
		imageUrl: row.thumbnailUrl,
		publisher: row.channelTitle,
		publishedAt: row.publishedAt,
		parentExternalId: row.channelId,
		parentTitle: row.channelTitle,
		subscribed: subscribed.has(row.channelId),
		playable: true,
		watchUrl: `https://www.youtube.com/watch?v=${row.videoId}`,
	}));
}

function recentlyFollowedToResults(
	rows: Array<{ channelId: string; title: string; thumbnailUrl: string; description: string; followedAt: string }>,
	subscribed: Set<string>,
): DiscoveryResult[] {
	return rows.map((row) => ({
		provider: 'youtube' as const,
		type: 'channel' as const,
		externalId: row.channelId,
		title: row.title,
		description: row.description?.slice(0, 300),
		imageUrl: row.thumbnailUrl,
		publisher: row.title,
		publishedAt: row.followedAt,
		subscribed: subscribed.has(row.channelId),
		watchUrl: `https://www.youtube.com/channel/${row.channelId}`,
	}));
}

async function browsePopular(env: Env, userId: string, now: Date): Promise<DiscoveryResult[]> {
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	let popularVideos: DiscoveryResult[] = [];
	const cachedPopular = await getDiscoverBrowseCache<PopularVideoRow[]>(env.DB, POPULAR_SECTION_KEY, now);
	if (cachedPopular && !cachedPopular.stale) {
		popularVideos = popularToDiscoveryResults(cachedPopular.payload, subscribed);
	} else if (env.YOUTUBE_API_KEY) {
		try {
			const rows = await fetchPopularVideos(env);
			if (rows.length) {
				await putDiscoverBrowseCache(env.DB, POPULAR_SECTION_KEY, rows, DISCOVER_BROWSE_POPULAR_TTL_MS, now);
				popularVideos = popularToDiscoveryResults(rows, subscribed);
			} else if (cachedPopular) {
				popularVideos = popularToDiscoveryResults(cachedPopular.payload, subscribed);
			}
		} catch {
			if (cachedPopular) {
				popularVideos = popularToDiscoveryResults(cachedPopular.payload, subscribed);
			}
		}
	} else if (cachedPopular) {
		popularVideos = popularToDiscoveryResults(cachedPopular.payload, subscribed);
	}
	return popularVideos;
}

async function browseRecent(env: Env, userId: string): Promise<DiscoveryResult[]> {
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	return recentlyFollowedToResults(await listRecentlyFollowedChannels(env.DB, userId, 12), subscribed);
}

export async function discoverBrowse(
	env: Env,
	userId: string,
	tab: DiscoverBrowseTab = 'forYou',
	opts?: { interestId?: string; includeDebug?: boolean },
	now = new Date(),
): Promise<DiscoverBrowseResponse> {
	const refreshedAt = now.toISOString();
	const empty: DiscoverBrowseResponse = {
		forYou: [],
		popularVideos: [],
		recentlyFollowed: [],
		refreshedAt,
	};

	if (tab === 'forYou') {
		const forYouResult = await buildForYouRecommendations(env, userId, opts, now);
		return {
			...empty,
			forYou: forYouResult.forYou,
			forYouInterests: forYouResult.forYouInterests,
			forYouEmpty: forYouResult.forYouEmpty,
			forYouMessage: forYouResult.forYouMessage,
			forYouMetrics: opts?.includeDebug ? forYouResult.metrics : undefined,
			forYouDebug: opts?.includeDebug ? forYouResult.debug : undefined,
		};
	}

	if (tab === 'popular') {
		return {
			...empty,
			popularVideos: await browsePopular(env, userId, now),
		};
	}

	return {
		...empty,
		recentlyFollowed: await browseRecent(env, userId),
	};
}
