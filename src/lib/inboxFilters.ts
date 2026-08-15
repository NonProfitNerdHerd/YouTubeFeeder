import type { InboxItem, InboxQuery, InboxView } from '../types';

export function matchesInboxView(item: InboxItem, view: InboxView): boolean {
	if (item.hidden) return false;
	switch (view) {
		case 'inbox':
			return !item.archived;
		case 'unread':
			return !item.archived && item.unread;
		case 'live':
			return !item.archived && item.livestreamStatus === 'live';
		case 'upcoming':
			return !item.archived && item.livestreamStatus === 'upcoming';
		case 'videos':
			return !item.archived && item.contentType === 'video';
		case 'starred':
			return item.starred && !item.archived;
		case 'archived':
			return item.archived;
		default:
			return !item.archived;
	}
}

export function filterInboxItems(items: InboxItem[], query: InboxQuery): InboxItem[] {
	const search = query.search.trim().toLowerCase();
	let result = items.filter((item) => matchesInboxView(item, query.view));
	if (query.unreadOnly) result = result.filter((item) => item.unread);
	if (query.channelId) result = result.filter((item) => item.channelId === query.channelId);
	if (search) {
		result = result.filter(
			(item) => item.title.toLowerCase().includes(search) || item.channelTitle.toLowerCase().includes(search),
		);
	}

	result.sort((a, b) => {
		if (query.sort === 'channel') return a.channelTitle.localeCompare(b.channelTitle) || compareTime(b, a);
		if (query.sort === 'oldest') return compareTime(a, b);
		if (query.sort === 'liveFirst') {
			const rank = (item: InboxItem) => (item.livestreamStatus === 'live' ? 0 : item.livestreamStatus === 'upcoming' ? 1 : 2);
			const d = rank(a) - rank(b);
			if (d !== 0) return d;
			return compareTime(b, a);
		}
		return compareTime(b, a);
	});
	return result;
}

function compareTime(a: InboxItem, b: InboxItem): number {
	const ta = Date.parse(a.scheduledStartAt ?? a.publishedAt ?? a.firstSeenAt);
	const tb = Date.parse(b.scheduledStartAt ?? b.publishedAt ?? b.firstSeenAt);
	return ta - tb;
}

export function inboxCounts(items: InboxItem[]) {
	const visible = items.filter((item) => !item.hidden);
	return {
		inbox: visible.filter((item) => !item.archived).length,
		unread: visible.filter((item) => !item.archived && item.unread).length,
		live: visible.filter((item) => !item.archived && item.livestreamStatus === 'live').length,
		upcoming: visible.filter((item) => !item.archived && item.livestreamStatus === 'upcoming').length,
	};
}
