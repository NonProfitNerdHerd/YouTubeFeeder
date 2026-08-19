-- Tag podcast subscriptions with the same user categories as YouTube channels.

CREATE TABLE podcast_categories (
	user_id TEXT NOT NULL,
	podcast_id TEXT NOT NULL,
	category_id TEXT NOT NULL,
	PRIMARY KEY (user_id, podcast_id, category_id),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (podcast_id) REFERENCES podcast_subscriptions(id) ON DELETE CASCADE,
	FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE INDEX idx_podcast_categories_category ON podcast_categories(user_id, category_id);
