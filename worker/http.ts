import type { ApiErrorBody } from '../src/types';

export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiError(status: number, code: string, message: string): Response {
	const body: ApiErrorBody = { error: { code, message } };
	return json(body, { status });
}

export async function readJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}
