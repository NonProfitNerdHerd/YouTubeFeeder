import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { upsertInterestCandidates, loadActiveInterestCandidates, dismissInterestCandidate } from '../../worker/db/discoverInterestCandidates';
import { buildForYouRecommendations } from '../../worker/services/discover/forYou';
import { loadAndPersistInterestPopular } from '../../worker/services/discover/interestPopular';
import { buildInterestFingerprints } from '../../worker/services/discover/interestFingerprint';
import { buildInterestSearchQuery } from '../../worker/services/discover/queryConstruction';
import { normalizeTopic } from '../../worker/services/discover/topicDiscovery';
import * as youtubeModule from '../../worker/services/youtube';

const SESSION_SECRET = 'test-session-secret';
const USER = 'user-1';
const CHANNEL = 'UCxxxxxxxxxxxxxxxxxxxxxx';

function seedSubscribedUser(db: MemorySyncDb) {
	db.seedUser(USER);
	for (const [id, title, description] of [
		['ch-1', 'Maker Bot 3D', '3d printing maker bot pla printer tutorials'],
		['ch-2', 'Print Farm', '3d printing resin printer reviews and tips'],
		['ch-3', 'Layer Lines', '3d printing design fusion cad slicer projects'],
	] as const) {
		db.channels.set(id, {
			channel_id: id,
			title,
			description,
			thumbnail_url: '',
			uploads_playlist_id: 'PL1',
		});
		db.prefs.set(`${USER}:${id}`, {
			user_id: USER,
			channel_id: id,
			is_subscribed: 1,
			follow_in_inbox: 1,
		});
	}
}

function seed3dCategory(db: MemorySyncDb) {
	db.categories.set('cat-3d', { id: 'cat-3d', user_id: USER, name: '3D Printing' });
	for (const channelId of ['ch-1', 'ch-2', 'ch-3']) {
		db.channelCategories.push({ user_id: USER, channel_id: channelId, category_id: 'cat-3d' });
	}
}

describe('discover interest candidates', () => {
	it('persists and reloads active browse popular candidates', async () => {
		const db = new MemorySyncDb();
		await upsertInterestCandidates(db as unknown as D1Database, USER, [
			{
				interestId: 'cat-3d',
				interestLabel: '3D Printing',
				provider: 'youtube',
				externalId: CHANNEL,
				channelTitle: '3D Print Channel',
				channelThumbnail: 'https://img.example/thumb.jpg',
				channelDescription: '3d printing tutorials',
				source: 'browse_popular',
				recommendationReason: 'Popular in 3D Printing',
			},
		]);
		const rows = await loadActiveInterestCandidates(db as unknown as D1Database, USER, 'cat-3d');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.external_id).toBe(CHANNEL);

		await dismissInterestCandidate(db as unknown as D1Database, USER, 'youtube', CHANNEL);
		const afterDismiss = await loadActiveInterestCandidates(db as unknown as D1Database, USER, 'cat-3d');
		expect(afterDismiss).toHaveLength(0);
	});

	it('includes persisted candidates in For You after refresh', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		const now = new Date('2026-08-19T12:00:00Z');
		seedSubscribedUser(db);
		seed3dCategory(db);

		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await db
			.prepare(
				`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
			)
			.bind(cacheKey, JSON.stringify([]), now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
			.run();

		await upsertInterestCandidates(db as unknown as D1Database, USER, [
			{
				interestId: 'cat-3d',
				interestLabel: '3D Printing',
				provider: 'youtube',
				externalId: CHANNEL,
				channelTitle: '3D Print Channel',
				channelThumbnail: '',
				channelDescription: '3d printing maker tutorials',
				source: 'browse_popular',
				recommendationReason: 'Popular in 3D Printing',
			},
		]);

		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		const result = await buildForYouRecommendations(env, USER, { interestId: 'cat-3d' }, now);
		expect(spy).not.toHaveBeenCalled();
		expect(result.forYou.some((row) => row.externalId === CHANNEL)).toBe(true);
		expect(result.forYou[0]?.recommendationToken).toBeTruthy();
		spy.mockRestore();
	});

	it('returns persisted rows without re-searching when already loaded', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		const now = new Date('2026-08-19T12:00:00Z');
		seedSubscribedUser(db);
		seed3dCategory(db);

		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await db
			.prepare(
				`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
			)
			.bind(
				cacheKey,
				JSON.stringify([
					{
						provider: 'youtube',
						type: 'channel',
						externalId: CHANNEL,
						title: 'Cached 3D Channel',
						description: '3d printing tutorials',
					},
				]),
				now.toISOString(),
				new Date(now.getTime() + 60_000).toISOString(),
			)
			.run();

		const first = await loadAndPersistInterestPopular(env, USER, 'cat-3d', now);
		expect(first.fromPersisted).toBe(false);
		expect(first.channels.length).toBeGreaterThan(0);

		const second = await loadAndPersistInterestPopular(env, USER, 'cat-3d', now);
		expect(second.fromPersisted).toBe(true);
		expect(second.channels.length).toBe(first.channels.length);
	});
});
