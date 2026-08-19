import { randomToken } from '../auth/crypto';
import type { MatchedConcept } from '../services/discover/recommendationToken';

export type RecommendationFeedbackAction = 'followed' | 'channel_not_interested' | 'not_relevant';

export interface RecommendationFeedbackRow {
	id: string;
	user_id: string;
	provider: string;
	external_id: string;
	channel_title: string;
	channel_thumbnail: string;
	interest_id: string | null;
	interest_label: string | null;
	action: RecommendationFeedbackAction;
	matched_concepts_json: string;
	recommendation_reason: string | null;
	base_score: number | null;
	created_at: string;
	restored_at: string | null;
}

export interface RecommendationFeedbackInsert {
	userId: string;
	provider: string;
	externalId: string;
	channelTitle: string;
	channelThumbnail: string;
	interestId: string;
	interestLabel: string;
	action: RecommendationFeedbackAction;
	matchedConcepts: MatchedConcept[];
	recommendationReason: string;
	baseScore: number;
}

export interface RecommendationHistoryOpts {
	filter?: 'all' | 'channel' | 'not_relevant';
	status?: 'active' | 'restored' | 'all';
	query?: string;
	limit?: number;
}

function suppressionKey(provider: string, externalId: string): string {
	return `${provider}:${externalId}`;
}

export async function loadActiveSuppressions(db: D1Database, userId: string): Promise<Set<string>> {
	const rows = await db
		.prepare(
			`SELECT provider, external_id FROM recommendation_feedback
			 WHERE user_id = ? AND restored_at IS NULL
			   AND action IN ('channel_not_interested', 'not_relevant')`,
		)
		.bind(userId)
		.all<{ provider: string; external_id: string }>();
	const out = new Set<string>();
	for (const row of rows.results ?? []) {
		out.add(suppressionKey(row.provider, row.external_id));
	}
	return out;
}

export async function loadActiveFeedbackRows(db: D1Database, userId: string): Promise<RecommendationFeedbackRow[]> {
	const rows = await db
		.prepare(
			`SELECT id, user_id, provider, external_id, channel_title, channel_thumbnail,
			        interest_id, interest_label, action, matched_concepts_json, recommendation_reason,
			        base_score, created_at, restored_at
			 FROM recommendation_feedback
			 WHERE user_id = ? AND restored_at IS NULL
			   AND action IN ('not_relevant', 'followed')
			 ORDER BY created_at ASC`,
		)
		.bind(userId)
		.all<RecommendationFeedbackRow>();
	return rows.results ?? [];
}

export async function insertRecommendationFeedback(
	db: D1Database,
	input: RecommendationFeedbackInsert,
	now = new Date(),
): Promise<RecommendationFeedbackRow> {
	const id = randomToken(16);
	const createdAt = now.toISOString();
	await db
		.prepare(
			`INSERT INTO recommendation_feedback (
				id, user_id, provider, external_id, channel_title, channel_thumbnail,
				interest_id, interest_label, action, matched_concepts_json,
				recommendation_reason, base_score, created_at, restored_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			id,
			input.userId,
			input.provider,
			input.externalId,
			input.channelTitle,
			input.channelThumbnail,
			input.interestId,
			input.interestLabel,
			input.action,
			JSON.stringify(input.matchedConcepts),
			input.recommendationReason,
			input.baseScore,
			createdAt,
		)
		.run();
	return {
		id,
		user_id: input.userId,
		provider: input.provider,
		external_id: input.externalId,
		channel_title: input.channelTitle,
		channel_thumbnail: input.channelThumbnail,
		interest_id: input.interestId,
		interest_label: input.interestLabel,
		action: input.action,
		matched_concepts_json: JSON.stringify(input.matchedConcepts),
		recommendation_reason: input.recommendationReason,
		base_score: input.baseScore,
		created_at: createdAt,
		restored_at: null,
	};
}

export async function restoreRecommendationFeedback(
	db: D1Database,
	userId: string,
	feedbackId: string,
	now = new Date(),
): Promise<{ ok: true; restoredAt: string } | { ok: false; reason: 'not_found' | 'already_restored' }> {
	const row = await db
		.prepare(`SELECT id, restored_at FROM recommendation_feedback WHERE id = ? AND user_id = ?`)
		.bind(feedbackId, userId)
		.first<{ id: string; restored_at: string | null }>();
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.restored_at) return { ok: false, reason: 'already_restored' };
	const restoredAt = now.toISOString();
	await db
		.prepare(`UPDATE recommendation_feedback SET restored_at = ? WHERE id = ? AND user_id = ?`)
		.bind(restoredAt, feedbackId, userId)
		.run();
	return { ok: true, restoredAt };
}

export async function listRecommendationHistory(
	db: D1Database,
	userId: string,
	opts?: RecommendationHistoryOpts,
): Promise<RecommendationFeedbackRow[]> {
	const filter = opts?.filter ?? 'all';
	const status = opts?.status ?? 'active';
	const limit = Math.min(200, Math.max(1, opts?.limit ?? 100));
	const q = opts?.query?.trim().toLowerCase() ?? '';

	let sql = `SELECT id, user_id, provider, external_id, channel_title, channel_thumbnail,
	                  interest_id, interest_label, action, matched_concepts_json, recommendation_reason,
	                  base_score, created_at, restored_at
	           FROM recommendation_feedback
	           WHERE user_id = ?`;
	const binds: unknown[] = [userId];

	if (filter === 'channel') {
		sql += ` AND action = 'channel_not_interested'`;
	} else if (filter === 'not_relevant') {
		sql += ` AND action = 'not_relevant'`;
	} else {
		sql += ` AND action IN ('channel_not_interested', 'not_relevant')`;
	}

	if (status === 'active') {
		sql += ` AND restored_at IS NULL`;
	} else if (status === 'restored') {
		sql += ` AND restored_at IS NOT NULL`;
	}

	sql += ` ORDER BY created_at DESC LIMIT ?`;
	binds.push(limit);

	const rows = await db.prepare(sql).bind(...binds).all<RecommendationFeedbackRow>();
	let results = rows.results ?? [];
	if (q) {
		results = results.filter((row) => row.channel_title.toLowerCase().includes(q));
	}
	return results;
}

export function parseMatchedConcepts(json: string): MatchedConcept[] {
	try {
		const parsed = JSON.parse(json) as MatchedConcept[];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((row) => row && typeof row.text === 'string');
	} catch {
		return [];
	}
}
