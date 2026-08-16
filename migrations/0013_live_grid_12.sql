PRAGMA defer_foreign_keys = ON;

CREATE TABLE live_slots_new (
	user_id TEXT NOT NULL,
	slot_number INTEGER NOT NULL,
	source_id TEXT,
	video_id TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (user_id, slot_number),
	FOREIGN KEY (user_id) REFERENCES users(id),
	FOREIGN KEY (source_id) REFERENCES live_sources(id) ON DELETE SET NULL,
	CHECK (slot_number BETWEEN 1 AND 12)
);

INSERT INTO live_slots_new (user_id, slot_number, source_id, video_id, updated_at)
SELECT user_id, slot_number, source_id, video_id, updated_at FROM live_slots;

DROP TABLE live_slots;
ALTER TABLE live_slots_new RENAME TO live_slots;

CREATE TABLE live_session_new (
	user_id TEXT PRIMARY KEY,
	grid_size INTEGER NOT NULL DEFAULT 4,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (user_id) REFERENCES users(id),
	CHECK (grid_size IN (1, 4, 6, 8, 12))
);

INSERT INTO live_session_new (user_id, grid_size, updated_at)
SELECT user_id, grid_size, updated_at FROM live_session;

DROP TABLE live_session;
ALTER TABLE live_session_new RENAME TO live_session;

ALTER TABLE live_layouts ADD COLUMN slot9 TEXT;
ALTER TABLE live_layouts ADD COLUMN slot10 TEXT;
ALTER TABLE live_layouts ADD COLUMN slot11 TEXT;
ALTER TABLE live_layouts ADD COLUMN slot12 TEXT;

INSERT OR IGNORE INTO live_slots (user_id, slot_number, source_id)
SELECT user_id, 9, NULL FROM live_session;

INSERT OR IGNORE INTO live_slots (user_id, slot_number, source_id)
SELECT user_id, 10, NULL FROM live_session;

INSERT OR IGNORE INTO live_slots (user_id, slot_number, source_id)
SELECT user_id, 11, NULL FROM live_session;

INSERT OR IGNORE INTO live_slots (user_id, slot_number, source_id)
SELECT user_id, 12, NULL FROM live_session;

PRAGMA defer_foreign_keys = OFF;
