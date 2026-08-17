import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	applyInboxProgress,
	countInbox,
	countUnwatchedInbox,
	listInbox,
	markInboxWatched,
	unwatchInboxItem,
	watchAllInbox,
} from '../../worker/db/queries';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const USER_A = 'user-a';
const USER_B = 'user-b';
const CH = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const VID_A = 'aaaaaaaaaaa';
const VID_B = 'bbbbbbbbbbb';
const VID_C = 'ccccccccccc';
const VID_SHORT = 'shortclip00';

function createD1(db: DatabaseSync): D1Database {
	const prepare = (sql: string) => {
		const bound = (values: unknown[]) => ({
			async first<T>() {
				const stmt = db.prepare(sql);
				const row = (values.length ? stmt.get(...values) : stmt.get()) as T | undefined;
				return row ?? null;
			},
			async all<T>() {
				const stmt = db.prepare(sql);
				const results = (values.length ? stmt.all(...values) : stmt.all()) as T[];
				return { results, success: true as const, meta: {} };
			},
			async run() {
				const stmt = db.prepare(sql);
				const info = values.length ? stmt.run(...values) : stmt.run();
				return {
					success: true as const,
					meta: {
						changes: Number(info.changes ?? 0),
						last_row_id: Number(info.lastInsertRowid ?? 0),
					},
				};
			},
		});
		return {
			bind(...values: unknown[]) {
				return bound(values);
			},
			...bound([]),
		};
	};
	return { prepare } as unknown as D1Database;
}

function seed(): { db: DatabaseSync; d1: D1Database } {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, google_account_id TEXT, display_name TEXT);
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
			last_api_update_at TEXT
		);
		CREATE TABLE inbox_state (
			user_id TEXT NOT NULL,
			video_id TEXT NOT NULL,
			unread INTEGER NOT NULL DEFAULT 1,
			starred INTEGER NOT NULL DEFAULT 0,
			archived INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0,
			first_seen_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			read_at TEXT,
			snoozed_until TEXT,
			notes TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (user_id, video_id)
		);
		CREATE TABLE channel_prefs (
			user_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			follow_in_inbox INTEGER NOT NULL DEFAULT 1,
			max_videos_to_pull INTEGER NOT NULL DEFAULT 0,
			is_subscribed INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (user_id, channel_id)
		);
		CREATE TABLE watchlist_items (
			user_id TEXT NOT NULL,
			watchlist_id TEXT NOT NULL,
			video_id TEXT NOT NULL,
			PRIMARY KEY (user_id, watchlist_id, video_id)
		);
		INSERT INTO users (id, google_account_id, display_name) VALUES ('${USER_A}', 'ga', 'A'), ('${USER_B}', 'gb', 'B');
		INSERT INTO channels (channel_id, title) VALUES ('${CH}', 'Test channel');
		INSERT INTO channel_prefs (user_id, channel_id, is_subscribed) VALUES ('${USER_A}', '${CH}', 1), ('${USER_B}', '${CH}', 1);
		INSERT INTO videos (video_id, channel_id, title, duration_seconds, content_type, livestream_status, published_at)
		VALUES
			('${VID_A}', '${CH}', 'Long video', 600, 'video', 'none', '2026-01-02T00:00:00Z'),
			('${VID_B}', '${CH}', 'Live', NULL, 'live', 'live', '2026-01-03T00:00:00Z'),
			('${VID_C}', '${CH}', 'Other', 120, 'video', 'none', '2026-01-04T00:00:00Z'),
			('${VID_SHORT}', '${CH}', 'Short', 40, 'video', 'none', '2026-01-01T00:00:00Z');
		INSERT INTO inbox_state (user_id, video_id, unread) VALUES
			('${USER_A}', '${VID_A}', 1),
			('${USER_A}', '${VID_B}', 1),
			('${USER_A}', '${VID_SHORT}', 1),
			('${USER_B}', '${VID_A}', 1),
			('${USER_B}', '${VID_C}', 1);
	`);
	db.exec(readFileSync(join(root, 'migrations/0017_inbox_watched.sql'), 'utf8'));
	return { db, d1: createD1(db) };
}

describe('inbox watched queries', () => {
	it('does not set watched_at on a progress PATCH with no genuine playback (open/select/play-pause/link)', async () => {
		const { db, d1 } = seed();
		const none = await applyInboxProgress(d1, USER_A, VID_A, { playbackSeconds: 0, lastPositionSeconds: 0 });
		expect(none?.watchedAt).toBeNull();
		expect(none?.playbackSeconds).toBe(0);
		const pause = await applyInboxProgress(d1, USER_A, VID_A, { playbackSeconds: 0.4, lastPositionSeconds: 0.4 });
		expect(pause?.watchedAt).toBeNull();
		db.close();
	});

	it('max-merges playback seconds and marks watched at 30s', async () => {
		const { db, d1 } = seed();
		await applyInboxProgress(d1, USER_A, VID_A, { playbackSeconds: 15, lastPositionSeconds: 15 });
		const lower = await applyInboxProgress(d1, USER_A, VID_A, { playbackSeconds: 8, lastPositionSeconds: 8 });
		expect(lower?.playbackSeconds).toBe(15);
		expect(lower?.lastPositionSeconds).toBe(8);
		expect(lower?.watchedAt).toBeNull();
		const done = await applyInboxProgress(d1, USER_A, VID_A, { playbackSeconds: 30, lastPositionSeconds: 30 });
		expect(done?.playbackSeconds).toBe(30);
		expect(done?.watchedAt).toBeTruthy();
		const again = await applyInboxProgress(d1, USER_A, VID_A, { playbackSeconds: 31, lastPositionSeconds: 31 });
		expect(again?.watchedAt).toBe(done?.watchedAt);
		db.close();
	});

	it('marks a short video at 50% and a live video at 30s or ended', async () => {
		const { db, d1 } = seed();
		const short = await applyInboxProgress(d1, USER_A, VID_SHORT, { playbackSeconds: 20 });
		expect(short?.watchedAt).toBeTruthy();
		const liveLow = await applyInboxProgress(d1, USER_A, VID_B, { playbackSeconds: 29 });
		expect(liveLow?.watchedAt).toBeNull();
		const live = await applyInboxProgress(d1, USER_A, VID_B, { playbackSeconds: 30 });
		expect(live?.watchedAt).toBeTruthy();
		await unwatchInboxItem(d1, USER_A, VID_B);
		const ended = await applyInboxProgress(d1, USER_A, VID_B, { playbackSeconds: 2, ended: true });
		expect(ended?.watchedAt).toBeTruthy();
		db.close();
	});

	it('manual watch does not require playback and unwatch zeros progress', async () => {
		const { db, d1 } = seed();
		const watched = await markInboxWatched(d1, USER_A, VID_A);
		expect(watched?.watchedAt).toBeTruthy();
		expect(watched?.playbackSeconds).toBe(0);
		await applyInboxProgress(d1, USER_A, VID_A, { playbackSeconds: 12, lastPositionSeconds: 12 });
		const cleared = await unwatchInboxItem(d1, USER_A, VID_A);
		expect(cleared?.watchedAt).toBeNull();
		expect(cleared?.playbackSeconds).toBe(0);
		expect(cleared?.lastPositionSeconds).toBe(0);
		db.close();
	});

	it('keeps two user_ids isolated', async () => {
		const { db, d1 } = seed();
		await markInboxWatched(d1, USER_A, VID_A);
		const a = await listInbox(d1, USER_A, null, null, 'inbox', null, 'all');
		const b = await listInbox(d1, USER_B, null, null, 'inbox', null, 'all');
		expect(a.find((row) => row.videoId === VID_A)?.watchedAt).toBeTruthy();
		expect(b.find((row) => row.videoId === VID_A)?.watchedAt).toBeNull();
		expect(b.find((row) => row.videoId === VID_C)).toBeTruthy();
		expect(a.find((row) => row.videoId === VID_C)).toBeUndefined();
		db.close();
	});

	it('filters watched/unwatched and leaves inbox count unchanged', async () => {
		const { db, d1 } = seed();
		const countBefore = await countInbox(d1, USER_A, null, null, 'inbox', null);
		await markInboxWatched(d1, USER_A, VID_A);
		const all = await listInbox(d1, USER_A, null, null, 'inbox', null, 'all');
		const watched = await listInbox(d1, USER_A, null, null, 'inbox', null, 'watched');
		const unwatched = await listInbox(d1, USER_A, null, null, 'inbox', null, 'unwatched');
		expect(all).toHaveLength(3);
		expect(watched.map((row) => row.videoId)).toEqual([VID_A]);
		expect(unwatched.map((row) => row.videoId).sort()).toEqual([VID_B, VID_SHORT].sort());
		expect(await countInbox(d1, USER_A, null, null, 'inbox', null)).toBe(countBefore);
		expect(await countUnwatchedInbox(d1, USER_A, null, null, 'inbox', null)).toBe(2);
		const updated = await watchAllInbox(d1, USER_A, null, null, 'inbox', null, 'all');
		expect(updated).toBeGreaterThanOrEqual(2);
		expect(await countUnwatchedInbox(d1, USER_A, null, null, 'inbox', null)).toBe(0);
		db.close();
	});

	it('progress helpers do not call YouTube or sync', () => {
		const queries = readFileSync(join(root, 'worker/db/queries.ts'), 'utf8');
		const index = readFileSync(join(root, 'worker/index.ts'), 'utf8');
		expect(queries).not.toMatch(/googleapis|youtube\.googleapis|syncFeedNow|catchUpChannel|syncSubscriptions/);
		const progressBlock = index.slice(index.indexOf("body.action === 'progress'"), index.indexOf("body.action === 'watch'"));
		expect(progressBlock).toContain('applyInboxProgress');
		expect(progressBlock).not.toMatch(/syncFeedNow|catchUpChannel|syncSubscriptions|accessTokenForUser/);
	});
});
