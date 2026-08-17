import { useEffect, useRef } from 'react';
import {
	PROGRESS_PERSIST_MS,
	SAMPLE_INTERVAL_MS,
	createPlaybackSampler,
	meetsWatchThreshold,
	mergeStoredPlayback,
	samplePlayback,
	setSamplerPlaying,
	type PlaybackSampleState,
} from '../lib/watchProgress';

export type WatchPersistPayload = {
	playbackSeconds: number;
	lastPositionSeconds: number;
	ended?: boolean;
};

type PersistReason = 'interval' | 'pause' | 'ended' | 'threshold' | 'unload' | 'switch';

let iframeApiPromise: Promise<void> | null = null;

function loadYoutubeIframeApi(): Promise<void> {
	if (typeof window === 'undefined') return Promise.resolve();
	if (window.YT?.Player) return Promise.resolve();
	if (iframeApiPromise) return iframeApiPromise;
	iframeApiPromise = new Promise((resolve) => {
		const previous = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = () => {
			previous?.();
			resolve();
		};
		if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
			const tag = document.createElement('script');
			tag.src = 'https://www.youtube.com/iframe_api';
			document.head.appendChild(tag);
		}
		if (window.YT?.Player) resolve();
	});
	return iframeApiPromise;
}

const PLAYER_PLAYING = 1;
const PLAYER_ENDED = 0;

export function FeedYouTubePlayer({
	videoId,
	title,
	durationSeconds,
	initialPlaybackSeconds,
	onPersist,
}: {
	videoId: string;
	title: string;
	durationSeconds: number | null;
	initialPlaybackSeconds: number;
	onPersist: (videoId: string, payload: WatchPersistPayload, options?: { keepalive?: boolean }) => void;
}) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const playerRef = useRef<YT.Player | null>(null);
	const samplerRef = useRef<PlaybackSampleState>(createPlaybackSampler(initialPlaybackSeconds));
	const lastSentSecondsRef = useRef(initialPlaybackSeconds);
	const endedRef = useRef(false);
	const persistRef = useRef(onPersist);
	const durationRef = useRef(durationSeconds);
	const seedRef = useRef(initialPlaybackSeconds);
	persistRef.current = onPersist;
	durationRef.current = durationSeconds;
	seedRef.current = initialPlaybackSeconds;

	useEffect(() => {
		samplerRef.current = {
			...samplerRef.current,
			playbackSeconds: mergeStoredPlayback(initialPlaybackSeconds, samplerRef.current.playbackSeconds),
		};
	}, [initialPlaybackSeconds]);

	useEffect(() => {
		let cancelled = false;
		let pollId: number | null = null;
		let persistId: number | null = null;
		let player: YT.Player | null = null;
		const activeId = videoId;
		endedRef.current = false;
		samplerRef.current = createPlaybackSampler(seedRef.current);
		lastSentSecondsRef.current = seedRef.current;

		const snapshot = (): WatchPersistPayload => ({
			playbackSeconds: samplerRef.current.playbackSeconds,
			lastPositionSeconds: (() => {
				try {
					return playerRef.current?.getCurrentTime() ?? 0;
				} catch {
					return 0;
				}
			})(),
			ended: endedRef.current || undefined,
		});

		const persist = (reason: PersistReason, keepalive = false) => {
			const payload = snapshot();
			const grew = payload.playbackSeconds > lastSentSecondsRef.current + 0.05;
			const must = reason === 'ended' || reason === 'threshold' || reason === 'unload' || reason === 'switch';
			if (!grew && !payload.ended && !must) return;
			if (payload.playbackSeconds <= 0 && !payload.ended && reason !== 'ended') return;
			lastSentSecondsRef.current = payload.playbackSeconds;
			persistRef.current(activeId, payload, { keepalive });
		};

		const tick = () => {
			const current = playerRef.current;
			if (!current || !samplerRef.current.playing) return;
			let time = 0;
			let rate = 1;
			try {
				time = current.getCurrentTime();
				rate = current.getPlaybackRate() || 1;
			} catch {
				return;
			}
			samplerRef.current = samplePlayback(samplerRef.current, time, Date.now(), rate);
			if (
				!endedRef.current &&
				meetsWatchThreshold(samplerRef.current.playbackSeconds, durationRef.current, false)
			) {
				persist('threshold');
			}
		};

		const onState = (state: number) => {
			if (state === PLAYER_PLAYING) {
				endedRef.current = false;
				samplerRef.current = setSamplerPlaying(samplerRef.current, true);
				tick();
				return;
			}
			if (state === PLAYER_ENDED) {
				endedRef.current = true;
				samplerRef.current = setSamplerPlaying(samplerRef.current, false);
				persist('ended');
				return;
			}
			const wasPlaying = samplerRef.current.playing;
			samplerRef.current = setSamplerPlaying(samplerRef.current, false);
			if (wasPlaying) persist('pause');
		};

		const onHidden = () => {
			if (document.visibilityState === 'hidden') persist('unload', true);
		};
		const onPageHide = () => persist('unload', true);

		void loadYoutubeIframeApi().then(() => {
			if (cancelled || !hostRef.current || !window.YT?.Player) return;
			player = new window.YT.Player(hostRef.current, {
				videoId: activeId,
				host: 'https://www.youtube-nocookie.com',
				width: '100%',
				height: '100%',
				playerVars: {
					rel: 0,
					modestbranding: 1,
					playsinline: 1,
					enablejsapi: 1,
					origin: window.location.origin,
				},
				events: {
					onStateChange: (event) => onState(event.data),
				},
			});
			playerRef.current = player;
			pollId = window.setInterval(tick, SAMPLE_INTERVAL_MS);
			persistId = window.setInterval(() => persist('interval'), PROGRESS_PERSIST_MS);
		});

		document.addEventListener('visibilitychange', onHidden);
		window.addEventListener('pagehide', onPageHide);

		return () => {
			cancelled = true;
			persist('switch', true);
			document.removeEventListener('visibilitychange', onHidden);
			window.removeEventListener('pagehide', onPageHide);
			if (pollId != null) window.clearInterval(pollId);
			if (persistId != null) window.clearInterval(persistId);
			try {
				player?.destroy();
			} catch {
				/* player may already be gone */
			}
			playerRef.current = null;
		};
	}, [videoId]);

	return (
		<div className="yt-frame" title={title}>
			<div ref={hostRef} />
		</div>
	);
}
