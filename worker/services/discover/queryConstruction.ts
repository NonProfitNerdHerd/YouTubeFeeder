import { normalizeDiscoverQuery } from './youtube';
import type { InterestFingerprint } from './interestFingerprint';

export function buildInterestSearchQuery(fingerprint: InterestFingerprint): string {
	const parts: string[] = [];

	for (const phrase of fingerprint.phrases.slice(0, 3)) {
		if (phrase.text.split(' ').length >= 2) {
			parts.push(`"${phrase.text}"`);
		}
	}

	for (const term of fingerprint.terms) {
		if (term.ambiguous) continue;
		if (parts.length >= 6) break;
		if (parts.some((part) => part.replace(/"/g, '') === term.text)) continue;
		parts.push(term.text);
	}

	if (!parts.length && fingerprint.phrases[0]) {
		parts.push(`"${fingerprint.phrases[0].text}"`);
	}

	return parts.join(' ').slice(0, 120);
}

export function interestQueryCacheKey(fingerprint: InterestFingerprint): string {
	const query = buildInterestSearchQuery(fingerprint);
	return normalizeDiscoverQuery(query);
}
