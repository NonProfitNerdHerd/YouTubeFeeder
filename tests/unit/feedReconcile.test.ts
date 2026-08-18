import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { YoutubeApiError, type YoutubeClient } from '../../worker/services/youtube';
import {
	listDueChannels,
	reconcileDueChannels,
} from '../../worker/services/feedReconcile';
import { runManualSyncJob } from '../../worker/services/feedJobs';
import {
	canContinueReconcile,
	canRunBackfill,
	invocationsForFullPass,
	quotaConfig,
	reconcileBatchSize,
} from '../../worker/services/quotaGuard';
import { processPendingWebSubEvents } from '../../worker/services/websubProcess';
import { catchUpChannel } from '../../worker/services/sync';
import {
	callbackTokenFromSession,
	handleWebSubNotification,
	hubSecretFromSession,
	ingestAddedToday,
	topicForChannel,
} from '../../worker/services/websub';
import { inboxIsStale, formatFeedHealth, prependNewerInboxItems, appendOlderInboxItems } from '../../src/lib/inboxFreshness';
import { nextAttemptAt } from '../../worker/services/websubProcess';

const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CH_C = 'UCcccccccccccccccccccccc';
const VIDEO = 'abcdefghijk';
const SESSION = 'test-session-secret-for-websub';

function emptyCalls() {
	return { search: 0, videos: 0, playlistItems: 0, channels: 0, subscriptions: 0, other: 0 };
}

function mockYt(handler: YoutubeClient['getJson']): YoutubeClient {
	const yt: YoutubeClient = {
		quotaUsed: 0,
		searchQueries: 0,
		calls: emptyCalls(),
		async getJson(path, params) {
			yt.quotaUsed += 1;
			if (path === 'videos') yt.calls.videos += 1;
			else if (path === 'playlistItems') yt.calls.playlistItems += 1;
			else if (path === 'channels') yt.calls.channels += 1;
			else yt.calls.other += 1;
			return handler(path, params);
		},
	};
	return yt;
}

function videoItem(id: string, channelId: string, publishedAt = '2026-08-17T00:00:00Z') {
	return {
		id,
		snippet: {
			channelId,
			title: id,
			description: '',
			publishedAt,
			liveBroadcastContent: 'none',
			thumbnails: {},
		},
		contentDetails: { duration: 'PT1M' },
		status: { embeddable: true },
	};
}

async function signBody(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('feed reconcile scheduling', () => {
	it('migration 0018 adds reconcile columns, jobs, ingest, and backfills last_reconciled_at', () => {
		const sql = readFileSync(new URL('../../migrations/0018_feed_reconcile.sql', import.meta.url), 'utf8');
		expect(sql).toContain('last_reconciled_at');
		expect(sql).toContain('SET last_reconciled_at = last_synchronized_at');
		expect(sql).toContain('feed_sync_jobs');
		expect(sql).toContain('feed_ingest_daily');
		expect(sql).toContain('last_notify_at');
		expect(sql).not.toMatch(/DROP TABLE/);
	});

	it('selects never-reconciled first, then oldest last_reconciled_at', async () => {
		const db = new MemorySyncDb();
		const now = Date.parse('2026-08-18T12:00:00Z');
		db.seedChannel({ channel_id: CH_B, uploads_playlist_id: 'UUb', last_reconciled_at: '2026-08-18T08:00:00Z' });
		db.seedChannel({ channel_id: CH_A, uploads_playlist_id: 'UUa', last_reconciled_at: null });
		db.seedChannel({
			channel_id: CH_C,
			uploads_playlist_id: 'UUc',
			last_reconciled_at: new Date(now - 30 * 60 * 1000).toISOString(),
		});
		const due = await listDueChannels(db as unknown as D1Database, 10, { now });
		expect(due.map((row) => row.channel_id)).toEqual([CH_A, CH_B]);
	});

	it('covers 105 channels inside a 2-hour window with continuations', () => {
		const batch = reconcileBatchSize({ dueCount: 105, remainingQuota: 10_000, reconcileReserve: 2_000 });
		expect(batch).toBeGreaterThanOrEqual(10);
		expect(batch).toBeLessThanOrEqual(12);
		const invocations = invocationsForFullPass(105, batch);
		expect(invocations).toBeLessThanOrEqual(12);
		expect(invocations * batch).toBeGreaterThanOrEqual(105);
	});

	it('one 500 does not stop the batch and backoff skips until next_retry_at', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({ channel_id: CH_A, uploads_playlist_id: 'UUa' });
		db.seedChannel({ channel_id: CH_B, uploads_playlist_id: 'UUb' });
		const yt = mockYt(async (path, params) => {
			if (path === 'playlistItems' && params.playlistId === 'UUa') {
				throw new YoutubeApiError('YouTube API playlistItems failed (500).', 500, false, 'playlistItems');
			}
			if (path === 'playlistItems') return { items: [{ contentDetails: { videoId: 'newvideoid1' } }] };
			if (path === 'videos') return { items: [videoItem('newvideoid1', CH_B)] };
			return { items: [] };
		});
		const first = await reconcileDueChannels(asEnv(db, { YOUTUBE_API_KEY: 'key' }), { ytClient: yt, maxChannels: 12 });
		expect(first.channels).toBe(2);
		expect(first.errors).toBe(1);
		expect(first.videosAdded).toBe(1);
		expect(db.channels.get(CH_A)?.last_reconciled_at).toBeNull();
		expect(db.channels.get(CH_A)?.reconcile_next_retry_at).toBeTruthy();
		expect(db.channels.get(CH_B)?.last_reconciled_at).toBeTruthy();

		const skipped = await listDueChannels(db as unknown as D1Database, 10, { now: Date.now() });
		expect(skipped.map((row) => row.channel_id)).not.toContain(CH_A);

		const later = Date.parse(String(db.channels.get(CH_A)?.reconcile_next_retry_at)) + 1;
		const retryDue = await listDueChannels(db as unknown as D1Database, 10, { now: later });
		expect(retryDue.map((row) => row.channel_id)).toContain(CH_A);
		expect(nextAttemptAt(1, 0) < nextAttemptAt(3, 0)).toBe(true);
	});

	it('skips backfill when overdue or below the cutoff, and extra reconcile when under reserve', () => {
		const config = quotaConfig({} as Env);
		expect(canRunBackfill({ overdueCount: 1, manualJobActive: false, used: 100, config })).toBe(false);
		expect(canRunBackfill({ overdueCount: 0, manualJobActive: true, used: 100, config })).toBe(false);
		expect(canRunBackfill({ overdueCount: 0, manualJobActive: false, used: config.backfillCutoff, config })).toBe(false);
		expect(canRunBackfill({ overdueCount: 0, manualJobActive: false, used: 100, config })).toBe(true);
		expect(canContinueReconcile(config.reconcileReserve - 1, config.reconcileReserve)).toBe(false);
		expect(canContinueReconcile(config.reconcileReserve, config.reconcileReserve)).toBe(true);
	});

	it('does not tag a second feed_reconcile unit copy of playlistItems/videos', () => {
		const reconcile = readFileSync(new URL('../../worker/services/feedReconcile.ts', import.meta.url), 'utf8');
		expect(reconcile).toContain('recordYoutubeCalls');
		expect(reconcile).not.toMatch(/recordQuota\([^)]*feed_reconcile/);
		expect(reconcile).toContain("recordIngest(env.DB, 'reconcile'");
	});
});

describe('feed sync jobs', () => {
	it('resumes a manual job, rejects a concurrent job, and is idempotent on a second pass', async () => {
		const db = new MemorySyncDb();
		for (let i = 0; i < 15; i += 1) {
			const id = `UC${String(i).padStart(22, 'a')}`;
			db.seedChannel({ channel_id: id, uploads_playlist_id: `UU${i}` });
		}
		const yt = mockYt(async (path) => {
			if (path === 'playlistItems') return { items: [] };
			return { items: [] };
		});
		const env = asEnv(db, { YOUTUBE_API_KEY: 'key' });
		const first = await runManualSyncJob(env, 'user-1', { ytClient: yt });
		expect(first.done).toBe(false);
		expect(first.channelsChecked).toBeGreaterThanOrEqual(10);
		const second = await runManualSyncJob(env, 'user-1', { ytClient: yt });
		expect(second.done).toBe(true);
		expect(second.channelsChecked).toBeGreaterThanOrEqual(15);

		db.jobs.forEach((job) => {
			job.status = 'running';
			job.completed_at = null;
			job.user_id = 'user-2';
		});
		const busy = await runManualSyncJob(env, 'user-1', { ytClient: yt });
		expect(busy.status).toBe('busy');

		const third = await runManualSyncJob(asEnv(db, { YOUTUBE_API_KEY: 'key' }), 'user-2', { ytClient: yt });
		expect(third.status === 'ok' || third.status === 'busy').toBe(true);
	});
});

describe('shared ingest idempotency', () => {
	it('WebSub, reconcile, and Catch-up keep watched, archive, and first_seen_at', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({ channel_id: CH_A, uploads_playlist_id: 'UUa', max_videos_to_pull: 50 });
		db.videos.set(VIDEO, { video_id: VIDEO, channel_id: CH_A, published_at: '2026-01-01T00:00:00Z' });
		db.inbox.set(`user-1:${VIDEO}`, {
			user_id: 'user-1',
			video_id: VIDEO,
			watched_at: '2026-02-01T00:00:00Z',
			archived: 0,
			hidden: 0,
			first_seen_at: '2026-01-01T00:00:00.000Z',
		});
		db.events.set('evt-1', {
			id: 'evt-1',
			channel_id: CH_A,
			video_id: VIDEO,
			status: 'pending',
			attempts: 0,
			next_attempt_at: null,
			created_at: new Date().toISOString(),
		});
		const env = asEnv(db, { YOUTUBE_API_KEY: 'key', SESSION_SECRET: SESSION });
		await processPendingWebSubEvents(env, 50);
		const afterWebSub = db.inbox.get(`user-1:${VIDEO}`);
		expect(afterWebSub?.watched_at).toBe('2026-02-01T00:00:00Z');
		expect(afterWebSub?.first_seen_at).toBe('2026-01-01T00:00:00.000Z');
		expect(afterWebSub?.archived).toBe(0);

		const yt = mockYt(async (path, params) => {
			if (path === 'playlistItems') {
				expect(params.maxResults).toBe('15');
				return { items: [{ contentDetails: { videoId: VIDEO } }] };
			}
			throw new Error(`unexpected ${path}`);
		});
		await reconcileDueChannels(env, { ytClient: yt, force: true });
		const afterReconcile = db.inbox.get(`user-1:${VIDEO}`);
		expect(afterReconcile?.watched_at).toBe('2026-02-01T00:00:00Z');
		expect(afterReconcile?.first_seen_at).toBe('2026-01-01T00:00:00.000Z');

		const catchYt = mockYt(async (path) => {
			if (path === 'playlistItems') return { items: [{ contentDetails: { videoId: VIDEO } }], nextPageToken: undefined };
			return { items: [] };
		});
		await catchUpChannel(env, 'user-1', 'token', CH_A, '', 0, catchYt);
		const afterCatchup = db.inbox.get(`user-1:${VIDEO}`);
		expect(afterCatchup?.watched_at).toBe('2026-02-01T00:00:00Z');
		expect(afterCatchup?.first_seen_at).toBe('2026-01-01T00:00:00.000Z');
		expect(afterCatchup?.archived).toBe(0);
	});

	it('counts websub.notify separately from ingest source=websub', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({ channel_id: CH_A, uploads_playlist_id: 'UUa' });
		db.websub.set(CH_A, { channel_id: CH_A, status: 'active' });
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <link rel="self" href="${topicForChannel(CH_A)}"/>
  <entry>
    <id>yt:video:${VIDEO}</id>
    <yt:videoId>${VIDEO}</yt:videoId>
    <yt:channelId>${CH_A}</yt:channelId>
    <title>Hello</title>
    <published>2026-08-17T00:00:00Z</published>
    <updated>2026-08-17T00:00:01Z</updated>
  </entry>
</feed>`;
		const secret = await hubSecretFromSession(SESSION);
		const token = await callbackTokenFromSession(SESSION);
		const res = await handleWebSubNotification(
			asEnv(db, { SESSION_SECRET: SESSION }),
			new Request(`https://example.com/api/websub/callback?token=${token}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/atom+xml',
					'x-hub-signature': `sha1=${await signBody(secret, xml)}`,
				},
				body: xml,
			}),
		);
		expect(res.response.status).toBe(204);
		expect(res.inserted).toBe(1);
		expect(db.websub.get(CH_A)?.last_notify_at || db.quota.some((row) => row.endpoint === 'websub.notify')).toBeTruthy();
		expect(await ingestAddedToday(db as unknown as D1Database, 'websub')).toBe(0);
		expect(db.quota.some((row) => row.endpoint === 'websub.notify')).toBe(true);
	});
});

describe('inbox freshness and wiring', () => {
	it('detects a newer inbox head without reshuffling on equal timestamps', () => {
		expect(inboxIsStale('2026-08-18T10:00:00Z', '2026-08-18T11:00:00Z')).toBe(true);
		expect(inboxIsStale('2026-08-18T11:00:00Z', '2026-08-18T11:00:00Z')).toBe(false);
		expect(formatFeedHealth({ quotaLimited: true })).toContain('Quota limited');
		expect(formatFeedHealth({ overdueCount: 3 })).toContain('3 channels due');
	});

	it('prepends newer unseen videos above the current list', () => {
		const current = [
			{ videoId: 'aaaa1111111', publishedAt: '2026-08-18T10:00:00Z', scheduledStartAt: null, firstSeenAt: '2026-08-18T10:00:00Z' },
			{ videoId: 'bbbb2222222', publishedAt: '2026-08-18T09:00:00Z', scheduledStartAt: null, firstSeenAt: '2026-08-18T09:00:00Z' },
		];
		const incoming = [
			{ videoId: 'cccc3333333', publishedAt: '2026-08-18T11:00:00Z', scheduledStartAt: null, firstSeenAt: '2026-08-18T11:00:00Z' },
			...current,
		];
		expect(prependNewerInboxItems(current, incoming, '2026-08-18T10:00:00Z').map((item) => item.videoId)).toEqual([
			'cccc3333333',
			'aaaa1111111',
			'bbbb2222222',
		]);
		const unchanged = prependNewerInboxItems(current, current, '2026-08-18T10:00:00Z');
		expect(unchanged).toBe(current);
		expect(
			prependNewerInboxItems(
				current,
				[
					{ videoId: 'oldvid00001', publishedAt: '2026-08-18T08:00:00Z', scheduledStartAt: null, firstSeenAt: '2026-08-18T08:00:00Z' },
					...current,
				],
				'2026-08-18T10:00:00Z',
			),
		).toBe(current);
	});

	it('appends older unseen videos below the current list', () => {
		const current = [
			{ videoId: 'aaaa1111111', publishedAt: '2026-08-18T10:00:00Z', scheduledStartAt: null, firstSeenAt: '2026-08-18T10:00:00Z' },
		];
		const older = { videoId: 'bbbb2222222', publishedAt: '2026-08-18T09:00:00Z', scheduledStartAt: null, firstSeenAt: '2026-08-18T09:00:00Z' };
		expect(appendOlderInboxItems(current, [older, current[0]!]).map((item) => item.videoId)).toEqual(['aaaa1111111', 'bbbb2222222']);
		expect(appendOlderInboxItems(current, current)).toBe(current);
	});

	it('cron densifies to every 2 hours and Sync now uses the job path', () => {
		const wrangler = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
		expect(wrangler).toContain('0 */2 * * *');
		expect(wrangler).toContain('YOUTUBE_RECONCILE_RESERVE');
		const index = readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
		expect(index).toContain('continueOverdueReconcile');
		expect(index).toContain('buildFeedSyncStatus');
		expect(index).toContain('runFeedMaintenance(env, ctx)');
		expect(index).toContain('beforeId');
		expect(index).not.toContain('syncAllDueContent');
		const feed = readFileSync(new URL('../../worker/services/feedSchedule.ts', import.meta.url), 'utf8');
		expect(feed.indexOf('reconcileDueChannels')).toBeGreaterThan(feed.indexOf('processPendingWebSubEvents'));
		expect(feed).toContain('canRunBackfill');
		expect(feed).toContain('runManualSyncJob');
		const android = readFileSync(
			new URL('../../android/app/src/main/java/com/heartlandwiwx/streamfeeder/MainActivity.kt', import.meta.url),
			'utf8',
		);
		expect(android).toContain('onResume');
		expect(android).toContain('onAppResume');
	});
});
