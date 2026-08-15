export type ContentType = 'video' | 'live' | 'upcoming' | 'completed';
export type LivestreamStatus = 'none' | 'upcoming' | 'live' | 'completed';
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

export interface InboxItem {
	videoId: string;
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
}

export interface InboxCounts {
	inbox: number;
	unread: number;
	live: number;
	upcoming: number;
}

export interface ChannelRecord {
	channelId: string;
	title: string;
	description: string;
	thumbnailUrl: string;
	uploadsPlaylistId: string | null;
	subscribed: boolean;
	lastSynchronizedAt: string | null;
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
