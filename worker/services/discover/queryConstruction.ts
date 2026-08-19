import { buildInterestSearchQueries } from './clusterQueries';
import type { InterestFingerprint } from './interestFingerprint';

/** @deprecated Use buildInterestSearchQueries for multi-cluster discovery. */
export function buildInterestSearchQuery(fingerprint: InterestFingerprint): string {
	const queries = buildInterestSearchQueries(fingerprint);
	return queries[0]?.query ?? fingerprint.label;
}

/** @deprecated Use ClusterQuery.cacheKey from buildInterestSearchQueries. */
export function interestQueryCacheKey(fingerprint: InterestFingerprint): string {
	const queries = buildInterestSearchQueries(fingerprint);
	return queries[0]?.cacheKey ?? fingerprint.label.toLowerCase();
}