import { normalizeDiscoverQuery } from './youtube';
import type { ConceptCluster } from './conceptClustering';
import type { InterestFingerprint } from './interestFingerprint';
import type { WeightedPhrase } from './phraseExtract';

export interface ClusterQuery {
	query: string;
	cacheKey: string;
	confidence: number;
	clusterId: string;
	phrases?: string[];
}

/** YouTube channel search works best with plain space-separated terms (not stacked quoted phrases). */
function buildQueryText(phrases: WeightedPhrase[], maxParts = 2): string {
	const parts: string[] = [];
	for (const phrase of phrases) {
		const text = phrase.text.trim();
		if (!text || parts.includes(text)) continue;
		parts.push(text);
		if (parts.length >= maxParts) break;
	}
	return parts.join(' ').slice(0, 120);
}

export function buildClusterQueries(clusters: ConceptCluster[], maxQueries = 4): ClusterQuery[] {
	const out: ClusterQuery[] = [];
	for (const cluster of clusters.slice(0, maxQueries)) {
		const query = buildQueryText(cluster.phrases, 2);
		if (!query) continue;
		out.push({
			query,
			cacheKey: canonicalizeClusterQueryKey(query),
			confidence: cluster.confidence,
			clusterId: cluster.id,
			phrases: cluster.phrases.map((row) => row.text),
		});
	}
	return out;
}

export function buildSupplementalPhraseQueries(
	fingerprint: InterestFingerprint,
	maxQueries = 2,
): ClusterQuery[] {
	const used = new Set(
		(fingerprint.queries ?? []).flatMap((row) => row.phrases ?? row.query.split(/\s+/)),
	);
	const out: ClusterQuery[] = [];
	for (const phrase of fingerprint.phrases) {
		if (phrase.text.split(' ').length < 2) continue;
		if (used.has(phrase.text)) continue;
		out.push({
			query: phrase.text,
			cacheKey: canonicalizeClusterQueryKey(phrase.text),
			confidence: phrase.weight,
			clusterId: `phrase-${out.length + 1}`,
			phrases: [phrase.text],
		});
		used.add(phrase.text);
		if (out.length >= maxQueries) break;
	}
	return out;
}

export function canonicalizeClusterQueryKey(query: string): string {
	const normalized = normalizeDiscoverQuery(query.replace(/"/g, ' '));
	const tokens = normalized.split(/\s+/).filter(Boolean);
	return [...new Set(tokens)].sort().join(' ').trim();
}

export function buildInterestSearchQueries(fingerprint: InterestFingerprint): ClusterQuery[] {
	const fromFingerprint = fingerprint.queries?.length ? fingerprint.queries : [];
	const clusterQueries = fromFingerprint.length
		? fromFingerprint
		: buildClusterQueries(fingerprint.clusters ?? []);
	if (clusterQueries.length) {
		return [...clusterQueries, ...buildSupplementalPhraseQueries({ ...fingerprint, queries: clusterQueries })];
	}
	const fallbackParts = fingerprint.phrases.slice(0, 2);
	if (!fallbackParts.length) return [];
	const query = buildQueryText(fallbackParts, 2);
	return [
		{
			query,
			cacheKey: canonicalizeClusterQueryKey(query),
			confidence: fingerprint.confidence,
			clusterId: 'fallback',
			phrases: fallbackParts.map((row) => row.text),
		},
	];
}

/**
 * Single strong Brave provider query for For You / Discover More.
 * Prefer the interest label (e.g. "Microsoft") so typed Discover and topic chips share cache keys.
 */
export function buildBraveInterestPrimaryQuery(fingerprint: InterestFingerprint): ClusterQuery {
	const label = fingerprint.label.trim();
	if (label) {
		return {
			query: label,
			cacheKey: normalizeDiscoverQuery(label),
			confidence: fingerprint.confidence,
			clusterId: 'brave-primary',
			phrases: [label],
		};
	}
	const queries = buildInterestSearchQueries(fingerprint);
	if (queries[0]) return queries[0];
	return {
		query: '',
		cacheKey: '',
		confidence: 0,
		clusterId: 'brave-primary',
		phrases: [],
	};
}

/** Keys that may exist from pre-refactor query construction or partial term caches. */
export function buildLegacyInterestQueryKeys(fingerprint: InterestFingerprint): string[] {
	const keys: string[] = [];
	const add = (raw: string) => {
		const trimmed = raw.trim();
		if (!trimmed) return;
		const normalized = normalizeDiscoverQuery(trimmed.replace(/"/g, ' '));
		if (normalized && !keys.includes(normalized)) keys.push(normalized);
		const canonical = canonicalizeClusterQueryKey(trimmed);
		if (canonical && !keys.includes(canonical)) keys.push(canonical);
		// Legacy rows may retain literal quote characters in normalized_topic.
		const quotedLiteral = normalizeDiscoverQuery(trimmed);
		if (quotedLiteral && !keys.includes(quotedLiteral)) keys.push(quotedLiteral);
	};

	const parts: string[] = [];
	for (const phrase of fingerprint.phrases.slice(0, 3)) {
		if (phrase.text.split(' ').length >= 2) parts.push(`"${phrase.text}"`);
		parts.push(phrase.text);
	}
	for (const term of fingerprint.terms.slice(0, 3)) {
		if (!term.ambiguous) parts.push(term.text);
	}
	if (parts.length) add(parts.join(' '));

	return keys;
}

export function buildPhraseLookupKeys(fingerprint: InterestFingerprint, maxPhrases = 3): string[] {
	const keys: string[] = [];
	const add = (raw: string) => {
		const key = normalizeDiscoverQuery(raw);
		if (key && !keys.includes(key)) keys.push(key);
		const canonical = canonicalizeClusterQueryKey(raw);
		if (canonical && !keys.includes(canonical)) keys.push(canonical);
	};

	for (const phrase of fingerprint.phrases.slice(0, maxPhrases)) {
		add(phrase.text);
		for (const token of phrase.text.split(/\s+/)) {
			if (token.length >= 4) add(token);
		}
	}
	for (const term of fingerprint.terms.slice(0, maxPhrases * 2)) {
		if (term.ambiguous) continue;
		add(term.text);
	}
	return keys;
}
