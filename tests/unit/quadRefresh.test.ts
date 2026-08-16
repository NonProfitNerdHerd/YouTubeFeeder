import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryQuadStore, source } from './helpers/memoryQuadStore';
import { classifyYoutubeVideo, isActuallyLiveVideo, QUAD_SEARCH_DAILY_ALLOWANCE } from '../../worker/services/quadClassify';
import { collectConfirmIds, confirmLiveStatuses, discoverLiveStreams, recoverLiveSource } from '../../worker/services/quadRefresh';
import type { YoutubeClient } from '../../worker/services/youtube';

function mockYt(handler: (path: string, params: Record<string, string>) => unknown, delayMs = 0): YoutubeClient {
	return {
		quotaUsed: 0,
		searchQueries: 0,
		calls: { search: 0, videos: 0, playlistItems: 0, channels: 0, other: 0 },
		async getJson(path, params) {
			if (path === 'search') {
				this.quotaUsed += 100;
				this.searchQueries += 1;
				this.calls.search += 1;
			} else {
				this.quotaUsed += 1;
				if (path === 'videos') this.calls.videos += 1;
				else if (path === 'playlistItems') this.calls.playlistItems += 1;
				else if (path === 'channels') this.calls.channels += 1;
				else this.calls.other += 1;
			}
			if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
			return handler(path, params) as never;
		},
	};
}

function vodHandler(): (path: string, params: Record<string, string>) => unknown {
	return (path, params) => {
		if (path === 'playlistItems') {
			return { items: Array.from({ length: 8 }, (_, i) => ({ contentDetails: { videoId: `vid${params.playlistId}_${i}` } })) };
		}
		if (path === 'videos') {
			const ids = (params.id ?? '').split(',').filter(Boolean);
			return {
				items: ids.map((id) => ({
					id,
					snippet: { title: id, liveBroadcastContent: 'none' },
					status: { embeddable: true, privacyStatus: 'public' },
				})),
			};
		}
		if (path === 'channels') return { items: [] };
		if (path === 'search') return { items: [] };
		return {};
	};
}

describe('quad classify', () => {
	it('classifies live, upcoming, completed, private, deleted, non-embeddable', () => {
		expect(classifyYoutubeVideo(undefined)).toBe('deleted');
		expect(classifyYoutubeVideo({ id: 'a', snippet: { liveBroadcastContent: 'live' }, status: { embeddable: true } })).toBe('unavailable');
		expect(
			classifyYoutubeVideo({
				id: 'a',
				snippet: { liveBroadcastContent: 'live' },
				status: { embeddable: true },
				liveStreamingDetails: { actualStartTime: 't' },
			}),
		).toBe('live');
		expect(isActuallyLiveVideo({ id: 'a', snippet: { liveBroadcastContent: 'live' }, liveStreamingDetails: { actualStartTime: 't' } })).toBe(true);
		expect(classifyYoutubeVideo({ id: 'a', snippet: { liveBroadcastContent: 'upcoming' }, status: { embeddable: true } })).toBe('upcoming');
		expect(classifyYoutubeVideo({ id: 'a', snippet: { liveBroadcastContent: 'none' }, liveStreamingDetails: { actualEndTime: 't' } })).toBe(
			'completed',
		);
		expect(classifyYoutubeVideo({ id: 'a', status: { privacyStatus: 'private' } })).toBe('private');
		expect(
			classifyYoutubeVideo({
				id: 'a',
				snippet: { liveBroadcastContent: 'live' },
				status: { embeddable: false },
				liveStreamingDetails: { actualStartTime: 't' },
			}),
		).toBe('non_embeddable');
	});
});

describe('quad confirm / discover', () => {
	it('thirty offline normal sources cause zero search.list calls', async () => {
		const store = new MemoryQuadStore();
		for (let i = 0; i < 30; i++) store.addSource(source({ id: `s${i}`, channelId: `UC${i}` }));
		const yt = mockYt(vodHandler());
		await confirmLiveStatuses(store, yt, 'user-1', { force: true });
		await discoverLiveStreams(store, yt, 'user-1', { force: true });
		expect(yt.calls.search).toBe(0);
		expect(yt.searchQueries).toBe(0);
	});

	it('thirty offline sources use about 30 playlistItems calls per discovery', async () => {
		const store = new MemoryQuadStore();
		for (let i = 0; i < 30; i++) store.addSource(source({ id: `s${i}`, channelId: `UC${i}` }));
		const yt = mockYt(vodHandler());
		await discoverLiveStreams(store, yt, 'user-1', { force: true });
		expect(yt.calls.playlistItems).toBe(30);
		expect(yt.calls.playlistItems).toBeLessThanOrEqual(31);
		expect(yt.calls.videos).toBe(5);
		expect(yt.calls.search).toBe(0);
	});

	it('known live and upcoming IDs confirm in one videos.list batch', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', knownLiveVideoId: 'live1', isLive: true }));
		store.addSource(source({ id: 'b', channelId: 'UCb', knownUpcomingVideoId: 'up1' }));
		const yt = mockYt((path, params) => {
			if (path === 'videos') {
				expect(params.id.split(',').sort()).toEqual(['live1', 'up1'].sort());
				return {
					items: [
						{ id: 'live1', snippet: { title: 'L', liveBroadcastContent: 'live' }, status: { embeddable: true }, liveStreamingDetails: { actualStartTime: 't' } },
						{ id: 'up1', snippet: { title: 'U', liveBroadcastContent: 'upcoming' }, status: { embeddable: true } },
					],
				};
			}
			throw new Error(path);
		});
		await confirmLiveStatuses(store, yt, 'user-1', { force: true });
		expect(yt.calls.videos).toBe(1);
		expect(yt.calls.search).toBe(0);
		expect((await store.getSource('user-1', 'a'))?.isLive).toBe(true);
		expect((await store.getSource('user-1', 'b'))?.knownUpcomingVideoId).toBe('up1');
	});

	it('always-on sources do not run discovery while current video remains valid', async () => {
		const store = new MemoryQuadStore();
		store.addSource(
			source({
				id: 'news',
				channelId: 'UCnews',
				sourceMode: 'always_on',
				skipDiscovery: true,
				knownLiveVideoId: '24h',
				isLive: true,
				liveVideoId: '24h',
			}),
		);
		await store.upsertCandidates([
			{ sourceId: 'news', videoId: '24h', title: 'News', status: 'live', embeddable: true, lastCheckedAt: null },
		]);
		const yt = mockYt((path) => {
			if (path === 'videos') {
				return { items: [{ id: '24h', snippet: { title: 'News', liveBroadcastContent: 'live' }, status: { embeddable: true }, liveStreamingDetails: { actualStartTime: 't' } }] };
			}
			if (path === 'playlistItems') throw new Error('should not discover');
			if (path === 'search') throw new Error('should not search');
			return {};
		});
		await confirmLiveStatuses(store, yt, 'user-1', { force: true });
		await discoverLiveStreams(store, yt, 'user-1', { force: true });
		expect(yt.calls.playlistItems).toBe(0);
		expect(yt.calls.search).toBe(0);
	});

	it('failed always-on source checks uploads playlist before search', async () => {
		const store = new MemoryQuadStore();
		store.addSource(
			source({
				id: 'news',
				channelId: 'UCnews',
				sourceMode: 'always_on',
				skipDiscovery: true,
				knownLiveVideoId: 'old',
				isLive: false,
				uploadsPlaylistId: 'UUnews',
			}),
		);
		const order: string[] = [];
		const yt = mockYt((path, params) => {
			order.push(path);
			if (path === 'videos') {
				const ids = (params.id ?? '').split(',').filter(Boolean);
				return {
					items: ids.map((id) =>
						id === 'newlive'
							? { id, snippet: { title: 'Now', liveBroadcastContent: 'live' }, status: { embeddable: true }, liveStreamingDetails: { actualStartTime: 't' } }
							: {
									id,
									snippet: { liveBroadcastContent: 'none' },
									status: { embeddable: true },
									liveStreamingDetails: { actualEndTime: 'x' },
								},
					),
				};
			}
			if (path === 'playlistItems') return { items: [{ contentDetails: { videoId: 'newlive' } }] };
			if (path === 'search') throw new Error('search should not run when playlist recovers');
			return {};
		});
		await recoverLiveSource(store, yt, 'user-1', 'news');
		expect(order[0]).toBe('playlistItems');
		expect(order).toContain('videos');
		expect((await store.getSource('user-1', 'news'))?.knownLiveVideoId).toBe('newlive');
	});

	it('on-demand sources are not polled automatically', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'od', channelId: 'UCod', sourceMode: 'on_demand', knownLiveVideoId: 'x' }));
		const yt = mockYt(() => {
			throw new Error('no calls');
		});
		await confirmLiveStatuses(store, yt, 'user-1', { force: true });
		await discoverLiveStreams(store, yt, 'user-1', { force: true });
		expect(yt.quotaUsed).toBe(0);
	});

	it('disabled sources generate no requests', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'off', channelId: 'UCoff', sourceMode: 'disabled', enabled: false, knownLiveVideoId: 'x' }));
		const yt = mockYt(() => {
			throw new Error('no calls');
		});
		await confirmLiveStatuses(store, yt, 'user-1', { force: true });
		await discoverLiveStreams(store, yt, 'user-1', { force: true });
		expect(yt.quotaUsed).toBe(0);
	});

	it('repeated clicks and overlapping jobs share one lock', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', knownLiveVideoId: 'v1', isLive: true }));
		const yt = mockYt((path) => {
			if (path === 'videos') {
				return { items: [{ id: 'v1', snippet: { liveBroadcastContent: 'live' }, status: { embeddable: true }, liveStreamingDetails: { actualStartTime: 't' } }] };
			}
			return {};
		}, 40);
		const [first, second] = await Promise.all([
			confirmLiveStatuses(store, yt, 'user-1', { force: true }),
			confirmLiveStatuses(store, yt, 'user-1', { force: true }),
		]);
		const cached = [first, second].filter((r) => r.cached || r.inProgress);
		expect(cached.length).toBeGreaterThanOrEqual(1);
		expect(yt.calls.videos).toBe(1);
	});

	it('enforces search cooldown and daily allowance', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', sourceMode: 'always_on', skipDiscovery: true, knownLiveVideoId: 'dead' }));
		const yt = mockYt((path) => {
			if (path === 'videos') return { items: [] };
			if (path === 'playlistItems') return { items: [] };
			if (path === 'search') return { items: [] };
			if (path === 'channels') return { items: [] };
			return {};
		});
		await recoverLiveSource(store, yt, 'user-1', 'a');
		expect(yt.calls.search).toBe(1);
		const after = yt.calls.search;
		await recoverLiveSource(store, yt, 'user-1', 'a');
		expect(yt.calls.search).toBe(after);

		store.budget.used = QUAD_SEARCH_DAILY_ALLOWANCE;
		store.budget.day = new Date().toISOString().slice(0, 10);
		store.sources.get('a')!.searchCooldownUntil = null;
		const yt2 = mockYt((path) => {
			if (path === 'search') throw new Error('over budget');
			if (path === 'videos') return { items: [] };
			if (path === 'playlistItems') return { items: [] };
			return {};
		});
		await recoverLiveSource(store, yt2, 'user-1', 'a');
		expect(yt2.calls.search).toBe(0);
	});

	it('collectConfirmIds skips disabled sources', () => {
		const ids = collectConfirmIds(
			[source({ id: 'off', channelId: 'x', sourceMode: 'disabled', knownLiveVideoId: 'nope' })],
			[{ sourceId: 'off', videoId: 'nope' }],
			[],
		);
		expect(ids.size).toBe(0);
	});

	it('category refresh skips always-on and disabled sources', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'chase', channelId: 'UCc' }));
		store.addSource(source({ id: 'news', channelId: 'UCn', sourceMode: 'always_on', skipDiscovery: true, knownLiveVideoId: 'n1', isLive: true }));
		store.addSource(source({ id: 'off', channelId: 'UCo', sourceMode: 'disabled', enabled: false }));
		const yt = mockYt(vodHandler());
		await discoverLiveStreams(store, yt, 'user-1', { sourceIds: ['chase', 'news', 'off'] });
		expect(yt.calls.playlistItems).toBe(1);
		expect(yt.calls.search).toBe(0);
	});
});

describe('feed isolation', () => {
	it('does not mention Feed tables in Quad refresh', () => {
		const refresh = readFileSync(new URL('../../worker/services/quadRefresh.ts', import.meta.url), 'utf8');
		const store = readFileSync(new URL('../../worker/db/quadStore.ts', import.meta.url), 'utf8');
		const mig = readFileSync(new URL('../../migrations/0010_quad_live_status.sql', import.meta.url), 'utf8');
		for (const text of [refresh, store, mig]) {
			expect(text).not.toMatch(/\binbox_state\b/);
			expect(text).not.toMatch(/\bwatchlists\b/);
			expect(text).not.toMatch(/\bsync_runs\b/);
			expect(text).not.toMatch(/INSERT INTO videos/);
			expect(text).not.toMatch(/UPDATE videos/);
			expect(text).not.toMatch(/UPDATE inbox_state/);
		}
	});

	it('Feed sync does not mention Quad live tables', () => {
		const sync = readFileSync(new URL('../../worker/services/sync.ts', import.meta.url), 'utf8');
		expect(sync).not.toMatch(/live_sources/);
		expect(sync).not.toMatch(/live_source_videos/);
		expect(sync).not.toMatch(/live_quad_/);
		expect(sync).not.toMatch(/live_slots/);
	});

	it('migration 0010 is Quad-only', () => {
		const mig = readFileSync(new URL('../../migrations/0010_quad_live_status.sql', import.meta.url), 'utf8');
		expect(mig).toMatch(/live_sources/);
		expect(mig).toMatch(/live_quad_jobs/);
		expect(mig).not.toMatch(/ALTER TABLE videos/);
		expect(mig).not.toMatch(/ALTER TABLE inbox_state/);
		expect(mig).not.toMatch(/ALTER TABLE channels /);
		expect(mig).not.toMatch(/ALTER TABLE settings/);
	});
});
