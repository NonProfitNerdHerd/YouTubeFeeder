-- Quad-only verification state. Does not alter Feed tables.

ALTER TABLE live_sources ADD COLUMN verify_state TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE live_sources ADD COLUMN verify_error TEXT;
