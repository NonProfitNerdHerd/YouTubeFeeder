export {};

declare global {
	interface Window {
		YT?: typeof YT;
		onYouTubeIframeAPIReady?: () => void;
	}

	namespace YT {
		const PlayerState: {
			UNSTARTED: -1;
			ENDED: 0;
			PLAYING: 1;
			PAUSED: 2;
			BUFFERING: 3;
			CUED: 5;
		};

		class Player {
			constructor(element: HTMLElement | string, options: PlayerOptions);
			destroy(): void;
			getCurrentTime(): number;
			getDuration(): number;
			getPlaybackRate(): number;
			getPlayerState(): number;
		}

		interface PlayerOptions {
			videoId?: string;
			host?: string;
			width?: string | number;
			height?: string | number;
			playerVars?: Record<string, string | number>;
			events?: {
				onReady?: (event: { target: Player }) => void;
				onStateChange?: (event: { data: number; target: Player }) => void;
			};
		}
	}
}
