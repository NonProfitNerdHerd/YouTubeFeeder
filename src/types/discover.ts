export type DiscoveryProvider = 'youtube' | 'podcast' | 'local';
export type DiscoveryResultType = 'channel' | 'video' | 'podcast' | 'episode' | 'live';
export type DiscoverFilter = 'all' | 'podcasts' | 'youtube' | 'live';

export interface DiscoveryResult {
	provider: DiscoveryProvider;
	type: DiscoveryResultType;
	externalId: string;
	title: string;
	description?: string;
	imageUrl?: string;
	publisher?: string;
	publishedAt?: string | null;
	durationSeconds?: number | null;
	feedUrl?: string;
	parentExternalId?: string;
	parentTitle?: string;
	subscribed?: boolean;
	playable?: boolean;
	watchUrl?: string;
}

export interface DiscoverSearchResponse {
	query: string;
	filter: DiscoverFilter;
	results: DiscoveryResult[];
	warnings: Array<{ provider: DiscoveryProvider; message: string }>;
	cached: boolean;
	searchedAt: string;
	/** More YouTube Discover candidates available for "Add more". */
	hasMore?: boolean;
	/** Absolute offset to request for the next typed-search page. */
	nextOffset?: number;
}

export interface DiscoverBrowseResponse {
	forYou: DiscoverRecommendation[];
	forYouTotal?: number;
	forYouHasMore?: boolean;
	forYouInterests?: DiscoverInterest[];
	forYouEmpty?: boolean;
	forYouMessage?: string;
	forYouSupportingMessage?: string;
	forYouMetrics?: ForYouMetrics;
	forYouDebug?: CandidateScoreDebug[];
	forYouPipelineDebug?: ForYouPipelineDebug[];
	popularChannels: DiscoveryResult[];
	popularInterestChannels?: DiscoverRecommendation[];
	popularInterestLabel?: string;
	recentlyFollowed: DiscoveryResult[];
	refreshedAt: string;
}

export type DiscoverBrowseTab = 'forYou' | 'popular' | 'recent';

export interface DiscoverInterest {
	id: string;
	label: string;
	confidence: number;
}

export interface ForYouMetrics {
	retrieved: number;
	rejected: number;
	accepted: number;
	interestsRepresented: number;
	searchCalls: number;
	persistedActive?: number;
	persistedRetired?: number;
	cacheHits?: number;
	newlyPersisted?: number;
}

export interface ForYouPipelineDebug {
	interestId: string;
	interestLabel: string;
	channelCount: number;
	videosSampled: number;
	fingerprint: Array<{ text: string; weight: number; channelCoverage?: number }>;
	clusters: Array<{ id: string; confidence: number; phrases: string[] }>;
	queries: string[];
	cacheHits: number;
	liveSearches: number;
	rawCandidates: number;
	rejected: number;
	accepted: number;
	persistedActive: number;
	feedbackSuppressed: number;
	returned: number;
}

export interface CandidateScoreDebug {
	candidateTitle: string;
	candidateId: string;
	interestId: string;
	interestLabel: string;
	positive: string[];
	negative: string[];
	score: number;
	threshold: number;
	result: 'ACCEPT' | 'REJECT';
	baseScore?: number;
	feedbackPositive?: number;
	feedbackNegative?: number;
	finalScore?: number;
	contributingFeedbackIds?: string[];
}

export type RecommendationFeedbackAction = 'followed' | 'channel_not_interested' | 'not_relevant';

export interface RecommendationHistoryEntry {
	id: string;
	provider: DiscoveryProvider;
	externalId: string;
	channelTitle: string;
	channelThumbnail: string;
	interestId: string | null;
	interestLabel: string | null;
	action: RecommendationFeedbackAction;
	actionLabel: string;
	recommendationReason: string | null;
	createdAt: string;
	restoredAt: string | null;
	active: boolean;
}

export interface DiscoverRecommendation extends DiscoveryResult {
	recommendationReason?: string;
	interestId?: string;
	interestLabel?: string;
	recommendationToken?: string;
}

export interface PodcastSubscriptionRecord {
	podcastId: string;
	externalFeedId: number;
	feedUrl: string;
	title: string;
	publisher: string;
	description: string;
	imageUrl: string;
	followInInbox: boolean;
	maxEpisodesToPull: number;
	inboxEpisodeCount: number;
	lastPolledAt: string | null;
	subscribedAt: string;
}
