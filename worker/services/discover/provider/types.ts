/** Shared DTOs for external Discover search providers (Brave first; YouTube/podcast later). */

export type DiscoverContentType = 'youtube' | 'podcast' | 'article' | 'web';

export interface DiscoverySearchRequest {
	contentType: DiscoverContentType;
	/** Original user query (not yet provider-rewritten). */
	query: string;
	/** Provider page index (Brave: 0–9). */
	offset?: number;
	/** Results per provider page (Brave max 20). */
	count?: number;
	strategyVersion?: string;
}

/** One raw hit from a provider before YouTube canonicalization / usable filtering. */
export interface DiscoveryProviderRawHit {
	title: string;
	url: string;
	description?: string;
	/** Provider-specific extras kept for later scoring (never secrets). */
	meta?: Record<string, unknown>;
}

/** Resolved YouTube channel candidate stored in the global provider cache (pre user-filter). */
export interface DiscoveryProviderCandidate {
	provider: 'youtube';
	type: 'channel';
	externalId: string;
	title: string;
	description?: string;
	imageUrl?: string;
	publisher?: string;
	watchUrl?: string;
	/** Source Brave URLs that mapped to this channel (debug). */
	sourceUrls?: string[];
}

export interface DiscoverySearchResult {
	hits: DiscoveryProviderRawHit[];
	/** Next provider page offset to request, or null if unknown/none. */
	nextOffset: number | null;
	moreAvailable: boolean;
	providerMeta?: {
		originalQuery?: string;
		alteredQuery?: string;
		/** Safe diagnostic fields only — never API keys. */
		[key: string]: unknown;
	};
}

export interface DiscoverySearchProvider {
	readonly id: string;
	search(request: DiscoverySearchRequest): Promise<DiscoverySearchResult>;
}

export type BraveProviderErrorCode =
	| 'missing_api_key'
	| 'timeout'
	| 'unauthorized'
	| 'forbidden'
	| 'rate_limited'
	| 'server_error'
	| 'network_error'
	| 'invalid_response'
	| 'empty_query';

export class BraveProviderError extends Error {
	readonly code: BraveProviderErrorCode;
	readonly status?: number;

	constructor(code: BraveProviderErrorCode, message: string, status?: number) {
		super(message);
		this.name = 'BraveProviderError';
		this.code = code;
		this.status = status;
	}
}

/** Cached pool row shape — raw hits vs usable candidates are separate for auto-paging. */
export interface DiscoverProviderCacheRecord {
	cacheKey: string;
	provider: string;
	contentType: string;
	normalizedQuery: string;
	strategyVersion: string;
	/** Accumulated raw provider hits across fetched pages. */
	rawResults: DiscoveryProviderRawHit[];
	/**
	 * Resolved channel candidates after normalize/resolve/dedupe.
	 * User-specific subscribed filtering happens after load — never mutate this globally for one user.
	 */
	candidates: DiscoveryProviderCandidate[];
	/** Last Brave `offset` (page index) successfully fetched. */
	providerOffset: number;
	moreResultsAvailable: boolean;
	/** How far the UI/consumer has walked into `candidates` (usable-pool cursor). */
	candidateConsumeOffset: number;
	rawResultCount: number;
	searchedAt: string;
	updatedAt: string;
	expiresAt: string;
	stale: boolean;
}

export interface DiscoverProviderCacheWrite {
	provider: string;
	contentType: string;
	normalizedQuery: string;
	strategyVersion: string;
	rawResults: DiscoveryProviderRawHit[];
	candidates?: DiscoveryProviderCandidate[];
	providerOffset: number;
	moreResultsAvailable: boolean;
	candidateConsumeOffset?: number;
}

/** Debug funnel for typed Brave Discover (not returned to ordinary clients). */
export interface TypedBraveSearchFunnel {
	rawBraveResults: number;
	validYoutubeUrls: number;
	channelUrls: number;
	videoUrls: number;
	customUrls: number;
	resolvedChannels: number;
	unresolvedResults: number;
	duplicateChannels: number;
	subscribedFiltered: number;
	qualityRejected: number;
	usableCandidates: number;
	bravePagesFetched: number;
	cacheHit: boolean;
	cacheMiss: boolean;
	youtubeVideosListCalls: number;
	youtubeChannelsListCalls: number;
	youtubeSearchListCalls: number;
	stopReason?: string;
}
