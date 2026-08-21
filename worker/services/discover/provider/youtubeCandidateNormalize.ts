import { parseYouTubeChannelInput, parseYouTubeVideoId, youtubeChannelUrl } from '../../../../src/lib/youtubeUrl';
import type { DiscoveryProviderRawHit } from './types';

export type ClassifiedYoutubeHit =
	| { kind: 'channelId'; channelId: string; url: string; title: string; description?: string }
	| { kind: 'handle'; handle: string; url: string; title: string; description?: string }
	| { kind: 'videoId'; videoId: string; url: string; title: string; description?: string }
	| { kind: 'custom'; path: string; url: string; title: string; description?: string }
	| { kind: 'invalid'; url: string; title: string; reason: string };

export function isYoutubeHost(hostname: string): boolean {
	const host = hostname.replace(/^www\./, '').toLowerCase();
	return (
		host === 'youtube.com' ||
		host === 'm.youtube.com' ||
		host === 'youtu.be' ||
		host === 'music.youtube.com' ||
		host === 'youtube-nocookie.com'
	);
}

export function classifyBraveYoutubeHit(hit: DiscoveryProviderRawHit): ClassifiedYoutubeHit {
	const title = hit.title || '';
	const description = hit.description;
	let url: URL;
	try {
		url = new URL(hit.url);
	} catch {
		return { kind: 'invalid', url: hit.url, title, reason: 'malformed_url' };
	}
	if (!isYoutubeHost(url.hostname)) {
		return { kind: 'invalid', url: hit.url, title, reason: 'non_youtube_host' };
	}

	const videoId = parseYouTubeVideoId(hit.url);
	if (videoId) {
		return { kind: 'videoId', videoId, url: hit.url, title, description };
	}

	const parsed = parseYouTubeChannelInput(hit.url);
	if (parsed.channelId) {
		return { kind: 'channelId', channelId: parsed.channelId, url: hit.url, title, description };
	}
	if (parsed.handle) {
		return { kind: 'handle', handle: parsed.handle, url: hit.url, title, description };
	}
	if (parsed.query) {
		return { kind: 'custom', path: parsed.query, url: hit.url, title, description };
	}
	return { kind: 'invalid', url: hit.url, title, reason: parsed.error ?? 'unrecognized_youtube_url' };
}

/** Deterministic typed-search relevance: query token overlap with title/description. */
export function scoreTypedBraveCandidate(
	query: string,
	candidate: { title: string; description?: string; publisher?: string },
): number {
	const tokens = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 2);
	if (!tokens.length) return 0;
	const hay = `${candidate.title} ${candidate.description ?? ''} ${candidate.publisher ?? ''}`.toLowerCase();
	let hits = 0;
	for (const token of tokens) {
		if (hay.includes(token)) hits += 1;
	}
	const coverage = hits / tokens.length;
	// Prefer title hits lightly by re-checking title-only coverage.
	const titleHay = candidate.title.toLowerCase();
	let titleHits = 0;
	for (const token of tokens) {
		if (titleHay.includes(token)) titleHits += 1;
	}
	return Math.round(coverage * 70 + (titleHits / tokens.length) * 30);
}

export const TYPED_BRAVE_MIN_RELEVANCE = 20;

export function candidateWatchUrl(channelId: string): string {
	return youtubeChannelUrl(channelId);
}
