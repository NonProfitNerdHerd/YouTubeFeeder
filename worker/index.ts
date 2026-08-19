import { decryptSecret, encryptSecret, verifySignedValue } from './auth/crypto';
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
import { lastSyncAt, listInbox, listInboxMerged, countInbox, countUnwatchedInbox, listSubscribedChannels, listCategories, createCategory, renameCategory, deleteCategory, updateChannelPrefs, hideInboxItem, snoozeInboxItem, unsnoozeInboxItem, restoreInboxItem, updateInboxNotes, applyInboxProgress, markInboxWatched, unwatchInboxItem, watchAllInbox, listWatchlists, createWatchlist, renameWatchlist, deleteWatchlist, addToWatchlist, removeFromWatchlist, INBOX_PAGE_LIMIT } from './db/queries';
import {
	countPodcastInbox,
	countUnwatchedPodcastInbox,
	hidePodcastInboxItem,
	isPodcastEpisodeId,
	listPodcastSubscriptions,
	restorePodcastInboxItem,
	snoozePodcastInboxItem,
	unsnoozePodcastInboxItem,
	updatePodcastInboxNotes,
	updatePodcastPrefs,
} from './db/podcasts';
import { discoverBrowse, discoverSearch, discoverSubscribePodcast } from './services/discover';
import { FOR_YOU_PAGE_SIZE } from './services/discover/forYou';
import {
	getRecommendationHistory,
	recordFollowFeedbackFromToken,
	restoreFeedback,
	submitRecommendationFeedback,
	type RecommendationFeedbackAction,
} from './services/discover/recommendationFeedbackService';
import { followYoutubeChannel, unfollowYoutubeChannel } from './services/discoverFollow';
import { dismissInterestCandidate } from './db/discoverInterestCandidates';
import { loadAndPersistInterestPopular } from './services/discover/interestPopular';
import { catchUpPodcast } from './services/podcastCatchup';
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
import { catchUpChannel, syncSubscriptions } from './services/sync';
import { runFeedMaintenance, syncFeedNow, continueOverdueReconcile } from './services/feedSchedule';
import { buildFeedSyncStatus } from './services/feedStatus';
import { handleWebSubNotification, handleWebSubVerification, WEBSUB_CALLBACK_PATH } from './services/websub';
import { processPendingWebSubEvents } from './services/websubProcess';
import { YoutubeApiError } from './services/youtube';
import { isLiveGridSize } from '../src/types';
import { STREAMFEEDER_PACKAGE_ID } from '../src/lib/androidRelease';
import { parseWatchedFilter } from '../src/lib/watchProgress';
import { digitalAssetLinks, type AssetLinkFingerprint } from './android/assetlinks';
import androidFingerprints from './android/fingerprints.json';

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

	if (path === WEBSUB_CALLBACK_PATH && request.method === 'GET') {
		return handleWebSubVerification(env, url);
	}
	if (path === WEBSUB_CALLBACK_PATH && request.method === 'POST') {
		const result = await handleWebSubNotification(env, request);
		if (result.response.ok) {
			ctx.waitUntil(processPendingWebSubEvents(env));
		}
		return result.response;
	}

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
		const podcasts = await listPodcastSubscriptions(env.DB, user.id);
		return json({ channels, podcasts });
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
					'Remove this category from all subscriptions (Edit on Subscriptions) before deleting it.',
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
		const watched = parseWatchedFilter(url.searchParams.get('watched'));
		const beforeId = url.searchParams.get('beforeId');
		const items = await listInboxMerged(env.DB, user.id, channelId, categoryId, view, watchlistId, watched, beforeId);
		const hasMore = items.length === INBOX_PAGE_LIMIT;
		if (beforeId) return json({ items, hasMore });
		const ytCount = await countInbox(env.DB, user.id, channelId, categoryId, view, watchlistId);
		const podCount =
			!channelId && !categoryId && view !== 'watchlist'
				? await countPodcastInbox(env.DB, user.id, view)
				: 0;
		const count = ytCount + podCount;
		const ytUnwatched = await countUnwatchedInbox(env.DB, user.id, channelId, categoryId, view, watchlistId);
		const podUnwatched =
			!channelId && !categoryId && view !== 'watchlist'
				? await countUnwatchedPodcastInbox(env.DB, user.id, view)
				: 0;
		const unwatchedCount = ytUnwatched + podUnwatched;
		return json({ items, count, unwatchedCount, hasMore });
	}

	if (path === '/api/discover/search' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const q = url.searchParams.get('q') ?? '';
		const filter = url.searchParams.get('filter');
		return json(await discoverSearch(env, user.id, q, filter));
	}

	if (path === '/api/discover/browse' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const url = new URL(request.url);
		const tabParam = url.searchParams.get('tab');
		const tab =
			tabParam === 'popular' || tabParam === 'recent' || tabParam === 'forYou' ? tabParam : 'forYou';
		const interestId = url.searchParams.get('interest') ?? undefined;
		const includeDebug = url.searchParams.get('debug') === '1' && env.DISCOVER_RELEVANCE_DEBUG === 'true';
		const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? FOR_YOU_PAGE_SIZE) || FOR_YOU_PAGE_SIZE));
		const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
		const loadMore = url.searchParams.get('loadMore') === '1';
		const refreshOffset = Math.max(0, Number(url.searchParams.get('forYouRefreshOffset') ?? 0) || 0);
		return json(
			await discoverBrowse(env, user.id, tab, { interestId, includeDebug, limit, offset, loadMore, refreshOffset }),
		);
	}

	if (path === '/api/discover/follow/youtube' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{
			channelId?: string;
			title?: string;
			description?: string;
			thumbnailUrl?: string;
			recommendationToken?: string;
		}>(request);
		if (!body?.channelId) return apiError(400, 'invalid_channel', 'Missing channelId.');
		try {
			const followResult = await followYoutubeChannel(env, user.id, {
				channelId: body.channelId,
				title: body.title,
				description: body.description,
				thumbnailUrl: body.thumbnailUrl,
			});
			await dismissInterestCandidate(env.DB, user.id, 'youtube', body.channelId);
			let feedbackRecorded = false;
			if (body.recommendationToken) {
				const feedback = await recordFollowFeedbackFromToken(env, user.id, body.recommendationToken, body.channelId);
				feedbackRecorded = feedback.ok;
				if (!feedback.ok) {
					console.warn(`For You follow feedback not recorded: ${feedback.code}`);
				}
			}
			return json({ ...followResult, feedbackRecorded });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : 'follow_failed';
			if (msg === 'invalid_channel') return apiError(400, 'invalid_channel', 'Invalid channel.');
			return apiError(500, 'follow_failed', msg);
		}
	}

	if (path === '/api/discover/interest-popular' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ interestId?: string }>(request);
		const interestId = body?.interestId?.trim();
		const result = await loadAndPersistInterestPopular(
			env,
			user.id,
			interestId && interestId !== 'all' ? interestId : undefined,
		);
		return json({
			channels: result.channels,
			interestLabel: result.interestLabel,
			usedGlobalFallback: result.usedGlobalFallback,
			fromPersisted: result.fromPersisted,
		});
	}

	if (path === '/api/discover/feedback' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ recommendationToken?: string; action?: RecommendationFeedbackAction }>(request);
		if (!body?.recommendationToken) return apiError(400, 'invalid_token', 'Missing recommendationToken.');
		if (!body.action || !['channel_not_interested', 'not_relevant'].includes(body.action)) {
			return apiError(400, 'invalid_action', 'Invalid feedback action.');
		}
		const result = await submitRecommendationFeedback(env, user.id, body.action, body.recommendationToken);
		if (!result.ok) {
			if (result.code === 'invalid_token') return apiError(400, 'invalid_token', 'Invalid or expired recommendation token.');
			return apiError(500, 'feedback_failed', 'Could not record feedback.');
		}
		return json({
			ok: true,
			feedbackId: result.feedback.id,
			action: result.feedback.action,
		});
	}

	if (path === '/api/discover/recommendation-history' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const filterParam = url.searchParams.get('filter');
		const statusParam = url.searchParams.get('status');
		const filter =
			filterParam === 'channel' || filterParam === 'not_relevant' ? filterParam : 'all';
		const status =
			statusParam === 'restored' || statusParam === 'all' ? statusParam : 'active';
		const q = url.searchParams.get('q') ?? undefined;
		return json({
			entries: await getRecommendationHistory(env, user.id, { filter, status, query: q }),
		});
	}

	if (path.startsWith('/api/discover/feedback/') && path.endsWith('/restore') && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const feedbackId = decodeURIComponent(path.slice('/api/discover/feedback/'.length, -'/restore'.length));
		const result = await restoreFeedback(env, user.id, feedbackId);
		if (!result.ok) {
			if (result.code === 'not_found') return apiError(404, 'not_found', 'Feedback entry not found.');
			if (result.code === 'already_restored') return apiError(409, 'already_restored', 'Feedback already restored.');
			return apiError(500, 'restore_failed', 'Could not restore feedback.');
		}
		return json({ ok: true, restoredAt: result.restoredAt });
	}

	if (path === '/api/discover/unfollow/youtube' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{ channelId?: string }>(request);
		if (!body?.channelId) return apiError(400, 'invalid_channel', 'Missing channelId.');
		try {
			return json(await unfollowYoutubeChannel(env, user.id, body.channelId));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : 'unfollow_failed';
			if (msg === 'invalid_channel') return apiError(400, 'invalid_channel', 'Invalid channel.');
			return apiError(500, 'unfollow_failed', msg);
		}
	}

	if (path === '/api/discover/subscribe/podcast' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const body = await readJson<{
			externalFeedId?: number;
			feedUrl?: string;
			title?: string;
			publisher?: string;
			description?: string;
			imageUrl?: string;
		}>(request);
		if (!body) return apiError(400, 'invalid_json', 'Expected JSON body.');
		try {
			return json(await discoverSubscribePodcast(env, user.id, body));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : 'subscribe_failed';
			if (msg === 'invalid_subscribe') return apiError(400, 'invalid_subscribe', 'Missing podcast feed details.');
			return apiError(500, 'subscribe_failed', msg);
		}
	}

	if (path.startsWith('/api/podcasts/') && path.endsWith('/catchup') && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const podcastId = decodeURIComponent(path.slice('/api/podcasts/'.length, -'/catchup'.length));
		const body = await readJson<{ pulled?: number }>(request);
		const result = await catchUpPodcast(env, user.id, podcastId, body?.pulled ?? 0);
		return json({
			episodesAdded: result.episodesAdded,
			pulled: result.pulled,
			want: result.want,
			done: result.done,
			errorSummary: result.errorSummary,
			status: result.status,
		});
	}

	if (path.startsWith('/api/podcasts/') && request.method === 'PATCH') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const podcastId = decodeURIComponent(path.slice('/api/podcasts/'.length));
		const body = await readJson<{ followInInbox?: boolean; maxEpisodesToPull?: number; categoryIds?: string[] }>(request);
		if (!body) return apiError(400, 'invalid_json', 'Expected JSON body.');
		const ok = await updatePodcastPrefs(env.DB, user.id, podcastId, {
			followInInbox: body.followInInbox !== false,
			maxEpisodesToPull: typeof body.maxEpisodesToPull === 'number' ? body.maxEpisodesToPull : 20,
			categoryIds: Array.isArray(body.categoryIds) ? body.categoryIds.filter((id) => typeof id === 'string') : [],
		});
		if (!ok) return apiError(404, 'not_found', 'Podcast subscription not found.');
		return json({ ok: true });
	}

	if (path === '/api/inbox/watch-all' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const channelId = url.searchParams.get('channelId');
		const categoryId = url.searchParams.get('categoryId');
		const viewParam = url.searchParams.get('view');
		const view =
			viewParam === 'snoozed' || viewParam === 'deleted' || viewParam === 'watchlist' ? viewParam : 'inbox';
		const watchlistId = url.searchParams.get('watchlistId');
		const watched = parseWatchedFilter(url.searchParams.get('watched'));
		const updated = await watchAllInbox(env.DB, user.id, channelId, categoryId, view, watchlistId, watched);
		return json({ updated });
	}

	if (path.startsWith('/api/inbox/') && request.method === 'PATCH') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		const videoId = decodeURIComponent(path.slice('/api/inbox/'.length));
		const body = await readJson<{
			action?: string;
			until?: string;
			notes?: string;
			playbackSeconds?: number;
			lastPositionSeconds?: number;
			ended?: boolean;
		}>(request);
		if (!body?.action) return apiError(400, 'invalid_json', 'Expected an action.');
		if (!isPodcastEpisodeId(videoId)) {
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
		if (body.action === 'progress') {
			if (typeof body.playbackSeconds !== 'number' || !Number.isFinite(body.playbackSeconds)) {
				return apiError(400, 'invalid_progress', 'Expected playbackSeconds.');
			}
			const watch = await applyInboxProgress(env.DB, user.id, videoId, {
				playbackSeconds: body.playbackSeconds,
				lastPositionSeconds: body.lastPositionSeconds,
				ended: body.ended,
			});
			if (!watch) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true, ...watch });
		}
		if (body.action === 'watch') {
			const watch = await markInboxWatched(env.DB, user.id, videoId);
			if (!watch) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true, ...watch });
		}
		if (body.action === 'unwatch') {
			const watch = await unwatchInboxItem(env.DB, user.id, videoId);
			if (!watch) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true, ...watch });
		}
		return apiError(400, 'invalid_action', 'Unknown inbox action.');
		}
		if (body.action === 'delete') {
			const ok = await hidePodcastInboxItem(env.DB, user.id, videoId);
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'restore') {
			const ok = await restorePodcastInboxItem(env.DB, user.id, videoId);
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'unsnooze') {
			const ok = await unsnoozePodcastInboxItem(env.DB, user.id, videoId);
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'snooze') {
			const until = body.until ? Date.parse(body.until) : Number.NaN;
			if (!Number.isFinite(until) || until <= Date.now()) {
				return apiError(400, 'invalid_until', 'Pick a future date and time.');
			}
			const ok = await snoozePodcastInboxItem(env.DB, user.id, videoId, new Date(until).toISOString());
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'notes') {
			const ok = await updatePodcastInboxNotes(env.DB, user.id, videoId, typeof body.notes === 'string' ? body.notes : '');
			if (!ok) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true });
		}
		if (body.action === 'watch' || body.action === 'unwatch') {
			const watchedAt = body.action === 'watch' ? new Date().toISOString() : null;
			const result = await env.DB.prepare(
				`UPDATE podcast_inbox_state SET watched_at = ?, watch_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND episode_id = ?`,
			)
				.bind(watchedAt, user.id, videoId)
				.run();
			if ((result.meta.changes ?? 0) < 1) return apiError(404, 'not_found', 'Inbox item not found.');
			return json({ ok: true, watchedAt });
		}
		return apiError(400, 'invalid_action', 'Unknown inbox action for podcast item.');
	}

	if (path === '/api/sync/status' && request.method === 'GET') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		return json(
			await buildFeedSyncStatus(env, user.id, await lastSyncAt(env.DB, user.id), Boolean(user.encrypted_refresh_token)),
		);
	}

	if ((path === '/api/sync/subscriptions' || path === '/api/sync/content') && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		if (!user.encrypted_refresh_token) {
			return apiError(409, 'not_connected', 'Reconnect with Create account with Google so VortiQuest can store a refresh token.');
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
		const result =
			path === '/api/sync/subscriptions'
				? await syncSubscriptions(env, user.id, token)
				: await syncFeedNow(env, user.id);
		const status =
			result.status === 'ok' ? 200 : result.status === 'quota' || result.status === 'busy' ? 429 : 502;
		return json(result, { status });
	}

	if (path === '/api/sync/catchup' && request.method === 'POST') {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		if (!user.encrypted_refresh_token) {
			return apiError(409, 'not_connected', 'Reconnect with Create account with Google so VortiQuest can store a refresh token.');
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
		if (payload.startsWith('cron-content:continue:')) {
			const summary = await continueOverdueReconcile(env, ctx);
			return json({ ok: true, ...summary });
		}
		const summary = await runFeedMaintenance(env, ctx);
		return json({ ok: true, ...summary });
	}

	async function requireYoutubeUser() {
		const user = await requireUser(env, request);
		if (user instanceof Response) return user;
		if (!user.encrypted_refresh_token) {
			return apiError(409, 'not_connected', 'Reconnect with Create account with Google so VortiQuest can store a refresh token.');
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
		ctx.waitUntil(runFeedMaintenance(env, ctx));
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
