import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from '../../src/types/discover';
import {
	MIN_ACCEPT_SCORE,
	scoreCandidateAgainstFingerprint,
	scoreCandidatesForInterest,
} from '../../worker/services/discover/candidateScoring';
import { buildInterestFingerprints, type InterestFingerprint } from '../../worker/services/discover/interestFingerprint';
import { extractPhrasesFromDocuments } from '../../worker/services/discover/phraseExtract';
import { buildInterestSearchQuery } from '../../worker/services/discover/queryConstruction';
import { MemorySyncDb } from './helpers/memorySyncDb';

function weatherFingerprint(): InterestFingerprint {
	return {
		interestId: 'cat-weather',
		label: 'Storm Chasing',
		phrases: [
			{ text: 'storm chasing', weight: 40 },
			{ text: 'severe weather', weight: 30 },
			{ text: 'tornado forecasting', weight: 25 },
		],
		terms: [
			{ text: 'tornado', weight: 20, ambiguous: false },
			{ text: 'meteorology', weight: 18, ambiguous: false },
			{ text: 'supercell', weight: 15, ambiguous: false },
			{ text: 'storm', weight: 10, ambiguous: true },
			{ text: 'chasing', weight: 8, ambiguous: true },
		],
		negativeHints: [],
		channelCount: 4,
		confidence: 80,
	};
}

function candidate(title: string, description: string): DiscoveryResult {
	return {
		provider: 'youtube',
		type: 'channel',
		externalId: `UC-${title.replace(/\s+/g, '-').toLowerCase()}`,
		title,
		description,
	};
}

describe('phrase extraction', () => {
	it('preserves multi-word category phrases instead of splitting them', () => {
		const docs = [
			'Storm Chasing',
			'Tornado intercept live stream severe weather forecasting',
			'Supercell meteorology chase footage',
		];
		const phrases = extractPhrasesFromDocuments(docs, ['Storm Chasing']);
		expect(phrases.some((row) => row.text === 'storm chasing')).toBe(true);
		expect(phrases.some((row) => row.text === 'severe weather')).toBe(true);
	});
});

describe('query construction', () => {
	it('builds focused plain-text queries rather than lone ambiguous tokens', () => {
		const query = buildInterestSearchQuery(weatherFingerprint());
		expect(query).toContain('storm chasing');
		expect(query).toMatch(/tornado|meteorology|supercell|severe weather/);
		expect(query).not.toMatch(/^storm$/);
		expect(query).not.toContain('"');
	});
});

describe('candidate relevance scoring', () => {
	it('accepts candidates with multiple strong weather concepts', () => {
		const scored = scoreCandidateAgainstFingerprint(
			candidate(
				'Severe Weather Forecasting',
				'Tornado forecasting, supercells, severe thunderstorms, and meteorology coverage.',
			),
			weatherFingerprint(),
		);
		expect(scored.score).toBeGreaterThanOrEqual(MIN_ACCEPT_SCORE);
		expect(scored.debug.result).toBe('ACCEPT');
	});

	it('rejects music channels that only match storm in the title', () => {
		const scored = scoreCandidateAgainstFingerprint(
			candidate('STORM Records', 'Independent music producer, records, songs, and studio sessions.'),
			weatherFingerprint(),
		);
		expect(scored.debug.result).toBe('REJECT');
		expect(scored.score).toBeLessThan(MIN_ACCEPT_SCORE);
	});

	it('rejects soccer channels that only match chasing in the title', () => {
		const scored = scoreCandidateAgainstFingerprint(
			candidate('Chasing the Game', 'Soccer highlights, football training, and match analysis.'),
			weatherFingerprint(),
		);
		expect(scored.debug.result).toBe('REJECT');
	});

	it('rejects unrelated travel content with no topical overlap', () => {
		const scored = scoreCandidateAgainstFingerprint(
			candidate('Northern Europe Travels', 'Traveling throughout Northern Europe and vacation vlogs.'),
			weatherFingerprint(),
		);
		expect(scored.debug.result).toBe('REJECT');
	});

	it('does not fill results with sub-threshold candidates', () => {
		const fp = weatherFingerprint();
		const pool = [
			candidate('STORM Records', 'music producer records songs'),
			candidate('Chasing the Game', 'soccer football'),
			candidate('Travel Vlog', 'traveling vacation Europe'),
			candidate(
				'Storm Chaser Pro',
				'Storm chasing tornado intercept severe weather forecasting meteorology supercells',
			),
		];
		const accepted = scoreCandidatesForInterest(pool, fp);
		expect(accepted.length).toBe(1);
		expect(accepted[0]?.result.title).toBe('Storm Chaser Pro');
	});
});

describe('interest fingerprints from local corpus', () => {
	it('derives weather concepts from categorized subscription corpus', async () => {
		const db = new MemorySyncDb();
		db.seedUser('user-1');
		db.categories.set('cat-storm', { id: 'cat-storm', user_id: 'user-1', name: 'Storm Chasing' });
		for (const [id, title, description] of [
			['ch-1', 'Tornado Alley Live', 'Severe weather tornado supercell storm chasing intercepts'],
			['ch-2', 'Meteorology Now', 'Forecasting severe thunderstorms and convective weather radar'],
			['ch-3', 'Storm Chaser Mike', 'Storm chasing footage from tornado alley'],
		] as const) {
			db.channels.set(id, { channel_id: id, title, description, thumbnail_url: '', uploads_playlist_id: 'PL' });
			db.prefs.set(`user-1:${id}`, { user_id: 'user-1', channel_id: id, is_subscribed: 1, follow_in_inbox: 1 });
			db.channelCategories.push({ user_id: 'user-1', channel_id: id, category_id: 'cat-storm' });
		}
		db.inbox.set('user-1:v1', { user_id: 'user-1', video_id: 'v1', hidden: 0 });
		db.videos.set('v1', {
			video_id: 'v1',
			channel_id: 'ch-1',
			title: 'Large tornado near Wakita severe weather chase',
			description_excerpt: 'Supercell intercept',
			published_at: '2026-08-19T00:00:00Z',
		});

		const fps = await buildInterestFingerprints(db as unknown as D1Database, 'user-1');
		expect(fps.some((fp) => fp.label === 'Storm Chasing')).toBe(true);
		const storm = fps.find((fp) => fp.label === 'Storm Chasing');
		expect(storm?.phrases.some((row) => row.text.includes('storm'))).toBe(true);
		expect(storm?.terms.some((row) => row.text === 'tornado' || row.text === 'meteorology')).toBe(true);
	});
});
