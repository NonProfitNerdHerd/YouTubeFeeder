/**
 * Local typed-Brave Discover quality probe (Phase 3).
 * Usage (PowerShell):
 *   $env:BRAVE_SEARCH_API_KEY="..."; $env:YOUTUBE_API_KEY="..."; npx tsx scripts/brave-typed-discover-eval.ts
 *
 * Does not print secrets. Writes summary JSON to tests/unit/.brave-typed-eval.json (gitignored via *-diagnostic pattern — use .brave prefix).
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { braveDiscoverConfigFromEnv } from '../worker/services/discover/provider/braveConfig';
import { searchYoutubeDiscoverViaBrave } from '../worker/services/discover/provider/typedBraveDiscoverSearch';
import { buildBraveYoutubeSearchQuery } from '../worker/services/discover/provider/braveQueryStrategy';

const QUERIES = ['storm chasing', 'Microsoft', 'Chevy trucks', 'knowledge management', 'weather', '3D printing'];

function createMinimalD1(): D1Database {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE api_quota_daily (day TEXT, endpoint TEXT, call_count INT, general_units INT, search_calls INT, PRIMARY KEY(day, endpoint));
		CREATE TABLE discover_provider_cache (
			cache_key TEXT PRIMARY KEY, provider TEXT, content_type TEXT, normalized_query TEXT, strategy_version TEXT,
			raw_results_json TEXT, candidates_json TEXT, provider_offset INT, more_results_available INT,
			candidate_consume_offset INT, raw_result_count INT, searched_at TEXT, updated_at TEXT, expires_at TEXT
		);
		CREATE TABLE discover_provider_locks (cache_key TEXT PRIMARY KEY, lock_owner TEXT, locked_at TEXT, expires_at TEXT);
		CREATE TABLE discover_brave_usage_daily (
			day TEXT, user_id TEXT, request_count INT, cache_hits INT, cache_misses INT,
			zero_result_searches INT, api_errors INT, usable_candidate_count INT, PRIMARY KEY(day, user_id)
		);
		CREATE TABLE channel_prefs (user_id TEXT, channel_id TEXT, is_subscribed INT, PRIMARY KEY(user_id, channel_id));
	`);
	const prepare = (sql: string) => {
		const stmt = {
			_sql: sql,
			_bound: [] as unknown[],
			bind(...args: unknown[]) {
				stmt._bound = args;
				return stmt;
			},
			async run() {
				db.prepare(sql).run(...stmt._bound);
				return { success: true, meta: { changes: 1 } };
			},
			async first<T>() {
				const row = db.prepare(sql).get(...stmt._bound);
				return (row as T) ?? null;
			},
			async all<T>() {
				const rows = db.prepare(sql).all(...stmt._bound);
				return { results: rows as T[] };
			},
		};
		return stmt;
	};
	return { prepare } as unknown as D1Database;
}

async function main() {
	if (!process.env.BRAVE_SEARCH_API_KEY || !process.env.YOUTUBE_API_KEY) {
		console.error('Set BRAVE_SEARCH_API_KEY and YOUTUBE_API_KEY in the environment to run live eval.');
		process.exit(2);
	}
	const d1 = createMinimalD1();
	const env = {
		DB: d1,
		BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
		YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
		DISCOVER_SEARCH_PROVIDER: 'brave',
		DISCOVER_PROVIDER_STRATEGY_VERSION: 'v1',
		BRAVE_USER_DAILY_SOFT_CAP: '100',
		BRAVE_GLOBAL_DAILY_SOFT_CAP: '750',
	} as Env;

	const config = braveDiscoverConfigFromEnv(env);
	console.log('strategyQueryExample', buildBraveYoutubeSearchQuery('storm chasing', config.strategyVersion));

	const rows = [];
	for (const query of QUERIES) {
		const result = await searchYoutubeDiscoverViaBrave(env, 'eval-user', query, {
			includeDebug: true,
			config,
			limit: 20,
		});
		const funnel = result.funnel!;
		rows.push({
			query,
			bravePagesRequested: funnel.bravePagesFetched,
			rawBraveResults: funnel.rawBraveResults,
			validYoutubeUrls: funnel.validYoutubeUrls,
			uniqueResolvedChannels: funnel.resolvedChannels,
			unresolvedResults: funnel.unresolvedResults,
			duplicatesRemoved: funnel.duplicateChannels,
			usableFinalCandidates: result.results.length,
			youtubeVideosListCalls: funnel.youtubeVideosListCalls,
			youtubeChannelsListCalls: funnel.youtubeChannelsListCalls,
			youtubeSearchListCalls: funnel.youtubeSearchListCalls,
			channelNames: result.results.map((r) => r.title),
			warning: result.warning ?? null,
			stopReason: funnel.stopReason,
		});
		console.log(JSON.stringify(rows[rows.length - 1], null, 2));
	}

	writeFileSync('tests/unit/.brave-typed-eval.json', JSON.stringify({ strategy: 'v1', rows }, null, 2));
	console.log('Wrote tests/unit/.brave-typed-eval.json');
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
