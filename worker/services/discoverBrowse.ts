import type {
	DiscoverBrowseResponse,
	DiscoverBrowseTab,
	DiscoverRecommendation,
	DiscoveryResult,
} from '../../src/types/discover';
import {
	DISCOVER_BROWSE_POPULAR_TTL_MS,
	getDiscoverBrowseCache,
	putDiscoverBrowseCache,
} from '../db/discoverCache';
import { getSubscribedChannelIds, listRecentlyFollowedChannels } from '../db/queries';
import { buildForYouRecommendations, FOR_YOU_PAGE_SIZE } from './discover/forYou';
import { buildInterestFingerprints } from './discover/interestFingerprint';
import { buildInterestSearchQuery } from './discover/queryConstruction';
import { getTopicCandidates, loadCachedQueryResults, normalizeTopic } from './discover/topicDiscovery';
import { recordYoutubeCalls } from './websub';
import { createYoutubeApiKeyClient } from './youtube';

const POPULAR_SECTION_KEY = 'popular_videos';
const POPULAR_CHANNEL_LIMIT = 25;
const INTEREST_POPULAR_LIMIT = 25;

interface TrendingVideoRow {
	videoId: string;
	channelId: string;
	channelTitle: string;
	thumbnailUrl: string;
	publishedAt: string | null;
}

async function fetchTrendingVideos(env: Env): Promise<TrendingVideoRow[]> {
	const apiKey = env.YOUTUBE_API_KEY;
	if (!apiKey) return [];
	const yt = createYoutubeApiKeyClient(apiKey);
	const page = await yt.getJson<{
		items?: Array<{
			id?: string;
			snippet?: {
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
		maxResults: '50',
	});
	await recordYoutubeCalls(env.DB, yt);
	return (page.items ?? [])
		.filter((item) => item.id && item.snippet?.channelId)
		.map((item) => ({
			videoId: item.id!,
			channelId: item.snippet!.channelId!,
			channelTitle: item.snippet!.channelTitle ?? 'YouTube channel',
			thumbnailUrl: item.snippet!.thumbnails?.medium?.url ?? item.snippet!.thumbnails?.default?.url ?? '',
			publishedAt: item.snippet!.publishedAt ?? null,
		}));
}

function trendingToPopularChannels(
	rows: TrendingVideoRow[],
	subscribed: Set<string>,
	excludeIds = new Set<string>(),
): DiscoveryResult[] {
	const seen = new Set<string>();
	const results: DiscoveryResult[] = [];
	for (const row of rows) {
		if (seen.has(row.channelId)) continue;
		if (subscribed.has(row.channelId) || excludeIds.has(row.channelId)) continue;
		seen.add(row.channelId);
		results.push({
			provider: 'youtube',
			type: 'channel',
			externalId: row.channelId,
			title: row.channelTitle,
			imageUrl: row.thumbnailUrl,
			publisher: row.channelTitle,
			publishedAt: row.publishedAt,
			subscribed: false,
			watchUrl: `https://www.youtube.com/channel/${row.channelId}`,
		});
		if (results.length >= POPULAR_CHANNEL_LIMIT) break;
	}
	return results;
}

async function loadTrendingVideoRows(env: Env, now: Date): Promise<TrendingVideoRow[]> {
	const cachedPopular = await getDiscoverBrowseCache<TrendingVideoRow[]>(env.DB, POPULAR_SECTION_KEY, now);
	if (cachedPopular && !cachedPopular.stale) {
		return cachedPopular.payload;
	}
	if (env.YOUTUBE_API_KEY) {
		try {
			const rows = await fetchTrendingVideos(env);
			if (rows.length) {
				await putDiscoverBrowseCache(env.DB, POPULAR_SECTION_KEY, rows, DISCOVER_BROWSE_POPULAR_TTL_MS, now);
				return rows;
			}
		} catch {
			// Fall back to stale cache below.
		}
	}
	return cachedPopular?.payload ?? [];
}

async function browseGlobalPopularChannels(
	env: Env,
	userId: string,
	now: Date,
	excludeIds = new Set<string>(),
): Promise<DiscoveryResult[]> {
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const rows = await loadTrendingVideoRows(env, now);
	return trendingToPopularChannels(rows, subscribed, excludeIds);
}

async function interestPopularFromQuery(
	env: Env,
	query: string,
	fingerprint: { interestId: string; label: string },
	subscribed: Set<string>,
	now: Date,
): Promise<DiscoverRecommendation[]> {
	await getTopicCandidates(env, query, now);
	return (await loadCachedQueryResults(env, query, now))
		.filter((row) => !subscribed.has(row.externalId))
		.slice(0, INTEREST_POPULAR_LIMIT)
		.map(
			(row): DiscoverRecommendation => ({
				...row,
				subscribed: false,
				recommendationReason: `Popular in ${fingerprint.label}`,
				interestId: fingerprint.interestId,
				interestLabel: fingerprint.label,
			}),
		);
}

async function browseInterestPopularChannels(
	env: Env,
	userId: string,
	interestId: string,
	now: Date,
): Promise<{ channels: DiscoverRecommendation[]; label?: string }> {
	const fingerprints = await buildInterestFingerprints(env.DB, userId);
	const fingerprint = fingerprints.find((row) => row.interestId === interestId);
	if (!fingerprint) return { channels: [] };

	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const primaryQuery = buildInterestSearchQuery(fingerprint);
	let channels = await interestPopularFromQuery(env, primaryQuery, fingerprint, subscribed, now);

	const labelQuery = fingerprint.label.trim();
	if (!channels.length && labelQuery && normalizeTopic(labelQuery) !== normalizeTopic(primaryQuery)) {
		channels = await interestPopularFromQuery(env, labelQuery, fingerprint, subscribed, now);
	}

	return { channels, label: fingerprint.label };
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

async function browseRecent(env: Env, userId: string): Promise<DiscoveryResult[]> {
	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	return recentlyFollowedToResults(await listRecentlyFollowedChannels(env.DB, userId, 12), subscribed);
}

export async function discoverBrowse(
	env: Env,
	userId: string,
	tab: DiscoverBrowseTab = 'forYou',
	opts?: {
		interestId?: string;
		includeDebug?: boolean;
		limit?: number;
		offset?: number;
		loadMore?: boolean;
		refreshOffset?: number;
	},
	now = new Date(),
): Promise<DiscoverBrowseResponse> {
	const refreshedAt = now.toISOString();
	const empty: DiscoverBrowseResponse = {
		forYou: [],
		popularChannels: [],
		recentlyFollowed: [],
		refreshedAt,
	};

	if (tab === 'forYou') {
		const forYouResult = await buildForYouRecommendations(env, userId, opts, now);
		return {
			...empty,
			forYou: forYouResult.forYou,
			forYouTotal: forYouResult.forYouTotal,
			forYouHasMore: forYouResult.forYouHasMore,
			forYouInterests: forYouResult.forYouInterests,
			forYouEmpty: forYouResult.forYouEmpty,
			forYouMessage: forYouResult.forYouMessage,
			forYouSupportingMessage: forYouResult.forYouSupportingMessage,
			forYouMetrics: opts?.includeDebug ? forYouResult.metrics : undefined,
			forYouDebug: opts?.includeDebug ? forYouResult.debug : undefined,
			forYouPipelineDebug: opts?.includeDebug ? forYouResult.pipelineDebug : undefined,
		};
	}

	if (tab === 'popular') {
		let popularInterestChannels: DiscoverRecommendation[] = [];
		let popularInterestLabel: string | undefined;
		const excludeIds = new Set<string>();

		if (opts?.interestId) {
			const interestPopular = await browseInterestPopularChannels(env, userId, opts.interestId, now);
			popularInterestChannels = interestPopular.channels;
			popularInterestLabel = interestPopular.label;
			for (const row of popularInterestChannels) {
				excludeIds.add(row.externalId);
			}
		}

		return {
			...empty,
			popularChannels: await browseGlobalPopularChannels(env, userId, now, excludeIds),
			popularInterestChannels: popularInterestChannels.length ? popularInterestChannels : undefined,
			popularInterestLabel,
		};
	}

	return {
		...empty,
		recentlyFollowed: await browseRecent(env, userId),
	};
}
