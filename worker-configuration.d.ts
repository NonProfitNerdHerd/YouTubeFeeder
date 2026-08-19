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
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}
