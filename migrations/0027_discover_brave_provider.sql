-- Brave Discover provider cache, coalesce locks, and per-user Brave usage counters.
-- Additive only. Does not alter subscription/feed/WebSub tables.
-- Cache key shape: brave:youtube:{strategyVersion}:{normalizedQuery}

CREATE TABLE discover_provider_cache (
	cache_key TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	content_type TEXT NOT NULL,
	normalized_query TEXT NOT NULL,
	strategy_version TEXT NOT NULL,
	-- Accumulated raw provider page hits (pre usable-channel filtering).
	raw_results_json TEXT NOT NULL DEFAULT '[]',
	-- Usable candidates after normalize/resolve/dedupe/filter (filled in later phases).
	candidates_json TEXT NOT NULL DEFAULT '[]',
	-- Last provider page offset successfully fetched (Brave: 0–9).
	provider_offset INTEGER NOT NULL DEFAULT 0,
	-- Provider reports additional pages available.
	more_results_available INTEGER NOT NULL DEFAULT 0,
	-- Consumer cursor into candidates_json (usable-pool exhaustion ≠ provider-page exhaustion).
	candidate_consume_offset INTEGER NOT NULL DEFAULT 0,
	raw_result_count INTEGER NOT NULL DEFAULT 0,
	searched_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX idx_discover_provider_cache_expires ON discover_provider_cache (expires_at);
CREATE INDEX idx_discover_provider_cache_lookup
	ON discover_provider_cache (provider, content_type, strategy_version, normalized_query);

CREATE TABLE discover_provider_locks (
	cache_key TEXT PRIMARY KEY,
	lock_owner TEXT NOT NULL,
	locked_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX idx_discover_provider_locks_expires ON discover_provider_locks (expires_at);

-- Per-user Brave API / cache telemetry (UTC day).
CREATE TABLE discover_brave_usage_daily (
	day TEXT NOT NULL,
	user_id TEXT NOT NULL,
	request_count INTEGER NOT NULL DEFAULT 0,
	cache_hits INTEGER NOT NULL DEFAULT 0,
	cache_misses INTEGER NOT NULL DEFAULT 0,
	zero_result_searches INTEGER NOT NULL DEFAULT 0,
	api_errors INTEGER NOT NULL DEFAULT 0,
	usable_candidate_count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, user_id)
);

CREATE INDEX idx_discover_brave_usage_day ON discover_brave_usage_daily (day);
