import { signValue, verifySignedValue } from '../../auth/crypto';

const TOKEN_PREFIX = 'rec:';
/** Seven days — enough time to dismiss or follow after seeing a recommendation. */
export const RECOMMENDATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MatchedConcept {
	text: string;
	ambiguous: boolean;
}

export interface RecommendationTokenPayload {
	userId: string;
	provider: string;
	externalId: string;
	channelTitle: string;
	channelThumbnail: string;
	interestId: string;
	interestLabel: string;
	baseScore: number;
	matchedConcepts: MatchedConcept[];
	recommendationReason: string;
	expiresAt: number;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
	const binary = atob(withPad);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function encodePayload(payload: RecommendationTokenPayload): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return `${TOKEN_PREFIX}${bytesToBase64(bytes)}`;
}

function decodePayload(value: string): RecommendationTokenPayload | null {
	if (!value.startsWith(TOKEN_PREFIX)) return null;
	try {
		const json = new TextDecoder().decode(base64ToBytes(value.slice(TOKEN_PREFIX.length)));
		const parsed = JSON.parse(json) as RecommendationTokenPayload;
		if (
			!parsed ||
			typeof parsed.userId !== 'string' ||
			typeof parsed.provider !== 'string' ||
			typeof parsed.externalId !== 'string' ||
			typeof parsed.interestId !== 'string' ||
			typeof parsed.expiresAt !== 'number'
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export async function mintRecommendationToken(
	secret: string,
	payload: Omit<RecommendationTokenPayload, 'expiresAt'>,
	now = Date.now(),
): Promise<string> {
	const full: RecommendationTokenPayload = {
		...payload,
		expiresAt: now + RECOMMENDATION_TOKEN_TTL_MS,
	};
	return signValue(secret, encodePayload(full));
}

export async function verifyRecommendationToken(
	secret: string,
	token: string,
	userId: string,
	now = Date.now(),
): Promise<RecommendationTokenPayload | null> {
	const raw = await verifySignedValue(secret, token);
	if (!raw) return null;
	const payload = decodePayload(raw);
	if (!payload) return null;
	if (payload.userId !== userId) return null;
	if (payload.expiresAt < now) return null;
	return payload;
}
