-- Additive: Brave provider cache candidate-resolver versioning / resolution status.
-- Allows reprocessing raw Brave hits after resolver improvements without paying Brave again.
-- Does not alter subscription/feed/WebSub tables.

ALTER TABLE discover_provider_cache ADD COLUMN resolver_version TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE discover_provider_cache ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'ok';
