ALTER TABLE inbox_state ADD COLUMN watched_at TEXT;
ALTER TABLE inbox_state ADD COLUMN playback_seconds REAL NOT NULL DEFAULT 0;
ALTER TABLE inbox_state ADD COLUMN last_position_seconds REAL NOT NULL DEFAULT 0;
ALTER TABLE inbox_state ADD COLUMN watch_updated_at TEXT;
CREATE INDEX idx_inbox_user_watched ON inbox_state(user_id, watched_at);
