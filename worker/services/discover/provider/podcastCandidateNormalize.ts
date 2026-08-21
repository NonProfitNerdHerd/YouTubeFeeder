import type { PodcastDiscoverCandidate, PodcastSearchHit } from './podcastDiscoveryProvider';
import { TYPED_PODCAST_MIN_RELEVANCE } from './podcastDiscoveryProvider';
import { normalizePodcastFeedUrl } from './podcastFeedUrl';
import { scoreDiscoverTextMatch } from './scoreDiscoverTextMatch';

/** Deterministic 0–100 typed podcast relevance via shared Discover text match. */
export function scoreTypedPodcastCandidate(
	query: string,
	candidate: { title: string; description?: string; publisher?: string; genres?: string[]; providerRank?: number },
): number {
	return scoreDiscoverTextMatch(query, candidate);
}

export function hitsToPodcastCandidates(
	hits: PodcastSearchHit[],
	query: string,
	providerBackend: string,
): PodcastDiscoverCandidate[] {
	const byFeed = new Map<string, PodcastDiscoverCandidate>();
	hits.forEach((hit, providerRank) => {
		const feedUrlNormalized = normalizePodcastFeedUrl(hit.feedUrl);
		if (!feedUrlNormalized) return;
		const relevance = scoreTypedPodcastCandidate(query, {
			title: hit.title,
			description: hit.description,
			publisher: hit.publisher,
			genres: hit.genres,
			providerRank,
		});
		if (relevance < TYPED_PODCAST_MIN_RELEVANCE) return;

		const existing = byFeed.get(feedUrlNormalized);
		if (existing) {
			if (relevance > existing.relevance) {
				existing.relevance = relevance;
				existing.title = hit.title;
				existing.description = hit.description ?? existing.description;
				existing.imageUrl = hit.imageUrl ?? existing.imageUrl;
				existing.publisher = hit.publisher ?? existing.publisher;
				existing.providerExternalId = hit.providerExternalId;
				existing.feedUrl = hit.feedUrl.trim();
				existing.websiteUrl = hit.websiteUrl ?? existing.websiteUrl;
				existing.genres = hit.genres ?? existing.genres;
			}
			if (hit.websiteUrl) {
				existing.sourceUrls = [...new Set([...(existing.sourceUrls ?? []), hit.websiteUrl])];
			}
			return;
		}

		byFeed.set(feedUrlNormalized, {
			provider: 'podcast',
			type: 'podcast',
			feedUrl: hit.feedUrl.trim(),
			feedUrlNormalized,
			title: hit.title,
			description: hit.description?.slice(0, 500),
			imageUrl: hit.imageUrl,
			publisher: hit.publisher,
			providerBackend,
			providerExternalId: hit.providerExternalId,
			relevance,
			sourceUrls: hit.websiteUrl ? [hit.websiteUrl] : [],
			websiteUrl: hit.websiteUrl,
			genres: hit.genres,
		});
	});

	return [...byFeed.values()].sort((a, b) => {
		if (b.relevance !== a.relevance) return b.relevance - a.relevance;
		return a.title.localeCompare(b.title);
	});
}
