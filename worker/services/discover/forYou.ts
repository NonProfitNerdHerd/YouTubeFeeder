import type { DiscoverRecommendation } from '../../../src/types/discover';
import { getTopicDiscoveryCache } from '../../db/discoverCache';
import { getSubscribedChannelIds } from '../../db/queries';
import { buildInterestProfile, isInterestProfileEmpty, type InterestTopic } from './interestProfile';
import { normalizeTopic, refreshTopicCaches } from './topicDiscovery';

const MAX_FOR_YOU = 20;
const MAX_PER_TOPIC = 4;
const TOPICS_FOR_REFRESH = 2;
const TOPICS_TO_MERGE = 5;

function recommendationReason(topic: InterestTopic): string {
	if (topic.source === 'category') return `Because you follow ${topic.reasonLabel}`;
	return `Related to ${topic.reasonLabel}`;
}

function dedupeCandidates(
	candidates: Array<{ result: DiscoverRecommendation; topicScore: number; topicKey: string }>,
): Array<{ result: DiscoverRecommendation; topicKey: string }> {
	const byId = new Map<string, { result: DiscoverRecommendation; topicScore: number; topicKey: string }>();
	for (const candidate of candidates) {
		const existing = byId.get(candidate.result.externalId);
		if (!existing || candidate.topicScore > existing.topicScore) {
			byId.set(candidate.result.externalId, candidate);
		}
	}
	return [...byId.values()].map(({ result, topicKey }) => ({ result, topicKey }));
}

function diversifyByTopic(
	grouped: Map<string, DiscoverRecommendation[]>,
	maxTotal = MAX_FOR_YOU,
	maxPerTopic = MAX_PER_TOPIC,
): DiscoverRecommendation[] {
	const topicKeys = [...grouped.keys()];
	const picked: DiscoverRecommendation[] = [];
	const counts = new Map<string, number>();

	while (picked.length < maxTotal) {
		let added = false;
		for (const key of topicKeys) {
			const count = counts.get(key) ?? 0;
			if (count >= maxPerTopic) continue;
			const list = grouped.get(key) ?? [];
			const next = list[count];
			if (!next) continue;
			picked.push(next);
			counts.set(key, count + 1);
			added = true;
			if (picked.length >= maxTotal) break;
		}
		if (!added) break;
	}

	return picked;
}

export interface ForYouResult {
	forYou: DiscoverRecommendation[];
	forYouEmpty: boolean;
	forYouMessage?: string;
}

export async function buildForYouRecommendations(env: Env, userId: string, now = new Date()): Promise<ForYouResult> {
	const topics = await buildInterestProfile(env.DB, userId);
	if (isInterestProfileEmpty(topics)) {
		return {
			forYou: [],
			forYouEmpty: true,
			forYouMessage: 'Follow and categorize channels to improve For You.',
		};
	}

	const subscribed = await getSubscribedChannelIds(env.DB, userId);
	const refreshTopics = topics.slice(0, TOPICS_FOR_REFRESH).map((t) => t.topic);
	const mergeTopics = topics.slice(0, TOPICS_TO_MERGE);

	const cacheByTopic = await refreshTopicCaches(env, refreshTopics, now);
	for (const topic of mergeTopics.slice(TOPICS_FOR_REFRESH)) {
		const normalized = normalizeTopic(topic.topic);
		if (!normalized || cacheByTopic.has(normalized)) continue;
		const cached = await getTopicDiscoveryCache(env.DB, normalized, now);
		cacheByTopic.set(normalized, cached?.results ?? []);
	}

	const rawCandidates: Array<{ result: DiscoverRecommendation; topicScore: number; topicKey: string }> = [];

	for (const topic of mergeTopics) {
		const normalized = normalizeTopic(topic.topic);
		const results = cacheByTopic.get(normalized) ?? [];
		for (const row of results) {
			if (subscribed.has(row.externalId)) continue;
			rawCandidates.push({
				result: {
					...row,
					subscribed: false,
					recommendationReason: recommendationReason(topic),
				},
				topicScore: topic.score,
				topicKey: normalized,
			});
		}
	}

	const deduped = dedupeCandidates(rawCandidates);
	const grouped = new Map<string, DiscoverRecommendation[]>();

	for (const entry of deduped) {
		const list = grouped.get(entry.topicKey) ?? [];
		list.push(entry.result);
		grouped.set(entry.topicKey, list);
	}

	const forYou = diversifyByTopic(grouped);

	return {
		forYou,
		forYouEmpty: forYou.length === 0,
		forYouMessage: forYou.length === 0 ? 'Follow and categorize channels to improve For You.' : undefined,
	};
}
