CREATE TABLE live_sources (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	youtube_url TEXT NOT NULL,
	notes TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1,
	is_live INTEGER NOT NULL DEFAULT 0,
	live_video_id TEXT,
	live_title TEXT,
	live_checked_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id),
	UNIQUE (user_id, channel_id)
);

CREATE TABLE live_source_categories (
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	category_id TEXT NOT NULL,
	PRIMARY KEY (user_id, source_id, category_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (source_id) REFERENCES live_sources(id) ON DELETE CASCADE,
	FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE live_slots (
	user_id TEXT NOT NULL,
	slot_number INTEGER NOT NULL,
	source_id TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (user_id, slot_number),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (source_id) REFERENCES live_sources(id) ON DELETE SET NULL,
	CHECK (slot_number BETWEEN 1 AND 8)
);

CREATE TABLE live_session (
	user_id TEXT PRIMARY KEY,
	grid_size INTEGER NOT NULL DEFAULT 4,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id),
	CHECK (grid_size IN (1, 4, 6, 8))
);

CREATE TABLE live_layouts (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	grid_size INTEGER NOT NULL DEFAULT 4,
	slot1 TEXT,
	slot2 TEXT,
	slot3 TEXT,
	slot4 TEXT,
	slot5 TEXT,
	slot6 TEXT,
	slot7 TEXT,
	slot8 TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id),
	UNIQUE (user_id, name)
);

CREATE INDEX idx_live_sources_user ON live_sources(user_id, display_name);
CREATE INDEX idx_live_source_categories_cat ON live_source_categories(user_id, category_id);
CREATE INDEX idx_live_layouts_user ON live_layouts(user_id);
