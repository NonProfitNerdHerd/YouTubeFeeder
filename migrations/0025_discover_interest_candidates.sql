-- Per-user Browse Popular candidates persisted until follow or dismiss

CREATE TABLE discover_interest_candidates (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id),
	interest_id TEXT NOT NULL,
	interest_label TEXT NOT NULL,
	provider TEXT NOT NULL,
	external_id TEXT NOT NULL,
	channel_title TEXT NOT NULL,
	channel_thumbnail TEXT NOT NULL DEFAULT '',
	channel_description TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL,
	recommendation_reason TEXT NOT NULL,
	dismissed_at TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (user_id, interest_id, provider, external_id)
);

CREATE INDEX idx_discover_interest_candidates_user_active
	ON discover_interest_candidates(user_id, interest_id, dismissed_at);
