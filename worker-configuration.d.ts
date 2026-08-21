/// <reference types="@cloudflare/workers-types" />

interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_REDIRECT_URI?: string;
	TOKEN_ENCRYPTION_KEY?: string;
	SESSION_SECRET?: string;
	MOCK_DATA?: string;
	PUBLIC_ORIGIN?: string;
	YOUTUBE_API_KEY?: string;
	YOUTUBE_DAILY_QUOTA?: string;
	YOUTUBE_QUOTA_WARN?: string;
	YOUTUBE_RECONCILE_RESERVE?: string;
	YOUTUBE_BACKFILL_CUTOFF?: string;
	PODCAST_INDEX_KEY?: string;
	PODCAST_INDEX_SECRET?: string;
	DISCOVER_RELEVANCE_DEBUG?: string;
	/** Cloudflare secret — Brave Search API subscription token (server-only). */
	BRAVE_SEARCH_API_KEY?: string;
	/** Phase 3+: `brave` | `youtube` (default). Phase 1–2 leave Discover on youtube. */
	DISCOVER_SEARCH_PROVIDER?: string;
	/** Brave YouTube query strategy version (cache key component). */
	DISCOVER_PROVIDER_STRATEGY_VERSION?: string;
	/** Soft cap on actual Brave HTTP requests per user per UTC day (default 100). */
	BRAVE_USER_DAILY_SOFT_CAP?: string;
	/** Soft cap on actual Brave HTTP requests globally per UTC day (default 750). */
	BRAVE_GLOBAL_DAILY_SOFT_CAP?: string;
	/** Brave HTTP timeout in ms (default 8000). */
	BRAVE_SEARCH_TIMEOUT_MS?: string;
	/** Max Brave pages fetched per typed Discover search request (default 3). */
	DISCOVER_BRAVE_MAX_PAGES_PER_REQUEST?: string;
	/** Target usable channel count for typed Brave Discover (default 20). */
	DISCOVER_BRAVE_TYPED_RESULT_LIMIT?: string;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}
