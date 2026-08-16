import type { QuadCandidateRow, QuadSourceRow, QuadStore } from '../db/quadStore';
import {
	QUAD_CONFIRM_TTL_MS,
	QUAD_DISCOVERY_TTL_MS,
	QUAD_LOCK_TTL_MS,
	QUAD_PLAYER_ERROR_RATE_MS,
	QUAD_PLAYLIST_NEWEST,
	QUAD_SEARCH_COOLDOWN_MS,
	QUAD_SEARCH_DAILY_ALLOWANCE,
	classifyYoutubeVideo,
	isPlayableLive,
	isVerifiedLiveStatus,
	isDue,
	plusMs,
	utcDay,
} from './quadClassify';
import { randomToken } from '../auth/crypto';
import {
	createYoutubeClient,
	fetchChannelLiveVideos,
	fetchNewestPlaylistVideoIds,
	fetchUploadsPlaylistIds,
	fetchVideosByIds,
	type YoutubeClient,
	type YoutubeVideoItem,
} from './youtube';

export interface QuadRefreshResult {
	cached: boolean;
	inProgress: boolean;
	done: true;
	job: 'confirm' | 'discover' | 'recover';
	liveCount: number;
	offlineCount: number;
	quotaUsed: number;
	searchQueries: number;
	calls: YoutubeClient['calls'];
	lastRefreshedAt: string;
	nextEligibleAt: string | null;
	cacheHit: boolean;
	duplicatePrevented: boolean;
	error?: string;
	nextOffset: number;
	total: number;
}

function emptyCalls(): YoutubeClient['calls'] {
	return { search: 0, videos: 0, playlistItems: 0, channels: 0, other: 0 };
}

function summary(sources: QuadSourceRow[], extra: Partial<QuadRefreshResult> & { job: QuadRefreshResult['job'] }): QuadRefreshResult {
	const enabled = sources.filter((s) => s.sourceMode !== 'disabled');
	const liveCount = enabled.filter((s) => s.isLive).length;
	return {
		cached: false,
		inProgress: false,
		done: true,
		liveCount,
		offlineCount: enabled.length - liveCount,
		quotaUsed: 0,
		searchQueries: 0,
		calls: emptyCalls(),
		lastRefreshedAt: new Date().toISOString(),
		nextOffset: enabled.length,
		total: enabled.length,
		cacheHit: extra.cached === true,
		duplicatePrevented: extra.inProgress === true,
		nextEligibleAt: extra.nextEligibleAt ?? null,
		...extra,
	};
}

export function collectConfirmIds(
	sources: QuadSourceRow[],
	slots: Array<{ sourceId: string | null; videoId: string | null }>,
	candidates: QuadCandidateRow[],
): Map<string, string> {
	const sourceById = new Map(sources.map((s) => [s.id, s]));
	const videoToSource = new Map<string, string>();
	const add = (sourceId: string | null | undefined, videoId: string | null | undefined) => {
		if (!sourceId || !videoId) return;
		const source = sourceById.get(sourceId);
		if (!source || source.sourceMode === 'disabled') return;
		videoToSource.set(videoId, sourceId);
	};
	for (const source of sources) {
		if (source.sourceMode === 'disabled') continue;
		if (source.sourceMode === 'on_demand') {
			const assigned = slots.some((slot) => slot.sourceId === source.id);
			if (!assigned) continue;
		}
		add(source.id, source.knownLiveVideoId);
		add(source.id, source.knownUpcomingVideoId);
		add(source.id, source.liveVideoId);
	}
	for (const slot of slots) add(slot.sourceId, slot.videoId);
	for (const row of candidates) {
		const source = sourceById.get(row.sourceId);
		if (!source || source.sourceMode === 'disabled') continue;
		if (source.sourceMode === 'on_demand' && !slots.some((slot) => slot.sourceId === source.id)) continue;
		add(row.sourceId, row.videoId);
	}
	return videoToSource;
}

async function applyClassifications(
	store: QuadStore,
	userId: string,
	now: Date,
	videoToSource: Map<string, string>,
	items: Map<string, YoutubeVideoItem>,
): Promise<void> {
	const nowIso = now.toISOString();
	const bySource = new Map<string, QuadCandidateRow[]>();
	for (const [videoId, sourceId] of videoToSource) {
		const item = items.get(videoId);
		const status = classifyYoutubeVideo(item);
		const embeddable = item?.status?.embeddable !== false && status !== 'non_embeddable';
		const title = item?.snippet?.title ?? videoId;
		const row: QuadCandidateRow = {
			sourceId,
			videoId,
			title,
			status,
			embeddable: status === 'non_embeddable' ? false : embeddable,
			lastCheckedAt: nowIso,
		};
		const list = bySource.get(sourceId) ?? [];
		list.push(row);
		bySource.set(sourceId, list);
	}
	for (const [sourceId, rows] of bySource) {
		const keep = rows.filter((r) => isVerifiedLiveStatus(r.status) || r.status === 'upcoming');
		await store.replaceSourceCandidates(sourceId, keep);
	}

	const sources = await store.listSources(userId);
	for (const source of sources) {
		if (source.sourceMode === 'disabled') continue;
		const rows = bySource.get(source.id);
		if (!rows) continue;
		const live = rows.filter((r) => isVerifiedLiveStatus(r.status));
		const playable = rows.filter((r) => isPlayableLive(r.status, r.embeddable));
		const upcoming = rows.filter((r) => r.status === 'upcoming');
		const knownLive = playable[0] ?? live[0] ?? null;
		const knownUpcoming = upcoming[0] ?? null;
		await store.patchSource(userId, source.id, {
			knownLiveVideoId: knownLive?.videoId ?? null,
			knownUpcomingVideoId: knownUpcoming?.videoId ?? null,
			isLive: live.length > 0,
			liveVideoId: knownLive?.videoId ?? null,
			liveTitle: knownLive?.title ?? null,
			liveCheckedAt: nowIso,
			lastStatusCheckAt: nowIso,
			nextStatusCheckAt: plusMs(QUAD_CONFIRM_TTL_MS, now),
			lastLiveAt: live.length ? nowIso : source.lastLiveAt,
			consecutiveOfflineChecks: live.length ? 0 : source.consecutiveOfflineChecks + 1,
			nextDiscoveryAt: source.sourceMode === 'always_on' && !live.length ? nowIso : source.nextDiscoveryAt,
			verifyState: 'ok',
			verifyError: null,
		});
	}
}

async function ensurePlaylists(store: QuadStore, yt: YoutubeClient, sources: QuadSourceRow[]): Promise<void> {
	const missing = sources.filter((s) => s.channelId && !s.uploadsPlaylistId);
	if (!missing.length) return;
	const map = await fetchUploadsPlaylistIds(
		yt,
		missing.map((s) => s.channelId),
	);
	for (const source of missing) {
		const playlistId = map.get(source.channelId);
		if (playlistId) await store.patchSource(source.userId, source.id, { uploadsPlaylistId: playlistId });
	}
}

async function discoverSource(store: QuadStore, yt: YoutubeClient, source: QuadSourceRow, now: Date): Promise<void> {
	if (!source.uploadsPlaylistId) return;
	const ids = await fetchNewestPlaylistVideoIds(yt, source.uploadsPlaylistId, QUAD_PLAYLIST_NEWEST);
	const existing = await store.listCandidates([source.id]);
	const known = new Set(existing.map((r) => r.videoId));
	const fresh = ids.filter((id) => !known.has(id));
	const relevant = existing.filter((r) => r.status === 'live' || r.status === 'upcoming' || r.status === 'unknown').map((r) => r.videoId);
	const toClassify = [...new Set([...fresh, ...relevant, ...ids])];
	if (!toClassify.length) {
		await store.patchSource(source.userId, source.id, {
			lastDiscoveryAt: now.toISOString(),
			nextDiscoveryAt: plusMs(QUAD_DISCOVERY_TTL_MS, now),
		});
		return;
	}
	const items = await fetchVideosByIds(yt, toClassify);
	const videoToSource = new Map(toClassify.map((id) => [id, source.id] as const));
	await applyClassifications(store, source.userId, now, videoToSource, items);
	await store.patchSource(source.userId, source.id, {
		lastDiscoveryAt: now.toISOString(),
		nextDiscoveryAt: plusMs(QUAD_DISCOVERY_TTL_MS, now),
	});
}

async function withLock(
	store: QuadStore,
	userId: string,
	job: 'confirm' | 'discover' | 'recover',
	now: Date,
	run: () => Promise<QuadRefreshResult>,
): Promise<QuadRefreshResult> {
	const holder = randomToken(12);
	const nowIso = now.toISOString();
	const got = await store.tryLock(userId, job, holder, plusMs(QUAD_LOCK_TTL_MS, now), nowIso);
	if (!got) {
		const lock = await store.getLock(userId, job);
		if (lock?.resultJson) {
			try {
				return { ...(JSON.parse(lock.resultJson) as QuadRefreshResult), cached: true, inProgress: lock.status === 'running' };
			} catch {
				/* fall through */
			}
		}
		const sources = await store.listSources(userId);
		return summary(sources, { job, cached: true, inProgress: true, lastRefreshedAt: nowIso });
	}
	try {
		const result = await run();
		await store.finishLock(userId, job, JSON.stringify(result), new Date().toISOString());
		return result;
	} catch (error) {
		await store.finishLock(
			userId,
			job,
			JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }),
			new Date().toISOString(),
		);
		throw error;
	}
}

export async function confirmLiveStatuses(
	store: QuadStore,
	yt: YoutubeClient,
	userId: string,
	opts: { force?: boolean; scheduled?: boolean } = {},
): Promise<QuadRefreshResult> {
	const now = new Date();
	return withLock(store, userId, 'confirm', now, async () => {
		const sources = await store.listSources(userId);
		const slots = await store.listSlots(userId);
		const slotted = new Set(slots.map((s) => s.sourceId).filter(Boolean));
		const dueSources = sources.filter((s) => {
			if (s.sourceMode === 'disabled') return false;
			if (s.sourceMode === 'on_demand') return !opts.scheduled && slotted.has(s.id) && isDue(s.nextStatusCheckAt, now);
			return isDue(s.nextStatusCheckAt, now);
		});
		if (!dueSources.length) {
			const nextAt = sources.reduce<string | null>((acc, s) => {
				if (!s.nextStatusCheckAt) return acc;
				if (!acc || s.nextStatusCheckAt < acc) return s.nextStatusCheckAt;
				return acc;
			}, null);
			return summary(sources, {
				job: 'confirm',
				cached: true,
				cacheHit: true,
				lastRefreshedAt: sources[0]?.lastStatusCheckAt ?? now.toISOString(),
				nextEligibleAt: nextAt,
				quotaUsed: yt.quotaUsed,
				searchQueries: yt.searchQueries,
				calls: { ...yt.calls },
			});
		}
		const candidates = await store.listCandidates(sources.map((s) => s.id));
		const videoToSource = collectConfirmIds(dueSources, slots, candidates);
		const ids = [...videoToSource.keys()];
		try {
			const items = ids.length ? await fetchVideosByIds(yt, ids) : new Map();
			if (ids.length) await applyClassifications(store, userId, now, videoToSource, items);
			else {
				for (const source of dueSources) {
					await store.replaceSourceCandidates(source.id, []);
					await store.patchSource(userId, source.id, {
						knownLiveVideoId: null,
						isLive: false,
						liveVideoId: null,
						liveTitle: null,
						liveCheckedAt: now.toISOString(),
						lastStatusCheckAt: now.toISOString(),
						nextStatusCheckAt: plusMs(QUAD_CONFIRM_TTL_MS, now),
						verifyState: 'ok',
						verifyError: null,
					});
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'verification_failed';
			for (const source of dueSources) {
				await store.patchSource(userId, source.id, {
					verifyState: 'error',
					verifyError: message,
				});
			}
			const afterFail = await store.listSources(userId);
			return summary(afterFail, {
				job: 'confirm',
				error: message,
				lastRefreshedAt: now.toISOString(),
				quotaUsed: yt.quotaUsed,
				searchQueries: yt.searchQueries,
				calls: { ...yt.calls },
			});
		}
		const after = await store.listSources(userId);
		return summary(after, {
			job: 'confirm',
			lastRefreshedAt: now.toISOString(),
			quotaUsed: yt.quotaUsed,
			searchQueries: yt.searchQueries,
			calls: { ...yt.calls },
		});
	});
}

function discoveryEligible(source: QuadSourceRow, slots: Array<{ sourceId: string | null }>, now: Date, scheduled: boolean): boolean {
	if (source.sourceMode === 'disabled') return false;
	if (source.sourceMode === 'on_demand') {
		if (scheduled) return false;
		return slots.some((slot) => slot.sourceId === source.id) && isDue(source.nextDiscoveryAt, now);
	}
	if (source.sourceMode === 'always_on') {
		if (source.knownLiveVideoId && source.isLive) return false;
		return isDue(source.nextDiscoveryAt, now);
	}
	return isDue(source.nextDiscoveryAt, now);
}

export async function discoverLiveStreams(
	store: QuadStore,
	yt: YoutubeClient,
	userId: string,
	opts: { force?: boolean; scheduled?: boolean; sourceIds?: string[] } = {},
): Promise<QuadRefreshResult> {
	const now = new Date();
	return withLock(store, userId, 'discover', now, async () => {
		const sources = await store.listSources(userId);
		const slots = await store.listSlots(userId);
		const targeted = opts.sourceIds?.length
			? sources.filter((s) => opts.sourceIds!.includes(s.id) && s.sourceMode !== 'always_on' && s.sourceMode !== 'disabled')
			: null;
		const due = targeted ?? sources.filter((s) => discoveryEligible(s, slots, now, opts.scheduled === true));
		if (!due.length) {
			const nextAt = sources.reduce<string | null>((acc, s) => {
				if (!s.nextDiscoveryAt) return acc;
				if (!acc || s.nextDiscoveryAt < acc) return s.nextDiscoveryAt;
				return acc;
			}, null);
			return summary(sources, {
				job: 'discover',
				cached: true,
				cacheHit: true,
				lastRefreshedAt: now.toISOString(),
				nextEligibleAt: nextAt,
			});
		}
		try {
			await ensurePlaylists(store, yt, due);
			const refreshed = await store.listSources(userId);
			const dueNow = refreshed.filter((s) => due.some((d) => d.id === s.id));
			const videoToSource = new Map<string, string>();
			const toClassify: string[] = [];
			for (const source of dueNow) {
				if (!source.uploadsPlaylistId) continue;
				const ids = await fetchNewestPlaylistVideoIds(yt, source.uploadsPlaylistId, QUAD_PLAYLIST_NEWEST);
				const existing = await store.listCandidates([source.id]);
				const relevant = existing.filter((r) => isVerifiedLiveStatus(r.status) || r.status === 'upcoming').map((r) => r.videoId);
				for (const id of [...new Set([...ids, ...relevant])]) {
					toClassify.push(id);
					videoToSource.set(id, source.id);
				}
			}
			if (toClassify.length) {
				const items = await fetchVideosByIds(yt, toClassify);
				await applyClassifications(store, userId, now, videoToSource, items);
			}
			for (const source of dueNow) {
				await store.patchSource(source.userId, source.id, {
					lastDiscoveryAt: now.toISOString(),
					nextDiscoveryAt: plusMs(QUAD_DISCOVERY_TTL_MS, now),
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'verification_failed';
			for (const source of due) {
				await store.patchSource(userId, source.id, { verifyState: 'error', verifyError: message });
			}
			const afterFail = await store.listSources(userId);
			return summary(afterFail, {
				job: 'discover',
				error: message,
				lastRefreshedAt: now.toISOString(),
				quotaUsed: yt.quotaUsed,
				searchQueries: yt.searchQueries,
				calls: { ...yt.calls },
			});
		}
		const after = await store.listSources(userId);
		return summary(after, {
			job: 'discover',
			lastRefreshedAt: now.toISOString(),
			quotaUsed: yt.quotaUsed,
			searchQueries: yt.searchQueries,
			calls: { ...yt.calls },
		});
	});
}

async function trySearchRecovery(
	store: QuadStore,
	yt: YoutubeClient,
	userId: string,
	source: QuadSourceRow,
	now: Date,
	policy: { searchFallbackEnabled?: boolean; searchDailyAllowance?: number } = {},
): Promise<boolean> {
	if (policy.searchFallbackEnabled === false) return false;
	if (!isDue(source.searchCooldownUntil, now)) return false;
	const used = await store.searchUsed(userId, utcDay(now));
	const allowance = policy.searchDailyAllowance ?? QUAD_SEARCH_DAILY_ALLOWANCE;
	if (used >= allowance) return false;
	const before = yt.searchQueries;
	const lives = await fetchChannelLiveVideos(yt, source.channelId);
	await store.addSearchUse(userId, utcDay(now), Math.max(1, yt.searchQueries - before));
	await store.patchSource(userId, source.id, { searchCooldownUntil: plusMs(QUAD_SEARCH_COOLDOWN_MS, now) });
	if (!lives.length) return false;
	const items = await fetchVideosByIds(
		yt,
		lives.map((v) => v.videoId),
	);
	const videoToSource = new Map(lives.map((v) => [v.videoId, source.id] as const));
	await applyClassifications(store, userId, now, videoToSource, items);
	return true;
}

export async function recoverLiveSource(
	store: QuadStore,
	yt: YoutubeClient,
	userId: string,
	sourceId: string,
	policy: { searchFallbackEnabled?: boolean; searchDailyAllowance?: number } = {},
): Promise<QuadRefreshResult> {
	const now = new Date();
	return withLock(store, userId, 'recover', now, async () => {
		let source = await store.getSource(userId, sourceId);
		if (!source) throw new Error('not_found');
		if (source.sourceMode === 'disabled') {
			await store.patchSource(userId, sourceId, { sourceMode: 'normal' });
			source = await store.getSource(userId, sourceId);
			if (!source) throw new Error('not_found');
		}
		await store.clearSourceCandidates(sourceId);
		await store.patchSource(userId, sourceId, {
			knownLiveVideoId: null,
			knownUpcomingVideoId: null,
			isLive: false,
			liveVideoId: null,
			liveTitle: null,
		});
		try {
			await ensurePlaylists(store, yt, [source]);
			const latest = await store.getSource(userId, sourceId);
			if (latest?.uploadsPlaylistId) await discoverSource(store, yt, latest, now);
			const afterDiscover = await store.getSource(userId, sourceId);
			if (!afterDiscover?.isLive && afterDiscover?.sourceMode === 'always_on') {
				await trySearchRecovery(store, yt, userId, afterDiscover, now, policy);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'verification_failed';
			await store.patchSource(userId, sourceId, { verifyState: 'error', verifyError: message });
			const afterFail = await store.listSources(userId);
			return summary(afterFail, { job: 'recover', error: message, lastRefreshedAt: now.toISOString() });
		}
		const after = await store.listSources(userId);
		return summary(after, {
			job: 'recover',
			lastRefreshedAt: now.toISOString(),
			quotaUsed: yt.quotaUsed,
			searchQueries: yt.searchQueries,
			calls: { ...yt.calls },
		});
	});
}

export async function reportQuadPlayerError(
	store: QuadStore,
	yt: YoutubeClient,
	userId: string,
	sourceId: string,
	_videoId?: string | null,
	policy?: { searchFallbackEnabled?: boolean; searchDailyAllowance?: number },
): Promise<QuadRefreshResult> {
	const now = new Date();
	const source = await store.getSource(userId, sourceId);
	if (!source) throw new Error('not_found');
	if (source.lastPlayerErrorAt && !isDue(plusMs(QUAD_PLAYER_ERROR_RATE_MS, new Date(Date.parse(source.lastPlayerErrorAt))), now)) {
		const sources = await store.listSources(userId);
		return summary(sources, { job: 'recover', cached: true, lastRefreshedAt: source.lastPlayerErrorAt });
	}
	await store.patchSource(userId, sourceId, {
		lastPlayerErrorAt: now.toISOString(),
		nextStatusCheckAt: now.toISOString(),
		nextDiscoveryAt: now.toISOString(),
	});
	return recoverLiveSource(store, yt, userId, sourceId, policy);
}

export async function confirmWithToken(store: QuadStore, accessToken: string, userId: string, opts?: { force?: boolean }) {
	return confirmLiveStatuses(store, createYoutubeClient(accessToken), userId, opts);
}

export async function discoverWithToken(
	store: QuadStore,
	accessToken: string,
	userId: string,
	opts?: { force?: boolean; sourceIds?: string[] },
) {
	return discoverLiveStreams(store, createYoutubeClient(accessToken), userId, opts);
}

export async function recoverWithToken(
	store: QuadStore,
	accessToken: string,
	userId: string,
	sourceId: string,
	policy?: { searchFallbackEnabled?: boolean; searchDailyAllowance?: number },
) {
	return recoverLiveSource(store, createYoutubeClient(accessToken), userId, sourceId, policy);
}
