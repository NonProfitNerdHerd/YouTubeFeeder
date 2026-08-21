import { buildBraveYoutubeSearchQuery, DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION } from './braveQueryStrategy';
import {
	BraveProviderError,
	type DiscoveryProviderRawHit,
	type DiscoverySearchProvider,
	type DiscoverySearchRequest,
	type DiscoverySearchResult,
} from './types';

export const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_MAX_COUNT = 20;
export const BRAVE_MAX_OFFSET = 9;
export const DEFAULT_BRAVE_TIMEOUT_MS = 8_000;

export interface BraveSearchProviderOptions {
	apiKey: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	strategyVersion?: string;
}

interface BraveWebResult {
	title?: unknown;
	url?: unknown;
	description?: unknown;
}

interface BraveSearchResponse {
	query?: {
		original?: unknown;
		altered?: unknown;
		more_results_available?: unknown;
	};
	web?: {
		results?: unknown;
	};
}

function redactSecrets(value: string, apiKey: string): string {
	if (!apiKey) return value;
	return value.split(apiKey).join('[redacted]');
}

export function clampBraveCount(count: number | undefined): number {
	if (count == null || !Number.isFinite(count)) return BRAVE_MAX_COUNT;
	return Math.min(BRAVE_MAX_COUNT, Math.max(1, Math.floor(count)));
}

export function clampBraveOffset(offset: number | undefined): number {
	if (offset == null || !Number.isFinite(offset)) return 0;
	return Math.min(BRAVE_MAX_OFFSET, Math.max(0, Math.floor(offset)));
}

export function parseBraveSearchResponse(body: unknown): DiscoverySearchResult {
	if (!body || typeof body !== 'object') {
		throw new BraveProviderError('invalid_response', 'Brave response was not a JSON object');
	}
	const data = body as BraveSearchResponse;
	const rawResults = data.web?.results;
	if (rawResults != null && !Array.isArray(rawResults)) {
		throw new BraveProviderError('invalid_response', 'Brave web.results was not an array');
	}

	const hits: DiscoveryProviderRawHit[] = [];
	for (const item of (rawResults as BraveWebResult[] | undefined) ?? []) {
		if (!item || typeof item !== 'object') continue;
		const url = typeof item.url === 'string' ? item.url.trim() : '';
		const title = typeof item.title === 'string' ? item.title.trim() : '';
		if (!url || !title) continue;
		const description = typeof item.description === 'string' ? item.description.slice(0, 1000) : undefined;
		hits.push({ title, url, description });
	}

	const moreAvailable = Boolean(data.query?.more_results_available);
	return {
		hits,
		nextOffset: null,
		moreAvailable,
		providerMeta: {
			originalQuery: typeof data.query?.original === 'string' ? data.query.original : undefined,
			alteredQuery: typeof data.query?.altered === 'string' ? data.query.altered : undefined,
		},
	};
}

export class BraveSearchProvider implements DiscoverySearchProvider {
	readonly id = 'brave';
	readonly #apiKey: string;
	readonly #timeoutMs: number;
	readonly #fetchImpl: typeof fetch;
	readonly #defaultStrategyVersion: string;

	constructor(opts: BraveSearchProviderOptions) {
		this.#apiKey = opts.apiKey?.trim() ?? '';
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_BRAVE_TIMEOUT_MS;
		this.#fetchImpl =
			opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
		this.#defaultStrategyVersion = opts.strategyVersion ?? DEFAULT_BRAVE_YOUTUBE_STRATEGY_VERSION;
	}

	async search(request: DiscoverySearchRequest): Promise<DiscoverySearchResult> {
		if (!this.#apiKey) {
			throw new BraveProviderError('missing_api_key', 'BRAVE_SEARCH_API_KEY is not configured');
		}
		const userQuery = request.query.trim();
		if (!userQuery) {
			throw new BraveProviderError('empty_query', 'Search query is empty');
		}
		if (request.contentType !== 'youtube') {
			throw new BraveProviderError('invalid_response', `Brave provider does not support contentType=${request.contentType}`);
		}

		const strategyVersion = request.strategyVersion ?? this.#defaultStrategyVersion;
		const providerQuery = buildBraveYoutubeSearchQuery(userQuery, strategyVersion);
		if (!providerQuery) {
			throw new BraveProviderError('empty_query', 'Search query is empty');
		}

		const count = clampBraveCount(request.count);
		const offset = clampBraveOffset(request.offset);
		const url = new URL(BRAVE_WEB_SEARCH_URL);
		url.searchParams.set('q', providerQuery);
		url.searchParams.set('count', String(count));
		url.searchParams.set('offset', String(offset));

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		let response: Response;
		try {
			response = await this.#fetchImpl(url.toString(), {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					'X-Subscription-Token': this.#apiKey,
				},
				signal: controller.signal,
			});
		} catch (err) {
			const message = redactSecrets(err instanceof Error ? err.message : String(err), this.#apiKey);
			if (err instanceof Error && err.name === 'AbortError') {
				throw new BraveProviderError('timeout', `Brave search timed out after ${this.#timeoutMs}ms`);
			}
			throw new BraveProviderError('network_error', `Brave search network error: ${message}`);
		} finally {
			clearTimeout(timer);
		}

		if (response.status === 401) {
			throw new BraveProviderError('unauthorized', 'Brave search unauthorized', 401);
		}
		if (response.status === 403) {
			throw new BraveProviderError('forbidden', 'Brave search forbidden', 403);
		}
		if (response.status === 429) {
			throw new BraveProviderError('rate_limited', 'Brave search rate limited', 429);
		}
		if (response.status >= 500) {
			throw new BraveProviderError('server_error', `Brave search server error (${response.status})`, response.status);
		}
		if (!response.ok) {
			throw new BraveProviderError('server_error', `Brave search HTTP ${response.status}`, response.status);
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch {
			throw new BraveProviderError('invalid_response', 'Brave search returned non-JSON body');
		}

		const parsed = parseBraveSearchResponse(json);
		const nextOffset = parsed.moreAvailable && offset < BRAVE_MAX_OFFSET ? offset + 1 : null;
		return {
			...parsed,
			nextOffset,
			providerMeta: {
				...parsed.providerMeta,
				strategyVersion,
				providerQuery,
				offset,
				count,
			},
		};
	}
}
