import { chunk } from './youtube';

export const YOUTUBE_HUB = 'https://pubsubhubbub.appspot.com/subscribe';
export const WEBSUB_CALLBACK_PATH = '/api/websub/callback';
export const WEBSUB_LEASE_SECONDS = 432000;
export const MAX_ATOM_BYTES = 256_000;
export const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
export const VIDEO_ID_RE = /^[\w-]{11}$/;
export const ATOM_CONTENT_TYPES = new Set(['application/atom+xml', 'application/xml']);

export function topicForChannel(channelId: string): string {
	return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

export function channelIdFromTopic(topic: string): string | null {
	try {
		const url = new URL(topic);
		if (url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') return null;
		if (url.pathname !== '/feeds/videos.xml' && url.pathname !== '/xml/feeds/videos.xml') return null;
		const id = url.searchParams.get('channel_id') ?? '';
		return CHANNEL_ID_RE.test(id) ? id : null;
	} catch {
		return null;
	}
}

async function hmacHex(sessionSecret: string, info: string, bytes: number): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(sessionSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(info));
	return toHex(sig).slice(0, bytes);
}

export async function hubSecretFromSession(sessionSecret: string): Promise<string> {
	return hmacHex(sessionSecret, 'youtube-websub-hub-secret', 32);
}

export async function callbackTokenFromSession(sessionSecret: string): Promise<string> {
	return hmacHex(sessionSecret, 'youtube-websub-callback-token', 32);
}

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let ok = 0;
	for (let i = 0; i < left.length; i++) ok |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return ok === 0;
}

export function acceptAtomContentType(header: string | null): boolean {
	const raw = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	return ATOM_CONTENT_TYPES.has(raw);
}

export async function verifyHubSignature(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
	if (!header) return false;
	const match = /^sha1=([a-fA-F0-9]{40})$/.exec(header.trim());
	if (!match) return false;
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, [
		'sign',
	]);
	const sig = await crypto.subtle.sign('HMAC', key, body);
	const expected = toHex(sig).toLowerCase();
	const given = match[1].toLowerCase();
	return timingSafeEqual(expected, given);
}

export function feedSelfHref(xml: string): string | null {
	const selfThenHref = /<link\b[^>]*\brel=["']self["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(xml);
	if (selfThenHref?.[1]) return selfThenHref[1];
	const hrefThenSelf = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']self["'][^>]*>/i.exec(xml);
	return hrefThenSelf?.[1] ?? null;
}

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

function tagValue(xml: string, tag: string): string | null {
	const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
	return match ? decodeXml(match[1].trim()) : null;
}

export interface ParsedWebSubEntry {
	id: string;
	channelId: string;
	videoId: string;
	title: string;
	publishedAt: string | null;
	updatedAt: string | null;
}

export function parseAtomEntries(xml: string): ParsedWebSubEntry[] {
	if (!xml.includes('<entry')) return [];
	const chunks = xml.split(/<entry[\s>]/i).slice(1);
	const entries: ParsedWebSubEntry[] = [];
	for (const raw of chunks) {
		const entry = raw.split(/<\/entry>/i)[0] ?? '';
		const videoId = tagValue(entry, 'yt:videoId') ?? tagValue(entry, 'videoId');
		const channelId = tagValue(entry, 'yt:channelId') ?? tagValue(entry, 'channelId');
		if (!videoId || !VIDEO_ID_RE.test(videoId) || !channelId || !CHANNEL_ID_RE.test(channelId)) continue;
		const atomId = tagValue(entry, 'id') ?? `yt:video:${videoId}`;
		const updatedAt = tagValue(entry, 'updated');
		entries.push({
			id: `${videoId}:${updatedAt ?? atomId}`,
			channelId,
			videoId,
			title: (tagValue(entry, 'title') ?? '').slice(0, 500),
			publishedAt: tagValue(entry, 'published'),
			updatedAt,
		});
	}
	return entries;
}

export async function recordQuota(
	db: D1Database,
	endpoint: string,
	opts: { callCount?: number; generalUnits?: number; searchCalls?: number },
): Promise<void> {
	const day = new Date().toISOString().slice(0, 10);
	await db
		.prepare(
			`INSERT INTO api_quota_daily (day, endpoint, call_count, general_units, search_calls)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(day, endpoint) DO UPDATE SET
				call_count = call_count + excluded.call_count,
				general_units = general_units + excluded.general_units,
				search_calls = search_calls + excluded.search_calls`,
		)
		.bind(day, endpoint, opts.callCount ?? 1, opts.generalUnits ?? 0, opts.searchCalls ?? 0)
		.run();
}

export async function recordYoutubeCalls(db: D1Database, yt: { quotaUsed: number; searchQueries: number; calls: Record<string, number> }): Promise<void> {
	const mapping: Array<[string, number, number, number]> = [
		['subscriptions.list', yt.calls.subscriptions ?? 0, yt.calls.subscriptions ?? 0, 0],
		['channels.list', yt.calls.channels ?? 0, yt.calls.channels ?? 0, 0],
		['playlistItems.list', yt.calls.playlistItems ?? 0, yt.calls.playlistItems ?? 0, 0],
		['videos.list', yt.calls.videos ?? 0, yt.calls.videos ?? 0, 0],
		['search.list', yt.calls.search ?? 0, 0, yt.searchQueries],
	];
	for (const [endpoint, calls, general, search] of mapping) {
		if (calls > 0 || search > 0) await recordQuota(db, endpoint, { callCount: calls || search, generalUnits: general, searchCalls: search });
	}
}

export async function dailyQuotaUsed(db: D1Database, endpoint: string): Promise<number> {
	const day = new Date().toISOString().slice(0, 10);
	const row = await db
		.prepare(`SELECT general_units FROM api_quota_daily WHERE day = ? AND endpoint = ?`)
		.bind(day, endpoint)
		.first<{ general_units: number }>();
	return row?.general_units ?? 0;
}

export type IngestSource = 'websub' | 'reconcile' | 'catchup' | 'backfill';

export async function recordIngest(db: D1Database, source: IngestSource, videosAdded: number): Promise<void> {
	if (videosAdded < 1) return;
	const day = new Date().toISOString().slice(0, 10);
	await db
		.prepare(
			`INSERT INTO feed_ingest_daily (day, source, videos_added)
			 VALUES (?, ?, ?)
			 ON CONFLICT(day, source) DO UPDATE SET videos_added = videos_added + excluded.videos_added`,
		)
		.bind(day, source, videosAdded)
		.run();
}

export async function ingestAddedToday(db: D1Database, source: IngestSource): Promise<number> {
	const day = new Date().toISOString().slice(0, 10);
	const row = await db
		.prepare(`SELECT videos_added FROM feed_ingest_daily WHERE day = ? AND source = ?`)
		.bind(day, source)
		.first<{ videos_added: number }>();
	return Number(row?.videos_added ?? 0);
}

export async function quotaRowsToday(db: D1Database): Promise<Array<{ endpoint: string; call_count: number; general_units: number }>> {
	const day = new Date().toISOString().slice(0, 10);
	const rows = await db
		.prepare(`SELECT endpoint, call_count, general_units FROM api_quota_daily WHERE day = ? ORDER BY endpoint`)
		.bind(day)
		.all<{ endpoint: string; call_count: number; general_units: number }>();
	return rows.results ?? [];
}

export async function countWebSubEvents(db: D1Database): Promise<{ pending: number; error: number; dead: number }> {
	const rows = await db
		.prepare(`SELECT status, COUNT(*) AS n FROM websub_events GROUP BY status`)
		.all<{ status: string; n: number }>();
	const counts = { pending: 0, error: 0, dead: 0 };
	for (const row of rows.results ?? []) {
		if (row.status === 'pending') counts.pending = row.n;
		else if (row.status === 'error') counts.error = row.n;
		else if (row.status === 'dead') counts.dead = row.n;
	}
	return counts;
}

export function callbackUrl(origin: string, token: string): string {
	const url = new URL(`${origin.replace(/\/$/, '')}${WEBSUB_CALLBACK_PATH}`);
	url.searchParams.set('token', token);
	return url.toString();
}

export async function requestHub(
	mode: 'subscribe' | 'unsubscribe',
	params: { origin: string; channelId: string; secret: string; token: string },
): Promise<{ ok: boolean; status: number }> {
	const body = new URLSearchParams({
		'hub.callback': callbackUrl(params.origin, params.token),
		'hub.topic': topicForChannel(params.channelId),
		'hub.verify': 'async',
		'hub.mode': mode,
		'hub.lease_seconds': String(WEBSUB_LEASE_SECONDS),
		'hub.secret': params.secret,
	});
	const res = await fetch(YOUTUBE_HUB, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
	});
	return { ok: res.status >= 200 && res.status < 300, status: res.status };
}

export async function upsertWebSubRow(
	db: D1Database,
	channelId: string,
	patch: {
		status?: string;
		leaseExpiresAt?: string | null;
		lastSubscribeAttemptAt?: string | null;
		lastVerifiedAt?: string | null;
		failureCount?: number;
		lastError?: string | null;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO websub_subscriptions (channel_id, status, lease_expires_at, last_subscribe_attempt_at, last_verified_at, failure_count, last_error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(channel_id) DO UPDATE SET
				status = COALESCE(excluded.status, websub_subscriptions.status),
				lease_expires_at = COALESCE(excluded.lease_expires_at, websub_subscriptions.lease_expires_at),
				last_subscribe_attempt_at = COALESCE(excluded.last_subscribe_attempt_at, websub_subscriptions.last_subscribe_attempt_at),
				last_verified_at = COALESCE(excluded.last_verified_at, websub_subscriptions.last_verified_at),
				failure_count = COALESCE(excluded.failure_count, websub_subscriptions.failure_count),
				last_error = excluded.last_error`,
		)
		.bind(
			channelId,
			patch.status ?? 'pending',
			patch.leaseExpiresAt ?? null,
			patch.lastSubscribeAttemptAt ?? null,
			patch.lastVerifiedAt ?? null,
			patch.failureCount ?? 0,
			patch.lastError ?? null,
		)
		.run();
}

export async function enqueueHubSubscriptions(env: Env, channelIds: string[]): Promise<number> {
	const ids = [...new Set(channelIds.filter((id) => CHANNEL_ID_RE.test(id)))];
	for (const group of chunk(ids, 20)) {
		await env.DB.batch(
			group.map((channelId) =>
				env.DB.prepare(
					`INSERT INTO websub_subscriptions (channel_id, status, failure_count)
					 VALUES (?, 'pending', 0)
					 ON CONFLICT(channel_id) DO UPDATE SET
						status = CASE WHEN websub_subscriptions.status = 'inactive' THEN 'pending' ELSE websub_subscriptions.status END`,
				).bind(channelId),
			),
		);
	}
	return ids.length;
}

/** Heal rows missing after a crashed Reload: one D1 statement, no hub fetch. */
export async function enqueueMissingHubSubscriptions(env: Env): Promise<void> {
	await env.DB.prepare(
		`INSERT OR IGNORE INTO websub_subscriptions (channel_id, status, failure_count)
		 SELECT DISTINCT channel_id, 'pending', 0 FROM channel_prefs WHERE is_subscribed = 1`,
	).run();
}

export async function subscribeHubChannels(env: Env, channelIds: string[]): Promise<number> {
	const origin = env.PUBLIC_ORIGIN;
	const session = env.SESSION_SECRET;
	if (!origin || !session || channelIds.length === 0) return 0;
	const secret = await hubSecretFromSession(session);
	const token = await callbackTokenFromSession(session);
	const now = new Date().toISOString();
	let n = 0;
	for (const channelId of channelIds) {
		if (!CHANNEL_ID_RE.test(channelId)) continue;
		const existing = await env.DB.prepare(
			`SELECT status, lease_expires_at, failure_count FROM websub_subscriptions WHERE channel_id = ?`,
		)
			.bind(channelId)
			.first<{ status: string; lease_expires_at: string | null; failure_count: number }>();
		if (existing?.status === 'active' && existing.lease_expires_at && existing.lease_expires_at > now) continue;
		await upsertWebSubRow(env.DB, channelId, { status: 'pending', lastSubscribeAttemptAt: now, lastError: null });
		const result = await requestHub('subscribe', { origin, channelId, secret, token });
		await recordQuota(env.DB, 'websub.subscribe', { callCount: 1, generalUnits: 0 });
		n += 1;
		if (!result.ok) {
			await upsertWebSubRow(env.DB, channelId, {
				status: 'error',
				lastSubscribeAttemptAt: now,
				failureCount: (existing?.failure_count ?? 0) + 1,
				lastError: `hub_${result.status}`,
			});
		}
	}
	return n;
}

/** @deprecated Reload/reconcile must enqueue only. Kept name for call sites that should not hub-POST. */
export async function ensureHubSubscriptions(env: Env, channelIds: string[]): Promise<void> {
	await enqueueHubSubscriptions(env, channelIds);
}

export async function unsubscribeIfOrphaned(env: Env, channelIds: string[]): Promise<void> {
	const origin = env.PUBLIC_ORIGIN;
	const session = env.SESSION_SECRET;
	if (!origin || !session) return;
	const secret = await hubSecretFromSession(session);
	const token = await callbackTokenFromSession(session);
	const now = new Date().toISOString();
	for (const channelId of channelIds) {
		const row = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM channel_prefs WHERE channel_id = ? AND is_subscribed = 1`,
		)
			.bind(channelId)
			.first<{ n: number }>();
		if ((row?.n ?? 0) > 0) continue;
		await requestHub('unsubscribe', { origin, channelId, secret, token });
		await recordQuota(env.DB, 'websub.unsubscribe', { callCount: 1, generalUnits: 0 });
		await upsertWebSubRow(env.DB, channelId, { status: 'inactive', lastSubscribeAttemptAt: now, lastError: null });
	}
}

export function channelEligibleForUnsubscribe(followerCount: number): boolean {
	return followerCount <= 0;
}

export async function insertWebSubEvents(db: D1Database, entries: ParsedWebSubEntry[]): Promise<number> {
	let inserted = 0;
	for (const entry of entries) {
		const result = await db
			.prepare(
				`INSERT OR IGNORE INTO websub_events (id, channel_id, video_id, title, published_at, updated_at, status)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
			)
			.bind(entry.id, entry.channelId, entry.videoId, entry.title, entry.publishedAt, entry.updatedAt)
			.run();
		if ((result.meta.changes ?? 0) > 0) inserted += 1;
	}
	return inserted;
}

export const HUB_FETCH_LIMIT = 20;
export const LEASE_RENEW_LIMIT = HUB_FETCH_LIMIT;
export const RECONCILE_USER_LIMIT = 2;

export async function renewExpiringLeases(env: Env, limit = HUB_FETCH_LIMIT): Promise<number> {
	await enqueueMissingHubSubscriptions(env);
	const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
	const staleAttempt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
	const due = await env.DB.prepare(
		`SELECT w.channel_id FROM websub_subscriptions w
		 WHERE w.status IN ('active', 'pending', 'error')
		 AND (w.lease_expires_at IS NULL OR w.lease_expires_at <= ?)
		 AND (w.last_subscribe_attempt_at IS NULL OR w.last_subscribe_attempt_at <= ?)
		 AND EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = w.channel_id AND p.is_subscribed = 1)
		 ORDER BY CASE WHEN w.last_subscribe_attempt_at IS NULL THEN 0 ELSE 1 END,
			w.last_subscribe_attempt_at ASC, w.channel_id ASC
		 LIMIT ?`,
	)
		.bind(cutoff, staleAttempt, limit)
		.all<{ channel_id: string }>();
	const subscribeIds = (due.results ?? []).map((row) => row.channel_id);
	const subscribed = await subscribeHubChannels(env, subscribeIds);
	const remaining = Math.max(0, limit - subscribed);
	if (remaining < 1) return subscribed;
	const orphans = await env.DB.prepare(
		`SELECT w.channel_id FROM websub_subscriptions w
		 WHERE w.status IN ('active', 'pending', 'error')
		 AND (w.last_subscribe_attempt_at IS NULL OR w.last_subscribe_attempt_at <= ?)
		 AND NOT EXISTS (SELECT 1 FROM channel_prefs p WHERE p.channel_id = w.channel_id AND p.is_subscribed = 1)
		 ORDER BY CASE WHEN w.last_subscribe_attempt_at IS NULL THEN 0 ELSE 1 END,
			w.last_subscribe_attempt_at ASC, w.channel_id ASC
		 LIMIT ?`,
	)
		.bind(staleAttempt, remaining)
		.all<{ channel_id: string }>();
	await unsubscribeIfOrphaned(env, (orphans.results ?? []).map((row) => row.channel_id));
	return subscribed;
}

async function expectedCallbackToken(env: Env): Promise<string | null> {
	const secret = env.SESSION_SECRET;
	if (!secret) return null;
	return callbackTokenFromSession(secret);
}

export async function handleWebSubVerification(env: Env, url: URL): Promise<Response> {
	const expected = await expectedCallbackToken(env);
	const token = url.searchParams.get('token') ?? '';
	if (!expected || !timingSafeEqual(token, expected)) {
		return new Response('invalid callback', { status: 404 });
	}
	if (url.pathname !== WEBSUB_CALLBACK_PATH) {
		return new Response('invalid callback', { status: 404 });
	}
	const mode = url.searchParams.get('hub.mode');
	const topic = url.searchParams.get('hub.topic') ?? '';
	const challenge = url.searchParams.get('hub.challenge') ?? '';
	const lease = Number(url.searchParams.get('hub.lease_seconds') ?? WEBSUB_LEASE_SECONDS) || WEBSUB_LEASE_SECONDS;
	const channelId = channelIdFromTopic(topic);
	if ((mode !== 'subscribe' && mode !== 'unsubscribe') || !channelId || !challenge) {
		return new Response('invalid hub challenge', { status: 404 });
	}
	const followers = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM channel_prefs WHERE channel_id = ? AND is_subscribed = 1`,
	)
		.bind(channelId)
		.first<{ n: number }>();
	const count = followers?.n ?? 0;
	if (mode === 'subscribe' && count < 1) {
		return new Response('no subscribers', { status: 404 });
	}
	const now = new Date().toISOString();
	if (mode === 'subscribe') {
		const expires = new Date(Date.now() + lease * 1000).toISOString();
		await upsertWebSubRow(env.DB, channelId, {
			status: 'active',
			leaseExpiresAt: expires,
			lastVerifiedAt: now,
			failureCount: 0,
			lastError: null,
		});
	} else {
		await upsertWebSubRow(env.DB, channelId, { status: 'inactive', lastVerifiedAt: now, lastError: null });
	}
	await recordQuota(env.DB, 'websub.verify', { callCount: 1, generalUnits: 0 });
	return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export async function handleWebSubNotification(env: Env, request: Request): Promise<{ response: Response; inserted: number }> {
	const url = new URL(request.url);
	const expected = await expectedCallbackToken(env);
	const token = url.searchParams.get('token') ?? '';
	if (!expected || url.pathname !== WEBSUB_CALLBACK_PATH || !timingSafeEqual(token, expected)) {
		return { response: new Response('invalid callback', { status: 404 }), inserted: 0 };
	}
	const lengthHeader = Number(request.headers.get('content-length') ?? '0');
	if (lengthHeader > MAX_ATOM_BYTES) {
		return { response: new Response('payload too large', { status: 413 }), inserted: 0 };
	}
	if (!acceptAtomContentType(request.headers.get('content-type'))) {
		return { response: new Response('unsupported media type', { status: 415 }), inserted: 0 };
	}
	const secret = env.SESSION_SECRET;
	if (!secret) {
		return { response: new Response('misconfigured', { status: 500 }), inserted: 0 };
	}
	const body = await request.arrayBuffer();
	if (body.byteLength > MAX_ATOM_BYTES) {
		return { response: new Response('payload too large', { status: 413 }), inserted: 0 };
	}
	const hubSecret = await hubSecretFromSession(secret);
	const signed = await verifyHubSignature(hubSecret, body, request.headers.get('x-hub-signature'));
	if (!signed) {
		return { response: new Response('invalid signature', { status: 403 }), inserted: 0 };
	}
	const xml = new TextDecoder().decode(body);
	if (!xml.includes('<feed') && !xml.includes('<entry')) {
		return { response: new Response('malformed atom', { status: 400 }), inserted: 0 };
	}
	const selfHref = feedSelfHref(xml);
	const topicChannel = selfHref ? channelIdFromTopic(selfHref) : null;
	if (selfHref && !topicChannel) {
		return { response: new Response('invalid topic', { status: 400 }), inserted: 0 };
	}
	const entries = parseAtomEntries(xml);
	const channels = new Set(entries.map((entry) => entry.channelId));
	if (channels.size > 1) {
		return { response: new Response('mixed channel payload', { status: 400 }), inserted: 0 };
	}
	const payloadChannel = [...channels][0] ?? topicChannel;
	if (payloadChannel && topicChannel && payloadChannel !== topicChannel) {
		return { response: new Response('topic channel mismatch', { status: 400 }), inserted: 0 };
	}
	if (payloadChannel && !CHANNEL_ID_RE.test(payloadChannel)) {
		return { response: new Response('invalid channel', { status: 400 }), inserted: 0 };
	}
	if (entries.some((entry) => !VIDEO_ID_RE.test(entry.videoId) || entry.channelId !== payloadChannel)) {
		return { response: new Response('invalid entry', { status: 400 }), inserted: 0 };
	}
	const inserted = await insertWebSubEvents(env.DB, entries);
	if (payloadChannel && entries.length) {
		await env.DB.prepare(
			`UPDATE websub_subscriptions SET last_notify_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE channel_id = ?`,
		)
			.bind(payloadChannel)
			.run();
	}
	await recordQuota(env.DB, 'websub.notify', { callCount: 1, generalUnits: 0 });
	return { response: new Response(null, { status: 204 }), inserted };
}

