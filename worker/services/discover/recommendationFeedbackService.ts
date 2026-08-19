import {
	insertRecommendationFeedback,
	listRecommendationHistory,
	loadActiveFeedbackRows,
	restoreRecommendationFeedback,
	type RecommendationFeedbackAction,
	type RecommendationFeedbackRow,
	type RecommendationHistoryOpts,
} from '../../db/recommendationFeedback';
import {
	mintRecommendationToken,
	verifyRecommendationToken,
	type MatchedConcept,
	type RecommendationTokenPayload,
} from './recommendationToken';
import { AMBIGUOUS_UNIGRAMS } from './phraseExtract';
import type { InterestFingerprint } from './interestFingerprint';
import type { CandidateScoreDebug, ScoredCandidate } from './candidateScoring';

export type { RecommendationFeedbackAction, RecommendationHistoryOpts, RecommendationFeedbackRow };

export const FEEDBACK_ACTION_LABELS: Record<RecommendationFeedbackAction, string> = {
	followed: 'Followed from For You',
	channel_not_interested: 'Not interested in this channel',
	not_relevant: 'Not relevant to this topic',
};

export function matchedConceptsFromDebug(
	debug: CandidateScoreDebug,
	fingerprint: InterestFingerprint,
): MatchedConcept[] {
	const concepts: MatchedConcept[] = [];
	for (const match of debug.positive) {
		const text = match
			.replace(/ \(title\)$/, '')
			.replace(/^phrase "/, '')
			.replace(/"$/, '')
			.trim()
			.toLowerCase();
		if (!text) continue;
		const ambiguous = fingerprint.terms.some(
			(term) => term.text === text && (term.ambiguous || AMBIGUOUS_UNIGRAMS.has(term.text)),
		);
		concepts.push({ text, ambiguous });
	}
	return concepts;
}

export async function mintTokenForScoredCandidate(
	secret: string,
	userId: string,
	row: ScoredCandidate,
	fingerprint: InterestFingerprint,
): Promise<string> {
	return mintRecommendationToken(secret, {
		userId,
		provider: row.result.provider,
		externalId: row.result.externalId,
		channelTitle: row.result.title,
		channelThumbnail: row.result.imageUrl ?? '',
		interestId: row.interestId,
		interestLabel: row.interestLabel,
		baseScore: row.score,
		matchedConcepts: matchedConceptsFromDebug(row.debug, fingerprint),
		recommendationReason: row.recommendationReason,
	});
}

function payloadToInsert(userId: string, action: RecommendationFeedbackAction, payload: RecommendationTokenPayload) {
	return {
		userId,
		provider: payload.provider,
		externalId: payload.externalId,
		channelTitle: payload.channelTitle,
		channelThumbnail: payload.channelThumbnail,
		interestId: payload.interestId,
		interestLabel: payload.interestLabel,
		action,
		matchedConcepts: payload.matchedConcepts,
		recommendationReason: payload.recommendationReason,
		baseScore: payload.baseScore,
	};
}

export async function submitRecommendationFeedback(
	env: Env,
	userId: string,
	action: RecommendationFeedbackAction,
	recommendationToken: string,
): Promise<{ ok: true; feedback: RecommendationFeedbackRow } | { ok: false; code: string }> {
	const secret = env.SESSION_SECRET;
	if (!secret) return { ok: false, code: 'misconfigured' };

	const payload = await verifyRecommendationToken(secret, recommendationToken, userId);
	if (!payload) return { ok: false, code: 'invalid_token' };

	if (action !== 'channel_not_interested' && action !== 'not_relevant' && action !== 'followed') {
		return { ok: false, code: 'invalid_action' };
	}

	const feedback = await insertRecommendationFeedback(env.DB, payloadToInsert(userId, action, payload));
	return { ok: true, feedback };
}

export async function recordFollowFeedbackFromToken(
	env: Env,
	userId: string,
	recommendationToken: string,
	channelId: string,
): Promise<{ ok: true; feedback: RecommendationFeedbackRow } | { ok: false; code: string }> {
	const secret = env.SESSION_SECRET;
	if (!secret) return { ok: false, code: 'misconfigured' };

	const payload = await verifyRecommendationToken(secret, recommendationToken, userId);
	if (!payload) return { ok: false, code: 'invalid_token' };
	if (payload.externalId !== channelId) return { ok: false, code: 'token_channel_mismatch' };

	const feedback = await insertRecommendationFeedback(env.DB, payloadToInsert(userId, 'followed', payload));
	return { ok: true, feedback };
}

export async function restoreFeedback(
	env: Env,
	userId: string,
	feedbackId: string,
): Promise<{ ok: true; restoredAt: string } | { ok: false; code: string }> {
	const result = await restoreRecommendationFeedback(env.DB, userId, feedbackId);
	if (!result.ok) {
		return { ok: false, code: result.reason === 'already_restored' ? 'already_restored' : 'not_found' };
	}
	return { ok: true, restoredAt: result.restoredAt };
}

export async function getRecommendationHistory(env: Env, userId: string, opts?: RecommendationHistoryOpts) {
	const rows = await listRecommendationHistory(env.DB, userId, opts);
	return rows.map((row) => ({
		id: row.id,
		provider: row.provider,
		externalId: row.external_id,
		channelTitle: row.channel_title,
		channelThumbnail: row.channel_thumbnail,
		interestId: row.interest_id,
		interestLabel: row.interest_label,
		action: row.action,
		actionLabel: FEEDBACK_ACTION_LABELS[row.action],
		recommendationReason: row.recommendation_reason,
		createdAt: row.created_at,
		restoredAt: row.restored_at,
		active: row.restored_at == null,
	}));
}

export { loadActiveFeedbackRows, loadActiveSuppressions } from '../../db/recommendationFeedback';
