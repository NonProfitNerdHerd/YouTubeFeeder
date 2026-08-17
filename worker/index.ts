import { decryptSecret, encryptSecret, signValue, verifySignedValue } from './auth/crypto';
import {
	exchangeCode,
	fetchGoogleUser,
	googleAuthUrl,
	revokeToken,
	validateOauthState,
} from './auth/oauth';
import {
	ANDROID_OAUTH_REDIRECT,
	clearSessionCookies,
	createOauthStateCookie,
	isSecureRequest,
	mintSession,
	oauthClientFromState,
	readOauthState,
	readSessionUserId,
} from './auth/session';
import { lastSyncAt, listInbox, countInbox, listSubscribedChannels, listCategories, createCategory, renameCategory, deleteCategory, updateChannelPrefs, hideInboxItem, snoozeInboxItem, unsnoozeInboxItem, restoreInboxItem, updateInboxNotes, listWatchlists, createWatchlist, renameWatchlist, deleteWatchlist, addToWatchlist, removeFromWatchlist } from './db/queries';
import {
	applyLiveLayout,
	assignLiveSlot,
	deleteLiveLayout,
	deleteLiveSource,
	getLiveSession,
	listLiveLayouts,
	listLiveSources,
	listLiveCategories,
	createLiveCategory,
	deleteLiveCategory,
	saveLiveLayout,
	updateLiveLayout,
} from './db/live';
import { getUserById, upsertGoogleUser } from './db/users';
import { apiError, json, readJson } from './http';
import { accessTokenForUser } from './services/googleToken';
import { addLiveSourceFromInput, discoverLiveSources, getLiveJobs, getLiveMonitor, patchLiveSourceFromInput, putLiveSession, refreshLiveSources, refreshOneLiveSource, reportLivePlayerError } from './services/live';
import { getQuadSettings, putQuadSettings } from './db/quadSettings';
import { runScheduledQuadRefresh } from './services/quadSchedule';
import { catchUpChannel, syncContent, syncSubscriptions } from './services/sync';
import { YoutubeApiError } from './services/youtube';
import { isLiveGridSize } from '../src/types';
import { STREAMFEEDER_PACKAGE_ID } from '../src/lib/androidRelease';
import { digitalAssetLinks, type AssetLinkFingerprint } from './android/assetlinks';
import androidFingerprints from './android/fingerprints.json';

async function continueCronContent(env: Env, userId: string, offset: number): Promise<void> {
	const origin = env.PUBLIC_ORIGIN;
	const secret = env.SESSION_SECRET;
	if (!origin || !secret) return;
	const token = await signValue(secret, `cron-content:${userId}:${offset}`);
	await fetch(`${origin.replace(/\/$/, '')}/api/cron/sync-content`, {
		method: 'POST',
		headers: { 'x-cron-sync': token },
	});
}

function requiredEnv(env: Env, key: keyof Env): string {
	const value = env[key];
	if (typeof value !== 'string' || !value) {
		throw new Error(`missing_env:${String(key)}`);
	}
	return value;
}

function redirectUri(env: Env, url: URL): string {
	return env.GOOGLE_REDIRECT_URI || `${url.origin}/api/auth/google/callback`;
}

async function requireUser(env: Env, request: Request) {
	const secret = env.SESSION_SECRET;
	if (!secret) return apiError(500, 'misconfigured', 'Missing SESSION_SECRET.');
	const userId = await readSessionUserId(secret, request);
	if (!userId) return apiError(401, 'unauthorized', 'Sign in required.');
	const user = await getUserById(env.DB, userId);
	if (!user) return apiError(401, 'unauthorized', 'Session is no longer valid.');
	return user;
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const secure = isSecureRequest(url);

	if (path === '/api/auth/google' && request.method === 'GET') {
		const intent = url.searchParams.get('intent') === 'signup' ? 'signup' : 'login';
		const client = url.searchParams.get('client') === 'android' ? 'android' : 'web';
		const secret = requiredEnv(env, 'SESSION_SECRET');
		const clientId = requiredEnv(env, 'GOOGLE_CLIENT_ID');
		const { state, header } = await createOauthStateCookie(secret, secure, intent, client);
		const location = googleAuthUrl({
			clientId,
			redirectUri: redirectUri(env, url),
			state,
			prompt: intent === 'signup' ? 'consent' : 'select_account',
		});
		return new Response(null, {
			status: 302,
			headers: { Location: location, 'Set-Cookie': header },
		});
	}

	if (path === '/api/auth/google/callback' && request.method === 'GET') {
		const err = url.searchParams.get('error');
		const secretEarly = env.SESSION_SECRET;
		const expectedEarly = secretEarly ? await readOauthState(secretEarly, request) : null;
		const androidClient = oauthClientFromState(expectedEarly);
		if (err) {
			if (androidClient === 'android') {
				return Response.redirect(`${ANDROID_OAUTH_REDIRECT}?error=${encodeURIComponent(err)}`, 302);
			}
			return Response.redirect(`${url.origin}/login?error=${encodeURIComponent(err)}`, 302);
		}
		const secret = requiredEnv(env, 'SESSION_SECRET');
		const expected = await readOauthState(secret, request);
		const received = url.searchParams.get('state');
		const client = oauthClientFromState(expected);
		if (!validateOauthState(expected, received)) {
			if (client === 'android') {
				return Response.redirect(`${ANDROID_OAUTH_REDIRECT}?error=invalid_state`, 302);
			}
			return Response.redirect(`${url.origin}/login?error=invalid_state`, 302);
		}
		const code = url.searchParams.get('code');
		if (!code) {
			if (client === 'android') {
				return Response.redirect(`${ANDROID_OAUTH_REDIRECT}?error=missing_code`, 302);
			}
			return Response.redirect(`${url.origin}/login?error=missing_code`, 302);
		}

		const tokens = await exchangeCode(
			{
				GOOGLE_CLIENT_ID: requiredEnv(env, 'GOOGLE_CLIENT_ID'),
				GOOGLE_CLIENT_SECRET: requiredEnv(env, 'GOOGLE_CLIENT_SECRET'),
				GOOGLE_REDIRECT_URI: redirectUri(env, url),
			},
			code,
		);
		const profile = await fetchGoogleUser(tokens.access_token);
		let encrypted: string | null = null;
		if (tokens.refresh_token) {
			encrypted = await encryptSecret(tokens.refresh_token, requiredEnv(env, 'TOKEN_ENCRYPTION_KEY'));
		}
		const user = await upsertGoogleUser(env.DB, {
			googleAccountId: profile.id,
			displayName: profile.name,
			encryptedRefreshToken: encrypted,
		});
		const { token, cookieHeader } = await mintSession(secret, user.id, secure);
		const location =
			client === 'android'
				? `${ANDROID_OAUTH_REDIRECT}?token=${encodeURIComponent(token)}`
				: `${url.origin}/`;
		const headers = new Headers({ Location: location });
		headers.append('Set-Cookie', cookieHeader);
		for (const cleared of clearSessionCookies(secure).filter((c) => c.startsWith('yf_oauth_state='))) {
			headers.append('Set-Cookie', cleared);
		}
		return new Response(null, { status: 302, headers });
	}

	if (path === '/api/auth/logout' && request.method === 'POST') {
		const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
		for (const c of clearSessionCookies(secure)) headers.append('Set-Cookie', c);
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
	}

	if (path === '/api/auth/disconnect' && request.method === 'POST') {
		const secret = requiredEnv(env, 'SESSION_SECRET');
		const userId = await readSessionUserId(secret, request);
		if (!userId) return apiError(401, 'unauthorized', 'Sign in required.');
		const user = await getUserById(env.DB, userId);
		if (user?.encrypted_refresh_token) {
			try {
				const refresh = await decryptSecret(user.encrypted_refresh_token, requiredEnv(env, 'TOKEN_ENCRYPTION_KEY'));
				await revokeToken(refresh);
			} catch {
				// Revoke best-effort; still clear local credentials.
			}
		}
		await env.DB.prepare(
			"UPDATE users SET encrypted_refresh_token = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
		)
			.bind(userId)
			.run();
		const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
		for (const c of clearSessionCookies(secure)) headers.append('Set-Cookie', c);
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
	}

	if (path === '/api/me' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({
			id: user.id,
			googleAccountId: user.google_account_id,
			displayName: user.display_name,
			connected: Boolean(user.encrypted_refresh_token),
			mock: env.MOCK_DATA === 'true',
		});
	}

	if (path === '/api/channels' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const channels = await listSubscribedChannels(env.DB, user.id);
		return json({ channels });
	}

	if (path.startsWith('/api/channels/') && request.method === 'PATCH') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const channelId = decodeURIComponent(path.slice('/api/channels/'.length));
		const body = await readJson<{ followInInbox?: boolean; maxVideosToPull?: number; categoryIds?: string[] }>(request);
		if (!body) return apiError(400, 'invalid_json', 'Expected JSON body.');
		await updateChannelPrefs(env.DB, user.id, channelId, {
			followInInbox: body.followInInbox !== false,
			maxVideosToPull: typeof body.maxVideosToPull === 'number' ? body.maxVideosToPull : 0,
			categoryIds: Array.isArray(body.categoryIds) ? body.categoryIds.filter((id) => typeof id === 'string') : [],
		});
		return json({ ok: true });
	}

	if (path === '/api/categories' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ categories: await listCategories(env.DB, user.id) });
	}

	if (path === '/api/categories' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ name?: string }>(request);
		try {
			const category = await createCategory(env.DB, user.id, body?.name ?? '');
			return json({ category }, { status: 201 });
		} catch {
			return apiError(400, 'invalid_name', 'Category name is required.');
		}
	}

	if (path.startsWith('/api/categories/') && request.method === 'PATCH') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const id = decodeURIComponent(path.slice('/api/categories/'.length));
		const body = await readJson<{ name?: string }>(request);
		try {
			const category = await renameCategory(env.DB, user.id, id, body?.name ?? '');
			return json({ category });
		} catch (err: unknown) {
			const code = err instanceof Error ? err.message : 'invalid_name';
			if (code === 'not_found') return apiError(404, 'not_found', 'Category not found.');
			return apiError(400, 'invalid_name', 'Category name is required.');
		}
	}

	if (path.startsWith('/api/categories/') && request.method === 'DELETE') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const id = decodeURIComponent(path.slice('/api/categories/'.length));
		if (!id) return apiError(400, 'invalid_json', 'Expected a category id.');
		try {
			await deleteCategory(env.DB, user.id, id);
			return json({ ok: true });
		} catch (err: unknown) {
			if (err instanceof Error && err.message === 'in_use') {
				return apiError(
					409,
					'in_use',
					'Remove this category from all streams (Edit on Streams) before deleting it.',
				);
			}
			throw err;
		}
	}

	if (path === '/api/watchlists' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ watchlists: await listWatchlists(env.DB, user.id) });
	}

	if (path === '/api/watchlists' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ name?: string }>(request);
		try {
			const watchlist = await createWatchlist(env.DB, user.id, body?.name ?? '');
			return json({ watchlist }, { status: 201 });
		} catch (err: unknown) {
			const code = err instanceof Error ? err.message : 'invalid_name';
			if (code === 'duplicate_name') return apiError(409, 'duplicate_name', 'A watchlist with that name already exists.');
			return apiError(400, 'invalid_name', 'Watchlist name is required.');
		}
	}

	if (path.startsWith('/api/watchlists/') && request.method === 'PATCH') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		// IDs may contain '/' (legacy base64 from randomToken); take the full remainder.
		const id = decodeURIComponent(path.slice('/api/watchlists/'.length));
		if (!id || id.includes('/items')) return apiError(400, 'invalid_json', 'Expected a watchlist id.');
		const body = await readJson<{ name?: string }>(request);
		try {
			const watchlist = await renameWatchlist(env.DB, user.id, id, body?.name ?? '');
			return json({ watchlist });
		} catch (err: unknown) {
			const code = err instanceof Error ? err.message : 'invalid_name';
			if (code === 'not_found') return apiError(404, 'not_found', 'Watchlist not found.');
			if (code === 'duplicate_name') return apiError(409, 'duplicate_name', 'A watchlist with that name already exists.');
			return apiError(400, 'invalid_name', 'Watchlist name is required.');
		}
	}

	if (path.startsWith('/api/watchlists/') && request.method === 'DELETE') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const rest = decodeURIComponent(path.slice('/api/watchlists/'.length));
		const itemMatch = rest.match(/^(.+)\/items\/([^/]+)$/);
		if (itemMatch) {
			await removeFromWatchlist(env.DB, user.id, itemMatch[1], itemMatch[2]);
			return json({ ok: true });
		}
		try {
			await deleteWatchlist(env.DB, user.id, rest);
			return json({ ok: true });
		} catch (err: unknown) {
			if (err instanceof Error && err.message === 'not_empty') {
				return apiError(409, 'not_empty', 'Remove all videos from this watchlist before deleting it.');
			}
			throw err;
		}
	}

	if (path.startsWith('/api/watchlists/') && path.endsWith('/items') && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const watchlistId = decodeURIComponent(path.slice('/api/watchlists/'.length, -'/items'.length));
		const body = await readJson<{ videoId?: string }>(request);
		if (!body?.videoId) return apiError(400, 'invalid_json', 'Expected videoId.');
		const ok = await addToWatchlist(env.DB, user.id, watchlistId, body.videoId);
		if (!ok) return apiError(404, 'not_found', 'Watchlist not found.');
		return json({ ok: true });
	}

	if (path === '/api/inbox' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const channelId = url.searchParams.get('channelId');
		const categoryId = url.searchParams.get('categoryId');
		const viewParam = url.searchParams.get('view');
		const view =
			viewParam === 'snoozed' || viewParam === 'deleted' || viewParam === 'watchlist' ? viewParam : 'inbox';
		const watchlistId = url.searchParams.get('watchlistId');
		const items = await listInbox(env.DB, user.id, channelId, categoryId, view, watchlistId);
		const count = await countInbox(env.DB, user.id, channelId, categoryId, view, watchlistId);
		return json({ items, count });
	}

	if (path.startsWith('/api/inbox/') && request.method === 'PATCH') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const videoId = decodeURIComponent(path.slice('/api/inbox/'.length));
		const body = await readJson<{ action?: string; until?: string; notes?: string }>(request);
		if (!body?.action) return apiError(400, 'invalid_json', 'Expected an action.');
		if (body.action === 'delete') {
			const ok = await hideInboxItem(env.DB, user.id, videoId);
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'restore') {
			const ok = await restoreInboxItem(env.DB, user.id, videoId);
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'unsnooze') {
			const ok = await unsnoozeInboxItem(env.DB, user.id, videoId);
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'snooze') {
			const until = body.until ? Date.parse(body.until) : Number.NaN;
			if (!Number.isFinite(until) || until <= Date.now()) {
				return apiError(400, 'invalid_until', 'Pick a future date and time.');
			}
			const ok = await snoozeInboxItem(env.DB, user.id, videoId, new Date(until).toISOString());
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'notes') {
			const ok = await updateInboxNotes(env.DB, user.id, videoId, typeof body.notes === 'string' ? body.notes : '');
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		return apiError(400, 'invalid_action', 'Unknown inbox action.');
	}

	if (path === '/api/sync/status' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ lastSyncAt: await lastSyncAt(env.DB, user.id), connected: Boolean(user.encrypted_refresh_token) });
	}

	if ((path === '/api/sync/subscriptions' || path === '/api/sync/content') && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		if (!user.encrypted_refresh_token) {
			return apiError(409, 'not_connected', 'Reconnect with Create account with Google so StreamFeeder can store a refresh token.');
		}
		const recent = await lastSyncAt(env.DB, user.id);
		const offset = Number(url.searchParams.get('offset') ?? '0') || 0;
		if (recent && Date.now() - Date.parse(recent) < 90_000 && url.searchParams.get('force') !== '1' && offset === 0) {
			return apiError(429, 'rate_limited', 'Wait a moment before syncing again.');
		}
		let token: string;
		try {
			token = await accessTokenForUser(env, user);
		} catch {
			return apiError(401, 'token_refresh_failed', 'Google access expired. Sign out and use Create account with Google.');
		}
		const categoryId = url.searchParams.get('categoryId');
		const result =
			path === '/api/sync/subscriptions'
				? await syncSubscriptions(env, user.id, token)
				: await syncContent(env, user.id, token, offset, undefined, {
						categoryId,
						allSubscribed: url.searchParams.get('scope') === 'all',
					});
		const status = result.status === 'ok' ? 200 : result.status === 'quota' ? 429 : 502;
		return json(result, { status });
	}

	if (path === '/api/sync/catchup' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		if (!user.encrypted_refresh_token) {
			return apiError(409, 'not_connected', 'Reconnect with Create account with Google so StreamFeeder can store a refresh token.');
		}
		const body = await readJson<{ channelId?: string; pageToken?: string; pulled?: number }>(request);
		if (!body?.channelId) return apiError(400, 'invalid_json', 'Expected channelId.');
		let token: string;
		try {
			token = await accessTokenForUser(env, user);
		} catch {
			return apiError(401, 'token_refresh_failed', 'Google access expired. Sign out and use Create account with Google.');
		}
		const result = await catchUpChannel(
			env,
			user.id,
			token,
			body.channelId,
			body.pageToken ?? '',
			Number(body.pulled ?? 0) || 0,
		);
		const status = result.status === 'ok' ? 200 : result.status === 'quota' ? 429 : 400;
		return json(result, { status });
	}

	if (path === '/api/cron/sync-content' && request.method === 'POST') {
		const secret = env.SESSION_SECRET;
		if (!secret) return apiError(500, 'misconfigured', 'Missing SESSION_SECRET.');
		const token = request.headers.get('x-cron-sync') ?? '';
		const payload = await verifySignedValue(secret, token);
		if (!payload?.startsWith('cron-content:')) return apiError(401, 'unauthorized', 'Invalid cron token.');
		const parts = payload.split(':');
		const userId = parts[1];
		const offset = Number(parts[2] ?? '0') || 0;
		if (!userId) return apiError(401, 'unauthorized', 'Invalid cron token.');
		const user = await getUserById(env.DB, userId);
		if (!user?.encrypted_refresh_token) return json({ ok: true, skipped: true });
		let access: string;
		try {
			access = await accessTokenForUser(env, user);
		} catch {
			return apiError(401, 'token_refresh_failed', 'Google access expired.');
		}
		const result = await syncContent(env, user.id, access, offset);
		if (result.status === 'ok' && !result.done && typeof result.nextOffset === 'number') {
			ctx.waitUntil(continueCronContent(env, user.id, result.nextOffset));
		}
		return json(result);
	}

	async function requireYoutubeUser() {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		if (!user.encrypted_refresh_token) {
			return apiError(409, 'not_connected', 'Reconnect with Create account with Google so StreamFeeder can store a refresh token.');
		}
		try {
			const token = await accessTokenForUser(env, user);
			return { user, token };
		} catch {
			return apiError(401, 'token_refresh_failed', 'Google access expired. Sign out and use Create account with Google.');
		}
	}

	function liveErr(err: unknown): Response {
		if (err instanceof YoutubeApiError) {
			return apiError(err.quotaExceeded ? 429 : 502, err.quotaExceeded ? 'quota' : 'youtube', err.message);
		}
		const code = err instanceof Error ? err.message : 'live_failed';
		if (code === 'not_found') return apiError(404, 'not_found', 'Not found.');
		if (code === 'duplicate_channel') return apiError(409, 'duplicate_channel', 'That channel is already on Live.');
		if (code === 'duplicate_name') return apiError(409, 'duplicate_name', 'That name is already in use.');
		if (code === 'invalid_name') return apiError(400, 'invalid_name', 'Name is required.');
		if (code === 'invalid_slot') return apiError(400, 'invalid_slot', 'Slot must be 1–12.');
		if (code === 'channel_not_found') return apiError(404, 'channel_not_found', 'Could not resolve that YouTube channel.');
		if (code === 'invalid_channel') return apiError(400, 'invalid_channel', 'Paste a YouTube channel URL, @handle, or UC… ID.');
		return apiError(400, 'invalid_json', code);
	}

	if (path === '/api/live/categories' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ categories: await listLiveCategories(env.DB, user.id) });
	}

	if (path === '/api/live/categories' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ name?: string }>(request);
		try {
			const category = await createLiveCategory(env.DB, user.id, body?.name ?? '');
			return json({ category }, { status: 201 });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/categories/') && request.method === 'DELETE') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const id = decodeURIComponent(path.slice('/api/live/categories/'.length));
		try {
			await deleteLiveCategory(env.DB, user.id, id);
			return json({ ok: true });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path === '/api/live/sources' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ sources: await listLiveSources(env.DB, user.id), session: await getLiveSession(env.DB, user.id) });
	}

	if (path === '/api/live/sources' && request.method === 'POST') {
		const auth = await requireYoutubeUser();
		if (auth instanceof Response) return auth;
		const body = await readJson<{ displayName?: string; channel?: string; notes?: string; enabled?: boolean; categoryIds?: string[] }>(request);
		try {
			const source = await addLiveSourceFromInput(env, auth.user.id, auth.token, body ?? {});
			return json({ source }, { status: 201 });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/sources/') && path.endsWith('/refresh') && request.method === 'POST') {
		const auth = await requireYoutubeUser();
		if (auth instanceof Response) return auth;
		const id = decodeURIComponent(path.slice('/api/live/sources/'.length, -'/refresh'.length));
		try {
			return json(await refreshOneLiveSource(env, auth.user.id, auth.token, id));
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/sources/') && request.method === 'PATCH') {
		const auth = await requireYoutubeUser();
		if (auth instanceof Response) return auth;
		const id = decodeURIComponent(path.slice('/api/live/sources/'.length));
		const body = await readJson<{ displayName?: string; channel?: string; notes?: string; enabled?: boolean; categoryIds?: string[] }>(request);
		try {
			const source = await patchLiveSourceFromInput(env, auth.user.id, auth.token, id, body ?? {});
			return json({ source });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/sources/') && request.method === 'DELETE') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const id = decodeURIComponent(path.slice('/api/live/sources/'.length));
		try {
			await deleteLiveSource(env.DB, user.id, id);
			return json({ ok: true });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path === '/api/live/refresh' && request.method === 'POST') {
		const auth = await requireYoutubeUser();
		if (auth instanceof Response) return auth;
		const body = await readJson<{ force?: boolean; offset?: number }>(request);
		try {
			return json(
				await refreshLiveSources(env, auth.user.id, auth.token, {
					force: body?.force === true,
					offset: Number(body?.offset ?? 0) || 0,
				}),
			);
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path === '/api/live/discover' && request.method === 'POST') {
		const auth = await requireYoutubeUser();
		if (auth instanceof Response) return auth;
		const body = await readJson<{ force?: boolean; categoryId?: string }>(request);
		try {
			return json(
				await discoverLiveSources(env, auth.user.id, auth.token, {
					force: body?.force === true,
					categoryId: body?.categoryId,
				}),
			);
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path === '/api/live/player-error' && request.method === 'POST') {
		const auth = await requireYoutubeUser();
		if (auth instanceof Response) return auth;
		const body = await readJson<{ sourceId?: string; videoId?: string | null }>(request);
		if (!body?.sourceId) return apiError(400, 'invalid_json', 'Expected sourceId.');
		try {
			return json(await reportLivePlayerError(env, auth.user.id, auth.token, body.sourceId, body.videoId));
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path === '/api/live/settings' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ settings: await getQuadSettings(env.DB, user.id) });
	}

	if (path === '/api/live/settings' && request.method === 'PUT') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<Partial<{
			pollingEnabled: boolean;
			confirmIntervalSeconds: number;
			discoveryIntervalSeconds: number;
			cacheMaxAgeSeconds: number;
			defaultSourceMode: string;
			searchFallbackEnabled: boolean;
			searchDailyAllowance: number;
		}>>(request);
		return json({ settings: await putQuadSettings(env.DB, user.id, (body ?? {}) as Parameters<typeof putQuadSettings>[2]) });
	}

	if (path === '/api/live/monitor' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json(await getLiveMonitor(env, user.id));
	}

	if (path === '/api/live/jobs' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json(await getLiveJobs(env, user.id));
	}

	if (path === '/api/live/session' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ session: await getLiveSession(env.DB, user.id), sources: await listLiveSources(env.DB, user.id) });
	}

	if (path === '/api/live/session' && request.method === 'PUT') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ gridSize?: number; slots?: Array<{ slotNumber: number; sourceId: string | null }> }>(request);
		try {
			return json({ session: await putLiveSession(env, user.id, body ?? {}) });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/slots/') && request.method === 'PUT') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const n = Number(decodeURIComponent(path.slice('/api/live/slots/'.length)));
		const body = await readJson<{ sourceId?: string | null; videoId?: string | null }>(request);
		try {
			return json({ session: await assignLiveSlot(env.DB, user.id, n, body?.sourceId ?? null, body?.videoId ?? null) });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path === '/api/live/layouts' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json({ layouts: await listLiveLayouts(env.DB, user.id) });
	}

	if (path === '/api/live/layouts' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ name?: string }>(request);
		try {
			const layout = await saveLiveLayout(env.DB, user.id, body?.name ?? '');
			return json({ layout }, { status: 201 });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/layouts/') && path.endsWith('/apply') && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const id = decodeURIComponent(path.slice('/api/live/layouts/'.length, -'/apply'.length));
		try {
			return json({ session: await applyLiveLayout(env.DB, user.id, id) });
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/layouts/') && request.method === 'PATCH') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const id = decodeURIComponent(path.slice('/api/live/layouts/'.length));
		const body = await readJson<{ name?: string; description?: string; gridSize?: number }>(request);
		try {
			return json({
				layout: await updateLiveLayout(env.DB, user.id, id, {
					name: body?.name,
					description: body?.description,
					gridSize: typeof body?.gridSize === 'number' && isLiveGridSize(body.gridSize) ? body.gridSize : undefined,
				}),
			});
		} catch (err) {
			return liveErr(err);
		}
	}

	if (path.startsWith('/api/live/layouts/') && request.method === 'DELETE') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const id = decodeURIComponent(path.slice('/api/live/layouts/'.length));
		try {
			await deleteLiveLayout(env.DB, user.id, id);
			return json({ ok: true });
		} catch (err) {
			return liveErr(err);
		}
	}

	return apiError(404, 'not_found', 'Unknown API route.');
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === '/.well-known/assetlinks.json') {
				return json(digitalAssetLinks(STREAMFEEDER_PACKAGE_ID, androidFingerprints as AssetLinkFingerprint[]), {
					headers: { 'cache-control': 'public, max-age=300' },
				});
			}
			if (url.pathname.startsWith('/api/')) {
				return await handleApi(request, env, ctx);
			}
			return env.ASSETS.fetch(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'unexpected_error';
			if (message.startsWith('missing_env:')) {
				return apiError(500, 'misconfigured', `Server is missing required secret ${message.slice('missing_env:'.length)}.`);
			}
			if (url.pathname.startsWith('/api/auth/google/callback')) {
				return Response.redirect(`${url.origin}/login?error=oauth_failed`, 302);
			}
			return apiError(500, 'internal', 'Request failed.');
		}
	},
	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(
			(async () => {
				const users = await env.DB.prepare(
					`SELECT id, google_account_id, display_name, encrypted_refresh_token FROM users WHERE encrypted_refresh_token IS NOT NULL`,
				).all<{ id: string; google_account_id: string; display_name: string; encrypted_refresh_token: string | null }>();
				for (const user of users.results ?? []) {
					try {
						const token = await accessTokenForUser(env, user);
						const result = await syncContent(env, user.id, token, 0);
						if (result.status === 'ok' && !result.done && typeof result.nextOffset === 'number') {
							ctx.waitUntil(continueCronContent(env, user.id, result.nextOffset));
						}
					} catch {
						continue;
					}
				}
			})(),
		);
		ctx.waitUntil(
			(async () => {
				const users = await env.DB.prepare(
					`SELECT id, google_account_id, display_name, encrypted_refresh_token FROM users WHERE encrypted_refresh_token IS NOT NULL`,
				).all<{ id: string; google_account_id: string; display_name: string; encrypted_refresh_token: string | null }>();
				for (const user of users.results ?? []) {
					try {
						const token = await accessTokenForUser(env, user);
						await runScheduledQuadRefresh(env, user.id, token);
					} catch {
						continue;
					}
				}
			})(),
		);
	},
} satisfies ExportedHandler<Env>;
