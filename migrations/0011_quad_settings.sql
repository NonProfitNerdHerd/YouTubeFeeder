-- Quad-only settings and stats. Does not alter Feed tables.

CREATE TABLE live_quad_settings (
	user_id TEXT PRIMARY KEY,
	polling_enabled INTEGER NOT NULL DEFAULT 0,
	confirm_interval_seconds INTEGER NOT NULL DEFAULT 300,
	discovery_interval_seconds INTEGER NOT NULL DEFAULT 900,
	cache_max_age_seconds INTEGER NOT NULL DEFAULT 300,
	default_source_mode TEXT NOT NULL DEFAULT 'normal',
	search_fallback_enabled INTEGER NOT NULL DEFAULT 1,
	search_daily_allowance INTEGER NOT NULL DEFAULT 20,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE live_quad_stats (
	user_id TEXT PRIMARY KEY,
	day TEXT NOT NULL DEFAULT '',
	general_api_calls INTEGER NOT NULL DEFAULT 0,
	search_queries INTEGER NOT NULL DEFAULT 0,
	cache_hits INTEGER NOT NULL DEFAULT 0,
	duplicates_prevented INTEGER NOT NULL DEFAULT 0,
	last_confirm_at TEXT,
	last_discover_at TEXT,
	next_confirm_at TEXT,
	next_discover_at TEXT,
	last_duration_ms INTEGER,
	last_error TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id)
);

ALTER TABLE live_source_videos ADD COLUMN scheduled_start_at TEXT;
