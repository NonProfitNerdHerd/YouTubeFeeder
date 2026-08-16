CREATE TABLE categories (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE channel_categories (
	user_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	category_id TEXT NOT NULL,
	PRIMARY KEY (user_id, channel_id, category_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (channel_id) REFERENCES channels(channel_id),
	FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE channel_prefs (
	user_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	follow_in_inbox INTEGER NOT NULL DEFAULT 1,
	max_videos_to_pull INTEGER NOT NULL DEFAULT 5,
	newest_seen_published_at TEXT,
	PRIMARY KEY (user_id, channel_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE INDEX idx_categories_user ON categories(user_id);
CREATE INDEX idx_channel_categories_category ON channel_categories(user_id, category_id);
