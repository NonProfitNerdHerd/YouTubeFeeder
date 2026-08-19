export const STOP_WORDS = new Set([
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
	'watch',
	'full',
	'episode',
	'episodes',
]);

export const AMBIGUOUS_UNIGRAMS = new Set([
	'storm',
	'chase',
	'chasing',
	'weather',
	'tech',
	'game',
	'games',
	'gaming',
	'car',
	'cars',
	'auto',
	'history',
	'news',
	'live',
	'world',
	'life',
	'love',
	'records',
	'record',
	'studio',
	'studios',
]);

export const NEGATIVE_DOMAIN_TERMS = new Set([
	'music',
	'musical',
	'producer',
	'producers',
	'records',
	'record',
	'label',
	'song',
	'songs',
	'album',
	'gaming',
	'game',
	'games',
	'gamer',
	'soccer',
	'football',
	'basketball',
	'sports',
	'travel',
	'traveling',
	'travelling',
	'vlog',
	'vacation',
	'crime',
	'true',
	'podcast',
	'airsoft',
	'minecraft',
	'fortnite',
]);

function normalizeText(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function tokenizeWords(text: string): string[] {
	return normalizeText(text)
		.split(/\s+/)
		.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function ngrams(tokens: string[], n: number): string[] {
	if (tokens.length < n) return [];
	const out: string[] = [];
	for (let i = 0; i <= tokens.length - n; i += 1) {
		const phrase = tokens.slice(i, i + n).join(' ');
		if (phrase.split(' ').every((part) => part.length >= 2 && !STOP_WORDS.has(part))) {
			out.push(phrase);
		}
	}
	return out;
}

export interface WeightedPhrase {
	text: string;
	weight: number;
}

export interface WeightedTerm {
	text: string;
	weight: number;
	ambiguous: boolean;
}

export function extractPhrasesFromDocuments(documents: string[], protectedPhrases: string[] = []): WeightedPhrase[] {
	const counts = new Map<string, number>();
	const docHits = new Map<string, number>();

	for (const doc of documents) {
		const tokens = tokenizeWords(doc);
		const seenInDoc = new Set<string>();
		for (const phrase of [...ngrams(tokens, 2), ...ngrams(tokens, 3)]) {
			counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
			seenInDoc.add(phrase);
		}
		for (const phrase of seenInDoc) {
			docHits.set(phrase, (docHits.get(phrase) ?? 0) + 1);
		}
	}

	for (const raw of protectedPhrases) {
		const phrase = normalizeText(raw);
		if (!phrase || phrase.split(' ').length < 2) continue;
		counts.set(phrase, (counts.get(phrase) ?? 0) + 10);
		docHits.set(phrase, Math.max(docHits.get(phrase) ?? 0, documents.length));
	}

	return [...counts.entries()]
		.map(([text, count]) => ({
			text,
			weight: count * 3 + (docHits.get(text) ?? 0) * 5,
		}))
		.filter((row) => row.text.split(' ').length >= 2)
		.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
}

export function extractTermsFromDocuments(documents: string[]): WeightedTerm[] {
	const counts = new Map<string, number>();
	const docHits = new Map<string, number>();

	for (const doc of documents) {
		const tokens = tokenizeWords(doc);
		const seen = new Set(tokens);
		for (const token of tokens) {
			counts.set(token, (counts.get(token) ?? 0) + 1);
		}
		for (const token of seen) {
			docHits.set(token, (docHits.get(token) ?? 0) + 1);
		}
	}

	return [...counts.entries()]
		.map(([text, count]) => ({
			text,
			weight: count + (docHits.get(text) ?? 0) * 2,
			ambiguous: AMBIGUOUS_UNIGRAMS.has(text),
		}))
		.filter((row) => row.weight >= 2)
		.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
}

export function normalizeMatchText(text: string): string {
	return normalizeText(text);
}
