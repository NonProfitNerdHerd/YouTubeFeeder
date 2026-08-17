export interface SyncWarning {
	channelId: string;
	channelTitle: string;
	code: string;
	message: string;
}

export function formatSyncCompletion(videosAdded: number, warnings: SyncWarning[]): string {
	const base = `Updated ${videosAdded} videos.`;
	if (!warnings.length) return base;
	if (warnings.length === 1) {
		const name = warnings[0]?.channelTitle?.trim() || 'Unknown channel';
		return `${base} Skipped 1 unavailable channel: ${name}.`;
	}
	return `${base} Skipped ${warnings.length} unavailable channels.`;
}

export function skippedChannelNames(warnings: SyncWarning[], limit = 12): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const warning of warnings) {
		const name = warning.channelTitle?.trim() || warning.channelId;
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
		if (names.length >= limit) break;
	}
	return names;
}
