import { buildInterestFingerprints, isInterestFingerprintEmpty } from './interestFingerprint';

/** @deprecated Use buildInterestFingerprints instead. Kept for legacy tests. */
export async function buildInterestProfile(db: D1Database, userId: string) {
	const fingerprints = await buildInterestFingerprints(db, userId);
	return fingerprints.flatMap((fp) =>
		fp.phrases.slice(0, 3).map((phrase) => ({
			topic: phrase.text,
			score: phrase.weight,
			source: 'category' as const,
			reasonLabel: fp.label,
		})),
	);
}

export async function isInterestProfileEmptyForUser(db: D1Database, userId: string): Promise<boolean> {
	const fingerprints = await buildInterestFingerprints(db, userId);
	return isInterestFingerprintEmpty(fingerprints);
}

export function isInterestProfileEmpty(topics: { length: number }[]): boolean {
	return topics.length < 1;
}

export type { InterestFingerprint } from './interestFingerprint';
