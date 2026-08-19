import { describe, expect, it, vi } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { buildForYouRecommendations } from '../../worker/services/discover/forYou';
import { buildInterestFingerprints } from '../../worker/services/discover/interestFingerprint';
import { buildInterestSearchQuery } from '../../worker/services/discover/queryConstruction';
import { computeFeedbackAdjustment, buildFeedbackAdjustmentIndex } from '../../worker/services/discover/feedbackScoring';
import { scoreCandidateAgainstFingerprint } from '../../worker/services/discover/candidateScoring';
import {
	getRecommendationHistory,
	recordFollowFeedbackFromToken,
	restoreFeedback,
	submitRecommendationFeedback,
} from '../../worker/services/discover/recommendationFeedbackService';
import {
	mintRecommendationToken,
	verifyRecommendationToken,
} from '../../worker/services/discover/recommendationToken';
import { normalizeTopic } from '../../worker/services/discover/topicDiscovery';
import { followYoutubeChannel } from '../../worker/services/discoverFollow';
import { discoverBrowse } from '../../worker/services/discoverBrowse';
import * as youtubeModule from '../../worker/services/youtube';

const SESSION_SECRET = 'test-session-secret-for-feedback';
const USER_A = 'user-a';
const USER_B = 'user-b';
const CHANNEL = 'UCxxxxxxxxxxxxxxxxxxxxxx';
const CHANNEL_B = 'UCyyyyyyyyyyyyyyyyyyyyyy';

function weatherChannel(externalId: string, title: string, description: string) {
	return {
		provider: 'youtube',
		type: 'channel',
		externalId,
		title,
		description,
	};
}

async function seedTopicCache(db: MemorySyncDb, cacheKey: string, results: unknown[], now: Date) {
	await db
		.prepare(
			`INSERT INTO topic_discovery_cache (normalized_topic, results_json, searched_at, expires_at) VALUES (?, ?, ?, ?)`,
		)
		.bind(cacheKey, JSON.stringify(results), now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
		.run();
}

function seedSubscribedUser(db: MemorySyncDb, userId: string) {
	db.seedUser(userId);
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
		db.prefs.set(`${userId}:${id}`, {
			user_id: userId,
			channel_id: id,
			is_subscribed: 1,
			follow_in_inbox: 1,
		});
	}
}

function seedStormChasingCategory(db: MemorySyncDb, userId: string, categoryId = 'cat-storm') {
	db.categories.set(categoryId, { id: categoryId, user_id: userId, name: 'Storm Chasing' });
	for (const channelId of ['ch-1', 'ch-2', 'ch-3']) {
		db.channelCategories.push({ user_id: userId, channel_id: channelId, category_id: categoryId });
	}
}

function seedPrintingCategory(db: MemorySyncDb, userId: string) {
	db.categories.set('cat-print', { id: 'cat-print', user_id: userId, name: '3D Printing' });
	for (const channelId of ['p-1', 'p-2', 'p-3']) {
		db.channels.set(channelId, {
			channel_id: channelId,
			title: `Printer ${channelId}`,
			description: '3d printing filament nozzle extruder maker',
			thumbnail_url: '',
			uploads_playlist_id: 'PL1',
		});
		db.prefs.set(`${userId}:${channelId}`, {
			user_id: userId,
			channel_id: channelId,
			is_subscribed: 1,
			follow_in_inbox: 1,
		});
		db.channelCategories.push({ user_id: userId, channel_id: channelId, category_id: 'cat-print' });
	}
}

async function mintTokenForUser(
	db: MemorySyncDb,
	userId: string,
	now: Date,
	overrides?: Partial<{ externalId: string; interestId: string; baseScore: number }>,
) {
	const fps = await buildInterestFingerprints(db as unknown as D1Database, userId);
	const fp = fps[0]!;
	return mintRecommendationToken(
		SESSION_SECRET,
		{
			userId,
			provider: 'youtube',
			externalId: overrides?.externalId ?? CHANNEL,
			channelTitle: 'Storm Channel',
			channelThumbnail: 'https://example.com/thumb.jpg',
			interestId: overrides?.interestId ?? fp.interestId,
			interestLabel: fp.label,
			baseScore: overrides?.baseScore ?? 72,
			matchedConcepts: [{ text: 'storm', ambiguous: true }],
			recommendationReason: 'Related to Storm Chasing',
		},
		now.getTime(),
	);
}

describe('recommendation feedback', () => {
	it('channel-only rejection hides channel without affecting feedback scoring index', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await seedTopicCache(db, cacheKey, [weatherChannel(CHANNEL, 'Hidden Channel', 'storm chasing tornado')], now);
		const token = await mintTokenForUser(db, USER_A, now);
		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');

		const result = await submitRecommendationFeedback(env, USER_A, 'channel_not_interested', token);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const history = await getRecommendationHistory(env, USER_A);
		expect(history.some((row) => row.externalId === CHANNEL)).toBe(true);
		expect(history[0]?.actionLabel).toContain('Not interested in this channel');

		const forYou = await buildForYouRecommendations(env, USER_A, undefined, now);
		expect(forYou.forYou.some((row) => row.externalId === CHANNEL)).toBe(false);

		const index = buildFeedbackAdjustmentIndex(db.recommendationFeedback as never);
		expect(index.negativeByInterestConcept.size).toBe(0);
		expect(index.positiveByInterestConcept.size).toBe(0);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('relevance rejection applies bounded interest-scoped negative scoring', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const token = await mintTokenForUser(db, USER_A, now, { externalId: CHANNEL_B });

		const result = await submitRecommendationFeedback(env, USER_A, 'not_relevant', token);
		expect(result.ok).toBe(true);

		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const fp = fps[0]!;
		const candidate = weatherChannel(CHANNEL_B, 'STORM Records', 'storm music production beats');
		const scored = scoreCandidateAgainstFingerprint(candidate, fp);
		const index = buildFeedbackAdjustmentIndex(db.recommendationFeedback as never);
		const adjustment = computeFeedbackAdjustment(scored.debug, index);
		expect(adjustment.negative).toBeGreaterThan(0);
		expect(adjustment.total).toBeLessThan(0);
	});

	it('follow with recommendation token records positive feedback server-side', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const token = await mintRecommendationToken(
			SESSION_SECRET,
			{
				userId: USER_A,
				provider: 'youtube',
				externalId: 'new-follow-ch',
				channelTitle: 'New Channel',
				channelThumbnail: '',
				interestId: 'cat-storm',
				interestLabel: 'Storm Chasing',
				baseScore: 60,
				matchedConcepts: [{ text: 'storm chasing', ambiguous: false }],
				recommendationReason: 'Related to Storm Chasing',
			},
			now.getTime(),
		);

		await followYoutubeChannel(env, USER_A, { channelId: 'new-follow-ch', title: 'New Channel' });
		const feedback = await recordFollowFeedbackFromToken(env, USER_A, token, 'new-follow-ch');
		expect(feedback.ok).toBe(true);

		const history = await getRecommendationHistory(env, USER_A, { filter: 'all', status: 'all' });
		expect(history.some((row) => row.action === 'followed')).toBe(false);
		expect(db.recommendationFeedback.some((row) => row.action === 'followed')).toBe(true);
	});

	it('follow without recommendation token does not require feedback', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		const result = await followYoutubeChannel(env, USER_A, { channelId: 'plain-follow-ch', title: 'Plain' });
		expect(result.ok).toBe(true);
		expect(db.recommendationFeedback.length).toBe(0);
	});

	it('restore removes suppression and scoring effect for relevance feedback', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await seedTopicCache(db, cacheKey, [weatherChannel(CHANNEL, 'Hidden Channel', 'storm chasing tornado')], now);

		const token = await mintTokenForUser(db, USER_A, now);
		const submitted = await submitRecommendationFeedback(env, USER_A, 'not_relevant', token);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;

		let forYou = await buildForYouRecommendations(env, USER_A, undefined, now);
		expect(forYou.forYou.some((row) => row.externalId === CHANNEL)).toBe(false);

		const restored = await restoreFeedback(env, USER_A, submitted.feedback.id);
		expect(restored.ok).toBe(true);

		forYou = await buildForYouRecommendations(env, USER_A, undefined, now);
		expect(forYou.forYou.some((row) => row.externalId === CHANNEL)).toBe(true);

		const index = buildFeedbackAdjustmentIndex(
			db.recommendationFeedback.filter((row) => row.restored_at == null) as never,
		);
		expect(index.negativeByInterestConcept.size).toBe(0);
	});

	it('restore channel-only clears suppression without scoring reversal', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await seedTopicCache(db, cacheKey, [weatherChannel(CHANNEL, 'Hidden Channel', 'storm chasing tornado')], now);

		const token = await mintTokenForUser(db, USER_A, now);
		const submitted = await submitRecommendationFeedback(env, USER_A, 'channel_not_interested', token);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;

		const restored = await restoreFeedback(env, USER_A, submitted.feedback.id);
		expect(restored.ok).toBe(true);

		const forYou = await buildForYouRecommendations(env, USER_A, undefined, now);
		expect(forYou.forYou.some((row) => row.externalId === CHANNEL)).toBe(true);
	});

	it('rejects invalid or cross-user recommendation tokens', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedSubscribedUser(db, USER_B);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const tokenForA = await mintTokenForUser(db, USER_A, now);

		const crossUser = await submitRecommendationFeedback(env, USER_B, 'not_relevant', tokenForA);
		expect(crossUser.ok).toBe(false);

		const forged = await submitRecommendationFeedback(env, USER_A, 'not_relevant', 'rec:forged.token');
		expect(forged.ok).toBe(false);
	});

	it('user A dismissal does not suppress for user B', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedSubscribedUser(db, USER_B);
		seedStormChasingCategory(db, USER_A);
		seedStormChasingCategory(db, USER_B);
		const now = new Date('2026-08-19T12:00:00Z');
		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await seedTopicCache(db, cacheKey, [weatherChannel(CHANNEL, 'Shared Channel', 'storm chasing tornado')], now);

		const token = await mintTokenForUser(db, USER_A, now);
		await submitRecommendationFeedback(env, USER_A, 'channel_not_interested', token);

		const forYouA = await buildForYouRecommendations(env, USER_A, undefined, now);
		const forYouB = await buildForYouRecommendations(env, USER_B, undefined, now);
		expect(forYouA.forYou.some((row) => row.externalId === CHANNEL)).toBe(false);
		expect(forYouB.forYou.some((row) => row.externalId === CHANNEL)).toBe(true);
	});

	it('interest isolation keeps not_relevant feedback scoped to one interest', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		seedPrintingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');

		const stormToken = await mintRecommendationToken(
			SESSION_SECRET,
			{
				userId: USER_A,
				provider: 'youtube',
				externalId: CHANNEL,
				channelTitle: 'Storm Channel',
				channelThumbnail: '',
				interestId: 'cat-storm',
				interestLabel: 'Storm Chasing',
				baseScore: 70,
				matchedConcepts: [{ text: 'storm', ambiguous: true }],
				recommendationReason: 'Related to Storm Chasing',
			},
			now.getTime(),
		);
		await submitRecommendationFeedback(env, USER_A, 'not_relevant', stormToken);

		const stormFps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const stormFp = stormFps.find((fp) => fp.interestId === 'cat-storm')!;
		const printFp = stormFps.find((fp) => fp.interestId === 'cat-print')!;
		const candidate = weatherChannel(CHANNEL_B, 'Storm Word Channel', 'storm in title only');
		const stormScored = scoreCandidateAgainstFingerprint(candidate, stormFp);
		const printScored = scoreCandidateAgainstFingerprint(candidate, printFp);
		const index = buildFeedbackAdjustmentIndex(db.recommendationFeedback as never);
		const stormAdj = computeFeedbackAdjustment(stormScored.debug, index);
		const printAdj = computeFeedbackAdjustment(printScored.debug, index);
		expect(stormAdj.negative).toBeGreaterThan(0);
		expect(printAdj.negative).toBe(0);
	});

	it('history lists dismissed entries with human-readable labels and zero youtube calls', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const token = await mintTokenForUser(db, USER_A, now);
		const spy = vi.spyOn(youtubeModule, 'createYoutubeApiKeyClient');
		await submitRecommendationFeedback(env, USER_A, 'channel_not_interested', token);

		const history = await getRecommendationHistory(env, USER_A);
		expect(history[0]?.actionLabel).toBe('Not interested in this channel');
		expect(history[0]?.channelTitle).toBe('Storm Channel');
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('forYou recommendations include server-minted recommendationToken', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await seedTopicCache(
			db,
			cacheKey,
			[weatherChannel(CHANNEL, 'For You Channel', 'storm chasing tornado severe weather')],
			now,
		);

		const forYou = await buildForYouRecommendations(env, USER_A, undefined, now);
		expect(forYou.forYou[0]?.recommendationToken).toBeTruthy();
		const verified = await verifyRecommendationToken(
			SESSION_SECRET,
			forYou.forYou[0]!.recommendationToken!,
			USER_A,
			now.getTime(),
		);
		expect(verified?.interestId).toBe('cat-storm');
		expect(verified?.externalId).toBe(CHANNEL);
	});

	it('feedback recording failure does not undo successful follow', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		await followYoutubeChannel(env, USER_A, { channelId: 'follow-ch', title: 'Follow Channel' });
		const badToken = await mintRecommendationToken(SESSION_SECRET, {
			userId: USER_A,
			provider: 'youtube',
			externalId: 'other-ch',
			channelTitle: 'Other',
			channelThumbnail: '',
			interestId: 'cat-storm',
			interestLabel: 'Storm Chasing',
			baseScore: 60,
			matchedConcepts: [],
			recommendationReason: 'Related',
		});
		const feedback = await recordFollowFeedbackFromToken(env, USER_A, badToken, 'follow-ch');
		expect(feedback.ok).toBe(false);
		const pref = db.prefs.get(`${USER_A}:follow-ch`);
		expect(pref?.is_subscribed).toBe(1);
	});
});

describe('forYou suppression integration', () => {
	it('filters actively dismissed channels from browse forYou', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db, { SESSION_SECRET, YOUTUBE_API_KEY: 'test-key' });
		seedSubscribedUser(db, USER_A);
		seedStormChasingCategory(db, USER_A);
		const now = new Date('2026-08-19T12:00:00Z');
		const fps = await buildInterestFingerprints(db as unknown as D1Database, USER_A);
		const cacheKey = normalizeTopic(buildInterestSearchQuery(fps[0]!));
		await seedTopicCache(db, cacheKey, [weatherChannel(CHANNEL, 'Dismissed', 'storm chasing tornado')], now);
		const token = await mintTokenForUser(db, USER_A, now);
		await submitRecommendationFeedback(env, USER_A, 'channel_not_interested', token);

		const browse = await discoverBrowse(env, USER_A, 'forYou', undefined, now);
		expect(browse.forYou.some((row) => row.externalId === CHANNEL)).toBe(false);
	});
});
