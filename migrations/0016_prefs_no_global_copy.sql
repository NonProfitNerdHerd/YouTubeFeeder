-- Repair 0015 CROSS JOIN copies (already applied in production) and add
-- retry/sweep/catch-up columns. Do not INSERT channel_prefs from channels.subscribed.
-- Global channel metadata is preserved. Channels without prefs stay unassigned.

ALTER TABLE websub_events ADD COLUMN last_attempt_at TEXT;
ALTER TABLE websub_events ADD COLUMN next_attempt_at TEXT;
CREATE INDEX IF NOT EXISTS idx_websub_events_retry ON websub_events(status, next_attempt_at);

ALTER TABLE channel_prefs ADD COLUMN catchup_page_token TEXT;
ALTER TABLE channel_prefs ADD COLUMN catchup_pulled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_prefs ADD COLUMN catchup_updated_at TEXT;

CREATE TABLE IF NOT EXISTS feed_reconcile_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	day TEXT NOT NULL,
	units_used INTEGER NOT NULL DEFAULT 0,
	last_channel_id TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS migration_reports (
	migration TEXT PRIMARY KEY,
	orphaned_subscribed_channels INTEGER NOT NULL DEFAULT 0,
	orphaned_channels INTEGER NOT NULL DEFAULT 0,
	prefs_removed INTEGER NOT NULL DEFAULT 0,
	recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Count unused fingerprint rows that 0015 could have invented, then delete them.
-- Keep prefs with any user-specific evidence (watermark, custom pull/follow,
-- subscription snapshot, unsubscribe timestamp, categories, or inbox items).
INSERT INTO migration_reports (migration, orphaned_subscribed_channels, orphaned_channels, prefs_removed)
SELECT
	'0016_prefs_no_global_copy',
	0,
	0,
	(
		SELECT COUNT(*) FROM channel_prefs p
		WHERE p.follow_in_inbox = 1
			AND p.max_videos_to_pull = 0
			AND p.newest_seen_published_at IS NULL
			AND p.last_subscription_sync_id IS NULL
			AND p.unsubscribed_at IS NULL
			AND NOT EXISTS (
				SELECT 1 FROM channel_categories cc
				WHERE cc.user_id = p.user_id AND cc.channel_id = p.channel_id
			)
			AND NOT EXISTS (
				SELECT 1 FROM inbox_state i
				JOIN videos v ON v.video_id = i.video_id
				WHERE i.user_id = p.user_id AND v.channel_id = p.channel_id
			)
	);

DELETE FROM channel_prefs
WHERE follow_in_inbox = 1
	AND max_videos_to_pull = 0
	AND newest_seen_published_at IS NULL
	AND last_subscription_sync_id IS NULL
	AND unsubscribed_at IS NULL
	AND NOT EXISTS (
		SELECT 1 FROM channel_categories cc
		WHERE cc.user_id = channel_prefs.user_id AND cc.channel_id = channel_prefs.channel_id
	)
	AND NOT EXISTS (
		SELECT 1 FROM inbox_state i
		JOIN videos v ON v.video_id = i.video_id
		WHERE i.user_id = channel_prefs.user_id AND v.channel_id = channel_prefs.channel_id
	);

UPDATE migration_reports
SET
	orphaned_subscribed_channels = (
		SELECT COUNT(*) FROM channels c
		WHERE c.subscribed = 1
			AND NOT EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id)
	),
	orphaned_channels = (
		SELECT COUNT(*) FROM channels c
		WHERE NOT EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id)
	),
	recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE migration = '0016_prefs_no_global_copy';
