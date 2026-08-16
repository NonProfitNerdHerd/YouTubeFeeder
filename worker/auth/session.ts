import { randomToken, signValue, verifySignedValue } from './crypto';

const SESSION_COOKIE = 'yf_session';
const STATE_COOKIE = 'yf_oauth_state';
const MAX_AGE = 60 * 60 * 24 * 30;

function cookie(name: string, value: string, attrs: string[]): string {
	return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...attrs].join('; ');
}

export function parseCookies(request: Request): Record<string, string> {
	const header = request.headers.get('Cookie') ?? '';
	const out: Record<string, string> = {};
	for (const part of header.split(';')) {
		const [k, ...rest] = part.trim().split('=');
		if (!k) continue;
		out[k] = decodeURIComponent(rest.join('='));
	}
	return out;
}

export async function createSessionCookie(secret: string, userId: string, secure: boolean): Promise<string> {
	const token = await signValue(secret, `${userId}.${Date.now()}`);
	return cookie(SESSION_COOKIE, token, [`Max-Age=${MAX_AGE}`, secure ? 'Secure' : ''].filter(Boolean));
}

export function clearSessionCookies(secure: boolean): string[] {
	const extra = secure ? ['Secure'] : [];
	return [
		cookie(SESSION_COOKIE, '', ['Max-Age=0', ...extra]),
		cookie(STATE_COOKIE, '', ['Max-Age=0', ...extra]),
	];
}

export async function readSessionUserId(secret: string, request: Request): Promise<string | null> {
	const raw = parseCookies(request)[SESSION_COOKIE];
	if (!raw) return null;
	const value = await verifySignedValue(secret, raw);
	if (!value) return null;
	const userId = value.split('.')[0];
	return userId || null;
}

export async function createOauthStateCookie(
	secret: string,
	secure: boolean,
	intent: 'login' | 'signup',
): Promise<{ state: string; header: string }> {
	const nonce = randomToken(24);
	const state = `${intent}.${nonce}`;
	const signed = await signValue(secret, state);
	return {
		state,
		header: cookie(STATE_COOKIE, signed, ['Max-Age=600', secure ? 'Secure' : ''].filter(Boolean)),
	};
}

export async function readOauthState(secret: string, request: Request): Promise<string | null> {
	const raw = parseCookies(request)[STATE_COOKIE];
	if (!raw) return null;
	return verifySignedValue(secret, raw);
}

export function isSecureRequest(url: URL): boolean {
	return url.protocol === 'https:';
}
