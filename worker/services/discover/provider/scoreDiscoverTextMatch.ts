/**
 * Shared deterministic typed-Discover text relevance (0–100).
 *
 * Phase 2.1 formula (no provider-type bias):
 *
 * 1. Tokenize query/title on non-alphanumeric; keep tokens length ≥ 2.
 * 2. Title match class:
 *    - exact: normalized title key === query key → base 100
 *    - all_tokens: every query token appears as a whole title token
 *        base = 58 + 32 * (queryLen / (queryLen + extraTitleTokens))
 *        + up to 6 for multi-token queries (specificity)
 *        Single-token “contains” titles (History Daily) stay well below 100.
 *    - partial_title: some query tokens in title
 *        base = 28 + 40 * (titleHits / queryLen)
 *    - metadata_only: no title hits; description/publisher/genres only
 *        base from those fields alone (capped)
 * 3. Description contribution: up to +8 from description token coverage
 *    (only when title is not exact).
 * 4. Publisher contribution: up to +8 from publisher token coverage
 *    (stronger when title is weak).
 * 5. Genre contribution: up to +3 (podcast categories).
 * 6. Provider rank contribution: max +3 (rank 0 → +3 … rank ≥3 → +0).
 *    Never overpowers title class gaps.
 * 7. Clamp to 0–100; round.
 *
 * Exact normalized titles remain near/at 100. Titles that merely contain the
 * query word do not all saturate at 100.
 */

export interface DiscoverTextMatchMetadata {
	title: string;
	description?: string;
	publisher?: string;
	genres?: string[];
	/**
	 * Optional 0-based provider order (lower = higher in provider list).
	 * Modest secondary signal only — does not override strong text matches.
	 */
	providerRank?: number;
}

export type TitleMatchClass = 'exact' | 'all_tokens' | 'partial_title' | 'metadata_only' | 'none';

/** Ordering for tie-breaks: higher = stronger title match. */
export const TITLE_MATCH_CLASS_RANK: Record<TitleMatchClass, number> = {
	exact: 4,
	all_tokens: 3,
	partial_title: 2,
	metadata_only: 1,
	none: 0,
};

export interface DiscoverTextMatchExplanation {
	score: number;
	titleMatch: TitleMatchClass;
	/** Fraction of query tokens found in title (whole-token). */
	titleTokenCoverage: number;
	/** Fraction of query tokens found in title+description+publisher+genres. */
	tokenCoverage: number;
	descriptionContribution: number;
	publisherContribution: number;
	genreContribution: number;
	providerRankContribution: number;
	queryTokenCount: number;
	extraTitleTokens: number;
}

export function tokenizeDiscoverQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 2);
}

export function normalizeTitleKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function countTokenHits(tokens: string[], hayTokens: string[]): number {
	let hits = 0;
	for (const token of tokens) {
		if (hayTokens.includes(token)) hits += 1;
	}
	return hits;
}

function countSubstringHits(tokens: string[], hay: string): number {
	let hits = 0;
	const lower = hay.toLowerCase();
	for (const token of tokens) {
		if (lower.includes(token)) hits += 1;
	}
	return hits;
}

/**
 * Full scoring breakdown for tests/debug (not for normal UI).
 */
export function explainDiscoverTextMatch(
	query: string,
	metadata: DiscoverTextMatchMetadata,
): DiscoverTextMatchExplanation {
	const empty: DiscoverTextMatchExplanation = {
		score: 0,
		titleMatch: 'none',
		titleTokenCoverage: 0,
		tokenCoverage: 0,
		descriptionContribution: 0,
		publisherContribution: 0,
		genreContribution: 0,
		providerRankContribution: 0,
		queryTokenCount: 0,
		extraTitleTokens: 0,
	};

	const q = query.trim();
	if (!q) return empty;

	const title = metadata.title ?? '';
	const tokens = tokenizeDiscoverQuery(q);
	const titleTokens = tokenizeDiscoverQuery(title);
	const queryKey = normalizeTitleKey(q);
	const titleKey = normalizeTitleKey(title);

	if (!tokens.length) return empty;

	const titleHits = countTokenHits(tokens, titleTokens);
	const titleTokenCoverage = titleHits / tokens.length;
	const extraTitleTokens = Math.max(0, titleTokens.length - titleHits);

	const description = metadata.description ?? '';
	const publisher = metadata.publisher ?? '';
	const genreText = (metadata.genres ?? []).join(' ');

	const descHits = countSubstringHits(tokens, description);
	const publisherHits = countSubstringHits(tokens, publisher);
	const genreHits = countSubstringHits(tokens, genreText);

	const anyHit = new Set<string>();
	for (const token of tokens) {
		if (titleTokens.includes(token) || description.toLowerCase().includes(token) || publisher.toLowerCase().includes(token) || genreText.toLowerCase().includes(token)) {
			anyHit.add(token);
		}
	}
	const tokenCoverage = anyHit.size / tokens.length;

	let titleMatch: TitleMatchClass = 'none';
	let base = 0;

	if (titleKey && queryKey && titleKey === queryKey) {
		titleMatch = 'exact';
		base = 100;
	} else if (titleHits === tokens.length) {
		titleMatch = 'all_tokens';
		const compactness = tokens.length / (tokens.length + extraTitleTokens);
		// Multi-token queries get a small specificity bump; single-token contains do not saturate.
		const specificity = tokens.length >= 2 ? 6 : 0;
		base = 58 + 32 * compactness + specificity;
	} else if (titleHits > 0) {
		titleMatch = 'partial_title';
		base = 28 + 40 * titleTokenCoverage;
	} else if (tokenCoverage > 0) {
		titleMatch = 'metadata_only';
		base = 12 + 28 * tokenCoverage;
	} else {
		return { ...empty, queryTokenCount: tokens.length };
	}

	let descriptionContribution = 0;
	let publisherContribution = 0;
	let genreContribution = 0;

	if (titleMatch !== 'exact') {
		const descCov = descHits / tokens.length;
		descriptionContribution = Math.round(descCov * 8 * 10) / 10;
		const pubCov = publisherHits / tokens.length;
		publisherContribution =
			titleTokenCoverage < 1 ? Math.round(pubCov * 8 * 10) / 10 : Math.round(pubCov * 3 * 10) / 10;
		const genreCov = genreHits / tokens.length;
		genreContribution = Math.round(genreCov * 3 * 10) / 10;
	}

	let providerRankContribution = 0;
	const rank = metadata.providerRank;
	if (rank != null && Number.isFinite(rank) && rank >= 0) {
		providerRankContribution = Math.max(0, 3 - Math.min(3, Math.floor(rank)));
	}

	const raw =
		base + descriptionContribution + publisherContribution + genreContribution + providerRankContribution;
	const score = Math.max(0, Math.min(100, Math.round(raw)));

	return {
		score,
		titleMatch,
		titleTokenCoverage,
		tokenCoverage,
		descriptionContribution,
		publisherContribution,
		genreContribution,
		providerRankContribution,
		queryTokenCount: tokens.length,
		extraTitleTokens,
	};
}

export function scoreDiscoverTextMatch(query: string, metadata: DiscoverTextMatchMetadata): number {
	return explainDiscoverTextMatch(query, metadata).score;
}

/** Human-readable ranking explanation for debug/tests. */
export function formatDiscoverTextMatchExplanation(
	candidateTitle: string,
	contentType: string,
	explanation: DiscoverTextMatchExplanation,
	diversityNote = 'none',
): string {
	return [
		`Candidate: ${candidateTitle}`,
		`Type: ${contentType}`,
		`Score: ${explanation.score}`,
		`Title match: ${explanation.titleMatch}`,
		`Token coverage: ${Math.round(explanation.tokenCoverage * 100)}%`,
		`Title token coverage: ${Math.round(explanation.titleTokenCoverage * 100)}%`,
		`Description contribution: ${explanation.descriptionContribution}`,
		`Publisher contribution: ${explanation.publisherContribution}`,
		`Provider rank contribution: ${explanation.providerRankContribution}`,
		`Diversity adjustment: ${diversityNote}`,
	].join('\n');
}
