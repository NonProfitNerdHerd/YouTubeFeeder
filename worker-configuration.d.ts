interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_REDIRECT_URI?: string;
	TOKEN_ENCRYPTION_KEY?: string;
	SESSION_SECRET?: string;
	MOCK_DATA?: string;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}
