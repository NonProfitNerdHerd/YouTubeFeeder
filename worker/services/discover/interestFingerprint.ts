import { listInterestCategories, listSubscribedChannels } from '../../db/queries';
import { buildInterestCorpus } from './interestCorpus';
import { buildConceptClusters, type ConceptCluster } from './conceptClustering';
import { buildInterestSearchQueries, type ClusterQuery } from './clusterQueries';
import {
	extractPhrasesFromChannelDocuments,
	extractTermsFromChannelDocuments,
	type WeightedPhrase,
	type WeightedTerm,
} from './phraseExtract';

export interface InterestFingerprint {
	interestId: string;
	label: string;
	phrases: WeightedPhrase[];
	terms: WeightedTerm[];
	negativeHints: string[];
	channelCount: number;
	confidence: number;
	videosSampled?: number;
	clusters?: ConceptCluster[];
	queries?: ClusterQuery[];
}

export const MIN_CHANNELS_PER_INTEREST = 2;
export const MIN_INTERESTS = 1;

function computeConfidence(channelCount: number, videoCount: number, topPhraseWeight: number): number {
	return channelCount * 10 + videoCount + Math.min(topPhraseWeight, 50);
}

export async function buildInterestFingerprints(db: D1Database, userId: string): Promise<InterestFingerprint[]> {
	const categories = await listInterestCategories(db, userId, MIN_CHANNELS_PER_INTEREST);
	const subscribedCount = (await listSubscribedChannels(db, userId)).length;
	if (subscribedCount < 3) return [];

	const fingerprints: InterestFingerprint[] = [];

	for (const category of categories) {
		const corpus = await buildInterestCorpus(db, userId, category.id, category.name);
		const phrasesWithCoverage = extractPhrasesFromChannelDocuments(corpus.channelDocuments, [category.name]).slice(0, 16);
		const phrases: WeightedPhrase[] = phrasesWithCoverage.map(({ text, weight }) => ({ text, weight }));
		const phraseTexts = new Set(phrases.map((row) => row.text));
		const terms = extractTermsFromChannelDocuments(corpus.channelDocuments)
			.filter((term) => !phraseTexts.has(term.text))
			.slice(0, 20);

		const clusters = buildConceptClusters(phrasesWithCoverage, corpus.channelDocuments);
		const draft: InterestFingerprint = {
			interestId: category.id,
			label: category.name,
			phrases,
			terms,
			negativeHints: [],
			channelCount: corpus.channelCount,
			confidence: 0,
			videosSampled: corpus.videosSampled,
			clusters,
		};
		draft.confidence = computeConfidence(corpus.channelCount, corpus.videosSampled, phrases[0]?.weight ?? 0);
		if (draft.confidence < 20) continue;
		draft.queries = buildInterestSearchQueries(draft);

		fingerprints.push(draft);
	}

	return fingerprints.sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));
}

export function isInterestFingerprintEmpty(fingerprints: InterestFingerprint[]): boolean {
	return fingerprints.length < MIN_INTERESTS;
}
