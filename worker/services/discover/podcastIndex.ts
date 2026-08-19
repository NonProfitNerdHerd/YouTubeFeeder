async function sha1Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export interface PodcastIndexFeed {
	id: number;
	title: string;
	url: string;
	description: string;
	author: string;
	image: string;
}

export interface PodcastIndexEpisode {
	id: number;
	feedId: number;
	feedTitle: string;
	title: string;
	description: string;
	link: string;
	datePublished: number;
	enclosureUrl: string;
	duration: number;
	feedUrl: string;
	feedImage: string;
}

async function podcastIndexFetch<T>(
	env: Env,
	path: string,
	params: Record<string, string>,
): Promise<T> {
	const key = env.PODCAST_INDEX_KEY;
	const secret = env.PODCAST_INDEX_SECRET;
	if (!key || !secret) throw new Error('podcast_index_not_configured');

	const authDate = Math.floor(Date.now() / 1000).toString();
	const auth = await sha1Hex(`${key}${secret}${authDate}`);
	const url = new URL(`https://api.podcastindex.org/api/1.0/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

	const res = await fetch(url.toString(), {
		headers: {
			'User-Agent': 'VortiQuest/1.0',
			'X-Auth-Key': key,
			'X-Auth-Date': authDate,
			Authorization: auth,
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`podcast_index_${res.status}:${text.slice(0, 120)}`);
	}
	return (await res.json()) as T;
}

export async function searchPodcastIndex(
	env: Env,
	query: string,
	max = 20,
): Promise<{ feeds: PodcastIndexFeed[]; episodes: PodcastIndexEpisode[] }> {
	const trimmed = query.trim();
	if (!trimmed) return { feeds: [], episodes: [] };

	const body = await podcastIndexFetch<{ feeds?: PodcastIndexFeed[]; items?: PodcastIndexEpisode[] }>(
		env,
		'search/byterm',
		{ q: trimmed, max: String(max), clean: '1' },
	);
	return {
		feeds: body.feeds ?? [],
		episodes: body.items ?? [],
	};
}

export async function getPodcastFeedById(env: Env, feedId: number): Promise<PodcastIndexFeed | null> {
	const body = await podcastIndexFetch<{ feed?: PodcastIndexFeed }>(env, 'podcasts/byfeedid', {
		id: String(feedId),
	});
	return body.feed ?? null;
}
