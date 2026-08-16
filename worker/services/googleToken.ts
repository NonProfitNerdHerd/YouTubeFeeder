import { decryptSecret } from '../auth/crypto';
import { refreshAccessToken } from '../auth/oauth';
import type { UserRow } from '../db/users';

export async function accessTokenForUser(env: Env, user: UserRow): Promise<string> {
	if (!user.encrypted_refresh_token) {
		throw new Error('not_connected');
	}
	const refresh = await decryptSecret(user.encrypted_refresh_token, env.TOKEN_ENCRYPTION_KEY ?? '');
	const tokens = await refreshAccessToken(
		{
			GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? '',
			GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? '',
		},
		refresh,
	);
	return tokens.access_token;
}
