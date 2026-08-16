export class YoutubeApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly quotaExceeded: boolean,
	) {
		super(message);
		this.name = 'YoutubeApiError';
	}
}

export interface YoutubeClient {
	quotaUsed: number;
	searchQueries: number;
	calls: { search: number; videos: number; playlistItems: number; channels: number; other: number };
	getJson<T>(path: string, params: Record<string, string>): Promise<T>;
}

function emptyCalls() {
	return { search: 0, videos: 0, playlistItems: 0, channels: 0, other: 0 };
}

export function createYoutubeClient(accessToken: string): YoutubeClient {
	return {
		quotaUsed: 0,
		searchQueries: 0,
		calls: emptyCalls(),
		async getJson<T>(path: string, params: Record<string, string>): Promise<T> {
			const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
			for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
			if (path === 'search') {
				this.quotaUsed += 100;
				this.searchQueries += 1;
				this.calls.search += 1;
			} else {
				this.quotaUsed += 1;
				if (path === 'videos') this.calls.videos += 1;
				else if (path === 'playlistItems') this.calls.playlistItems += 1;
				else if (path === 'channels') this.calls.channels += 1;
				else this.calls.other += 1;
			}
			const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
			if (res.status === 403 || res.status === 429) {
				const body = await res.text();
				const quotaExceeded = body.includes('quotaExceeded') || body.includes('dailyLimitExceeded');
				throw new YoutubeApiError(quotaExceeded ? 'YouTube API quota exhausted.' : 'YouTube API forbidden.', res.status, quotaExceeded);
			}
			if (!res.ok) {
				throw new YoutubeApiError(`YouTube API ${path} failed (${res.status}).`, res.status, false);
			}
			return (await res.json()) as T;
		},
	};
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	let i = 0;
	async function worker() {
		while (i < items.length) {
			const idx = i++;
			out[idx] = await fn(items[idx]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return out;
}

export function parseIsoDuration(iso: string | undefined): number | null {
	if (!iso || !iso.startsWith('PT')) return null;
	const hours = Number(/(\d+)H/.exec(iso)?.[1] ?? 0);
	const minutes = Number(/(\d+)M/.exec(iso)?.[1] ?? 0);
	const seconds = Number(/(\d+)S/.exec(iso)?.[1] ?? 0);
	return hours * 3600 + minutes * 60 + seconds;
}

export function chunk<T>(items: T[], size: number): T[][] {
	const groups: T[][] = [];
	for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
	return groups;
}

export interface ChannelLiveStatus {
	isLive: boolean;
	videoId: string | null;
	title: string | null;
}

export async function fetchChannelLiveVideos(
	yt: YoutubeClient,
	channelId: string,
): Promise<Array<{ videoId: string; title: string }>> {
	const lives: Array<{ videoId: string; title: string }> = [];
	let pageToken = '';
	while (lives.length < 100) {
		const params: Record<string, string> = {
			part: 'snippet',
			channelId,
			eventType: 'live',
			type: 'video',
			maxResults: '50',
		};
		if (pageToken) params.pageToken = pageToken;
		const page = await yt.getJson<{
			nextPageToken?: string;
			items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>;
		}>('search', params);
		for (const item of page.items ?? []) {
			if (!item.id?.videoId) continue;
			lives.push({ videoId: item.id.videoId, title: item.snippet?.title ?? 'Live' });
			if (lives.length >= 100) break;
		}
		if (!page.nextPageToken || lives.length >= 100) break;
		pageToken = page.nextPageToken;
	}
	return lives;
}

export async function fetchChannelLiveStatus(
	yt: YoutubeClient,
	channelId: string,
): Promise<ChannelLiveStatus> {
	const lives = await fetchChannelLiveVideos(yt, channelId);
	const first = lives[0];
	if (!first) return { isLive: false, videoId: null, title: null };
	return { isLive: true, videoId: first.videoId, title: first.title };
}

export async function resolveChannelId(
	yt: YoutubeClient,
	parsed: { channelId?: string; handle?: string; query?: string },
): Promise<string> {
	if (parsed.channelId) return parsed.channelId;
	if (parsed.handle) {
		const page = await yt.getJson<{ items?: Array<{ id?: string }> }>('channels', {
			part: 'id',
			forHandle: parsed.handle,
		});
		const id = page.items?.[0]?.id;
		if (!id) throw new Error('channel_not_found');
		return id;
	}
	if (parsed.query) {
		const page = await yt.getJson<{ items?: Array<{ id?: { channelId?: string } }> }>('search', {
			part: 'snippet',
			q: parsed.query,
			type: 'channel',
			maxResults: '1',
		});
		const id = page.items?.[0]?.id?.channelId;
		if (!id) throw new Error('channel_not_found');
		return id;
	}
	throw new Error('invalid_channel');
}

export interface YoutubeVideoItem {
	id?: string;
	snippet?: {
		title?: string;
		channelId?: string;
		liveBroadcastContent?: string;
	};
	status?: {
		embeddable?: boolean;
		privacyStatus?: string;
		uploadStatus?: string;
	};
	liveStreamingDetails?: {
		scheduledStartTime?: string;
		actualStartTime?: string;
		actualEndTime?: string;
	};
}

export async function fetchVideosByIds(yt: YoutubeClient, ids: string[]): Promise<Map<string, YoutubeVideoItem>> {
	const found = new Map<string, YoutubeVideoItem>();
	const unique = [...new Set(ids.filter(Boolean))];
	for (const group of chunk(unique, 50)) {
		if (!group.length) continue;
		const page = await yt.getJson<{ items?: YoutubeVideoItem[] }>('videos', {
			part: 'snippet,liveStreamingDetails,status',
			id: group.join(','),
		});
		for (const item of page.items ?? []) {
			if (item.id) found.set(item.id, item);
		}
	}
	return found;
}

export async function fetchUploadsPlaylistIds(yt: YoutubeClient, channelIds: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const unique = [...new Set(channelIds.filter(Boolean))];
	for (const group of chunk(unique, 50)) {
		if (!group.length) continue;
		const page = await yt.getJson<{
			items?: Array<{ id?: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
		}>('channels', {
			part: 'contentDetails',
			id: group.join(','),
		});
		for (const item of page.items ?? []) {
			const uploads = item.contentDetails?.relatedPlaylists?.uploads;
			if (item.id && uploads) map.set(item.id, uploads);
		}
	}
	return map;
}

export async function fetchNewestPlaylistVideoIds(
	yt: YoutubeClient,
	playlistId: string,
	maxResults = 8,
): Promise<string[]> {
	const page = await yt.getJson<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>('playlistItems', {
		part: 'contentDetails',
		playlistId,
		maxResults: String(Math.min(50, Math.max(1, maxResults))),
	});
	const ids: string[] = [];
	for (const item of page.items ?? []) {
		if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
	}
	return ids;
}
