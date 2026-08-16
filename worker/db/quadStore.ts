import type { LiveSourceMode, QuadVideoStatus } from '../services/quadClassify';
import { modeFlags, resolveSourceMode } from '../services/quadClassify';
import { utcDay } from '../services/quadClassify';

export interface QuadSourceRow {
	id: string;
	userId: string;
	displayName: string;
	channelId: string;
	youtubeUrl: string;
	notes: string;
	enabled: boolean;
	skipDiscovery: boolean;
	sourceMode: LiveSourceMode;
	uploadsPlaylistId: string | null;
	knownLiveVideoId: string | null;
	knownUpcomingVideoId: string | null;
	isLive: boolean;
	liveVideoId: string | null;
	liveTitle: string | null;
	liveCheckedAt: string | null;
	lastStatusCheckAt: string | null;
	lastDiscoveryAt: string | null;
	nextStatusCheckAt: string | null;
	nextDiscoveryAt: string | null;
	lastLiveAt: string | null;
	consecutiveOfflineChecks: number;
	searchCooldownUntil: string | null;
	lastPlayerErrorAt: string | null;
	verifyState: 'ok' | 'error';
	verifyError: string | null;
}

export interface QuadCandidateRow {
	sourceId: string;
	videoId: string;
	title: string;
	status: QuadVideoStatus;
	embeddable: boolean;
	lastCheckedAt: string | null;
}

export interface QuadSlotRow {
	slotNumber: number;
	sourceId: string | null;
	videoId: string | null;
}

export interface QuadJobRow {
	job: string;
	holder: string | null;
	expiresAt: string | null;
	status: string;
	resultJson: string | null;
}

export interface QuadSourcePatch {
	uploadsPlaylistId?: string | null;
	knownLiveVideoId?: string | null;
	knownUpcomingVideoId?: string | null;
	isLive?: boolean;
	liveVideoId?: string | null;
	liveTitle?: string | null;
	liveCheckedAt?: string | null;
	lastStatusCheckAt?: string | null;
	lastDiscoveryAt?: string | null;
	nextStatusCheckAt?: string | null;
	nextDiscoveryAt?: string | null;
	lastLiveAt?: string | null;
	consecutiveOfflineChecks?: number;
	searchCooldownUntil?: string | null;
	lastPlayerErrorAt?: string | null;
	verifyState?: 'ok' | 'error';
	verifyError?: string | null;
	sourceMode?: LiveSourceMode;
	enabled?: boolean;
	skipDiscovery?: boolean;
}

export interface QuadStore {
	listSources(userId: string): Promise<QuadSourceRow[]>;
	getSource(userId: string, id: string): Promise<QuadSourceRow | null>;
	listSlots(userId: string): Promise<QuadSlotRow[]>;
	listCandidates(sourceIds: string[]): Promise<QuadCandidateRow[]>;
	upsertCandidates(rows: QuadCandidateRow[]): Promise<void>;
	replaceSourceCandidates(sourceId: string, rows: QuadCandidateRow[]): Promise<void>;
	clearSourceCandidates(sourceId: string): Promise<void>;
	patchSource(userId: string, id: string, patch: QuadSourcePatch): Promise<void>;
	tryLock(userId: string, job: string, holder: string, expiresAt: string, nowIso: string): Promise<boolean>;
	finishLock(userId: string, job: string, resultJson: string, nowIso: string): Promise<void>;
	getLock(userId: string, job: string): Promise<QuadJobRow | null>;
	searchUsed(userId: string, day: string): Promise<number>;
	addSearchUse(userId: string, day: string, n: number): Promise<number>;
}

function mapSource(row: Record<string, unknown>): QuadSourceRow {
	const enabled = Number(row.enabled) === 1;
	const skipDiscovery = Number(row.skip_discovery) === 1;
	const sourceMode = resolveSourceMode({
		enabled,
		skipDiscovery,
		sourceMode: typeof row.source_mode === 'string' ? row.source_mode : null,
	});
	return {
		id: String(row.id),
		userId: String(row.user_id),
		displayName: String(row.display_name),
		channelId: String(row.channel_id),
		youtubeUrl: String(row.youtube_url),
		notes: String(row.notes ?? ''),
		enabled,
		skipDiscovery,
		sourceMode,
		uploadsPlaylistId: (row.uploads_playlist_id as string | null) ?? null,
		knownLiveVideoId: (row.known_live_video_id as string | null) ?? (row.live_video_id as string | null) ?? null,
		knownUpcomingVideoId: (row.known_upcoming_video_id as string | null) ?? null,
		isLive: Number(row.is_live) === 1,
		liveVideoId: (row.live_video_id as string | null) ?? null,
		liveTitle: (row.live_title as string | null) ?? null,
		liveCheckedAt: (row.live_checked_at as string | null) ?? null,
		lastStatusCheckAt: (row.last_status_check_at as string | null) ?? null,
		lastDiscoveryAt: (row.last_discovery_at as string | null) ?? null,
		nextStatusCheckAt: (row.next_status_check_at as string | null) ?? null,
		nextDiscoveryAt: (row.next_discovery_at as string | null) ?? null,
		lastLiveAt: (row.last_live_at as string | null) ?? null,
		consecutiveOfflineChecks: Number(row.consecutive_offline_checks ?? 0),
		searchCooldownUntil: (row.search_cooldown_until as string | null) ?? null,
		lastPlayerErrorAt: (row.last_player_error_at as string | null) ?? null,
		verifyState: row.verify_state === 'error' ? 'error' : 'ok',
		verifyError: (row.verify_error as string | null) ?? null,
	};
}

const SOURCE_COLS = `id, user_id, display_name, channel_id, youtube_url, notes, enabled, skip_discovery,
	source_mode, uploads_playlist_id, known_live_video_id, known_upcoming_video_id,
	is_live, live_video_id, live_title, live_checked_at,
	last_status_check_at, last_discovery_at, next_status_check_at, next_discovery_at,
	last_live_at, consecutive_offline_checks, search_cooldown_until, last_player_error_at, verify_state, verify_error`;

export function d1QuadStore(db: D1Database): QuadStore {
	return {
		async listSources(userId) {
			const rows = await db.prepare(`SELECT ${SOURCE_COLS} FROM live_sources WHERE user_id = ?`).bind(userId).all();
			return (rows.results ?? []).map((row) => mapSource(row as Record<string, unknown>));
		},
		async getSource(userId, id) {
			const row = await db.prepare(`SELECT ${SOURCE_COLS} FROM live_sources WHERE user_id = ? AND id = ?`).bind(userId, id).first();
			return row ? mapSource(row as Record<string, unknown>) : null;
		},
		async listSlots(userId) {
			const rows = await db
				.prepare(`SELECT slot_number, source_id, video_id FROM live_slots WHERE user_id = ?`)
				.bind(userId)
				.all<{ slot_number: number; source_id: string | null; video_id: string | null }>();
			return (rows.results ?? []).map((row) => ({
				slotNumber: row.slot_number,
				sourceId: row.source_id,
				videoId: row.video_id,
			}));
		},
		async listCandidates(sourceIds) {
			if (!sourceIds.length) return [];
			const rows = await db
				.prepare(
					`SELECT source_id, video_id, title, status, embeddable, last_checked_at
					 FROM live_source_videos WHERE source_id IN (${sourceIds.map(() => '?').join(',')})`,
				)
				.bind(...sourceIds)
				.all<{
					source_id: string;
					video_id: string;
					title: string;
					status: string;
					embeddable: number;
					last_checked_at: string | null;
				}>();
			return (rows.results ?? []).map((row) => ({
				sourceId: row.source_id,
				videoId: row.video_id,
				title: row.title,
				status: row.status as QuadVideoStatus,
				embeddable: row.embeddable !== 0,
				lastCheckedAt: row.last_checked_at,
			}));
		},
		async upsertCandidates(rows) {
			if (!rows.length) return;
			await db.batch(
				rows.map((row) =>
					db
						.prepare(
							`INSERT INTO live_source_videos (source_id, video_id, title, status, embeddable, last_checked_at)
							 VALUES (?, ?, ?, ?, ?, ?)
							 ON CONFLICT(source_id, video_id) DO UPDATE SET
								title = excluded.title,
								status = excluded.status,
								embeddable = excluded.embeddable,
								last_checked_at = excluded.last_checked_at`,
						)
						.bind(row.sourceId, row.videoId, row.title, row.status, row.embeddable ? 1 : 0, row.lastCheckedAt),
				),
			);
		},
		async patchSource(userId, id, patch) {
			const current = await this.getSource(userId, id);
			if (!current) return;
			const next = { ...current, ...patch };
			if (patch.sourceMode) {
				const flags = modeFlags(patch.sourceMode);
				next.enabled = flags.enabled;
				next.skipDiscovery = flags.skipDiscovery;
				next.sourceMode = patch.sourceMode;
			}
			await db
				.prepare(
					`UPDATE live_sources SET
						enabled = ?, skip_discovery = ?, source_mode = ?, uploads_playlist_id = ?,
						known_live_video_id = ?, known_upcoming_video_id = ?,
						is_live = ?, live_video_id = ?, live_title = ?, live_checked_at = ?,
						last_status_check_at = ?, last_discovery_at = ?, next_status_check_at = ?, next_discovery_at = ?,
						last_live_at = ?, consecutive_offline_checks = ?, search_cooldown_until = ?, last_player_error_at = ?,
						verify_state = ?, verify_error = ?,
						updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
					 WHERE user_id = ? AND id = ?`,
				)
				.bind(
					next.enabled ? 1 : 0,
					next.skipDiscovery ? 1 : 0,
					next.sourceMode,
					next.uploadsPlaylistId,
					next.knownLiveVideoId,
					next.knownUpcomingVideoId,
					next.isLive ? 1 : 0,
					next.liveVideoId,
					next.liveTitle,
					next.liveCheckedAt,
					next.lastStatusCheckAt,
					next.lastDiscoveryAt,
					next.nextStatusCheckAt,
					next.nextDiscoveryAt,
					next.lastLiveAt,
					next.consecutiveOfflineChecks,
					next.searchCooldownUntil,
					next.lastPlayerErrorAt,
					next.verifyState,
					next.verifyError,
					userId,
					id,
				)
				.run();
		},
		async replaceSourceCandidates(sourceId, rows) {
			await db.prepare(`DELETE FROM live_source_videos WHERE source_id = ?`).bind(sourceId).run();
			if (!rows.length) return;
			await this.upsertCandidates(rows);
		},
		async clearSourceCandidates(sourceId) {
			await db.prepare(`DELETE FROM live_source_videos WHERE source_id = ?`).bind(sourceId).run();
		},
		async tryLock(userId, job, holder, expiresAt, nowIso) {
			await db
				.prepare(`INSERT OR IGNORE INTO live_quad_jobs (user_id, job, status, updated_at) VALUES (?, ?, 'idle', ?)`)
				.bind(userId, job, nowIso)
				.run();
			const result = await db
				.prepare(
					`UPDATE live_quad_jobs SET holder = ?, expires_at = ?, status = 'running', updated_at = ?
					 WHERE user_id = ? AND job = ? AND (status != 'running' OR expires_at IS NULL OR expires_at < ?)`,
				)
				.bind(holder, expiresAt, nowIso, userId, job, nowIso)
				.run();
			return (result.meta.changes ?? 0) > 0;
		},
		async finishLock(userId, job, resultJson, nowIso) {
			await db
				.prepare(
					`UPDATE live_quad_jobs SET status = 'done', holder = NULL, expires_at = ?, result_json = ?, updated_at = ?
					 WHERE user_id = ? AND job = ?`,
				)
				.bind(nowIso, resultJson, nowIso, userId, job)
				.run();
		},
		async getLock(userId, job) {
			const row = await db
				.prepare(`SELECT job, holder, expires_at, status, result_json FROM live_quad_jobs WHERE user_id = ? AND job = ?`)
				.bind(userId, job)
				.first<{ job: string; holder: string | null; expires_at: string | null; status: string; result_json: string | null }>();
			if (!row) return null;
			return {
				job: row.job,
				holder: row.holder,
				expiresAt: row.expires_at,
				status: row.status,
				resultJson: row.result_json,
			};
		},
		async searchUsed(userId, day) {
			const row = await db
				.prepare(`SELECT day, used FROM live_quad_search_budget WHERE user_id = ?`)
				.bind(userId)
				.first<{ day: string; used: number }>();
			if (!row) return 0;
			if (row.day !== day) return 0;
			return row.used;
		},
		async addSearchUse(userId, day, n) {
			const row = await db
				.prepare(`SELECT day, used FROM live_quad_search_budget WHERE user_id = ?`)
				.bind(userId)
				.first<{ day: string; used: number }>();
			const base = row && row.day === day ? row.used : 0;
			const next = base + n;
			await db
				.prepare(
					`INSERT INTO live_quad_search_budget (user_id, day, used, updated_at)
					 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
					 ON CONFLICT(user_id) DO UPDATE SET day = excluded.day, used = excluded.used, updated_at = excluded.updated_at`,
				)
				.bind(userId, day, next)
				.run();
			return next;
		},
	};
}

export { utcDay };
export type { LiveSourceMode };
