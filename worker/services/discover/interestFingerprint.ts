import {
	listCategoryChannelCorpus,
	listInterestCategories,
	listRecentInboxContentForChannels,
	listSubscribedChannels,
} from '../../db/queries';
import { extractPhrasesFromDocuments, extractTermsFromDocuments, type WeightedPhrase, type WeightedTerm } from './phraseExtract';

export interface InterestFingerprint {
	interestId: string;
	label: string;
	phrases: WeightedPhrase[];
	terms: WeightedTerm[];
	negativeHints: string[];
	channelCount: number;
	confidence: number;
}

export const MIN_CHANNELS_PER_INTEREST = 2;
export const MIN_INTERESTS = 1;

function corpusDocuments(
	label: string,
	channels: Array<{ title: string; description: string }>,
	videos: Array<{ title: string; descriptionExcerpt: string }>,
): string[] {
	const docs: string[] = [label];
	for (const channel of channels) {
		docs.push(`${channel.title} ${channel.description}`);
	}
	for (const video of videos) {
		docs.push(`${video.title} ${video.descriptionExcerpt}`);
	}
	return docs.filter(Boolean);
}

function computeConfidence(channelCount: number, videoCount: number, topPhraseWeight: number): number {
	return channelCount * 10 + videoCount + Math.min(topPhraseWeight, 50);
}

export async function buildInterestFingerprints(db: D1Database, userId: string): Promise<InterestFingerprint[]> {
	const categories = await listInterestCategories(db, userId, MIN_CHANNELS_PER_INTEREST);
	const subscribedCount = (await listSubscribedChannels(db, userId)).length;
	if (subscribedCount < 3) return [];

	const fingerprints: InterestFingerprint[] = [];

	for (const category of categories) {
		const channels = await listCategoryChannelCorpus(db, userId, category.id);
		const channelIds = channels.map((row) => row.channelId);
		const videos = await listRecentInboxContentForChannels(db, userId, channelIds, 15);
		const documents = corpusDocuments(category.name, channels, videos);
		const phrases = extractPhrasesFromDocuments(documents, [category.name]).slice(0, 12);
		const phraseTexts = new Set(phrases.map((row) => row.text));
		const terms = extractTermsFromDocuments(documents)
			.filter((term) => !phraseTexts.has(term.text))
			.slice(0, 20);

		const topPhraseWeight = phrases[0]?.weight ?? 0;
		const confidence = computeConfidence(channels.length, videos.length, topPhraseWeight);
		if (confidence < 20) continue;

		fingerprints.push({
			interestId: category.id,
			label: category.name,
			phrases,
			terms,
			negativeHints: [],
			channelCount: category.channelCount,
			confidence,
		});
	}

	return fingerprints.sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));
}

export function isInterestFingerprintEmpty(fingerprints: InterestFingerprint[]): boolean {
	return fingerprints.length < MIN_INTERESTS;
}
