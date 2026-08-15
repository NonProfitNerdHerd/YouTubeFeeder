import type { VideoClassification, VideoClassificationInput } from '../types';

export function classifyYouTubeVideo(input: VideoClassificationInput): VideoClassification {
	const live = (input.liveBroadcastContent ?? 'none').toLowerCase();
	if (live === 'live' || (input.actualStartTime && !input.actualEndTime && live !== 'upcoming')) {
		return { contentType: 'live', livestreamStatus: 'live' };
	}
	if (live === 'upcoming' || (input.scheduledStartTime && !input.actualStartTime && live !== 'none')) {
		return { contentType: 'upcoming', livestreamStatus: 'upcoming' };
	}
	if (live === 'completed' || input.actualEndTime) {
		return { contentType: 'completed', livestreamStatus: 'completed' };
	}
	return { contentType: 'video', livestreamStatus: 'none' };
}

export function applyLivestreamTransition(
	previous: VideoClassification,
	next: VideoClassification,
): { classification: VideoClassification; shouldCreateInboxEntry: boolean } {
	if (previous.livestreamStatus === next.livestreamStatus && previous.contentType === next.contentType) {
		return { classification: next, shouldCreateInboxEntry: false };
	}
	return { classification: next, shouldCreateInboxEntry: false };
}
