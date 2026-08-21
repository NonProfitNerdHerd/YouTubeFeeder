export class YoutubeApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly quotaExceeded: boolean,
		readonly path: string = '',
		readonly reason: string | null = null,
	) {
		super(message);
		this.name = 'YoutubeApiError';
	}

	/** playlistItems 404 is a per-channel miss, not a global sync failure. */
	get isPlaylistNotFound(): boolean {
		return this.path === 'playlistItems' && this.status === 404;
	}

	/** Quota / rate / auth failures must abort the whole sync. */
	get isGlobalFatal(): boolean {
		if (this.quotaExceeded) return true;
		if (this.status === 401 || this.status === 429) return true;
		if (this.reason === 'quotaExceeded' || this.reason === 'dailyLimitExceeded') return true;
		if (this.reason === 'keyInvalid') return true;
		if (this.reason === 'authError' || this.reason === 'unauthorized' || this.reason === 'forbidden') {
			return this.status === 401 || this.status === 403;
		}
		return false;
	}
}

export interface YoutubeClient {
	quotaUsed: number;
	searchQueries: number;
	calls: {
		search: number;
		videos: number;
		playlistItems: number;
		channels: number;
		subscriptions: number;
		other: number;
	};
	getJson<T>(path: string, params: Record<string, string>): Promise<T>;
}

export function emptyCalls(): YoutubeClient['calls'] {
	return { search: 0, videos: 0, playlistItems: 0, channels: 0, subscriptions: 0, other: 0 };
}

function accountCall(client: YoutubeClient, path: string): void {
	// YouTube Data API quota (verified 2026-08-17): search.list is a separate 100-call/day
	// bucket at 1 unit/call and must not consume the 10,000 general units pool.
	if (path === 'search') {
		client.searchQueries += 1;
		client.calls.search += 1;
		return;
	}
	client.quotaUsed += 1;
	if (path === 'videos') client.calls.videos += 1;
	else if (path === 'playlistItems') client.calls.playlistItems += 1;
	else if (path === 'channels') client.calls.channels += 1;
	else if (path === 'subscriptions') client.calls.subscriptions += 1;
	else client.calls.other += 1;
}

async function youtubeGetJson<T>(
	client: YoutubeClient,
	path: string,
	params: Record<string, string>,
	auth: { bearer?: string; apiKey?: string },
): Promise<T> {
	const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	if (auth.apiKey) url.searchParams.set('key', auth.apiKey);
	accountCall(client, path);
	const headers: Record<string, string> = {};
	if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
	const res = await globalThis.fetch(url, { headers });
	if (!res.ok) {
		const body = await res.text();
		const reason = extractYoutubeErrorReason(body);
		const quotaExceeded =
			reason === 'quotaExceeded' ||
			reason === 'dailyLimitExceeded' ||
			body.includes('quotaExceeded') ||
			body.includes('dailyLimitExceeded');
		throw new YoutubeApiError(
			sanitizeErrorMessage(path, res.status, quotaExceeded, reason),
			res.status,
			quotaExceeded,
			path,
			reason,
		);
	}
	return (await res.json()) as T;
}

export function createYoutubeClient(accessToken: string): YoutubeClient {
	const client: YoutubeClient = {
		quotaUsed: 0,
		searchQueries: 0,
		calls: emptyCalls(),
		async getJson<T>(path: string, params: Record<string, string>): Promise<T> {
			return youtubeGetJson<T>(client, path, params, { bearer: accessToken });
		},
	};
	return client;
}

export function createYoutubeApiKeyClient(apiKey: string): YoutubeClient {
	const client: YoutubeClient = {
		quotaUsed: 0,
		searchQueries: 0,
		calls: emptyCalls(),
		async getJson<T>(path: string, params: Record<string, string>): Promise<T> {
			return youtubeGetJson<T>(client, path, params, { apiKey });
		},
	};
	return client;
}

/** Extract a short YouTube error reason without retaining raw credential-bearing payloads. */
export function extractYoutubeErrorReason(body: string): string | null {
	if (!body) return null;
	try {
		const parsed = JSON.parse(body) as {
			error?: { errors?: Array<{ reason?: string }>; status?: string; message?: string };
		};
		const message = parsed.error?.message ?? '';
		if (/api key not valid/i.test(message)) return 'keyInvalid';
		const reason = parsed.error?.errors?.[0]?.reason;
		if (typeof reason === 'string' && reason.length > 0 && reason.length <= 120) {
			return reason.replace(/[^\w.-]/g, '');
		}
	} catch {
		/* fall through to substring checks */
	}
	if (body.includes('API key not valid') || body.includes('keyInvalid')) return 'keyInvalid';
	if (body.includes('quotaExceeded')) return 'quotaExceeded';
	if (body.includes('dailyLimitExceeded')) return 'dailyLimitExceeded';
	return null;
}

function sanitizeErrorMessage(path: string, status: number, quotaExceeded: boolean, reason: string | null): string {
	if (quotaExceeded) return 'YouTube API quota exhausted.';
	if (reason === 'keyInvalid') {
		return 'YouTube API key is invalid or not authorized for this request.';
	}
	if (status === 403) return 'YouTube API forbidden.';
	if (status === 401) return 'YouTube API authorization failed.';
	if (status === 429) return 'YouTube API rate limited.';
	if (reason) return `YouTube API ${path} failed (${status}: ${reason}).`;
	return `YouTube API ${path} failed (${status}).`;
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

/** D1/SQLite rejects more than 100 bound parameters in one statement. */
export const D1_IN_CHUNK = 50;

export async function selectInChunks<T>(
	db: D1Database,
	sqlForPlaceholders: (placeholders: string) => string,
	ids: string[],
): Promise<T[]> {
	const rows: T[] = [];
	for (const group of chunk(ids, D1_IN_CHUNK)) {
		if (!group.length) continue;
		const page = await db
			.prepare(sqlForPlaceholders(group.map(() => '?').join(',')))
			.bind(...group)
			.all<T>();
		rows.push(...(page.results ?? []));
	}
	return rows;
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

const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Resolve video → channelId for Discover Brave verification.
 * Uses part=snippet only. Soft-fails invalid batches / IDs so one bad Brave URL
 * cannot abort the whole Discover request (avoids "YouTube API videos failed (400)").
 */
export async function fetchVideoChannelIdsSoft(
	yt: YoutubeClient,
	ids: string[],
): Promise<{ channelByVideoId: Map<string, string>; failedIds: number }> {
	const channelByVideoId = new Map<string, string>();
	const unique = [...new Set(ids.filter((id) => YOUTUBE_VIDEO_ID_RE.test(id)))];
	let failedIds = 0;

	async function loadGroup(group: string[]): Promise<void> {
		if (!group.length) return;
		try {
			const page = await yt.getJson<{
				items?: Array<{ id?: string; snippet?: { channelId?: string } }>;
			}>('videos', {
				part: 'snippet',
				id: group.join(','),
			});
			for (const item of page.items ?? []) {
				const videoId = item.id;
				const channelId = item.snippet?.channelId;
				if (videoId && channelId) channelByVideoId.set(videoId, channelId);
			}
		} catch (err) {
			if (err instanceof YoutubeApiError && err.isGlobalFatal) throw err;
			// Batch rejected (often one malformed id) — retry individually.
			if (group.length === 1) {
				failedIds += 1;
				return;
			}
			for (const id of group) {
				await loadGroup([id]);
			}
		}
	}

	for (const group of chunk(unique, 50)) {
		await loadGroup(group);
	}
	return { channelByVideoId, failedIds };
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
