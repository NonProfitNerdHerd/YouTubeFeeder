export type ContentType = 'video' | 'live' | 'upcoming' | 'completed';
export type LivestreamStatus = 'none' | 'upcoming' | 'live' | 'completed';
export type LiveSourceMode = 'normal' | 'always_on' | 'on_demand' | 'disabled';
export type InboxView =
	| 'inbox'
	| 'unread'
	| 'live'
	| 'upcoming'
	| 'videos'
	| 'starred'
	| 'archived'
	| 'channels'
	| 'quad'
	| 'layouts'
	| 'settings';

export type InboxSort = 'newest' | 'oldest' | 'channel' | 'liveFirst';

export type MediaKind = 'youtube' | 'podcast';

export interface InboxItem {
	videoId: string;
	mediaKind?: MediaKind;
	audioUrl?: string;
	channelId: string;
	channelTitle: string;
	channelThumbnailUrl: string;
	title: string;
	descriptionExcerpt: string;
	thumbnailUrl: string;
	publishedAt: string | null;
	scheduledStartAt: string | null;
	actualStartAt: string | null;
	actualEndAt: string | null;
	durationSeconds: number | null;
	contentType: ContentType;
	livestreamStatus: LivestreamStatus;
	embeddable: boolean;
	unread: boolean;
	starred: boolean;
	archived: boolean;
	hidden: boolean;
	firstSeenAt: string;
	snoozedUntil: string | null;
	notes: string;
	watchedAt: string | null;
	playbackSeconds: number;
	lastPositionSeconds: number;
	watchUpdatedAt: string | null;
}

export type WatchedFilter = 'all' | 'watched' | 'unwatched';

export interface InboxWatchFields {
	watchedAt: string | null;
	playbackSeconds: number;
	lastPositionSeconds: number;
	watchUpdatedAt: string | null;
}

export interface InboxCounts {
	inbox: number;
	unread: number;
	live: number;
	upcoming: number;
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
	categoryIds: string[];
}

export interface ChannelRecord {
	channelId: string;
	title: string;
	description: string;
	thumbnailUrl: string;
	uploadsPlaylistId: string | null;
	subscribed: boolean;
	lastSynchronizedAt: string | null;
	followInInbox: boolean;
	maxVideosToPull: number;
	/** Active inbox videos for this channel (same filters as the default Inbox view). */
	inboxVideoCount: number;
	categoryIds: string[];
}

export interface CategoryRecord {
	id: string;
	name: string;
}

export interface WatchlistRecord {
	id: string;
	name: string;
	videoCount: number;
}

export interface QuadSlots {
	slot1: string | null;
	slot2: string | null;
	slot3: string | null;
	slot4: string | null;
}

export interface QuadLayout {
	id: string;
	name: string;
	slots: QuadSlots;
	createdAt: string;
	updatedAt: string;
}

export interface AppSettings {
	syncEnabled: boolean;
	syncIntervalMinutes: number;
	defaultInboxFilter: InboxView;
	defaultQuadAudio: 'oneActive' | 'allMuted';
	theme: 'dark' | 'light';
	liveStatusRefreshSeconds: number;
}

export interface SyncRunSummary {
	id: string;
	syncType: 'subscriptions' | 'content' | 'live' | 'test';
	status: 'running' | 'ok' | 'error' | 'quota';
	startedAt: string;
	completedAt: string | null;
	channelsChecked: number;
	videosAdded: number;
	videosUpdated: number;
	estimatedQuotaUnits: number;
	errorSummary: string | null;
}

export interface CurrentUser {
	id: string;
	googleAccountId: string;
	displayName: string;
	connected: boolean;
	mock: boolean;
}

export interface ApiErrorBody {
	error: {
		code: string;
		message: string;
	};
}

export interface InboxQuery {
	view: InboxView;
	sort: InboxSort;
	unreadOnly: boolean;
	search: string;
	channelId: string | null;
}

export interface VideoClassificationInput {
	liveBroadcastContent?: string;
	scheduledStartTime?: string | null;
	actualStartTime?: string | null;
	actualEndTime?: string | null;
}

export interface VideoClassification {
	contentType: ContentType;
	livestreamStatus: LivestreamStatus;
}

export const LIVE_GRID_SIZES = [1, 4, 6, 8, 12] as const;
export type LiveGridSize = (typeof LIVE_GRID_SIZES)[number];
export const MAX_LIVE_SLOTS = 12;

export function isLiveGridSize(value: number): value is LiveGridSize {
	return (LIVE_GRID_SIZES as readonly number[]).includes(value);
}

export interface LiveVideoRecord {
	videoId: string;
	title: string;
	status?: string;
	embeddable?: boolean;
}

export interface LiveSourceRecord {
	id: string;
	displayName: string;
	channelId: string;
	youtubeUrl: string;
	notes: string;
	enabled: boolean;
	skipDiscovery: boolean;
	sourceMode: LiveSourceMode;
	isLive: boolean;
	liveVideoId: string | null;
	liveTitle: string | null;
	liveCheckedAt: string | null;
	knownLiveVideoId: string | null;
	lastStatusCheckAt: string | null;
	lastDiscoveryAt: string | null;
	nextStatusCheckAt: string | null;
	nextDiscoveryAt: string | null;
	searchCooldownUntil: string | null;
	lastPlayerErrorAt: string | null;
	verifyState: 'ok' | 'error';
	verifyError: string | null;
	liveVideos: LiveVideoRecord[];
	categoryIds: string[];
}

export interface LiveSlotRecord {
	slotNumber: number;
	sourceId: string | null;
	videoId: string | null;
	source: LiveSourceRecord | null;
}

export interface LiveSessionRecord {
	gridSize: LiveGridSize;
	slots: LiveSlotRecord[];
}

export interface LiveLayoutRecord {
	id: string;
	name: string;
	description: string;
	gridSize: LiveGridSize;
	slotIds: Array<string | null>;
}
