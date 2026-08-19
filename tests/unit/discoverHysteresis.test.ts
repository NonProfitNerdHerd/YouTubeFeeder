import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import {
	MIN_ACCEPT_SCORE,
	MIN_RETAIN_SCORE,
	shouldPersistNewCandidate,
	shouldRetainPersistedCandidate,
	scoreCandidateAgainstFingerprint,
} from '../../worker/services/discover/candidateScoring';
import {
	evaluatePersistedCandidates,
	discoverCandidatesForInterest,
} from '../../worker/services/discover/interestDiscovery';
import {
	loadActiveInterestCandidates,
	upsertInterestCandidates,
} from '../../worker/db/discoverInterestCandidates';
import { buildInterestFingerprints } from '../../worker/services/discover/interestFingerprint';
import { canonicalizeClusterQueryKey } from '../../worker/services/discover/clusterQueries';
import { DISCOVER_TOPIC_REFRESH_PER_REQUEST } from '../../worker/services/discoverQuota';
import * as topicDiscoveryModule from '../../worker/services/discover/topicDiscovery';
import type { InterestFingerprint } from '../../worker/services/discover/interestFingerprint';

const USER = 'user-hyst';
const CHANNEL = 'UC_hysteresis_channel';

function microsoftFingerprint(): InterestFingerprint {
	return {
		interestId: 'cat-ms',
		label: 'Microsoft',
		phrases: [
			{ text: 'power bi', weight: 92 },
			{ text: 'power platform', weight: 85 },
			{ text: 'microsoft 365', weight: 76 },
		],
		terms: [{ text: 'sharepoint', weight: 20, ambiguous: false }],
		negativeHints: [],
		channelCount: 7,
		confidence: 120,
		queries: [
			{ query: '"power bi" "power platform"', cacheKey: 'power bi power platform', confidence: 94, clusterId: 'c1' },
			{ query: '"microsoft 365" sharepoint', cacheKey: 'microsoft 365 sharepoint', confidence: 82, clusterId: 'c2' },
			{ query: '"power apps" automate', cacheKey: 'automate power apps', confidence: 61, clusterId: 'c3' },
			{ query: '"vs code" copilot', cacheKey: 'copilot vs code', confidence: 48, clusterId: 'c4' },
		],
	};
}

function seedMicrosoftCorpus(db: MemorySyncDb) {
	db.seedUser(USER);
	const channels = [
		['ms-1', 'Guy in a Cube', 'Power BI and Power Platform tutorials for analysts'],
		['ms-2', 'Shane Young', 'Power Apps Power Automate SharePoint Microsoft 365'],
		['ms-3', 'Christine Payton', 'Power BI dashboards and Power Platform tips'],
		['ms-4', 'Microsoft 365', 'Microsoft Teams SharePoint Microsoft 365 news'],
		['ms-5', 'Reza Dorrani', 'Power Apps canvas apps and Power Automate flows'],
		['ms-6', 'Steve Corey - MVP', 'Power Platform MVP Power BI consulting'],
		['ms-7', 'Tolu Victor', 'Power BI reports and Microsoft data analytics'],
	] as const;
	for (const [id, title, description] of channels) {
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
	for (const [id] of channels) {
		db.channelCategories.push({ user_id: USER, channel_id: id, category_id: 'cat-ms' });
	}
	for (const [channelId, title] of [
		['ms-1', 'Getting started with Power BI'],
		['ms-2', 'Build a Power Apps form'],
		['ms-3', 'Power Platform overview'],
		['ms-4', 'Microsoft Teams updates'],
		['ms-5', 'Power Automate tutorial'],
		['ms-6', 'Power BI desktop tips'],
		['ms-7', 'SharePoint list integration'],
	] as const) {
		const videoId = `vid-${channelId}`;
		db.videos.set(videoId, {
			video_id: videoId,
			channel_id: channelId,
			title,
			description_excerpt: `${title} for Microsoft 365 and Power Platform`,
			published_at: '2026-01-01T00:00:00Z',
		});
		db.inbox.set(`${USER}:${videoId}`, { user_id: USER, video_id: videoId, hidden: 0 });
	}
}

describe('candidate score hysteresis', () => {
	it('does not persist score 54 and persists score 55', () => {
		expect(shouldPersistNewCandidate(54)).toBe(false);
		expect(shouldPersistNewCandidate(55)).toBe(true);
		expect(MIN_ACCEPT_SCORE).toBe(55);
		expect(MIN_RETAIN_SCORE).toBe(45);
	});

	it('retains persisted candidate on minor drift (61 -> 52)', () => {
		expect(shouldRetainPersistedCandidate(52)).toBe(true);
	});

	it('retires persisted candidate on major relevance loss (61 -> 30)', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftCorpus(db);
		await upsertInterestCandidates(db as unknown as D1Database, USER, [
			{
				interestId: 'cat-ms',
				interestLabel: 'Microsoft',
				provider: 'youtube',
				externalId: CHANNEL,
				channelTitle: 'Unrelated Gaming Channel',
				channelThumbnail: '',
				channelDescription: 'Fortnite gameplay and gaming news',
				source: 'discovered',
				recommendationReason: 'Related to Power Bi',
				originatingQuery: 'power bi',
				matchedConceptsJson: '[]',
				baseRelevanceScore: 61,
			},
		]);

		const rows = await loadActiveInterestCandidates(db as unknown as D1Database, USER, 'cat-ms');
		const { active, retired } = await evaluatePersistedCandidates(
			db as unknown as D1Database,
			USER,
			microsoftFingerprint(),
			rows,
		);
		expect(retired).toBe(1);
		expect(active).toHaveLength(0);
		expect(db.recommendationFeedback).toHaveLength(0);
		const inactive = db.discoverInterestCandidates.find((row) => row.external_id === CHANNEL);
		expect(inactive?.inactive_reason).toBe('relevance_drift');
	});

	it('does not grandfather low current score because historical base was high', async () => {
		const db = new MemorySyncDb();
		await upsertInterestCandidates(db as unknown as D1Database, USER, [
			{
				interestId: 'cat-ms',
				interestLabel: 'Microsoft',
				provider: 'youtube',
				externalId: CHANNEL,
				channelTitle: 'Crime podcast network',
				channelThumbnail: '',
				channelDescription: 'True crime stories and mystery podcasts',
				source: 'discovered',
				recommendationReason: 'Related to Power Bi',
				originatingQuery: 'power bi',
				matchedConceptsJson: '[]',
				baseRelevanceScore: 80,
			},
		]);
		const rows = await loadActiveInterestCandidates(db as unknown as D1Database, USER, 'cat-ms');
		const scored = scoreCandidateAgainstFingerprint(
			{
				provider: 'youtube',
				type: 'channel',
				externalId: CHANNEL,
				title: 'Crime podcast network',
				description: 'True crime stories and mystery podcasts',
				subscribed: false,
			},
			microsoftFingerprint(),
		);
		expect(scored.score).toBeLessThan(MIN_RETAIN_SCORE);
		const { active, retired } = await evaluatePersistedCandidates(
			db as unknown as D1Database,
			USER,
			microsoftFingerprint(),
			rows,
		);
		expect(retired).toBe(1);
		expect(active).toHaveLength(0);
	});
});

describe('cluster search budget', () => {
	it('uses cache hits without live searches and caps live searches at request budget', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftCorpus(db);
		const env = asEnv(db, { SESSION_SECRET: 'secret', YOUTUBE_API_KEY: 'test-key' });
		const fingerprint = microsoftFingerprint();

		const now = new Date('2026-08-19T12:00:00Z');
		db.topicDiscoveryCache.set('power bi power platform', {
			normalized_topic: 'power bi power platform',
			results_json: JSON.stringify([
				{
					provider: 'youtube',
					type: 'channel',
					externalId: 'UC_power_bi',
					title: 'Power BI Pro Tips',
					description: 'Power BI and Power Platform training',
				},
			]),
			searched_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 60_000).toISOString(),
			next_page_token: null,
		});
		db.topicDiscoveryCache.set('microsoft 365 sharepoint', {
			normalized_topic: 'microsoft 365 sharepoint',
			results_json: JSON.stringify([
				{
					provider: 'youtube',
					type: 'channel',
					externalId: 'UC_m365',
					title: 'Microsoft 365 Daily',
					description: 'Microsoft 365 SharePoint Teams tutorials',
				},
			]),
			searched_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 60_000).toISOString(),
			next_page_token: null,
		});

		const getTopicCandidates = vi.spyOn(topicDiscoveryModule, 'getTopicCandidates');
		getTopicCandidates.mockImplementation(async (_env, query) => ({
			results: [
				{
					provider: 'youtube',
					type: 'channel',
					externalId: `UC_live_${canonicalizeClusterQueryKey(query).replace(/\s+/g, '_')}`,
					title: `Live ${query}`,
					description: 'Power BI Power Platform Microsoft 365',
				},
			],
			refreshed: true,
			cacheKey: canonicalizeClusterQueryKey(query),
			nextPageToken: null,
		}));

		const result = await discoverCandidatesForInterest(env, USER, fingerprint, {
			allowLiveSearch: true,
			maxLiveSearches: DISCOVER_TOPIC_REFRESH_PER_REQUEST,
		}, now);

		expect(result.metrics.cacheHits).toBe(2);
		expect(result.metrics.liveSearches).toBe(2);
		expect(getTopicCandidates).toHaveBeenCalledTimes(2);
		getTopicCandidates.mockRestore();
	});
});

describe('microsoft fingerprint corpus', () => {
	it('derives power platform concepts from multi-channel corpus', async () => {
		const db = new MemorySyncDb();
		seedMicrosoftCorpus(db);
		const fingerprints = await buildInterestFingerprints(db as unknown as D1Database, USER);
		const ms = fingerprints.find((row) => row.interestId === 'cat-ms');
		expect(ms).toBeTruthy();
		expect(ms!.channelCount).toBe(7);
		expect(ms!.phrases.some((row) => row.text.includes('power bi') || row.text.includes('power platform'))).toBe(true);
		expect((ms!.queries?.length ?? 0)).toBeGreaterThan(0);
	});
});
