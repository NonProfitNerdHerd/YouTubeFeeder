import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';
import { syncSubscriptions } from '../../worker/services/sync';
import { createYoutubeClient, YoutubeApiError, type YoutubeClient } from '../../worker/services/youtube';
import {
	channelEligibleForUnsubscribe,
	handleWebSubNotification,
	handleWebSubVerification,
	HUB_FETCH_LIMIT,
	hubSecretFromSession,
	renewExpiringLeases,
	topicForChannel,
	unsubscribeIfOrphaned,
} from '../../worker/services/websub';
import { processPendingWebSubEvents } from '../../worker/services/websubProcess';

const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CH_SHARED = 'UCcccccccccccccccccccccc';
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
			if (path === 'search') {
				yt.searchQueries += 1;
				yt.calls.search += 1;
			} else {
				yt.quotaUsed += 1;
				if (path === 'videos') yt.calls.videos += 1;
				else if (path === 'playlistItems') yt.calls.playlistItems += 1;
				else if (path === 'channels') yt.calls.channels += 1;
				else if (path === 'subscriptions') yt.calls.subscriptions += 1;
				else yt.calls.other += 1;
			}
			if (path === 'channels') {
				try {
					return await handler(path, params);
				} catch {
					return { items: [] };
				}
			}
			return handler(path, params);
		},
	};
	return yt;
}

function subItems(ids: string[]) {
	return {
		items: ids.map((channelId) => ({
			snippet: { title: channelId, resourceId: { channelId }, thumbnails: {} },
		})),
	};
}

function atomFor(channelId: string, videoId: string, updated = '2026-08-17T00:00:01Z') {
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <entry>
    <id>yt:video:${videoId}</id>
    <yt:videoId>${videoId}</yt:videoId>
    <yt:channelId>${channelId}</yt:channelId>
    <title>Hello</title>
    <published>2026-08-17T00:00:00Z</published>
    <updated>${updated}</updated>
  </entry>
</feed>`;
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

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('per-user subscription isolation', () => {
	it('keeps user A membership when user B syncs a different list', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db);
		const ytA = mockYt(async (path) => {
			if (path === 'subscriptions') return subItems([CH_A, CH_SHARED]);
			if (path === 'channels') return { items: [] };
			throw new Error(path);
		});
		const ytB = mockYt(async (path) => {
			if (path === 'subscriptions') return subItems([CH_B, CH_SHARED]);
			throw new Error(path);
		});
		await syncSubscriptions(env, 'user-1', 'token', ytA);
		await syncSubscriptions(env, 'user-2', 'token', ytB);
		expect(db.prefs.get(`user-1:${CH_A}`)?.is_subscribed).toBe(1);
		expect(db.prefs.get(`user-1:${CH_SHARED}`)?.is_subscribed).toBe(1);
		expect(db.prefs.get(`user-2:${CH_B}`)?.is_subscribed).toBe(1);
		expect(db.prefs.get(`user-2:${CH_A}`)).toBeUndefined();

		const ytB2 = mockYt(async (path) => {
			if (path === 'subscriptions') return subItems([CH_B]);
			throw new Error(path);
		});
		await syncSubscriptions(env, 'user-2', 'token', ytB2);
		expect(db.prefs.get(`user-1:${CH_SHARED}`)?.is_subscribed).toBe(1);
		expect(db.prefs.get(`user-2:${CH_SHARED}`)?.is_subscribed).toBe(0);
		expect(db.prefs.get(`user-2:${CH_B}`)?.is_subscribed).toBe(1);
		expect(db.channels.size).toBe(3);
	});

	it('does not unsubscribe after a failed partial snapshot', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({ channel_id: CH_A, uploads_playlist_id: 'UUa' }, 'user-1');
		let page = 0;
		const yt = mockYt(async (path) => {
			if (path === 'subscriptions') {
				page += 1;
				if (page === 2) {
					throw new YoutubeApiError('YouTube API quota exhausted.', 403, true, 'subscriptions', 'quotaExceeded');
				}
				return { nextPageToken: 'more', items: subItems([CH_A]).items };
			}
			throw new Error(path);
		});
		const result = await syncSubscriptions(asEnv(db), 'user-1', 'token', yt);
		expect(result.status).toBe('quota');
		expect(db.prefs.get(`user-1:${CH_A}`)?.is_subscribed).toBe(1);
	});

	it('pages 250 subscriptions across 5 subscriptions.list calls', async () => {
		const db = new MemorySyncDb();
		let page = 0;
		const yt = mockYt(async (path) => {
			if (path === 'subscriptions') {
				const start = page * 50;
				page += 1;
				return {
					nextPageToken: page < 5 ? String(page) : undefined,
					items: Array.from({ length: 50 }, (_, i) => {
						const n = start + i;
						return {
							snippet: {
								title: `c${n}`,
								resourceId: { channelId: `UC${String(n).padStart(22, '0')}` },
							},
						};
					}),
				};
			}
			throw new Error(path);
		});
		const result = await syncSubscriptions(asEnv(db), 'user-1', 'token', yt);
		expect(result.status).toBe('ok');
		expect(result.channelsChecked).toBe(250);
		expect(yt.calls.subscriptions).toBe(5);
		expect(db.channels.size).toBe(250);
	});

	it('stores one global channel row for two followers', async () => {
		const db = new MemorySyncDb();
		const env = asEnv(db);
		const yt = mockYt(async (path) => {
			if (path === 'subscriptions') return subItems([CH_SHARED]);
			throw new Error(path);
		});
		await syncSubscriptions(env, 'user-1', 'token', yt);
		await syncSubscriptions(env, 'user-2', 'token', yt);
		expect(db.channels.size).toBe(1);
		expect(db.prefs.get(`user-1:${CH_SHARED}`)?.is_subscribed).toBe(1);
		expect(db.prefs.get(`user-2:${CH_SHARED}`)?.is_subscribed).toBe(1);
	});
});

describe('WebSub callback and fan-out', () => {
	it('echoes the hub challenge for a followed channel', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({ channel_id: CH_SHARED, uploads_playlist_id: 'UU' }, 'user-1');
		const url = new URL('https://example.com/api/websub/callback');
		url.searchParams.set('hub.mode', 'subscribe');
		url.searchParams.set('hub.topic', topicForChannel(CH_SHARED));
		url.searchParams.set('hub.challenge', 'challenge-token');
		url.searchParams.set('hub.lease_seconds', '432000');
		const res = await handleWebSubVerification(asEnv(db), url);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('challenge-token');
		expect(db.websub.get(CH_SHARED)?.status).toBe('active');
	});

	it('rejects an invalid topic and malformed Atom', async () => {
		const db = new MemorySyncDb();
		const bad = new URL('https://example.com/api/websub/callback');
		bad.searchParams.set('hub.mode', 'subscribe');
		bad.searchParams.set('hub.topic', 'https://evil.example/feed');
		bad.searchParams.set('hub.challenge', 'x');
		expect((await handleWebSubVerification(asEnv(db), bad)).status).toBe(404);

		const secret = await hubSecretFromSession(SESSION);
		const xml = 'not-atom';
		const req = new Request('https://example.com/api/websub/callback', {
			method: 'POST',
			headers: { 'x-hub-signature': `sha1=${await signBody(secret, xml)}` },
			body: xml,
		});
		const posted = await handleWebSubNotification(asEnv(db, { SESSION_SECRET: SESSION }), req);
		expect(posted.response.status).toBe(400);

		const huge = await handleWebSubNotification(
			asEnv(db, { SESSION_SECRET: SESSION }),
			new Request('https://example.com/api/websub/callback', {
				method: 'POST',
				headers: { 'content-length': '300000' },
				body: 'x',
			}),
		);
		expect(huge.response.status).toBe(413);
	});

	it('fans out one video to followers and ignores duplicate deliveries', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({ channel_id: CH_SHARED, uploads_playlist_id: 'UU' }, 'user-1');
		db.seedChannel({ channel_id: CH_SHARED, uploads_playlist_id: 'UU', follow_in_inbox: 1 }, 'user-2');
		const xml = atomFor(CH_SHARED, VIDEO);
		const secret = await hubSecretFromSession(SESSION);
		const sig = await signBody(secret, xml);
		const env = asEnv(db, { SESSION_SECRET: SESSION, YOUTUBE_API_KEY: 'key' });
		const post = () =>
			handleWebSubNotification(
				env,
				new Request('https://example.com/api/websub/callback', {
					method: 'POST',
					headers: { 'x-hub-signature': `sha1=${sig}` },
					body: xml,
				}),
			);
		expect((await post()).inserted).toBe(1);
		expect((await post()).inserted).toBe(0);
		expect(db.events.size).toBe(1);

		const yt = mockYt(async (path) => {
			if (path === 'videos') {
				return {
					items: [
						{
							id: VIDEO,
							snippet: {
								channelId: CH_SHARED,
								title: 'Hello',
								description: '',
								publishedAt: '2026-08-17T00:00:00Z',
								liveBroadcastContent: 'none',
								thumbnails: {},
							},
							contentDetails: { duration: 'PT1M' },
							status: { embeddable: true },
						},
					],
				};
			}
			throw new Error(path);
		});
		await processPendingWebSubEvents(env, 50, yt);
		await processPendingWebSubEvents(env, 50, yt);
		expect(db.inbox.get(`user-1:${VIDEO}`)).toBeTruthy();
		expect(db.inbox.get(`user-2:${VIDEO}`)).toBeTruthy();
		expect(db.inbox.size).toBe(2);
		expect(db.videos.size).toBe(1);
	});

	it('marks a zero-follower channel eligible to unsubscribe', async () => {
		expect(channelEligibleForUnsubscribe(0)).toBe(true);
		expect(channelEligibleForUnsubscribe(1)).toBe(false);
		const db = new MemorySyncDb();
		db.seedChannel({ channel_id: CH_A, uploads_playlist_id: 'UU', is_subscribed: 0 }, 'user-1');
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(undefined, { status: 204 });
		}) as typeof fetch;
		await unsubscribeIfOrphaned(asEnv(db, { PUBLIC_ORIGIN: 'https://example.com', SESSION_SECRET: SESSION }), [CH_A]);
		expect(calls.some((url) => url.includes('pubsubhubbub.appspot.com'))).toBe(true);
		expect(db.websub.get(CH_A)?.status).toBe('inactive');
	});

	it('Reload enqueues hub rows without calling the hub', async () => {
		const db = new MemorySyncDb();
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(undefined, { status: 204 });
		}) as typeof fetch;
		const yt = mockYt(async (path) => {
			if (path === 'subscriptions') return subItems([CH_A, CH_SHARED]);
			return { items: [] };
		});
		const result = await syncSubscriptions(
			asEnv(db, { PUBLIC_ORIGIN: 'https://example.com', SESSION_SECRET: SESSION }),
			'user-1',
			'token',
			yt,
		);
		expect(result.status).toBe('ok');
		expect(db.websub.get(CH_A)?.status).toBe('pending');
		expect(db.websub.get(CH_SHARED)?.status).toBe('pending');
		expect(calls.some((url) => url.includes('pubsubhubbub.appspot.com'))).toBe(false);
	});

	it('cron hub-subscribes never-attempted channels first, then the next batch', async () => {
		expect(HUB_FETCH_LIMIT).toBe(20);
		const db = new MemorySyncDb();
		const ids = Array.from({ length: 45 }, (_, i) => `UC${String(i).padStart(22, '0')}`);
		for (const channelId of ids) {
			db.seedChannel({ channel_id: channelId, uploads_playlist_id: 'UU' }, 'user-1');
		}
		const hubCalls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			hubCalls.push(`${String(input)} ${String(init?.body ?? '')}`);
			return new Response(undefined, { status: 204 });
		}) as typeof fetch;
		const env = asEnv(db, { PUBLIC_ORIGIN: 'https://example.com', SESSION_SECRET: SESSION });
		expect(await renewExpiringLeases(env, 20)).toBe(20);
		expect(hubCalls).toHaveLength(20);
		const first = ids.filter((id) => db.websub.get(id)?.last_subscribe_attempt_at);
		expect(first).toHaveLength(20);
		hubCalls.length = 0;
		expect(await renewExpiringLeases(env, 20)).toBe(20);
		expect(hubCalls).toHaveLength(20);
		const attempted = ids.filter((id) => db.websub.get(id)?.last_subscribe_attempt_at);
		expect(attempted).toHaveLength(40);
		hubCalls.length = 0;
		expect(await renewExpiringLeases(env, 20)).toBe(5);
		expect(hubCalls).toHaveLength(5);
		expect(ids.every((id) => db.websub.get(id)?.last_subscribe_attempt_at)).toBe(true);
	});
});

describe('scheduler and quota accounting', () => {
	it('scheduled feed maintenance has no per-user playlist sweep', () => {
		const index = readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
		expect(index).toContain('runFeedMaintenance');
		expect(index).toContain('runScheduledQuadRefresh');
		expect(index).not.toContain('syncAllDueContent');
		const feed = readFileSync(new URL('../../worker/services/feedSchedule.ts', import.meta.url), 'utf8');
		expect(feed).not.toContain('syncAllDueContent');
		expect(feed).not.toContain('syncContent(');
		const sync = readFileSync(new URL('../../worker/services/sync.ts', import.meta.url), 'utf8');
		expect(sync).toContain('enqueueHubSubscriptions');
		expect(sync).not.toContain('subscribeHubChannels');
		expect(sync).not.toContain('unsubscribeIfOrphaned');
	});

	it('search.list does not consume 100 general units', async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch;
		const yt = createYoutubeClient('token');
		await yt.getJson('search', { part: 'snippet' });
		expect(yt.quotaUsed).toBe(0);
		expect(yt.searchQueries).toBe(1);
		await yt.getJson('videos', { part: 'snippet', id: VIDEO });
		expect(yt.quotaUsed).toBe(1);
		expect(yt.calls.videos).toBe(1);
	});
});
