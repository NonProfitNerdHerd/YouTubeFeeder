import type { CategoryRecord, LiveGridSize, LiveLayoutRecord, LiveSessionRecord, LiveSlotRecord, LiveSourceRecord, LiveVideoRecord } from '../../src/types';
import { isLiveGridSize, MAX_LIVE_SLOTS } from '../../src/types';
import { randomToken } from '../auth/crypto';
import { resolveSourceMode } from '../services/quadClassify';
import { selectInChunks } from '../services/youtube';

const SOURCE_SELECT = `SELECT id, display_name, channel_id, youtube_url, notes, enabled, skip_discovery,
	source_mode, is_live, live_video_id, live_title, live_checked_at,
	known_live_video_id, last_status_check_at, last_discovery_at, next_status_check_at, next_discovery_at,
	search_cooldown_until, last_player_error_at, verify_state, verify_error
	FROM live_sources`;

type SourceRow = {
	id: string;
	display_name: string;
	channel_id: string;
	youtube_url: string;
	notes: string;
	enabled: number;
	skip_discovery: number;
	source_mode: string | null;
	is_live: number;
	live_video_id: string | null;
	live_title: string | null;
	live_checked_at: string | null;
	known_live_video_id: string | null;
	last_status_check_at: string | null;
	last_discovery_at: string | null;
	next_status_check_at: string | null;
	next_discovery_at: string | null;
	search_cooldown_until: string | null;
	last_player_error_at: string | null;
	verify_state: string | null;
	verify_error: string | null;
};

function toSource(row: SourceRow, categoryIds: string[], liveVideos: LiveVideoRecord[] = []): LiveSourceRecord {
	return {
		id: row.id,
		displayName: row.display_name,
		channelId: row.channel_id,
		youtubeUrl: row.youtube_url,
		notes: row.notes,
		enabled: row.enabled === 1,
		skipDiscovery: row.skip_discovery === 1 || row.source_mode === 'always_on',
		sourceMode: resolveSourceMode({ enabled: row.enabled === 1, skipDiscovery: row.skip_discovery === 1, sourceMode: row.source_mode }),
		isLive: row.is_live === 1,
		liveVideoId: row.live_video_id,
		liveTitle: row.live_title,
		liveCheckedAt: row.live_checked_at,
		knownLiveVideoId: row.known_live_video_id ?? row.live_video_id,
		lastStatusCheckAt: row.last_status_check_at,
		lastDiscoveryAt: row.last_discovery_at,
		nextStatusCheckAt: row.next_status_check_at,
		nextDiscoveryAt: row.next_discovery_at,
		searchCooldownUntil: row.search_cooldown_until,
		lastPlayerErrorAt: row.last_player_error_at,
		verifyState: row.verify_state === 'error' ? 'error' : 'ok',
		verifyError: row.verify_error,
		liveVideos,
		categoryIds,
	};
}

async function categoryMap(db: D1Database, userId: string): Promise<Map<string, string[]>> {
	const tags = await db
		.prepare(`SELECT source_id, category_id FROM live_source_categories WHERE user_id = ?`)
		.bind(userId)
		.all<{ source_id: string; category_id: string }>();
	const map = new Map<string, string[]>();
	for (const row of tags.results ?? []) {
		const list = map.get(row.source_id) ?? [];
		list.push(row.category_id);
		map.set(row.source_id, list);
	}
	return map;
}

export async function listLiveCategories(db: D1Database, userId: string): Promise<CategoryRecord[]> {
	const rows = await db
		.prepare(`SELECT id, name FROM live_categories WHERE user_id = ? ORDER BY name COLLATE NOCASE`)
		.bind(userId)
		.all<{ id: string; name: string }>();
	return (rows.results ?? []).map((row) => ({ id: row.id, name: row.name }));
}

export async function createLiveCategory(db: D1Database, userId: string, name: string): Promise<CategoryRecord> {
	const trimmed = name.trim().slice(0, 80);
	if (!trimmed) throw new Error('invalid_name');
	const id = randomToken(12);
	try {
		await db.prepare(`INSERT INTO live_categories (id, user_id, name) VALUES (?, ?, ?)`).bind(id, userId, trimmed).run();
	} catch {
		throw new Error('duplicate_name');
	}
	return { id, name: trimmed };
}

export async function deleteLiveCategory(db: D1Database, userId: string, id: string): Promise<void> {
	await db.prepare(`DELETE FROM live_source_categories WHERE user_id = ? AND category_id = ?`).bind(userId, id).run();
	const result = await db.prepare(`DELETE FROM live_categories WHERE user_id = ? AND id = ?`).bind(userId, id).run();
	if (!(result.meta.changes ?? 0)) throw new Error('not_found');
}

export async function ensureLiveSession(db: D1Database, userId: string): Promise<void> {
	await db.prepare(`INSERT OR IGNORE INTO live_session (user_id, grid_size) VALUES (?, 4)`).bind(userId).run();
	await db.batch(
		Array.from({ length: MAX_LIVE_SLOTS }, (_, i) =>
			db.prepare(`INSERT OR IGNORE INTO live_slots (user_id, slot_number, source_id) VALUES (?, ?, NULL)`).bind(userId, i + 1),
		),
	);
}

async function videosBySource(db: D1Database, sourceIds: string[]): Promise<Map<string, LiveVideoRecord[]>> {
	const map = new Map<string, LiveVideoRecord[]>();
	if (!sourceIds.length) return map;
	const found = await selectInChunks<{
		source_id: string;
		video_id: string;
		title: string;
		status: string;
		embeddable: number;
	}>(
		db,
		(placeholders) =>
			`SELECT source_id, video_id, title, status, embeddable FROM live_source_videos
			 WHERE source_id IN (${placeholders})
			   AND status IN ('live', 'non_embeddable', 'upcoming')
			 ORDER BY title COLLATE NOCASE`,
		sourceIds,
	);
	for (const row of found) {
		const list = map.get(row.source_id) ?? [];
		list.push({
			videoId: row.video_id,
			title: row.title,
			status: row.status,
			embeddable: row.embeddable !== 0,
		});
		map.set(row.source_id, list);
	}
	return map;
}

export async function listLiveSources(db: D1Database, userId: string): Promise<LiveSourceRecord[]> {
	const rows = await db.prepare(`${SOURCE_SELECT} WHERE user_id = ? ORDER BY display_name COLLATE NOCASE`).bind(userId).all<SourceRow>();
	const list = rows.results ?? [];
	const cats = await categoryMap(db, userId);
	const videos = await videosBySource(db, list.map((row) => row.id));
	return list.map((row) => toSource(row, cats.get(row.id) ?? [], videos.get(row.id) ?? []));
}

export async function listLiveSourceIdsForCategory(db: D1Database, userId: string, categoryId: string): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT source_id FROM live_source_categories WHERE user_id = ? AND category_id = ?`)
		.bind(userId, categoryId)
		.all<{ source_id: string }>();
	return (rows.results ?? []).map((row) => row.source_id);
}

export async function getLiveSource(db: D1Database, userId: string, id: string): Promise<LiveSourceRecord | null> {
	const row = await db.prepare(`${SOURCE_SELECT} WHERE user_id = ? AND id = ?`).bind(userId, id).first<SourceRow>();
	if (!row) return null;
	const cats = await categoryMap(db, userId);
	const videos = await videosBySource(db, [id]);
	return toSource(row, cats.get(row.id) ?? [], videos.get(id) ?? []);
}

async function setSourceCategories(db: D1Database, userId: string, sourceId: string, categoryIds: string[]): Promise<void> {
	await db.prepare(`DELETE FROM live_source_categories WHERE user_id = ? AND source_id = ?`).bind(userId, sourceId).run();
	const unique = [...new Set(categoryIds.filter(Boolean))];
	if (!unique.length) return;
	await db.batch(
		unique.map((categoryId) =>
			db
				.prepare(`INSERT OR IGNORE INTO live_source_categories (user_id, source_id, category_id) VALUES (?, ?, ?)`)
				.bind(userId, sourceId, categoryId),
		),
	);
}

export async function createLiveSource(
	db: D1Database,
	userId: string,
	input: {
		displayName: string;
		channelId: string;
		youtubeUrl: string;
		notes: string;
		enabled: boolean;
		skipDiscovery: boolean;
		sourceMode?: string;
		categoryIds: string[];
	},
): Promise<LiveSourceRecord> {
	const id = randomToken(12);
	const mode = resolveSourceMode(input);
	const flags = { enabled: mode !== 'disabled', skipDiscovery: mode === 'always_on' };
	try {
		await db
			.prepare(
				`INSERT INTO live_sources (id, user_id, display_name, channel_id, youtube_url, notes, enabled, skip_discovery, source_mode)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				userId,
				input.displayName,
				input.channelId,
				input.youtubeUrl,
				input.notes,
				flags.enabled ? 1 : 0,
				flags.skipDiscovery ? 1 : 0,
				mode,
			)
			.run();
	} catch {
		throw new Error('duplicate_channel');
	}
	await setSourceCategories(db, userId, id, input.categoryIds);
	const created = await getLiveSource(db, userId, id);
	if (!created) throw new Error('not_found');
	return created;
}

export async function updateLiveSource(
	db: D1Database,
	userId: string,
	id: string,
	input: {
		displayName: string;
		channelId: string;
		youtubeUrl: string;
		notes: string;
		enabled: boolean;
		skipDiscovery: boolean;
		sourceMode?: string;
		categoryIds: string[];
	},
): Promise<LiveSourceRecord> {
	const existing = await db.prepare(`SELECT id FROM live_sources WHERE user_id = ? AND id = ?`).bind(userId, id).first();
	if (!existing) throw new Error('not_found');
	const mode = resolveSourceMode(input);
	try {
		await db
			.prepare(
				`UPDATE live_sources SET display_name = ?, channel_id = ?, youtube_url = ?, notes = ?, enabled = ?, skip_discovery = ?,
					source_mode = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND id = ?`,
			)
			.bind(
				input.displayName,
				input.channelId,
				input.youtubeUrl,
				input.notes,
				mode !== 'disabled' ? 1 : 0,
				mode === 'always_on' ? 1 : 0,
				mode,
				userId,
				id,
			)
			.run();
	} catch {
		throw new Error('duplicate_channel');
	}
	await setSourceCategories(db, userId, id, input.categoryIds);
	const updated = await getLiveSource(db, userId, id);
	if (!updated) throw new Error('not_found');
	return updated;
}

export async function deleteLiveSource(db: D1Database, userId: string, id: string): Promise<void> {
	const result = await db.prepare(`DELETE FROM live_sources WHERE user_id = ? AND id = ?`).bind(userId, id).run();
	if (!(result.meta.changes ?? 0)) throw new Error('not_found');
}

export async function updateLiveSourceStatus(
	db: D1Database,
	userId: string,
	id: string,
	status: { videos: LiveVideoRecord[]; checkedAt: string },
): Promise<void> {
	const first = status.videos[0] ?? null;
	await db
		.prepare(
			`UPDATE live_sources SET is_live = ?, live_video_id = ?, live_title = ?, live_checked_at = ?,
				updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND id = ?`,
		)
		.bind(first ? 1 : 0, first?.videoId ?? null, first?.title ?? null, status.checkedAt, userId, id)
		.run();
	await db.prepare(`DELETE FROM live_source_videos WHERE source_id = ?`).bind(id).run();
	if (status.videos.length) {
		await db.batch(
			status.videos.map((video) =>
				db.prepare(`INSERT INTO live_source_videos (source_id, video_id, title) VALUES (?, ?, ?)`).bind(id, video.videoId, video.title),
			),
		);
	}
}

export async function liveRefreshTtlSeconds(db: D1Database, userId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT live_status_refresh_seconds FROM settings WHERE user_id = ?`)
		.bind(userId)
		.first<{ live_status_refresh_seconds: number }>();
	return row?.live_status_refresh_seconds ?? 120;
}

export async function getLiveSession(db: D1Database, userId: string): Promise<LiveSessionRecord> {
	await ensureLiveSession(db, userId);
	const session = await db.prepare(`SELECT grid_size FROM live_session WHERE user_id = ?`).bind(userId).first<{ grid_size: number }>();
	const slotRows = await db
		.prepare(`SELECT slot_number, source_id, video_id FROM live_slots WHERE user_id = ? ORDER BY slot_number`)
		.bind(userId)
		.all<{ slot_number: number; source_id: string | null; video_id: string | null }>();
	const sources = await listLiveSources(db, userId);
	const byId = new Map(sources.map((s) => [s.id, s]));
	const slots: LiveSlotRecord[] = (slotRows.results ?? []).map((row) => {
		const source = row.source_id ? (byId.get(row.source_id) ?? null) : null;
		const videoId = row.video_id ?? source?.liveVideos[0]?.videoId ?? source?.liveVideoId ?? null;
		return { slotNumber: row.slot_number, sourceId: row.source_id, videoId, source };
	});
	const rawGrid = session?.grid_size ?? 4;
	const gridSize = isLiveGridSize(rawGrid) ? rawGrid : 4;
	return { gridSize, slots };
}

export async function setLiveGridSize(db: D1Database, userId: string, gridSize: LiveGridSize): Promise<LiveSessionRecord> {
	await ensureLiveSession(db, userId);
	await db
		.prepare(`UPDATE live_session SET grid_size = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`)
		.bind(gridSize, userId)
		.run();
	return getLiveSession(db, userId);
}

export async function assignLiveSlot(
	db: D1Database,
	userId: string,
	slotNumber: number,
	sourceId: string | null,
	videoId: string | null = null,
): Promise<LiveSessionRecord> {
	await ensureLiveSession(db, userId);
	if (slotNumber < 1 || slotNumber > MAX_LIVE_SLOTS) throw new Error('invalid_slot');
	if (sourceId) {
		const source = await db.prepare(`SELECT id FROM live_sources WHERE user_id = ? AND id = ?`).bind(userId, sourceId).first();
		if (!source) throw new Error('not_found');
		if (!videoId) {
			const first = await db
				.prepare(`SELECT video_id FROM live_source_videos WHERE source_id = ? ORDER BY title COLLATE NOCASE LIMIT 1`)
				.bind(sourceId)
				.first<{ video_id: string }>();
			videoId = first?.video_id ?? null;
		}
	}
	await db
		.prepare(
			`UPDATE live_slots SET source_id = ?, video_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND slot_number = ?`,
		)
		.bind(sourceId, sourceId ? videoId : null, userId, slotNumber)
		.run();
	return getLiveSession(db, userId);
}

type LayoutRow = {
	id: string;
	name: string;
	description: string;
	grid_size: number;
	slot1: string | null;
	slot2: string | null;
	slot3: string | null;
	slot4: string | null;
	slot5: string | null;
	slot6: string | null;
	slot7: string | null;
	slot8: string | null;
	slot9: string | null;
	slot10: string | null;
	slot11: string | null;
	slot12: string | null;
};

function mapLayout(row: LayoutRow): LiveLayoutRecord {
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? '',
		gridSize: isLiveGridSize(row.grid_size) ? row.grid_size : 4,
		slotIds: [
			row.slot1,
			row.slot2,
			row.slot3,
			row.slot4,
			row.slot5,
			row.slot6,
			row.slot7,
			row.slot8,
			row.slot9,
			row.slot10,
			row.slot11,
			row.slot12,
		],
	};
}

const LAYOUT_SELECT = `SELECT id, name, description, grid_size, slot1, slot2, slot3, slot4, slot5, slot6, slot7, slot8,
	slot9, slot10, slot11, slot12 FROM live_layouts`;

export async function listLiveLayouts(db: D1Database, userId: string): Promise<LiveLayoutRecord[]> {
	const rows = await db.prepare(`${LAYOUT_SELECT} WHERE user_id = ? ORDER BY name COLLATE NOCASE`).bind(userId).all<LayoutRow>();
	return (rows.results ?? []).map(mapLayout);
}

export async function saveLiveLayout(db: D1Database, userId: string, name: string): Promise<LiveLayoutRecord> {
	const trimmed = name.trim().slice(0, 80);
	if (!trimmed) throw new Error('invalid_name');
	const session = await getLiveSession(db, userId);
	const bySlot = new Map(session.slots.map((s) => [s.slotNumber, s.sourceId]));
	const ids = Array.from({ length: MAX_LIVE_SLOTS }, (_, i) => bySlot.get(i + 1) ?? null);
	const id = randomToken(12);
	try {
		await db
			.prepare(
				`INSERT INTO live_layouts (id, user_id, name, description, grid_size, slot1, slot2, slot3, slot4, slot5, slot6, slot7, slot8, slot9, slot10, slot11, slot12)
				 VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(id, userId, trimmed, session.gridSize, ...ids)
			.run();
	} catch {
		throw new Error('duplicate_name');
	}
	return {
		id,
		name: trimmed,
		description: '',
		gridSize: session.gridSize,
		slotIds: ids,
	};
}

export async function updateLiveLayout(
	db: D1Database,
	userId: string,
	id: string,
	input: { name?: string; description?: string; gridSize?: LiveGridSize },
): Promise<LiveLayoutRecord> {
	const existing = await db.prepare(`${LAYOUT_SELECT} WHERE user_id = ? AND id = ?`).bind(userId, id).first<LayoutRow>();
	if (!existing) throw new Error('not_found');
	const name = input.name !== undefined ? input.name.trim().slice(0, 80) : existing.name;
	if (!name) throw new Error('invalid_name');
	const description = input.description !== undefined ? input.description.trim().slice(0, 280) : (existing.description ?? '');
	const gridSize = input.gridSize !== undefined && isLiveGridSize(input.gridSize) ? input.gridSize : existing.grid_size;
	try {
		await db
			.prepare(
				`UPDATE live_layouts SET name = ?, description = ?, grid_size = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				 WHERE user_id = ? AND id = ?`,
			)
			.bind(name, description, gridSize, userId, id)
			.run();
	} catch {
		throw new Error('duplicate_name');
	}
	const updated = await db.prepare(`${LAYOUT_SELECT} WHERE user_id = ? AND id = ?`).bind(userId, id).first<LayoutRow>();
	if (!updated) throw new Error('not_found');
	return mapLayout(updated);
}

export async function applyLiveLayout(db: D1Database, userId: string, layoutId: string): Promise<LiveSessionRecord> {
	const row = await db
		.prepare(
			`SELECT grid_size, slot1, slot2, slot3, slot4, slot5, slot6, slot7, slot8, slot9, slot10, slot11, slot12
			 FROM live_layouts WHERE user_id = ? AND id = ?`,
		)
		.bind(userId, layoutId)
		.first<{
			grid_size: number;
			slot1: string | null;
			slot2: string | null;
			slot3: string | null;
			slot4: string | null;
			slot5: string | null;
			slot6: string | null;
			slot7: string | null;
			slot8: string | null;
			slot9: string | null;
			slot10: string | null;
			slot11: string | null;
			slot12: string | null;
		}>();
	if (!row) throw new Error('not_found');
	const gridSize = isLiveGridSize(row.grid_size) ? row.grid_size : 4;
	await setLiveGridSize(db, userId, gridSize);
	const ids = [
		row.slot1,
		row.slot2,
		row.slot3,
		row.slot4,
		row.slot5,
		row.slot6,
		row.slot7,
		row.slot8,
		row.slot9,
		row.slot10,
		row.slot11,
		row.slot12,
	];
	for (let i = 0; i < MAX_LIVE_SLOTS; i++) {
		await assignLiveSlot(db, userId, i + 1, ids[i]);
	}
	return getLiveSession(db, userId);
}

export async function deleteLiveLayout(db: D1Database, userId: string, id: string): Promise<void> {
	const result = await db.prepare(`DELETE FROM live_layouts WHERE user_id = ? AND id = ?`).bind(userId, id).run();
	if (!(result.meta.changes ?? 0)) throw new Error('not_found');
}
