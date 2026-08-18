export function playthroughQueue<T extends { videoId: string; embeddable: boolean }>(items: T[] | null | undefined): T[] {
	return (items ?? []).filter((item) => item.embeddable);
}

export function playthroughStartId(ids: string[], fromId: string | null | undefined): string | null {
	if (!ids.length) return null;
	if (fromId && ids.includes(fromId)) return fromId;
	return ids[0] ?? null;
}

export function playthroughNextId(ids: string[], currentId: string): string | null {
	const index = ids.indexOf(currentId);
	if (index < 0) return ids[0] ?? null;
	return ids[index + 1] ?? null;
}
