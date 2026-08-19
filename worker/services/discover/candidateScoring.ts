import type { DiscoveryResult } from '../../../src/types/discover';
import {
	AMBIGUOUS_UNIGRAMS,
	NEGATIVE_DOMAIN_TERMS,
	normalizeMatchText,
	type WeightedPhrase,
	type WeightedTerm,
} from './phraseExtract';
import type { InterestFingerprint } from './interestFingerprint';

export const MIN_ACCEPT_SCORE = 55;

export interface CandidateScoreDebug {
	candidateTitle: string;
	candidateId: string;
	interestId: string;
	interestLabel: string;
	positive: string[];
	negative: string[];
	score: number;
	threshold: number;
	result: 'ACCEPT' | 'REJECT';
}

export interface ScoredCandidate {
	result: DiscoveryResult;
	score: number;
	recommendationReason: string;
	interestId: string;
	interestLabel: string;
	debug: CandidateScoreDebug;
}

function containsPhrase(text: string, phrase: string): boolean {
	return text.includes(phrase);
}

function containsTerm(text: string, term: string): boolean {
	const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
	return pattern.test(text);
}

function formatReasonLabel(matches: string[]): string {
	const cleaned = matches
		.slice(0, 3)
		.map((item) => item.split(' ').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '));
	if (!cleaned.length) return 'Related channels';
	if (cleaned.length === 1) return cleaned[0]!;
	return `${cleaned.slice(0, -1).join(', ')} & ${cleaned[cleaned.length - 1]}`;
}

function fingerprintHasAmbiguity(fingerprint: InterestFingerprint): boolean {
	if (fingerprint.phrases.some((phrase) => phrase.text.split(' ').length >= 2)) return true;
	return fingerprint.terms.some((term) => term.ambiguous || AMBIGUOUS_UNIGRAMS.has(term.text));
}

export function scoreCandidateAgainstFingerprint(
	candidate: DiscoveryResult,
	fingerprint: InterestFingerprint,
): ScoredCandidate {
	const title = normalizeMatchText(candidate.title ?? '');
	const description = normalizeMatchText(candidate.description ?? '');
	const combined = `${title} ${description}`.trim();

	const positive: string[] = [];
	const negative: string[] = [];
	let score = 0;

	let phraseHits = 0;
	let nonAmbiguousTermHits = 0;
	let ambiguousOnlyHits = 0;

	for (const phrase of fingerprint.phrases as WeightedPhrase[]) {
		const inDescription = containsPhrase(description, phrase.text);
		const inTitle = containsPhrase(title, phrase.text);
		if (inDescription) {
			score += 25;
			phraseHits += 1;
			positive.push(`phrase "${phrase.text}"`);
		} else if (inTitle) {
			score += 15;
			phraseHits += 1;
			positive.push(`phrase "${phrase.text}" (title)`);
		}
	}

	for (const term of fingerprint.terms as WeightedTerm[]) {
		const inDescription = containsTerm(description, term.text);
		const inTitle = containsTerm(title, term.text);
		if (!inDescription && !inTitle) continue;

		if (term.ambiguous || AMBIGUOUS_UNIGRAMS.has(term.text)) {
			if (inDescription) {
				score += 4;
				ambiguousOnlyHits += 1;
				positive.push(term.text);
			} else if (inTitle) {
				score += 2;
				ambiguousOnlyHits += 1;
				positive.push(`${term.text} (title)`);
			}
		} else if (inDescription) {
			score += 12;
			nonAmbiguousTermHits += 1;
			positive.push(term.text);
		} else if (inTitle) {
			score += 6;
			nonAmbiguousTermHits += 1;
			positive.push(`${term.text} (title)`);
		}
	}

	for (const term of NEGATIVE_DOMAIN_TERMS) {
		if (containsTerm(combined, term) && !fingerprint.terms.some((row) => row.text === term)) {
			score -= 10;
			negative.push(term);
		}
	}

	const hasStrongEvidence = phraseHits > 0 || nonAmbiguousTermHits >= 2;
	const ambiguousInterest = fingerprintHasAmbiguity(fingerprint);

	if (ambiguousInterest && !hasStrongEvidence && ambiguousOnlyHits > 0 && phraseHits === 0 && nonAmbiguousTermHits === 0) {
		score = Math.min(score, 20);
	}

	if (ambiguousInterest && phraseHits === 0 && nonAmbiguousTermHits < 2) {
		score = Math.min(score, MIN_ACCEPT_SCORE - 1);
	}

	if (negative.length >= 2 && !hasStrongEvidence) {
		score = Math.min(score, MIN_ACCEPT_SCORE - 10);
	}

	const accepted = score >= MIN_ACCEPT_SCORE;
	const reasonMatches = positive
		.map((item) => item.replace(/ \(title\)$/, '').replace(/^phrase "/, '').replace(/"$/, ''))
		.filter(Boolean);

	const recommendationReason = accepted
		? `Related to ${formatReasonLabel(reasonMatches)}`
		: `Related to ${fingerprint.label}`;

	const debug: CandidateScoreDebug = {
		candidateTitle: candidate.title,
		candidateId: candidate.externalId,
		interestId: fingerprint.interestId,
		interestLabel: fingerprint.label,
		positive,
		negative,
		score,
		threshold: MIN_ACCEPT_SCORE,
		result: accepted ? 'ACCEPT' : 'REJECT',
	};

	return {
		result: candidate,
		score,
		recommendationReason,
		interestId: fingerprint.interestId,
		interestLabel: fingerprint.label,
		debug,
	};
}

export function scoreCandidatesForInterest(
	candidates: DiscoveryResult[],
	fingerprint: InterestFingerprint,
): ScoredCandidate[] {
	return candidates
		.map((candidate) => scoreCandidateAgainstFingerprint(candidate, fingerprint))
		.filter((row) => row.score >= MIN_ACCEPT_SCORE)
		.sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title));
}

export function scoreAllCandidates(
	candidates: DiscoveryResult[],
	fingerprint: InterestFingerprint,
	includeRejected = false,
): ScoredCandidate[] {
	const scored = candidates.map((candidate) => scoreCandidateAgainstFingerprint(candidate, fingerprint));
	if (includeRejected) {
		return scored.sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title));
	}
	return scoreCandidatesForInterest(candidates, fingerprint);
}
