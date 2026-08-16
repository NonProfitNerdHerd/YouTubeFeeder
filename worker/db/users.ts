import { randomToken } from '../auth/crypto';

export interface UserRow {
	id: string;
	google_account_id: string;
	display_name: string;
	encrypted_refresh_token: string | null;
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
	return db.prepare('SELECT id, google_account_id, display_name, encrypted_refresh_token FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function upsertGoogleUser(
	db: D1Database,
	input: { googleAccountId: string; displayName: string; encryptedRefreshToken: string | null },
): Promise<UserRow> {
	const existing = await db
		.prepare('SELECT id, google_account_id, display_name, encrypted_refresh_token FROM users WHERE google_account_id = ?')
		.bind(input.googleAccountId)
		.first<UserRow>();

	if (existing) {
		const token = input.encryptedRefreshToken ?? existing.encrypted_refresh_token;
		await db
			.prepare(
				`UPDATE users SET display_name = ?, encrypted_refresh_token = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
			)
			.bind(input.displayName, token, existing.id)
			.run();
		await db
			.prepare(
				`INSERT OR IGNORE INTO settings (user_id) VALUES (?)`,
			)
			.bind(existing.id)
			.run();
		return { ...existing, display_name: input.displayName, encrypted_refresh_token: token };
	}

	const id = randomToken(16);
	await db
		.prepare(
			`INSERT INTO users (id, google_account_id, display_name, encrypted_refresh_token) VALUES (?, ?, ?, ?)`,
		)
		.bind(id, input.googleAccountId, input.displayName, input.encryptedRefreshToken)
		.run();
	await db.prepare(`INSERT OR IGNORE INTO settings (user_id) VALUES (?)`).bind(id).run();
	return {
		id,
		google_account_id: input.googleAccountId,
		display_name: input.displayName,
		encrypted_refresh_token: input.encryptedRefreshToken,
	};
}
