import type { DiscoverRecommendation, DiscoveryResult } from '../../../src/types/discover';
import {
	DISCOVER_BROWSE_POPULAR_TTL_MS,
	getDiscoverBrowseCache,
	putDiscoverBrowseCache,
} from '../../db/discoverCache';
import {
	candidateRowToRecommendation,
	FOR_YOU_GLOBAL_INTEREST_ID,
	hasActiveInterestCandidates,
	loadActiveInterestCandidates,
	type DiscoverInterestCandidateInsert,
	type DiscoverInterestCandidateSource,
	upsertInterestCandidates,
} from '../../db/discoverInterestCandidates';
import { getSubscribedChannelIds } from '../../db/queries';
import { buildInterestFingerprints } from './interestFingerprint';
import { buildInterestSearchQuery } from './queryConstruction';
import { getTopicCandidates, loadCachedQueryResults, normalizeTopic } from './topicDiscovery';
import { recordYoutubeCalls } from '../websub';
import { createYoutubeApiKeyClient } from '../youtube';

const POPULAR_SECTION_KEY = 'popular_videos';
const INTEREST_POPULAR_LIMIT = 25;
const POPULAR_CHANNEL_LIMIT = 25;

interface TrendingVideoRow {
	videoId: string;
	channelId: string;
	channelTitle: string;
	thumbnailUrl: string;
	publishedAt: string | null;
}

export interface InterestPopularResult {
	channels: DiscoverRecommendation[];
	interestLabel?: string;
	usedGlobalFallback: boolean;
	fromPersisted: boolean;
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

function trendingToPopularChannels(rows: TrendingVideoRow[], subscribed: Set<string>): DiscoveryResult[] {
	const seen = new Set<string>();
	const results: DiscoveryResult[] = [];
	for (const row of rows) {
		if (seen.has(row.channelId)) continue;
		if (subscribed.has(row.channelId)) continue;
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

async function fetchInterestPopularChannels(
	env: Env,
	userId: string,
	interestId: string,
	now: Date,
): Promise<{ channels: DiscoverRecommendation[]; label: string }> {
	const fingerprints = await buildInterestFingerprints(env.DB, userId);
	const fingerprint = fingerprints.find((row) => row.interestId === interestId);
	if (!fingerprint) return { channels: [], label: '' };

	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const primaryQuery = buildInterestSearchQuery(fingerprint);
	let channels = await interestPopularFromQuery(env, primaryQuery, fingerprint, subscribed, now);

	const labelQuery = fingerprint.label.trim();
	if (!channels.length && labelQuery && normalizeTopic(labelQuery) !== normalizeTopic(primaryQuery)) {
		channels = await interestPopularFromQuery(env, labelQuery, fingerprint, subscribed, now);
	}

	return { channels, label: fingerprint.label };
}

function toCandidateInserts(
	channels: DiscoverRecommendation[],
	source: DiscoverInterestCandidateSource,
): DiscoverInterestCandidateInsert[] {
	return channels.map((row) => ({
		interestId: row.interestId ?? FOR_YOU_GLOBAL_INTEREST_ID,
		interestLabel: row.interestLabel ?? 'All',
		provider: row.provider,
		externalId: row.externalId,
		channelTitle: row.title,
		channelThumbnail: row.imageUrl ?? '',
		channelDescription: row.description ?? '',
		source,
		recommendationReason: row.recommendationReason ?? 'Popular channel',
	}));
}

function tagGlobalFallback(
	channels: DiscoveryResult[],
	interestId: string,
	interestLabel: string,
): DiscoverRecommendation[] {
	return channels.map((row) => ({
		...row,
		subscribed: false,
		interestId,
		interestLabel,
		recommendationReason: `Trending while we build ${interestLabel} recommendations`,
	}));
}

export async function loadPersistedInterestPopular(
	db: D1Database,
	userId: string,
	interestId: string,
): Promise<DiscoverRecommendation[]> {
	const rows = await loadActiveInterestCandidates(db, userId, interestId);
	return rows.map(candidateRowToRecommendation);
}

export async function loadAllPersistedInterestPopular(
	db: D1Database,
	userId: string,
): Promise<DiscoverRecommendation[]> {
	const rows = await loadActiveInterestCandidates(db, userId);
	return rows.map(candidateRowToRecommendation);
}

export async function loadAndPersistInterestPopular(
	env: Env,
	userId: string,
	interestId: string | undefined,
	now = new Date(),
): Promise<InterestPopularResult> {
	const cacheInterestId = interestId ?? FOR_YOU_GLOBAL_INTEREST_ID;

	if (await hasActiveInterestCandidates(env.DB, userId, cacheInterestId)) {
		const channels = await loadPersistedInterestPopular(env.DB, userId, cacheInterestId);
		const label = channels[0]?.interestLabel;
		const usedGlobalFallback = channels.some((row) =>
			row.recommendationReason?.startsWith('Trending while we build'),
		);
		return {
			channels,
			interestLabel: label,
			usedGlobalFallback,
			fromPersisted: true,
		};
	}

	let channels: DiscoverRecommendation[] = [];
	let interestLabel = interestId ? '' : 'All';
	let usedGlobalFallback = false;
	let source: DiscoverInterestCandidateSource = 'browse_popular';

	if (interestId) {
		const interestPopular = await fetchInterestPopularChannels(env, userId, interestId, now);
		channels = interestPopular.channels;
		interestLabel = interestPopular.label;
	}

	if (!channels.length) {
		const subscribed = await getSubscribedChannelIds(env.DB, userId);
		const trending = trendingToPopularChannels(await loadTrendingVideoRows(env, now), subscribed);
		usedGlobalFallback = true;
		source = 'global_fallback';
		if (interestId) {
			channels = tagGlobalFallback(trending, interestId, interestLabel || 'this interest');
		} else {
			channels = trending.map((row) => ({
				...row,
				interestId: FOR_YOU_GLOBAL_INTEREST_ID,
				interestLabel: 'All',
				recommendationReason: 'Trending on YouTube',
			}));
		}
	}

	if (channels.length) {
		await upsertInterestCandidates(env.DB, userId, toCandidateInserts(channels, source), now);
	}

	return {
		channels,
		interestLabel: interestLabel || undefined,
		usedGlobalFallback,
		fromPersisted: false,
	};
}
