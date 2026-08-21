/**
 * Conservative podcast RSS/feed URL normalization for identity + dedupe.
 * Does NOT upgrade http→https (legacy feeds may not support TLS).
 */

const TRACKING_PARAMS = new Set([
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'fbclid',
	'gclid',
	'mc_cid',
	'mc_eid',
	'_ga',
]);

export function normalizePodcastFeedUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (!url.hostname) return null;

	url.hostname = url.hostname.toLowerCase();
	url.hash = '';

	const params = url.searchParams;
	for (const key of [...params.keys()]) {
		if (TRACKING_PARAMS.has(key.toLowerCase())) params.delete(key);
	}
	// Rebuild search without empty `?`
	const qs = params.toString();
	url.search = qs ? `?${qs}` : '';

	let path = url.pathname || '/';
	// Collapse trivial trailing slash (keep root `/`)
	if (path.length > 1 && path.endsWith('/')) {
		path = path.replace(/\/+$/, '');
	}
	url.pathname = path || '/';

	return url.toString();
}

/** Stable positive integer from feed URL for legacy external_feed_id column. */
export function feedUrlToExternalFeedId(feedUrlNormalized: string): number {
	let hash = 2166136261;
	for (let i = 0; i < feedUrlNormalized.length; i++) {
		hash ^= feedUrlNormalized.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	// Keep in signed 31-bit positive range (SQLite INTEGER friendly)
	return (hash >>> 0) % 2_100_000_000 || 1;
}
