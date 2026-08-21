/**
 * Versioned Brave query construction for YouTube discovery.
 * Change constructions by bumping strategy version — evaluate by usable unique channels per Brave request.
 */

export const BRAVE_YOUTUBE_STRATEGY_V1 = 'v1';
export const DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION = BRAVE_YOUTUBE_STRATEGY_V1;

/**
 * V1 (selected for Phase 3): `site:youtube.com {query}`
 *
 * Why: broader than `@`-only queries — Brave returns channel pages and videos; videos resolve via
 * inexpensive videos.list → channelId, raising usable unique channels per Brave request.
 * Handle-only (`site:youtube.com/@ {query}`) under-produced channel cards in strategy evaluation.
 */
export function buildBraveYoutubeSearchQuery(
	userQuery: string,
	strategyVersion: string = DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION,
): string {
	const q = userQuery.trim().replace(/\s+/g, ' ');
	if (!q) return '';

	switch (strategyVersion) {
		case 'v1-at':
			// Alternate construction kept for offline A/B — not default.
			return `site:youtube.com/@ ${q}`;
		case BRAVE_YOUTUBE_STRATEGY_V1:
		default:
			return `site:youtube.com ${q}`;
	}
}
