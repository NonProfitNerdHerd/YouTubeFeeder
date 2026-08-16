import type { QuadCandidateRow, QuadJobRow, QuadSlotRow, QuadSourceRow, QuadStore, QuadSourcePatch } from '../../worker/db/quadStore';

function modeFlags(mode: QuadSourceRow['sourceMode']): { enabled: boolean; skipDiscovery: boolean } {
	if (mode === 'disabled') return { enabled: false, skipDiscovery: false };
	if (mode === 'always_on') return { enabled: true, skipDiscovery: true };
	return { enabled: true, skipDiscovery: false };
}

export class MemoryQuadStore implements QuadStore {
	sources = new Map<string, QuadSourceRow>();
	candidates = new Map<string, QuadCandidateRow>();
	slots: QuadSlotRow[] = [];
	jobs = new Map<string, QuadJobRow>();
	budget = { day: '', used: 0 };
	sqlLog: string[] = [];

	constructor(public userId = 'user-1') {}

	addSource(row: QuadSourceRow) {
		this.sources.set(row.id, row);
	}

	async listSources(userId: string) {
		return [...this.sources.values()].filter((s) => s.userId === userId);
	}
	async getSource(userId: string, id: string) {
		const row = this.sources.get(id);
		return row?.userId === userId ? row : null;
	}
	async listSlots() {
		return this.slots;
	}
	async listCandidates(sourceIds: string[]) {
		return [...this.candidates.values()].filter((c) => sourceIds.includes(c.sourceId));
	}
	async upsertCandidates(rows: QuadCandidateRow[]) {
		for (const row of rows) this.candidates.set(`${row.sourceId}:${row.videoId}`, row);
	}
	async replaceSourceCandidates(sourceId: string, rows: QuadCandidateRow[]) {
		for (const key of [...this.candidates.keys()]) {
			if (key.startsWith(`${sourceId}:`)) this.candidates.delete(key);
		}
		await this.upsertCandidates(rows);
	}
	async clearSourceCandidates(sourceId: string) {
		await this.replaceSourceCandidates(sourceId, []);
	}
	async patchSource(userId: string, id: string, patch: QuadSourcePatch) {
		const current = await this.getSource(userId, id);
		if (!current) return;
		const next = { ...current, ...patch };
		if (patch.sourceMode) {
			const flags = modeFlags(patch.sourceMode);
			next.enabled = flags.enabled;
			next.skipDiscovery = flags.skipDiscovery;
		}
		this.sources.set(id, next);
	}
	async tryLock(userId: string, job: string, holder: string, expiresAt: string, nowIso: string) {
		const key = `${userId}:${job}`;
		const existing = this.jobs.get(key);
		if (existing?.status === 'running' && existing.expiresAt && existing.expiresAt >= nowIso) return false;
		this.jobs.set(key, { job, holder, expiresAt, status: 'running', resultJson: existing?.resultJson ?? null });
		return true;
	}
	async finishLock(userId: string, job: string, resultJson: string, nowIso: string) {
		const key = `${userId}:${job}`;
		this.jobs.set(key, { job, holder: null, expiresAt: nowIso, status: 'done', resultJson });
	}
	async getLock(userId: string, job: string) {
		return this.jobs.get(`${userId}:${job}`) ?? null;
	}
	async searchUsed(_userId: string, day: string) {
		return this.budget.day === day ? this.budget.used : 0;
	}
	async addSearchUse(_userId: string, day: string, n: number) {
		const base = this.budget.day === day ? this.budget.used : 0;
		this.budget = { day, used: base + n };
		return this.budget.used;
	}
}

export function source(partial: Partial<QuadSourceRow> & Pick<QuadSourceRow, 'id' | 'channelId'>): QuadSourceRow {
	return {
		userId: 'user-1',
		displayName: partial.id,
		youtubeUrl: `https://www.youtube.com/channel/${partial.channelId}`,
		notes: '',
		enabled: true,
		skipDiscovery: false,
		sourceMode: 'normal',
		uploadsPlaylistId: `UU_${partial.channelId}`,
		knownLiveVideoId: null,
		knownUpcomingVideoId: null,
		isLive: false,
		liveVideoId: null,
		liveTitle: null,
		liveCheckedAt: null,
		lastStatusCheckAt: null,
		lastDiscoveryAt: null,
		nextStatusCheckAt: null,
		nextDiscoveryAt: null,
		lastLiveAt: null,
		consecutiveOfflineChecks: 0,
		searchCooldownUntil: null,
		lastPlayerErrorAt: null,
		verifyState: 'ok',
		verifyError: null,
		...partial,
	};
}
