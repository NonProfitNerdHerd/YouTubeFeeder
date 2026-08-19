import { randomToken } from '../auth/crypto';
import type { DiscoverRecommendation } from '../../src/types/discover';

export type DiscoverInterestCandidateSource = 'browse_popular' | 'global_fallback';

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
}

export const FOR_YOU_GLOBAL_INTEREST_ID = '__global__';

export async function loadActiveInterestCandidates(
	db: D1Database,
	userId: string,
	interestId?: string,
): Promise<DiscoverInterestCandidateRow[]> {
	let sql = `SELECT id, user_id, interest_id, interest_label, provider, external_id,
	                  channel_title, channel_thumbnail, channel_description, source,
	                  recommendation_reason, dismissed_at, created_at
	           FROM discover_interest_candidates
	           WHERE user_id = ? AND dismissed_at IS NULL`;
	const binds: unknown[] = [userId];
	if (interestId) {
		sql += ` AND interest_id = ?`;
		binds.push(interestId);
	}
	sql += ` ORDER BY created_at ASC`;
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
					recommendation_reason, dismissed_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
				ON CONFLICT(user_id, interest_id, provider, external_id) DO UPDATE SET
					channel_title = excluded.channel_title,
					channel_thumbnail = excluded.channel_thumbnail,
					channel_description = excluded.channel_description,
					source = excluded.source,
					recommendation_reason = excluded.recommendation_reason,
					dismissed_at = NULL,
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
): Promise<void> {
	const dismissedAt = now.toISOString();
	await db
		.prepare(
			`UPDATE discover_interest_candidates
			 SET dismissed_at = ?
			 WHERE user_id = ? AND provider = ? AND external_id = ? AND dismissed_at IS NULL`,
		)
		.bind(dismissedAt, userId, provider, externalId)
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
