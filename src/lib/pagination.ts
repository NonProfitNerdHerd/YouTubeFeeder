export interface Page<T> {
	items: T[];
	nextPageToken?: string;
}

export async function collectAllPages<T>(
	fetchPage: (pageToken?: string) => Promise<Page<T>>,
	maxPages = 100,
): Promise<T[]> {
	const all: T[] = [];
	let token: string | undefined;
	for (let i = 0; i < maxPages; i++) {
		const page = await fetchPage(token);
		all.push(...page.items);
		if (!page.nextPageToken) break;
		token = page.nextPageToken;
	}
	return all;
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		out.push(item);
	}
	return out;
}

export function backoffMs(attempt: number, base = 500, cap = 15_000): number {
	const exp = Math.min(cap, base * 2 ** attempt);
	const jitter = Math.floor(Math.random() * 100);
	return exp + jitter;
}
