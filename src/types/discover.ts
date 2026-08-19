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
}

export interface DiscoverBrowseResponse {
	forYou: DiscoverRecommendation[];
	forYouTotal?: number;
	forYouHasMore?: boolean;
	forYouInterests?: DiscoverInterest[];
	forYouEmpty?: boolean;
	forYouMessage?: string;
	forYouMetrics?: ForYouMetrics;
	forYouDebug?: CandidateScoreDebug[];
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
}

export interface DiscoverRecommendation extends DiscoveryResult {
	recommendationReason?: string;
	interestId?: string;
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
