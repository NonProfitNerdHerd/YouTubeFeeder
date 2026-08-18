export function inboxIsStale(currentNewest: string | null | undefined, serverNewest: string | null | undefined): boolean {
	if (!serverNewest) return false;
	if (!currentNewest) return true;
	const current = Date.parse(currentNewest);
	const server = Date.parse(serverNewest);
	if (!Number.isFinite(server)) return false;
	if (!Number.isFinite(current)) return true;
	return server > current;
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
