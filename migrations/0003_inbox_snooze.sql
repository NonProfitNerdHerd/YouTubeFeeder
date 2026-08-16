ALTER TABLE inbox_state ADD COLUMN snoozed_until TEXT;
CREATE INDEX idx_inbox_user_snoozed ON inbox_state(user_id, snoozed_until);
