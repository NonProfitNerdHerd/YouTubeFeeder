-- Per-user For You recommendation feedback and dismissal history

CREATE TABLE recommendation_feedback (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id),
	provider TEXT NOT NULL,
	external_id TEXT NOT NULL,
	channel_title TEXT NOT NULL,
	channel_thumbnail TEXT NOT NULL DEFAULT '',
	interest_id TEXT,
	interest_label TEXT,
	action TEXT NOT NULL,
	matched_concepts_json TEXT NOT NULL DEFAULT '[]',
	recommendation_reason TEXT,
	base_score REAL,
	created_at TEXT NOT NULL,
	restored_at TEXT
);

CREATE INDEX idx_recommendation_feedback_user_created
	ON recommendation_feedback(user_id, created_at DESC);

CREATE INDEX idx_recommendation_feedback_active_suppression
	ON recommendation_feedback(user_id, provider, external_id, restored_at);
