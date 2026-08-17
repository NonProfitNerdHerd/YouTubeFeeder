-- Per-user subscription membership, WebSub state, and daily API accounting.
-- channels.subscribed is retained for compatibility but must not drive queries.
-- Global subscriptions are NOT copied onto users. Membership comes only from
-- existing channel_prefs(user_id, channel_id) rows.

ALTER TABLE channel_prefs ADD COLUMN is_subscribed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channel_prefs ADD COLUMN last_subscription_sync_id TEXT;
ALTER TABLE channel_prefs ADD COLUMN subscription_seen_at TEXT;
ALTER TABLE channel_prefs ADD COLUMN unsubscribed_at TEXT;

ALTER TABLE channels ADD COLUMN bootstrap_status TEXT;
ALTER TABLE channels ADD COLUMN bootstrap_page_token TEXT;
ALTER TABLE channels ADD COLUMN bootstrap_updated_at TEXT;

CREATE INDEX idx_channel_prefs_user_subscribed ON channel_prefs(user_id, is_subscribed);
CREATE INDEX idx_channel_prefs_channel_subscribed ON channel_prefs(channel_id, is_subscribed);
CREATE INDEX idx_channel_prefs_sync_id ON channel_prefs(last_subscription_sync_id);

-- Existing prefs only. Do not INSERT from channels.subscribed.
UPDATE channel_prefs SET is_subscribed = 1;

CREATE TABLE websub_subscriptions (
	channel_id TEXT PRIMARY KEY,
	status TEXT NOT NULL DEFAULT 'pending',
	lease_expires_at TEXT,
	last_subscribe_attempt_at TEXT,
	last_verified_at TEXT,
	failure_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE INDEX idx_websub_lease ON websub_subscriptions(status, lease_expires_at);
CREATE INDEX idx_websub_status ON websub_subscriptions(status);

CREATE TABLE websub_events (
	id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	video_id TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	published_at TEXT,
	updated_at TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	processed_at TEXT,
	FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE INDEX idx_websub_events_status ON websub_events(status, created_at);
CREATE INDEX idx_websub_events_video ON websub_events(video_id);

CREATE TABLE api_quota_daily (
	day TEXT NOT NULL,
	endpoint TEXT NOT NULL,
	call_count INTEGER NOT NULL DEFAULT 0,
	general_units INTEGER NOT NULL DEFAULT 0,
	search_calls INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, endpoint)
);
