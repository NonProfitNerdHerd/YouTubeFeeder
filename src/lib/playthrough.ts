export type PlaythroughStartMode = 'top' | 'selected';

export function playthroughQueue<T extends { videoId: string; embeddable: boolean }>(items: T[] | null | undefined): T[] {
	return (items ?? []).filter((item) => item.embeddable);
}

/** Embeddable queue starting at `fromId` (inclusive). Empty if selection is missing or not playable. */
export function playthroughQueueFromSelected<T extends { videoId: string; embeddable: boolean }>(
	items: T[] | null | undefined,
	fromId: string | null | undefined,
): T[] {
	const queue = playthroughQueue(items);
	if (!fromId) return [];
	const index = queue.findIndex((item) => item.videoId === fromId);
	if (index < 0) return [];
	return queue.slice(index);
}

export function playthroughStartId(
	ids: string[],
	fromId: string | null | undefined,
	mode: PlaythroughStartMode = 'selected',
): string | null {
	if (!ids.length) return null;
	if (mode === 'selected' && fromId && ids.includes(fromId)) return fromId;
	return ids[0] ?? null;
}

export function playthroughNextId(ids: string[], currentId: string): string | null {
	const index = ids.indexOf(currentId);
	if (index < 0) return ids[0] ?? null;
	return ids[index + 1] ?? null;
}
