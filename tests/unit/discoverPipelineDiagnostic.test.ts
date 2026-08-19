import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { buildInterestCorpus } from '../../worker/services/discover/interestCorpus';
import {
	extractPhrasesFromChannelDocuments,
	type ChannelDocumentInput,
} from '../../worker/services/discover/phraseExtract';
import { buildConceptClusters } from '../../worker/services/discover/conceptClustering';
import { buildClusterQueries, buildInterestSearchQueries, canonicalizeClusterQueryKey } from '../../worker/services/discover/clusterQueries';
import { buildInterestFingerprints } from '../../worker/services/discover/interestFingerprint';
import { buildInterestSearchQuery } from '../../worker/services/discover/queryConstruction';
import {
	MIN_ACCEPT_SCORE,
	MIN_RETAIN_SCORE,
	scoreCandidateAgainstFingerprint,
	shouldPersistNewCandidate,
	shouldRetainPersistedCandidate,
} from '../../worker/services/discover/candidateScoring';
import { buildForYouRecommendations } from '../../worker/services/discover/forYou';
import { discoverCandidatesForInterest } from '../../worker/services/discover/interestDiscovery';
import { loadAndPersistInterestPopular } from '../../worker/services/discover/interestPopular';
import { loadActiveInterestCandidates } from '../../worker/db/discoverInterestCandidates';
import { discoverTopicSearchQuotaStatus } from '../../worker/services/discoverQuota';
import { getTopicDiscoveryCache, loadCachedQueryResults, normalizeTopic } from '../../worker/services/discover/topicDiscovery';
import * as youtubeModule from '../../worker/services/youtube';

const USER = 'user-diag';
const NOW = new Date('2026-08-19T12:00:00Z');

function seedStormChasing(db: MemorySyncDb, withVideos = true) {
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
	if (withVideos) {
		for (const [channelId, title] of [
			['ch-1', 'Live tornado chase intercept supercell'],
			['ch-2', 'Severe weather forecasting radar analysis'],
			['ch-3', 'Storm chasing day in tornado alley'],
		] as const) {
			const videoId = `vid-${channelId}`;
			db.videos.set(videoId, {
				video_id: videoId,
				channel_id: channelId,
				title,
				description_excerpt: `${title} meteorology convective weather`,
				published_at: '2026-08-18T00:00:00Z',
			});
			db.inbox.set(`${USER}:${videoId}`, { user_id: USER, video_id: videoId, hidden: 0 });
		}
	}
}

function seedMicrosoft(db: MemorySyncDb) {
	db.seedUser(USER);
	for (const [id, title, description] of [
		['ms-1', 'Guy in a Cube', 'Power BI Power Platform Microsoft 365 tutorials'],
		['ms-2', 'Shane Young', 'Power Apps Power Automate SharePoint'],
		['ms-3', 'Christine Payton', 'Power BI dashboards Microsoft Teams'],
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
	db.categories.set('cat-ms', { id: 'cat-ms', user_id: USER, name: 'Microsoft' });
	for (const channelId of ['ms-1', 'ms-2', 'ms-3']) {
		db.channelCategories.push({ user_id: USER, channel_id: channelId, category_id: 'cat-ms' });
	}
	for (const [channelId, title] of [
		['ms-1', 'Power BI report building tutorial'],
		['ms-2', 'Power Apps canvas app walkthrough'],
		['ms-3', 'Microsoft 365 SharePoint integration'],
	] as const) {
		const videoId = `vid-${channelId}`;
		db.videos.set(videoId, {
			video_id: videoId,
			channel_id: channelId,
			title,
			description_excerpt: `${title} Power Platform`,
			published_at: '2026-08-18T00:00:00Z',
		});
		db.inbox.set(`${USER}:${videoId}`, { user_id: USER, video_id: videoId, hidden: 0 });
	}
}

const weatherCandidate = {
	provider: 'youtube' as const,
	type: 'channel' as const,
	externalId: 'UC_storm_chaser',
	title: 'Storm Chaser Live',
	description: 'Storm chasing tornado severe weather meteorology supercells forecasting intercepts',
};

describe('pipeline diagnostic — Storm Chasing', () => {
	it('traces full pipeline and exposes regression metrics', async () => {
		const db = new MemorySyncDb();
		seedStormChasing(db, true);
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'secret' });

		const corpus = await buildInterestCorpus(db as unknown as D1Database, USER, 'cat-storm', 'Storm Chasing');
		expect(corpus.channelCount).toBe(3);
		expect(corpus.videosSampled).toBeGreaterThan(0);

		const channelDocs: ChannelDocumentInput[] = corpus.channelDocuments;
		const phrasesDetailed = extractPhrasesFromChannelDocuments(channelDocs, ['Storm Chasing']).slice(0, 30);
		const clusters = buildConceptClusters(phrasesDetailed, channelDocs);
		const clusterQueries = buildClusterQueries(clusters);

		const fingerprints = await buildInterestFingerprints(db as unknown as D1Database, USER);
		const fp = fingerprints.find((row) => row.label === 'Storm Chasing')!;
		expect(fp).toBeTruthy();

		const oldQuery = buildInterestSearchQuery(fp);
		const oldCacheKey = normalizeTopic(oldQuery);
		const newQueries = buildInterestSearchQueries(fp);

		// Seed cache ONLY under old key (simulates pre-refactor production cache)
		await db
			.prepare(
				`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
			)
			.bind(
				oldCacheKey,
				JSON.stringify([weatherCandidate]),
				NOW.toISOString(),
				new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
			)
			.run();

		const quota = await discoverTopicSearchQuotaStatus(db as unknown as D1Database);
		const persistedBefore = await loadActiveInterestCandidates(db as unknown as D1Database, USER, 'cat-storm');

		const forYouCold = await buildForYouRecommendations(env, USER, { interestId: 'cat-storm', includeDebug: true }, NOW);

		const yt = {
			searchQueries: 0,
			getJson: vi.fn(async (path: string) => {
				if (path === 'search') {
					yt.searchQueries += 1;
					return {
						items: [
							{
								id: { channelId: 'UC_live_storm' },
								snippet: {
									title: 'Tornado Alley Chasers',
									description: 'Storm chasing tornado severe weather meteorology supercells',
									thumbnails: {},
								},
							},
						],
					};
				}
				return { items: [] };
			}),
		};
		vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient').mockReturnValue(yt as never);

		const discoverMore = await loadAndPersistInterestPopular(env, USER, 'cat-storm', NOW);
		const forYouAfterDiscover = await buildForYouRecommendations(env, USER, { interestId: 'cat-storm' }, NOW);

		// Score sample candidate against fingerprint
		const scored = scoreCandidateAgainstFingerprint(weatherCandidate, fp);

		const cacheProbe = await Promise.all(
			newQueries.map(async (q) => ({
				query: q.query,
				cacheKey: normalizeTopic(q.query),
				canonicalKey: q.cacheKey,
				cachedCount: (await loadCachedQueryResults(env, q.query, NOW)).length,
				oldKeyMatch: normalizeTopic(q.query) === oldCacheKey,
			})),
		);

		const report = {
			corpus: {
				channels: corpus.channelCount,
				videosSampled: corpus.videosSampled,
				channelIds: corpus.channelDocuments.filter((d) => d.channelId !== '__category__').map((d) => d.channelId),
			},
			topPhrases: phrasesDetailed.slice(0, 15).map((p) => ({
				phrase: p.text,
				weight: p.weight,
				channelCoverage: p.channelCoverage,
			})),
			clusters: clusters.map((c) => ({
				confidence: c.confidence,
				phrases: c.phrases.map((p) => p.text),
			})),
			oldQuery,
			oldCacheKey,
			newQueries: cacheProbe,
			persistedActiveBefore: persistedBefore.length,
			forYouCold: {
				returned: forYouCold.forYou.length,
				accepted: forYouCold.metrics.accepted,
				cacheHits: forYouCold.metrics.cacheHits,
				searchCalls: forYouCold.metrics.searchCalls,
				message: forYouCold.forYouMessage,
			},
			discoverMore: {
				channels: discoverMore.channels.length,
				fromPersisted: discoverMore.fromPersisted,
				liveSearchCalls: yt.searchQueries,
			},
			forYouAfterDiscover: forYouAfterDiscover.forYou.length,
			sampleScore: {
				candidate: weatherCandidate.title,
				baseScore: scored.score,
				minAccept: MIN_ACCEPT_SCORE,
				minRetain: MIN_RETAIN_SCORE,
				accept: shouldPersistNewCandidate(scored.score),
				retain: shouldRetainPersistedCandidate(scored.score),
				positive: scored.debug.positive,
			},
			quota,
		};

		// eslint-disable-next-line no-console
		console.log('STORM_CHASING_DIAGNOSTIC', JSON.stringify(report, null, 2));

		expect(report.sampleScore.accept).toBe(true);
		expect(report.forYouCold.searchCalls).toBe(0);
		vi.restoreAllMocks();
	});
});

describe('pipeline diagnostic — Microsoft', () => {
	it('traces microsoft pipeline metrics', async () => {
		const db = new MemorySyncDb();
		seedMicrosoft(db);
		const env = asEnv(db, { YOUTUBE_API_KEY: 'test-key', SESSION_SECRET: 'secret' });

		const fingerprints = await buildInterestFingerprints(db as unknown as D1Database, USER);
		const fp = fingerprints.find((row) => row.label === 'Microsoft')!;
		const queries = buildInterestSearchQueries(fp);
		const oldKey = normalizeTopic(buildInterestSearchQuery(fp));

		const discovery = await discoverCandidatesForInterest(env, USER, fp, {
			allowLiveSearch: false,
			includeDebug: true,
		}, NOW);

		const report = {
			phrases: fp.phrases.slice(0, 10),
			queries: queries.map((q) => ({ raw: q.query, key: normalizeTopic(q.query), canonical: q.cacheKey })),
			oldKey,
			discovery,
		};
		// eslint-disable-next-line no-console
		console.log('MICROSOFT_DIAGNOSTIC', JSON.stringify(report, null, 2));
		expect(fp.phrases.some((p) => p.text.includes('power'))).toBe(true);
	});
});
