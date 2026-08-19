import type { RecommendationFeedbackRow } from '../../db/recommendationFeedback';
import { parseMatchedConcepts } from '../../db/recommendationFeedback';
import type { CandidateScoreDebug } from './candidateScoring';
import { AMBIGUOUS_UNIGRAMS } from './phraseExtract';

export const FEEDBACK_NEGATIVE_CAP = 12;
export const FEEDBACK_POSITIVE_CAP = 10;
const NOT_RELEVANT_AMBIGUOUS_WEIGHT = 3;
const NOT_RELEVANT_TERM_WEIGHT = 1;
const FOLLOWED_CONCEPT_WEIGHT = 2;

export interface FeedbackAdjustmentIndex {
	negativeByInterestConcept: Map<string, number>;
	positiveByInterestConcept: Map<string, number>;
	contributingByKey: Map<string, string[]>;
}

function conceptKey(interestId: string, conceptText: string): string {
	return `${interestId}:${conceptText.toLowerCase()}`;
}

function normalizeConceptLabel(raw: string): string {
	return raw
		.replace(/ \(title\)$/, '')
		.replace(/^phrase "/, '')
		.replace(/"$/, '')
		.trim()
		.toLowerCase();
}

export function buildFeedbackAdjustmentIndex(rows: RecommendationFeedbackRow[]): FeedbackAdjustmentIndex {
	const negativeByInterestConcept = new Map<string, number>();
	const positiveByInterestConcept = new Map<string, number>();
	const contributingByKey = new Map<string, string[]>();

	for (const row of rows) {
		if (!row.interest_id) continue;
		const concepts = parseMatchedConcepts(row.matched_concepts_json);
		for (const concept of concepts) {
			const key = conceptKey(row.interest_id, concept.text);
			if (row.action === 'not_relevant') {
				const delta = concept.ambiguous || AMBIGUOUS_UNIGRAMS.has(concept.text) ? NOT_RELEVANT_AMBIGUOUS_WEIGHT : NOT_RELEVANT_TERM_WEIGHT;
				negativeByInterestConcept.set(key, (negativeByInterestConcept.get(key) ?? 0) + delta);
				const ids = contributingByKey.get(key) ?? [];
				ids.push(row.id);
				contributingByKey.set(key, ids);
			} else if (row.action === 'followed') {
				positiveByInterestConcept.set(key, (positiveByInterestConcept.get(key) ?? 0) + FOLLOWED_CONCEPT_WEIGHT);
				const ids = contributingByKey.get(key) ?? [];
				ids.push(row.id);
				contributingByKey.set(key, ids);
			}
		}
	}

	return { negativeByInterestConcept, positiveByInterestConcept, contributingByKey };
}

export function computeFeedbackAdjustment(
	debug: CandidateScoreDebug,
	index: FeedbackAdjustmentIndex,
): { positive: number; negative: number; total: number; contributingFeedbackIds: string[] } {
	const interestId = debug.interestId;
	let positive = 0;
	let negative = 0;
	const contributing = new Set<string>();

	for (const match of debug.positive) {
		const text = normalizeConceptLabel(match);
		if (!text) continue;
		const key = conceptKey(interestId, text);
		const pos = index.positiveByInterestConcept.get(key) ?? 0;
		const neg = index.negativeByInterestConcept.get(key) ?? 0;
		if (pos > 0) {
			positive += pos;
			for (const id of index.contributingByKey.get(key) ?? []) contributing.add(id);
		}
		if (neg > 0) {
			negative += neg;
			for (const id of index.contributingByKey.get(key) ?? []) contributing.add(id);
		}
	}

	positive = Math.min(positive, FEEDBACK_POSITIVE_CAP);
	negative = Math.min(negative, FEEDBACK_NEGATIVE_CAP);
	const total = Math.max(-FEEDBACK_NEGATIVE_CAP, Math.min(FEEDBACK_POSITIVE_CAP, positive - negative));
	return {
		positive,
		negative,
		total,
		contributingFeedbackIds: [...contributing],
	};
}
