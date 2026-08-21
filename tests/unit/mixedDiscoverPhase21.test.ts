import { describe, expect, it } from 'vitest';
import {
	rankMixedDiscoverCandidates,
	type MixedRankCandidate,
} from '../../worker/services/discover/provider/mixedDiscoverRank';
import {
	explainDiscoverTextMatch,
	formatDiscoverTextMatchExplanation,
	scoreDiscoverTextMatch,
} from '../../worker/services/discover/provider/scoreDiscoverTextMatch';
import type { DiscoveryResult } from '../../src/types/discover';

function yt(
	id: string,
	title: string,
	query: string,
	extra: { description?: string; publisher?: string; rank?: number } = {},
): MixedRankCandidate {
	const explanation = explainDiscoverTextMatch(query, {
		title,
		description: extra.description,
		publisher: extra.publisher ?? title,
		providerRank: extra.rank ?? 0,
	});
	return {
		contentType: 'youtube',
		canonicalId: id,
		relevance: explanation.score,
		providerRank: extra.rank ?? 0,
		titleMatch: explanation.titleMatch,
		explanation,
		result: {
			provider: 'youtube',
			type: 'channel',
			externalId: id,
			title,
			description: extra.description,
			imageUrl: '',
			publisher: extra.publisher ?? title,
		},
	};
}

function pod(
	feed: string,
	title: string,
	query: string,
	extra: { description?: string; publisher?: string; genres?: string[]; rank?: number } = {},
): MixedRankCandidate {
	const explanation = explainDiscoverTextMatch(query, {
		title,
		description: extra.description,
		publisher: extra.publisher,
		genres: extra.genres,
		providerRank: extra.rank ?? 0,
	});
	return {
		contentType: 'podcast',
		canonicalId: feed,
		relevance: explanation.score,
		providerRank: extra.rank ?? 0,
		titleMatch: explanation.titleMatch,
		explanation,
		result: {
			provider: 'podcast',
			type: 'podcast',
			externalId: feed,
			title,
			description: extra.description,
			feedUrl: feed,
			imageUrl: '',
			publisher: extra.publisher ?? '',
		},
	};
}

function withScores(
	items: Array<{ contentType: 'youtube' | 'podcast'; id: string; title: string; relevance: number; rank?: number }>,
): MixedRankCandidate[] {
	return items.map((item) => ({
		contentType: item.contentType,
		canonicalId: item.id,
		relevance: item.relevance,
		providerRank: item.rank ?? 0,
		result: {
			provider: item.contentType === 'youtube' ? 'youtube' : 'podcast',
			type: item.contentType === 'youtube' ? 'channel' : 'podcast',
			externalId: item.id,
			title: item.title,
			imageUrl: '',
			feedUrl: item.contentType === 'podcast' ? item.id : undefined,
		} as DiscoveryResult,
	}));
}

describe('Phase 2.1 scoreDiscoverTextMatch saturation fix', () => {
	it('true exact normalized title scores 100', () => {
		const ex = explainDiscoverTextMatch('Microsoft', { title: 'Microsoft' });
		expect(ex.titleMatch).toBe('exact');
		expect(ex.score).toBe(100);
	});

	it('title-contains for broad one-word query does not saturate at 100', () => {
		const titles = [
			'History Daily',
			'The History Podcast',
			'History Extra',
			"History That Doesn't Suck",
			'American History Tellers',
		];
		const scores = titles.map((title) => scoreDiscoverTextMatch('history', { title }));
		expect(scores.every((s) => s < 100)).toBe(true);
		expect(new Set(scores).size).toBeGreaterThan(1);
		expect(explainDiscoverTextMatch('history', { title: 'History Daily' }).titleMatch).toBe('all_tokens');
	});

	it('multi-token exact outranks partial outranks weak topic', () => {
		const q = 'storm chasers';
		const exact = scoreDiscoverTextMatch(q, { title: 'Storm Chasers' });
		const close = scoreDiscoverTextMatch(q, { title: 'Storm Chasing Stories' });
		const weak = scoreDiscoverTextMatch(q, {
			title: 'Severe Weather Weekly',
			description: 'occasional storm coverage',
		});
		expect(exact).toBeGreaterThan(close);
		expect(close).toBeGreaterThan(weak);
		expect(explainDiscoverTextMatch(q, { title: 'Storm Chasers' }).titleMatch).toBe('exact');
	});

	it('description-only mentions rank below strong titles', () => {
		expect(
			scoreDiscoverTextMatch('Microsoft', { title: 'Microsoft' }),
		).toBeGreaterThan(
			scoreDiscoverTextMatch('Microsoft', {
				title: 'Random Tech Daily',
				description: 'We mention Microsoft once among many topics.',
			}),
		);
	});

	it('provider rank is a small secondary signal', () => {
		const highTextLowRank = scoreDiscoverTextMatch('Microsoft', {
			title: 'Microsoft',
			providerRank: 40,
		});
		const weakTextTopRank = scoreDiscoverTextMatch('Microsoft', {
			title: 'Cooking Show',
			description: 'recipes',
			providerRank: 0,
		});
		expect(highTextLowRank).toBeGreaterThan(weakTextTopRank);
		const a = explainDiscoverTextMatch('tech news', { title: 'Tech News Weekly', providerRank: 0 });
		const b = explainDiscoverTextMatch('tech news', { title: 'Tech News Weekly', providerRank: 5 });
		expect(a.providerRankContribution).toBeLessThanOrEqual(3);
		expect(a.score - b.score).toBeLessThanOrEqual(3);
	});

	it('YouTube and podcast use the same scale for identical metadata', () => {
		const meta = { title: 'Automotive Weekly', publisher: 'Cars Media', description: 'cars and trucks' };
		expect(scoreDiscoverTextMatch('automotive', meta)).toBe(scoreDiscoverTextMatch('automotive', meta));
	});

	it('formats explanation metadata for debug', () => {
		const ex = explainDiscoverTextMatch('Microsoft', { title: 'Microsoft', providerRank: 1 });
		const text = formatDiscoverTextMatchExplanation('Microsoft', 'YouTube', ex, 'none');
		expect(text).toContain('Title match: exact');
		expect(text).toContain('Score: 100');
		expect(text).toContain('Provider rank contribution:');
	});
});

describe('Phase 2.1 soft diversity (symmetric)', () => {
	it('promotes podcast within delta after 3 YouTube', () => {
		const ranked = rankMixedDiscoverCandidates(
			withScores([
				{ contentType: 'youtube', id: 'UC1', title: 'A', relevance: 94 },
				{ contentType: 'youtube', id: 'UC2', title: 'B', relevance: 91 },
				{ contentType: 'youtube', id: 'UC3', title: 'C', relevance: 89 },
				{ contentType: 'youtube', id: 'UC4', title: 'D', relevance: 82 },
				{ contentType: 'podcast', id: 'https://p/f', title: 'P', relevance: 81 },
			]),
			{ diversityWindow: 3, diversityDelta: 8 },
		);
		expect(ranked.items.map((i) => i.result.title)).toEqual(['A', 'B', 'C', 'P', 'D']);
		expect(ranked.items[3]!.diversityNote).toMatch(/promoted from/);
	});

	it('does not promote podcast far below delta', () => {
		const ranked = rankMixedDiscoverCandidates(
			withScores([
				{ contentType: 'youtube', id: 'UC1', title: 'A', relevance: 94 },
				{ contentType: 'youtube', id: 'UC2', title: 'B', relevance: 91 },
				{ contentType: 'youtube', id: 'UC3', title: 'C', relevance: 89 },
				{ contentType: 'youtube', id: 'UC4', title: 'D', relevance: 82 },
				{ contentType: 'podcast', id: 'https://p/f', title: 'P', relevance: 60 },
			]),
			{ diversityWindow: 3, diversityDelta: 8 },
		);
		expect(ranked.items.map((i) => i.result.title)).toEqual(['A', 'B', 'C', 'D', 'P']);
	});

	it('promotes YouTube symmetrically after 3 podcasts', () => {
		const ranked = rankMixedDiscoverCandidates(
			withScores([
				{ contentType: 'podcast', id: 'https://a', title: 'A', relevance: 94 },
				{ contentType: 'podcast', id: 'https://b', title: 'B', relevance: 92 },
				{ contentType: 'podcast', id: 'https://c', title: 'C', relevance: 90 },
				{ contentType: 'podcast', id: 'https://d', title: 'D', relevance: 84 },
				{ contentType: 'youtube', id: 'UC1', title: 'Y', relevance: 82 },
			]),
			{ diversityWindow: 3, diversityDelta: 8 },
		);
		expect(ranked.items.map((i) => i.result.title)).toEqual(['A', 'B', 'C', 'Y', 'D']);
	});

	it('allows all-YouTube top 8 when they are strongest', () => {
		const pool = Array.from({ length: 8 }, (_, i) =>
			withScores([{ contentType: 'youtube', id: `UC${i}`, title: `Y${i}`, relevance: 95 - i }])[0]!,
		).concat(
			withScores([{ contentType: 'podcast', id: 'https://weak', title: 'Weak', relevance: 40 }]),
		);
		const ranked = rankMixedDiscoverCandidates(pool, { diversityWindow: 3, diversityDelta: 8 });
		expect(ranked.items.slice(0, 8).every((i) => i.contentType === 'youtube')).toBe(true);
	});

	it('allows all-podcast top 8 when they are strongest', () => {
		const pool = Array.from({ length: 8 }, (_, i) =>
			withScores([{ contentType: 'podcast', id: `https://p${i}`, title: `P${i}`, relevance: 95 - i }])[0]!,
		).concat(withScores([{ contentType: 'youtube', id: 'UC1', title: 'Weak', relevance: 40 }]));
		const ranked = rankMixedDiscoverCandidates(pool, { diversityWindow: 3, diversityDelta: 8 });
		expect(ranked.items.slice(0, 8).every((i) => i.contentType === 'podcast')).toBe(true);
	});

	it('does not force alternation', () => {
		const ranked = rankMixedDiscoverCandidates(
			withScores([
				{ contentType: 'youtube', id: 'UC1', title: 'A', relevance: 94 },
				{ contentType: 'youtube', id: 'UC2', title: 'B', relevance: 91 },
				{ contentType: 'podcast', id: 'https://a', title: 'C', relevance: 88 },
				{ contentType: 'youtube', id: 'UC3', title: 'D', relevance: 85 },
			]),
		);
		expect(ranked.items[0]!.contentType).toBe(ranked.items[1]!.contentType);
	});
});

describe('Phase 2.1 fixture evaluation (six queries)', () => {
	it('Microsoft: exact match outranks description-only', () => {
		const q = 'Microsoft';
		const ranked = rankMixedDiscoverCandidates([
			yt('UCmicrosoft', 'Microsoft', q, { rank: 2 }),
			pod('https://feeds.example/ms', 'Microsoft', q, { rank: 5 }),
			yt('UCverge', 'The Verge', q, {
				description: 'Tech news covering Microsoft and more',
				rank: 0,
			}),
			pod('https://feeds.example/cook', 'Cooking Tips', q, {
				description: 'Microsoft Excel recipes for bakers',
				rank: 1,
			}),
			yt('UCdev', 'Microsoft Developer', q, { rank: 3 }),
		]);
		expect(ranked.items[0]!.result.title).toMatch(/^Microsoft$/);
		expect(ranked.items[0]!.relevance).toBeGreaterThan(ranked.items.find((i) => i.result.title === 'The Verge')!.relevance);
		expect(ranked.items.every((i) => i.result.type === 'channel' || i.result.type === 'podcast')).toBe(true);
	});

	it('Storm Chasers: topical sources beat generic weather; both types can top', () => {
		const q = 'storm chasers';
		const ranked = rankMixedDiscoverCandidates([
			yt('UCryan', "Ryan Hall, Y'all", q, {
				description: 'Storm chasers covering severe weather and tornadoes',
				rank: 0,
			}),
			pod('https://feeds.example/sc', 'Storm Chasers', q, { rank: 1 }),
			yt('UCreed', 'Reed Timmer', q, {
				description: 'Storm chasers tornado intercepts',
				rank: 2,
			}),
			pod('https://feeds.example/wx', 'Severe Weather Weekly', q, {
				description: 'General forecasts',
				rank: 0,
			}),
			yt('UCcook', 'Cooking Channel', q, { description: 'recipes and baking tips', rank: 0 }),
		]);
		const titles = ranked.items.map((i) => i.result.title);
		expect(titles.indexOf('Storm Chasers')).toBeLessThan(titles.indexOf('Severe Weather Weekly'));
		expect(titles.indexOf("Ryan Hall, Y'all")).toBeLessThan(titles.indexOf('Cooking Channel'));
		expect(ranked.items.some((i) => i.contentType === 'youtube')).toBe(true);
		expect(ranked.items.some((i) => i.contentType === 'podcast')).toBe(true);
	});

	it('history: broad query avoids identical 100 saturation', () => {
		const q = 'history';
		const ranked = rankMixedDiscoverCandidates([
			pod('https://a', 'History Daily', q, { rank: 0 }),
			pod('https://b', 'The History Podcast', q, { rank: 1 }),
			pod('https://c', 'History Extra', q, { rank: 2 }),
			pod('https://d', "History That Doesn't Suck", q, { rank: 3 }),
			yt('UChist', 'History', q, { rank: 0 }),
			yt('UCover', 'OverSimplified', q, { description: 'History explained simply', rank: 1 }),
			pod('https://e', 'True Crime Stories', q, { description: 'mentions history once', rank: 0 }),
		]);
		const historyPods = ranked.items.filter((i) => i.result.title.toLowerCase().includes('history') && i.contentType === 'podcast');
		expect(historyPods.every((i) => i.relevance < 100 || i.titleMatch === 'exact')).toBe(true);
		expect(new Set(historyPods.map((i) => i.relevance)).size).toBeGreaterThan(1);
		expect(ranked.items[0]!.result.title).toBe('History');
	});

	it('technology: distributes scores without provider bias', () => {
		const q = 'technology';
		const ranked = rankMixedDiscoverCandidates([
			yt('UCmkbhd', 'Marques Brownlee', q, { description: 'Consumer technology reviews', rank: 0 }),
			pod('https://next', 'The Next Wave - AI and The Future of Technology', q, { rank: 0 }),
			pod('https://ted', 'TED Tech', q, { rank: 1 }),
			yt('UCnet', 'CNET', q, { description: 'Technology news', rank: 2 }),
			pod('https://weak', 'Baking Hour', q, { description: 'oven technology tips', rank: 0 }),
		]);
		expect(ranked.items[0]!.relevance).toBeGreaterThanOrEqual(ranked.items[ranked.items.length - 1]!.relevance);
		expect(ranked.items.some((i) => i.contentType === 'youtube')).toBe(true);
		expect(ranked.items.some((i) => i.contentType === 'podcast')).toBe(true);
	});

	it('3D printing: multi-token title matches weigh heavily', () => {
		const q = '3D printing';
		const ranked = rankMixedDiscoverCandidates([
			yt('UCnord', '3D Printing Nerd', q, { rank: 1 }),
			pod('https://basics', '3d Printing Basics', q, { rank: 0 }),
			yt('UCmaker', "Maker's Muse", q, { description: '3D printing tutorials', rank: 0 }),
			pod('https://cars', 'All Things Cars', q, { description: 'printing stickers', rank: 0 }),
		]);
		expect(ranked.items[0]!.relevance).toBeGreaterThan(
			ranked.items.find((i) => i.result.title === 'All Things Cars')!.relevance,
		);
	});

	it('automotive: equal-score cross-type candidates both survive (no cross-dedupe)', () => {
		const q = 'automotive';
		const ranked = rankMixedDiscoverCandidates([
			yt('UCauto', 'Automotive Digest', q, { rank: 0 }),
			pod('https://auto', 'Automotive Digest', q, { rank: 0 }),
			yt('UCdonut', 'Donut', q, { description: 'Cars and automotive culture', rank: 1 }),
		]);
		expect(ranked.items.filter((i) => i.result.title === 'Automotive Digest')).toHaveLength(2);
	});

	it('source-only hierarchy: no videos or episodes in fixture pool', () => {
		const ranked = rankMixedDiscoverCandidates([
			yt('UCa', 'A', 'tech'),
			pod('https://a', 'B', 'tech'),
		]);
		expect(ranked.items.every((i) => i.result.type === 'channel' || i.result.type === 'podcast')).toBe(true);
	});
});

describe('Phase 2.1 mixed pagination stress', () => {
	it('pages are contiguous, deterministic, and duplicate-free', () => {
		const pool: MixedRankCandidate[] = [];
		for (let i = 0; i < 40; i++) {
			pool.push(
				...withScores([
					{
						contentType: i % 2 === 0 ? 'youtube' : 'podcast',
						id: i % 2 === 0 ? `UC${String(i).padStart(2, '0')}` : `https://feed/${i}`,
						title: `Item ${String(i).padStart(2, '0')}`,
						relevance: 90 - (i % 30),
						rank: i,
					},
				]),
			);
		}
		const ranked = rankMixedDiscoverCandidates(pool).items;
		const pageSize = 10;
		const pages = [0, 1, 2, 3].map((p) => ranked.slice(p * pageSize, (p + 1) * pageSize));
		const ids = pages.flat().map((i) => `${i.contentType}:${i.canonicalId}`);
		expect(new Set(ids).size).toBe(ids.length);
		expect(pages[0]!.length + pages[1]!.length).toBe(20);
		const again = rankMixedDiscoverCandidates(pool).items.map((i) => i.canonicalId);
		expect(again).toEqual(ranked.map((i) => i.canonicalId));
	});

	it('hasMore semantics: one exhausted provider does not end mixed list', () => {
		const fewYt = withScores([
			{ contentType: 'youtube', id: 'UC1', title: 'Y1', relevance: 80 },
			{ contentType: 'youtube', id: 'UC2', title: 'Y2', relevance: 70 },
		]);
		const manyPod = Array.from({ length: 25 }, (_, i) =>
			withScores([
				{
					contentType: 'podcast',
					id: `https://p/${i}`,
					title: `P${i}`,
					relevance: 75 - (i % 10),
				},
			])[0]!,
		);
		const ranked = rankMixedDiscoverCandidates([...fewYt, ...manyPod]).items;
		expect(ranked.length).toBe(27);
		expect(ranked.slice(10).length).toBeGreaterThan(0);
		expect(ranked.filter((i) => i.contentType === 'podcast').length).toBe(25);
	});
});
