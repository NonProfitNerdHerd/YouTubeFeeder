const YOUTUBE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';

export function googleAuthUrl(params: { clientId: string; redirectUri: string; state: string }): string {
	const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
	url.searchParams.set('client_id', params.clientId);
	url.searchParams.set('redirect_uri', params.redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', YOUTUBE_READONLY);
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	url.searchParams.set('state', params.state);
	return url.toString();
}

export interface GoogleTokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
	token_type?: string;
}

export async function exchangeCode(env: {
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_REDIRECT_URI: string;
}, code: string): Promise<GoogleTokenResponse> {
	const body = new URLSearchParams({
		code,
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		redirect_uri: env.GOOGLE_REDIRECT_URI,
		grant_type: 'authorization_code',
	});
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
	});
	if (!res.ok) {
		throw new Error(`token_exchange_failed:${res.status}`);
	}
	return (await res.json()) as GoogleTokenResponse;
}

export async function refreshAccessToken(env: {
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
}, refreshToken: string): Promise<GoogleTokenResponse> {
	const body = new URLSearchParams({
		refresh_token: refreshToken,
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		grant_type: 'refresh_token',
	});
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
	});
	if (!res.ok) {
		throw new Error(`token_refresh_failed:${res.status}`);
	}
	return (await res.json()) as GoogleTokenResponse;
}

export async function fetchGoogleUser(accessToken: string): Promise<{ id: string; name: string }> {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`userinfo_failed:${res.status}`);
	const data = (await res.json()) as { id: string; name?: string };
	return { id: data.id, name: data.name ?? 'YouTube user' };
}

export async function revokeToken(token: string): Promise<void> {
	await fetch('https://oauth2.googleapis.com/revoke', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token }),
	});
}

export function validateOauthState(expected: string | null, received: string | null): boolean {
	if (!expected || !received) return false;
	if (expected.length !== received.length) return false;
	let ok = 0;
	for (let i = 0; i < expected.length; i++) ok |= expected.charCodeAt(i) ^ received.charCodeAt(i);
	return ok === 0;
}
