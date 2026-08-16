CREATE UNIQUE INDEX idx_watchlists_user_name ON watchlists (user_id, name COLLATE NOCASE);
