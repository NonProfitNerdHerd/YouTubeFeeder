import { isYouTubeChannelId } from '../../../../src/lib/youtubeUrl';
import {
	chunk,
	fetchVideoChannelIdsSoft,
	YoutubeApiError,
	type YoutubeClient,
} from '../../youtube';
import { candidateWatchUrl, classifyBraveYoutubeHit, type ClassifiedYoutubeHit } from './youtubeCandidateNormalize';
import type { DiscoveryProviderCandidate, DiscoveryProviderRawHit } from './types';

/** Bump when candidate resolution logic changes — triggers reprocess of cached raw hits. */
export const DISCOVER_CANDIDATE_RESOLVER_VERSION = 'v2';

export type DiscoverResolutionStatus = 'ok' | 'failed' | 'empty_legitimate' | 'pending';

export interface BatchResolveStats {
	rawBraveResults: number;
	validYoutubeUrls: number;
	channelUrls: number;
	videoUrls: number;
	customUrls: number;
	invalidUrls: number;
	resolvedChannels: number;
	unresolvedResults: number;
	duplicateChannels: number;
	videosListCalls: number;
	channelsListCalls: number;
	searchListCalls: number;
	videoResolveFailures?: number;
	usernameLookups?: number;
	handleLookups?: number;
	aliasAssociated?: number;
	channelIdsFromDescriptions?: number;
	youtubeErrorReason?: string | null;
}

export interface ResolveBraveHitsResult {
	candidates: DiscoveryProviderCandidate[];
	stats: BatchResolveStats;
	/** Set when resolution could not complete due to API/key failure. */
	resolutionStatus: DiscoverResolutionStatus;
	errorMessage?: string;
}

interface ChannelSnippetItem {
	id?: string;
	snippet?: {
		title?: string;
		description?: string;
		customUrl?: string;
		thumbnails?: { default?: { url?: string }; medium?: { url?: string }; high?: { url?: string } };
	};
}

const CHANNEL_ID_IN_TEXT = /youtube\.com\/channel\/(UC[\w-]{22})/gi;
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function normalizeTitle(value: string): string {
	return value
		.toLowerCase()
		.replace(/\s*-\s*youtube\s*$/i, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function thumb(item: ChannelSnippetItem | undefined): string {
	return (
		item?.snippet?.thumbnails?.medium?.url ??
		item?.snippet?.thumbnails?.default?.url ??
		item?.snippet?.thumbnails?.high?.url ??
		''
	);
}

function extractChannelIdsFromText(text: string | undefined, into: Set<string>): number {
	if (!text) return 0;
	let added = 0;
	CHANNEL_ID_IN_TEXT.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CHANNEL_ID_IN_TEXT.exec(text))) {
		const id = match[1];
		if (id && isYouTubeChannelId(id) && !into.has(id)) {
			into.add(id);
			added += 1;
		}
	}
	return added;
}

function collectValidVideoIds(ids: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of ids) {
		const id = raw.trim();
		if (!YOUTUBE_VIDEO_ID_RE.test(id)) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

async function fetchChannelsByIds(yt: YoutubeClient, ids: string[]): Promise<Map<string, ChannelSnippetItem>> {
	const found = new Map<string, ChannelSnippetItem>();
	const unique = [...new Set(ids.filter((id) => isYouTubeChannelId(id)))];
	for (const group of chunk(unique, 50)) {
		if (!group.length) continue;
		try {
			const page = await yt.getJson<{ items?: ChannelSnippetItem[] }>('channels', {
				part: 'snippet',
				id: group.join(','),
			});
			for (const item of page.items ?? []) {
				if (item.id) found.set(item.id, item);
			}
		} catch (err) {
			if (err instanceof YoutubeApiError && err.isGlobalFatal) throw err;
			if (group.length === 1) continue;
			for (const id of group) {
				try {
					const page = await yt.getJson<{ items?: ChannelSnippetItem[] }>('channels', {
						part: 'snippet',
						id,
					});
					for (const item of page.items ?? []) {
						if (item.id) found.set(item.id, item);
					}
				} catch (inner) {
					if (inner instanceof YoutubeApiError && inner.isGlobalFatal) throw inner;
				}
			}
		}
	}
	return found;
}

async function fetchChannelByHandle(yt: YoutubeClient, handle: string): Promise<ChannelSnippetItem | null> {
	try {
		const page = await yt.getJson<{ items?: ChannelSnippetItem[] }>('channels', {
			part: 'snippet',
			forHandle: handle.replace(/^@/, ''),
		});
		return page.items?.[0] ?? null;
	} catch (err) {
		if (err instanceof YoutubeApiError && err.isGlobalFatal) throw err;
		return null;
	}
}

/** Legacy /user/{username} → channels.list(forUsername=...) — no search.list. */
async function fetchChannelByUsername(yt: YoutubeClient, username: string): Promise<ChannelSnippetItem | null> {
	try {
		const page = await yt.getJson<{ items?: ChannelSnippetItem[] }>('channels', {
			part: 'snippet',
			forUsername: username,
		});
		return page.items?.[0] ?? null;
	} catch (err) {
		if (err instanceof YoutubeApiError && err.isGlobalFatal) throw err;
		return null;
	}
}

/**
 * Resolve Brave web hits to unique YouTube channel candidates.
 * Never calls search.list.
 */
export async function resolveBraveHitsToChannels(
	yt: YoutubeClient,
	hits: DiscoveryProviderRawHit[],
): Promise<ResolveBraveHitsResult> {
	const stats: BatchResolveStats = {
		rawBraveResults: hits.length,
		validYoutubeUrls: 0,
		channelUrls: 0,
		videoUrls: 0,
		customUrls: 0,
		invalidUrls: 0,
		resolvedChannels: 0,
		unresolvedResults: 0,
		duplicateChannels: 0,
		videosListCalls: 0,
		channelsListCalls: 0,
		searchListCalls: 0,
		videoResolveFailures: 0,
		usernameLookups: 0,
		handleLookups: 0,
		aliasAssociated: 0,
		channelIdsFromDescriptions: 0,
		youtubeErrorReason: null,
	};

	const classified: ClassifiedYoutubeHit[] = hits.map(classifyBraveYoutubeHit);
	const channelIds = new Set<string>();
	const handles = new Map<string, ClassifiedYoutubeHit & { kind: 'handle' }>();
	const usernames = new Map<string, { url: string; title: string }>();
	const aliases: Array<{ url: string; title: string; path: string }> = [];
	const videoIds = new Set<string>();
	const sourceByChannel = new Map<string, string[]>();
	const titleHintByChannel = new Map<string, string>();

	function noteSource(channelId: string, url: string, title: string) {
		const list = sourceByChannel.get(channelId) ?? [];
		list.push(url);
		sourceByChannel.set(channelId, list);
		if (!titleHintByChannel.has(channelId) && title) titleHintByChannel.set(channelId, title);
	}

	for (const hit of hits) {
		stats.channelIdsFromDescriptions! += extractChannelIdsFromText(hit.description, channelIds);
		stats.channelIdsFromDescriptions! += extractChannelIdsFromText(hit.url, channelIds);
	}

	for (const row of classified) {
		if (row.kind === 'invalid') {
			stats.invalidUrls += 1;
			stats.unresolvedResults += 1;
			continue;
		}
		stats.validYoutubeUrls += 1;
		if (row.kind === 'channelId') {
			stats.channelUrls += 1;
			channelIds.add(row.channelId);
			noteSource(row.channelId, row.url, row.title);
		} else if (row.kind === 'handle') {
			stats.channelUrls += 1;
			handles.set(row.handle.toLowerCase(), row);
		} else if (row.kind === 'videoId') {
			stats.videoUrls += 1;
			videoIds.add(row.videoId);
		} else if (row.kind === 'custom') {
			stats.customUrls += 1;
			try {
				const pathParts = new URL(row.url).pathname.split('/').filter(Boolean);
				if (pathParts[0] === 'user' && pathParts[1]) {
					usernames.set(pathParts[1], { url: row.url, title: row.title });
				} else {
					aliases.push({ url: row.url, title: row.title, path: row.path });
				}
			} catch {
				aliases.push({ url: row.url, title: row.title, path: row.path });
			}
		}
	}

	const videosBefore = yt.calls.videos;
	const channelsBefore = yt.calls.channels;
	const searchBefore = yt.calls.search;

	try {
		const validVideoIds = collectValidVideoIds(videoIds);
		if (validVideoIds.length) {
			const { channelByVideoId, failedIds } = await fetchVideoChannelIdsSoft(yt, validVideoIds);
			stats.videoResolveFailures = failedIds;
			for (const [videoId, channelId] of channelByVideoId) {
				channelIds.add(channelId);
				const hit = classified.find((c) => c.kind === 'videoId' && c.videoId === videoId);
				noteSource(
					channelId,
					hit && hit.kind === 'videoId' ? hit.url : `https://www.youtube.com/watch?v=${videoId}`,
					hit?.title ?? '',
				);
			}
			for (const id of validVideoIds) {
				if (!channelByVideoId.has(id)) stats.unresolvedResults += 1;
			}
		}

		const prefetched = new Map<string, ChannelSnippetItem>();

		for (const [, hit] of handles) {
			stats.handleLookups! += 1;
			const item = await fetchChannelByHandle(yt, hit.handle);
			if (!item?.id) {
				stats.unresolvedResults += 1;
				continue;
			}
			channelIds.add(item.id);
			prefetched.set(item.id, item);
			noteSource(item.id, hit.url, hit.title);
		}

		for (const [username, meta] of usernames) {
			stats.usernameLookups! += 1;
			const item = await fetchChannelByUsername(yt, username);
			if (!item?.id) {
				stats.unresolvedResults += 1;
				continue;
			}
			channelIds.add(item.id);
			prefetched.set(item.id, item);
			noteSource(item.id, meta.url, meta.title);
		}

		const channelMeta = await fetchChannelsByIds(yt, [...channelIds]);
		for (const [id, item] of prefetched) {
			if (!channelMeta.has(id)) channelMeta.set(id, item);
		}

		stats.videosListCalls = yt.calls.videos - videosBefore;
		stats.channelsListCalls = yt.calls.channels - channelsBefore;
		stats.searchListCalls = yt.calls.search - searchBefore;

		const candidates: DiscoveryProviderCandidate[] = [];
		const seen = new Set<string>();
		const titleIndex = new Map<string, string>();
		const customUrlIndex = new Map<string, string>();

		for (const channelId of channelIds) {
			if (seen.has(channelId)) {
				stats.duplicateChannels += 1;
				continue;
			}
			seen.add(channelId);
			const meta = channelMeta.get(channelId);
			if (!meta) {
				stats.unresolvedResults += 1;
				continue;
			}
			const title = meta.snippet?.title ?? titleHintByChannel.get(channelId) ?? 'YouTube channel';
			const customUrl = (meta.snippet?.customUrl ?? '').replace(/^@/, '').toLowerCase();
			titleIndex.set(normalizeTitle(title), channelId);
			if (customUrl) customUrlIndex.set(customUrl, channelId);

			candidates.push({
				provider: 'youtube',
				type: 'channel',
				externalId: channelId,
				title,
				description: meta.snippet?.description?.slice(0, 500),
				imageUrl: thumb(meta),
				publisher: meta.snippet?.title ?? '',
				watchUrl: candidateWatchUrl(channelId),
				sourceUrls: sourceByChannel.get(channelId) ?? [],
			});
		}

		// Conservatively associate /c/ and bare-path aliases with already-canonical candidates only.
		for (const alias of aliases) {
			const byCustom = customUrlIndex.get(alias.path.toLowerCase());
			const byTitle = titleIndex.get(normalizeTitle(alias.title));
			const channelId = byCustom ?? byTitle;
			if (!channelId) {
				stats.unresolvedResults += 1;
				continue;
			}
			const cand = candidates.find((c) => c.externalId === channelId);
			if (!cand) {
				stats.unresolvedResults += 1;
				continue;
			}
			cand.sourceUrls = [...new Set([...(cand.sourceUrls ?? []), alias.url])];
			stats.aliasAssociated! += 1;
		}

		stats.resolvedChannels = candidates.length;
		const totalMappedSources = [...sourceByChannel.values()].reduce((n, urls) => n + urls.length, 0);
		stats.duplicateChannels = Math.max(0, totalMappedSources - candidates.length);

		const resolutionStatus: DiscoverResolutionStatus =
			candidates.length > 0 ? 'ok' : hits.length === 0 ? 'empty_legitimate' : 'empty_legitimate';

		return { candidates, stats, resolutionStatus };
	} catch (err) {
		stats.videosListCalls = yt.calls.videos - videosBefore;
		stats.channelsListCalls = yt.calls.channels - channelsBefore;
		stats.searchListCalls = yt.calls.search - searchBefore;
		if (err instanceof YoutubeApiError) {
			stats.youtubeErrorReason = err.reason;
			return {
				candidates: [],
				stats,
				resolutionStatus: 'failed',
				errorMessage: err.message,
			};
		}
		return {
			candidates: [],
			stats,
			resolutionStatus: 'failed',
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}
}

export function needsCandidateReprocess(record: {
	resolverVersion?: string;
	resolutionStatus?: string;
	rawResults: unknown[];
	candidates: unknown[];
}): boolean {
	const resolverVersion = record.resolverVersion ?? 'v1';
	const resolutionStatus = record.resolutionStatus ?? 'ok';
	if (resolutionStatus === 'failed' || resolutionStatus === 'pending') return true;
	if (record.rawResults.length > 0 && record.candidates.length === 0 && resolutionStatus !== 'empty_legitimate') {
		return true;
	}
	// Resolver upgraded: reprocess raw hits (0 Brave cost) even if prior candidates exist.
	if (resolverVersion !== DISCOVER_CANDIDATE_RESOLVER_VERSION && record.rawResults.length > 0) {
		return true;
	}
	return false;
}
