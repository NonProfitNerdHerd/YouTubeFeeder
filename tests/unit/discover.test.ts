import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { episodeIdFor, isPodcastEpisodeId, mergeInboxItems, mockDiscoveryResults } from '../../worker/db/podcasts';
import { parseRssItemsForTest } from '../../worker/services/discover/rss';

describe('discover podcasts', () => {
	it('builds stable podcast episode ids', () => {
		const a = episodeIdFor('https://example.com/feed.xml', 'guid-1');
		const b = episodeIdFor('https://example.com/feed.xml', 'guid-1');
		expect(a).toBe(b);
		expect(isPodcastEpisodeId(a)).toBe(true);
		expect(isPodcastEpisodeId('dQw4w9WgXcQ')).toBe(false);
	});

	it('merges youtube and podcast inbox rows by date', () => {
		const merged = mergeInboxItems(
			[
				{
					videoId: 'yt1',
					mediaKind: 'youtube',
					channelId: 'c1',
					channelTitle: 'C',
					channelThumbnailUrl: '',
					title: 'Video',
					descriptionExcerpt: '',
					thumbnailUrl: '',
					publishedAt: '2026-01-02T00:00:00.000Z',
					scheduledStartAt: null,
					actualStartAt: null,
					actualEndAt: null,
					durationSeconds: null,
					contentType: 'video',
					livestreamStatus: 'none',
					embeddable: true,
					unread: true,
					starred: false,
					archived: false,
					hidden: false,
					firstSeenAt: '2026-01-02T00:00:00.000Z',
					snoozedUntil: null,
					notes: '',
					watchedAt: null,
					playbackSeconds: 0,
					lastPositionSeconds: 0,
					watchUpdatedAt: null,
				},
			],
			[
				{
					videoId: 'pe_abc',
					mediaKind: 'podcast',
					audioUrl: 'https://example.com/ep.mp3',
					channelId: 'p1',
					channelTitle: 'Pod',
					channelThumbnailUrl: '',
					title: 'Episode',
					descriptionExcerpt: '',
					thumbnailUrl: '',
					publishedAt: '2026-01-03T00:00:00.000Z',
					scheduledStartAt: null,
					actualStartAt: null,
					actualEndAt: null,
					durationSeconds: 100,
					contentType: 'video',
					livestreamStatus: 'none',
					embeddable: true,
					unread: true,
					starred: false,
					archived: false,
					hidden: false,
					firstSeenAt: '2026-01-03T00:00:00.000Z',
					snoozedUntil: null,
					notes: '',
					watchedAt: null,
					playbackSeconds: 0,
					lastPositionSeconds: 0,
					watchUpdatedAt: null,
				},
			],
			10,
		);
		expect(merged[0]?.videoId).toBe('pe_abc');
		expect(merged[1]?.videoId).toBe('yt1');
	});

	it('keeps mockDiscoveryResults as a test fixture helper only', () => {
		const results = mockDiscoveryResults('weather', new Set());
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.type === 'podcast' || r.type === 'episode')).toBe(true);
	});

	it('parses RSS items', () => {
		const xml = `<?xml version="1.0"?><rss><channel><item>
			<title>Episode One</title>
			<guid>ep-1</guid>
			<pubDate>Mon, 01 Jan 2026 12:00:00 GMT</pubDate>
			<enclosure url="https://example.com/a.mp3" type="audio/mpeg"/>
		</item></channel></rss>`;
		const items = parseRssItemsForTest(xml);
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe('Episode One');
		expect(items[0]?.audioUrl).toContain('a.mp3');
	});
});

describe('Discover UI wiring', () => {
	it('InboxPage includes Discover tab and podcast subscriptions', () => {
		const source = readFileSync(new URL('../../src/pages/InboxPage.tsx', import.meta.url), 'utf8');
		expect(source).toContain("mainSection === 'discover'");
		expect(source).toContain('DiscoverPage');
		expect(source).toContain('editingPodcast');
		expect(source).toContain('catchUpPodcast');
		expect(source).toContain('categoryIds');
		expect(source).toContain('sub-avatar-placeholder');
	});
});
