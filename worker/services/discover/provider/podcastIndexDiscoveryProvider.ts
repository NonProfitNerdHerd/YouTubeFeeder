import { searchPodcastIndex } from '../podcastIndex';
import type { PodcastDiscoveryProvider, PodcastSearchHit } from './podcastDiscoveryProvider';

/** Optional Podcast Index backend behind the same discovery interface. */
export class PodcastIndexDiscoveryProvider implements PodcastDiscoveryProvider {
	readonly id = 'podcastindex';

	constructor(private readonly env: Env) {}

	async search(query: string, opts: { limit?: number } = {}): Promise<PodcastSearchHit[]> {
		const { feeds } = await searchPodcastIndex(this.env, query, opts.limit ?? 50);
		return feeds
			.filter((f) => Boolean(f.url?.trim() && f.title?.trim()))
			.map((f) => ({
				providerExternalId: String(f.id),
				title: f.title,
				description: f.description?.slice(0, 500),
				imageUrl: f.image || undefined,
				publisher: f.author || undefined,
				feedUrl: f.url,
			}));
	}
}
