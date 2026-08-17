import { describe, expect, it } from 'vitest';
import {
	createPlaybackSampler,
	meetsWatchThreshold,
	mergeStoredPlayback,
	samplePlayback,
	setSamplerPlaying,
} from '../../src/lib/watchProgress';

function play(seconds: number, opts?: { start?: number; rate?: number; step?: number; wallScale?: number }) {
	let state = setSamplerPlaying(createPlaybackSampler(opts?.start ?? 0), true);
	const step = opts?.step ?? 0.4;
	const rate = opts?.rate ?? 1;
	const wallScale = opts?.wallScale ?? 1;
	let t = 0;
	let wall = 0;
	state = samplePlayback(state, t, wall, rate);
	while (t + 1e-9 < seconds) {
		const next = Math.min(seconds, t + step);
		const dt = next - t;
		t = next;
		wall += (dt / rate) * 1000 * wallScale;
		state = samplePlayback(state, t, wall, rate);
	}
	return state;
}

describe('watchProgress threshold', () => {
	it('does not mark watched on open, select, or a brief play-pause', () => {
		expect(meetsWatchThreshold(0, 600, false)).toBe(false);
		const started = setSamplerPlaying(createPlaybackSampler(0), true);
		const first = samplePlayback(started, 0, 0, 1);
		expect(first.playbackSeconds).toBe(0);
		const paused = setSamplerPlaying(samplePlayback(first, 0.2, 200, 1), false);
		expect(paused.playbackSeconds).toBeLessThan(1);
		expect(meetsWatchThreshold(paused.playbackSeconds, 600, false)).toBe(false);
	});

	it('does not treat a YouTube outbound click as watched', () => {
		expect(meetsWatchThreshold(0, 45, false)).toBe(false);
	});

	it('marks watched at 30 seconds of genuine playback', () => {
		expect(meetsWatchThreshold(29.9, 600, false)).toBe(false);
		expect(meetsWatchThreshold(30, 600, false)).toBe(true);
	});

	it('marks short videos at 50% when duration is under 60s', () => {
		expect(meetsWatchThreshold(19, 40, false)).toBe(false);
		expect(meetsWatchThreshold(20, 40, false)).toBe(true);
		expect(meetsWatchThreshold(20, 60, false)).toBe(false);
	});

	it('uses only the 30s rule when duration is missing or live', () => {
		expect(meetsWatchThreshold(29, null, false)).toBe(false);
		expect(meetsWatchThreshold(30, null, false)).toBe(true);
		expect(meetsWatchThreshold(29, Number.NaN, false)).toBe(false);
	});

	it('marks watched when the player reports ended', () => {
		expect(meetsWatchThreshold(1, 600, true)).toBe(true);
		expect(meetsWatchThreshold(0, null, true)).toBe(true);
	});
});

describe('watchProgress sampler', () => {
	it('does not count while paused, buffering, or not playing', () => {
		const paused = samplePlayback(createPlaybackSampler(5), 20, 1_000, 1);
		expect(paused.playbackSeconds).toBe(5);
		const buffering = samplePlayback(setSamplerPlaying(createPlaybackSampler(0), false), 4, 400, 1);
		expect(buffering.playbackSeconds).toBe(0);
	});

	it('does not inflate seconds on a seek jump', () => {
		let state = setSamplerPlaying(createPlaybackSampler(0), true);
		state = samplePlayback(state, 10, 0, 1);
		state = samplePlayback(state, 80, 400, 1);
		expect(state.playbackSeconds).toBe(0);
	});

	it('accumulates two 15s genuine stretches to 30s', () => {
		const first = play(15);
		expect(first.playbackSeconds).toBeGreaterThanOrEqual(14.5);
		expect(first.playbackSeconds).toBeLessThan(16);
		const resumed = play(16, { start: first.playbackSeconds });
		expect(resumed.playbackSeconds).toBeGreaterThanOrEqual(29.5);
		expect(meetsWatchThreshold(resumed.playbackSeconds, 600, false)).toBe(true);
	});

	it('caps counted time against wall clock so rate-1 playback cannot race ahead', () => {
		let state = setSamplerPlaying(createPlaybackSampler(0), true);
		state = samplePlayback(state, 0, 0, 1);
		state = samplePlayback(state, 1.5, 400, 1);
		expect(state.playbackSeconds).toBeLessThanOrEqual(0.4 * 1.25 + 1e-9);
	});

	it('never rewinds stored progress when merging tabs', () => {
		expect(mergeStoredPlayback(40, 12)).toBe(40);
		expect(mergeStoredPlayback(12, 18)).toBe(18);
	});
});
