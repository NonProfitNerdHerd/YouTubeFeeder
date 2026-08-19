import { normalizeDiscoverQuery } from './youtube';
import type { ConceptCluster } from './conceptClustering';
import type { InterestFingerprint } from './interestFingerprint';

export interface ClusterQuery {
	query: string;
	cacheKey: string;
	confidence: number;
	clusterId: string;
}

function formatQueryPart(text: string): string {
	return text.split(' ').length >= 2 ? `"${text}"` : text;
}

export function buildClusterQueries(clusters: ConceptCluster[], maxQueries = 4): ClusterQuery[] {
	const out: ClusterQuery[] = [];
	for (const cluster of clusters.slice(0, maxQueries)) {
		const parts: string[] = [];
		for (const phrase of cluster.phrases.slice(0, 3)) {
			const formatted = formatQueryPart(phrase.text);
			if (!parts.includes(formatted)) parts.push(formatted);
		}
		if (!parts.length) continue;
		const query = parts.join(' ').slice(0, 120);
		out.push({
			query,
			cacheKey: canonicalizeClusterQueryKey(query),
			confidence: cluster.confidence,
			clusterId: cluster.id,
		});
	}
	return out;
}

export function canonicalizeClusterQueryKey(query: string): string {
	const normalized = normalizeDiscoverQuery(query);
	const quoted = [...normalized.matchAll(/"([^"]+)"/g)].map((match) => match[1]!.trim()).filter(Boolean);
	const bare = normalized.replace(/"([^"]+)"/g, ' ').split(/\s+/).filter(Boolean);
	const sortedQuoted = [...quoted].sort();
	const sortedBare = [...bare].sort();
	return [...sortedQuoted, ...sortedBare].join(' ').trim();
}

export function buildInterestSearchQueries(fingerprint: InterestFingerprint): ClusterQuery[] {
	if (fingerprint.queries?.length) return fingerprint.queries;
	const fallbackParts = fingerprint.phrases.slice(0, 3).map((row) => formatQueryPart(row.text));
	if (!fallbackParts.length) return [];
	const query = fallbackParts.join(' ').slice(0, 120);
	return [
		{
			query,
			cacheKey: canonicalizeClusterQueryKey(query),
			confidence: fingerprint.confidence,
			clusterId: 'fallback',
		},
	];
}
