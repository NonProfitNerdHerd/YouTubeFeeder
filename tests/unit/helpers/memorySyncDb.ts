/** Minimal D1 stand-in for content-sync unit tests. */

type Row = Record<string, unknown>;

function nowIso() {
	return new Date().toISOString();
}

export class MemorySyncDb {
	channels = new Map<string, Row>();
	videos = new Map<string, Row>();
	inbox = new Map<string, Row>();
	prefs = new Map<string, Row>();
	syncRuns: Row[] = [];

	prepare(sql: string) {
		const statement = {
			_sql: sql,
			_bound: [] as unknown[],
			bind: (...args: unknown[]) => {
				statement._bound = args;
				return statement;
			},
			run: async () => {
				this.exec(sql, statement._bound);
				return { success: true };
			},
			first: async <T>() => {
				const rows = this.query(sql, statement._bound);
				return (rows[0] as T) ?? null;
			},
			all: async <T>() => {
				const rows = this.query(sql, statement._bound);
				return { results: rows as T[] };
			},
		};
		return statement;
	}

	async batch(statements: Array<ReturnType<MemorySyncDb['prepare']>>) {
		for (const stmt of statements) await stmt.run();
		return [];
	}

	seedChannel(row: {
		channel_id: string;
		title?: string;
		uploads_playlist_id: string | null;
		subscribed?: number;
		follow_in_inbox?: number;
		max_videos_to_pull?: number;
		newest_seen_published_at?: string | null;
	}) {
		this.channels.set(row.channel_id, {
			channel_id: row.channel_id,
			title: row.title ?? row.channel_id,
			description: '',
			thumbnail_url: '',
			uploads_playlist_id: row.uploads_playlist_id,
			subscribed: row.subscribed ?? 1,
			last_synchronized_at: null,
		});
		this.prefs.set(`${'user-1'}:${row.channel_id}`, {
			user_id: 'user-1',
			channel_id: row.channel_id,
			follow_in_inbox: row.follow_in_inbox ?? 1,
			max_videos_to_pull: row.max_videos_to_pull ?? 0,
			newest_seen_published_at: row.newest_seen_published_at ?? null,
		});
	}

	private exec(sql: string, bound: unknown[]) {
		const normalized = sql.replace(/\s+/g, ' ').trim();
		if (normalized.startsWith('UPDATE channels SET last_synchronized_at')) {
			const channelId = String(bound[0]);
			const row = this.channels.get(channelId);
			if (row) row.last_synchronized_at = nowIso();
			return;
		}
		if (normalized.startsWith('UPDATE channels SET uploads_playlist_id = NULL')) {
			const channelId = String(bound[0]);
			const row = this.channels.get(channelId);
			if (row) row.uploads_playlist_id = null;
			return;
		}
		if (normalized.startsWith('UPDATE channels SET uploads_playlist_id = ?')) {
			const playlistId = bound[0] as string | null;
			const channelId = String(bound[1]);
			const row = this.channels.get(channelId);
			if (row) row.uploads_playlist_id = playlistId;
			return;
		}
		if (normalized.startsWith('UPDATE channels SET subscribed = 0')) {
			for (const row of this.channels.values()) row.subscribed = 0;
			return;
		}
		if (normalized.startsWith('INSERT INTO sync_runs')) {
			this.syncRuns.push({
				id: bound[0],
				user_id: bound[1],
				sync_type: bound[2],
				status: bound[3],
				started_at: bound[4],
				channels_checked: bound[5],
				videos_added: bound[6],
				videos_updated: bound[7],
				estimated_quota_units: bound[8],
				error_summary: bound[9],
			});
			return;
		}
		if (normalized.startsWith('INSERT INTO videos')) {
			const videoId = String(bound[0]);
			const existing = this.videos.get(videoId);
			this.videos.set(videoId, {
				video_id: videoId,
				channel_id: bound[1],
				title: bound[2],
				description_excerpt: bound[3],
				thumbnail_default: bound[4],
				thumbnail_medium: bound[5],
				thumbnail_high: bound[6],
				published_at: bound[7],
				scheduled_start_at: bound[8],
				actual_start_at: bound[9],
				actual_end_at: bound[10],
				duration_seconds: bound[11],
				content_type: bound[12],
				livestream_status: bound[13],
				embeddable: bound[14],
				updated: Boolean(existing),
			});
			return;
		}
		if (normalized.startsWith('INSERT OR IGNORE INTO inbox_state')) {
			const key = `${bound[0]}:${bound[1]}`;
			if (!this.inbox.has(key)) {
				this.inbox.set(key, { user_id: bound[0], video_id: bound[1], unread: 1 });
			}
			return;
		}
		if (normalized.startsWith('INSERT INTO channel_prefs')) {
			const key = `${bound[0]}:${bound[1]}`;
			const existing = this.prefs.get(key) ?? {};
			this.prefs.set(key, {
				...existing,
				user_id: bound[0],
				channel_id: bound[1],
				follow_in_inbox: bound[2],
				max_videos_to_pull: bound[3],
				newest_seen_published_at: bound[4],
			});
			return;
		}
		if (normalized.startsWith('INSERT OR IGNORE INTO channel_prefs')) {
			const key = `${bound[0]}:${bound[1]}`;
			if (!this.prefs.has(key)) {
				this.prefs.set(key, {
					user_id: bound[0],
					channel_id: bound[1],
					follow_in_inbox: 1,
					max_videos_to_pull: 0,
					newest_seen_published_at: null,
				});
			}
			return;
		}
		if (normalized.startsWith('INSERT INTO channels')) {
			const channelId = String(bound[0]);
			const existing = this.channels.get(channelId) ?? {};
			this.channels.set(channelId, {
				...existing,
				channel_id: channelId,
				title: bound[1],
				description: bound[2],
				thumbnail_url: bound[3],
				subscribed: 1,
				last_synchronized_at: nowIso(),
				uploads_playlist_id: (existing as Row).uploads_playlist_id ?? null,
			});
			return;
		}
	}

	private query(sql: string, bound: unknown[]): Row[] {
		const normalized = sql.replace(/\s+/g, ' ').trim();
		if (normalized.includes('FROM channels c') && normalized.includes('uploads_playlist_id IS NOT NULL')) {
			const userId = String(bound[0]);
			return [...this.channels.values()]
				.filter((ch) => ch.subscribed === 1 && ch.uploads_playlist_id)
				.map((ch) => {
					const pref = this.prefs.get(`${userId}:${ch.channel_id}`) ?? {
						follow_in_inbox: 1,
						max_videos_to_pull: 0,
						newest_seen_published_at: null,
					};
					return {
						channel_id: ch.channel_id,
						title: ch.title,
						uploads_playlist_id: ch.uploads_playlist_id,
						follow_in_inbox: pref.follow_in_inbox ?? 1,
						max_videos_to_pull: pref.max_videos_to_pull ?? 0,
						newest_seen_published_at: pref.newest_seen_published_at ?? null,
					};
				});
		}
		if (normalized.includes('SELECT video_id FROM videos WHERE video_id IN')) {
			return bound
				.map((id) => this.videos.get(String(id)))
				.filter(Boolean)
				.map((row) => ({ video_id: (row as Row).video_id }));
		}
		return [];
	}
}

export function asEnv(db: MemorySyncDb): Env {
	return { DB: db as unknown as D1Database } as Env;
}
