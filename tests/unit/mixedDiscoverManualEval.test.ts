/**
 * Opt-in mixed All production evaluation harness (Phase 2.1).
 *
 * Local (optional):
 *   $env:EVAL_MIXED='1'; npx vitest run tests/unit/mixedDiscoverManualEval.test.ts
 *
 * Production (after deploy + API key verification) — preferred:
 *   1. Ensure Worker secrets: BRAVE_SEARCH_API_KEY, YOUTUBE_API_KEY
 *   2. Vars: DISCOVER_SEARCH_PROVIDER=brave, DISCOVER_PODCAST_PROVIDER=apple
 *   3. Apply D1 migration 0029 if not yet applied (via deploy / wrangler d1 migrations apply)
 *  4. Authenticated GET for each query:
 *       /api/discover/search?q=...&filter=all&limit=15&debug=1
 *     with DISCOVER_RELEVANCE_DEBUG=true on the Worker
 *   5. Capture TOP 15 + telemetry; repeat Microsoft + Storm Chasers for cache hits
 *
 * Local YouTube credential availability is NOT required to complete Phase 2.1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { searchMixedDiscoverAll } from '../../worker/services/discover/provider/mixedDiscoverSearch';
import { formatMixedCandidateExplanation } from '../../worker/services/discover/provider/mixedDiscoverRank';

function loadDevVars(): Record<string, string> {
	try {
		const raw = readFileSync('.dev.vars', 'utf8');
		const out: Record<string, string> = {};
		for (const line of raw.split(/\r?\n/)) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m) out[m[1]!] = m[2]!;
		}
		return out;
	} catch {
		return {};
	}
}

const enabled = process.env.EVAL_MIXED === '1';
const vars = loadDevVars();

export const MIXED_PRODUCTION_EVAL_QUERIES = [
	'Storm Chasers',
	'Microsoft',
	'technology',
	'history',
	'3D printing',
	'automotive',
] as const;

export const MIXED_PRODUCTION_EVAL_CHECKLIST = [
	'Are obvious exact matches near the top?',
	'Are loosely related sources appropriately lower?',
	'Are podcasts overwhelming YouTube because of score saturation?',
	'Is YouTube overwhelming podcasts?',
	'Does soft diversity look natural?',
	'Are garbage candidates reaching the first page?',
	'Are both source types competing on relevance rather than provider identity?',
] as const;

describe.skipIf(!enabled)('Phase 2.1 live mixed All evaluation (opt-in)', () => {
	const USER = 'eval-mixed-user';

	it(
		'captures TOP 15 + telemetry for six queries and cache repeats',
		async () => {
			const db = new MemorySyncDb();
			db.seedUser(USER);
			const env = asEnv(db, {
				DISCOVER_SEARCH_PROVIDER: 'brave',
				DISCOVER_PODCAST_PROVIDER: 'apple',
				BRAVE_SEARCH_API_KEY: vars.BRAVE_SEARCH_API_KEY ?? '',
				YOUTUBE_API_KEY: vars.YOUTUBE_API_KEY ?? '',
				DISCOVER_RELEVANCE_DEBUG: 'true',
				DISCOVER_BRAVE_TYPED_RESULT_LIMIT: '42',
				DISCOVER_BRAVE_MAX_PAGES_PER_REQUEST: '2',
			});

			const summaries = [];
			for (const query of MIXED_PRODUCTION_EVAL_QUERIES) {
				const res = await searchMixedDiscoverAll(env, USER, query, {
					limit: 15,
					includeDebug: true,
				});
				const top15 = (res.rankedPage ?? []).map((item, idx) => ({
					rank: idx + 1,
					title: item.result.title,
					type: item.contentType,
					relevance: item.relevance,
					titleMatch: item.titleMatch,
					diversity: item.diversityNote,
					provider: item.result.provider,
					explanation: formatMixedCandidateExplanation(item),
				}));
				summaries.push({
					query,
					totalReturned: res.results.length,
					youtubeInTop10: top15.slice(0, 10).filter((r) => r.type === 'youtube').length,
					podcastInTop10: top15.slice(0, 10).filter((r) => r.type === 'podcast').length,
					rawYoutubeCandidates: res.mixedTelemetry?.youtubeCandidatesAvailable ?? 0,
					usableYoutube: res.mixedTelemetry?.youtubeCandidatesAvailable ?? 0,
					rawPodcastCandidates: res.mixedTelemetry?.podcastCandidatesAvailable ?? 0,
					usablePodcasts: res.mixedTelemetry?.podcastCandidatesAvailable ?? 0,
					top15,
					braveRequests: res.mixedTelemetry?.youtubeExternalRequests,
					podcastRequests: res.mixedTelemetry?.podcastExternalRequests,
					ytCache: res.mixedTelemetry?.youtubeCacheHit,
					podCache: res.mixedTelemetry?.podcastCacheHit,
					distinctScoresInTop10: res.mixedTelemetry?.distinctScoresInTop10,
					diversityPromotions: res.mixedTelemetry?.diversityPromotions,
					warnings: res.warnings,
					checklist: MIXED_PRODUCTION_EVAL_CHECKLIST,
				});
			}

			const repeats = [];
			for (const query of ['Storm Chasers', 'Microsoft'] as const) {
				const res = await searchMixedDiscoverAll(env, USER, query, {
					limit: 15,
					includeDebug: true,
				});
				repeats.push({
					query,
					braveRequests: res.mixedTelemetry?.youtubeExternalRequests,
					podcastRequests: res.mixedTelemetry?.podcastExternalRequests,
					order: res.results.map((r) => `${r.provider}:${r.externalId}`),
					cached: res.cached,
				});
			}

			writeFileSync(
				'mixed-eval-results.json',
				JSON.stringify(
					{
						note: 'If YouTube warnings mention invalid key, treat as local-only; re-run against production after deploy.',
						productionSteps: [
							'Deploy Worker with migration 0029',
							'Confirm BRAVE_SEARCH_API_KEY + YOUTUBE_API_KEY secrets',
							'Set DISCOVER_SEARCH_PROVIDER=brave DISCOVER_PODCAST_PROVIDER=apple',
							'Enable DISCOVER_RELEVANCE_DEBUG=true temporarily',
							'GET /api/discover/search?q=QUERY&filter=all&limit=15&debug=1 (authenticated)',
							'Repeat Microsoft + Storm Chasers; expect external discovery requests = 0 on fresh cache',
						],
						summaries,
						repeats,
					},
					null,
					2,
				),
			);
			expect(summaries.length).toBe(6);
		},
		180_000,
	);
});
