-- Recent-upload reconciliation state, durable Sync-now jobs, and ingest metrics.
-- Additive only. Backfill last_reconciled_at from last_synchronized_at.

ALTER TABLE channels ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE channels ADD COLUMN last_reconcile_attempt_at TEXT;
ALTER TABLE channels ADD COLUMN reconcile_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN reconcile_last_error TEXT;
ALTER TABLE channels ADD COLUMN reconcile_next_retry_at TEXT;
ALTER TABLE channels ADD COLUMN last_new_video_at TEXT;

UPDATE channels SET last_reconciled_at = last_synchronized_at WHERE last_reconciled_at IS NULL AND last_synchronized_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channels_reconcile_due
	ON channels(last_reconciled_at, reconcile_next_retry_at, channel_id);

ALTER TABLE websub_subscriptions ADD COLUMN last_notify_at TEXT;

CREATE TABLE IF NOT EXISTS feed_sync_jobs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	status TEXT NOT NULL,
	user_id TEXT,
	cursor_channel_id TEXT,
	channels_total INTEGER NOT NULL DEFAULT 0,
	channels_checked INTEGER NOT NULL DEFAULT 0,
	videos_added INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	started_at TEXT NOT NULL,
	updated_at TEXT,
	completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_feed_sync_jobs_status ON feed_sync_jobs(status, kind, started_at);

CREATE TABLE IF NOT EXISTS feed_ingest_daily (
	day TEXT NOT NULL,
	source TEXT NOT NULL,
	videos_added INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, source)
);
