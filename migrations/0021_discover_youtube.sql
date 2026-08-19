-- YouTube Discover: search cache, browse cache, follow_source on channel_prefs

CREATE TABLE discover_search_cache (
	cache_key TEXT PRIMARY KEY,
	results_json TEXT NOT NULL,
	searched_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE TABLE discover_browse_cache (
	section_key TEXT PRIMARY KEY,
	payload_json TEXT NOT NULL,
	refreshed_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

ALTER TABLE channel_prefs ADD COLUMN follow_source TEXT NOT NULL DEFAULT 'youtube_sync';

UPDATE channel_prefs
SET follow_source = 'youtube_sync'
WHERE last_subscription_sync_id IS NOT NULL;

UPDATE channel_prefs
SET follow_source = 'manual'
WHERE last_subscription_sync_id IS NULL
	AND is_subscribed = 1
	AND (
		COALESCE(catchup_pulled, 0) > 0
		OR catchup_page_token IS NOT NULL
		OR newest_seen_published_at IS NOT NULL
		OR EXISTS (
			SELECT 1 FROM channel_categories cc
			WHERE cc.user_id = channel_prefs.user_id AND cc.channel_id = channel_prefs.channel_id
		)
		OR EXISTS (
			SELECT 1 FROM inbox_state i
			JOIN videos v ON v.video_id = i.video_id
			WHERE i.user_id = channel_prefs.user_id AND v.channel_id = channel_prefs.channel_id
		)
	);

UPDATE channel_prefs
SET follow_source = 'legacy'
WHERE last_subscription_sync_id IS NULL
	AND is_subscribed = 1
	AND follow_source = 'youtube_sync';

CREATE INDEX idx_channel_prefs_follow_source ON channel_prefs(user_id, follow_source, is_subscribed);
