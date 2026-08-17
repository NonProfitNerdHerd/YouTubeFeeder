import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CH_ORPHAN = 'UCcccccccccccccccccccccc';
const CH_COPIED = 'UCdddddddddddddddddddddd';

function readMigration(name: string): string {
	return readFileSync(join(root, 'migrations', name), 'utf8');
}

function execSql(db: DatabaseSync, sql: string): void {
	db.exec(sql);
}

function seedBase(db: DatabaseSync): void {
	execSql(
		db,
		`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			google_account_id TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			encrypted_refresh_token TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE TABLE channels (
			channel_id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			thumbnail_url TEXT NOT NULL DEFAULT '',
			uploads_playlist_id TEXT,
			subscribed INTEGER NOT NULL DEFAULT 1,
			last_synchronized_at TEXT
		);
		CREATE TABLE videos (
			video_id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description_excerpt TEXT NOT NULL DEFAULT '',
			thumbnail_default TEXT NOT NULL DEFAULT '',
			thumbnail_medium TEXT NOT NULL DEFAULT '',
			thumbnail_high TEXT NOT NULL DEFAULT '',
			published_at TEXT,
			scheduled_start_at TEXT,
			actual_start_at TEXT,
			actual_end_at TEXT,
			duration_seconds INTEGER,
			content_type TEXT NOT NULL,
			livestream_status TEXT NOT NULL,
			embeddable INTEGER NOT NULL DEFAULT 1,
			last_api_update_at TEXT,
			FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
		);
		CREATE TABLE inbox_state (
			user_id TEXT NOT NULL,
			video_id TEXT NOT NULL,
			unread INTEGER NOT NULL DEFAULT 1,
			starred INTEGER NOT NULL DEFAULT 0,
			archived INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0,
			first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			read_at TEXT,
			PRIMARY KEY (user_id, video_id)
		);
		CREATE TABLE categories (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE TABLE channel_categories (
			user_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			category_id TEXT NOT NULL,
			PRIMARY KEY (user_id, channel_id, category_id)
		);
		CREATE TABLE channel_prefs (
			user_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			follow_in_inbox INTEGER NOT NULL DEFAULT 1,
			max_videos_to_pull INTEGER NOT NULL DEFAULT 5,
			newest_seen_published_at TEXT,
			PRIMARY KEY (user_id, channel_id)
		);
		INSERT INTO users (id, google_account_id, display_name) VALUES ('user-a', 'ga', 'A'), ('user-b', 'gb', 'B');
		INSERT INTO channels (channel_id, title, subscribed) VALUES
			('${CH_A}', 'A channel', 1),
			('${CH_ORPHAN}', 'Orphan', 1),
			('${CH_B}', 'B channel', 0);
		INSERT INTO channel_prefs (user_id, channel_id, follow_in_inbox, max_videos_to_pull, newest_seen_published_at)
		VALUES
			('user-a', '${CH_A}', 1, 5, '2026-01-01T00:00:00Z'),
			('user-b', '${CH_B}', 0, 10, NULL);
		`,
	);
}

function memberships(db: DatabaseSync): Array<{ user_id: string; channel_id: string; is_subscribed: number }> {
	return db
		.prepare('SELECT user_id, channel_id, is_subscribed FROM channel_prefs ORDER BY user_id, channel_id')
		.all() as Array<{ user_id: string; channel_id: string; is_subscribed: number }>;
}

describe('0015/0016 membership backfill', () => {
	it('does not copy global subscriptions onto every user', () => {
		const sql = readMigration('0015_subscription_websub.sql');
		expect(sql).not.toMatch(/CROSS\s+JOIN/i);
		expect(sql).not.toMatch(/INSERT OR IGNORE INTO channel_prefs[\s\S]*FROM users/i);
		expect(sql).toMatch(/UPDATE channel_prefs SET is_subscribed = 1/);
	});

	it('keeps User A prefs, does not give them to User B, and leaves orphan subscribed channels unassigned', () => {
		const db = new DatabaseSync(':memory:');
		seedBase(db);
		execSql(db, readMigration('0015_subscription_websub.sql'));
		const rows = memberships(db);
		expect(rows).toEqual([
			{ user_id: 'user-a', channel_id: CH_A, is_subscribed: 1 },
			{ user_id: 'user-b', channel_id: CH_B, is_subscribed: 1 },
		]);
		expect(rows.some((row) => row.user_id === 'user-b' && row.channel_id === CH_A)).toBe(false);
		expect(rows.some((row) => row.channel_id === CH_ORPHAN)).toBe(false);
		const orphanSubscribed = db
			.prepare(
				`SELECT COUNT(*) AS n FROM channels c
				 WHERE c.subscribed = 1
				 AND NOT EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = c.channel_id)`,
			)
			.get() as { n: number };
		expect(orphanSubscribed.n).toBe(1);
		db.close();
	});

	it('0016 removes CROSS JOIN copies without assigning orphan channels and reports the orphan count', () => {
		const db = new DatabaseSync(':memory:');
		seedBase(db);
		execSql(db, readMigration('0015_subscription_websub.sql'));
		execSql(
			db,
			`
			INSERT INTO channels (channel_id, title, subscribed) VALUES ('${CH_COPIED}', 'Copied', 1);
			INSERT INTO channel_prefs (user_id, channel_id, follow_in_inbox, max_videos_to_pull, is_subscribed)
			VALUES
				('user-a', '${CH_COPIED}', 1, 0, 1),
				('user-b', '${CH_A}', 1, 0, 1),
				('user-b', '${CH_ORPHAN}', 1, 0, 1),
				('user-a', '${CH_ORPHAN}', 1, 0, 1);
			`,
		);
		execSql(db, readMigration('0016_prefs_no_global_copy.sql'));
		const rows = memberships(db);
		expect(rows).toEqual([
			{ user_id: 'user-a', channel_id: CH_A, is_subscribed: 1 },
			{ user_id: 'user-b', channel_id: CH_B, is_subscribed: 1 },
		]);
		expect(rows.some((row) => row.channel_id === CH_ORPHAN)).toBe(false);
		expect(rows.some((row) => row.user_id === 'user-b' && row.channel_id === CH_A)).toBe(false);
		const report = db
			.prepare(`SELECT orphaned_subscribed_channels, orphaned_channels, prefs_removed FROM migration_reports WHERE migration = '0016_prefs_no_global_copy'`)
			.get() as { orphaned_subscribed_channels: number; orphaned_channels: number; prefs_removed: number };
		expect(report.prefs_removed).toBe(4);
		expect(report.orphaned_subscribed_channels).toBe(2);
		expect(report.orphaned_channels).toBe(2);
		db.close();
	});
});
