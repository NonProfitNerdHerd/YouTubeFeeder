-- Quad-only live-status fields. Does not alter Feed tables.

ALTER TABLE live_sources ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE live_sources ADD COLUMN uploads_playlist_id TEXT;
ALTER TABLE live_sources ADD COLUMN known_live_video_id TEXT;
ALTER TABLE live_sources ADD COLUMN known_upcoming_video_id TEXT;
ALTER TABLE live_sources ADD COLUMN last_status_check_at TEXT;
ALTER TABLE live_sources ADD COLUMN last_discovery_at TEXT;
ALTER TABLE live_sources ADD COLUMN next_status_check_at TEXT;
ALTER TABLE live_sources ADD COLUMN next_discovery_at TEXT;
ALTER TABLE live_sources ADD COLUMN last_live_at TEXT;
ALTER TABLE live_sources ADD COLUMN consecutive_offline_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_sources ADD COLUMN search_cooldown_until TEXT;
ALTER TABLE live_sources ADD COLUMN last_player_error_at TEXT;

UPDATE live_sources SET source_mode = 'always_on', known_live_video_id = live_video_id
	WHERE skip_discovery = 1 AND enabled = 1;
UPDATE live_sources SET source_mode = 'disabled' WHERE enabled = 0;
UPDATE live_sources SET known_live_video_id = live_video_id WHERE known_live_video_id IS NULL AND live_video_id IS NOT NULL;

ALTER TABLE live_source_videos ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE live_source_videos ADD COLUMN embeddable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE live_source_videos ADD COLUMN last_checked_at TEXT;

UPDATE live_source_videos SET status = 'live' WHERE status = 'unknown';

CREATE TABLE live_quad_jobs (
	user_id TEXT NOT NULL,
	job TEXT NOT NULL,
	holder TEXT,
	expires_at TEXT,
	status TEXT NOT NULL DEFAULT 'idle',
	result_json TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (user_id, job),
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE live_quad_search_budget (
	user_id TEXT PRIMARY KEY,
	day TEXT NOT NULL,
	used INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id)
);
