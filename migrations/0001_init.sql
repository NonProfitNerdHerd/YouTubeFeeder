-- YouTubeFeeder initial schema

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	google_account_id TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	encrypted_refresh_token TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE channels (
	channel_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	thumbnail_url TEXT NOT NULL DEFAULT '',
	uploads_playlist_id TEXT,
	subscribed INTEGER NOT NULL DEFAULT 1,
	last_synchronized_at TEXT
);

CREATE TABLE videos (
	video_id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description_excerpt TEXT NOT NULL DEFAULT '',
	thumbnail_default TEXT NOT NULL DEFAULT '',
	thumbnail_medium TEXT NOT NULL DEFAULT '',
	thumbnail_high TEXT NOT NULL DEFAULT '',
	published_at TEXT,
	scheduled_start_at TEXT,
	actual_start_at TEXT,
	actual_end_at TEXT,
	duration_seconds INTEGER,
	content_type TEXT NOT NULL,
	livestream_status TEXT NOT NULL,
	embeddable INTEGER NOT NULL DEFAULT 1,
	last_api_update_at TEXT,
	FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE TABLE inbox_state (
	user_id TEXT NOT NULL,
	video_id TEXT NOT NULL,
	unread INTEGER NOT NULL DEFAULT 1,
	starred INTEGER NOT NULL DEFAULT 0,
	archived INTEGER NOT NULL DEFAULT 0,
	hidden INTEGER NOT NULL DEFAULT 0,
	first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	read_at TEXT,
	PRIMARY KEY (user_id, video_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (video_id) REFERENCES videos(video_id)
);

CREATE TABLE quad_layouts (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	layout_name TEXT NOT NULL,
	slot1 TEXT,
	slot2 TEXT,
	slot3 TEXT,
	slot4 TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE settings (
	user_id TEXT PRIMARY KEY,
	sync_enabled INTEGER NOT NULL DEFAULT 1,
	sync_interval_minutes INTEGER NOT NULL DEFAULT 20,
	default_inbox_filter TEXT NOT NULL DEFAULT 'inbox',
	default_quad_audio TEXT NOT NULL DEFAULT 'oneActive',
	theme TEXT NOT NULL DEFAULT 'dark',
	live_status_refresh_seconds INTEGER NOT NULL DEFAULT 60,
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE sync_runs (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	sync_type TEXT NOT NULL,
	status TEXT NOT NULL,
	started_at TEXT NOT NULL,
	completed_at TEXT,
	channels_checked INTEGER NOT NULL DEFAULT 0,
	videos_added INTEGER NOT NULL DEFAULT 0,
	videos_updated INTEGER NOT NULL DEFAULT 0,
	estimated_quota_units INTEGER NOT NULL DEFAULT 0,
	error_summary TEXT
);

CREATE TABLE current_quad (
	user_id TEXT PRIMARY KEY,
	slot1 TEXT,
	slot2 TEXT,
	slot3 TEXT,
	slot4 TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_videos_channel ON videos(channel_id);
CREATE INDEX idx_videos_published ON videos(published_at DESC);
CREATE INDEX idx_videos_live_status ON videos(livestream_status);
CREATE INDEX idx_videos_content_type ON videos(content_type);
CREATE INDEX idx_inbox_user_unread ON inbox_state(user_id, unread, archived);
CREATE INDEX idx_inbox_user_starred ON inbox_state(user_id, starred);
CREATE INDEX idx_inbox_first_seen ON inbox_state(user_id, first_seen_at DESC);
CREATE INDEX idx_channels_subscribed ON channels(subscribed);
CREATE INDEX idx_sync_runs_started ON sync_runs(started_at DESC);
