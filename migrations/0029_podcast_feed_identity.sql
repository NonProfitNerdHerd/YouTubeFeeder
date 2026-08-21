-- Additive: provider-independent podcast subscription identity.
-- Preserves existing Podcast Index subscriptions; backfills normalized feed URLs.

ALTER TABLE podcast_subscriptions ADD COLUMN feed_url_normalized TEXT;
ALTER TABLE podcast_subscriptions ADD COLUMN provider_external_id TEXT;

-- Backfill from stored feed_url (lowercase host-style normalization done in app on write;
-- SQL backfill uses lower(trim) as a conservative first pass).
UPDATE podcast_subscriptions
SET feed_url_normalized = lower(trim(feed_url))
WHERE feed_url_normalized IS NULL OR feed_url_normalized = '';

UPDATE podcast_subscriptions
SET provider_external_id = CAST(external_feed_id AS TEXT)
WHERE provider_external_id IS NULL OR provider_external_id = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_subs_user_feed_norm
	ON podcast_subscriptions (user_id, feed_url_normalized)
	WHERE feed_url_normalized IS NOT NULL AND feed_url_normalized != '';
