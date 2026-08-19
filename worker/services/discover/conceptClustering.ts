import type { WeightedPhraseWithCoverage } from './phraseExtract';
import type { ChannelDocumentInput } from './phraseExtract';

export interface ConceptCluster {
	id: string;
	phrases: WeightedPhraseWithCoverage[];
	confidence: number;
}

function phraseInText(text: string, phrase: string): boolean {
	return text.includes(phrase);
}

export function buildConceptClusters(
	phrases: WeightedPhraseWithCoverage[],
	channelDocuments: ChannelDocumentInput[],
	maxClusters = 4,
): ConceptCluster[] {
	const eligible = phrases.filter((row) => row.channelCoverage >= 1).slice(0, 24);
	if (!eligible.length) return [];

	const coOccurrence = new Map<string, Map<string, number>>();
	for (const doc of channelDocuments) {
		const present = eligible.filter((phrase) => phraseInText(doc.text, phrase.text));
		for (let i = 0; i < present.length; i += 1) {
			for (let j = i + 1; j < present.length; j += 1) {
				const a = present[i]!.text;
				const b = present[j]!.text;
				const mapA = coOccurrence.get(a) ?? new Map<string, number>();
				mapA.set(b, (mapA.get(b) ?? 0) + 1);
				coOccurrence.set(a, mapA);
				const mapB = coOccurrence.get(b) ?? new Map<string, number>();
				mapB.set(a, (mapB.get(a) ?? 0) + 1);
				coOccurrence.set(b, mapB);
			}
		}
	}

	const used = new Set<string>();
	const clusters: ConceptCluster[] = [];

	for (const seed of eligible) {
		if (used.has(seed.text) || clusters.length >= maxClusters) continue;
		const members = [seed];
		used.add(seed.text);
		const neighbors = coOccurrence.get(seed.text);
		if (neighbors) {
			const sorted = [...neighbors.entries()].sort((a, b) => b[1] - a[1]);
			for (const [neighborText] of sorted) {
				if (members.length >= 4) break;
				if (used.has(neighborText)) continue;
				const phrase = eligible.find((row) => row.text === neighborText);
				if (!phrase) continue;
				members.push(phrase);
				used.add(neighborText);
			}
		}
		const confidence = members.reduce((sum, row) => sum + row.weight, 0) / members.length;
		clusters.push({
			id: `cluster-${clusters.length + 1}`,
			phrases: members.sort((a, b) => b.weight - a.weight),
			confidence,
		});
	}

	return clusters.sort((a, b) => b.confidence - a.confidence);
}
