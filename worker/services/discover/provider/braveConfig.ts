import { DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION } from './braveQueryStrategy';
import { DEFAULT_BRAVE_TIMEOUT_MS } from './braveSearchProvider';

export const DEFAULT_BRAVE_USER_DAILY_SOFT_CAP = 100;
export const DEFAULT_BRAVE_GLOBAL_DAILY_SOFT_CAP = 750;

export interface BraveDiscoverConfig {
	apiKey: string;
	/** Not wired to production Discover in Phase 1–2; reserved for Phase 3. */
	providerMode: 'youtube' | 'brave';
	strategyVersion: string;
	userDailySoftCap: number;
	globalDailySoftCap: number;
	timeoutMs: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return Math.floor(n);
}

export function braveDiscoverConfigFromEnv(env: Env): BraveDiscoverConfig {
	const mode = (env.DISCOVER_SEARCH_PROVIDER ?? 'youtube').trim().toLowerCase();
	return {
		apiKey: (env.BRAVE_SEARCH_API_KEY ?? '').trim(),
		providerMode: mode === 'brave' ? 'brave' : 'youtube',
		strategyVersion: (env.DISCOVER_PROVIDER_STRATEGY_VERSION ?? DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION).trim() || DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION,
		userDailySoftCap: parsePositiveInt(env.BRAVE_USER_DAILY_SOFT_CAP, DEFAULT_BRAVE_USER_DAILY_SOFT_CAP),
		globalDailySoftCap: parsePositiveInt(env.BRAVE_GLOBAL_DAILY_SOFT_CAP, DEFAULT_BRAVE_GLOBAL_DAILY_SOFT_CAP),
		timeoutMs: parsePositiveInt(env.BRAVE_SEARCH_TIMEOUT_MS, DEFAULT_BRAVE_TIMEOUT_MS) || DEFAULT_BRAVE_TIMEOUT_MS,
	};
}
