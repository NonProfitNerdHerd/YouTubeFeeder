ALTER TABLE inbox_state ADD COLUMN notes TEXT;

CREATE TABLE watchlists (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE watchlist_items (
	user_id TEXT NOT NULL,
	watchlist_id TEXT NOT NULL,
	video_id TEXT NOT NULL,
	added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (user_id, watchlist_id, video_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
	FOREIGN KEY (video_id) REFERENCES videos(video_id)
);

CREATE INDEX idx_watchlists_user ON watchlists(user_id);
CREATE INDEX idx_watchlist_items_list ON watchlist_items(user_id, watchlist_id);
CREATE INDEX idx_watchlist_items_video ON watchlist_items(user_id, video_id);
