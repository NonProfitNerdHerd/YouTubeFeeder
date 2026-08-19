import { listCategoryChannelCounts, listRecentInboxVideoTitles, listSubscribedChannels } from '../../db/queries';

export type InterestTopicSource = 'category' | 'metadata' | 'titles';

export interface InterestTopic {
	topic: string;
	score: number;
	source: InterestTopicSource;
	reasonLabel: string;
}

const STOP_WORDS = new Set([
	'video',
	'videos',
	'channel',
	'channels',
	'official',
	'youtube',
	'new',
	'today',
	'live',
	'the',
	'and',
	'for',
	'with',
	'from',
	'that',
	'this',
	'your',
	'our',
	'are',
	'was',
	'has',
	'have',
	'been',
	'will',
	'can',
	'all',
	'get',
	'how',
	'what',
	'when',
	'where',
	'who',
	'why',
	'not',
	'but',
	'you',
	'its',
	'into',
	'out',
	'about',
	'more',
	'most',
	'just',
	'also',
	'www',
	'com',
]);

const MIN_SUBSCRIBED_CHANNELS = 3;
const MIN_MEANINGFUL_TOPICS = 2;
const MAX_TOPICS = 8;

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s'-]/g, ' ')
		.split(/\s+/)
		.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function addScore(scores: Map<string, { score: number; source: InterestTopicSource; reasonLabel: string }>, token: string, weight: number, source: InterestTopicSource, reasonLabel: string) {
	const key = token.trim().toLowerCase();
	if (!key || key.length < 3 || STOP_WORDS.has(key)) return;
	const existing = scores.get(key);
	if (existing) {
		existing.score += weight;
		if (source === 'category' || (source === 'metadata' && existing.source === 'titles')) {
			existing.source = source;
			existing.reasonLabel = reasonLabel;
		}
	} else {
		scores.set(key, { score: weight, source, reasonLabel });
	}
}

export async function buildInterestProfile(db: D1Database, userId: string): Promise<InterestTopic[]> {
	const [categories, channels, titles] = await Promise.all([
		listCategoryChannelCounts(db, userId),
		listSubscribedChannels(db, userId),
		listRecentInboxVideoTitles(db, userId),
	]);

	if (channels.length < MIN_SUBSCRIBED_CHANNELS) return [];

	const scores = new Map<string, { score: number; source: InterestTopicSource; reasonLabel: string }>();

	for (const category of categories) {
		const label = category.name.trim();
		if (!label) continue;
		for (const token of tokenize(label)) {
			addScore(scores, token, 10 * category.channelCount, 'category', label);
		}
	}

	for (const channel of channels) {
		const text = `${channel.title} ${channel.description ?? ''}`;
		for (const token of tokenize(text)) {
			addScore(scores, token, 3, 'metadata', channel.title);
		}
	}

	for (const title of titles) {
		for (const token of tokenize(title)) {
			addScore(scores, token, 1, 'titles', token.charAt(0).toUpperCase() + token.slice(1));
		}
	}

	const topics = [...scores.entries()]
		.map(([topic, meta]) => ({
			topic,
			score: meta.score,
			source: meta.source,
			reasonLabel: meta.reasonLabel,
		}))
		.sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic))
		.slice(0, MAX_TOPICS);

	if (topics.length < MIN_MEANINGFUL_TOPICS) return [];
	return topics;
}

export function isInterestProfileEmpty(topics: InterestTopic[]): boolean {
	return topics.length < MIN_MEANINGFUL_TOPICS;
}
