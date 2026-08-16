import { parseYouTubeChannelInput, youtubeChannelUrl } from '../../src/lib/youtubeUrl';
import {
	assignLiveSlot,
	createLiveSource,
	getLiveSession,
	getLiveSource,
	listLiveSources,
	listLiveSourceIdsForCategory,
	setLiveGridSize,
	updateLiveSource,
} from '../db/live';
import { d1QuadStore } from '../db/quadStore';
import { bumpQuadStats, getQuadSettings, getQuadStats, putQuadSettings } from '../db/quadSettings';
import { isLiveGridSize } from '../../src/types';
import { utcDay } from './quadClassify';
import { confirmWithToken, discoverWithToken, recoverWithToken, reportQuadPlayerError } from './quadRefresh';
import { createYoutubeClient, resolveChannelId } from './youtube';

export async function addLiveSourceFromInput(
	env: Env,
	userId: string,
	accessToken: string,
	body: {
		displayName?: string;
		channel?: string;
		notes?: string;
		enabled?: boolean;
		skipDiscovery?: boolean;
		sourceMode?: string;
		categoryIds?: string[];
	},
) {
	const displayName = body.displayName?.trim().slice(0, 80) ?? '';
	if (!displayName) throw new Error('invalid_name');
	const parsed = parseYouTubeChannelInput(body.channel ?? '');
	if (parsed.error) throw new Error(parsed.error);
	const yt = createYoutubeClient(accessToken);
	let channelId: string;
	try {
		channelId = await resolveChannelId(yt, parsed);
	} catch {
		throw new Error('channel_not_found');
	}
	const settings = await getQuadSettings(env.DB, userId);
	return createLiveSource(env.DB, userId, {
		displayName,
		channelId,
		youtubeUrl: youtubeChannelUrl(channelId),
		notes: (body.notes ?? '').trim().slice(0, 500),
		enabled: body.enabled !== false,
		skipDiscovery: body.skipDiscovery === true,
		sourceMode: body.sourceMode ?? settings.defaultSourceMode,
		categoryIds: body.categoryIds ?? [],
	});
}

export async function patchLiveSourceFromInput(
	env: Env,
	userId: string,
	accessToken: string,
	id: string,
	body: {
		displayName?: string;
		channel?: string;
		notes?: string;
		enabled?: boolean;
		skipDiscovery?: boolean;
		sourceMode?: string;
		categoryIds?: string[];
	},
) {
	const existing = await getLiveSource(env.DB, userId, id);
	if (!existing) throw new Error('not_found');
	const displayName = (body.displayName ?? existing.displayName).trim().slice(0, 80);
	if (!displayName) throw new Error('invalid_name');
	let channelId = existing.channelId;
	if (body.channel != null && body.channel.trim()) {
		const parsed = parseYouTubeChannelInput(body.channel);
		if (parsed.error) throw new Error(parsed.error);
		const yt = createYoutubeClient(accessToken);
		try {
			channelId = await resolveChannelId(yt, parsed);
		} catch {
			throw new Error('channel_not_found');
		}
	}
	return updateLiveSource(env.DB, userId, id, {
		displayName,
		channelId,
		youtubeUrl: youtubeChannelUrl(channelId),
		notes: body.notes != null ? body.notes.trim().slice(0, 500) : existing.notes,
		enabled: body.enabled ?? existing.enabled,
		skipDiscovery: body.skipDiscovery ?? existing.skipDiscovery,
		sourceMode: body.sourceMode,
		categoryIds: body.categoryIds ?? existing.categoryIds,
	});
}

async function recordResult(env: Env, userId: string, result: { job: string; cached?: boolean; cacheHit?: boolean; duplicatePrevented?: boolean; inProgress?: boolean; quotaUsed: number; searchQueries: number; nextEligibleAt?: string | null }, started: number) {
	const day = utcDay();
	await bumpQuadStats(env.DB, userId, day, {
		generalApiCalls: result.quotaUsed,
		searchQueries: result.searchQueries,
		cacheHits: result.cached || result.cacheHit ? 1 : 0,
		duplicatesPrevented: result.duplicatePrevented || result.inProgress ? 1 : 0,
		lastConfirmAt: result.job === 'confirm' ? new Date().toISOString() : undefined,
		lastDiscoverAt: result.job === 'discover' ? new Date().toISOString() : undefined,
		nextConfirmAt: result.job === 'confirm' ? result.nextEligibleAt ?? undefined : undefined,
		nextDiscoverAt: result.job === 'discover' ? result.nextEligibleAt ?? undefined : undefined,
		lastDurationMs: Date.now() - started,
		lastError: null,
	});
}

export async function refreshLiveSources(
	env: Env,
	userId: string,
	accessToken: string,
	opts: { force: boolean; offset: number },
) {
	const started = Date.now();
	const store = d1QuadStore(env.DB);
	const result = await confirmWithToken(store, accessToken, userId, { force: opts.force });
	await recordResult(env, userId, result, started);
	const sources = await listLiveSources(env.DB, userId);
	const session = await getLiveSession(env.DB, userId);
	return {
		...result,
		done: true as const,
		nextOffset: sources.length,
		total: sources.length,
		sources,
		session,
	};
}

export async function discoverLiveSources(
	env: Env,
	userId: string,
	accessToken: string,
	opts: { force?: boolean; categoryId?: string } = {},
) {
	const started = Date.now();
	const store = d1QuadStore(env.DB);
	const sourceIds = opts.categoryId ? await listLiveSourceIdsForCategory(env.DB, userId, opts.categoryId) : undefined;
	const result = await discoverWithToken(store, accessToken, userId, {
		force: opts.force,
		sourceIds,
	});
	await recordResult(env, userId, result, started);
	return {
		...result,
		sources: await listLiveSources(env.DB, userId),
		session: await getLiveSession(env.DB, userId),
	};
}

export async function refreshOneLiveSource(env: Env, userId: string, accessToken: string, id: string) {
	const store = d1QuadStore(env.DB);
	const settings = await getQuadSettings(env.DB, userId);
	const result = await recoverWithToken(store, accessToken, userId, id, {
		searchFallbackEnabled: settings.searchFallbackEnabled,
		searchDailyAllowance: settings.searchDailyAllowance,
	});
	return {
		...result,
		source: await getLiveSource(env.DB, userId, id),
		session: await getLiveSession(env.DB, userId),
		quotaUsed: result.quotaUsed,
	};
}

export async function reportLivePlayerError(
	env: Env,
	userId: string,
	accessToken: string,
	sourceId: string,
	videoId?: string | null,
) {
	const store = d1QuadStore(env.DB);
	const yt = createYoutubeClient(accessToken);
	const settings = await getQuadSettings(env.DB, userId);
	const result = await reportQuadPlayerError(store, yt, userId, sourceId, videoId, {
		searchFallbackEnabled: settings.searchFallbackEnabled,
		searchDailyAllowance: settings.searchDailyAllowance,
	});
	return {
		...result,
		sources: await listLiveSources(env.DB, userId),
		session: await getLiveSession(env.DB, userId),
	};
}

export async function putLiveSession(
	env: Env,
	userId: string,
	body: { gridSize?: number; slots?: Array<{ slotNumber: number; sourceId: string | null; videoId?: string | null }> },
) {
	if (typeof body.gridSize === 'number' && isLiveGridSize(body.gridSize)) {
		await setLiveGridSize(env.DB, userId, body.gridSize);
	}
	if (body.slots) {
		for (const slot of body.slots) {
			await assignLiveSlot(env.DB, userId, slot.slotNumber, slot.sourceId, slot.videoId ?? null);
		}
	}
	return getLiveSession(env.DB, userId);
}

function activeLives(source: { liveVideos?: Array<{ status?: string }>; sourceMode?: string }) {
	return (source.liveVideos ?? []).filter((video) => video.status === 'live' || video.status === 'non_embeddable');
}

export async function getLiveMonitor(env: Env, userId: string) {
	const settings = await getQuadSettings(env.DB, userId);
	const stats = await getQuadStats(env.DB, userId, utcDay());
	const sources = await listLiveSources(env.DB, userId);
	const store = d1QuadStore(env.DB);
	const searchUsed = await store.searchUsed(userId, utcDay());
	const activeStreamCount = sources.reduce((n, s) => n + (s.sourceMode === 'disabled' ? 0 : activeLives(s).length), 0);
	const upcoming = sources.filter((s) => s.sourceMode !== 'disabled' && Boolean(s.knownLiveVideoId) === false && (s.liveVideos?.length ?? 0) === 0);
	return {
		settings,
		stats: {
			...stats,
			searchQueries: Math.max(stats.searchQueries, searchUsed),
		},
		counts: {
			knownLive: activeStreamCount,
			knownUpcoming: sources.filter((s) => s.sourceMode !== 'disabled' && !s.isLive && s.nextStatusCheckAt).length,
			offline: sources.filter((s) => s.sourceMode !== 'disabled' && !s.isLive).length,
			alwaysOn: sources.filter((s) => s.sourceMode === 'always_on').length,
			onDemand: sources.filter((s) => s.sourceMode === 'on_demand').length,
			disabled: sources.filter((s) => s.sourceMode === 'disabled').length,
		},
		searchRemaining: Math.max(0, settings.searchDailyAllowance - searchUsed),
		quotaNote: 'Quad API and Search Query counts are application-side estimates. Google Cloud Console is authoritative.',
	};
}

export async function getLiveJobs(env: Env, userId: string) {
	const store = d1QuadStore(env.DB);
	const [confirm, discover, recover] = await Promise.all([
		store.getLock(userId, 'confirm'),
		store.getLock(userId, 'discover'),
		store.getLock(userId, 'recover'),
	]);
	return { confirm, discover, recover };
}

export { getQuadSettings, putQuadSettings };
