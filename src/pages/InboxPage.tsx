import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CategoryRecord, ChannelRecord, CurrentUser, InboxItem, LiveGridSize, WatchlistRecord } from '../types';
import { LIVE_GRID_SIZES } from '../types';
import { youtubeEmbedUrl, youtubeWatchUrl } from '../lib/youtubeUrl';
import { isAndroidClient, isNarrowFeeder } from '../lib/androidClient';
import { TEST_APK_PATH, STREAMFEEDER_DISPLAY_NAME } from '../lib/androidRelease';
import { qrSvgForUrl } from '../lib/qrSvg';
import { formatSyncCompletion, skippedChannelNames, type SyncWarning } from '../lib/syncStatus';
import { LivePage } from './LivePage';
import '../styles/app.css';
import '../styles/live.css';
import '../styles/download.css';

interface SyncApiBody {
	error?: { message: string };
	errorSummary?: string | null;
	channelsChecked?: number;
	videosAdded?: number;
	done?: boolean;
	nextOffset?: number;
	nextPageToken?: string;
	pulled?: number;
	want?: number;
	totalChannels?: number;
	channelsSkipped?: number;
	warnings?: SyncWarning[];
	status?: string;
}

function syncMessage(body: SyncApiBody, fallback: string): string {
	return body.error?.message || body.errorSummary || fallback;
}

function toLocalInputValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function tomorrowMorning(): Date {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(8, 0, 0, 0);
	return d;
}

function relativeRelease(iso: string | null): string {
	if (!iso) return 'Unknown date';
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return 'Unknown date';
	const delta = Date.now() - then;
	const future = delta < 0;
	const seconds = Math.round(Math.abs(delta) / 1000);
	const phrase = (unit: string, n: number) => {
		const label = n === 1 ? `1 ${unit}` : `${n} ${unit}s`;
		return future ? `In ${label}` : `${label} ago`;
	};
	if (seconds < 60) return future ? 'Soon' : 'Just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return phrase('minute', minutes);
	const hours = Math.round(minutes / 60);
	if (hours < 24) return phrase('hour', hours);
	const days = Math.round(hours / 24);
	if (days < 14) return phrase('day', days);
	const weeks = Math.round(days / 7);
	if (weeks < 8) return phrase('week', weeks);
	const months = Math.round(days / 30);
	if (months < 18) return phrase('month', months);
	return phrase('year', Math.round(days / 365));
}

function IconPencil() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
			/>
		</svg>
	);
}

function IconTrash() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v10h-2V9zm4 0h2v10h-2V9zM7 9h2v10H7V9zm-1 12h12a1 1 0 0 0 1-1V8H5v12a1 1 0 0 0 1 1z"
			/>
		</svg>
	);
}

function IconClock() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6 3.2 1.9-.8 1.3L11 13.5V7h2v5.6z"
			/>
		</svg>
	);
}

function IconRestore() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
		</svg>
	);
}

function IconList() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path fill="currentColor" d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
		</svg>
	);
}

function IconPhone() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v12h10V5H7zm5 15.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5z"
			/>
		</svg>
	);
}

function categoryNames(channel: ChannelRecord, all: CategoryRecord[]): string {
	const names = channel.categoryIds
		.map((id) => all.find((cat) => cat.id === id)?.name)
		.filter((name): name is string => Boolean(name));
	return names.length ? names.join(', ') : 'No category';
}

export function InboxPage({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
	const [channels, setChannels] = useState<ChannelRecord[]>([]);
	const [categories, setCategories] = useState<CategoryRecord[]>([]);
	const [items, setItems] = useState<InboxItem[] | null>(null);
	const [channelId, setChannelId] = useState<string | null>(null);
	const [categoryId, setCategoryId] = useState<string | null>(null);
	const [leftTab, setLeftTab] = useState<'inbox' | 'snoozed' | 'deleted' | 'watchlist' | 'streams' | 'categories'>('inbox');
	const [mainSection, setMainSection] = useState<'feed' | 'live'>('feed');
	const [liveSidebarOpen, setLiveSidebarOpen] = useState(true);
	const [liveHeaderStatus, setLiveHeaderStatus] = useState<{ text: string; error: boolean } | null>(null);
	const [liveGridChrome, setLiveGridChrome] = useState<{
		gridSize: LiveGridSize;
		setGrid: (size: LiveGridSize) => void;
	} | null>(null);
	const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
	const leftScrollRef = useRef<HTMLDivElement | null>(null);
	const [watchlists, setWatchlists] = useState<WatchlistRecord[]>([]);
	const [watchlistId, setWatchlistId] = useState<string | null>(null);
	const [newWatchlist, setNewWatchlist] = useState('');
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [watchlisting, setWatchlisting] = useState<InboxItem | null>(null);
	const [snoozing, setSnoozing] = useState<InboxItem | null>(null);
	const [snoozeUntil, setSnoozeUntil] = useState(toLocalInputValue(tomorrowMorning()));
	const [editing, setEditing] = useState<ChannelRecord | null>(null);
	const [newCategory, setNewCategory] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [syncWarnings, setSyncWarnings] = useState<SyncWarning[]>([]);
	const [showSkipDetails, setShowSkipDetails] = useState(false);
	const autoStarted = useRef(false);
	const androidClient = isAndroidClient();
	const [narrow, setNarrow] = useState(isNarrowFeeder());
	const [offline, setOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
	const [mobilePanel, setMobilePanel] = useState<'inbox' | 'watchlists' | 'filters' | 'account'>('inbox');
	const [androidQrOpen, setAndroidQrOpen] = useState(false);
	const [androidQrSvg, setAndroidQrSvg] = useState('');
	const [androidAppVersion, setAndroidAppVersion] = useState<{ versionName: string; versionCode: number } | null>(null);
	const [inboxSelectedIds, setInboxSelectedIds] = useState<string[]>([]);
	const [bulkSnoozeIds, setBulkSnoozeIds] = useState<string[] | null>(null);
	const [bulkWatchlistIds, setBulkWatchlistIds] = useState<string[] | null>(null);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const inboxQuery = new URLSearchParams();
			if (leftTab === 'streams' && channelId) inboxQuery.set('channelId', channelId);
			if ((leftTab === 'inbox' || leftTab === 'snoozed' || leftTab === 'deleted' || leftTab === 'categories') && categoryId) {
				inboxQuery.set('categoryId', categoryId);
			}
			if (leftTab === 'snoozed') inboxQuery.set('view', 'snoozed');
			if (leftTab === 'deleted') inboxQuery.set('view', 'deleted');
			if (leftTab === 'watchlist') {
				inboxQuery.set('view', 'watchlist');
				if (watchlistId) inboxQuery.set('watchlistId', watchlistId);
			}
			const qs = inboxQuery.toString();
			const [chRes, inRes, catRes, wlRes] = await Promise.all([
				fetch('/api/channels', { credentials: 'same-origin', signal }),
				fetch(qs ? `/api/inbox?${qs}` : '/api/inbox', { credentials: 'same-origin', signal }),
				fetch('/api/categories', { credentials: 'same-origin', signal }),
				fetch('/api/watchlists', { credentials: 'same-origin', signal }),
			]);
			if (!chRes.ok || !inRes.ok || !catRes.ok || !wlRes.ok) throw new Error('Could not load subscriptions.');
			setChannels(((await chRes.json()) as { channels: ChannelRecord[] }).channels);
			setItems(((await inRes.json()) as { items: InboxItem[] }).items);
			setCategories(((await catRes.json()) as { categories: CategoryRecord[] }).categories);
			const nextLists = ((await wlRes.json()) as { watchlists: WatchlistRecord[] }).watchlists;
			setWatchlists(nextLists);
		},
		[channelId, categoryId, leftTab, watchlistId],
	);

	useEffect(() => {
		const ac = new AbortController();
		load(ac.signal).catch((err: unknown) => {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			setError(err instanceof Error ? err.message : 'Could not load inbox.');
		});
		return () => ac.abort();
	}, [load]);

	useEffect(() => {
		const onResize = () => setNarrow(isNarrowFeeder());
		const onOffline = () => setOffline(true);
		const onOnline = () => {
			setOffline(false);
			void load().catch(() => undefined);
		};
		const onVisible = () => {
			if (document.visibilityState === 'visible') void load().catch(() => undefined);
		};
		window.addEventListener('resize', onResize);
		window.addEventListener('offline', onOffline);
		window.addEventListener('online', onOnline);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			window.removeEventListener('resize', onResize);
			window.removeEventListener('offline', onOffline);
			window.removeEventListener('online', onOnline);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, [load]);

	useEffect(() => {
		if (androidClient && mainSection !== 'feed') setMainSection('feed');
	}, [androidClient, mainSection]);

	useEffect(() => {
		const onPop = () => setSelectedVideoId(null);
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, []);

	useEffect(() => {
		leftScrollRef.current?.scrollTo({ top: 0 });
	}, [categoryId, leftTab, watchlistId, channelId]);

	useEffect(() => {
		if (leftTab !== 'inbox') {
			setInboxSelectedIds([]);
			setBulkSnoozeIds(null);
			setBulkWatchlistIds(null);
		}
	}, [leftTab]);

	function nextVideoIdAfterRemoval(list: InboxItem[], removedId: string): string | null {
		const index = list.findIndex((item) => item.videoId === removedId);
		if (index < 0) return list[0]?.videoId ?? null;
		return list[index + 1]?.videoId ?? list[index - 1]?.videoId ?? null;
	}

	async function syncNow() {
		setSyncing(true);
		setError(null);
		setSyncWarnings([]);
		setShowSkipDetails(false);
		setStatus('Syncing subscriptions…');
		try {
			const sub = await fetch('/api/sync/subscriptions?force=1', { method: 'POST', credentials: 'same-origin' });
			const subBody = (await sub.json()) as SyncApiBody;
			if (!sub.ok) throw new Error(syncMessage(subBody, 'Subscription sync failed.'));
			setStatus(`Found ${subBody.channelsChecked ?? 0} channels. Fetching videos…`);
			await load();
			let offset = 0;
			let added = 0;
			const accumulatedWarnings: SyncWarning[] = [];
			for (;;) {
				const content = await fetch(`/api/sync/content?force=1&offset=${offset}`, { method: 'POST', credentials: 'same-origin' });
				const contentBody = (await content.json()) as SyncApiBody;
				if (!content.ok) throw new Error(syncMessage(contentBody, 'Video sync failed.'));
				added += contentBody.videosAdded ?? 0;
				if (contentBody.warnings?.length) accumulatedWarnings.push(...contentBody.warnings);
				const next = contentBody.nextOffset ?? offset;
				setStatus(`Fetching videos… ${next} / ${contentBody.totalChannels ?? next} channels`);
				await load();
				if (contentBody.done) break;
				if (next === offset) throw new Error('Video sync stalled without progressing.');
				offset = next;
			}
			setSyncWarnings(accumulatedWarnings);
			setStatus(formatSyncCompletion(added, accumulatedWarnings));
		} catch (err: unknown) {
			setStatus(null);
			setSyncWarnings([]);
			setError(err instanceof Error ? err.message : 'Sync failed.');
			await load().catch(() => undefined);
		} finally {
			setSyncing(false);
		}
	}

	async function catchUpChannel(channelId: string, title: string, pull: number) {
		if (pull < 1) {
			setError('Set max videos to pull above 0 on Edit, then catch up.');
			return;
		}
		setSyncing(true);
		setError(null);
		setStatus(`Catching up ${title}… 0 / ${pull}`);
		try {
			let pageToken = '';
			let pulled = 0;
			let added = 0;
			const want = Math.min(500, pull);
			for (;;) {
				setStatus(`Catching up ${title}… ${pulled} / ${want}`);
				const res = await fetch('/api/sync/catchup', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ channelId, pageToken, pulled }),
				});
				const body = (await res.json().catch(() => ({}))) as SyncApiBody;
				if (!res.ok) throw new Error(syncMessage(body, 'Catch up failed.'));
				added += body.videosAdded ?? 0;
				pulled = body.pulled ?? pulled;
				const nextWant = body.want ?? want;
				setStatus(`Catching up ${title}… ${pulled} / ${nextWant}`);
				await load();
				if (body.done) break;
				pageToken = body.nextPageToken ?? '';
				if (!pageToken) break;
			}
			setStatus(`Added ${added} videos from ${title}.`);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Catch up failed.');
			await load().catch(() => undefined);
		} finally {
			setSyncing(false);
		}
	}

	async function syncSubscriptionsOnly() {
		setSyncing(true);
		setError(null);
		setStatus('Syncing subscriptions…');
		try {
			const sub = await fetch('/api/sync/subscriptions?force=1', { method: 'POST', credentials: 'same-origin' });
			const subBody = (await sub.json()) as SyncApiBody;
			if (!sub.ok) throw new Error(syncMessage(subBody, 'Subscription sync failed.'));
			await load();
			setStatus(`Updated ${subBody.channelsChecked ?? 0} subscriptions.`);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Subscription sync failed.');
			await load().catch(() => undefined);
		} finally {
			setSyncing(false);
		}
	}

	useEffect(() => {
		if (autoStarted.current) return;
		if (items === null || syncing) return;
		if (channels.length > 0) return;
		autoStarted.current = true;
		void syncNow();
	}, [channels.length, items, syncing]);

	async function addCategory(event: FormEvent) {
		event.preventDefault();
		const res = await fetch('/api/categories', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: newCategory }),
		});
		if (!res.ok) return;
		setNewCategory('');
		await load();
	}

	async function saveEdit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!editing) return;
		const form = new FormData(event.currentTarget);
		const selected = form.getAll('categoryIds').map(String);
		const res = await fetch(`/api/channels/${encodeURIComponent(editing.channelId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({
				followInInbox: form.get('followInInbox') === 'on',
				maxVideosToPull: Number(form.get('maxVideosToPull') || 0),
				categoryIds: selected,
			}),
		});
		if (!res.ok) {
			setError('Could not save channel settings.');
			return;
		}
		setEditing(null);
		await load();
	}

	async function removeCategory(id: string) {
		await fetch(`/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		if (categoryId === id) setCategoryId(null);
		await load();
	}

	async function addWatchlist(event: FormEvent) {
		event.preventDefault();
		setError(null);
		const res = await fetch('/api/watchlists', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: newWatchlist }),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not create watchlist.');
			return;
		}
		setNewWatchlist('');
		await load();
	}

	async function saveWatchlistName(event: FormEvent) {
		event.preventDefault();
		if (!renamingId) return;
		setError(null);
		const res = await fetch(`/api/watchlists/${encodeURIComponent(renamingId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: renameValue }),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not rename watchlist.');
			return;
		}
		setRenamingId(null);
		setRenameValue('');
		await load();
	}

	async function removeWatchlist(id: string, videoCount: number) {
		if (videoCount > 0) {
			setError('Remove all videos from this watchlist before deleting it.');
			return;
		}
		if (!window.confirm('Delete this empty watchlist?')) return;
		setError(null);
		const res = await fetch(`/api/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not delete watchlist.');
			return;
		}
		if (watchlistId === id) setWatchlistId(null);
		await load();
	}

	async function saveToWatchlist(videoId: string, listId: string) {
		if (!listId) {
			setError('Create a watchlist first.');
			return;
		}
		const res = await fetch(`/api/watchlists/${encodeURIComponent(listId)}/items`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ videoId }),
		});
		if (!res.ok) {
			setError('Could not add to watchlist.');
			return;
		}
		setWatchlisting(null);
		if (selectedVideoId === videoId) setSelectedVideoId(null);
		await load();
	}

	async function saveBulkToWatchlist(listId: string) {
		if (!bulkWatchlistIds?.length) return;
		if (!listId) {
			setError('Create a watchlist first.');
			return;
		}
		const ids = [...bulkWatchlistIds];
		setBulkWatchlistIds(null);
		setInboxSelectedIds([]);
		let failed = false;
		for (const videoId of ids) {
			const res = await fetch(`/api/watchlists/${encodeURIComponent(listId)}/items`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ videoId }),
			});
			if (!res.ok) failed = true;
		}
		if (failed) setError('Could not add some videos to the watchlist.');
		await load();
	}

	async function takeOffWatchlist(videoId: string) {
		if (!watchlistId) return;
		const previous = items;
		const nextId = selectedVideoId === videoId && previous ? nextVideoIdAfterRemoval(previous, videoId) : selectedVideoId;
		if (previous) setItems(previous.filter((item) => item.videoId !== videoId));
		await fetch(`/api/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(videoId)}`, {
			method: 'DELETE',
			credentials: 'same-origin',
		});
		if (selectedVideoId === videoId) setSelectedVideoId(nextId);
		await load();
	}

	async function patchInbox(
		videoId: string,
		body: { action: 'delete' | 'snooze' | 'unsnooze' | 'restore' | 'notes'; until?: string; notes?: string },
	) {
		const previous = items;
		const nextId =
			body.action !== 'notes' && selectedVideoId === videoId && previous
				? nextVideoIdAfterRemoval(previous, videoId)
				: selectedVideoId;
		if (previous && body.action !== 'notes') {
			setItems(previous.filter((item) => item.videoId !== videoId));
		}
		const res = await fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			if (previous) setItems(previous);
			setError('Could not update that video.');
			return false;
		}
		if (body.action !== 'notes' && selectedVideoId === videoId) setSelectedVideoId(nextId);
		await load();
		return true;
	}

	async function confirmSnooze(event: FormEvent) {
		event.preventDefault();
		const until = new Date(snoozeUntil);
		if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) {
			setError('Pick a future date and time.');
			return;
		}
		if (bulkSnoozeIds?.length) {
			const ids = [...bulkSnoozeIds];
			const previous = items;
			if (previous) setItems(previous.filter((item) => !ids.includes(item.videoId)));
			setBulkSnoozeIds(null);
			setInboxSelectedIds([]);
			if (selectedVideoId && ids.includes(selectedVideoId) && previous) {
				const remaining = previous.filter((item) => !ids.includes(item.videoId));
				setSelectedVideoId(remaining[0]?.videoId ?? null);
			}
			let failed = false;
			for (const videoId of ids) {
				const res = await fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ action: 'snooze', until: until.toISOString() }),
				});
				if (!res.ok) failed = true;
			}
			if (failed) {
				if (previous) setItems(previous);
				setError('Could not snooze some videos.');
			}
			await load();
			return;
		}
		if (!snoozing) return;
		const ok = await patchInbox(snoozing.videoId, { action: 'snooze', until: until.toISOString() });
		if (ok) setSnoozing(null);
	}

	async function bulkDeleteSelected() {
		const ids = [...inboxSelectedIds];
		if (!ids.length) return;
		const previous = items;
		if (previous) setItems(previous.filter((item) => !ids.includes(item.videoId)));
		setInboxSelectedIds([]);
		if (selectedVideoId && ids.includes(selectedVideoId) && previous) {
			const remaining = previous.filter((item) => !ids.includes(item.videoId));
			setSelectedVideoId(remaining[0]?.videoId ?? null);
		}
		let failed = false;
		for (const videoId of ids) {
			const res = await fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ action: 'delete' }),
			});
			if (!res.ok) failed = true;
		}
		if (failed) {
			if (previous) setItems(previous);
			setError('Could not delete some videos.');
		}
		await load();
	}

	function toggleInboxSelect(videoId: string) {
		setInboxSelectedIds((current) =>
			current.includes(videoId) ? current.filter((id) => id !== videoId) : [...current, videoId],
		);
	}

	const phoneLayout = androidClient || narrow;
	const selectedVideo =
		items?.find((item) => item.videoId === selectedVideoId) ?? (phoneLayout ? null : (items?.[0] ?? null));

	function openVideo(videoId: string) {
		setSelectedVideoId(videoId);
		if (phoneLayout) history.pushState({ feederVideo: videoId }, '');
	}

	function watchlistButton(item: InboxItem) {
		return (
			<button
				className="icon-btn"
				type="button"
				title="Add to watchlist"
				aria-label="Add to watchlist"
				onClick={() => setWatchlisting(item)}
			>
				<IconList />
			</button>
		);
	}

	function renderPreview(item: InboxItem, mode: 'inbox' | 'snoozed' | 'deleted' | 'watchlist') {
		return (
			<div className="preview">
				<header className="preview-header">
					<div className="preview-identity">
						<span className="video-title">{item.title}</span>
						<small className="muted">
							{item.channelTitle} · {relativeRelease(item.publishedAt)}
						</small>
					</div>
					<div className="preview-header-actions">
						{mode === 'deleted' ? (
							<button
								className="icon-btn"
								type="button"
								title="Restore"
								aria-label="Restore"
								onClick={() => void patchInbox(item.videoId, { action: 'restore' })}
							>
								<IconRestore />
							</button>
						) : (
							<>
								<button
									className="icon-btn"
									type="button"
									title="Delete"
									aria-label="Delete"
									onClick={() => void patchInbox(item.videoId, { action: 'delete' })}
								>
									<IconTrash />
								</button>
								{mode === 'watchlist' ? (
									<button
										className="icon-btn"
										type="button"
										title="Remove from watchlist"
										aria-label="Remove from watchlist"
										onClick={() => void takeOffWatchlist(item.videoId)}
									>
										<IconRestore />
									</button>
								) : mode === 'snoozed' ? (
									<button
										className="icon-btn"
										type="button"
										title="Wake"
										aria-label="Wake"
										onClick={() => void patchInbox(item.videoId, { action: 'unsnooze' })}
									>
										<IconRestore />
									</button>
								) : (
									<button
										className="icon-btn"
										type="button"
										title="Snooze"
										aria-label="Snooze"
										onClick={() => {
											setSnoozeUntil(toLocalInputValue(tomorrowMorning()));
											setSnoozing(item);
										}}
									>
										<IconClock />
									</button>
								)}
								{mode === 'inbox' || mode === 'snoozed' ? watchlistButton(item) : null}
							</>
						)}
					</div>
				</header>
				<div className="preview-player">
					{item.embeddable ? (
						<iframe
							title={item.title}
							src={youtubeEmbedUrl(item.videoId)}
							allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
							allowFullScreen
						/>
					) : (
						<img src={item.thumbnailUrl} alt="" />
					)}
				</div>
				<div className="preview-meta">
					{mode === 'snoozed' && item.snoozedUntil ? (
						<p className="muted">Snoozed until {new Date(item.snoozedUntil).toLocaleString()}</p>
					) : null}
					<p className="preview-description">{item.descriptionExcerpt}</p>
					<a className="ghost" href={youtubeWatchUrl(item.videoId)} target="_blank" rel="noreferrer">
						Open on YouTube
					</a>
				</div>
				<label className="notes-label">
					<span className="muted">Notes</span>
					<textarea
						key={item.videoId}
						defaultValue={item.notes}
						rows={3}
						placeholder="Notes for this video"
						onBlur={(event) => {
							const next = event.target.value;
							if (next === item.notes) return;
							void patchInbox(item.videoId, { action: 'notes', notes: next });
						}}
					/>
				</label>
			</div>
		);
	}

	function renderFeed(list: InboxItem[] | null, compact: boolean, actions: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' | 'none' = 'none') {
		if (list === null && !error) return <p className="muted">Loading feed…</p>;
		if (list?.length === 0) return <p className="muted">No videos in this view.</p>;
		return list?.map((item) =>
			compact ? (
				<div
					key={item.videoId}
					className={`${selectedVideo?.videoId === item.videoId ? 'inbox-item active' : 'inbox-item'}${item.unread ? ' unread' : ''}${inboxSelectedIds.includes(item.videoId) ? ' is-checked' : ''}${inboxSelectedIds.length > 0 && actions === 'inbox' && !androidClient ? ' selecting' : ''}`}
				>
					{actions === 'inbox' && !androidClient ? (
						<button
							className={`inbox-avatar-select${inboxSelectedIds.includes(item.videoId) ? ' is-selected' : ''}`}
							type="button"
							title={inboxSelectedIds.includes(item.videoId) ? 'Deselect' : 'Select'}
							aria-label={inboxSelectedIds.includes(item.videoId) ? 'Deselect video' : 'Select video'}
							aria-pressed={inboxSelectedIds.includes(item.videoId)}
							onClick={() => toggleInboxSelect(item.videoId)}
						>
							<img className="channel-avatar" src={item.channelThumbnailUrl || item.thumbnailUrl} alt="" />
							<span className="inbox-check" aria-hidden="true">
								<svg viewBox="0 0 24 24" width="18" height="18">
									<path
										fill="currentColor"
										d="M9.2 16.6 4.8 12.2l1.4-1.4 3 3 8-8 1.4 1.4-9.4 9.4z"
									/>
								</svg>
							</span>
						</button>
					) : null}
					<button className="inbox-item-main" type="button" onClick={() => openVideo(item.videoId)}>
						{actions === 'inbox' && !androidClient ? null : (
							<img className="channel-avatar" src={item.channelThumbnailUrl || item.thumbnailUrl} alt="" />
						)}
						<img className="video-thumb" src={item.thumbnailUrl} alt="" />
						<span>
							<strong className="video-title">{item.title}</strong>
							<small className="muted">{item.channelTitle}</small>
							<small className="muted">{relativeRelease(item.publishedAt)}</small>
							{actions === 'snoozed' && item.snoozedUntil ? (
								<small className="muted">Until {new Date(item.snoozedUntil).toLocaleString()}</small>
							) : null}
						</span>
					</button>
					{actions !== 'none' ? (
						<div className="inbox-item-actions">
							{actions === 'deleted' ? (
								<button
									className="icon-btn"
									type="button"
									title="Restore"
									aria-label="Restore"
									onClick={() => void patchInbox(item.videoId, { action: 'restore' })}
								>
									<IconRestore />
								</button>
							) : (
								<>
									<button
										className="icon-btn"
										type="button"
										title="Delete"
										aria-label="Delete"
										onClick={() => void patchInbox(item.videoId, { action: 'delete' })}
									>
										<IconTrash />
									</button>
									{actions === 'watchlist' ? (
										<button
											className="icon-btn"
											type="button"
											title="Remove from watchlist"
											aria-label="Remove from watchlist"
											onClick={() => void takeOffWatchlist(item.videoId)}
										>
											<IconRestore />
										</button>
									) : actions === 'snoozed' ? (
										<button
											className="icon-btn"
											type="button"
											title="Wake"
											aria-label="Wake"
											onClick={() => void patchInbox(item.videoId, { action: 'unsnooze' })}
										>
											<IconRestore />
										</button>
									) : (
										<button
											className="icon-btn"
											type="button"
											title="Snooze"
											aria-label="Snooze"
											onClick={() => {
												setSnoozeUntil(toLocalInputValue(tomorrowMorning()));
												setSnoozing(item);
											}}
										>
											<IconClock />
										</button>
									)}
									{actions === 'inbox' ? watchlistButton(item) : null}
								</>
							)}
						</div>
					) : null}
				</div>
			) : (
				<a className="row" key={item.videoId} href={youtubeWatchUrl(item.videoId)} target="_blank" rel="noreferrer">
					<img src={item.thumbnailUrl} alt="" />
					<div>
						<div>
							<span className={`badge ${item.contentType}`}>{item.contentType}</span>
							<strong className="video-title">{item.title}</strong>
						</div>
						<div className="muted">
							{item.channelTitle} · {relativeRelease(item.publishedAt)}
						</div>
					</div>
				</a>
			),
		);
	}

	return (
		<div className={androidClient ? 'shell android-app' : 'shell'}>
			<header className="topbar">
				<div className="topbar-left">
					{mainSection === 'live' && !androidClient ? (
						<button
							className="icon-btn live-hamburger"
							type="button"
							title={liveSidebarOpen ? 'Hide stream list' : 'Show stream list'}
							aria-label={liveSidebarOpen ? 'Hide stream list' : 'Show stream list'}
							aria-expanded={liveSidebarOpen}
							onClick={() => setLiveSidebarOpen((open) => !open)}
						>
							<span className="hamburger" aria-hidden="true" />
						</button>
					) : null}
					<h1>{androidClient ? STREAMFEEDER_DISPLAY_NAME : 'YouTubeFeeder'}</h1>
					{androidClient ? null : (
					<div className="app-tabs" role="tablist" aria-label="Main">
						<button
							className={mainSection === 'feed' ? 'tab active' : 'tab'}
							type="button"
							role="tab"
							aria-selected={mainSection === 'feed'}
							onClick={() => setMainSection('feed')}
						>
							Feed
						</button>
						<button
							className={mainSection === 'live' ? 'tab active' : 'tab'}
							type="button"
							role="tab"
							aria-selected={mainSection === 'live'}
							onClick={() => setMainSection('live')}
						>
							Live
						</button>
					</div>
					)}
					{mainSection === 'live' && !androidClient && liveGridChrome ? (
						<div className="live-toolbar-actions">
							<span className="muted">GRID</span>
							{LIVE_GRID_SIZES.map((size) => (
								<button
									key={size}
									className={liveGridChrome.gridSize === size ? 'ghost tiny active' : 'ghost tiny'}
									type="button"
									onClick={() => liveGridChrome.setGrid(size)}
								>
									{size}
								</button>
							))}
						</div>
					) : null}
					{mainSection === 'live' && liveHeaderStatus ? (
						<div className={liveHeaderStatus.error ? 'live-status live-header-status error' : 'live-status live-header-status'}>
							{liveHeaderStatus.text}
						</div>
					) : null}
				</div>
				<div className="topbar-actions">
					<span className="muted">{user.displayName}</span>
					{mainSection === 'feed' && !androidClient ? (
						<button className="ghost" type="button" disabled={syncing} onClick={() => void syncNow()}>
							{syncing ? 'Syncing…' : 'Sync now'}
						</button>
					) : null}
					<button className="ghost" type="button" onClick={onLogout}>
						Sign out
					</button>
					{androidClient ? null : (
						<button
							className="icon-btn"
							type="button"
							title="Get the Android app"
							aria-label="Get the Android app"
							onClick={() => {
								setAndroidQrOpen(true);
								void (async () => {
									const verRes = await fetch('/android-version.json');
									const ver = verRes.ok
										? ((await verRes.json()) as { versionName: string; versionCode: number })
										: null;
									if (ver) setAndroidAppVersion(ver);
									const qs = ver ? `?v=${encodeURIComponent(ver.versionName)}` : '';
									const url = `${window.location.origin}${TEST_APK_PATH}${qs}`;
									setAndroidQrSvg(await qrSvgForUrl(url));
								})();
							}}
						>
							<IconPhone />
						</button>
					)}
				</div>
			</header>
			{mainSection === 'feed' ? (
				<nav className="feed-toolbar" aria-label="Feed views">
					<button className={leftTab === 'inbox' ? 'tab active' : 'tab'} type="button" onClick={() => setLeftTab('inbox')}>
						Inbox
					</button>
					<button
						className={leftTab === 'snoozed' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => setLeftTab('snoozed')}
					>
						Snoozed
					</button>
					<button
						className={leftTab === 'deleted' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => setLeftTab('deleted')}
					>
						Deleted
					</button>
					<button
						className={leftTab === 'watchlist' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => setLeftTab('watchlist')}
					>
						WatchList
					</button>
					<button
						className={leftTab === 'streams' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => setLeftTab('streams')}
					>
						Streams
					</button>
					<button
						className={leftTab === 'categories' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => setLeftTab('categories')}
					>
						Categories
					</button>
				</nav>
			) : null}
			{offline ? <p className="status-line">Offline. Showing the last loaded inbox until you reconnect.</p> : null}
			{status || error ? (
				<div
					className={
						error
							? 'status-line error'
							: syncWarnings.length
								? 'status-line warning'
								: 'status-line'
					}
				>
					<p>{[status, error].filter(Boolean).join(' — ')}</p>
					{!error && syncWarnings.length > 1 ? (
						<>
							<button
								className="status-details-toggle"
								type="button"
								onClick={() => setShowSkipDetails((open) => !open)}
							>
								{showSkipDetails ? 'Hide skipped channels' : 'Show skipped channels'}
							</button>
							{showSkipDetails ? (
								<ul className="status-skip-list" title={skippedChannelNames(syncWarnings).join(', ')}>
									{skippedChannelNames(syncWarnings).map((name) => (
										<li key={name}>{name}</li>
									))}
								</ul>
							) : null}
						</>
					) : null}
					{!error && syncWarnings.length === 1 ? (
						<p className="status-skip-hint" title={syncWarnings[0]?.channelId}>
							{syncWarnings[0]?.message}
						</p>
					) : null}
				</div>
			) : null}
			{mainSection === 'live' ? (
				<LivePage sidebarOpen={liveSidebarOpen} onHeaderStatus={setLiveHeaderStatus} onGridChrome={setLiveGridChrome} />
			) : (
			<div className={phoneLayout && selectedVideo ? 'home mobile-detail' : 'home'}>
				<aside className="subs">
					{leftTab === 'inbox' ? (
						<>
							<label className="inbox-filter">
								<span className="muted">Category</span>
								<select
									value={categoryId ?? ''}
									onChange={(event) => {
										setCategoryId(event.target.value || null);
										setSelectedVideoId(null);
										setInboxSelectedIds([]);
										leftScrollRef.current?.scrollTo({ top: 0 });
									}}
								>
									<option value="">All categories</option>
									{categories.map((cat) => (
										<option key={cat.id} value={cat.id}>
											{cat.name}
										</option>
									))}
								</select>
							</label>
							{!androidClient && inboxSelectedIds.length > 0 ? (
								<div className="inbox-bulk-bar" role="toolbar" aria-label="Bulk inbox actions">
									<span className="muted inbox-bulk-count">{inboxSelectedIds.length} selected</span>
									<button
										className="icon-btn"
										type="button"
										title="Snooze selected"
										aria-label="Snooze selected"
										onClick={() => {
											setSnoozeUntil(toLocalInputValue(tomorrowMorning()));
											setSnoozing(null);
											setBulkSnoozeIds([...inboxSelectedIds]);
										}}
									>
										<IconClock />
									</button>
									<button
										className="icon-btn"
										type="button"
										title="Add selected to watchlist"
										aria-label="Add selected to watchlist"
										onClick={() => {
											setWatchlisting(null);
											setBulkWatchlistIds([...inboxSelectedIds]);
										}}
									>
										<IconList />
									</button>
									<button
										className="icon-btn"
										type="button"
										title="Delete selected"
										aria-label="Delete selected"
										onClick={() => void bulkDeleteSelected()}
									>
										<IconTrash />
									</button>
									<button className="ghost tiny" type="button" onClick={() => setInboxSelectedIds([])}>
										Clear
									</button>
								</div>
							) : null}
							<div className="left-scroll" ref={leftScrollRef}>{renderFeed(items, true, 'inbox')}</div>
						</>
					) : null}
					{leftTab === 'snoozed' ? (
						<>
							<label className="inbox-filter">
								<span className="muted">Category</span>
								<select
									value={categoryId ?? ''}
									onChange={(event) => {
										setCategoryId(event.target.value || null);
										setSelectedVideoId(null);
										leftScrollRef.current?.scrollTo({ top: 0 });
									}}
								>
									<option value="">All categories</option>
									{categories.map((cat) => (
										<option key={cat.id} value={cat.id}>
											{cat.name}
										</option>
									))}
								</select>
							</label>
							<div className="left-scroll" ref={leftScrollRef}>{renderFeed(items, true, 'snoozed')}</div>
						</>
					) : null}
					{leftTab === 'deleted' ? (
						<>
							<label className="inbox-filter">
								<span className="muted">Category</span>
								<select
									value={categoryId ?? ''}
									onChange={(event) => {
										setCategoryId(event.target.value || null);
										setSelectedVideoId(null);
										leftScrollRef.current?.scrollTo({ top: 0 });
									}}
								>
									<option value="">All categories</option>
									{categories.map((cat) => (
										<option key={cat.id} value={cat.id}>
											{cat.name}
										</option>
									))}
								</select>
							</label>
							<div className="left-scroll" ref={leftScrollRef}>{renderFeed(items, true, 'deleted')}</div>
						</>
					) : null}
					{leftTab === 'watchlist' ? (
						<div className="left-scroll cat-panel">
							<form className="cat-add" onSubmit={(e) => void addWatchlist(e)}>
								<input value={newWatchlist} onChange={(e) => setNewWatchlist(e.target.value)} placeholder="New watchlist" />
								<button className="ghost" type="submit">
									Add
								</button>
							</form>
							{watchlists.map((list) => {
								const expanded = watchlistId === list.id;
								return (
									<div key={list.id} className="watchlist-group">
										<div className={expanded ? 'sub-row active watchlist-row' : 'sub-row watchlist-row'}>
											<button
												className="caret-btn"
												type="button"
												aria-label={expanded ? 'Collapse watchlist' : 'Expand watchlist'}
												aria-expanded={expanded}
												onClick={() => {
													setWatchlistId(expanded ? null : list.id);
													setSelectedVideoId(null);
												}}
											>
												<span className={expanded ? 'caret open' : 'caret'} aria-hidden="true" />
											</button>
											{renamingId === list.id ? (
												<form className="watchlist-rename" onSubmit={(e) => void saveWatchlistName(e)}>
													<input
														value={renameValue}
														onChange={(e) => setRenameValue(e.target.value)}
														aria-label="Watchlist name"
														autoFocus
														onKeyDown={(e) => {
															if (e.key === 'Escape') {
																e.preventDefault();
																setRenamingId(null);
															}
														}}
													/>
													<button className="ghost tiny" type="submit">
														Save
													</button>
												</form>
											) : (
												<button
													className="sub watchlist-name"
													type="button"
													onClick={() => {
														setWatchlistId(expanded ? null : list.id);
														setSelectedVideoId(null);
													}}
												>
													{list.name} ({list.videoCount})
												</button>
											)}
											<button
												className="icon-btn"
												type="button"
												title="Rename watchlist"
												aria-label="Rename watchlist"
												onClick={() => {
													setRenamingId(list.id);
													setRenameValue(list.name);
												}}
											>
												<IconPencil />
											</button>
											{list.videoCount === 0 ? (
												<button
													className="icon-btn"
													type="button"
													title="Delete watchlist"
													aria-label="Delete watchlist"
													onClick={() => void removeWatchlist(list.id, list.videoCount)}
												>
													<IconTrash />
												</button>
											) : (
												<span className="icon-btn-spacer" aria-hidden="true" />
											)}
										</div>
										{expanded ? renderFeed(items, true, 'watchlist') : null}
									</div>
								);
							})}
							{watchlists.length === 0 ? <p className="muted pad">Create a watchlist, then add videos from Inbox.</p> : null}
						</div>
					) : null}
					{leftTab === 'streams' ? (
						<div className="left-scroll">
							<div className="streams-toolbar">
								<button className="ghost" type="button" disabled={syncing} onClick={() => void syncSubscriptionsOnly()}>
									{syncing ? 'Syncing…' : 'Sync subscriptions'}
								</button>
							</div>
							{channels.map((ch) => (
								<div key={ch.channelId} className={channelId === ch.channelId ? 'sub-row active stream-row' : 'sub-row stream-row'}>
									<button className="sub" type="button" onClick={() => setChannelId(ch.channelId)}>
										<img src={ch.thumbnailUrl} alt="" />
										<span>
											<strong>{ch.title}</strong>
											<small className="muted">
												{ch.followInInbox ? 'Following' : 'Not following'} · pull {ch.maxVideosToPull}
											</small>
											<small className="muted cat-tags">{categoryNames(ch, categories)}</small>
										</span>
									</button>
									<button
										className="ghost tiny"
										type="button"
										disabled={syncing}
										onClick={() => void catchUpChannel(ch.channelId, ch.title, ch.maxVideosToPull)}
									>
										Catch up
									</button>
									<button className="ghost tiny" type="button" onClick={() => setEditing(ch)}>
										Edit
									</button>
								</div>
							))}
							{channels.length === 0 && !syncing ? <p className="muted pad">No streams yet. Use Sync now.</p> : null}
						</div>
					) : null}
					{leftTab === 'categories' ? (
						<div className="left-scroll cat-panel">
							<form className="cat-add" onSubmit={(e) => void addCategory(e)}>
								<input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New category" />
								<button className="ghost" type="submit">
									Add
								</button>
							</form>
							{categories.map((cat) => (
								<div key={cat.id} className={categoryId === cat.id ? 'sub-row active' : 'sub-row'}>
									<button
										className="sub"
										type="button"
										onClick={() => setCategoryId(cat.id)}
									>
										{cat.name}
									</button>
									<button className="ghost tiny" type="button" onClick={() => void removeCategory(cat.id)}>
										Delete
									</button>
								</div>
							))}
							{categories.length === 0 ? <p className="muted pad">Add a category, then tag streams under Edit.</p> : null}
						</div>
					) : null}
				</aside>
				<section className="feed">
					{phoneLayout && selectedVideo ? (
						<button
							className="ghost mobile-back"
							type="button"
							onClick={() => {
								setSelectedVideoId(null);
								if (history.state && typeof history.state === 'object' && 'feederVideo' in history.state) history.back();
							}}
						>
							Back to list
						</button>
					) : null}
					{leftTab === 'inbox' && selectedVideo ? renderPreview(selectedVideo, 'inbox') : null}
					{leftTab === 'inbox' && !selectedVideo ? <p className="muted">No videos in your inbox yet. Sync now.</p> : null}
					{leftTab === 'snoozed' && selectedVideo ? renderPreview(selectedVideo, 'snoozed') : null}
					{leftTab === 'snoozed' && !selectedVideo ? <p className="muted">No snoozed videos.</p> : null}
					{leftTab === 'deleted' && selectedVideo ? renderPreview(selectedVideo, 'deleted') : null}
					{leftTab === 'deleted' && !selectedVideo ? <p className="muted">No deleted videos.</p> : null}
					{leftTab === 'watchlist' && watchlistId && selectedVideo ? renderPreview(selectedVideo, 'watchlist') : null}
					{leftTab === 'watchlist' && watchlistId && !selectedVideo ? <p className="muted">No videos in this watchlist.</p> : null}
					{leftTab === 'watchlist' && !watchlistId ? <p className="muted">Select a watchlist to see saved videos.</p> : null}
					{leftTab === 'streams' ? (
						<>
							<h2 className="pane-title">{channelId ? channels.find((c) => c.channelId === channelId)?.title ?? 'Stream' : 'Select a stream'}</h2>
							{channelId ? renderFeed(items, false) : <p className="muted">Choose a stream on the left to see its videos, or use Edit to change follow settings.</p>}
						</>
					) : null}
					{leftTab === 'categories' ? (
						<>
							<h2 className="pane-title">{categoryId ? categories.find((c) => c.id === categoryId)?.name ?? 'Category' : 'Categories'}</h2>
							{categoryId ? renderFeed(items, false) : <p className="muted">Select a category to see tagged videos. Tag streams from the Streams tab using Edit.</p>}
						</>
					) : null}
				</section>
				{phoneLayout ? (
					<nav className="mobile-nav" aria-label="Feeder">
						<button className={leftTab === 'inbox' ? 'active' : undefined} type="button" onClick={() => setLeftTab('inbox')}>
							Inbox
						</button>
						<button className={leftTab === 'watchlist' ? 'active' : undefined} type="button" onClick={() => setLeftTab('watchlist')}>
							Watchlists
						</button>
						<button type="button" onClick={() => void load().catch(() => setError('Could not refresh inbox.'))}>
							Refresh
						</button>
						<button className={mobilePanel === 'account' ? 'active' : undefined} type="button" onClick={() => setMobilePanel((p) => (p === 'account' ? 'inbox' : 'account'))}>
							Account
						</button>
					</nav>
				) : null}
			</div>
			)}
			{mobilePanel === 'account' && phoneLayout ? (
				<div className="modal-backdrop" onClick={() => setMobilePanel('inbox')}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h2>Account</h2>
						<p>{user.displayName}</p>
						<p className="muted">Inbox and watchlists use the same signed-in account as the website. Refresh loads saved data without calling YouTube.</p>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => void load()}>
								Refresh inbox
							</button>
							<button className="ghost" type="button" onClick={onLogout}>
								Sign out
							</button>
						</div>
					</div>
				</div>
			) : null}
			{androidQrOpen ? (
				<div className="modal-backdrop" onClick={() => setAndroidQrOpen(false)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h2>Get StreamFeeder</h2>
						<p className="muted">Scan this code on your Android phone to download the StreamFeeder test APK, then allow install from your browser if Android asks.</p>
						{androidQrSvg ? <div className="download-qr" dangerouslySetInnerHTML={{ __html: androidQrSvg }} /> : <p className="muted">Preparing QR…</p>}
						{androidAppVersion ? (
							<p>
								Version {androidAppVersion.versionName} (build {androidAppVersion.versionCode})
							</p>
						) : null}
						<p>
							<a href={androidAppVersion ? `${TEST_APK_PATH}?v=${encodeURIComponent(androidAppVersion.versionName)}` : TEST_APK_PATH}>
								{typeof window !== 'undefined'
									? `${window.location.origin}${TEST_APK_PATH}${androidAppVersion ? `?v=${encodeURIComponent(androidAppVersion.versionName)}` : ''}`
									: TEST_APK_PATH}
							</a>
						</p>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setAndroidQrOpen(false)}>
								Close
							</button>
						</div>
					</div>
				</div>
			) : null}
			{watchlisting || bulkWatchlistIds ? (
				<div
					className="modal-backdrop"
					onClick={() => {
						setWatchlisting(null);
						setBulkWatchlistIds(null);
					}}
				>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h2>Add to WatchList</h2>
						<p className="muted">
							{bulkWatchlistIds
								? `${bulkWatchlistIds.length} selected video${bulkWatchlistIds.length === 1 ? '' : 's'}`
								: watchlisting?.title}
						</p>
						{watchlists.length === 0 ? <p className="muted">Create a watchlist on the WatchList tab first.</p> : null}
						<div className="modal-list">
							{watchlists.map((list) => (
								<button
									key={list.id}
									className="ghost"
									type="button"
									onClick={() =>
										bulkWatchlistIds
											? void saveBulkToWatchlist(list.id)
											: watchlisting
												? void saveToWatchlist(watchlisting.videoId, list.id)
												: undefined
									}
								>
									{list.name} ({list.videoCount})
								</button>
							))}
						</div>
						<div className="modal-actions">
							<button
								className="ghost"
								type="button"
								onClick={() => {
									setWatchlisting(null);
									setBulkWatchlistIds(null);
								}}
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			) : null}
			{snoozing || bulkSnoozeIds ? (
				<div
					className="modal-backdrop"
					onClick={() => {
						setSnoozing(null);
						setBulkSnoozeIds(null);
					}}
				>
					<form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void confirmSnooze(e)}>
						<h2>Snooze</h2>
						<p className="muted">
							{bulkSnoozeIds
								? `${bulkSnoozeIds.length} selected video${bulkSnoozeIds.length === 1 ? '' : 's'}`
								: snoozing?.title}
						</p>
						<div className="snooze-presets">
							<button
								className="ghost tiny"
								type="button"
								onClick={() => setSnoozeUntil(toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)))}
							>
								In 3 hours
							</button>
							<button className="ghost tiny" type="button" onClick={() => setSnoozeUntil(toLocalInputValue(tomorrowMorning()))}>
								Tomorrow 8:00 AM
							</button>
							<button
								className="ghost tiny"
								type="button"
								onClick={() => {
									const d = tomorrowMorning();
									d.setDate(d.getDate() + 6);
									setSnoozeUntil(toLocalInputValue(d));
								}}
							>
								Next week
							</button>
						</div>
						<label>
							Until
							<input
								type="datetime-local"
								value={snoozeUntil}
								onChange={(e) => setSnoozeUntil(e.target.value)}
								required
							/>
						</label>
						<div className="modal-actions">
							<button
								className="ghost"
								type="button"
								onClick={() => {
									setSnoozing(null);
									setBulkSnoozeIds(null);
								}}
							>
								Cancel
							</button>
							<button className="ghost" type="submit">
								Snooze
							</button>
						</div>
					</form>
				</div>
			) : null}
			{editing ? (
				<div className="modal-backdrop" onClick={() => setEditing(null)}>
					<form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void saveEdit(e)}>
						<h2>Edit {editing.title}</h2>
						<label className="check">
							<input type="checkbox" name="followInInbox" defaultChecked={editing.followInInbox} />
							Follow in inbox (always pull new videos)
						</label>
						<label>
							Max existing videos to pull
							<input type="number" name="maxVideosToPull" min={0} max={500} defaultValue={editing.maxVideosToPull} />
						</label>
						<fieldset className="modal-cats">
							<legend>Categories</legend>
							{categories.length === 0 ? <p className="muted">Add a category in the Categories tab first.</p> : null}
							{categories.map((cat) => (
								<label key={cat.id} className="check">
									<input type="checkbox" name="categoryIds" value={cat.id} defaultChecked={editing.categoryIds.includes(cat.id)} />
									{cat.name}
								</label>
							))}
						</fieldset>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setEditing(null)}>
								Cancel
							</button>
							<button className="ghost" type="submit">
								Save
							</button>
						</div>
					</form>
				</div>
			) : null}
		</div>
	);
}
