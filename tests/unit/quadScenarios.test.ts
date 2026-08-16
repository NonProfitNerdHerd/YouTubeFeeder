import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryQuadStore, source } from './helpers/memoryQuadStore';
import { confirmLiveStatuses, discoverLiveStreams, recoverLiveSource } from '../../worker/services/quadRefresh';
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

describe('Quad simulated API-call scenarios', () => {
	it('Scenario 1: 30 offline normals — ~30 playlistItems, batched videos, zero search', async () => {
		const store = new MemoryQuadStore();
		for (let i = 0; i < 30; i++) store.addSource(source({ id: `s${i}`, channelId: `UC${i}` }));
		const yt = mockYt((path, params) => {
			if (path === 'playlistItems') {
				return { items: [{ contentDetails: { videoId: `new_${params.playlistId}` } }] };
			}
			if (path === 'videos') {
				const ids = (params.id ?? '').split(',').filter(Boolean);
				return {
					items: ids.map((id) => ({
						id,
						snippet: { liveBroadcastContent: 'none' },
						status: { embeddable: true },
					})),
				};
			}
			if (path === 'search') throw new Error('search.list not allowed');
			return { items: [] };
		});
		await discoverLiveStreams(store, yt, 'user-1');
		expect(yt.calls.search).toBe(0);
		expect(yt.calls.playlistItems).toBe(30);
		expect(yt.calls.videos).toBe(1);
	});

	it('Scenario 2: 5 live chasers — one videos.list, no search, no discovery if cached', async () => {
		const store = new MemoryQuadStore();
		const future = new Date(Date.now() + 14 * 60 * 1000).toISOString();
		for (let i = 0; i < 5; i++) {
			store.addSource(
				source({
					id: `l${i}`,
					channelId: `UCl${i}`,
					knownLiveVideoId: `live${i}`,
					isLive: true,
					nextDiscoveryAt: future,
				}),
			);
		}
		const yt = mockYt((path, params) => {
			if (path === 'videos') {
				const ids = (params.id ?? '').split(',').filter(Boolean);
				expect(ids).toHaveLength(5);
				return {
					items: ids.map((id) => ({
						id,
						snippet: { liveBroadcastContent: 'live' },
						liveStreamingDetails: { actualStartTime: 't' },
						status: { embeddable: true },
					})),
				};
			}
			if (path === 'playlistItems' || path === 'search') throw new Error(path);
			return {};
		});
		await confirmLiveStatuses(store, yt, 'user-1');
		await discoverLiveStreams(store, yt, 'user-1');
		expect(yt.calls.videos).toBe(1);
		expect(yt.calls.playlistItems).toBe(0);
		expect(yt.calls.search).toBe(0);
	});

	it('Scenario 3: 10 always-on still live — one videos.list, zero playlist, zero search', async () => {
		const store = new MemoryQuadStore();
		for (let i = 0; i < 10; i++) {
			store.addSource(
				source({
					id: `n${i}`,
					channelId: `UCn${i}`,
					sourceMode: 'always_on',
					skipDiscovery: true,
					knownLiveVideoId: `news${i}`,
					isLive: true,
					liveVideoId: `news${i}`,
				}),
			);
		}
		const yt = mockYt((path, params) => {
			if (path === 'videos') {
				expect(params.id.split(',')).toHaveLength(10);
				return {
					items: params.id.split(',').map((id) => ({
						id,
						snippet: { liveBroadcastContent: 'live' },
						liveStreamingDetails: { actualStartTime: 't' },
						status: { embeddable: true },
					})),
				};
			}
			if (path === 'playlistItems' || path === 'search') throw new Error(path);
			return {};
		});
		await confirmLiveStatuses(store, yt, 'user-1');
		await discoverLiveStreams(store, yt, 'user-1');
		expect(yt.calls.videos).toBe(1);
		expect(yt.calls.playlistItems).toBe(0);
		expect(yt.calls.search).toBe(0);
	});

	it('Scenario 4: always-on ends — confirm, playlist, no search if replacement found', async () => {
		const store = new MemoryQuadStore();
		store.addSource(
			source({
				id: 'news',
				channelId: 'UCnews',
				sourceMode: 'always_on',
				skipDiscovery: true,
				knownLiveVideoId: 'old',
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
						id === 'fresh'
							? { id, snippet: { liveBroadcastContent: 'live' },
						liveStreamingDetails: { actualStartTime: 't' }, status: { embeddable: true } }
							: {
									id,
									snippet: { liveBroadcastContent: 'none' },
									status: { embeddable: true },
									liveStreamingDetails: { actualEndTime: 'x' },
								},
					),
				};
			}
			if (path === 'playlistItems') return { items: [{ contentDetails: { videoId: 'fresh' } }] };
			if (path === 'search') throw new Error('search should not run');
			return {};
		});
		await recoverLiveSource(store, yt, 'user-1', 'news');
		expect(order[0]).toBe('playlistItems');
		expect(order).toContain('videos');
		expect(yt.calls.search).toBe(0);
		expect((await store.getSource('user-1', 'news'))?.knownLiveVideoId).toBe('fresh');
	});

	it('Scenario 5: ten repeated refresh clicks — one YouTube job', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', knownLiveVideoId: 'v1', isLive: true }));
		const yt = mockYt((path) => {
			if (path === 'videos') {
				return { items: [{ id: 'v1', snippet: { liveBroadcastContent: 'live' },
						liveStreamingDetails: { actualStartTime: 't' }, status: { embeddable: true } }] };
			}
			return {};
		}, 30);
		const results = await Promise.all(Array.from({ length: 10 }, () => confirmLiveStatuses(store, yt, 'user-1')));
		expect(yt.calls.videos).toBe(1);
		expect(results.filter((r) => r.cached || r.inProgress || r.duplicatePrevented).length).toBeGreaterThanOrEqual(9);
	});

	it('Scenario 6: multiple tabs share one videos.list', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', knownLiveVideoId: 'v1', isLive: true }));
		const yt = mockYt((path) => {
			if (path === 'videos') {
				return { items: [{ id: 'v1', snippet: { liveBroadcastContent: 'live' },
						liveStreamingDetails: { actualStartTime: 't' }, status: { embeddable: true } }] };
			}
			return {};
		}, 25);
		await Promise.all([confirmLiveStatuses(store, yt, 'user-1'), confirmLiveStatuses(store, yt, 'user-1')]);
		expect(yt.calls.videos).toBe(1);
	});

	it('Scenario 7: on-demand — no scheduled calls; recover uses playlist then videos, not search', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'od', channelId: 'UCod', sourceMode: 'on_demand', knownLiveVideoId: 'x' }));
		const yt = mockYt((path) => {
			if (path === 'playlistItems') return { items: [{ contentDetails: { videoId: 'x' } }] };
			if (path === 'videos') {
				return { items: [{ id: 'x', snippet: { liveBroadcastContent: 'none' }, status: { embeddable: true } }] };
			}
			if (path === 'search') throw new Error('search');
			return {};
		});
		await confirmLiveStatuses(store, yt, 'user-1', { scheduled: true });
		await discoverLiveStreams(store, yt, 'user-1', { scheduled: true });
		expect(yt.quotaUsed).toBe(0);
		await recoverLiveSource(store, yt, 'user-1', 'od');
		expect(yt.calls.playlistItems).toBe(1);
		expect(yt.calls.videos).toBe(1);
		expect(yt.calls.search).toBe(0);
	});

	it('Scenario 9: Feed sync and Quad refresh stay isolated', () => {
		const index = readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
		expect(index).toContain('runScheduledQuadRefresh');
		expect(index).toContain('syncContent');
		const scheduled = index.slice(index.indexOf('async scheduled'));
		expect(scheduled.indexOf('syncContent')).toBeGreaterThan(-1);
		expect(scheduled.indexOf('runScheduledQuadRefresh')).toBeGreaterThan(scheduled.indexOf('syncContent'));
		const refresh = readFileSync(new URL('../../worker/services/quadRefresh.ts', import.meta.url), 'utf8');
		expect(refresh).toContain("withLock(store, userId, 'confirm'");
		expect(refresh).toContain("withLock(store, userId, 'discover'");
		expect(refresh).toContain("withLock(store, userId, 'recover'");
		expect(refresh).not.toContain('sync_runs');
		const sync = readFileSync(new URL('../../worker/services/sync.ts', import.meta.url), 'utf8');
		expect(sync).toContain('sync_runs');
		expect(sync).not.toContain('live_quad_jobs');
	});

	it('Scenario 8: disabled source — zero API calls', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'off', channelId: 'UCoff', sourceMode: 'disabled', enabled: false, knownLiveVideoId: 'z' }));
		const yt = mockYt(() => {
			throw new Error('no calls');
		});
		await confirmLiveStatuses(store, yt, 'user-1');
		await discoverLiveStreams(store, yt, 'user-1');
		expect(yt.quotaUsed).toBe(0);
	});
});
