-- Podcast discovery and RSS ingestion (additive; YouTube tables unchanged)

CREATE TABLE podcast_subscriptions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	external_feed_id INTEGER NOT NULL,
	feed_url TEXT NOT NULL,
	title TEXT NOT NULL,
	publisher TEXT NOT NULL DEFAULT '',
	description TEXT NOT NULL DEFAULT '',
	image_url TEXT NOT NULL DEFAULT '',
	follow_in_inbox INTEGER NOT NULL DEFAULT 1,
	max_episodes_to_pull INTEGER NOT NULL DEFAULT 20,
	catchup_pulled INTEGER NOT NULL DEFAULT 0,
	subscribed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	last_polled_at TEXT,
	etag TEXT,
	last_modified TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id),
	UNIQUE (user_id, external_feed_id)
);

CREATE INDEX idx_podcast_subs_user ON podcast_subscriptions(user_id);

CREATE TABLE podcast_episodes (
	episode_id TEXT PRIMARY KEY,
	feed_url TEXT NOT NULL,
	guid TEXT NOT NULL,
	subscription_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description_excerpt TEXT NOT NULL DEFAULT '',
	image_url TEXT NOT NULL DEFAULT '',
	audio_url TEXT NOT NULL DEFAULT '',
	published_at TEXT,
	duration_seconds INTEGER,
	FOREIGN KEY (subscription_id) REFERENCES podcast_subscriptions(id),
	UNIQUE (feed_url, guid)
);

CREATE INDEX idx_podcast_episodes_sub ON podcast_episodes(subscription_id);
CREATE INDEX idx_podcast_episodes_published ON podcast_episodes(published_at);

CREATE TABLE podcast_inbox_state (
	user_id TEXT NOT NULL,
	episode_id TEXT NOT NULL,
	unread INTEGER NOT NULL DEFAULT 1,
	starred INTEGER NOT NULL DEFAULT 0,
	archived INTEGER NOT NULL DEFAULT 0,
	hidden INTEGER NOT NULL DEFAULT 0,
	first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	snoozed_until TEXT,
	notes TEXT NOT NULL DEFAULT '',
	watched_at TEXT,
	playback_seconds INTEGER NOT NULL DEFAULT 0,
	last_position_seconds INTEGER NOT NULL DEFAULT 0,
	watch_updated_at TEXT,
	PRIMARY KEY (user_id, episode_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (episode_id) REFERENCES podcast_episodes(episode_id)
);

CREATE INDEX idx_podcast_inbox_user ON podcast_inbox_state(user_id);
