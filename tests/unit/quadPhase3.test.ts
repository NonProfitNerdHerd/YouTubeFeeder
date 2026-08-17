import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatQuadJobStatus } from '../../src/lib/quadStatus';
import { clampConfirmMs, clampDiscoveryMs, QUAD_MIN_CONFIRM_MS, QUAD_MIN_DISCOVERY_MS } from '../../worker/services/quadClassify';
import { MemoryQuadStore, source } from './helpers/memoryQuadStore';
import { confirmLiveStatuses, discoverLiveStreams } from '../../worker/services/quadRefresh';
import type { YoutubeClient } from '../../worker/services/youtube';

function mockYt(handler: (path: string, params: Record<string, string>) => unknown): YoutubeClient {
	return {
		quotaUsed: 0,
		searchQueries: 0,
		calls: { search: 0, videos: 0, playlistItems: 0, channels: 0, subscriptions: 0, other: 0 },
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
			}
			return handler(path, params) as never;
		},
	};
}

describe('quad phase 3 intervals and UI copy', () => {
	it('clamps status to 5 minutes and discovery to 15 minutes', () => {
		expect(clampConfirmMs(60)).toBe(QUAD_MIN_CONFIRM_MS);
		expect(clampDiscoveryMs(60)).toBe(QUAD_MIN_DISCOVERY_MS);
	});

	it('Refresh Statuses does not run discovery', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', knownLiveVideoId: 'v1', isLive: true }));
		const yt = mockYt((path) => {
			if (path === 'playlistItems') throw new Error('discovery');
			if (path === 'search') throw new Error('search');
			if (path === 'videos') return { items: [{ id: 'v1', snippet: { liveBroadcastContent: 'live' }, status: { embeddable: true }, liveStreamingDetails: { actualStartTime: 't' } }] };
			return {};
		});
		await confirmLiveStatuses(store, yt, 'user-1');
		expect(yt.calls.playlistItems).toBe(0);
		expect(yt.calls.search).toBe(0);
	});

	it('Discover respects 15-minute cache', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', nextDiscoveryAt: new Date(Date.now() + 60_000).toISOString() }));
		const yt = mockYt(() => {
			throw new Error('should cache');
		});
		const result = await discoverLiveStreams(store, yt, 'user-1', { force: true });
		expect(result.cached).toBe(true);
		expect(yt.calls.playlistItems).toBe(0);
	});

	it('formats duplicate and cached job status', () => {
		expect(formatQuadJobStatus({ duplicatePrevented: true, inProgress: true })).toMatch(/Duplicate/);
		expect(formatQuadJobStatus({ cached: true, cacheHit: true })).toMatch(/Cached/);
	});

	it('on-demand and disabled are not scheduled', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'od', channelId: 'UCod', sourceMode: 'on_demand' }));
		store.addSource(source({ id: 'off', channelId: 'UCoff', sourceMode: 'disabled', enabled: false }));
		const yt = mockYt(() => {
			throw new Error('no poll');
		});
		await confirmLiveStatuses(store, yt, 'user-1', { scheduled: true });
		await discoverLiveStreams(store, yt, 'user-1', { scheduled: true });
		expect(yt.quotaUsed).toBe(0);
	});

	it('Feed sync source still has no Quad tables', () => {
		const sync = readFileSync(new URL('../../worker/services/sync.ts', import.meta.url), 'utf8');
		expect(sync).not.toMatch(/live_quad_settings/);
		expect(sync).not.toMatch(/runScheduledQuadRefresh/);
	});

	it('scheduled handler runs Feed and Quad in separate waitUntil blocks', () => {
		const index = readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
		expect(index).toMatch(/runFeedMaintenance/);
		expect(index).toMatch(/runScheduledQuadRefresh/);
		expect(index).not.toMatch(/continueCronContent/);
		const scheduled = index.slice(index.indexOf('async scheduled'));
		expect(scheduled.split('ctx.waitUntil').length).toBe(3);
	});

	it('Quad settings live in live_quad_settings not Feed settings', () => {
		const sql = readFileSync(new URL('../../migrations/0011_quad_settings.sql', import.meta.url), 'utf8');
		expect(sql).toMatch(/live_quad_settings/);
		expect(sql).not.toMatch(/ALTER TABLE settings/);
	});
});
