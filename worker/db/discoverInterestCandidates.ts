import { randomToken } from '../auth/crypto';
import type { DiscoverRecommendation } from '../../src/types/discover';

export type DiscoverInterestCandidateSource = 'discovered' | 'browse_popular' | 'global_fallback';

export type InactiveReason =
	| 'user_action'
	| 'relevance_drift'
	| 'global_fallback_cleanup'
	| 'explicit_refresh';

export interface DiscoverInterestCandidateRow {
	id: string;
	user_id: string;
	interest_id: string;
	interest_label: string;
	provider: string;
	external_id: string;
	channel_title: string;
	channel_thumbnail: string;
	channel_description: string;
	source: DiscoverInterestCandidateSource;
	recommendation_reason: string;
	dismissed_at: string | null;
	created_at: string;
	originating_query: string;
	matched_concepts_json: string;
	base_relevance_score: number;
	discovered_at: string | null;
	last_presented_at: string | null;
	acted_at: string | null;
	inactive_reason: InactiveReason | null;
}

export interface DiscoverInterestCandidateInsert {
	interestId: string;
	interestLabel: string;
	provider: string;
	externalId: string;
	channelTitle: string;
	channelThumbnail: string;
	channelDescription: string;
	source: DiscoverInterestCandidateSource;
	recommendationReason: string;
	originatingQuery: string;
	matchedConceptsJson: string;
	baseRelevanceScore: number;
}

export const FOR_YOU_GLOBAL_INTEREST_ID = '__global__';

const SELECT_COLUMNS = `id, user_id, interest_id, interest_label, provider, external_id,
	channel_title, channel_thumbnail, channel_description, source,
	recommendation_reason, dismissed_at, created_at,
	originating_query, matched_concepts_json, base_relevance_score,
	discovered_at, last_presented_at, acted_at, inactive_reason`;

export async function loadActiveInterestCandidates(
	db: D1Database,
	userId: string,
	interestId?: string,
): Promise<DiscoverInterestCandidateRow[]> {
	let sql = `SELECT ${SELECT_COLUMNS}
	           FROM discover_interest_candidates
	           WHERE user_id = ? AND dismissed_at IS NULL`;
	const binds: unknown[] = [userId];
	if (interestId) {
		sql += ` AND interest_id = ?`;
		binds.push(interestId);
	}
	sql += ` ORDER BY discovered_at ASC, created_at ASC`;
	const rows = await db.prepare(sql).bind(...binds).all<DiscoverInterestCandidateRow>();
	return rows.results ?? [];
}

export async function hasActiveInterestCandidates(
	db: D1Database,
	userId: string,
	interestId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM discover_interest_candidates
			 WHERE user_id = ? AND interest_id = ? AND dismissed_at IS NULL LIMIT 1`,
		)
		.bind(userId, interestId)
		.first<{ ok: number }>();
	return Boolean(row?.ok);
}

export async function upsertInterestCandidates(
	db: D1Database,
	userId: string,
	inputs: DiscoverInterestCandidateInsert[],
	now = new Date(),
): Promise<void> {
	const createdAt = now.toISOString();
	for (const input of inputs) {
		const id = randomToken(16);
		await db
			.prepare(
				`INSERT INTO discover_interest_candidates (
					id, user_id, interest_id, interest_label, provider, external_id,
					channel_title, channel_thumbnail, channel_description, source,
					recommendation_reason, dismissed_at, created_at,
					originating_query, matched_concepts_json, base_relevance_score,
					discovered_at, last_presented_at, acted_at, inactive_reason
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL)
				ON CONFLICT(user_id, interest_id, provider, external_id) DO UPDATE SET
					channel_title = excluded.channel_title,
					channel_thumbnail = excluded.channel_thumbnail,
					channel_description = excluded.channel_description,
					source = excluded.source,
					recommendation_reason = excluded.recommendation_reason,
					originating_query = excluded.originating_query,
					matched_concepts_json = excluded.matched_concepts_json,
					base_relevance_score = excluded.base_relevance_score,
					dismissed_at = NULL,
					inactive_reason = NULL,
					acted_at = NULL,
					interest_label = excluded.interest_label`,
			)
			.bind(
				id,
				userId,
				input.interestId,
				input.interestLabel,
				input.provider,
				input.externalId,
				input.channelTitle,
				input.channelThumbnail,
				input.channelDescription,
				input.source,
				input.recommendationReason,
				createdAt,
				input.originatingQuery,
				input.matchedConceptsJson,
				input.baseRelevanceScore,
				createdAt,
			)
			.run();
	}
}

export async function dismissInterestCandidate(
	db: D1Database,
	userId: string,
	provider: string,
	externalId: string,
	now = new Date(),
	reason: InactiveReason = 'user_action',
): Promise<void> {
	const dismissedAt = now.toISOString();
	await db
		.prepare(
			`UPDATE discover_interest_candidates
			 SET dismissed_at = ?, acted_at = ?, inactive_reason = ?
			 WHERE user_id = ? AND provider = ? AND external_id = ? AND dismissed_at IS NULL`,
		)
		.bind(dismissedAt, dismissedAt, reason, userId, provider, externalId)
		.run();
}

export async function retireInterestCandidateByRelevance(
	db: D1Database,
	userId: string,
	candidateId: string,
	now = new Date(),
): Promise<void> {
	const dismissedAt = now.toISOString();
	await db
		.prepare(
			`UPDATE discover_interest_candidates
			 SET dismissed_at = ?, acted_at = ?, inactive_reason = 'relevance_drift'
			 WHERE user_id = ? AND id = ? AND dismissed_at IS NULL`,
		)
		.bind(dismissedAt, dismissedAt, userId, candidateId)
		.run();
}

export async function reactivateInterestCandidate(
	db: D1Database,
	userId: string,
	provider: string,
	externalId: string,
	interestId?: string,
): Promise<boolean> {
	let sql = `UPDATE discover_interest_candidates
	           SET dismissed_at = NULL, acted_at = NULL, inactive_reason = NULL
	           WHERE user_id = ? AND provider = ? AND external_id = ?`;
	const binds: unknown[] = [userId, provider, externalId];
	if (interestId) {
		sql += ` AND interest_id = ?`;
		binds.push(interestId);
	}
	const result = await db.prepare(sql).bind(...binds).run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function markInterestCandidatesPresented(
	db: D1Database,
	userId: string,
	candidateIds: string[],
	now = new Date(),
): Promise<void> {
	if (!candidateIds.length) return;
	const presentedAt = now.toISOString();
	const placeholders = candidateIds.map(() => '?').join(', ');
	await db
		.prepare(
			`UPDATE discover_interest_candidates
			 SET last_presented_at = ?
			 WHERE user_id = ? AND id IN (${placeholders})`,
		)
		.bind(presentedAt, userId, ...candidateIds)
		.run();
}

export function candidateRowToRecommendation(row: DiscoverInterestCandidateRow): DiscoverRecommendation {
	return {
		provider: row.provider as DiscoverRecommendation['provider'],
		type: 'channel',
		externalId: row.external_id,
		title: row.channel_title,
		description: row.channel_description || undefined,
		imageUrl: row.channel_thumbnail || undefined,
		publisher: row.channel_title,
		subscribed: false,
		watchUrl: `https://www.youtube.com/channel/${row.external_id}`,
		recommendationReason: row.recommendation_reason,
		interestId: row.interest_id,
		interestLabel: row.interest_label,
	};
}
