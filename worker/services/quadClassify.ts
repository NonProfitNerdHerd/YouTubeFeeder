export type LiveSourceMode = 'normal' | 'always_on' | 'on_demand' | 'disabled';

export type QuadVideoStatus =
	| 'upcoming'
	| 'live'
	| 'completed'
	| 'private'
	| 'deleted'
	| 'unavailable'
	| 'non_embeddable'
	| 'unknown';

export const QUAD_SEARCH_DAILY_ALLOWANCE = 20;
export const QUAD_SEARCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const QUAD_MIN_CONFIRM_MS = 5 * 60 * 1000;
export const QUAD_MIN_DISCOVERY_MS = 15 * 60 * 1000;
export const QUAD_CONFIRM_TTL_MS = QUAD_MIN_CONFIRM_MS;
export const QUAD_DISCOVERY_TTL_MS = QUAD_MIN_DISCOVERY_MS;
export const QUAD_LOCK_TTL_MS = 60_000;
export const QUAD_PLAYER_ERROR_RATE_MS = 60_000;
export const QUAD_PLAYLIST_NEWEST = 50;

export function utcDay(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function plusMs(ms: number, now = new Date()): string {
	return new Date(now.getTime() + ms).toISOString();
}

export function isDue(iso: string | null | undefined, now: Date): boolean {
	if (!iso) return true;
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return true;
	return t <= now.getTime();
}

export function modeFlags(mode: LiveSourceMode): { enabled: boolean; skipDiscovery: boolean } {
	if (mode === 'disabled') return { enabled: false, skipDiscovery: false };
	if (mode === 'always_on') return { enabled: true, skipDiscovery: true };
	return { enabled: true, skipDiscovery: false };
}

export function resolveSourceMode(input: {
	enabled?: boolean;
	skipDiscovery?: boolean;
	sourceMode?: string | null;
}): LiveSourceMode {
	if (input.sourceMode === 'normal' || input.sourceMode === 'always_on' || input.sourceMode === 'on_demand' || input.sourceMode === 'disabled') {
		return input.sourceMode;
	}
	if (input.enabled === false) return 'disabled';
	if (input.skipDiscovery) return 'always_on';
	return 'normal';
}

export type QuadVerifyState = 'ok' | 'error';

export interface YoutubeLiveFields {
	id?: string;
	snippet?: { liveBroadcastContent?: string; title?: string };
	status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
	liveStreamingDetails?: { actualStartTime?: string; actualEndTime?: string; scheduledStartTime?: string };
}

export function isActuallyLiveVideo(video: YoutubeLiveFields | undefined): boolean {
	if (!video) return false;
	return (
		video.snippet?.liveBroadcastContent === 'live' &&
		Boolean(video.liveStreamingDetails?.actualStartTime) &&
		!video.liveStreamingDetails?.actualEndTime
	);
}

export function classifyYoutubeVideo(item: YoutubeLiveFields | undefined): QuadVideoStatus {
	if (!item?.id) return 'deleted';
	if (item.status?.privacyStatus === 'private') return 'private';
	if (item.status?.uploadStatus === 'deleted' || item.status?.uploadStatus === 'rejected') return 'deleted';
	if (isActuallyLiveVideo(item)) {
		if (item.status?.embeddable === false) return 'non_embeddable';
		return 'live';
	}
	const live = item.snippet?.liveBroadcastContent;
	if (live === 'upcoming') return 'upcoming';
	if (item.liveStreamingDetails?.actualEndTime) return 'completed';
	if (live === 'none') return 'completed';
	return 'unavailable';
}

export function isPlayableLive(status: QuadVideoStatus, embeddable: boolean): boolean {
	return status === 'live' && embeddable;
}

export function isVerifiedLiveStatus(status: QuadVideoStatus): boolean {
	return status === 'live' || status === 'non_embeddable';
}

export function isActiveLive(status: QuadVideoStatus, embeddable: boolean): boolean {
	return isPlayableLive(status, embeddable);
}

export function clampConfirmMs(seconds: number | undefined): number {
	const ms = (Number(seconds) || 300) * 1000;
	return Math.max(QUAD_MIN_CONFIRM_MS, ms);
}

export function clampDiscoveryMs(seconds: number | undefined): number {
	const ms = (Number(seconds) || 900) * 1000;
	return Math.max(QUAD_MIN_DISCOVERY_MS, ms);
}
