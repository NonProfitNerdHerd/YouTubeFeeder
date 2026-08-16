CREATE TABLE live_source_videos (
	source_id TEXT NOT NULL,
	video_id TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (source_id, video_id),
	FOREIGN KEY (source_id) REFERENCES live_sources(id) ON DELETE CASCADE
);

CREATE INDEX idx_live_source_videos_source ON live_source_videos(source_id);

ALTER TABLE live_slots ADD COLUMN video_id TEXT;
