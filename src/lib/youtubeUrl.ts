const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

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
