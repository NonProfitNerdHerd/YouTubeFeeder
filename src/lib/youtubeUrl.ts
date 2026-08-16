const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;

export function isYouTubeChannelId(value: string): boolean {
	return CHANNEL_ID.test(value);
}

export function youtubeChannelUrl(channelId: string): string {
	return `https://www.youtube.com/channel/${channelId}`;
}

export function parseYouTubeChannelInput(input: string): { channelId?: string; handle?: string; query?: string; error?: string } {
	const trimmed = input.trim();
	if (!trimmed) return { error: 'Channel ID or URL is required.' };
	if (isYouTubeChannelId(trimmed)) return { channelId: trimmed };
	if (trimmed.startsWith('@') && trimmed.length > 1) return { handle: trimmed.slice(1) };

	let url: URL;
	try {
		url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
	} catch {
		return { error: 'Paste a YouTube channel URL, @handle, or UC… channel ID.' };
	}

	const host = url.hostname.replace(/^www\./, '').toLowerCase();
	if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') {
		return { error: 'Use a youtube.com channel URL, @handle, or UC… ID.' };
	}

	const parts = url.pathname.split('/').filter(Boolean);
	const channelIdx = parts.indexOf('channel');
	if (channelIdx >= 0 && parts[channelIdx + 1] && isYouTubeChannelId(parts[channelIdx + 1])) {
		return { channelId: parts[channelIdx + 1] };
	}
	if (parts[0]?.startsWith('@')) return { handle: parts[0].slice(1) };
	if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) return { query: parts[1] };
	if (parts[0] && !['watch', 'embed', 'shorts', 'live', 'playlist', 'feed'].includes(parts[0])) {
		return { query: parts[0] };
	}
	return { error: 'Could not find a channel in that URL. Paste a /channel/UC… link, @handle, or UC… ID.' };
}

export function parseYouTubeVideoId(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (VIDEO_ID.test(trimmed)) return trimmed;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}

	const host = url.hostname.replace(/^www\./, '').toLowerCase();
	if (host === 'youtu.be') {
		const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
		return VIDEO_ID.test(id) ? id : null;
	}

	if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
		const v = url.searchParams.get('v');
		if (v && VIDEO_ID.test(v)) return v;

		const parts = url.pathname.split('/').filter(Boolean);
		if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'v') {
			const id = parts[1] ?? '';
			return VIDEO_ID.test(id) ? id : null;
		}
	}

	return null;
}

export function youtubeWatchUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export function youtubeEmbedUrl(videoId: string, options?: { mute?: boolean; autoplay?: boolean }): string {
	const params = new URLSearchParams({ rel: '0' });
	if (options?.mute) params.set('mute', '1');
	if (options?.autoplay) params.set('autoplay', '1');
	return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}
