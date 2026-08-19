import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { buildForYouRecommendations } from '../../worker/services/discover/forYou';
import { buildInterestFingerprints } from '../../worker/services/discover/interestFingerprint';
import { buildPhraseLookupKeys } from '../../worker/services/discover/clusterQueries';
import { loadPhraseCacheCandidates } from '../../worker/services/discover/cacheLookup';
import * as youtubeModule from '../../worker/services/youtube';

const USER = 'user-cache';
const NOW = new Date('2026-08-19T12:00:00Z');
const CHANNEL = 'UC_storm_prod';

function seedStormChasing(db: MemorySyncDb) {
	db.seedUser(USER);
	for (const [id, title, description] of [
		['ch-1', 'Storm Chasing Daily', 'Tornado and severe weather chase footage from tornado alley'],
		['ch-2', 'Meteorology Hub', 'Technology gadgets and severe weather forecasting reviews'],
		['ch-3', 'Supercell Tracker', 'Storm chasing supercells and convective meteorology'],
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
	db.categories.set('cat-storm', { id: 'cat-storm', user_id: USER, name: 'Storm Chasing' });
	for (const channelId of ['ch-1', 'ch-2', 'ch-3']) {
		db.channelCategories.push({ user_id: USER, channel_id: channelId, category_id: 'cat-storm' });
	}
}

const stormCandidate = {
	provider: 'youtube',
	type: 'channel',
	externalId: CHANNEL,
	title: 'Storm Chaser Live',
	description: 'Storm chasing tornado severe weather meteorology supercells forecasting',
};

async function seedProductionLikeCaches(db: MemorySyncDb) {
	// Production has separate term caches and a legacy quoted compound key — not new canonical cluster keys.
	for (const [key, candidate] of [
		['storm', stormCandidate],
		['chasing', { ...stormCandidate, externalId: 'UC_chasing', title: 'Chasing Storms TV' }],
		[
			'"storm chasing" "severe weather" "storm chaser" https tornado chaser',
			stormCandidate,
		],
	] as const) {
		await db
			.prepare(
				`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
			)
			.bind(key, JSON.stringify([candidate]), NOW.toISOString(), new Date(NOW.getTime() + 60 * 60 * 1000).toISOString())
			.run();
	}
}

describe('discovery cache fallback', () => {
	it('loads production-like storm/chasing caches when canonical cluster keys miss', async () => {
		const db = new MemorySyncDb();
		seedStormChasing(db);
		await seedProductionLikeCaches(db);
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'secret' });

		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER);
		const fp = fps.find((row) => row.label === 'Storm Chasing')!;
		expect(fp).toBeTruthy();

		const phraseKeys = buildPhraseLookupKeys(fp, 6);
		expect(phraseKeys.some((key) => key === 'storm' || key === 'chasing')).toBe(true);

		const phraseLookup = await loadPhraseCacheCandidates(env, fp, NOW);
		expect(phraseLookup.hitKeys.some((key) => key === 'storm' || key === 'chasing')).toBe(true);
		expect(phraseLookup.results.length).toBeGreaterThan(0);

		const yt = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		const forYou = await buildForYouRecommendations(env, USER, { interestId: 'cat-storm' }, NOW);
		expect(yt).not.toHaveBeenCalled();
		expect(forYou.forYou.length).toBeGreaterThan(0);
		expect(forYou.metrics.searchCalls).toBe(0);
		yt.mockRestore();
	});

	it('shows persisted candidates between retain and accept thresholds', async () => {
		const db = new MemorySyncDb();
		seedStormChasing(db);
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'secret' });
		await db
			.prepare(
				`INSERT INTO discover_interest_candidates (
					id, user_id, interest_id, interest_label, provider, external_id,
					channel_title, channel_thumbnail, channel_description, source,
					recommendation_reason, dismissed_at, created_at,
					originating_query, matched_concepts_json, base_relevance_score,
					discovered_at, last_presented_at, acted_at, inactive_reason
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
			)
			.bind(
				'cand-1',
				USER,
				'cat-storm',
				'Storm Chasing',
				'youtube',
				CHANNEL,
				'Storm Chaser Live',
				'',
				'Storm chasing tornado severe weather meteorology',
				'discovered',
				'Related to Storm Chasing',
				NOW.toISOString(),
				'storm chasing',
				'[]',
				58,
				NOW.toISOString(),
			)
			.run();

		const forYou = await buildForYouRecommendations(env, USER, { interestId: 'cat-storm' }, NOW);
		expect(forYou.forYou.some((row) => row.externalId === CHANNEL)).toBe(true);
	});
});
