CREATE TABLE live_categories (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id),
	UNIQUE (user_id, name)
);

DROP TABLE IF EXISTS live_source_categories;

CREATE TABLE live_source_categories (
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	category_id TEXT NOT NULL,
	PRIMARY KEY (user_id, source_id, category_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (source_id) REFERENCES live_sources(id) ON DELETE CASCADE,
	FOREIGN KEY (category_id) REFERENCES live_categories(id) ON DELETE CASCADE
);

CREATE INDEX idx_live_categories_user ON live_categories(user_id);
CREATE INDEX idx_live_source_categories_cat ON live_source_categories(user_id, category_id);
