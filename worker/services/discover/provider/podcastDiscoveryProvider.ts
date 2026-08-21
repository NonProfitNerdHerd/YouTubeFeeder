/** Replaceable podcast discovery providers — search only; RSS is authoritative after follow. */

export interface PodcastSearchHit {
	/** Provider-native id (Apple collectionId, Podcast Index feed id, …). Not canonical. */
	providerExternalId: string;
	title: string;
	description?: string;
	imageUrl?: string;
	publisher?: string;
	/** Raw feed URL from provider — required. */
	feedUrl: string;
	websiteUrl?: string;
	genres?: string[];
}

export interface PodcastDiscoveryProvider {
	readonly id: string;
	search(query: string, opts?: { limit?: number }): Promise<PodcastSearchHit[]>;
}

export interface PodcastDiscoverCandidate {
	provider: 'podcast';
	type: 'podcast';
	feedUrl: string;
	feedUrlNormalized: string;
	title: string;
	description?: string;
	imageUrl?: string;
	publisher?: string;
	providerBackend: string;
	providerExternalId: string;
	/** Deterministic 0–100 typed relevance. */
	relevance: number;
	sourceUrls?: string[];
	websiteUrl?: string;
	genres?: string[];
}

export const PODCAST_DISCOVER_STRATEGY_VERSION = 'v1';
export const PODCAST_DISCOVER_RESOLVER_VERSION = 'v1';
export const DEFAULT_TYPED_PODCAST_RESULT_LIMIT = 42;
export const TYPED_PODCAST_MIN_RELEVANCE = 15;
