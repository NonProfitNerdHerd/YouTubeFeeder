import { describe, expect, it, vi } from 'vitest';
import {
	buildBraveYoutubeSearchQuery,
	BRAVE_YOUTUBE_STRATEGY_V1,
} from '../../worker/services/discover/provider/braveQueryStrategy';
import {
	BraveSearchProvider,
	parseBraveSearchResponse,
} from '../../worker/services/discover/provider/braveSearchProvider';
import { BraveProviderError } from '../../worker/services/discover/provider/types';

const API_KEY = 'test-brave-secret-key-do-not-leak';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('Brave query strategy', () => {
	it('builds a versioned provisional youtube query for v1', () => {
		expect(buildBraveYoutubeSearchQuery('storm chasing', BRAVE_YOUTUBE_STRATEGY_V1)).toBe(
			'site:youtube.com storm chasing',
		);
	});

	it('trims and collapses whitespace without over-normalizing token order', () => {
		expect(buildBraveYoutubeSearchQuery('  power   bi  ')).toBe('site:youtube.com power bi');
	});
});

describe('BraveSearchProvider', () => {
	it('returns hits on success and never echoes the API key', async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url).toContain('api.search.brave.com');
			expect(new URL(url).searchParams.get('q')).toBe('site:youtube.com storm chasing');
			expect(init?.headers).toMatchObject({ 'X-Subscription-Token': API_KEY });
			return jsonResponse({
				query: { original: 'site:youtube.com storm chasing', more_results_available: true },
				web: {
					results: [
						{
							title: 'Max Velocity',
							url: 'https://www.youtube.com/@MaxVelocityWX',
							description: 'Storm chasing',
						},
					],
				},
			});
		});

		const provider = new BraveSearchProvider({ apiKey: API_KEY, fetchImpl: fetchImpl as typeof fetch });
		const result = await provider.search({ contentType: 'youtube', query: 'storm chasing', offset: 0, count: 20 });

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]?.url).toContain('youtube.com');
		expect(result.moreAvailable).toBe(true);
		expect(result.nextOffset).toBe(1);
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	it('returns zero hits for empty web results', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ query: { more_results_available: false }, web: { results: [] } }),
		);
		const provider = new BraveSearchProvider({ apiKey: API_KEY, fetchImpl: fetchImpl as typeof fetch });
		const result = await provider.search({ contentType: 'youtube', query: 'zzzzunlikely' });
		expect(result.hits).toEqual([]);
		expect(result.moreAvailable).toBe(false);
		expect(result.nextOffset).toBeNull();
	});

	it('rejects malformed responses', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ web: { results: 'nope' } }));
		const provider = new BraveSearchProvider({ apiKey: API_KEY, fetchImpl: fetchImpl as typeof fetch });
		await expect(provider.search({ contentType: 'youtube', query: 'x' })).rejects.toMatchObject({
			code: 'invalid_response',
		});
	});

	it('maps timeout abort to BraveProviderError timeout', async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					const err = new Error('Aborted');
					err.name = 'AbortError';
					reject(err);
				});
			});
		});
		const provider = new BraveSearchProvider({
			apiKey: API_KEY,
			timeoutMs: 5,
			fetchImpl: fetchImpl as typeof fetch,
		});
		await expect(provider.search({ contentType: 'youtube', query: 'storm' })).rejects.toBeInstanceOf(
			BraveProviderError,
		);
		await expect(provider.search({ contentType: 'youtube', query: 'storm' })).rejects.toMatchObject({
			code: 'timeout',
		});
	});

	it('maps 401 and 403', async () => {
		const provider401 = new BraveSearchProvider({
			apiKey: API_KEY,
			fetchImpl: vi.fn(async () => jsonResponse({}, 401)) as typeof fetch,
		});
		await expect(provider401.search({ contentType: 'youtube', query: 'x' })).rejects.toMatchObject({
			code: 'unauthorized',
			status: 401,
		});

		const provider403 = new BraveSearchProvider({
			apiKey: API_KEY,
			fetchImpl: vi.fn(async () => jsonResponse({}, 403)) as typeof fetch,
		});
		await expect(provider403.search({ contentType: 'youtube', query: 'x' })).rejects.toMatchObject({
			code: 'forbidden',
			status: 403,
		});
	});

	it('maps 429 and 5xx', async () => {
		const provider429 = new BraveSearchProvider({
			apiKey: API_KEY,
			fetchImpl: vi.fn(async () => jsonResponse({}, 429)) as typeof fetch,
		});
		await expect(provider429.search({ contentType: 'youtube', query: 'x' })).rejects.toMatchObject({
			code: 'rate_limited',
		});

		const provider500 = new BraveSearchProvider({
			apiKey: API_KEY,
			fetchImpl: vi.fn(async () => jsonResponse({}, 503)) as typeof fetch,
		});
		await expect(provider500.search({ contentType: 'youtube', query: 'x' })).rejects.toMatchObject({
			code: 'server_error',
			status: 503,
		});
	});

	it('requires API key and does not include the key in thrown messages when redacting network errors', async () => {
		const missing = new BraveSearchProvider({ apiKey: '' });
		await expect(missing.search({ contentType: 'youtube', query: 'x' })).rejects.toMatchObject({
			code: 'missing_api_key',
		});

		const fetchImpl = vi.fn(async () => {
			throw new Error(`upstream failed token=${API_KEY}`);
		});
		const provider = new BraveSearchProvider({ apiKey: API_KEY, fetchImpl: fetchImpl as typeof fetch });
		await expect(provider.search({ contentType: 'youtube', query: 'x' })).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(BraveProviderError);
			expect(String(err)).not.toContain(API_KEY);
			expect(String(err)).toContain('[redacted]');
			return true;
		});
	});
});

describe('parseBraveSearchResponse', () => {
	it('skips results missing title or url', () => {
		const parsed = parseBraveSearchResponse({
			web: {
				results: [
					{ title: 'Ok', url: 'https://youtube.com/@a' },
					{ title: 'No url' },
					{ url: 'https://youtube.com/@b' },
				],
			},
		});
		expect(parsed.hits).toHaveLength(1);
	});
});
