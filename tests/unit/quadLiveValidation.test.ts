import { describe, expect, it } from 'vitest';
import { classifyYoutubeVideo, isActuallyLiveVideo } from '../../worker/services/quadClassify';
import { MemoryQuadStore, source } from './helpers/memoryQuadStore';
import { confirmLiveStatuses, discoverLiveStreams, recoverLiveSource } from '../../worker/services/quadRefresh';
import type { YoutubeClient } from '../../worker/services/youtube';

function liveItem(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		snippet: { title: id, liveBroadcastContent: 'live' },
		status: { embeddable: true },
		liveStreamingDetails: { actualStartTime: '2026-01-01T00:00:00Z' },
		...extra,
	};
}

function mockYt(handler: (path: string, params: Record<string, string>) => unknown): YoutubeClient {
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
			return handler(path, params) as never;
		},
	};
}

describe('isActuallyLiveVideo', () => {
	it('excludes completed livestream archives whose titles say LIVE', () => {
		const video = {
			id: 'arch',
			snippet: { title: 'LIVE: Dangerous Tornado Threat', liveBroadcastContent: 'none' as const },
			liveStreamingDetails: { actualStartTime: 't', actualEndTime: 'e' },
			status: { embeddable: true },
		};
		expect(isActuallyLiveVideo(video)).toBe(false);
		expect(classifyYoutubeVideo(video)).toBe('completed');
	});

	it('excludes normal uploads titled Live Stream', () => {
		const video = {
			id: 'vod',
			snippet: { title: 'Live Stream', liveBroadcastContent: 'none' as const },
			status: { embeddable: true },
		};
		expect(isActuallyLiveVideo(video)).toBe(false);
		expect(classifyYoutubeVideo(video)).toBe('completed');
	});

	it('includes current active livestreams', () => {
		const video = liveItem('now');
		expect(isActuallyLiveVideo(video)).toBe(true);
		expect(classifyYoutubeVideo(video)).toBe('live');
	});

	it('classifies upcoming separately and not as live', () => {
		const video = {
			id: 'soon',
			snippet: { liveBroadcastContent: 'upcoming' as const },
			liveStreamingDetails: { scheduledStartTime: 'soon' },
			status: { embeddable: true },
		};
		expect(isActuallyLiveVideo(video)).toBe(false);
		expect(classifyYoutubeVideo(video)).toBe('upcoming');
	});

	it('includes live streams with no chat id and no concurrentViewers', () => {
		const video = liveItem('cam');
		expect(isActuallyLiveVideo(video)).toBe(true);
	});
});

describe('verified live set', () => {
	it('keeps 19 simultaneous live videos from one channel', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'harbor', channelId: 'UCh' }));
		const ids = Array.from({ length: 19 }, (_, i) => `cam${i}`);
		const yt = mockYt((path) => {
			if (path === 'playlistItems') return { items: ids.map((id) => ({ contentDetails: { videoId: id } })) };
			if (path === 'videos') {
				return { items: ids.map((id) => liveItem(id)) };
			}
			return { items: [] };
		});
		await discoverLiveStreams(store, yt, 'user-1');
		const live = (await store.listCandidates(['harbor'])).filter((r) => r.status === 'live');
		expect(live).toHaveLength(19);
		expect(new Set(live.map((r) => r.videoId)).size).toBe(19);
		expect((await store.getSource('user-1', 'harbor'))?.isLive).toBe(true);
	});

	it('mixed channel results count only the two currently live videos', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'copic', channelId: 'UCc' }));
		const ids = ['live1', 'live2', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
		const yt = mockYt((path) => {
			if (path === 'playlistItems') return { items: ids.map((id) => ({ contentDetails: { videoId: id } })) };
			if (path === 'videos') {
				return {
					items: ids.map((id) =>
						id.startsWith('live')
							? liveItem(id)
							: {
									id,
									snippet: { title: 'LIVE Stream Archive', liveBroadcastContent: 'none' },
									status: { embeddable: true },
									liveStreamingDetails: { actualStartTime: 't', actualEndTime: 'e' },
								},
					),
				};
			}
			return { items: [] };
		});
		await discoverLiveStreams(store, yt, 'user-1');
		const rows = await store.listCandidates(['copic']);
		expect(rows.filter((r) => r.status === 'live')).toHaveLength(2);
		expect(rows.filter((r) => r.status === 'completed')).toHaveLength(0);
	});

	it('recovery replaces eight cached archives with two verified live videos', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'copic', channelId: 'UCc', isLive: true }));
		for (let i = 0; i < 8; i++) {
			store.candidates.set(`copic:old${i}`, {
				sourceId: 'copic',
				videoId: `old${i}`,
				title: 'LIVE Stream Archive',
				status: 'live',
				embeddable: true,
				lastCheckedAt: null,
			});
		}
		const yt = mockYt((path) => {
			if (path === 'playlistItems') return { items: [{ contentDetails: { videoId: 'n1' } }, { contentDetails: { videoId: 'n2' } }] };
			if (path === 'videos') {
				return { items: [liveItem('n1'), liveItem('n2')] };
			}
			if (path === 'search') throw new Error('search');
			return { items: [] };
		});
		await recoverLiveSource(store, yt, 'user-1', 'copic');
		const rows = await store.listCandidates(['copic']);
		expect(rows.map((r) => r.videoId).sort()).toEqual(['n1', 'n2']);
		expect(rows.every((r) => r.status === 'live')).toBe(true);
	});

	it('successful refresh with no live results marks the channel offline', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', knownLiveVideoId: 'old', isLive: true }));
		store.candidates.set('a:old', {
			sourceId: 'a',
			videoId: 'old',
			title: 'LIVE',
			status: 'live',
			embeddable: true,
			lastCheckedAt: null,
		});
		const yt = mockYt((path) => {
			if (path === 'videos') {
				return {
					items: [
						{
							id: 'old',
							snippet: { title: 'LIVE Stream Archive', liveBroadcastContent: 'none' },
							status: { embeddable: true },
							liveStreamingDetails: { actualStartTime: 't', actualEndTime: 'e' },
						},
					],
				};
			}
			return { items: [] };
		});
		await confirmLiveStatuses(store, yt, 'user-1');
		const src = await store.getSource('user-1', 'a');
		expect(src?.isLive).toBe(false);
		expect(await store.listCandidates(['a'])).toHaveLength(0);
	});

	it('API failure marks unknown/error and does not classify archives as live', async () => {
		const store = new MemoryQuadStore();
		store.addSource(source({ id: 'a', channelId: 'UCa', knownLiveVideoId: 'old', isLive: false, verifyState: 'ok' }));
		const yt = mockYt(() => {
			throw new Error('network');
		});
		const result = await confirmLiveStatuses(store, yt, 'user-1');
		expect(result.error).toBe('network');
		const src = await store.getSource('user-1', 'a');
		expect(src?.verifyState).toBe('error');
		expect(src?.isLive).toBe(false);
		expect(await store.listCandidates(['a'])).toHaveLength(0);
	});
});
