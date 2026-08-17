import type { WatchedFilter } from '../types';

export type { WatchedFilter };

export const WATCHED_SECONDS = 30;
export const SHORT_VIDEO_MAX_SECONDS = 60;
export const SHORT_VIDEO_FRACTION = 0.5;
export const SEEK_MAX_STEP_SECONDS = 2;
export const WALL_CLOCK_SLACK = 1.25;
export const SAMPLE_INTERVAL_MS = 400;
export const PROGRESS_PERSIST_MS = 12_000;

export function parseWatchedFilter(value: string | null | undefined): WatchedFilter {
	if (value === 'watched' || value === 'unwatched') return value;
	return 'all';
}

export function matchesWatchedFilter(watchedAt: string | null | undefined, filter: WatchedFilter): boolean {
	if (filter === 'watched') return Boolean(watchedAt);
	if (filter === 'unwatched') return !watchedAt;
	return true;
}

export function meetsWatchThreshold(
	playbackSeconds: number,
	durationSeconds: number | null | undefined,
	ended = false,
): boolean {
	if (ended) return true;
	if (!Number.isFinite(playbackSeconds) || playbackSeconds < 0) return false;
	if (playbackSeconds >= WATCHED_SECONDS) return true;
	if (
		durationSeconds != null &&
		Number.isFinite(durationSeconds) &&
		durationSeconds > 0 &&
		durationSeconds < SHORT_VIDEO_MAX_SECONDS &&
		playbackSeconds >= durationSeconds * SHORT_VIDEO_FRACTION
	) {
		return true;
	}
	return false;
}

export type PlaybackSampleState = {
	playing: boolean;
	lastTime: number | null;
	lastWall: number | null;
	playbackSeconds: number;
};

export function createPlaybackSampler(initialSeconds = 0): PlaybackSampleState {
	return {
		playing: false,
		lastTime: null,
		lastWall: null,
		playbackSeconds: Math.max(0, initialSeconds),
	};
}

export function setSamplerPlaying(state: PlaybackSampleState, playing: boolean): PlaybackSampleState {
	if (!playing) {
		return { ...state, playing: false, lastTime: null, lastWall: null };
	}
	return { ...state, playing: true };
}

/** Count only small forward playhead steps while PLAYING. Seeks, pauses, and buffering add 0. */
export function samplePlayback(
	state: PlaybackSampleState,
	currentTime: number,
	nowMs: number,
	playbackRate = 1,
): PlaybackSampleState {
	if (!state.playing) return state;
	if (!Number.isFinite(currentTime) || !Number.isFinite(nowMs)) return state;
	const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
	if (state.lastTime == null || state.lastWall == null) {
		return { ...state, lastTime: currentTime, lastWall: nowMs };
	}
	const dPos = currentTime - state.lastTime;
	const dWall = ((nowMs - state.lastWall) / 1000) * rate;
	let add = 0;
	if (dPos > 0 && dPos <= SEEK_MAX_STEP_SECONDS) {
		add = Math.max(0, Math.min(dPos, dWall * WALL_CLOCK_SLACK));
	}
	return {
		...state,
		lastTime: currentTime,
		lastWall: nowMs,
		playbackSeconds: state.playbackSeconds + add,
	};
}

export function mergeStoredPlayback(stored: number, local: number): number {
	const a = Number.isFinite(stored) ? stored : 0;
	const b = Number.isFinite(local) ? local : 0;
	return Math.max(0, a, b);
}
