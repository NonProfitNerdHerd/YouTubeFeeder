import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { syncAllDueContent, syncContent, syncSubscriptions } from '../../worker/services/sync';
import { YoutubeApiError, type YoutubeClient } from '../../worker/services/youtube';
import { formatSyncCompletion, skippedChannelNames } from '../../src/lib/syncStatus';
import { asEnv, MemorySyncDb } from './helpers/memorySyncDb';

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
				yt.quotaUsed += 100;
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
			return handler(path, params);
		},
	};
	return yt;
}

function playlistNotFound(playlistId: string) {
	return new YoutubeApiError(`YouTube API playlistItems failed (404).`, 404, false, 'playlistItems', 'playlistNotFound');
}

function videoItem(id: string, channelId: string, publishedAt = '2026-08-01T00:00:00Z') {
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

function seedEight(db: MemorySyncDb, badIndexes: number[] = []) {
	const bad = new Set(badIndexes);
	for (let i = 0; i < 8; i += 1) {
		db.seedChannel({
			channel_id: `UC${i}`,
			title: `Channel ${i}`,
			uploads_playlist_id: bad.has(i) ? `UU_BAD_${i}` : `UU${i}`,
		});
	}
}

function seedN(db: MemorySyncDb, n: number, badIndexes: number[] = []) {
	const bad = new Set(badIndexes);
	for (let i = 0; i < n; i += 1) {
		db.seedChannel({
			channel_id: `UC${i}`,
			title: `Channel ${i}`,
			uploads_playlist_id: bad.has(i) ? `UU_BAD_${i}` : `UU${i}`,
		});
	}
}

function defaultHandler(opts?: {
	missingChannels?: Set<string>;
	playlistRemap?: Map<string, string>;
	failPlaylists?: Set<string>;
	quotaOnPlaylist?: string;
	authOnPlaylist?: string;
}): YoutubeClient['getJson'] {
	const missing = opts?.missingChannels ?? new Set<string>();
	const remap = opts?.playlistRemap ?? new Map<string, string>();
	const fail = opts?.failPlaylists ?? new Set<string>();
	const playlistHits = new Map<string, number>();

	return async (path, params) => {
		if (path === 'playlistItems') {
			const playlistId = params.playlistId;
			playlistHits.set(playlistId, (playlistHits.get(playlistId) ?? 0) + 1);
			if (opts?.quotaOnPlaylist === playlistId) {
				throw new YoutubeApiError('YouTube API quota exhausted.', 403, true, 'playlistItems', 'quotaExceeded');
			}
			if (opts?.authOnPlaylist === playlistId) {
				throw new YoutubeApiError('YouTube API authorization failed.', 401, false, 'playlistItems', 'authError');
			}
			if (fail.has(playlistId)) throw playlistNotFound(playlistId);
			const channelId = playlistId.replace(/^UU_BAD_/, 'UC').replace(/^UU_NEW_/, 'UC').replace(/^UU/, 'UC');
			return {
				items: [{ contentDetails: { videoId: `v_${channelId}` } }],
			};
		}
		if (path === 'channels') {
			const ids = (params.id ?? '').split(',').filter(Boolean);
			return {
				items: ids
					.filter((id) => !missing.has(id))
					.map((id) => ({
						id,
						contentDetails: {
							relatedPlaylists: {
								uploads: remap.get(id) ?? `UU${id.replace(/^UC/, '')}`,
							},
						},
					})),
			};
		}
		if (path === 'videos') {
			const ids = (params.id ?? '').split(',').filter(Boolean);
			return {
				items: ids.map((id) => {
					const channelId = id.replace(/^v_/, '');
					return videoItem(id, channelId);
				}),
			};
		}
		throw new Error(`unexpected ${path}`);
	};
}

describe('content sync playlist resilience', () => {
	it('1. all eight channels succeed and nextOffset advances by eight', async () => {
		const db = new MemorySyncDb();
		seedEight(db);
		const yt = mockYt(defaultHandler());
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.status).toBe('ok');
		expect(result.channelsChecked).toBe(8);
		expect(result.channelsSkipped).toBe(0);
		expect(result.nextOffset).toBe(8);
		expect(result.done).toBe(true);
		expect(result.videosAdded).toBe(8);
		expect(result.warnings).toBeUndefined();
	});

	it('2. 404 then channels.list returns a different playlist and retry succeeds', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [3]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_3']),
				playlistRemap: new Map([['UC3', 'UU_NEW_3']]),
			}),
		);
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.status).toBe('ok');
		expect(result.channelsSkipped).toBe(0);
		expect(db.channels.get('UC3')?.uploads_playlist_id).toBe('UU_NEW_3');
		expect(result.videosAdded).toBe(8);
		expect(yt.calls.channels).toBeGreaterThanOrEqual(1);
		expect(yt.calls.playlistItems).toBeGreaterThanOrEqual(9);
	});

	it('3. 404 and channel no longer exists → skip one, process seven, advance offset', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [2]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_2']),
				missingChannels: new Set(['UC2']),
			}),
		);
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.status).toBe('ok');
		expect(result.channelsChecked).toBe(8);
		expect(result.channelsSkipped).toBe(1);
		expect(result.nextOffset).toBe(8);
		expect(result.warnings?.[0]?.channelId).toBe('UC2');
		expect(result.warnings?.[0]?.code).toBe('channel_unavailable');
		expect(result.videosAdded).toBe(7);
		expect(db.videos.size).toBe(7);
	});

	it('4. refreshed playlist unchanged and retry not looped', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [1]);
		let playlistCallsForBad = 0;
		const yt = mockYt(async (path, params) => {
			if (path === 'playlistItems' && params.playlistId === 'UU_BAD_1') {
				playlistCallsForBad += 1;
				throw playlistNotFound('UU_BAD_1');
			}
			return defaultHandler({
				failPlaylists: new Set(['UU_BAD_1']),
				playlistRemap: new Map([['UC1', 'UU_BAD_1']]),
			})(path, params);
		});
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.status).toBe('ok');
		expect(result.channelsSkipped).toBe(1);
		expect(playlistCallsForBad).toBe(1);
		expect(result.warnings?.[0]?.code).toBe('uploads_playlist_not_found');
	});

	it('5. first channel 404 still processes remaining seven', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [0]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_0']),
				missingChannels: new Set(['UC0']),
			}),
		);
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.channelsSkipped).toBe(1);
		expect(result.videosAdded).toBe(7);
		expect([...db.videos.keys()].sort()).toEqual([
			'v_UC1',
			'v_UC2',
			'v_UC3',
			'v_UC4',
			'v_UC5',
			'v_UC6',
			'v_UC7',
		]);
	});

	it('6. middle channel 404 still processes remaining channels', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [4]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_4']),
				missingChannels: new Set(['UC4']),
			}),
		);
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.channelsSkipped).toBe(1);
		expect(result.videosAdded).toBe(7);
		expect(db.videos.has('v_UC4')).toBe(false);
		expect(db.videos.has('v_UC7')).toBe(true);
	});

	it('7. last channel 404 keeps prior seven committed', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [7]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_7']),
				missingChannels: new Set(['UC7']),
			}),
		);
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.channelsSkipped).toBe(1);
		expect(result.videosAdded).toBe(7);
		expect(db.videos.has('v_UC0')).toBe(true);
		expect(db.videos.has('v_UC6')).toBe(true);
		expect(db.videos.has('v_UC7')).toBe(false);
	});

	it('8. multiple 404 channels are skipped and progress advances', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [1, 3, 5]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_1', 'UU_BAD_3', 'UU_BAD_5']),
				missingChannels: new Set(['UC1', 'UC3', 'UC5']),
			}),
		);
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.channelsChecked).toBe(8);
		expect(result.channelsSkipped).toBe(3);
		expect(result.nextOffset).toBe(8);
		expect(result.videosAdded).toBe(5);
		expect(result.warnings).toHaveLength(3);
	});

	it('9. quota exhaustion remains a global failure', async () => {
		const db = new MemorySyncDb();
		seedEight(db);
		const yt = mockYt(defaultHandler({ quotaOnPlaylist: 'UU0' }));
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.status).toBe('quota');
		expect(result.errorSummary).toMatch(/quota/i);
		expect(result.channelsSkipped ?? 0).toBe(0);
	});

	it('10. authentication failure remains a global failure', async () => {
		const db = new MemorySyncDb();
		seedEight(db);
		const yt = mockYt(defaultHandler({ authOnPlaylist: 'UU2' }));
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.status).toBe('error');
		expect(result.errorSummary).toMatch(/authorization|401|forbidden/i);
	});

	it('11. final partial batch with one unavailable channel sets done true', async () => {
		const db = new MemorySyncDb();
		seedN(db, 11, [10]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_10']),
				missingChannels: new Set(['UC10']),
			}),
		);
		const first = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(first.done).toBe(false);
		expect(first.nextOffset).toBe(8);
		const second = await syncContent(asEnv(db), 'user-1', 'token', 8, yt);
		expect(second.channelsChecked).toBe(3);
		expect(second.channelsSkipped).toBe(1);
		expect(second.nextOffset).toBe(11);
		expect(second.done).toBe(true);
	});

	it('14. previously processed videos remain when a later channel is skipped', async () => {
		const db = new MemorySyncDb();
		seedEight(db, [6]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_6']),
				missingChannels: new Set(['UC6']),
			}),
		);
		await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(db.videos.has('v_UC0')).toBe(true);
		expect(db.videos.has('v_UC5')).toBe(true);
		expect(db.videos.has('v_UC6')).toBe(false);
	});

	it('15. sync can reach 96 / 96 when one channel is unavailable', async () => {
		const db = new MemorySyncDb();
		seedN(db, 96, [64]);
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_64']),
				missingChannels: new Set(['UC64']),
			}),
		);
		let offset = 0;
		let skipped = 0;
		let done = false;
		let lastTotal = 0;
		for (let guard = 0; guard < 20 && !done; guard += 1) {
			const result = await syncContent(asEnv(db), 'user-1', 'token', offset, yt);
			expect(result.status).toBe('ok');
			skipped += result.channelsSkipped ?? 0;
			lastTotal = result.totalChannels ?? lastTotal;
			expect(result.nextOffset).toBeGreaterThan(offset);
			offset = result.nextOffset ?? offset;
			done = Boolean(result.done);
		}
		expect(done).toBe(true);
		expect(offset).toBe(96);
		expect(lastTotal).toBe(96);
		expect(skipped).toBe(1);
		expect(db.videos.size).toBe(95);
	});

	it('pages past 15 uploads until the newest-seen watermark', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({
			channel_id: 'UCnews',
			uploads_playlist_id: 'UUnews',
			newest_seen_published_at: '2026-08-17T10:00:00Z',
		});
		const yt = mockYt(async (path, params) => {
			if (path === 'playlistItems') {
				return {
					items: Array.from({ length: 21 }, (_, idx) => {
						const hour = 20 - idx;
						return {
							contentDetails: { videoId: `v${hour}` },
							snippet: { publishedAt: `2026-08-17T${String(hour).padStart(2, '0')}:00:00Z` },
						};
					}),
				};
			}
			if (path === 'videos') {
				const ids = (params.id ?? '').split(',').filter(Boolean);
				return {
					items: ids.map((id) => {
						const hour = id.replace(/^v/, '');
						return videoItem(id, 'UCnews', `2026-08-17T${hour.padStart(2, '0')}:00:00Z`);
					}),
				};
			}
			throw new Error(path);
		});
		const result = await syncContent(asEnv(db), 'user-1', 'token', 0, yt);
		expect(result.status).toBe('ok');
		expect(result.videosAdded).toBe(10);
		expect(db.videos.has('v20')).toBe(true);
		expect(db.videos.has('v11')).toBe(true);
		expect(db.videos.has('v10')).toBe(false);
		expect(db.inbox.has('user-1:v20')).toBe(true);
		expect(db.inbox.has('user-1:v10')).toBe(false);
	});

	it('stale-first batches check the oldest channel before newer ones', async () => {
		const db = new MemorySyncDb();
		seedN(db, 11);
		for (let i = 0; i < 11; i += 1) {
			db.channels.get(`UC${i}`)!.last_synchronized_at = '2026-08-17T12:00:00Z';
		}
		db.channels.get('UC10')!.last_synchronized_at = '2026-08-16T00:00:00Z';
		const yt = mockYt(defaultHandler());
		const first = await syncContent(asEnv(db), 'user-1', 'token', 0, yt, { staleBefore: '2026-08-18T00:00:00Z' });
		expect(first.channelsChecked).toBe(8);
		expect(db.channels.get('UC10')?.last_synchronized_at).not.toBe('2026-08-16T00:00:00Z');
	});

	it('syncAllDueContent checks every due channel across batches', async () => {
		const db = new MemorySyncDb();
		seedN(db, 11);
		const yt = mockYt(defaultHandler());
		const result = await syncAllDueContent(asEnv(db), 'user-1', 'token', yt);
		expect(result.status).toBe('ok');
		expect(result.done).toBe(true);
		expect(result.channelsChecked).toBe(11);
		expect(db.videos.size).toBe(11);
	});

	it('skipped channels are stamped so they do not block later due channels', async () => {
		const db = new MemorySyncDb();
		seedN(db, 9, [0]);
		db.channels.get('UC0')!.last_synchronized_at = '2026-08-01T00:00:00Z';
		const yt = mockYt(
			defaultHandler({
				failPlaylists: new Set(['UU_BAD_0']),
				missingChannels: new Set(['UC0']),
			}),
		);
		const result = await syncAllDueContent(asEnv(db), 'user-1', 'token', yt);
		expect(result.channelsSkipped).toBe(1);
		expect(result.channelsChecked).toBe(9);
		expect(db.channels.get('UC0')?.last_synchronized_at).not.toBe('2026-08-01T00:00:00Z');
		expect(db.videos.has('v_UC8')).toBe(true);
	});
});

describe('subscription uploads playlist refresh', () => {
	it('bootstraps uploads playlist only when missing and leaves existing playlists', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({
			channel_id: 'UCstale',
			title: 'Stale',
			uploads_playlist_id: 'UUstale',
		});
		db.seedChannel({
			channel_id: 'UCgood',
			title: 'Good',
			uploads_playlist_id: null,
		});

		const yt = mockYt(async (path, params) => {
			if (path === 'subscriptions') {
				return {
					items: [
						{ snippet: { title: 'Stale', resourceId: { channelId: 'UCstale' }, thumbnails: {} } },
						{ snippet: { title: 'Good', resourceId: { channelId: 'UCgood' }, thumbnails: {} } },
					],
				};
			}
			if (path === 'channels') {
				expect(params.id).toBe('UCgood');
				return {
					items: [
						{
							id: 'UCgood',
							contentDetails: { relatedPlaylists: { uploads: 'UUgood' } },
						},
					],
				};
			}
			throw new Error(path);
		});

		const result = await syncSubscriptions(asEnv(db), 'user-1', 'token', yt);
		expect(result.status).toBe('ok');
		expect(db.channels.get('UCgood')?.uploads_playlist_id).toBe('UUgood');
		expect(db.channels.get('UCstale')?.uploads_playlist_id).toBe('UUstale');
		expect(yt.calls.channels).toBe(1);
	});

	it('does not overwrite last_synchronized_at or existing uploads playlist', async () => {
		const db = new MemorySyncDb();
		db.seedChannel({
			channel_id: 'UCgood',
			title: 'Good',
			uploads_playlist_id: 'UUold',
			last_synchronized_at: '2026-08-01T00:00:00Z',
		});
		const yt = mockYt(async (path) => {
			if (path === 'subscriptions') {
				return {
					items: [{ snippet: { title: 'Good', resourceId: { channelId: 'UCgood' }, thumbnails: {} } }],
				};
			}
			throw new Error(path);
		});
		await syncSubscriptions(asEnv(db), 'user-1', 'token', yt);
		expect(db.channels.get('UCgood')?.last_synchronized_at).toBe('2026-08-01T00:00:00Z');
		expect(db.channels.get('UCgood')?.uploads_playlist_id).toBe('UUold');
		expect(yt.calls.channels).toBe(0);
	});
});

describe('frontend sync warning messaging', () => {
	it('12. warning fields produce a nonfatal completion message', () => {
		const message = formatSyncCompletion(12, [
			{
				channelId: 'UC1',
				channelTitle: 'Broken Channel',
				code: 'uploads_playlist_not_found',
				message: 'Uploads playlist is currently unavailable.',
			},
		]);
		expect(message).toBe('Updated 12 videos. Skipped 1 unavailable channel: Broken Channel.');
		expect(skippedChannelNames([
			{ channelId: 'UC1', channelTitle: 'Broken Channel', code: 'x', message: 'm' },
			{ channelId: 'UC2', channelTitle: 'Other', code: 'x', message: 'm' },
		])).toEqual(['Broken Channel', 'Other']);
	});

	it('13. InboxPage keeps fatal errors on the red path and continues on warnings', () => {
		const source = readFileSync(new URL('../../src/pages/InboxPage.tsx', import.meta.url), 'utf8');
		expect(source).toContain('formatSyncCompletion');
		expect(source).toContain('accumulatedWarnings');
		expect(source).toContain("setStatus(null)");
		expect(source).toContain("status-line warning");
		expect(source).toContain("throw new Error(syncMessage(contentBody, 'Video sync failed.'))");
		expect(source).toContain('if (next === offset) throw new Error');
		expect(source).toContain('if (contentBody.done) break');
		expect(source).toContain('await load()');
		expect(source).toContain('New videos available');
		expect(source).toContain('checkInboxFreshness');
		expect(source).toContain('Playthrough');
		expect(source).toContain('startPlaythrough');
	});
});

describe('youtube error enrichment', () => {
	it('marks playlist 404 as skippable and quota/auth as global', async () => {
		const { extractYoutubeErrorReason, YoutubeApiError: Err } = await import('../../worker/services/youtube');
		expect(extractYoutubeErrorReason('{"error":{"errors":[{"reason":"playlistNotFound"}]}}')).toBe('playlistNotFound');
		const miss = new Err('x', 404, false, 'playlistItems', 'playlistNotFound');
		expect(miss.isPlaylistNotFound).toBe(true);
		expect(miss.isGlobalFatal).toBe(false);
		const quota = new Err('x', 403, true, 'playlistItems', 'quotaExceeded');
		expect(quota.isGlobalFatal).toBe(true);
		const auth = new Err('x', 401, false, 'playlistItems', 'authError');
		expect(auth.isGlobalFatal).toBe(true);
	});
});
