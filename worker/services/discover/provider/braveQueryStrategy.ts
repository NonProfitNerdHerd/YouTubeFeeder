/**
 * Versioned Brave query construction for YouTube discovery.
 * Change constructions by bumping strategy version — do not hard-code a single final query forever.
 * Later evaluation metric: usable unique YouTube channels per Brave API request.
 */

export const BRAVE_YOUTUBE_STRATEGY_V1 = 'v1';
export const DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION = BRAVE_YOUTUBE_STRATEGY_V1;

export function buildBraveYoutubeSearchQuery(
	userQuery: string,
	strategyVersion: string = DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION,
): string {
	const q = userQuery.trim().replace(/\s+/g, ' ');
	if (!q) return '';

	switch (strategyVersion) {
		case BRAVE_YOUTUBE_STRATEGY_V1:
		default:
			// Provisional v1 — evaluate alternatives by usable-channel yield before promoting.
			return `site:youtube.com ${q}`;
	}
}
