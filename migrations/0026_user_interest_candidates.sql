-- Extend per-user interest candidate queue with relevance metadata and retire global fallback rows

ALTER TABLE discover_interest_candidates ADD COLUMN originating_query TEXT NOT NULL DEFAULT '';
ALTER TABLE discover_interest_candidates ADD COLUMN matched_concepts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE discover_interest_candidates ADD COLUMN base_relevance_score REAL NOT NULL DEFAULT 0;
ALTER TABLE discover_interest_candidates ADD COLUMN discovered_at TEXT;
ALTER TABLE discover_interest_candidates ADD COLUMN last_presented_at TEXT;
ALTER TABLE discover_interest_candidates ADD COLUMN acted_at TEXT;
ALTER TABLE discover_interest_candidates ADD COLUMN inactive_reason TEXT;

UPDATE discover_interest_candidates
SET discovered_at = created_at
WHERE discovered_at IS NULL;

UPDATE discover_interest_candidates
SET dismissed_at = COALESCE(dismissed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    inactive_reason = 'global_fallback_cleanup'
WHERE source = 'global_fallback';
