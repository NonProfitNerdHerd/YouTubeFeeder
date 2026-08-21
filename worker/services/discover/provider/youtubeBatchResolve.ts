import { chunk, fetchVideoChannelIdsSoft, YoutubeApiError, type YoutubeClient } from '../../youtube';
import { candidateWatchUrl, classifyBraveYoutubeHit, type ClassifiedYoutubeHit } from './youtubeCandidateNormalize';
import type { DiscoveryProviderCandidate, DiscoveryProviderRawHit } from './types';

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

async function fetchChannelsByIds(yt: YoutubeClient, ids: string[]): Promise<Map<string, ChannelSnippetItem>> {
	const found = new Map<string, ChannelSnippetItem>();
	const unique = [...new Set(ids.filter(Boolean))];
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
			// Soft-fail batch: try individually so one bad id cannot wipe the page.
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
			forHandle: handle,
		});
		return page.items?.[0] ?? null;
	} catch (err) {
		if (err instanceof YoutubeApiError && err.isGlobalFatal) throw err;
		return null;
	}
}

function thumb(item: ChannelSnippetItem | undefined): string {
	return (
		item?.snippet?.thumbnails?.medium?.url ??
		item?.snippet?.thumbnails?.default?.url ??
		item?.snippet?.thumbnails?.high?.url ??
		''
	);
}

/**
 * Resolve Brave web hits to unique YouTube channel candidates.
 * Never calls search.list — custom /c /user URLs are dropped as unresolved.
 * videos.list / channels.list failures are soft where possible so Discover does not abort.
 */
export async function resolveBraveHitsToChannels(
	yt: YoutubeClient,
	hits: DiscoveryProviderRawHit[],
): Promise<{ candidates: DiscoveryProviderCandidate[]; stats: BatchResolveStats }> {
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
	};

	const classified: ClassifiedYoutubeHit[] = hits.map(classifyBraveYoutubeHit);
	const channelIds = new Set<string>();
	const handles = new Map<string, ClassifiedYoutubeHit & { kind: 'handle' }>();
	const videoIds = new Set<string>();
	const sourceByChannel = new Map<string, string[]>();
	const titleHintByChannel = new Map<string, string>();

	function noteSource(channelId: string, url: string, title: string) {
		const list = sourceByChannel.get(channelId) ?? [];
		list.push(url);
		sourceByChannel.set(channelId, list);
		if (!titleHintByChannel.has(channelId) && title) titleHintByChannel.set(channelId, title);
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
			stats.unresolvedResults += 1;
		}
	}

	const videosBefore = yt.calls.videos;
	const channelsBefore = yt.calls.channels;
	const searchBefore = yt.calls.search;

	if (videoIds.size) {
		const { channelByVideoId, failedIds } = await fetchVideoChannelIdsSoft(yt, [...videoIds]);
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
		for (const id of videoIds) {
			if (!channelByVideoId.has(id)) stats.unresolvedResults += 1;
		}
	}

	for (const [, hit] of handles) {
		const item = await fetchChannelByHandle(yt, hit.handle);
		if (!item?.id) {
			stats.unresolvedResults += 1;
			continue;
		}
		channelIds.add(item.id);
		noteSource(item.id, hit.url, hit.title);
	}

	const channelMeta = await fetchChannelsByIds(yt, [...channelIds]);

	stats.videosListCalls = yt.calls.videos - videosBefore;
	stats.channelsListCalls = yt.calls.channels - channelsBefore;
	stats.searchListCalls = yt.calls.search - searchBefore;

	const candidates: DiscoveryProviderCandidate[] = [];
	const seen = new Set<string>();
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
		candidates.push({
			provider: 'youtube',
			type: 'channel',
			externalId: channelId,
			title: meta.snippet?.title ?? titleHintByChannel.get(channelId) ?? 'YouTube channel',
			description: meta.snippet?.description?.slice(0, 500),
			imageUrl: thumb(meta),
			publisher: meta.snippet?.title ?? '',
			watchUrl: candidateWatchUrl(channelId),
			sourceUrls: sourceByChannel.get(channelId) ?? [],
		});
	}

	stats.resolvedChannels = candidates.length;
	const totalMappedSources = [...sourceByChannel.values()].reduce((n, urls) => n + urls.length, 0);
	stats.duplicateChannels = Math.max(0, totalMappedSources - candidates.length);

	return { candidates, stats };
}
