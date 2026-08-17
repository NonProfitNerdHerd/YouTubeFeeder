function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function importAesKey(secret: string): Promise<CryptoKey> {
	const material = new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32));
	return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
	const key = await importAesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
	return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(payload: string, secret: string): Promise<string> {
	const [ivB64, dataB64] = payload.split('.');
	if (!ivB64 || !dataB64) throw new Error('Invalid encrypted payload');
	const key = await importAesKey(secret);
	const iv = base64ToBytes(ivB64);
	const data = base64ToBytes(dataB64);
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
	return new TextDecoder().decode(plain);
}

async function hmac(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
	return bytesToBase64(new Uint8Array(sig));
}

export async function signValue(secret: string, value: string): Promise<string> {
	const sig = await hmac(secret, value);
	return `${value}.${sig}`;
}

export async function verifySignedValue(secret: string, token: string): Promise<string | null> {
	const idx = token.lastIndexOf('.');
	if (idx <= 0) return null;
	const value = token.slice(0, idx);
	const sig = token.slice(idx + 1);
	const expected = await hmac(secret, value);
	if (sig.length !== expected.length) return null;
	let ok = 0;
	for (let i = 0; i < sig.length; i++) ok |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
	return ok === 0 ? value : null;
}

export function randomToken(bytes = 32): string {
	const arr = crypto.getRandomValues(new Uint8Array(bytes));
	// URL-safe: watchlist/category ids appear in path segments (standard base64 can include '/').
	return bytesToBase64(arr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
