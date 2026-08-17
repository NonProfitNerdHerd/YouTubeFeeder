import { randomToken, signValue, verifySignedValue } from './crypto';

export const SESSION_COOKIE = 'yf_session';
const STATE_COOKIE = 'yf_oauth_state';
const MAX_AGE = 60 * 60 * 24 * 30;

export type OauthClient = 'web' | 'android';

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

function bearerToken(request: Request): string | null {
	const header = request.headers.get('Authorization');
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match?.[1]?.trim() || null;
}

export async function mintSession(
	secret: string,
	userId: string,
	secure: boolean,
): Promise<{ token: string; cookieHeader: string }> {
	const token = await signValue(secret, `${userId}.${Date.now()}`);
	return {
		token,
		cookieHeader: cookie(SESSION_COOKIE, token, [`Max-Age=${MAX_AGE}`, secure ? 'Secure' : ''].filter(Boolean)),
	};
}

export async function createSessionCookie(secret: string, userId: string, secure: boolean): Promise<string> {
	const { cookieHeader } = await mintSession(secret, userId, secure);
	return cookieHeader;
}

export function clearSessionCookies(secure: boolean): string[] {
	const extra = secure ? ['Secure'] : [];
	return [
		cookie(SESSION_COOKIE, '', ['Max-Age=0', ...extra]),
		cookie(STATE_COOKIE, '', ['Max-Age=0', ...extra]),
	];
}

export async function readSessionUserId(secret: string, request: Request): Promise<string | null> {
	const raw = parseCookies(request)[SESSION_COOKIE] ?? bearerToken(request);
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
	client: OauthClient = 'web',
): Promise<{ state: string; header: string }> {
	const nonce = randomToken(24);
	const state = client === 'android' ? `${intent}.android.${nonce}` : `${intent}.${nonce}`;
	const signed = await signValue(secret, state);
	return {
		state,
		header: cookie(STATE_COOKIE, signed, ['Max-Age=600', secure ? 'Secure' : ''].filter(Boolean)),
	};
}

export function oauthClientFromState(state: string | null): OauthClient {
	if (!state) return 'web';
	return /^(login|signup)\.android\./.test(state) ? 'android' : 'web';
}

export async function readOauthState(secret: string, request: Request): Promise<string | null> {
	const raw = parseCookies(request)[STATE_COOKIE];
	if (!raw) return null;
	return verifySignedValue(secret, raw);
}

export function isSecureRequest(url: URL): boolean {
	return url.protocol === 'https:';
}

/** Custom-scheme return for the native VortiQuest app after Google OAuth. */
export const ANDROID_OAUTH_REDIRECT = 'streamfeeder://oauth/callback';
