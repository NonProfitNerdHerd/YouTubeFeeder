import type { PodcastDiscoveryProvider, PodcastSearchHit } from './podcastDiscoveryProvider';

interface ApplePodcastResult {
	collectionId?: number;
	collectionName?: string;
	artistName?: string;
	artworkUrl600?: string;
	artworkUrl100?: string;
	artworkUrl60?: string;
	feedUrl?: string;
	collectionViewUrl?: string;
	genres?: string[];
	primaryGenreName?: string;
	releaseDate?: string;
}

interface AppleSearchResponse {
	resultCount?: number;
	results?: ApplePodcastResult[];
}

export function buildApplePodcastSearchUrl(query: string, limit = 50): string {
	const url = new URL('https://itunes.apple.com/search');
	url.searchParams.set('media', 'podcast');
	url.searchParams.set('entity', 'podcast');
	url.searchParams.set('term', query.trim());
	url.searchParams.set('limit', String(Math.min(200, Math.max(1, limit))));
	return url.toString();
}

export function mapApplePodcastResult(row: ApplePodcastResult): PodcastSearchHit | null {
	const feedUrl = (row.feedUrl ?? '').trim();
	if (!feedUrl) return null;
	const title = (row.collectionName ?? '').trim();
	if (!title) return null;
	const collectionId = row.collectionId;
	if (collectionId == null || !Number.isFinite(collectionId)) return null;

	const genres = [
		...(Array.isArray(row.genres) ? row.genres.filter((g) => typeof g === 'string' && g.trim()) : []),
		...(row.primaryGenreName ? [row.primaryGenreName] : []),
	];

	return {
		providerExternalId: String(collectionId),
		title,
		description: undefined,
		imageUrl: row.artworkUrl600 || row.artworkUrl100 || row.artworkUrl60 || undefined,
		publisher: (row.artistName ?? '').trim() || undefined,
		feedUrl,
		websiteUrl: row.collectionViewUrl,
		genres: genres.length ? [...new Set(genres)] : undefined,
	};
}

export class ApplePodcastSearchProvider implements PodcastDiscoveryProvider {
	readonly id = 'apple';

	constructor(
		private readonly opts: {
			fetchImpl?: typeof fetch;
			timeoutMs?: number;
		} = {},
	) {}

	async search(query: string, searchOpts: { limit?: number } = {}): Promise<PodcastSearchHit[]> {
		const q = query.trim();
		if (!q) return [];
		const limit = searchOpts.limit ?? 50;
		const url = buildApplePodcastSearchUrl(q, limit);
		const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
		const controller = new AbortController();
		const timeoutMs = this.opts.timeoutMs ?? 10_000;
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetchImpl(url, {
				signal: controller.signal,
				headers: { Accept: 'application/json', 'User-Agent': 'VortiQuest/1.0' },
			});
			if (!res.ok) {
				throw new Error(`apple_podcast_search_${res.status}`);
			}
			const body = (await res.json()) as AppleSearchResponse;
			const hits: PodcastSearchHit[] = [];
			for (const row of body.results ?? []) {
				const mapped = mapApplePodcastResult(row);
				if (mapped) hits.push(mapped);
			}
			return hits;
		} finally {
			clearTimeout(timer);
		}
	}
}
