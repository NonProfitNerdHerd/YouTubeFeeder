export const INBOX_PAGE_LIMIT = 200;

export function inboxItemHeadAt(item: {
	publishedAt: string | null;
	scheduledStartAt: string | null;
	firstSeenAt: string;
}): string | null {
	return item.publishedAt ?? item.scheduledStartAt ?? item.firstSeenAt ?? null;
}

export function inboxIsStale(currentNewest: string | null | undefined, serverNewest: string | null | undefined): boolean {
	if (!serverNewest) return false;
	if (!currentNewest) return true;
	const current = Date.parse(currentNewest);
	const server = Date.parse(serverNewest);
	if (!Number.isFinite(server)) return false;
	if (!Number.isFinite(current)) return true;
	return server > current;
}

export function prependNewerInboxItems<
	T extends { videoId: string; publishedAt: string | null; scheduledStartAt: string | null; firstSeenAt: string },
>(current: T[], incoming: T[], currentHead: string | null | undefined): T[] {
	const seen = new Set(current.map((item) => item.videoId));
	const added = incoming.filter((item) => {
		if (seen.has(item.videoId)) return false;
		const at = inboxItemHeadAt(item);
		if (!at) return false;
		if (!currentHead) return true;
		const head = Date.parse(currentHead);
		const time = Date.parse(at);
		if (!Number.isFinite(time)) return false;
		if (!Number.isFinite(head)) return true;
		return time >= head;
	});
	if (!added.length) return current;
	return [...added, ...current];
}

export function appendOlderInboxItems<T extends { videoId: string }>(current: T[], incoming: T[]): T[] {
	const seen = new Set(current.map((item) => item.videoId));
	const extra = incoming.filter((item) => !seen.has(item.videoId));
	if (!extra.length) return current;
	return [...current, ...extra];
}

export function inboxPageHasMore(itemCount: number): boolean {
	return itemCount >= INBOX_PAGE_LIMIT;
}

export function formatFeedHealth(status: {
	overdueCount?: number;
	quotaLimited?: boolean;
	reconciledLastTwoHours?: number;
	activeChannels?: number;
}): string {
	if (status.quotaLimited) return 'Quota limited — catching up later.';
	if ((status.overdueCount ?? 0) > 0) {
		return `${status.overdueCount} channel${status.overdueCount === 1 ? '' : 's'} due for a check.`;
	}
	const checked = status.reconciledLastTwoHours ?? 0;
	return `${checked} channel${checked === 1 ? '' : 's'} checked in the last 2 hours.`;
}
