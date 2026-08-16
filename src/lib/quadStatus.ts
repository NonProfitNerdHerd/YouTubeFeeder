export function formatQuadJobStatus(result: {
	cached?: boolean;
	inProgress?: boolean;
	cacheHit?: boolean;
	duplicatePrevented?: boolean;
	job?: string;
	liveCount?: number;
	nextEligibleAt?: string | null;
	searchQueries?: number;
	error?: string;
}): string {
	if (result.error) return `Partial failure: ${result.error}`;
	if (result.inProgress || result.duplicatePrevented) return 'Duplicate request prevented — using the job already running.';
	if (result.cached || result.cacheHit) {
		const next = result.nextEligibleAt ? ` Next eligible ${result.nextEligibleAt}.` : '';
		return `Cached result returned.${next}`;
	}
	if (result.job === 'confirm') return `Refresh completed — ${result.liveCount ?? 0} live.`;
	if (result.job === 'discover') return 'Discovery completed.';
	if (result.job === 'recover') return 'Recover completed.';
	return 'Refresh completed.';
}

export function searchCallsForFailedAlwaysOn(count: number): number {
	return Math.max(0, count);
}
