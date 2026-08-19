/** Minimal D1 stand-in for content-sync and WebSub unit tests. */

type Row = Record<string, unknown>;

function nowIso() {
	return new Date().toISOString();
}

function prefKey(userId: string, channelId: string) {
	return `${userId}:${channelId}`;
}

export class MemorySyncDb {
	channels = new Map<string, Row>();
	videos = new Map<string, Row>();
	inbox = new Map<string, Row>();
	prefs = new Map<string, Row>();
	syncRuns: Row[] = [];
	websub = new Map<string, Row>();
	events = new Map<string, Row>();
	quota: Row[] = [];
	users = new Map<string, Row>();
	reconcileState: Row | null = null;
	jobs = new Map<string, Row>();
	ingest: Row[] = [];
	discoverSearchCache = new Map<string, Row>();
	discoverBrowseCache = new Map<string, Row>();
	topicDiscoveryCache = new Map<string, Row>();
	recommendationFeedback: Row[] = [];
	categories = new Map<string, Row>();
	channelCategories: Row[] = [];
	failFanout = false;

	prepare(sql: string) {
		const statement = {
			_sql: sql,
			_bound: [] as unknown[],
			bind: (...args: unknown[]) => {
				if (args.length > 100) {
					throw new Error(`D1_ERROR: too many SQL variables at offset 285: SQLITE_ERROR`);
				}
				statement._bound = args;
				return statement;
			},
			run: async () => {
				const changes = this.exec(sql, statement._bound);
				return { success: true, meta: { changes } };
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

	seedUser(id: string, extras?: Row) {
		this.users.set(id, { id, google_account_id: id, display_name: id, encrypted_refresh_token: 'enc', ...extras });
	}

	seedChannel(
		row: {
			channel_id: string;
			title?: string;
			uploads_playlist_id: string | null;
			subscribed?: number;
			follow_in_inbox?: number;
			max_videos_to_pull?: number;
			newest_seen_published_at?: string | null;
			last_synchronized_at?: string | null;
			is_subscribed?: number;
			bootstrap_status?: string | null;
			bootstrap_page_token?: string | null;
			last_reconciled_at?: string | null;
			last_reconcile_attempt_at?: string | null;
			reconcile_failure_count?: number;
			reconcile_next_retry_at?: string | null;
			reconcile_last_error?: string | null;
		},
		userId = 'user-1',
	) {
		const existing = this.channels.get(row.channel_id) ?? {};
		this.channels.set(row.channel_id, {
			...existing,
			channel_id: row.channel_id,
			title: row.title ?? row.channel_id,
			description: '',
			thumbnail_url: '',
			uploads_playlist_id: row.uploads_playlist_id,
			subscribed: row.subscribed ?? 1,
			last_synchronized_at: row.last_synchronized_at ?? (existing as Row).last_synchronized_at ?? null,
			last_reconciled_at:
				row.last_reconciled_at ??
				(existing as Row).last_reconciled_at ??
				row.last_synchronized_at ??
				(existing as Row).last_synchronized_at ??
				null,
			last_reconcile_attempt_at: row.last_reconcile_attempt_at ?? (existing as Row).last_reconcile_attempt_at ?? null,
			reconcile_failure_count: row.reconcile_failure_count ?? (existing as Row).reconcile_failure_count ?? 0,
			reconcile_next_retry_at: row.reconcile_next_retry_at ?? (existing as Row).reconcile_next_retry_at ?? null,
			reconcile_last_error: row.reconcile_last_error ?? (existing as Row).reconcile_last_error ?? null,
			bootstrap_status: row.bootstrap_status ?? (existing as Row).bootstrap_status ?? null,
			bootstrap_page_token: row.bootstrap_page_token ?? (existing as Row).bootstrap_page_token ?? null,
		});
		const key = prefKey(userId, row.channel_id);
		const prev = this.prefs.get(key) ?? {};
		this.prefs.set(key, {
			...prev,
			user_id: userId,
			channel_id: row.channel_id,
			follow_in_inbox: row.follow_in_inbox ?? 1,
			max_videos_to_pull: row.max_videos_to_pull ?? 0,
			newest_seen_published_at: row.newest_seen_published_at ?? null,
			is_subscribed: row.is_subscribed ?? 1,
			last_subscription_sync_id: (prev as Row).last_subscription_sync_id ?? null,
			subscription_seen_at: (prev as Row).subscription_seen_at ?? null,
			unsubscribed_at: (prev as Row).unsubscribed_at ?? null,
			catchup_page_token: (prev as Row).catchup_page_token ?? null,
			catchup_pulled: (prev as Row).catchup_pulled ?? 0,
		});
	}

	private exec(sql: string, bound: unknown[]): number {
		const normalized = sql.replace(/\s+/g, ' ').trim();
		if (normalized.startsWith('UPDATE channels SET last_synchronized_at')) {
			const channelId = String(bound[bound.length - 1]);
			const row = this.channels.get(channelId);
			if (!row) return 0;
			row.last_synchronized_at = String(bound[0]);
			if (normalized.includes('last_reconciled_at')) {
				row.last_reconciled_at = String(bound[1]);
				row.last_reconcile_attempt_at = String(bound[2]);
				row.reconcile_failure_count = 0;
				row.reconcile_last_error = null;
				row.reconcile_next_retry_at = null;
				if (Number(bound[3]) > 0) row.last_new_video_at = String(bound[4]);
			}
			return 1;
		}
		if (normalized.startsWith('UPDATE channels SET last_reconcile_attempt_at')) {
			const channelId = String(bound[bound.length - 1]);
			const row = this.channels.get(channelId);
			if (!row) return 0;
			row.last_reconcile_attempt_at = String(bound[0]);
			row.reconcile_failure_count = Number(bound[1]);
			row.reconcile_last_error = String(bound[2]);
			row.reconcile_next_retry_at = String(bound[3]);
			return 1;
		}
		if (normalized.startsWith('UPDATE websub_subscriptions SET last_notify_at')) {
			const channelId = String(bound[0]);
			const row = this.websub.get(channelId);
			if (row) row.last_notify_at = nowIso();
			return row ? 1 : 0;
		}
		if (normalized.startsWith('UPDATE channels SET uploads_playlist_id = NULL')) {
			const channelId = String(bound[0]);
			const row = this.channels.get(channelId);
			if (row) row.uploads_playlist_id = null;
			return row ? 1 : 0;
		}
		if (normalized.startsWith('UPDATE channels SET uploads_playlist_id = ?')) {
			const playlistId = bound[0] as string | null;
			const channelId = String(bound[1]);
			const row = this.channels.get(channelId);
			if (row) row.uploads_playlist_id = playlistId;
			return row ? 1 : 0;
		}
		if (normalized.includes('UPDATE channels SET bootstrap_status')) {
			const channelId = String(bound[bound.length - 1]);
			const row = this.channels.get(channelId) ?? { channel_id: channelId };
			if (normalized.includes("bootstrap_status = 'unavailable'")) {
				row.bootstrap_status = 'unavailable';
				row.bootstrap_updated_at = bound[0];
			} else if (normalized.includes("bootstrap_status = 'in_progress'")) {
				row.bootstrap_status = 'in_progress';
				row.bootstrap_page_token = bound[0];
				row.bootstrap_updated_at = bound[1];
			} else if (normalized.includes("bootstrap_status = 'done'")) {
				row.bootstrap_status = 'done';
				row.bootstrap_page_token = null;
				row.bootstrap_updated_at = bound[0];
			}
			this.channels.set(channelId, row);
			return 1;
		}
		if (normalized.startsWith('UPDATE channels SET subscribed = 0')) {
			for (const row of this.channels.values()) row.subscribed = 0;
			return this.channels.size;
		}
		if (normalized.startsWith('UPDATE channel_prefs') && normalized.includes('is_subscribed = 0') && normalized.includes('channel_id = ?')) {
			const seenAt = String(bound[0]);
			const userId = String(bound[1]);
			const channelId = String(bound[2]);
			const pref = this.prefs.get(prefKey(userId, channelId));
			if (!pref || pref.is_subscribed !== 1) return 0;
			pref.is_subscribed = 0;
			pref.unsubscribed_at = seenAt;
			return 1;
		}
		if (normalized.startsWith('UPDATE channel_prefs') && normalized.includes('is_subscribed = 0')) {
			const seenAt = String(bound[0]);
			const userId = String(bound[1]);
			const syncId = String(bound[2]);
			let n = 0;
			for (const pref of this.prefs.values()) {
				if (pref.user_id !== userId || pref.is_subscribed !== 1) continue;
				if (pref.follow_source && pref.follow_source !== 'youtube_sync') continue;
				if (pref.last_subscription_sync_id != null && pref.last_subscription_sync_id === syncId) continue;
				pref.is_subscribed = 0;
				pref.unsubscribed_at = seenAt;
				n += 1;
			}
			return n;
		}
		if (normalized.startsWith('UPDATE websub_events SET status = \'done\'')) {
			const row = this.events.get(String(bound[0]));
			if (row) {
				row.status = 'done';
				row.processed_at = nowIso();
				row.last_error = null;
				row.last_attempt_at = nowIso();
				return 1;
			}
			return 0;
		}
		if (normalized.startsWith('UPDATE websub_events SET status = ?')) {
			const id = String(bound[bound.length - 1]);
			const row = this.events.get(id);
			if (!row) return 0;
			row.status = bound[0];
			row.attempts = bound[1];
			row.last_attempt_at = bound[2];
			row.next_attempt_at = bound[3];
			row.last_error = bound[4];
			return 1;
		}
		if (normalized.startsWith('UPDATE websub_events SET status = \'error\'')) {
			const id = String(bound[bound.length - 1]);
			const row = this.events.get(id);
			if (!row) return 0;
			row.status = 'error';
			row.attempts = Number(row.attempts ?? 0) + 1;
			if (bound.length > 1) row.last_error = bound[0];
			else if (normalized.includes('missing_api_key')) row.last_error = 'missing_api_key';
			else if (normalized.includes('video_not_found')) row.last_error = 'video_not_found';
			return 1;
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
			return 1;
		}
		if (normalized.startsWith('INSERT INTO videos') || normalized.startsWith('INSERT INTO videos (')) {
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
			return 1;
		}
		if (normalized.startsWith('INSERT OR IGNORE INTO inbox_state') && normalized.includes('SELECT p.user_id')) {
			if (this.failFanout) throw new Error('fanout_failed');
			const videoId = String(bound[0]);
			const channelId = String(bound[2] ?? bound[1]);
			const video = this.videos.get(videoId);
			let n = 0;
			for (const pref of this.prefs.values()) {
				if (pref.channel_id !== channelId || pref.is_subscribed !== 1 || pref.follow_in_inbox !== 1) continue;
				const watermark = pref.newest_seen_published_at as string | null | undefined;
				if (watermark && video?.published_at && String(video.published_at) <= watermark) continue;
				const key = `${pref.user_id}:${videoId}`;
				if (!this.inbox.has(key)) {
					this.inbox.set(key, {
						user_id: pref.user_id,
						video_id: videoId,
						unread: 1,
						archived: 0,
						hidden: 0,
						first_seen_at: nowIso(),
						watched_at: null,
					});
					n += 1;
				}
			}
			return n;
		}
		if (normalized.startsWith('INSERT OR IGNORE INTO inbox_state')) {
			const key = `${bound[0]}:${bound[1]}`;
			if (!this.inbox.has(key)) {
				this.inbox.set(key, {
					user_id: bound[0],
					video_id: bound[1],
					unread: 1,
					archived: 0,
					hidden: 0,
					first_seen_at: nowIso(),
					watched_at: null,
				});
				return 1;
			}
			return 0;
		}
		if (normalized.startsWith('INSERT OR IGNORE INTO websub_events') || normalized.startsWith('INSERT OR IGNORE INTO websub_events')) {
			const id = String(bound[0]);
			if (this.events.has(id)) return 0;
			this.events.set(id, {
				id,
				channel_id: bound[1],
				video_id: bound[2],
				title: bound[3],
				published_at: bound[4],
				updated_at: bound[5],
				status: 'pending',
				attempts: 0,
				last_error: null,
				created_at: nowIso(),
				last_attempt_at: null,
				next_attempt_at: null,
			});
			return 1;
		}
		if (normalized.startsWith('INSERT OR IGNORE INTO websub_subscriptions')) {
			let n = 0;
			for (const pref of this.prefs.values()) {
				if (pref.is_subscribed !== 1) continue;
				const channelId = String(pref.channel_id);
				if (!this.websub.has(channelId)) {
					this.websub.set(channelId, {
						channel_id: channelId,
						status: 'pending',
						lease_expires_at: null,
						last_subscribe_attempt_at: null,
						last_verified_at: null,
						failure_count: 0,
						last_error: null,
					});
					n += 1;
				}
			}
			return n;
		}
		if (normalized.includes("WHEN websub_subscriptions.status = 'inactive'")) {
			const channelId = String(bound[0]);
			const existing = this.websub.get(channelId);
			if (!existing) {
				this.websub.set(channelId, {
					channel_id: channelId,
					status: 'pending',
					lease_expires_at: null,
					last_subscribe_attempt_at: null,
					last_verified_at: null,
					failure_count: 0,
					last_error: null,
				});
			} else if (existing.status === 'inactive') {
				existing.status = 'pending';
			}
			return 1;
		}
		if (normalized.startsWith('INSERT INTO websub_subscriptions')) {
			const channelId = String(bound[0]);
			const existing = this.websub.get(channelId) ?? {};
			this.websub.set(channelId, {
				...existing,
				channel_id: channelId,
				status: bound[1] ?? existing.status ?? 'pending',
				lease_expires_at: bound[2] ?? existing.lease_expires_at ?? null,
				last_subscribe_attempt_at: bound[3] ?? existing.last_subscribe_attempt_at ?? null,
				last_verified_at: bound[4] ?? existing.last_verified_at ?? null,
				failure_count: bound[5] ?? existing.failure_count ?? 0,
				last_error: bound[6],
			});
			if (normalized.includes('ON CONFLICT')) {
				const patch: Row = { ...this.websub.get(channelId), channel_id: channelId };
				if (bound[1] != null) patch.status = bound[1];
				if (bound[2] != null) patch.lease_expires_at = bound[2];
				if (bound[3] != null) patch.last_subscribe_attempt_at = bound[3];
				if (bound[4] != null) patch.last_verified_at = bound[4];
				if (bound[5] != null) patch.failure_count = bound[5];
				patch.last_error = bound[6];
				this.websub.set(channelId, patch);
			}
			return 1;
		}
		if (normalized.startsWith('INSERT INTO api_quota_daily')) {
			const day = String(bound[0]);
			const endpoint = String(bound[1]);
			const existing = this.quota.find((row) => row.day === day && row.endpoint === endpoint);
			if (existing) {
				existing.call_count = Number(existing.call_count ?? 0) + Number(bound[2] ?? 0);
				existing.general_units = Number(existing.general_units ?? 0) + Number(bound[3] ?? 0);
				existing.search_calls = Number(existing.search_calls ?? 0) + Number(bound[4] ?? 0);
			} else {
				this.quota.push({
					day,
					endpoint,
					call_count: bound[2],
					general_units: bound[3],
					search_calls: bound[4],
				});
			}
			return 1;
		}
		if (normalized.includes('INSERT INTO discover_search_cache')) {
			this.discoverSearchCache.set(String(bound[0]), {
				cache_key: bound[0],
				results_json: bound[1],
				searched_at: bound[2],
				expires_at: bound[3],
			});
			return 1;
		}
		if (normalized.includes('INSERT INTO discover_browse_cache')) {
			this.discoverBrowseCache.set(String(bound[0]), {
				section_key: bound[0],
				payload_json: bound[1],
				refreshed_at: bound[2],
				expires_at: bound[3],
			});
			return 1;
		}
		if (normalized.includes('INSERT INTO topic_discovery_cache')) {
			this.topicDiscoveryCache.set(String(bound[0]), {
				normalized_topic: bound[0],
				results_json: bound[1],
				searched_at: bound[2],
				expires_at: bound[3],
				next_page_token: bound[4] ?? null,
			});
			return 1;
		}
		if (normalized.includes('INSERT INTO recommendation_feedback')) {
			this.recommendationFeedback.push({
				id: bound[0],
				user_id: bound[1],
				provider: bound[2],
				external_id: bound[3],
				channel_title: bound[4],
				channel_thumbnail: bound[5],
				interest_id: bound[6],
				interest_label: bound[7],
				action: bound[8],
				matched_concepts_json: bound[9],
				recommendation_reason: bound[10],
				base_score: bound[11],
				created_at: bound[12],
				restored_at: null,
			});
			return 1;
		}
		if (normalized.includes('UPDATE recommendation_feedback SET restored_at')) {
			const restoredAt = bound[0];
			const id = String(bound[1]);
			const userId = String(bound[2]);
			const row = this.recommendationFeedback.find((item) => item.id === id && item.user_id === userId);
			if (!row) return 0;
			row.restored_at = restoredAt;
			return 1;
		}
		if (normalized.startsWith('INSERT INTO feed_reconcile_state') || normalized.includes('ON CONFLICT(id) DO UPDATE SET')) {
			if (normalized.includes('feed_reconcile_state')) {
				this.reconcileState = {
					id: 1,
					day: bound[0],
					units_used: bound[1],
					last_channel_id: bound[2],
				};
				return 1;
			}
		}
		if (normalized.startsWith('UPDATE channel_prefs SET catchup_page_token')) {
			const key = prefKey(String(bound[2]), String(bound[3]));
			const pref = this.prefs.get(key);
			if (!pref) return 0;
			pref.catchup_page_token = bound[0];
			pref.catchup_pulled = bound[1];
			pref.catchup_updated_at = nowIso();
			return 1;
		}
		if (normalized.includes('last_subscription_sync_id') && normalized.startsWith('INSERT INTO channel_prefs')) {
			const key = prefKey(String(bound[0]), String(bound[1]));
			const existing = this.prefs.get(key) ?? {};
			this.prefs.set(key, {
				...existing,
				user_id: bound[0],
				channel_id: bound[1],
				follow_in_inbox: existing.follow_in_inbox ?? 1,
				max_videos_to_pull: existing.max_videos_to_pull ?? 0,
				is_subscribed: 1,
				last_subscription_sync_id: bound[2],
				subscription_seen_at: bound[3],
				unsubscribed_at: null,
				follow_source: 'youtube_sync',
			});
			return 1;
		}
		if (normalized.includes("follow_source = 'discover'") && normalized.startsWith('INSERT INTO channel_prefs')) {
			const key = prefKey(String(bound[0]), String(bound[1]));
			this.prefs.set(key, {
				user_id: bound[0],
				channel_id: bound[1],
				follow_in_inbox: 1,
				max_videos_to_pull: 0,
				is_subscribed: 1,
				subscription_seen_at: bound[2],
				newest_seen_published_at: bound[3],
				follow_source: 'discover',
				unsubscribed_at: null,
			});
			return 1;
		}
		if (normalized.startsWith('INSERT INTO channel_prefs')) {
			const key = prefKey(String(bound[0]), String(bound[1]));
			const existing = this.prefs.get(key) ?? {};
			this.prefs.set(key, {
				...existing,
				user_id: bound[0],
				channel_id: bound[1],
				follow_in_inbox: bound[2],
				max_videos_to_pull: bound[3],
				newest_seen_published_at: bound[4],
				is_subscribed: existing.is_subscribed ?? 1,
			});
			return 1;
		}
		if (normalized.startsWith('INSERT OR IGNORE INTO channel_prefs')) {
			const key = prefKey(String(bound[0]), String(bound[1]));
			if (!this.prefs.has(key)) {
				this.prefs.set(key, {
					user_id: bound[0],
					channel_id: bound[1],
					follow_in_inbox: 1,
					max_videos_to_pull: 0,
					newest_seen_published_at: null,
					is_subscribed: 1,
				});
				return 1;
			}
			return 0;
		}
		if (normalized.startsWith('INSERT INTO feed_ingest_daily')) {
			const day = String(bound[0]);
			const source = String(bound[1]);
			const added = Number(bound[2] ?? 0);
			const existing = this.ingest.find((row) => row.day === day && row.source === source);
			if (existing) existing.videos_added = Number(existing.videos_added ?? 0) + added;
			else this.ingest.push({ day, source, videos_added: added });
			return 1;
		}
		if (normalized.startsWith('INSERT INTO feed_sync_jobs')) {
			const id = String(bound[0]);
			const row: Row = {
				id,
				kind: bound[1],
				status: bound[2],
				user_id: bound[3],
				cursor_channel_id: bound[4],
				channels_total: bound[5],
				channels_checked: bound[6],
				videos_added: bound[7],
				error_count: bound[8],
				last_error: bound[9],
				started_at: bound[10],
				completed_at: bound[11],
				updated_at: nowIso(),
			};
			this.jobs.set(id, { ...(this.jobs.get(id) ?? {}), ...row });
			return 1;
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
				subscribed: (existing as Row).subscribed ?? 0,
				last_synchronized_at: (existing as Row).last_synchronized_at ?? null,
				uploads_playlist_id: (existing as Row).uploads_playlist_id ?? null,
			});
			return 1;
		}
		return 0;
	}

	private query(sql: string, bound: unknown[]): Row[] {
		const normalized = sql.replace(/\s+/g, ' ').trim();
		if (normalized.includes('SELECT COUNT(*) AS n FROM channel_prefs')) {
			const channelId = String(bound[0]);
			const n = [...this.prefs.values()].filter((p) => p.channel_id === channelId && p.is_subscribed === 1).length;
			return [{ n }];
		}
		if (normalized.includes('FROM websub_subscriptions WHERE channel_id = ?')) {
			const row = this.websub.get(String(bound[0]));
			return row ? [row] : [];
		}
		if (normalized.includes('FROM websub_subscriptions') && normalized.includes("status IN ('active', 'pending', 'error')")) {
			const cutoff = normalized.includes('lease_expires_at') ? String(bound[0]) : '9999';
			const staleAttempt = normalized.includes('last_subscribe_attempt_at')
				? String(bound[normalized.includes('lease_expires_at') ? 1 : 0])
				: '9999';
			const limit = Number(bound[bound.length - 1] ?? 20);
			const wantFollowers = normalized.includes('EXISTS') && !normalized.includes('NOT EXISTS');
			const wantOrphans = normalized.includes('NOT EXISTS');
			const rows = [...this.websub.values()].filter((row) => {
				if (!['active', 'pending', 'error'].includes(String(row.status))) return false;
				if (normalized.includes('lease_expires_at') && row.lease_expires_at != null && String(row.lease_expires_at) > cutoff) {
					return false;
				}
				if (row.last_subscribe_attempt_at != null && String(row.last_subscribe_attempt_at) > staleAttempt) return false;
				const followers = [...this.prefs.values()].some(
					(p) => p.channel_id === row.channel_id && p.is_subscribed === 1,
				);
				if (wantFollowers && !followers) return false;
				if (wantOrphans && followers) return false;
				return true;
			});
			rows.sort((a, b) => {
				if (a.last_subscribe_attempt_at == null && b.last_subscribe_attempt_at != null) return -1;
				if (a.last_subscribe_attempt_at != null && b.last_subscribe_attempt_at == null) return 1;
				const byAttempt = String(a.last_subscribe_attempt_at ?? '').localeCompare(String(b.last_subscribe_attempt_at ?? ''));
				if (byAttempt !== 0) return byAttempt;
				return String(a.channel_id).localeCompare(String(b.channel_id));
			});
			return rows.slice(0, limit);
		}
		if (normalized.includes('FROM websub_events WHERE status IN')) {
			const now = bound.length > 1 ? String(bound[0]) : '';
			const limit = Number(bound[bound.length - 1] ?? 50);
			return [...this.events.values()]
				.filter((row) => {
					if (row.status !== 'pending' && row.status !== 'error') return false;
					if (now && row.next_attempt_at != null && String(row.next_attempt_at) > now) return false;
					return true;
				})
				.slice(0, limit);
		}
		if (normalized.includes('SELECT status, COUNT(*) AS n FROM websub_events')) {
			const counts = new Map<string, number>();
			for (const row of this.events.values()) {
				const status = String(row.status);
				counts.set(status, (counts.get(status) ?? 0) + 1);
			}
			return [...counts.entries()].map(([status, n]) => ({ status, n }));
		}
		if (normalized.includes('SELECT general_units FROM api_quota_daily')) {
			const day = String(bound[0]);
			const endpoint = String(bound[1]);
			const row = this.quota.find((item) => item.day === day && item.endpoint === endpoint);
			return row ? [{ general_units: row.general_units ?? 0 }] : [];
		}
		if (normalized.includes('FROM feed_reconcile_state')) {
			return this.reconcileState ? [this.reconcileState] : [];
		}
		if (normalized.includes('FROM feed_sync_jobs')) {
			let rows = [...this.jobs.values()];
			if (normalized.includes("status IN ('queued', 'running')")) {
				rows = rows.filter((row) => row.status === 'queued' || row.status === 'running');
			}
			if (normalized.includes('AND kind = ?')) {
				rows = rows.filter((row) => row.kind === bound[0]);
			}
			if (normalized.includes('WHERE id = ?')) {
				const row = this.jobs.get(String(bound[0]));
				return row ? [row] : [];
			}
			rows.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
			return rows.slice(0, 1);
		}
		if (normalized.includes('FROM feed_ingest_daily')) {
			const day = String(bound[0]);
			const source = bound.length > 1 ? String(bound[1]) : null;
			return this.ingest.filter((row) => row.day === day && (!source || row.source === source));
		}
		if (normalized.includes('SELECT endpoint, call_count, general_units FROM api_quota_daily')) {
			const day = String(bound[0]);
			return this.quota.filter((row) => row.day === day).sort((a, b) => String(a.endpoint).localeCompare(String(b.endpoint)));
		}
		if (normalized.includes('MAX(COALESCE(v.published_at')) {
			const userId = String(bound[0]);
			let newest: string | null = null;
			for (const row of this.inbox.values()) {
				if (row.user_id !== userId || Number(row.archived ?? 0) === 1 || Number(row.hidden ?? 0) === 1) continue;
				const video = this.videos.get(String(row.video_id));
				const published = String(video?.published_at ?? video?.scheduled_start_at ?? row.first_seen_at ?? '');
				if (published && (!newest || published > newest)) newest = published;
			}
			return [{ newest }];
		}
		if (normalized.includes('FROM channels c') && normalized.includes('EXISTS (SELECT 1 FROM channel_prefs')) {
			const subscribed = [...this.channels.values()].filter((ch) =>
				[...this.prefs.values()].some((p) => p.channel_id === ch.channel_id && p.is_subscribed === 1),
			);
			if (normalized.includes('SELECT COUNT(*) AS n')) {
				let rows = subscribed;
				if (normalized.includes('c.channel_id > ?')) {
					rows = rows.filter((ch) => String(ch.channel_id) > String(bound[0]));
				} else if (normalized.includes('last_reconciled_at <= ?')) {
					const cutoff = String(bound[0]);
					const nowIso = String(bound[1] ?? '');
					rows = rows.filter((ch) => {
						if (ch.reconcile_next_retry_at != null && String(ch.reconcile_next_retry_at) > nowIso) return false;
						return ch.last_reconciled_at == null || String(ch.last_reconciled_at) <= cutoff;
					});
				} else if (normalized.includes('c.last_reconciled_at IS NOT NULL AND c.last_reconciled_at > ?')) {
					rows = rows.filter((ch) => ch.last_reconciled_at != null && String(ch.last_reconciled_at) > String(bound[0]));
				} else if (normalized.includes('bootstrap_status')) {
					rows = rows.filter((ch) => {
						const status = ch.bootstrap_status;
						return status == null || status === 'pending' || status === 'in_progress';
					});
				}
				return [{ n: rows.length }];
			}
			if (normalized.includes('MIN(last_reconciled_at)')) {
				const times = subscribed.map((ch) => ch.last_reconciled_at).filter((value) => value != null) as string[];
				times.sort();
				return [{ oldest: times[0] ?? null }];
			}
			if (normalized.includes('reconcile_failure_count')) {
				let rows = subscribed.filter((ch) => {
					if (normalized.includes('? IS NULL OR c.channel_id > ?')) {
						const after = bound[0];
						if (after != null && after !== '') return String(ch.channel_id) > String(bound[1] ?? after);
						return true;
					}
					const cutoff = String(bound[0] ?? '');
					const nowIso = String(bound[1] ?? '');
					if (ch.reconcile_next_retry_at != null && String(ch.reconcile_next_retry_at) > nowIso) return false;
					return ch.last_reconciled_at == null || String(ch.last_reconciled_at) <= cutoff;
				});
				if (normalized.includes('ORDER BY c.channel_id ASC')) {
					rows = rows.sort((a, b) => String(a.channel_id).localeCompare(String(b.channel_id)));
				} else {
					rows = rows.sort((a, b) => {
						if (a.last_reconciled_at == null && b.last_reconciled_at != null) return -1;
						if (a.last_reconciled_at != null && b.last_reconciled_at == null) return 1;
						const byTime = String(a.last_reconciled_at ?? '').localeCompare(String(b.last_reconciled_at ?? ''));
						if (byTime !== 0) return byTime;
						return String(a.channel_id).localeCompare(String(b.channel_id));
					});
				}
				const limit = Number(bound[bound.length - 1] ?? rows.length);
				return rows.slice(0, limit).map((ch) => ({
					channel_id: ch.channel_id,
					uploads_playlist_id: ch.uploads_playlist_id,
					last_reconciled_at: ch.last_reconciled_at ?? null,
					reconcile_next_retry_at: ch.reconcile_next_retry_at ?? null,
					reconcile_failure_count: Number(ch.reconcile_failure_count ?? 0),
				}));
			}
		}
		if (normalized.includes('LEFT JOIN websub_subscriptions w') && normalized.includes('FROM channels c')) {
			const now = String(bound[0] ?? '');
			const rows = [...this.channels.values()]
				.filter((ch) => [...this.prefs.values()].some((p) => p.channel_id === ch.channel_id && p.is_subscribed === 1))
				.map((ch) => {
					const w = this.websub.get(String(ch.channel_id));
					return {
						channel_id: ch.channel_id,
						uploads_playlist_id: ch.uploads_playlist_id,
						last_synchronized_at: ch.last_synchronized_at ?? null,
						websub_status: w?.status ?? null,
						lease_expires_at: w?.lease_expires_at ?? null,
						last_verified_at: w?.last_verified_at ?? null,
						_priority:
							!w ||
							['error', 'pending', 'inactive'].includes(String(w.status)) ||
							w.lease_expires_at == null ||
							String(w.lease_expires_at) <= now ||
							w.last_verified_at == null
								? 0
								: 1,
					};
				});
			rows.sort((a, b) => {
				if (a._priority !== b._priority) return a._priority - b._priority;
				if (!a.last_synchronized_at && b.last_synchronized_at) return -1;
				if (a.last_synchronized_at && !b.last_synchronized_at) return 1;
				const byTime = String(a.last_synchronized_at ?? '').localeCompare(String(b.last_synchronized_at ?? ''));
				if (byTime !== 0) return byTime;
				return String(a.channel_id).localeCompare(String(b.channel_id));
			});
			return rows.slice(0, 80);
		}
		if (normalized.includes('SELECT channel_id FROM channel_prefs') && normalized.includes('last_subscription_sync_id')) {
			const userId = String(bound[0]);
			const syncId = String(bound[1]);
			return [...this.prefs.values()]
				.filter(
					(p) =>
						p.user_id === userId &&
						p.is_subscribed === 1 &&
						p.follow_source === 'youtube_sync' &&
						(p.last_subscription_sync_id == null || p.last_subscription_sync_id !== syncId),
				)
				.map((p) => ({ channel_id: p.channel_id }));
		}
		if (normalized.includes('SELECT channel_id FROM channels WHERE uploads_playlist_id IS NULL')) {
			const ids = new Set(bound.map(String));
			return [...this.channels.values()]
				.filter((ch) => ids.has(String(ch.channel_id)) && !ch.uploads_playlist_id)
				.map((ch) => ({ channel_id: ch.channel_id }));
		}
		if (normalized.includes('FROM channels c') && normalized.includes('uploads_playlist_id IS NOT NULL')) {
			const userId = String(bound[0]);
			let rows = [...this.channels.values()]
				.map((ch) => {
					const pref = this.prefs.get(`${userId}:${ch.channel_id}`);
					if (!pref || pref.is_subscribed !== 1 || !ch.uploads_playlist_id) return null;
					return {
						channel_id: ch.channel_id,
						title: ch.title,
						uploads_playlist_id: ch.uploads_playlist_id,
						follow_in_inbox: pref.follow_in_inbox ?? 1,
						max_videos_to_pull: pref.max_videos_to_pull ?? 0,
						newest_seen_published_at: pref.newest_seen_published_at ?? null,
						last_synchronized_at: ch.last_synchronized_at ?? null,
					};
				})
				.filter((row): row is NonNullable<typeof row> => Boolean(row));
			if (normalized.includes('last_synchronized_at IS NULL OR')) {
				const staleBefore = String(bound[bound.length - 1]);
				rows = rows
					.filter((ch) => !ch.last_synchronized_at || String(ch.last_synchronized_at) < staleBefore)
					.sort((a, b) => {
						if (!a.last_synchronized_at && !b.last_synchronized_at) {
							return String(a.channel_id).localeCompare(String(b.channel_id));
						}
						if (!a.last_synchronized_at) return -1;
						if (!b.last_synchronized_at) return 1;
						const byTime = String(a.last_synchronized_at).localeCompare(String(b.last_synchronized_at));
						return byTime !== 0 ? byTime : String(a.channel_id).localeCompare(String(b.channel_id));
					});
			}
			return rows;
		}
		if (normalized.includes('LEFT JOIN channel_prefs p') || (normalized.includes('FROM channels c') && normalized.includes('c.channel_id = ?'))) {
			const userId = String(bound[0]);
			const channelId = String(bound[1]);
			const ch = this.channels.get(channelId);
			const pref = this.prefs.get(prefKey(userId, channelId));
			if (!ch || pref?.is_subscribed !== 1) return [];
			return [
				{
					channel_id: ch.channel_id,
					title: ch.title,
					uploads_playlist_id: ch.uploads_playlist_id,
					follow_in_inbox: pref.follow_in_inbox ?? 1,
					max_videos_to_pull: pref.max_videos_to_pull ?? 0,
					newest_seen_published_at: pref.newest_seen_published_at ?? null,
					last_synchronized_at: ch.last_synchronized_at ?? null,
					catchup_page_token: pref.catchup_page_token ?? null,
					catchup_pulled: pref.catchup_pulled ?? 0,
				},
			];
		}
		if (normalized.includes('FROM channels c') && normalized.includes('bootstrap_status')) {
			return [...this.channels.values()]
				.filter((ch) => {
					const hasFollower = [...this.prefs.values()].some((p) => p.channel_id === ch.channel_id && p.is_subscribed === 1);
					const status = ch.bootstrap_status;
					return hasFollower && (status == null || status === 'pending' || status === 'in_progress');
				})
				.sort((a, b) => String(a.channel_id).localeCompare(String(b.channel_id)))
				.slice(0, 20);
		}
		if (normalized.includes('SELECT video_id FROM videos WHERE video_id IN')) {
			return bound
				.map((id) => this.videos.get(String(id)))
				.filter(Boolean)
				.map((row) => ({ video_id: (row as Row).video_id }));
		}
		if (normalized.includes('FROM users u')) {
			const cutoff = String(bound[0]);
			const limit = Number(bound[1] ?? 10);
			return [...this.users.values()]
				.filter((u) => u.encrypted_refresh_token)
				.filter((u) => {
					const seen = [...this.prefs.values()].some(
						(p) => p.user_id === u.id && p.subscription_seen_at && String(p.subscription_seen_at) > cutoff,
					);
					return !seen;
				})
				.slice(0, limit);
		}
		if (normalized.includes('SELECT search_calls FROM api_quota_daily')) {
			const day = String(bound[0]);
			const endpoint = bound.length > 1 ? String(bound[1]) : 'search.list';
			const row = this.quota.find((item) => item.day === day && item.endpoint === endpoint);
			return row ? [{ search_calls: row.search_calls ?? 0 }] : [];
		}
		if (normalized.includes('FROM discover_search_cache WHERE cache_key = ?')) {
			const row = this.discoverSearchCache.get(String(bound[0]));
			return row ? [row] : [];
		}
		if (normalized.includes('FROM topic_discovery_cache WHERE normalized_topic = ?')) {
			const row = this.topicDiscoveryCache.get(String(bound[0]));
			if (!row) return [];
			return [
				{
					results_json: row.results_json,
					searched_at: row.searched_at,
					expires_at: row.expires_at,
					next_page_token: row.next_page_token ?? null,
				},
			];
		}
		if (normalized.includes('FROM recommendation_feedback') && normalized.includes('channel_title')) {
			const userId = String(bound[0]);
			let rows = this.recommendationFeedback.filter((row) => row.user_id === userId);
			if (normalized.includes("action = 'channel_not_interested'")) {
				rows = rows.filter((row) => row.action === 'channel_not_interested');
			} else if (normalized.includes("action = 'not_relevant'")) {
				rows = rows.filter((row) => row.action === 'not_relevant');
			} else if (normalized.includes("action IN ('channel_not_interested', 'not_relevant')")) {
				rows = rows.filter((row) => row.action === 'channel_not_interested' || row.action === 'not_relevant');
			}
			if (normalized.includes('restored_at IS NULL') && !normalized.includes('IS NOT NULL')) {
				rows = rows.filter((row) => row.restored_at == null);
			} else if (normalized.includes('restored_at IS NOT NULL')) {
				rows = rows.filter((row) => row.restored_at != null);
			}
			rows = rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
			const limit = Number(bound[bound.length - 1] ?? 100);
			return rows.slice(0, limit);
		}
		if (
			normalized.includes('FROM recommendation_feedback') &&
			normalized.includes('SELECT provider, external_id') &&
			normalized.includes('restored_at IS NULL')
		) {
			const userId = String(bound[0]);
			return this.recommendationFeedback
				.filter(
					(row) =>
						row.user_id === userId &&
						row.restored_at == null &&
						(row.action === 'channel_not_interested' || row.action === 'not_relevant'),
				)
				.map((row) => ({ provider: row.provider, external_id: row.external_id }));
		}
		if (normalized.includes('FROM recommendation_feedback') && normalized.includes('restored_at IS NULL')) {
			const userId = String(bound[0]);
			if (normalized.includes("action IN ('not_relevant', 'followed')")) {
				return this.recommendationFeedback
					.filter(
						(row) =>
							row.user_id === userId &&
							row.restored_at == null &&
							(row.action === 'not_relevant' || row.action === 'followed'),
					)
					.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
			}
		}
		if (normalized.includes('FROM recommendation_feedback') && normalized.includes('WHERE id = ? AND user_id = ?')) {
			const id = String(bound[0]);
			const userId = String(bound[1]);
			const row = this.recommendationFeedback.find((item) => item.id === id && item.user_id === userId);
			return row ? [{ id: row.id, restored_at: row.restored_at ?? null }] : [];
		}
		if (normalized.includes('FROM discover_browse_cache WHERE section_key = ?')) {
			const row = this.discoverBrowseCache.get(String(bound[0]));
			return row ? [row] : [];
		}
		if (normalized.includes('SELECT c.name, COUNT(cc.channel_id) AS channel_count')) {
			const userId = String(bound[0]);
			const counts = new Map<string, number>();
			for (const row of this.channelCategories) {
				if (row.user_id !== userId) continue;
				const cat = this.categories.get(String(row.category_id));
				if (!cat) continue;
				const pref = this.prefs.get(prefKey(userId, String(row.channel_id)));
				if (!pref || pref.is_subscribed !== 1) continue;
				counts.set(String(cat.name), (counts.get(String(cat.name)) ?? 0) + 1);
			}
			return [...counts.entries()].map(([name, channel_count]) => ({ name, channel_count }));
		}
		if (normalized.includes('SELECT c.id, c.name, COUNT(cc.channel_id) AS channel_count')) {
			const userId = String(bound[0]);
			const minCount = Number(bound[1] ?? 2);
			const counts = new Map<string, { id: string; name: string; channel_count: number }>();
			for (const row of this.channelCategories) {
				if (row.user_id !== userId) continue;
				const cat = this.categories.get(String(row.category_id));
				if (!cat) continue;
				const pref = this.prefs.get(prefKey(userId, String(row.channel_id)));
				if (!pref || pref.is_subscribed !== 1) continue;
				const key = String(cat.id);
				const existing = counts.get(key) ?? { id: key, name: String(cat.name), channel_count: 0 };
				existing.channel_count += 1;
				counts.set(key, existing);
			}
			return [...counts.values()].filter((row) => row.channel_count >= minCount);
		}
		if (normalized.includes('FROM channel_categories cc') && normalized.includes('cc.category_id = ?')) {
			const userId = String(bound[0]);
			const categoryId = String(bound[1]);
			return this.channelCategories
				.filter((row) => row.user_id === userId && row.category_id === categoryId)
				.map((row) => {
					const ch = this.channels.get(String(row.channel_id));
					const pref = this.prefs.get(prefKey(userId, String(row.channel_id)));
					if (!pref || pref.is_subscribed !== 1 || !ch) return null;
					return {
						channel_id: row.channel_id,
						title: ch.title ?? row.channel_id,
						description: ch.description ?? '',
					};
				})
				.filter(Boolean);
		}
		if (normalized.includes('FROM inbox_state i') && normalized.includes('description_excerpt')) {
			const userId = String(bound[0]);
			const channelIds = bound.slice(1).map(String);
			const allowed = new Set(channelIds);
			const counts = new Map<string, number>();
			return [...this.inbox.values()]
				.filter((row) => row.user_id === userId && row.hidden !== 1)
				.map((row) => {
					const video = this.videos.get(String(row.video_id));
					if (!video || !allowed.has(String(video.channel_id))) return null;
					const channelId = String(video.channel_id);
					const n = counts.get(channelId) ?? 0;
					if (n >= 15) return null;
					counts.set(channelId, n + 1);
					return {
						channel_id: channelId,
						title: video.title ?? '',
						description_excerpt: video.description_excerpt ?? '',
						published_at: video.published_at ?? '',
					};
				})
				.filter(Boolean)
				.sort((a, b) => String((b as Row).published_at).localeCompare(String((a as Row).published_at)));
		}
		if (normalized.includes('FROM inbox_state i') && normalized.includes('JOIN videos v ON v.video_id = i.video_id') && normalized.includes('LIMIT ?')) {
			const userId = String(bound[0]);
			const limit = Number(bound[1] ?? 50);
			return [...this.inbox.values()]
				.filter((row) => row.user_id === userId && row.hidden !== 1)
				.map((row) => {
					const video = this.videos.get(String(row.video_id));
					return { title: video?.title ?? '', published_at: video?.published_at ?? '' };
				})
				.filter((row) => row.title)
				.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
				.slice(0, limit)
				.map((row) => ({ title: row.title }));
		}
		if (normalized.includes('FROM channel_prefs p') && normalized.includes('JOIN channels c ON c.channel_id = p.channel_id') && normalized.includes('p.is_subscribed = 1')) {
			const userId = String(bound[0]);
			return [...this.prefs.values()]
				.filter((p) => p.user_id === userId && p.is_subscribed === 1)
				.map((p) => {
					const ch = this.channels.get(String(p.channel_id));
					return {
						channel_id: p.channel_id,
						title: ch?.title ?? p.channel_id,
						description: ch?.description ?? '',
						thumbnail_url: ch?.thumbnail_url ?? '',
						uploads_playlist_id: ch?.uploads_playlist_id ?? null,
						subscribed: 1,
						last_synchronized_at: ch?.last_synchronized_at ?? null,
						follow_in_inbox: p.follow_in_inbox ?? 1,
						max_videos_to_pull: p.max_videos_to_pull ?? 0,
					};
				})
				.sort((a, b) => String(a.title).localeCompare(String(b.title)));
		}
		if (normalized.includes('SELECT channel_id, category_id FROM channel_categories WHERE user_id = ?')) {
			const userId = String(bound[0]);
			return this.channelCategories.filter((row) => row.user_id === userId);
		}
		if (normalized.includes('SELECT channel_id FROM channel_prefs WHERE user_id = ? AND is_subscribed = 1')) {
			const userId = String(bound[0]);
			return [...this.prefs.values()]
				.filter((p) => p.user_id === userId && p.is_subscribed === 1)
				.map((p) => ({ channel_id: p.channel_id }));
		}
		if (normalized.includes('ORDER BY p.subscription_seen_at DESC')) {
			const userId = String(bound[0]);
			const limit = Number(bound[1] ?? 12);
			return [...this.prefs.values()]
				.filter((p) => p.user_id === userId && p.is_subscribed === 1)
				.sort((a, b) => String(b.subscription_seen_at ?? '').localeCompare(String(a.subscription_seen_at ?? '')))
				.slice(0, limit)
				.map((p) => {
					const ch = this.channels.get(String(p.channel_id));
					return {
						channel_id: p.channel_id,
						title: ch?.title ?? 'Channel',
						thumbnail_url: ch?.thumbnail_url ?? '',
						description: ch?.description ?? '',
						subscription_seen_at: p.subscription_seen_at ?? null,
					};
				});
		}
		if (normalized.includes('SELECT is_subscribed FROM channel_prefs WHERE user_id = ? AND channel_id = ?')) {
			const key = prefKey(String(bound[0]), String(bound[1]));
			const pref = this.prefs.get(key);
			return pref && pref.is_subscribed === 1 ? [{ is_subscribed: 1 }] : [];
		}
		if (normalized.includes('SELECT uploads_playlist_id FROM channels WHERE channel_id = ?')) {
			const ch = this.channels.get(String(bound[0]));
			return ch ? [{ uploads_playlist_id: ch.uploads_playlist_id ?? null }] : [];
		}
		return [];
	}
}

export function asEnv(db: MemorySyncDb, extras?: Partial<Env>): Env {
	return { DB: db as unknown as D1Database, ...extras } as Env;
}
