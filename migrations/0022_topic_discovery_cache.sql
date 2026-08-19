-- Global topic discovery cache for For You recommendations

CREATE TABLE topic_discovery_cache (
	normalized_topic TEXT PRIMARY KEY,
	results_json TEXT NOT NULL,
	searched_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
